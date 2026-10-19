/**
 * Admin seeding: writes verified BLOCK/ALLOW pairs straight into the ledger as approved, public lessons.
 *
 * The ledger's append-only rules still apply, so a seeded lesson walks the same state machine as any other,
 * in ONE D1 batch (one transaction) per pair:
 *
 *   seed_runs → traps → trap_events (attempt 1) → fixes (fix_source 'admin_seed') → lessons (provenance
 *   'admin_seed') → review_events triage_pass → review_events approve
 *
 * lesson_state is never written directly: the lessons and review_events triggers project it, and the
 * approve row makes it 'approved' / 'public' (which bumps vector_desired_version for syncVectors).
 *
 * What replaces community triage: every pair must carry two receipts that verify against the pinned ramen
 * key, bind to inputs MOM rebuilds itself, have the expected verdicts, were signed within the last five
 * minutes, and name exactly the tool's scoped policy set (src/config/domains.ts). The ALLOW must be signed
 * after the BLOCK, the steering must equal the signed steering, and the pair must have a real delta. The
 * burst, near-duplicate and reputation checks are skipped on purpose: they police anonymous community
 * submitters, and this route is admin-only.
 */
import { upstreamScopeFor } from "../config/domains";
import { MOM_ATTESTATION_KID, signPairAttestation, visibilityToken } from "../crypto/attestation";
import { verifyRamenReceipt, type VerifiedReceipt } from "../crypto/receipt";
import type { Env } from "../env";
import {
  STATUTORY_ANCHOR_MAX,
  STEERING_DIRECTIVE_MAX,
  VIOLATION_RULE_MAX,
  buildPairDelta,
  cleanText,
} from "../pairing";
import { canonicalJson, sha256Hex, taskFingerprint, type SeedPair } from "../schema";
import { EMBED_VERSION } from "../search/intent";

export const TRAP_WINDOW_MS = 86_400_000;
export const SEED_TRIAGE_ACTOR = "admin-seed-v1";

export interface SeededPair {
  index: number;
  lesson_id: string;
  trap_id: string;
  seed_run_id: string;
  block_receipt_id: string;
  allow_receipt_id: string;
}

export interface RejectedPair {
  index: number;
  code: string;
  message: string;
}

export interface SeedOutcome {
  seeded: SeededPair[];
  rejected: RejectedPair[];
}

export interface SeedOptions {
  /** Trusted ramen-ai receipt keys by kid. Default: the pinned production keys. */
  receiptKeys: Readonly<Record<string, string>>;
  nowMs?: number;
}

function reject(index: number, code: string, message: string): { ok: false; rejected: RejectedPair } {
  return { ok: false, rejected: { index, code, message } };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Trigger aborts that mean "this pair is already in the ledger", mapped to stable codes. */
function conflictFor(error: unknown): { code: string; message: string } | null {
  const text = errorText(error);
  if (text.includes("seed_runs: run or scenario already exists")) return { code: "DUPLICATE_SEED", message: "this exact pair was already seeded" };
  if (text.includes("lessons: lesson, trap, fix or dedup key already used")) {
    return { code: "DUPLICATE_LESSON", message: "a lesson already exists for this domain, tool, task and violation rule" };
  }
  if (text.includes("receipt already recorded")) return { code: "RECEIPT_REUSED", message: "one of the receipts is already in the ledger" };
  if (text.includes("an open trap exists")) return { code: "OPEN_TRAP_EXISTS", message: "this key already has an open trap for this task" };
  return null;
}

async function seedOne(
  env: Env,
  adminKey: string,
  pair: SeedPair,
  index: number,
  requestSha256: string,
  options: SeedOptions,
): Promise<{ ok: true; seeded: SeededPair } | { ok: false; rejected: RejectedPair }> {
  const nowMs = options.nowMs ?? Date.now();
  const { domain, tool_name: tool } = pair;

  // Only tools with an explicit policy list can be seeded: the receipt must come from the scoped evaluation.
  const scope = upstreamScopeFor(domain, tool);
  if (scope === null) return reject(index, "DOMAIN_UNKNOWN", "domain is not served");
  if (scope.kind !== "policies") {
    return reject(index, "TOOL_NOT_SCOPED", "this tool has no tool-scoped policy list, so its receipts cannot be checked against one");
  }
  const scopeJson = JSON.stringify([...scope.policyIds].sort());

  if (canonicalJson(pair.failed_arguments) === canonicalJson(pair.compliant_arguments)) {
    return reject(index, "DEGENERATE_DELTA", "failed_arguments and compliant_arguments are identical");
  }
  const blockInput = canonicalJson({ tool, arguments: pair.failed_arguments });
  const allowInput = canonicalJson({ tool, arguments: pair.compliant_arguments });

  const blockCheck = await verifyRamenReceipt(pair.block_receipt, blockInput, 0, { keys: options.receiptKeys, nowMs });
  if (!blockCheck.ok || blockCheck.receipt === null) return reject(index, "BLOCK_RECEIPT_INVALID", blockCheck.reason ?? "receipt not verified");
  const allowCheck = await verifyRamenReceipt(pair.allow_receipt, allowInput, 1, { keys: options.receiptKeys, nowMs });
  if (!allowCheck.ok || allowCheck.receipt === null) return reject(index, "ALLOW_RECEIPT_INVALID", allowCheck.reason ?? "receipt not verified");
  const block: VerifiedReceipt = blockCheck.receipt;
  const allow: VerifiedReceipt = allowCheck.receipt;

  const blockPolicies = JSON.stringify([...block.signed.policy_ids].sort());
  const allowPolicies = JSON.stringify([...allow.signed.policy_ids].sort());
  if (blockPolicies !== scopeJson || allowPolicies !== scopeJson) {
    return reject(index, "POLICY_SET_MISMATCH", "both receipts must be signed over exactly the policy list scoped to this tool");
  }
  if (!(Date.parse(allow.signed.timestamp) > Date.parse(block.signed.timestamp))) {
    return reject(index, "FIX_PREDATES_TRAP", "the ALLOW receipt must be signed after the BLOCK receipt");
  }
  if (block.id === allow.id) return reject(index, "RECEIPT_REUSED", "the BLOCK and ALLOW receipts are the same receipt");

  const signedSteering = cleanText(block.signed.steering, STEERING_DIRECTIVE_MAX);
  if (signedSteering === "") return reject(index, "STEERING_MISSING", "the BLOCK receipt signed no steering");
  if (cleanText(pair.steering_directive, STEERING_DIRECTIVE_MAX) !== signedSteering) {
    return reject(index, "STEERING_MISMATCH", "steering_directive does not equal the steering signed in the BLOCK receipt");
  }
  const violationRule = cleanText(pair.violation_rule, VIOLATION_RULE_MAX);
  if (violationRule === "") return reject(index, "VIOLATION_RULE_MISSING", "violation_rule is empty after cleaning");
  const anchor = block.signed.statutory_anchors.map((a) => cleanText(a, STATUTORY_ANCHOR_MAX)).find((a) => a !== "") ?? null;

  const delta = await buildPairDelta(pair.failed_arguments, pair.compliant_arguments);
  if (delta === null) return reject(index, "DEGENERATE_DELTA", "the compliant arguments do not differ from the failed arguments");

  const fingerprint = await taskFingerprint(pair.task_description);
  const scenarioHash = await sha256Hex(
    canonicalJson({ domain, tool, fingerprint, failed: pair.failed_arguments, compliant: pair.compliant_arguments }),
  );

  const existing = await env.DB.prepare(
    "SELECT lesson_id FROM lessons WHERE domain = ?1 AND tool_name = ?2 AND task_fingerprint = ?3 AND violation_rule = ?4",
  )
    .bind(domain, tool, fingerprint, violationRule)
    .first<{ lesson_id: string }>();
  if (existing) return reject(index, "DUPLICATE_LESSON", "a lesson already exists for this domain, tool, task and violation rule");

  const attestation = await signPairAttestation(env.MOM_ATTESTATION_PRIVATE_KEY, {
    blockReceiptId: block.id,
    allowReceiptId: allow.id,
    domain,
    tool,
    taskFingerprint: fingerprint,
    deltaHash: delta.deltaHash,
  });

  const runId = crypto.randomUUID();
  const trapId = crypto.randomUUID();
  const lessonId = crypto.randomUUID();
  const policyIdsJson = scopeJson;
  const failedJson = JSON.stringify(pair.failed_arguments);
  const compliantJson = JSON.stringify(pair.compliant_arguments);
  const manifest = JSON.stringify({
    version: SEED_TRIAGE_ACTOR,
    domain,
    tool,
    task_fingerprint: fingerprint,
    block_receipt_id: block.id,
    allow_receipt_id: allow.id,
    request_body_sha256: requestSha256,
  });
  const details = JSON.stringify({ version: SEED_TRIAGE_ACTOR, seed_run_id: runId, request_body_sha256: requestSha256 });
  const { DB } = env;

  try {
    await DB.batch([
      DB.prepare("INSERT INTO seed_runs (run_id, scenario_hash, manifest_json, created_by, created_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)").bind(
        runId,
        scenarioHash,
        manifest,
        adminKey,
        nowMs,
      ),
      DB.prepare(
        "INSERT INTO traps (trap_id, agent_key, domain, tool_name, task_fingerprint, opened_at_ms, expires_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).bind(trapId, adminKey, domain, tool, fingerprint, nowMs, nowMs + TRAP_WINDOW_MS),
      DB.prepare(
        `INSERT INTO trap_events
           (block_receipt_id, trap_id, attempt_seq, agent_key, domain, tool_name, task_fingerprint, task_description,
            trap_arguments_json, evaluated_input, receipt_signature, receipt_canonical_payload, payload_hash,
            bundle_id, policy_ids_json, violation_rule, rule_ids_json, steering_directive, statutory_anchor, recorded_at_ms)
         VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, '[]', ?16, ?17, ?18)`,
      ).bind(
        block.id,
        trapId,
        adminKey,
        domain,
        tool,
        fingerprint,
        pair.task_description,
        failedJson,
        blockInput,
        block.signature,
        block.canonicalPayload,
        block.signed.payload_hash,
        scope.id,
        policyIdsJson,
        violationRule,
        signedSteering,
        anchor,
        nowMs,
      ),
      DB.prepare(
        `INSERT INTO fixes
           (allow_receipt_id, trap_id, fix_source, pairing_outcome, agent_key, domain, tool_name, task_fingerprint,
            task_description, fix_arguments_json, evaluated_input, receipt_signature, receipt_canonical_payload,
            payload_hash, bundle_id, policy_ids_json, seed_run_id, recorded_at_ms)
         VALUES (?1, ?2, 'admin_seed', 'paired', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
      ).bind(
        allow.id,
        trapId,
        adminKey,
        domain,
        tool,
        fingerprint,
        pair.task_description,
        compliantJson,
        allowInput,
        allow.signature,
        allow.canonicalPayload,
        allow.signed.payload_hash,
        scope.id,
        policyIdsJson,
        runId,
        nowMs,
      ),
      DB.prepare(
        `INSERT INTO lessons
           (lesson_id, trap_id, trap_event_id, fix_event_id, domain, tool_name, task_fingerprint, violation_rule,
            changed_paths_json, delta_json, delta_hash, pair_attestation, attestation_kid, provenance,
            source_agent_key, fixed_by_key, submitter_visibility, embed_version, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'admin_seed', ?14, NULL, ?15, ?16, ?17)`,
      ).bind(
        lessonId,
        trapId,
        block.id,
        allow.id,
        domain,
        tool,
        fingerprint,
        violationRule,
        JSON.stringify(delta.changedPaths),
        delta.deltaJson,
        delta.deltaHash,
        attestation,
        MOM_ATTESTATION_KID,
        adminKey,
        await visibilityToken(env.VISIBILITY_KEY, adminKey),
        EMBED_VERSION,
        nowMs,
      ),
      // The projection moves pending_triage → pending_review → approved only through these two rows.
      DB.prepare(
        `INSERT INTO review_events (event_id, lesson_id, actor_type, actor_id, action, reason_code, details_json, at_ms)
         VALUES (?1, ?2, 'triage', ?3, 'triage_pass', NULL, ?4, ?5)`,
      ).bind(crypto.randomUUID(), lessonId, SEED_TRIAGE_ACTOR, details, nowMs),
      DB.prepare(
        `INSERT INTO review_events (event_id, lesson_id, actor_type, actor_id, action, reason_code, details_json, at_ms)
         VALUES (?1, ?2, 'human', ?3, 'approve', NULL, ?4, ?5)`,
      ).bind(crypto.randomUUID(), lessonId, adminKey, details, nowMs),
    ]);
  } catch (error) {
    const conflict = conflictFor(error);
    if (conflict) return reject(index, conflict.code, conflict.message);
    console.error("achromat-mom admin seed failed", errorText(error));
    return reject(index, "INGESTION_CONFLICT", "the ledger refused this pair");
  }

  return {
    ok: true,
    seeded: { index, lesson_id: lessonId, trap_id: trapId, seed_run_id: runId, block_receipt_id: block.id, allow_receipt_id: allow.id },
  };
}

/** Seeds each pair in its own transaction, in order. One bad pair never blocks the others. */
export async function seedPairs(
  env: Env,
  adminKey: string,
  pairs: readonly SeedPair[],
  requestSha256: string,
  options: SeedOptions,
): Promise<SeedOutcome> {
  const outcome: SeedOutcome = { seeded: [], rejected: [] };
  for (const [index, pair] of pairs.entries()) {
    const result = await seedOne(env, adminKey, pair, index, requestSha256, options);
    if (result.ok) outcome.seeded.push(result.seeded);
    else outcome.rejected.push(result.rejected);
  }
  return outcome;
}
