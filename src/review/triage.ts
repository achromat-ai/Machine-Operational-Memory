/**
 * Automated triage for a freshly bound lesson.
 *
 * triage_checks and the triage_pass / triage_fail review event are written in
 * ONE D1 batch, so a lesson is either untouched or fully triaged, and a second
 * runner aborts harmlessly on the triage_checks guard. The review_events
 * triggers (not this code) decide what a verdict means:
 *
 *   community lesson   triage_pass → pending_review, visible to the submitter only
 *                      triage_fail → quarantined, visible to no one
 *   bounty lesson      triage_pass → pending_review, then internal auto-approval (below)
 *                      triage_fail → pending_review, a human must approve
 *
 * Community lessons are NEVER approved here: the ledger only lets a human approve
 * them. Internal (bounty) lessons are auto-approved by internal_auto
 * when the fixing key still has auto-approval enabled, and 10% of those are
 * sampled for a later human audit (audit_status 'sampled').
 */
import type { Env } from "../env";
import type { DeltaChange } from "../pairing";
import { findPii, jsonStrings } from "./pii";

export const TRIAGE_VERSION = "triage-v1";
export const AUTO_APPROVE_ACTOR = "internal-auto-v1";
export const AUDIT_SAMPLE_RATE = 0.1;

export const BURST_LESSONS_PER_AGENT_PER_HOUR = 5;
export const BURST_LESSONS_PER_NETWORK_PER_HOUR = 20;
export const REPUTATION_RECENT_REJECTS = 2;
export const REPUTATION_WINDOW_MS = 7 * 86_400_000;
export const INTERNAL_PAUSE_WINDOW_MS = 30 * 86_400_000;
const HOUR_MS = 3_600_000;

export type CheckName =
  | "non_degenerate_delta"
  | "secret_pii_scan"
  | "same_tool_bundle"
  | "near_duplicate"
  | "submitter_reputation"
  | "burst"
  | "internal_anomaly";

export interface CheckResult {
  name: CheckName;
  passed: boolean;
  score: number | null;
  /** Labels and counts only. Never argument values or matched text. */
  details: Record<string, unknown>;
}

export interface LessonRecord {
  lesson_id: string;
  domain: string;
  tool_name: string;
  task_fingerprint: string;
  violation_rule: string;
  delta_json: string;
  delta_hash: string;
  provenance: "community" | "admin_seed" | "community_trap+internal_fix";
  source_agent_key: string;
  fixed_by_key: string | null;
  created_at_ms: number;
  review_status: string;
  visibility: string;
  task_description: string;
  fix_arguments_json: string;
  fix_tool: string;
  fix_bundle: string | null;
  fix_policies: string | null;
  trap_arguments_json: string;
  trap_tool: string;
  trap_bundle: string | null;
  trap_policies: string | null;
  steering_directive: string | null;
  statutory_anchor: string | null;
}

export function loadLesson(env: Env, lessonId: string): Promise<LessonRecord | null> {
  return env.DB.prepare(
    `SELECT l.lesson_id, l.domain, l.tool_name, l.task_fingerprint, l.violation_rule, l.delta_json, l.delta_hash,
            l.provenance, l.source_agent_key, l.fixed_by_key, l.created_at_ms,
            s.review_status, s.visibility,
            f.task_description, f.fix_arguments_json, f.tool_name AS fix_tool, f.bundle_id AS fix_bundle,
            f.policy_ids_json AS fix_policies,
            e.trap_arguments_json, e.tool_name AS trap_tool, e.bundle_id AS trap_bundle,
            e.policy_ids_json AS trap_policies, e.steering_directive, e.statutory_anchor
       FROM lessons l
       JOIN lesson_state s ON s.lesson_id = l.lesson_id
       JOIN fixes f ON f.allow_receipt_id = l.fix_event_id
       JOIN trap_events e ON e.block_receipt_id = l.trap_event_id
      WHERE l.lesson_id = ?1`,
  )
    .bind(lessonId)
    .first<LessonRecord>();
}

// ════════════════════════════════════════════════════════════════════════
// Pure checks
// ════════════════════════════════════════════════════════════════════════

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === 0 ||
    value === false ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0) ||
    (isObject(value) && Object.keys(value).length === 0)
  );
}

function numericLeaves(value: unknown): number[] {
  const out: number[] = [];
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0 && visited++ < 20_000) {
    const node = stack.pop();
    if (typeof node === "number") out.push(node);
    else if (Array.isArray(node)) stack.push(...node);
    else if (isObject(node)) stack.push(...Object.values(node));
  }
  return out;
}

/** Degenerate: nothing was added or changed to something real, or the fix just zeroes the numbers. */
export function checkDelta(lesson: Pick<LessonRecord, "delta_json" | "fix_arguments_json" | "trap_arguments_json">): CheckResult {
  const delta = parseJson(lesson.delta_json);
  const changes = isObject(delta) && Array.isArray(delta.changes) ? (delta.changes as DeltaChange[]) : null;
  if (changes === null || changes.length === 0) {
    return { name: "non_degenerate_delta", passed: false, score: 0, details: { reason: "delta_unreadable" } };
  }
  const meaningful = changes.filter((change) => {
    if (change.kind === "removed") return false;
    // values_omitted deltas keep paths and kinds only: an added or changed path counts.
    return !("after" in change) || !isEmptyValue(change.after);
  }).length;
  const fixNumbers = numericLeaves(parseJson(lesson.fix_arguments_json));
  const trapNumbers = numericLeaves(parseJson(lesson.trap_arguments_json));
  const zeroed = fixNumbers.length > 0 && fixNumbers.every((n) => n === 0) && trapNumbers.some((n) => n !== 0);

  const reasons: string[] = [];
  if (meaningful === 0) reasons.push("no_meaningful_change");
  if (zeroed) reasons.push("all_numbers_zeroed");
  return {
    name: "non_degenerate_delta",
    passed: reasons.length === 0,
    score: meaningful / changes.length,
    details: { changes: changes.length, meaningful, ...(reasons.length > 0 ? { reasons } : {}) },
  };
}

/** Scans everything a lesson stores or serves: both argument sets, the task, the rule and the steering text. */
export function checkPii(lesson: LessonRecord): CheckResult {
  const sources: Array<[string, string[]]> = [
    ["fix_arguments", jsonStrings(parseJson(lesson.fix_arguments_json))],
    ["trap_arguments", jsonStrings(parseJson(lesson.trap_arguments_json))],
    ["task_description", [lesson.task_description]],
    ["violation_rule", [lesson.violation_rule]],
    ["steering_directive", lesson.steering_directive === null ? [] : [lesson.steering_directive]],
    ["statutory_anchor", lesson.statutory_anchor === null ? [] : [lesson.statutory_anchor]],
  ];
  const hits: Array<{ field: string; kind: string }> = [];
  for (const [field, strings] of sources) {
    for (const text of strings) {
      const kind = findPii(text);
      if (kind !== null) {
        hits.push({ field, kind });
        break;
      }
    }
  }
  return { name: "secret_pii_scan", passed: hits.length === 0, score: null, details: { hits } };
}

/** Pairing already enforces domain, tool and fingerprint; this records that tool, bundle and policy set agree too. */
export function checkSameToolBundle(lesson: LessonRecord): CheckResult {
  const mismatches: string[] = [];
  if (lesson.fix_tool !== lesson.tool_name || lesson.trap_tool !== lesson.tool_name) mismatches.push("tool");
  if (lesson.fix_bundle !== lesson.trap_bundle) mismatches.push("bundle");
  if (lesson.fix_policies !== lesson.trap_policies) mismatches.push("policy_ids");
  return { name: "same_tool_bundle", passed: mismatches.length === 0, score: null, details: { mismatches } };
}

// ════════════════════════════════════════════════════════════════════════
// D1-backed checks
// ════════════════════════════════════════════════════════════════════════

async function count(env: Env, sql: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...params).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Informational only (never fails): same-task lessons and identical deltas, as corroboration hints for reviewers. */
async function checkNearDuplicate(env: Env, lesson: LessonRecord): Promise<CheckResult> {
  const sameTask = await count(
    env,
    `SELECT count(*) AS n FROM lessons l JOIN lesson_state s ON s.lesson_id = l.lesson_id
      WHERE l.domain = ?1 AND l.tool_name = ?2 AND l.task_fingerprint = ?3 AND l.lesson_id <> ?4 AND s.review_status = 'approved'`,
    lesson.domain,
    lesson.tool_name,
    lesson.task_fingerprint,
    lesson.lesson_id,
  );
  const sameDelta = await count(
    env,
    "SELECT count(*) AS n FROM lessons WHERE delta_hash = ?1 AND lesson_id <> ?2",
    lesson.delta_hash,
    lesson.lesson_id,
  );
  return { name: "near_duplicate", passed: true, score: null, details: { approved_same_task: sameTask, same_delta: sameDelta } };
}

async function checkReputation(env: Env, lesson: LessonRecord): Promise<CheckResult> {
  const state = await env.DB.prepare("SELECT approved_count, rejected_count FROM agent_state WHERE agent_key = ?1")
    .bind(lesson.source_agent_key)
    .first<{ approved_count: number; rejected_count: number }>();
  const approved = state?.approved_count ?? 0;
  const rejected = state?.rejected_count ?? 0;
  const recentRejects = await count(
    env,
    `SELECT count(*) AS n FROM review_events r JOIN lessons l ON l.lesson_id = r.lesson_id
      WHERE l.source_agent_key = ?1 AND r.action IN ('reject', 'audit_reject') AND r.at_ms > ?2`,
    lesson.source_agent_key,
    lesson.created_at_ms - REPUTATION_WINDOW_MS,
  );
  const failed = recentRejects >= REPUTATION_RECENT_REJECTS || (rejected >= 3 && rejected > approved);
  return {
    name: "submitter_reputation",
    passed: !failed,
    score: null,
    details: { approved, rejected, recent_rejects: recentRejects },
  };
}

/** Lessons from one key, or from one /24-/48 network, in the hour up to and including this lesson. */
async function checkBurst(env: Env, lesson: LessonRecord): Promise<CheckResult> {
  const from = lesson.created_at_ms - HOUR_MS;
  const perAgent = await count(
    env,
    "SELECT count(*) AS n FROM lessons WHERE source_agent_key = ?1 AND created_at_ms > ?2 AND created_at_ms <= ?3",
    lesson.source_agent_key,
    from,
    lesson.created_at_ms,
  );
  const attempt = await env.DB.prepare(
    `SELECT client_ip_hmac FROM calibration_attempts
      WHERE agent_key = ?1 AND task_fingerprint = ?2 AND verdict = 1 AND client_ip_hmac IS NOT NULL
      ORDER BY created_at_ms DESC LIMIT 1`,
  )
    .bind(lesson.source_agent_key, lesson.task_fingerprint)
    .first<{ client_ip_hmac: string }>();
  const perNetwork = attempt
    ? await count(
        env,
        `SELECT count(*) AS n FROM lessons
          WHERE created_at_ms > ?1 AND created_at_ms <= ?2
            AND source_agent_key IN (SELECT agent_key FROM calibration_attempts
                                      WHERE client_ip_hmac = ?3 AND created_at_ms > ?1)`,
        from,
        lesson.created_at_ms,
        attempt.client_ip_hmac,
      )
    : 0;
  const failed = perAgent > BURST_LESSONS_PER_AGENT_PER_HOUR || perNetwork > BURST_LESSONS_PER_NETWORK_PER_HOUR;
  return { name: "burst", passed: !failed, score: null, details: { per_agent_hour: perAgent, per_network_hour: perNetwork } };
}

/** Bounty lessons only: the fixing key must be a live internal key with no recent audit failure. */
async function checkInternalAnomaly(env: Env, lesson: LessonRecord): Promise<CheckResult> {
  const key = lesson.fixed_by_key;
  const state = key
    ? await env.DB.prepare("SELECT role, status FROM agent_state WHERE agent_key = ?1").bind(key).first<{ role: string; status: string }>()
    : null;
  const pauses = key
    ? await count(
        env,
        "SELECT count(*) AS n FROM agent_events WHERE agent_key = ?1 AND kind = 'auto_approve_paused' AND at_ms > ?2",
        key,
        lesson.created_at_ms - INTERNAL_PAUSE_WINDOW_MS,
      )
    : 0;
  const reasons: string[] = [];
  if (!state || state.role !== "internal") reasons.push("fixing_key_not_internal");
  else if (state.status !== "active") reasons.push("fixing_key_not_active");
  if (pauses > 0) reasons.push("recent_audit_failure");
  return { name: "internal_anomaly", passed: reasons.length === 0, score: null, details: { reasons } };
}

export async function runChecks(env: Env, lesson: LessonRecord): Promise<CheckResult[]> {
  const results = [
    checkDelta(lesson),
    checkPii(lesson),
    checkSameToolBundle(lesson),
    await checkNearDuplicate(env, lesson),
    await checkReputation(env, lesson),
    await checkBurst(env, lesson),
  ];
  if (lesson.provenance === "community_trap+internal_fix") results.push(await checkInternalAnomaly(env, lesson));
  return results;
}

// ════════════════════════════════════════════════════════════════════════
// Verdict
// ════════════════════════════════════════════════════════════════════════

export interface TriageOutcome {
  state: "missing" | "not_pending" | "already_triaged" | "passed" | "failed";
  failed: string[];
}

function isTriageRace(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("check already recorded") || text.includes("no longer awaiting triage") || text.includes("triage applies only");
}

/** Runs every check and records the verdict. Safe to call repeatedly: only the first run for a lesson writes. */
export async function runTriage(env: Env, lessonId: string, nowMs: number = Date.now()): Promise<TriageOutcome> {
  const lesson = await loadLesson(env, lessonId);
  if (lesson === null) return { state: "missing", failed: [] };
  if (lesson.review_status !== "pending_triage") return { state: "not_pending", failed: [] };

  const results = await runChecks(env, lesson);
  const failed = results.filter((result) => !result.passed).map((result) => result.name);
  const pass = failed.length === 0;

  const statements = results.map((result) =>
    env.DB.prepare("INSERT INTO triage_checks (lesson_id, check_name, passed, score, details_json, at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(
      lessonId,
      result.name,
      result.passed ? 1 : 0,
      result.score,
      JSON.stringify(result.details),
      nowMs,
    ),
  );
  statements.push(
    env.DB.prepare(
      `INSERT INTO review_events (event_id, lesson_id, actor_type, actor_id, action, reason_code, details_json, at_ms)
       VALUES (?1, ?2, 'triage', ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      crypto.randomUUID(),
      lessonId,
      TRIAGE_VERSION,
      pass ? "triage_pass" : "triage_fail",
      pass ? null : failed[0],
      JSON.stringify({ version: TRIAGE_VERSION, checks: results.map((r) => r.name), failed }),
      nowMs,
    ),
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (isTriageRace(error)) return { state: "already_triaged", failed: [] };
    throw error;
  }
  return { state: pass ? "passed" : "failed", failed };
}

// ════════════════════════════════════════════════════════════════════════
// Internal (bounty) auto-approval and the 10% audit lottery
// ════════════════════════════════════════════════════════════════════════

const encoder = new TextEncoder();

/**
 * Deterministic, auditable draw: SHA-256("achromat-audit-v1\n" + lesson_id), first 4 bytes as a
 * fraction of 2^32. lesson_id is a server-generated random UUID, so a submitter cannot steer it.
 */
export async function auditDraw(lessonId: string): Promise<{ value: number; sampled: boolean }> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`achromat-audit-v1\n${lessonId}`)));
  const uint = ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
  const value = uint / 2 ** 32;
  return { value, sampled: value < AUDIT_SAMPLE_RATE };
}

export type AutoApproveOutcome = "not_applicable" | "blocked" | "approved" | "approved_and_sampled";

/**
 * Bounty lessons only. After triage_pass the lesson is pending_review; internal_auto approves it if
 * the review_events guard allows (fixing key internal, auto-approval enabled, triage_pass on file),
 * and the lottery may sample the approved lesson for a human audit. Both events go in one batch.
 * Community lessons are never touched: only a human can approve them.
 */
export async function autoApproveBounty(env: Env, lessonId: string, nowMs: number = Date.now()): Promise<AutoApproveOutcome> {
  const lesson = await loadLesson(env, lessonId);
  if (lesson === null || lesson.provenance !== "community_trap+internal_fix" || lesson.review_status !== "pending_review") {
    return "not_applicable";
  }
  const draw = await auditDraw(lessonId);
  const statements = [
    env.DB.prepare(
      `INSERT INTO review_events (event_id, lesson_id, actor_type, actor_id, action, reason_code, details_json, at_ms)
       VALUES (?1, ?2, 'internal_auto', ?3, 'approve', NULL, ?4, ?5)`,
    ).bind(
      crypto.randomUUID(),
      lessonId,
      AUTO_APPROVE_ACTOR,
      JSON.stringify({ fixed_by_key: lesson.fixed_by_key, audit_draw: draw.value, audit_rate: AUDIT_SAMPLE_RATE, sampled: draw.sampled }),
      nowMs,
    ),
  ];
  if (draw.sampled) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO review_events (event_id, lesson_id, actor_type, actor_id, action, reason_code, details_json, at_ms)
         VALUES (?1, ?2, 'audit_sampler', ?3, 'sample_for_audit', NULL, ?4, ?5)`,
      ).bind(crypto.randomUUID(), lessonId, TRIAGE_VERSION, JSON.stringify({ audit_draw: draw.value, audit_rate: AUDIT_SAMPLE_RATE }), nowMs),
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    // The guard refused (auto-approval disabled or paused, or no triage_pass): a human decides.
    console.log("achromat-mom bounty lesson left for human review", lessonId, error instanceof Error ? error.message : error);
    return "blocked";
  }
  return draw.sampled ? "approved_and_sampled" : "approved";
}
