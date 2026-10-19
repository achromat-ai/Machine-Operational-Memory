/**
 * Embedding text for lessons and recall queries (decision D6).
 *
 * Index text, one per lesson:
 *   task: {normalised task_description}
 *   rule: {violation_rule}
 *   argument_keys: {sorted union of the key paths of the trap and fix arguments}
 * Keys only, never values, so secrets and PII cannot reach an embedding.
 * tool_name is deliberately absent: it is an exact Vectorize metadata filter.
 *
 * Query text has no rule line (the rule is only known after a match), so
 * query-to-lesson cosine sits a little below 1 even for the same task.
 *
 * bge-base-en-v1.5 accepts 512 input tokens and the docs do not say whether
 * longer input is truncated or rejected, so every part is clipped to a
 * deliberately pessimistic token estimate. There is no tokenizer in a Worker.
 */

/** Workers AI model, pooling "cls" at both index and query time (CLS and mean vectors are incompatible). */
export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
/** Stored in lessons.embed_version and the embed_v metadata; bump it when the text recipe changes. */
export const EMBED_VERSION = "bge-base-cls/intent-v2";
export const EMBEDDING_DIMENSIONS = 768;

/** Estimated-token budgets. Their sum plus labels stays near 400, well below the 512 limit. */
export const TASK_TOKEN_BUDGET = 220;
export const RULE_TOKEN_BUDGET = 60;
export const KEYS_TOKEN_BUDGET = 110;

const MAX_KEY_PATHS = 512;
const MAX_NODES = 5000;
const MAX_KEY_DEPTH = 12;

/** Words, numbers and single symbols: roughly what a WordPiece tokenizer splits on. */
const PIECE = /[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu;

function pieceCost(piece: string): number {
  if (!/^[\p{L}\p{N}]/u.test(piece)) return 1;
  const length = [...piece].length;
  // ASCII identifiers and numbers split into sub-words (assume 3 characters per token).
  // Other scripts can cost one token per character.
  return /^[\x00-\x7f]+$/.test(piece) ? Math.ceil(length / 3) : length;
}

/** Pessimistic token estimate including the [CLS] and [SEP] markers. */
export function estimateTokens(text: string): number {
  let total = 2;
  for (const match of text.matchAll(PIECE)) total += pieceCost(match[0]);
  return total;
}

/** Cuts `text` at a piece boundary so its estimate stays within `maxTokens`. */
export function clipToTokens(text: string, maxTokens: number): string {
  let cost = 0;
  for (const match of text.matchAll(PIECE)) {
    cost += pieceCost(match[0]);
    if (cost > maxTokens) return text.slice(0, match.index).trimEnd();
  }
  return text;
}

/**
 * Key paths of a JSON value ("approval.second_approver"), arrays collapsed into
 * their parent path, sorted and deduplicated. Values are never read.
 */
export function argumentKeyPaths(value: unknown): string[] {
  const paths = new Set<string>();
  const stack: Array<{ node: unknown; prefix: string; depth: number }> = [{ node: value, prefix: "", depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_NODES && paths.size < MAX_KEY_PATHS) {
    const { node, prefix, depth } = stack.pop()!;
    visited++;
    if (Array.isArray(node)) {
      if (depth < MAX_KEY_DEPTH) for (const child of node) stack.push({ node: child, prefix, depth: depth + 1 });
    } else if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        const path = prefix === "" ? key : `${prefix}.${key}`;
        paths.add(path);
        if (depth < MAX_KEY_DEPTH) stack.push({ node: child, prefix: path, depth: depth + 1 });
      }
    }
  }
  return [...paths].sort();
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function keysLine(paths: readonly string[], budget: number): string {
  return `argument_keys: ${clipToTokens(paths.join(" "), budget)}`;
}

export interface IndexTextInput {
  taskDescription: string;
  violationRule: string;
  trapArguments: unknown;
  fixArguments: unknown;
}

/** Text embedded for a lesson. `scale` < 1 shrinks every budget (the retry after a failed embed). */
export function buildIndexText(input: IndexTextInput, scale = 1): string {
  const paths = [...new Set([...argumentKeyPaths(input.trapArguments), ...argumentKeyPaths(input.fixArguments)])].sort();
  return [
    `task: ${clipToTokens(collapse(input.taskDescription), Math.floor(TASK_TOKEN_BUDGET * scale))}`,
    `rule: ${clipToTokens(collapse(input.violationRule), Math.floor(RULE_TOKEN_BUDGET * scale))}`,
    keysLine(paths, Math.floor(KEYS_TOKEN_BUDGET * scale)),
  ].join("\n");
}

export interface QueryTextInput {
  taskDescription: string;
  requestArguments: unknown;
}

/** Text embedded for a recall request: the task and the key paths of the arguments it is about to send. */
export function buildQueryText(input: QueryTextInput, scale = 1): string {
  return [
    `task: ${clipToTokens(collapse(input.taskDescription), Math.floor(TASK_TOKEN_BUDGET * scale))}`,
    keysLine(argumentKeyPaths(input.requestArguments), Math.floor(KEYS_TOKEN_BUDGET * scale)),
  ].join("\n");
}
