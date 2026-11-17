/**
 * The review digest: one compact row per queued lesson, with the mechanical checks of the moderation rubric
 * already run, so an operator can look at 15 to 25 lessons at once and decide them in one batch.
 *
 * Everything here is advice. A flag never decides anything: the operator's choice per row is what gets sent, and
 * a lesson with any doubt is proposed as "leave" (no decision), never as an approval. Every value read from a
 * lesson is untrusted community text. It is only compared, measured and shown as plain text.
 *
 * Pure functions with no DOM and no network, so they are tested against the real Worker's data.
 * The out-of-band tool ~/.achromat/review_digest.mjs applies the same rules (SOP section 15).
 */
import type { PendingLesson, ReviewReasonCode } from "./adminApi";

export type FlagSeverity = "reject" | "look";

export interface DigestFlag {
  /** Stable machine name: injection, secret_or_pii, literal_evidence, outcome_placeholder, weakening, clearance_flip,
   *  no_substantive_change, zeroed_numbers, same_delta, covered, batch_duplicate, batch_same_rule_class, triage:<check>. */
  code: string;
  severity: FlagSeverity;
  /** The reason code a rejection would carry, for a "reject" flag. */
  reason: ReviewReasonCode | null;
  text: string;
}

export type Proposal = { decision: "approve" } | { decision: "reject"; reasonCode: ReviewReasonCode } | { decision: "leave" };

export interface ChangeView {
  path: string;
  before: string;
  after: string;
}

export interface DigestRow {
  lesson: PendingLesson;
  /** 1-based position in the digest, the number the operator uses in "approve all except 3 and 8". */
  index: number;
  ruleClass: string;
  changes: ChangeView[];
  flags: DigestFlag[];
  proposal: Proposal;
  /** Shown as "NEW" or "covered by <id>". */
  coverage: { kind: "new" } | { kind: "covered"; by: string };
}

const SANCTIONED_PLACEHOLDERS = new Set(["[VERIFIED_STATE]", "[UNVERIFIED_STATE]", "[PLACEHOLDER_CREDENTIAL]"]);
const PLACEHOLDER = /^\[[A-Z][A-Z_]*\]$/;
const OUTCOME_TOKEN = /CLEAR|APPROV|AUTHORI[SZ]|PASS|WAIV|OVERRIDE|BYPASS|OFAC|SANCTION|KYC|AML|CONSENT/;
const EVIDENCE_KEY = /evidence|attestation|signature|token|receipt|certificate|nonce|clearance/i;
const CLEARANCE_KEY = /cleared|ofac|sanction|kyc|aml|consent|approved|authori[sz]ed|waiver|override|bypass/i;
const WEAKENING_KEY = /skip|bypass|force|insecure|disable|override/i;
const PASSING_VALUE = /^(clear|cleared|approved|pass|passed|verified|yes|true|granted|authori[sz]ed)$/i;
const ADVERSE_VALUE = /match|hit|block|denied|reject|fail|escalat|pending|review/i;
const INJECTION =
  /ignore (all |any |the )?(previous|prior|above)|disregard (all |any |the )?(previous|prior|above)|system prompt|approve this|you (must|should|need to) approve|mark (this )?(as )?approved|to the reviewer|dear reviewer|\bnote to reviewer/i;
const SECRET_SHAPES: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*(KEY|CERTIFICATE)-----/, "key block"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/, "cloud access key"],
  [/\bsk-[A-Za-z0-9_-]{16,}/, "API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "source host token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "chat token"],
  [/\b[rs]k_(live|test)_[A-Za-z0-9]{10,}/, "payment key"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "cloud API key"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./, "JWT"],
  [/^[0-9a-f]{64}$|^[0-9a-f]{128}$/i, "64 or 128 character hex value"],
  [/^[A-Za-z0-9_-]{43}$|^[A-Za-z0-9_-]{86}$/, "43 or 86 character base64url value"],
  [/[A-Za-z0-9+/_-]{40,}={0,2}/, "base64 run of 40 or more characters"],
  [/[^\s@"]+@[^\s@"]+\.[A-Za-z]{2,}/, "email address"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at an RFC 6901 pointer, or undefined when the path does not exist. */
export function valueAt(root: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return root;
  let current: unknown = root;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isRecord(current) && Object.hasOwn(current, key)) current = current[key];
    else return undefined;
  }
  return current;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === 0 || value === false || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

function isPlaceholder(value: unknown): value is string {
  return typeof value === "string" && PLACEHOLDER.test(value);
}

interface Leaf {
  path: string;
  key: string;
  value: unknown;
}

/** Every leaf of a JSON value with its pointer and key name, at most 2,000 of them. */
function leaves(value: unknown, path = "", out: Leaf[] = []): Leaf[] {
  if (out.length >= 2000) return out;
  if (Array.isArray(value)) value.forEach((item, i) => leaves(item, `${path}/${i}`, out));
  else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) leaves(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, out);
  } else out.push({ path, key: path.split("/").at(-1) ?? "", value });
  return out;
}

function keyNames(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => keyNames(item, out));
  else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      keyNames(child, out);
    }
  }
  return out;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The type of the first secret or personal-data shape found in `text`, or null. Placeholders never match. */
export function secretShape(text: string): string | null {
  if (PLACEHOLDER.test(text)) return null;
  for (const [pattern, label] of SECRET_SHAPES) if (pattern.test(text)) return label;
  const digits = text.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(digits) && luhn(digits)) return "card number";
  return null;
}

function show(value: unknown): string {
  if (value === undefined) return "(none)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

export function changeViews(lesson: PendingLesson, max = 2): ChangeView[] {
  return lesson.changedPaths.slice(0, max).map((path) => ({
    path,
    before: show(valueAt(lesson.trapArguments, path)),
    after: show(valueAt(lesson.fixArguments, path)),
  }));
}

/** Is this changed path a real change? Mirrors SOP section 7, including the known false negative for true to false. */
function meaningful(before: unknown, after: unknown): boolean {
  if (after === undefined) return false; // removed
  if (after === false && before === true) return true; // a capability switched off
  if (isEmpty(after)) return false;
  if (isPlaceholder(before) && isPlaceholder(after) && !(SANCTIONED_PLACEHOLDERS.has(before) && SANCTIONED_PLACEHOLDERS.has(after) && before !== after)) {
    return false; // a relabel between descriptive stand-ins
  }
  return true;
}

function textFields(lesson: PendingLesson): string[] {
  return [lesson.taskDescription, lesson.violationRule, lesson.steeringDirective ?? "", lesson.statutoryAnchor ?? ""];
}

/** Gates G1 to G5 and the triage results for one lesson, on its own (no knowledge of the rest of the batch). */
export function lessonFlags(lesson: PendingLesson): DigestFlag[] {
  const flags: DigestFlag[] = [];
  const fixLeaves = leaves(lesson.fixArguments);
  const trapLeaves = leaves(lesson.trapArguments);

  // G1 injection: reviewer-directed imperatives anywhere in the lesson's text.
  const injected = [...textFields(lesson), ...fixLeaves.map((leaf) => leaf.value), ...trapLeaves.map((leaf) => leaf.value)].some(
    (value) => typeof value === "string" && INJECTION.test(value),
  );
  if (injected) flags.push({ code: "injection", severity: "reject", reason: "adversarial", text: "text addressed to the reviewer" });

  // G2 secrets and PII: the type of data only, never the value.
  const hit = [
    ...fixLeaves.map((leaf) => ({ where: `fix ${leaf.path}`, text: leaf.value })),
    ...trapLeaves.map((leaf) => ({ where: `trap ${leaf.path}`, text: leaf.value })),
    ...keyNames(lesson.fixArguments).map((key) => ({ where: "fix key", text: key })),
    ...textFields(lesson).map((text) => ({ where: "text", text })),
  ]
    .map((item) => ({ where: item.where, shape: typeof item.text === "string" ? secretShape(item.text) : null }))
    .find((item) => item.shape !== null);
  if (hit) flags.push({ code: "secret_or_pii", severity: "reject", reason: "pii_or_secret", text: `${hit.shape} in ${hit.where}` });

  // G3 fix validity (SOP 6.2 to 6.4).
  const literal = fixLeaves.find((leaf) => EVIDENCE_KEY.test(leaf.key) && typeof leaf.value === "string" && leaf.value !== "" && !isPlaceholder(leaf.value));
  if (literal) flags.push({ code: "literal_evidence", severity: "reject", reason: "incorrect_fix", text: `evidence field ${literal.path} holds a literal` });
  const outcome = fixLeaves.find((leaf) => isPlaceholder(leaf.value) && !SANCTIONED_PLACEHOLDERS.has(leaf.value as string) && OUTCOME_TOKEN.test(leaf.value as string));
  if (outcome) flags.push({ code: "outcome_placeholder", severity: "reject", reason: "incorrect_fix", text: `${outcome.path} asserts an outcome` });
  const weakened = lesson.changedPaths.find((path) => {
    const key = path.split("/").at(-1) ?? "";
    const after = valueAt(lesson.fixArguments, path);
    return WEAKENING_KEY.test(key) && valueAt(lesson.trapArguments, path) === undefined && !isEmpty(after);
  });
  if (weakened) flags.push({ code: "weakening", severity: "reject", reason: "incorrect_fix", text: `${weakened} adds a skip, bypass or override style option` });
  for (const path of lesson.changedPaths) {
    const key = path.split("/").at(-1) ?? "";
    const before = valueAt(lesson.trapArguments, path);
    const after = valueAt(lesson.fixArguments, path);
    if (!CLEARANCE_KEY.test(key) || EVIDENCE_KEY.test(key)) continue;
    const passing = after === true || (typeof after === "string" && PASSING_VALUE.test(after));
    const wasPassing = before === true || (typeof before === "string" && PASSING_VALUE.test(before));
    if (!passing || wasPassing) continue;
    const parent = path.slice(0, path.lastIndexOf("/"));
    const evidence = fixLeaves.some((leaf) => EVIDENCE_KEY.test(leaf.key) && leaf.path.slice(0, leaf.path.lastIndexOf("/")) === parent && leaf.value === "[VERIFIED_STATE]");
    if (!evidence) {
      flags.push({ code: "clearance_flip", severity: "reject", reason: "incorrect_fix", text: `${path} flipped to passing with no [VERIFIED_STATE] evidence beside it` });
      break;
    }
    if (typeof before === "string" && ADVERSE_VALUE.test(before)) {
      flags.push({ code: "clearance_flip", severity: "look", reason: null, text: `${path} moved from an adverse result to passing` });
      break;
    }
  }

  // G4 delta.
  const substantive = lesson.changedPaths.filter((path) => meaningful(valueAt(lesson.trapArguments, path), valueAt(lesson.fixArguments, path)));
  if (substantive.length === 0) flags.push({ code: "no_substantive_change", severity: "reject", reason: "degenerate_delta", text: "no change that addresses the rule" });
  const numbers = fixLeaves.filter((leaf) => typeof leaf.value === "number");
  if (numbers.length > 0 && numbers.every((leaf) => leaf.value === 0) && trapLeaves.some((leaf) => typeof leaf.value === "number" && leaf.value !== 0)) {
    flags.push({ code: "zeroed_numbers", severity: "look", reason: null, text: "every number in the fix is 0 (fine only for an explicit abort)" });
  }

  // G5 duplicate against what is already approved.
  if (lesson.coverage.sameDelta !== null) {
    flags.push({ code: "same_delta", severity: "reject", reason: "duplicate", text: `same delta as approved ${lesson.coverage.sameDelta.slice(0, 8)}` });
  } else if (lesson.coverage.sameRuleClass !== null) {
    flags.push({ code: "covered", severity: "look", reason: null, text: `rule class covered by approved ${lesson.coverage.sameRuleClass.slice(0, 8)}` });
  }

  // Server triage: a failed check is a strong signal, judged against the rubric (SOP section 4).
  for (const check of lesson.triage) {
    if (!check.passed) flags.push({ code: `triage:${check.check}`, severity: "look", reason: null, text: `triage ${check.check} failed` });
  }
  return flags;
}

const GATE_ORDER: ReviewReasonCode[] = ["adversarial", "pii_or_secret", "incorrect_fix", "degenerate_delta", "duplicate"];

/** Reject when a reject-severity flag fired (first by gate order), leave when there is any doubt, else approve. */
export function propose(flags: readonly DigestFlag[]): Proposal {
  const rejects = flags.filter((flag) => flag.severity === "reject" && flag.reason !== null);
  if (rejects.length > 0) {
    const reasonCode = GATE_ORDER.find((code) => rejects.some((flag) => flag.reason === code)) ?? rejects[0]!.reason!;
    return { decision: "reject", reasonCode };
  }
  return flags.length > 0 ? { decision: "leave" } : { decision: "approve" };
}

function ruleClassKey(lesson: PendingLesson): string {
  return `${lesson.domain}|${lesson.tool}|${[...lesson.changedPaths].sort().join(",")}`;
}

/** The delta, as a hash-free fingerprint of what changed, for spotting repeats inside one digest. */
function deltaKey(lesson: PendingLesson): string {
  return `${lesson.domain}|${lesson.tool}|${JSON.stringify(lesson.changedPaths.map((path) => [path, valueAt(lesson.fixArguments, path)]))}`;
}

/**
 * The digest for a list of queued lessons: sorted by domain, tool and rule class (so repeats sit next to each
 * other), numbered from 1, with the per-lesson flags plus the repeats inside this batch.
 */
export function buildDigest(lessons: readonly PendingLesson[]): DigestRow[] {
  const sorted = [...lessons].sort(
    (a, b) =>
      a.domain.localeCompare(b.domain) ||
      a.tool.localeCompare(b.tool) ||
      ruleClassKey(a).localeCompare(ruleClassKey(b)) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.lessonId.localeCompare(b.lessonId),
  );
  const firstByClass = new Map<string, number>();
  const firstByDelta = new Map<string, number>();
  return sorted.map((lesson, position) => {
    const index = position + 1;
    const flags = lessonFlags(lesson);
    const sameDeltaAs = firstByDelta.get(deltaKey(lesson));
    const sameClassAs = firstByClass.get(ruleClassKey(lesson));
    if (sameDeltaAs !== undefined) {
      flags.push({ code: "batch_duplicate", severity: "reject", reason: "duplicate", text: `identical to #${sameDeltaAs} in this batch` });
    } else if (sameClassAs !== undefined) {
      flags.push({ code: "batch_same_rule_class", severity: "look", reason: null, text: `same rule class as #${sameClassAs} in this batch` });
    }
    if (!firstByDelta.has(deltaKey(lesson))) firstByDelta.set(deltaKey(lesson), index);
    if (!firstByClass.has(ruleClassKey(lesson))) firstByClass.set(ruleClassKey(lesson), index);
    const covered = lesson.coverage.sameDelta ?? lesson.coverage.sameRuleClass;
    return {
      lesson,
      index,
      ruleClass: lesson.changedPaths.length === 0 ? "(none)" : `${lesson.changedPaths.slice(0, 3).join(", ")}${lesson.changedPaths.length > 3 ? ` +${lesson.changedPaths.length - 3}` : ""}`,
      changes: changeViews(lesson),
      flags,
      proposal: lesson.reviewStatus === "quarantined" && propose(flags).decision === "approve" ? { decision: "leave" } : propose(flags),
      coverage: covered === null ? { kind: "new" } : { kind: "covered", by: covered },
    };
  });
}
