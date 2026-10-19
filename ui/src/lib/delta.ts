/**
 * The data behind the Delta View: two argument objects compared field by field, with the lesson's
 * `changed_paths` (RFC 6901 JSON Pointers) deciding which fields are highlighted.
 *
 * Mirrors the server's own diff (src/pairing.ts): objects are walked key by key, while arrays, scalars and
 * null are compared as whole values, so every pointer in `changed_paths` names either a leaf or a value
 * whose shape changed. An empty object has no fields and so no row of its own. Pure functions, no DOM.
 */

export type JsonObject = Record<string, unknown>;

/** How the two sides relate at a field. */
export type RowStatus = "same" | "changed" | "added" | "removed";

export interface DeltaRow {
  /** RFC 6901 pointer of the field. */
  path: string;
  /** Readable form, `approval.second_approver`. */
  label: string;
  left: unknown;
  right: unknown;
  hasLeft: boolean;
  hasRight: boolean;
  /** True when the lesson's changed_paths names this field (or a parent of it). */
  highlighted: boolean;
  status: RowStatus;
}

const MAX_NODES = 20_000;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 6901 tokens of a pointer, or null if it is not a valid pointer. "" is the whole document. */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  const tokens = pointer.slice(1).split("/");
  for (const token of tokens) if (/~(?![01])/.test(token)) return null;
  return tokens.map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function pointerFromTokens(tokens: readonly string[]): string {
  return tokens.map((token) => `/${token.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/** `approval.second_approver` for display. A pointer that cannot be parsed is shown as it came. */
export function pathLabel(pointer: string): string {
  const tokens = parsePointer(pointer);
  if (tokens === null) return pointer;
  return tokens.length === 0 ? "(whole call)" : tokens.join(".");
}

/** Key-sorted JSON, so equal values compare equal whatever their key order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** pointer -> value for every leaf. Walks plain objects only (empty ones hold none); stops after 20,000 nodes. */
export function flattenLeaves(value: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const stack: Array<{ node: unknown; tokens: string[] }> = [{ node: value, tokens: [] }];
  let visited = 0;
  while (stack.length > 0 && visited++ < MAX_NODES) {
    const { node, tokens } = stack.pop()!;
    if (isPlainObject(node)) {
      for (const key of Object.keys(node)) stack.push({ node: node[key], tokens: [...tokens, key] });
    } else {
      out.set(pointerFromTokens(tokens), node);
    }
  }
  return out;
}

function isHighlighted(path: string, changed: readonly string[]): boolean {
  return changed.some((pointer) => path === pointer || pointer === "" || path.startsWith(`${pointer}/`));
}

/**
 * Rows for every field either side has, sorted by pointer.
 *
 * `left` is the call being compared (the user's arguments, or the original trap). Pass null when there is
 * nothing to compare with: every row is then "same" and only the highlighting from `changedPaths` remains.
 * Pointers in `changedPaths` that are not valid RFC 6901 are ignored.
 */
export function buildDeltaRows(left: unknown, right: unknown, changedPaths: readonly string[]): DeltaRow[] {
  const leftLeaves = left === null || left === undefined ? new Map<string, unknown>() : flattenLeaves(left);
  const rightLeaves = flattenLeaves(right);
  const comparing = left !== null && left !== undefined;
  const changed = changedPaths.filter((pointer) => parsePointer(pointer) !== null);

  const paths = [...new Set([...leftLeaves.keys(), ...rightLeaves.keys()])].sort();
  return paths.map((path) => {
    const hasLeft = leftLeaves.has(path);
    const hasRight = rightLeaves.has(path);
    const leftValue = leftLeaves.get(path);
    const rightValue = rightLeaves.get(path);
    let status: RowStatus = "same";
    if (comparing) {
      if (hasLeft && hasRight) status = valuesEqual(leftValue, rightValue) ? "same" : "changed";
      else if (hasRight) status = "added";
      else status = "removed";
    }
    return {
      path,
      label: pathLabel(path),
      left: leftValue,
      right: rightValue,
      hasLeft,
      hasRight,
      highlighted: isHighlighted(path, changed),
      status,
    };
  });
}

/** Rows worth showing up front (highlighted or different) and the rest. */
export function splitRows(rows: readonly DeltaRow[]): { visible: DeltaRow[]; unchanged: DeltaRow[] } {
  const visible: DeltaRow[] = [];
  const unchanged: DeltaRow[] = [];
  for (const row of rows) (row.highlighted || row.status !== "same" ? visible : unchanged).push(row);
  return { visible, unchanged };
}

export interface FormattedValue {
  /** One line, at most `max` characters. */
  preview: string;
  /** Indented JSON, capped, shown when the value is long. */
  full: string;
  truncated: boolean;
}

/** Display text for a JSON value. Strings keep their quotes so `"5"` and `5` look different. */
export function formatValue(value: unknown, max = 160): FormattedValue {
  let line: string;
  try {
    line = JSON.stringify(value) ?? "undefined";
  } catch {
    line = String(value);
  }
  if (line.length <= max) return { preview: line, full: line, truncated: false };
  let full: string;
  try {
    full = JSON.stringify(value, null, 2) ?? line;
  } catch {
    full = line;
  }
  return { preview: `${line.slice(0, max - 1)}…`, full: full.length > 4000 ? `${full.slice(0, 3999)}…` : full, truncated: true };
}

/** How a row reads, for text that must not depend on colour. */
export function describeRow(row: DeltaRow, side: "left" | "right", comparing = true): string {
  if (!comparing) return row.highlighted ? (row.hasRight ? "set by the fix" : "removed by the fix") : "unchanged";
  if (side === "right") {
    if (!row.highlighted && row.status === "same") return "unchanged";
    if (!row.hasRight) return "removed by the fix";
    return row.hasLeft ? "changed" : "added";
  }
  if (!row.highlighted && row.status === "same") return "unchanged";
  if (!row.hasLeft) return "not set";
  if (row.status === "same") return "already matches";
  return row.hasRight ? "needs to change" : "to be removed";
}
