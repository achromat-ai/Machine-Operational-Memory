/**
 * POST /api/v1/calibrate (signed): passive, server-side ingestion.
 *
 * MOM evaluates the agent's candidate tool call against api.ramenai.dev with
 * its own key, verifies the Schema V5 receipt locally, and records the result
 * against the caller's Ed25519 identity. Agents never submit receipts.
 *
 * Order (no community quota is spent on an invalid request):
 *   secrets configured → per-agent limit (120/h) → body → domain → global
 *   upstream ceiling (1,000/h) → ramen-ai → receipt verify + bind → one D1 batch.
 *
 * Turn 1, BLOCK (verdict 0): the attempt log, then open or join the agent's
 *   24-hour trap for (domain, tool, task_fingerprint) and append the BLOCK.
 * Turn 2, ALLOW (verdict 1): the attempt log, then pair with the agent's open
 *   trap for the same task: fixes row (the trap's open → paired transition) plus
 *   a pending_triage lesson, or a corroboration when the dedup key already has one.
 *   No open trap: the ALLOW is kept as unpaired evidence.
 *
 * The D1 triggers in 0001_event_ledger.sql re-check every window and pairing
 * rule, so a bug here cannot pair what the ledger would reject.
 */
import { Hono, type Context } from "hono";
import { upstreamScopeFor } from "../config/domains";
import { MOM_ATTESTATION_KID, assertPairingSecrets, signPairAttestation, visibilityToken } from "../crypto/attestation";
import { verifyRamenReceipt, type ReceiptCheck, type VerifiedReceipt } from "../crypto/receipt";
import type { Env } from "../env";
import { apiError, parseJsonBytes } from "../http";
import type { AuthenticatedAgent, AuthVariables } from "../middleware/auth";
import { networkPrefix, networkPrefixHmac } from "../network";
import {
  STATUTORY_ANCHOR_MAX,
  STEERING_DIRECTIVE_MAX,
  buildPairDelta,
  cleanText,
  deriveSteeringDirective,
  deriveViolationRule,
} from "../pairing";
import {
  canonicalJson,
  parseCalibrateRequest,
  taskFingerprint,
  type TrapSubmission,
  type UpstreamEvaluation,
} from "../schema";
import { processLesson } from "../review/pipeline";
import { EMBED_VERSION } from "../search/intent";
import type { SearchFactory } from "../search/vectors";
import { evaluateUpstream } from "../upstream/evaluate";
import { HOUR_MS, consumeUsage, secondsUntil } from "../usage";

export { EMBED_VERSION, HOUR_MS };
export const CALIBRATE_LIMIT_PER_AGENT_PER_HOUR = 120;
export const CALIBRATE_GLOBAL_LIMIT_PER_HOUR = 1000;
export const TRAP_WINDOW_MS = 86_400_000;
export const GLOBAL_USAGE_KEY = "calibrate:global";

export function agentUsageKey(agentKey: string): string {
  return `calibrate:agent:${agentKey}`;
}

type CalibrateEnv = { Bindings: Env; Variables: AuthVariables };

export interface CalibrateOptions {
  /** Trusted ramen-ai receipt keys by kid (raw Ed25519 hex). Production passes the pinned keys. */
  receiptKeys: Readonly<Record<string, string>>;
  /** Embedder and vector store for the background triage and sync that follow a new lesson. */
  search: SearchFactory;
}

// ════════════════════════════════════════════════════════════════════════
// Shared context for one evaluated call
// ════════════════════════════════════════════════════════════════════════

interface CallContext {
  env: Env;
  agent: AuthenticatedAgent;
  body: TrapSubmission;
  bundleId: string;
  fingerprint: string;
  input: string;
  argumentsJson: string;
  evaluation: UpstreamEvaluation;
  check: ReceiptCheck;
  clientIpHmac: string | null;
}

/** calibration_attempts insert for this call. `error` is a short internal reason, never input. */
function attemptStatement(ctx: CallContext, attemptId: string, nowMs: number, error: string | null): D1PreparedStatement {
  let receiptJson: string | null = null;
  let verified = ctx.check.verified ? 1 : 0;
  let bound = ctx.check.bound ? 1 : 0;
  const rawReceipt = ctx.evaluation.receipt;
  if (rawReceipt !== undefined && rawReceipt !== null) {
    const json = JSON.stringify(rawReceipt);
    if (typeof json === "string" && json.length <= 32768) receiptJson = json;
  }
  if (receiptJson === null) {
    // The CHECK requires a logged receipt for verified rows.
    verified = 0;
    bound = 0;
  }
  return ctx.env.DB.prepare(
    `INSERT INTO calibration_attempts
       (attempt_id, agent_key, domain, tool_name, task_fingerprint, task_description, arguments_json,
        evaluated_input, verdict, receipt_json, receipt_verified, receipt_bound, error, client_ip_hmac, created_at_ms)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
  ).bind(
    attemptId,
    ctx.agent.agentKey,
    ctx.body.domain,
    ctx.body.tool,
    ctx.fingerprint,
    ctx.body.task_description,
    ctx.argumentsJson,
    ctx.input,
    ctx.evaluation.allowed ? 1 : 0,
    receiptJson,
    verified,
    bound,
    error === null ? null : error.slice(0, 500),
    ctx.clientIpHmac,
    nowMs,
  );
}

/** Records the attempt alone (no trap or fix). Logging failures never fail the agent's call. */
async function recordAttemptOnly(ctx: CallContext, error: string | null): Promise<void> {
  try {
    await attemptStatement(ctx, crypto.randomUUID(), Date.now(), error).run();
  } catch (failure) {
    console.error("achromat-mom calibrate attempt log failed", failure);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ════════════════════════════════════════════════════════════════════════
// Turn 1: BLOCK → trap
// ════════════════════════════════════════════════════════════════════════

export interface TrapOutcome {
  recorded: boolean;
  trap_id?: string;
  attempt_seq?: number;
  joined?: boolean;
  opened_at?: string;
  expires_at?: string;
  violation_rule?: string;
  reason?: string;
}

async function ingestBlock(ctx: CallContext, receipt: VerifiedReceipt | null): Promise<TrapOutcome> {
  const { evaluation } = ctx;
  if (!ctx.check.ok || receipt === null) {
    await recordAttemptOnly(ctx, ctx.check.reason ?? "receipt not verified");
    return { recorded: false, reason: "RECEIPT_UNVERIFIED" };
  }
  if ((evaluation.policies_errored ?? 0) > 0) {
    await recordAttemptOnly(ctx, "policy evaluation errored");
    return { recorded: false, reason: "POLICY_ERRORED" };
  }
  if (evaluation.total_violations.length === 0) {
    await recordAttemptOnly(ctx, "block without violations");
    return { recorded: false, reason: "NO_VIOLATIONS" };
  }

  const signed = receipt.signed;
  const violationRule = deriveViolationRule(evaluation, signed);
  const steering = cleanText(deriveSteeringDirective(signed, evaluation), STEERING_DIRECTIVE_MAX);
  const anchor = signed.statutory_anchors.map((a) => cleanText(a, STATUTORY_ANCHOR_MAX)).find((a) => a !== "") ?? null;
  const ruleIds = [...new Set(evaluation.total_violations.map((v) => v.rule_id))].sort().slice(0, 100);
  const policyIdsJson = JSON.stringify([...signed.policy_ids].sort());
  const newTrapId = crypto.randomUUID();
  const now = Date.now();
  const { DB } = ctx.env;
  const { agentKey } = ctx.agent;
  const { domain, tool, task_description: description } = ctx.body;

  try {
    const results = await DB.batch<{ trap_id: string; opened_at_ms: number; expires_at_ms: number; attempt_seq: number }>([
      attemptStatement(ctx, crypto.randomUUID(), now, null),
      // Open a window only if none is open. Zero rows otherwise, so traps_guard_insert never fires.
      DB.prepare(
        `INSERT INTO traps (trap_id, agent_key, domain, tool_name, task_fingerprint, opened_at_ms, expires_at_ms)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
          WHERE NOT EXISTS (
            SELECT 1 FROM traps t
             WHERE t.agent_key = ?2 AND t.domain = ?3 AND t.tool_name = ?4 AND t.task_fingerprint = ?5
               AND t.expires_at_ms > (SELECT now_ms FROM db_clock)
               AND NOT EXISTS (SELECT 1 FROM fixes f WHERE f.trap_id = t.trap_id))`,
      ).bind(newTrapId, agentKey, domain, tool, ctx.fingerprint, now, now + TRAP_WINDOW_MS),
      // Append the BLOCK to the open window (new or existing) with the next attempt_seq.
      DB.prepare(
        `INSERT INTO trap_events
           (block_receipt_id, trap_id, attempt_seq, agent_key, domain, tool_name, task_fingerprint, task_description,
            trap_arguments_json, evaluated_input, receipt_signature, receipt_canonical_payload, payload_hash,
            bundle_id, policy_ids_json, violation_rule, rule_ids_json, steering_directive, statutory_anchor, recorded_at_ms)
         SELECT ?1, t.trap_id,
                (SELECT coalesce(max(e.attempt_seq), 0) + 1 FROM trap_events e WHERE e.trap_id = t.trap_id),
                ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
           FROM traps t
          WHERE t.agent_key = ?2 AND t.domain = ?3 AND t.tool_name = ?4 AND t.task_fingerprint = ?5
            AND t.expires_at_ms > (SELECT now_ms FROM db_clock)
            AND NOT EXISTS (SELECT 1 FROM fixes f WHERE f.trap_id = t.trap_id)
          ORDER BY t.opened_at_ms DESC
          LIMIT 1`,
      ).bind(
        receipt.id,
        agentKey,
        domain,
        tool,
        ctx.fingerprint,
        description,
        ctx.argumentsJson,
        ctx.input,
        receipt.signature,
        receipt.canonicalPayload,
        signed.payload_hash,
        ctx.bundleId,
        policyIdsJson,
        violationRule,
        JSON.stringify(ruleIds),
        steering,
        anchor,
        now,
      ),
      DB.prepare(
        `SELECT t.trap_id, t.opened_at_ms, t.expires_at_ms, e.attempt_seq
           FROM trap_events e JOIN traps t ON t.trap_id = e.trap_id
          WHERE e.block_receipt_id = ?1`,
      ).bind(receipt.id),
    ]);
    const row = results[3]?.results[0];
    if (!row) throw new Error("trap_events row missing after insert");
    return {
      recorded: true,
      trap_id: row.trap_id,
      attempt_seq: row.attempt_seq,
      joined: row.trap_id !== newTrapId,
      opened_at: new Date(row.opened_at_ms).toISOString(),
      expires_at: new Date(row.expires_at_ms).toISOString(),
      violation_rule: violationRule,
    };
  } catch (error) {
    console.error("achromat-mom trap ingestion failed", errorText(error));
    await recordAttemptOnly(ctx, `trap ingestion failed: ${errorText(error)}`);
    return { recorded: false, reason: "INGESTION_CONFLICT" };
  }
}

// ════════════════════════════════════════════════════════════════════════
// Turn 2: ALLOW → fix
// ════════════════════════════════════════════════════════════════════════

export interface PairingOutcome {
  paired: boolean;
  /** Whether the agent's trap_id handle (if sent) matched the trap the key-based lookup found. */
  handle: "matched" | "ignored" | null;
  trap_id?: string;
  lesson_id?: string;
  corroboration_id?: string;
  review_status?: "pending_triage";
  outcome?: "unpaired_no_trap" | "unpaired_expired";
  reason?: string;
}

interface OpenTrapRow {
  trap_id: string;
  block_receipt_id: string;
  trap_arguments_json: string;
  policy_ids_json: string | null;
  violation_rule: string | null;
  block_signed_at: string | null;
}

/**
 * The agent's open trap for this task: same key, domain, tool and fingerprint,
 * inside its 24 hours (expires_at_ms = opened_at_ms + 24 h), not yet paired,
 * joined to its canonical first BLOCK. traps_guard_insert allows at most one.
 */
function findOpenTrap(ctx: CallContext): Promise<OpenTrapRow | null> {
  return ctx.env.DB.prepare(
    `SELECT t.trap_id, e.block_receipt_id, e.trap_arguments_json, e.policy_ids_json, e.violation_rule,
            json_extract(e.receipt_canonical_payload, '$.timestamp') AS block_signed_at
       FROM traps t
       JOIN trap_events e ON e.trap_id = t.trap_id AND e.attempt_seq = 1
      WHERE t.agent_key = ?1 AND t.domain = ?2 AND t.tool_name = ?3 AND t.task_fingerprint = ?4
        AND t.expires_at_ms > (SELECT now_ms FROM db_clock)
        AND NOT EXISTS (SELECT 1 FROM fixes f WHERE f.trap_id = t.trap_id)
      ORDER BY t.opened_at_ms DESC
      LIMIT 1`,
  )
    .bind(ctx.agent.agentKey, ctx.body.domain, ctx.body.tool, ctx.fingerprint)
    .first<OpenTrapRow>();
}

function fixStatement(
  ctx: CallContext,
  receipt: VerifiedReceipt,
  trapId: string | null,
  outcome: "paired" | "unpaired_no_trap" | "unpaired_expired",
  nowMs: number,
): D1PreparedStatement {
  return ctx.env.DB.prepare(
    `INSERT INTO fixes
       (allow_receipt_id, trap_id, fix_source, pairing_outcome, agent_key, domain, tool_name, task_fingerprint,
        task_description, fix_arguments_json, evaluated_input, receipt_signature, receipt_canonical_payload,
        payload_hash, bundle_id, policy_ids_json, seed_run_id, recorded_at_ms)
     VALUES (?1, ?2, 'community', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, NULL, ?16)`,
  ).bind(
    receipt.id,
    trapId,
    outcome,
    ctx.agent.agentKey,
    ctx.body.domain,
    ctx.body.tool,
    ctx.fingerprint,
    ctx.body.task_description,
    ctx.argumentsJson,
    ctx.input,
    receipt.signature,
    receipt.canonicalPayload,
    receipt.signed.payload_hash,
    ctx.bundleId,
    JSON.stringify([...receipt.signed.policy_ids].sort()),
    nowMs,
  );
}

/** Trigger aborts that a fresh resolution can resolve (lost race with another write). */
function isRetryableConflict(error: unknown): boolean {
  const text = errorText(error);
  return (
    text.includes("trap is already paired") ||
    text.includes("pairing window has closed") ||
    text.includes("an open trap exists") ||
    text.includes("dedup key already used") ||
    text.includes("UNIQUE constraint failed: fixes.trap_id")
  );
}

async function ingestAllow(ctx: CallContext, receipt: VerifiedReceipt | null, handle: string | null): Promise<PairingOutcome> {
  if (!ctx.check.ok || receipt === null) {
    await recordAttemptOnly(ctx, ctx.check.reason ?? "receipt not verified");
    return { paired: false, handle: handle === null ? null : "ignored", reason: "RECEIPT_UNVERIFIED" };
  }
  const { DB } = ctx.env;

  for (let round = 0; round < 2; round++) {
    const trap = await findOpenTrap(ctx);
    const handleStatus = handle === null ? null : trap !== null && trap.trap_id === handle ? "matched" : "ignored";
    const now = Date.now();
    const attemptId = crypto.randomUUID();

    try {
      if (trap === null) {
        // Unpaired evidence. unpaired_expired needs an expired trap for this task (trigger-checked).
        const expired = await DB.prepare(
          `SELECT EXISTS (SELECT 1 FROM traps t
                           WHERE t.agent_key = ?1 AND t.domain = ?2 AND t.tool_name = ?3 AND t.task_fingerprint = ?4
                             AND t.expires_at_ms <= (SELECT now_ms FROM db_clock)) AS has_expired`,
        )
          .bind(ctx.agent.agentKey, ctx.body.domain, ctx.body.tool, ctx.fingerprint)
          .first<{ has_expired: number }>();
        const outcome = expired?.has_expired ? "unpaired_expired" : "unpaired_no_trap";
        await DB.batch([attemptStatement(ctx, attemptId, now, null), fixStatement(ctx, receipt, null, outcome, now)]);
        return { paired: false, handle: handleStatus, outcome, reason: "NO_OPEN_TRAP" };
      }

      // Pair criteria checked here (the rest are enforced by the receipt check and the D1 triggers):
      //   (7) same signed policy set as the canonical BLOCK,
      //   (8) the ALLOW was signed after the BLOCK,
      //   (9) the fix changes at least one argument path (non-degenerate delta).
      const policyIdsJson = JSON.stringify([...receipt.signed.policy_ids].sort());
      const rejection =
        trap.policy_ids_json !== policyIdsJson
          ? "POLICY_SET_MISMATCH"
          : trap.block_signed_at === null || !(Date.parse(receipt.signed.timestamp) > Date.parse(trap.block_signed_at))
            ? "FIX_PREDATES_TRAP"
            : trap.violation_rule === null
              ? "TRAP_NOT_LESSON_ELIGIBLE"
              : null;
      const delta = rejection === null ? await buildPairDelta(JSON.parse(trap.trap_arguments_json), ctx.body.arguments) : null;
      const reason = rejection ?? (delta === null ? "DEGENERATE_DELTA" : null);
      if (reason !== null || delta === null || trap.violation_rule === null) {
        // An open trap exists, so the ledger forbids an unpaired_no_trap row: log the attempt only.
        await recordAttemptOnly(ctx, `pairing rejected: ${reason}`);
        return { paired: false, handle: handleStatus, trap_id: trap.trap_id, reason: reason ?? "DEGENERATE_DELTA" };
      }

      const attestation = await signPairAttestation(ctx.env.MOM_ATTESTATION_PRIVATE_KEY, {
        blockReceiptId: trap.block_receipt_id,
        allowReceiptId: receipt.id,
        domain: ctx.body.domain,
        tool: ctx.body.tool,
        taskFingerprint: ctx.fingerprint,
        deltaHash: delta.deltaHash,
      });
      const existing = await DB.prepare(
        `SELECT lesson_id FROM lessons
          WHERE domain = ?1 AND tool_name = ?2 AND task_fingerprint = ?3 AND violation_rule = ?4`,
      )
        .bind(ctx.body.domain, ctx.body.tool, ctx.fingerprint, trap.violation_rule)
        .first<{ lesson_id: string }>();

      const newId = crypto.randomUUID();
      const followUp = existing
        ? DB.prepare(
            `INSERT INTO lesson_corroborations
               (corroboration_id, lesson_id, trap_id, fix_event_id, agent_key, delta_hash, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          ).bind(newId, existing.lesson_id, trap.trap_id, receipt.id, ctx.agent.agentKey, delta.deltaHash, now)
        : DB.prepare(
            `INSERT INTO lessons
               (lesson_id, trap_id, trap_event_id, fix_event_id, domain, tool_name, task_fingerprint, violation_rule,
                changed_paths_json, delta_json, delta_hash, pair_attestation, attestation_kid, provenance,
                source_agent_key, fixed_by_key, submitter_visibility, embed_version, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'community', ?14, NULL, ?15, ?16, ?17)`,
          ).bind(
            newId,
            trap.trap_id,
            trap.block_receipt_id,
            receipt.id,
            ctx.body.domain,
            ctx.body.tool,
            ctx.fingerprint,
            trap.violation_rule,
            JSON.stringify(delta.changedPaths),
            delta.deltaJson,
            delta.deltaHash,
            attestation,
            MOM_ATTESTATION_KID,
            ctx.agent.agentKey,
            await visibilityToken(ctx.env.VISIBILITY_KEY, ctx.agent.agentKey),
            EMBED_VERSION,
            now,
          );

      await DB.batch([
        attemptStatement(ctx, attemptId, now, null),
        fixStatement(ctx, receipt, trap.trap_id, "paired", now),
        followUp,
      ]);
      return existing
        ? { paired: true, handle: handleStatus, trap_id: trap.trap_id, corroboration_id: newId }
        : { paired: true, handle: handleStatus, trap_id: trap.trap_id, lesson_id: newId, review_status: "pending_triage" };
    } catch (error) {
      if (round === 0 && isRetryableConflict(error)) continue;
      console.error("achromat-mom fix ingestion failed", errorText(error));
      await recordAttemptOnly(ctx, `fix ingestion failed: ${errorText(error)}`);
      return { paired: false, handle: handleStatus, reason: "INGESTION_CONFLICT" };
    }
  }
  // Unreachable: round 1 always returns.
  return { paired: false, handle: null, reason: "INGESTION_CONFLICT" };
}

// ════════════════════════════════════════════════════════════════════════
// Route
// ════════════════════════════════════════════════════════════════════════

function retryAfter(c: Context<CalibrateEnv>, resetAtMs: number): void {
  c.header("Retry-After", secondsUntil(resetAtMs));
}

/**
 * Runs triage and the Vectorize sync after the response (ctx.waitUntil: up to 30 s). Best effort by
 * design: the lesson and its pending_triage state are already durable in D1, and the 5-minute cron
 * (src/review/pipeline.ts reconcile) retries anything this run does not finish.
 */
function runInBackground(c: Context<CalibrateEnv>, task: Promise<unknown>): void {
  const guarded = task.catch((error) => console.error("achromat-mom background triage failed", errorText(error)));
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (direct unit-test calls): the promise still runs.
  }
}

async function clientIpHmac(c: Context<CalibrateEnv>): Promise<string | null> {
  const prefix = networkPrefix(c.req.header("cf-connecting-ip") ?? "");
  return prefix === null ? null : networkPrefixHmac(c.env.IP_HMAC_KEY, prefix);
}

export function createCalibrateRoutes(options: CalibrateOptions) {
  const calibrate = new Hono<CalibrateEnv>();
  calibrate.post("/", (c) => handleCalibrate(c, options));
  return calibrate;
}

async function handleCalibrate(c: Context<CalibrateEnv>, options: CalibrateOptions) {
  const env = c.env;
  const agent = c.get("agent");

  // Fail closed before any quota is spent if a secret is missing or malformed.
  try {
    if (typeof env.RAMEN_API_KEY !== "string" || env.RAMEN_API_KEY.trim() === "") throw new Error("RAMEN_API_KEY is not configured");
    await assertPairingSecrets(env.MOM_ATTESTATION_PRIVATE_KEY, env.VISIBILITY_KEY);
    await networkPrefixHmac(env.IP_HMAC_KEY, "0.0.0.0/24");
  } catch (error) {
    console.error("achromat-mom calibrate misconfigured", errorText(error));
    return apiError(c, 503, "SERVICE_MISCONFIGURED", "calibration is temporarily unavailable");
  }

  const agentUsage = await consumeUsage(env, agentUsageKey(agent.agentKey), CALIBRATE_LIMIT_PER_AGENT_PER_HOUR);
  if (!agentUsage.allowed) {
    retryAfter(c, agentUsage.resetAtMs);
    return apiError(c, 429, "RATE_LIMITED", `at most ${CALIBRATE_LIMIT_PER_AGENT_PER_HOUR} calibrations per hour per agent key`);
  }

  const parsed = parseCalibrateRequest(parseJsonBytes(c.get("raw_body")));
  if (!parsed.success) return apiError(c, 400, parsed.failure.code, "calibrate body is invalid", parsed.failure.details);
  const body = parsed.data.body;
  const handle = parsed.data.kind === "fix" ? parsed.data.body.trap_id : null;
  // Tool-scoped policy_ids where the tool is known, else the domain bundle (src/config/domains.ts).
  const scope = upstreamScopeFor(body.domain, body.tool);
  if (scope === null) {
    return apiError(c, 400, "DOMAIN_UNKNOWN", "domain is not served", [{ path: "domain", message: "unknown domain" }]);
  }

  const globalUsage = await consumeUsage(env, GLOBAL_USAGE_KEY, CALIBRATE_GLOBAL_LIMIT_PER_HOUR);
  if (!globalUsage.allowed) {
    retryAfter(c, globalUsage.resetAtMs);
    return apiError(c, 503, "UPSTREAM_CAPACITY", "community calibration capacity is exhausted for this hour");
  }

  /** Recorded in the ledger's bundle_id columns: the bundle slug, or the label of the tool-scoped policy list. */
  const bundleId = scope.id;
  const input = canonicalJson({ tool: body.tool, arguments: body.arguments });
  const upstream = await evaluateUpstream(env.RAMEN_API_KEY, scope, input);
  if (!upstream.ok) return apiError(c, upstream.status, upstream.code, upstream.error);
  const evaluation = upstream.evaluation;

  const check = await verifyRamenReceipt(evaluation.receipt, input, evaluation.allowed ? 1 : 0, {
    keys: options.receiptKeys,
  });
  const ctx: CallContext = {
    env,
    agent,
    body,
    bundleId,
    fingerprint: await taskFingerprint(body.task_description),
    input,
    argumentsJson: JSON.stringify(body.arguments),
    evaluation,
    check,
    clientIpHmac: await clientIpHmac(c),
  };
  const receipt = check.ok ? check.receipt : null;
  const signed = receipt?.signed ?? null;

  const shared = {
    success: true as const,
    domain: body.domain,
    bundle_id: bundleId,
    allowed: evaluation.allowed,
    verdict: evaluation.allowed ? ("ALLOW" as const) : ("BLOCK" as const),
    policy_ids: signed?.policy_ids ?? evaluation.policy_ids ?? [],
    statutory_anchors: signed?.statutory_anchors ?? evaluation.statutory_anchors ?? [],
    violations: evaluation.total_violations.map((v) => ({
      rule_id: v.rule_id,
      rule_name: v.rule_name,
      reasoning: v.reasoning ?? null,
      recovery_instruction: v.recovery_instruction ?? null,
    })),
    receipt: evaluation.receipt ?? null,
    receipt_id: receipt?.id ?? null,
    receipt_verified: check.ok,
    receipt_reason: check.reason,
    /** The exact string ramen-ai evaluated; the receipt's payload_hash is SHA-256 of it. */
    evaluated_input: input,
  };

  if (evaluation.allowed) {
    const pairing = await ingestAllow(ctx, receipt, handle);
    // Only a NEW lesson needs triage. Corroborations and unpaired ALLOWs carry no vector.
    if (pairing.lesson_id) runInBackground(c, processLesson(env, options.search(env), pairing.lesson_id));
    return c.json({ ...shared, steering_directive: null, pairing });
  }
  const trap = await ingestBlock(ctx, receipt);
  return c.json({ ...shared, steering_directive: deriveSteeringDirective(signed, evaluation), trap });
}
