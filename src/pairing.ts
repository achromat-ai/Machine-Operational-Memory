/**
 * Pure pairing helpers for /calibrate: violation rule, steering directive and
 * the trap → fix delta. No I/O, so every rule here is unit-tested directly.
 */
import type { SignedPayloadV5, UpstreamEvaluation, UpstreamViolation } from "./schema";
import { canonicalJson, sha256Hex } from "./schema";

export const VIOLATION_RULE_MAX = 256;
export const STEERING_DIRECTIVE_MAX = 4000;
export const STATUTORY_ANCHOR_MAX = 1000;
export const DELTA_JSON_MAX = 32768;
export const GENERIC_STEERING =
  "Blocked: adjust the candidate arguments to satisfy the evaluated policy and call /api/v1/calibrate again.";

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/gu;
const GENERIC_RULE_NAME = /^Rule \d+$/i;

/** NFC, control characters removed, whitespace collapsed, trimmed, cut to `max` code points. */
export function cleanText(value: string, max: number): string {
  const cleaned = value.normalize("NFC").replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
  const points = [...cleaned];
  return points.length > max ? points.slice(0, max).join("").trimEnd() : cleaned;
}

function nonBlank(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * True when the unsigned violation list reproduces the signed `reasoning`
 * (contract: violations[*].reasoning joined with " | "). Both readings of an
 * absent reasoning are accepted: skipped, or joined as an empty string.
 */
export function violationsMatchSignedReasoning(violations: readonly UpstreamViolation[], signedReasoning: string): boolean {
  const skipped = violations.map((v) => v.reasoning).filter(nonBlank).join(" | ");
  const kept = violations.map((v) => v.reasoning ?? "").join(" | ");
  return signedReasoning === skipped || signedReasoning === kept;
}

/**
 * Approved fallback chain: rule name → statutory anchor → reasoning → policy id.
 *
 *   1. Rule names, only if the unsigned violation list matches the signed reasoning.
 *      Strict violations are preferred; names are deduplicated in rule_id order and
 *      joined with " + ". Generic names ("Rule 1") are prefixed with the first anchor.
 *   2. The first signed statutory anchor.
 *   3. The first " | " segment of the signed reasoning.
 *   4. "policy:" + the first signed policy id (sorted).
 * Always returns 1-256 code points, as lessons.violation_rule requires.
 */
export function deriveViolationRule(evaluation: UpstreamEvaluation, signed: SignedPayloadV5): string {
  const anchor = signed.statutory_anchors.map((a) => cleanText(a, VIOLATION_RULE_MAX)).find(nonBlank);

  if (evaluation.total_violations.length > 0 && violationsMatchSignedReasoning(evaluation.total_violations, signed.reasoning)) {
    const strict = evaluation.total_violations.filter((v) => v.enforcement_level === "strict");
    const chosen = [...(strict.length > 0 ? strict : evaluation.total_violations)].sort((a, b) =>
      a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0,
    );
    const names = [...new Set(chosen.map((v) => cleanText(v.rule_name, VIOLATION_RULE_MAX)).filter(nonBlank))];
    if (names.length > 0) {
      const joined = names.join(" + ");
      const generic = names.every((name) => GENERIC_RULE_NAME.test(name));
      const rule = cleanText(generic && anchor ? `${anchor}: ${joined}` : joined, VIOLATION_RULE_MAX);
      if (rule !== "") return rule;
    }
  }

  if (anchor) return anchor;
  const reasoning = cleanText(signed.reasoning.split(" | ")[0] ?? "", VIOLATION_RULE_MAX);
  if (reasoning !== "") return reasoning;
  return cleanText(`policy:${[...signed.policy_ids].sort()[0]}`, VIOLATION_RULE_MAX);
}

/**
 * Steering guarantee: a BLOCK always carries a non-blank directive.
 * Signed steering, then signed reasoning, then (unverified receipts only) the
 * unsigned recovery instructions and reasoning, then a generic fallback.
 */
export function deriveSteeringDirective(signed: SignedPayloadV5 | null, evaluation: UpstreamEvaluation): string {
  if (signed) {
    if (nonBlank(signed.steering)) return signed.steering.trim();
    if (nonBlank(signed.reasoning)) return signed.reasoning.trim();
    return GENERIC_STEERING;
  }
  const steering = [
    ...evaluation.total_violations.map((v) => v.recovery_instruction),
    ...(evaluation.results ?? []).map((r) => r.instruction),
  ].filter(nonBlank);
  if (steering.length > 0) return steering.join(" | ");
  const reasons = evaluation.total_violations.map((v) => v.reasoning).filter(nonBlank);
  return reasons.length > 0 ? reasons.join(" | ") : GENERIC_STEERING;
}

// ════════════════════════════════════════════════════════════════════════
// Delta
// ════════════════════════════════════════════════════════════════════════

export interface DeltaChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export interface PairDelta {
  changedPaths: string[];
  deltaJson: string;
  deltaHash: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 6901 escaping. */
function pointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Leaf-level differences between two argument objects. Arrays and scalars compare as whole values. */
export function diffArguments(before: unknown, after: unknown, path = ""): DeltaChange[] {
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const changes: DeltaChange[] = [];
    for (const key of keys) {
      const child = `${path}/${pointerToken(key)}`;
      if (!Object.hasOwn(after, key)) changes.push({ path: child, kind: "removed", before: before[key] });
      else if (!Object.hasOwn(before, key)) changes.push({ path: child, kind: "added", after: after[key] });
      else changes.push(...diffArguments(before[key], after[key], child));
    }
    return changes;
  }
  return canonicalJson(before) === canonicalJson(after) ? [] : [{ path: path || "/", kind: "changed", before, after }];
}

/** changed_paths, delta_json (≤ 32 KiB: values are dropped if the full delta is larger) and its SHA-256. */
export async function buildPairDelta(trapArguments: unknown, fixArguments: unknown): Promise<PairDelta | null> {
  const changes = diffArguments(trapArguments, fixArguments);
  if (changes.length === 0) return null;
  const changedPaths = changes.map((change) => change.path);
  let delta: unknown = { changed_paths: changedPaths, changes };
  let deltaJson = canonicalJson(delta);
  if (deltaJson.length > DELTA_JSON_MAX) {
    delta = { changed_paths: changedPaths, changes: changes.map(({ path, kind }) => ({ path, kind })), values_omitted: true };
    deltaJson = canonicalJson(delta);
  }
  if (deltaJson.length > DELTA_JSON_MAX) return null;
  return { changedPaths, deltaJson, deltaHash: await sha256Hex(deltaJson) };
}
