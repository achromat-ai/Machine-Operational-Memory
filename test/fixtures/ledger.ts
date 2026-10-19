/**
 * Direct-SQL ledger fixtures. They go through every D1 trigger (pairing, window, clock and
 * lesson rules), so a fixture that inserts is a pair the ledger would accept.
 *
 * Used where the HTTP flow cannot reach the state under test: a lesson left at pending_triage,
 * and internal (bounty) lessons, which need a trap whose 24-hour window has closed.
 * Backdating a trap needs one UPDATE, which traps_no_update forbids, so the bounty fixture drops
 * and re-creates exactly that trigger around the UPDATE.
 */
import { env } from "cloudflare:workers";
import { visibilityToken } from "../../src/crypto/attestation";
import { buildPairDelta } from "../../src/pairing";
import { canonicalJson, decodeBase64url, sha256Hex, taskFingerprint, toHex } from "../../src/schema";
import { ORIGIN, freshIp, newAgent, postRegister, getChallenge, registrationBody, type TestAgent } from "../helpers";

export const DOMAIN = "fintech";
export const TOOL = "transfer_funds";
export const BUNDLE = "ramen__fintech_banking_invariance";
export const POLICY = "1006492f-db62-4f46-8775-48b966c5c956";

export const TRAP_ARGUMENTS = { amount: 50000, currency: "GBP", approval: { second_approver: null } };
export const FIX_ARGUMENTS = { amount: 50000, currency: "GBP", approval: { second_approver: "ops-lead" } };

let counter = 0;
export function uniqueDescription(label = "batch"): string {
  counter += 1;
  return `Move client funds to the settlement account for ${label} number ${counter}`;
}

export function agentKeyHex(agent: TestAgent): string {
  return toHex(decodeBase64url(agent.publicKey));
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** A provisioned internal key (auto-approval enabled by default). Internal keys never come from PoW. */
export async function insertInternalAgent(): Promise<string> {
  const key = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(
    `INSERT INTO agent_identities (agent_key, role, challenge_id, pow_nonce, pow_hash, rotated_from_key, ip_prefix_hmac, asn, registered_at_ms)
     VALUES (?1, 'internal', NULL, NULL, NULL, NULL, NULL, NULL, ?2)`,
  )
    .bind(key, Date.now())
    .run();
  return key;
}

export async function pauseAutoApprove(agentKey: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO agent_events (event_id, agent_key, kind, related_agent_key, actor, reason, at_ms) VALUES (?1, ?2, 'auto_approve_paused', NULL, 'test', 'test', ?3)",
  )
    .bind(uuid(), agentKey, Date.now())
    .run();
}

export type ProvisionedRole = "admin" | "internal" | "platform";

/** A provisioned (non-PoW) key with a known Ed25519 private key, so tests can sign requests as it. */
export async function provisionAgent(role: ProvisionedRole): Promise<{ agent: TestAgent; key: string }> {
  const agent = await newAgent();
  const key = agentKeyHex(agent);
  await env.DB.prepare(
    `INSERT INTO agent_identities (agent_key, role, challenge_id, pow_nonce, pow_hash, rotated_from_key, ip_prefix_hmac, asn, registered_at_ms)
     VALUES (?1, ?2, NULL, NULL, NULL, NULL, NULL, NULL, ?3)`,
  )
    .bind(key, role, Date.now())
    .run();
  return { agent, key };
}

/** Appends an agent_events row (throttled, revoked, ...); the trigger projects it into agent_state. */
export async function agentEvent(agentKey: string, kind: "throttled" | "revoked" | "reactivated"): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO agent_events (event_id, agent_key, kind, related_agent_key, actor, reason, at_ms) VALUES (?1, ?2, ?3, NULL, 'test', 'test', ?4)",
  )
    .bind(uuid(), agentKey, kind, Date.now())
    .run();
}

/**
 * Opens a trap with its first BLOCK. `ageMs` shifts the trap into the past (a 25 h shift closes the 24 h
 * window). traps_no_update forbids the UPDATE, so the trigger is dropped and re-created around it.
 */
async function insertTrapWithBlock(args: {
  ownerKey: string;
  description: string;
  trapArguments: Record<string, unknown>;
  violationRule: string;
  ageMs: number;
  domain?: string;
  tool?: string;
}) {
  const domain = args.domain ?? DOMAIN;
  const tool = args.tool ?? TOOL;
  const fingerprint = await taskFingerprint(args.description);
  const trapId = uuid();
  const blockId = uuid();
  const now = Date.now();
  const trapInput = canonicalJson({ tool, arguments: args.trapArguments });
  const policyIds = JSON.stringify([POLICY]);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO traps (trap_id, agent_key, domain, tool_name, task_fingerprint, opened_at_ms, expires_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).bind(trapId, args.ownerKey, domain, tool, fingerprint, now, now + 86_400_000),
    env.DB.prepare(
      `INSERT INTO trap_events
         (block_receipt_id, trap_id, attempt_seq, agent_key, domain, tool_name, task_fingerprint, task_description,
          trap_arguments_json, evaluated_input, receipt_signature, receipt_canonical_payload, payload_hash,
          bundle_id, policy_ids_json, violation_rule, rule_ids_json, steering_directive, statutory_anchor, recorded_at_ms)
       VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'sig', ?10, ?11, ?12, ?13, ?14, '[]', 'Add a second approver before moving the funds.', 'FCA SYSC 6.1.1', ?15)`,
    ).bind(
      blockId,
      trapId,
      args.ownerKey,
      domain,
      tool,
      fingerprint,
      args.description,
      JSON.stringify(args.trapArguments),
      trapInput,
      payload(blockId, 0, await sha256Hex(trapInput)),
      await sha256Hex(trapInput),
      BUNDLE,
      policyIds,
      args.violationRule,
      now,
    ),
  ]);

  if (args.ageMs > 0) {
    await env.DB.prepare("DROP TRIGGER traps_no_update").run();
    try {
      await env.DB.prepare("UPDATE traps SET opened_at_ms = opened_at_ms - ?2, expires_at_ms = expires_at_ms - ?2 WHERE trap_id = ?1")
        .bind(trapId, args.ageMs)
        .run();
    } finally {
      await env.DB.prepare("CREATE TRIGGER traps_no_update BEFORE UPDATE ON traps BEGIN SELECT RAISE(ABORT, 'traps is append-only'); END").run();
    }
  }
  return { trapId, blockId, fingerprint, now, policyIds };
}

export const HOUR = 3_600_000;

/** A trap with no fix, `ageMs` old. Optionally under a live 30-minute bounty lease held by an internal key. */
export async function insertOpenTrap(options: {
  ownerKey: string;
  ageMs: number;
  leaseKey?: string;
  domain?: string;
  tool?: string;
  trapArguments?: Record<string, unknown>;
}): Promise<{ trapId: string; description: string }> {
  const description = uniqueDescription("bounty");
  const { trapId, now } = await insertTrapWithBlock({
    ownerKey: options.ownerKey,
    description,
    trapArguments: options.trapArguments ?? TRAP_ARGUMENTS,
    violationRule: "Dual authorisation for large transfers",
    ageMs: options.ageMs,
    ...(options.domain ? { domain: options.domain } : {}),
    ...(options.tool ? { tool: options.tool } : {}),
  });
  if (options.leaseKey) {
    await env.DB.prepare(
      "INSERT INTO bounty_claims (claim_id, trap_id, agent_key, claimed_at_ms, lease_expires_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(uuid(), trapId, options.leaseKey, now, now + 1_800_000)
      .run();
  }
  return { trapId, description };
}

export interface PairOptions {
  ownerKey: string;
  /**
   * 'community' = a community fix inside the window; 'bounty' = an internal fix after the window closed;
   * 'seed' = an admin_seed fix inside the window (ownerKey must be an admin or platform key).
   */
  kind: "community" | "bounty" | "seed";
  fixerKey?: string;
  lessonId?: string;
  description?: string;
  violationRule?: string;
  trapArguments?: Record<string, unknown>;
  fixArguments?: Record<string, unknown>;
}

export interface InsertedPair {
  lessonId: string;
  trapId: string;
  blockReceiptId: string;
  allowReceiptId: string;
  description: string;
}

function payload(id: string, verdict: 0 | 1, hash: string): string {
  return JSON.stringify({
    schema_version: "5.0",
    kid: "ramen_pk_v1",
    id,
    timestamp: new Date().toISOString(),
    policy_ids: [POLICY],
    payload_hash: hash,
    verdict,
    reasoning: "fixture reasoning",
    steering: "fixture steering",
    statutory_anchors: [],
  });
}

/** Inserts trap → BLOCK → (claim) → fix → lesson. The lesson is left at pending_triage. */
export async function insertPair(options: PairOptions): Promise<InsertedPair> {
  const description = options.description ?? uniqueDescription();
  const trapArguments = options.trapArguments ?? TRAP_ARGUMENTS;
  const fixArguments = options.fixArguments ?? FIX_ARGUMENTS;
  const lessonId = options.lessonId ?? uuid();
  const allowId = uuid();
  const violationRule = options.violationRule ?? "Dual authorisation for large transfers";
  const fixInput = canonicalJson({ tool: TOOL, arguments: fixArguments });
  const delta = await buildPairDelta(trapArguments, fixArguments);
  if (delta === null) throw new Error("fixture needs a non-degenerate delta");

  const bounty = options.kind === "bounty";
  const seed = options.kind === "seed";
  const fixerKey = bounty ? options.fixerKey : options.ownerKey;
  if (!fixerKey) throw new Error("a bounty pair needs fixerKey");

  // A bounty trap's window is closed first: shifted 25 hours into the past (expires = opened + 24 h still holds).
  const { trapId, blockId, fingerprint, now, policyIds } = await insertTrapWithBlock({
    ownerKey: options.ownerKey,
    description,
    trapArguments,
    violationRule,
    ageMs: bounty ? 90_000_000 : 0,
  });

  if (bounty) {
    await env.DB.prepare(
      "INSERT INTO bounty_claims (claim_id, trap_id, agent_key, claimed_at_ms, lease_expires_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(uuid(), trapId, fixerKey, now, now + 1_800_000)
      .run();
  }

  let seedRunId: string | null = null;
  if (seed) {
    seedRunId = uuid();
    await env.DB.prepare("INSERT INTO seed_runs (run_id, scenario_hash, manifest_json, created_by, created_at_ms) VALUES (?1, ?2, '{}', 'test', ?3)")
      .bind(seedRunId, await sha256Hex(seedRunId), Date.now())
      .run();
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO fixes
         (allow_receipt_id, trap_id, fix_source, pairing_outcome, agent_key, domain, tool_name, task_fingerprint,
          task_description, fix_arguments_json, evaluated_input, receipt_signature, receipt_canonical_payload,
          payload_hash, bundle_id, policy_ids_json, seed_run_id, recorded_at_ms)
       VALUES (?1, ?2, ?3, 'paired', ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'sig', ?11, ?12, ?13, ?14, ?15, ?16)`,
    ).bind(
      allowId,
      trapId,
      bounty ? "internal_bounty" : seed ? "admin_seed" : "community",
      fixerKey,
      DOMAIN,
      TOOL,
      fingerprint,
      description,
      JSON.stringify(fixArguments),
      fixInput,
      payload(allowId, 1, await sha256Hex(fixInput)),
      await sha256Hex(fixInput),
      BUNDLE,
      policyIds,
      seedRunId,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO lessons
         (lesson_id, trap_id, trap_event_id, fix_event_id, domain, tool_name, task_fingerprint, violation_rule,
          changed_paths_json, delta_json, delta_hash, pair_attestation, attestation_kid, provenance,
          source_agent_key, fixed_by_key, submitter_visibility, embed_version, created_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'mom_pk_v1', ?13, ?14, ?15, ?16, 'bge-base-cls/intent-v2', ?17)`,
    ).bind(
      lessonId,
      trapId,
      blockId,
      allowId,
      DOMAIN,
      TOOL,
      fingerprint,
      violationRule,
      JSON.stringify(delta.changedPaths),
      delta.deltaJson,
      delta.deltaHash,
      "A".repeat(86),
      bounty ? "community_trap+internal_fix" : seed ? "admin_seed" : "community",
      options.ownerKey,
      bounty ? fixerKey : null,
      await visibilityToken(env.VISIBILITY_KEY, options.ownerKey),
      now,
    ),
  ]);
  return { lessonId, trapId, blockReceiptId: blockId, allowReceiptId: allowId, description };
}

/** A registered community agent plus its hex D1 key. */
export async function community(): Promise<{ agent: TestAgent; key: string }> {
  const ip = freshIp();
  const agent = await newAgent();
  const response = await postRegister(await registrationBody(agent, await getChallenge(ip)), ip);
  if (response.status !== 201) throw new Error(`register failed: ${response.status}`);
  return { agent, key: agentKeyHex(agent) };
}

/** Human review actions, as the Review Console will write them. */
export async function humanReview(lessonId: string, action: "approve" | "reject" | "quarantine", reasonCode: string | null = null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO review_events (event_id, lesson_id, actor_type, actor_id, action, reason_code, details_json, at_ms)
     VALUES (?1, ?2, 'human', 'test-reviewer', ?3, ?4, NULL, ?5)`,
  )
    .bind(uuid(), lessonId, action, reasonCode, Date.now())
    .run();
}

export async function lessonState(lessonId: string) {
  return env.DB.prepare(
    "SELECT review_status, visibility, audit_status, vector_desired_version AS desired, vector_synced_version AS synced FROM lesson_state WHERE lesson_id = ?1",
  )
    .bind(lessonId)
    .first<{ review_status: string; visibility: string; audit_status: string; desired: number; synced: number }>();
}

export async function reviewActions(lessonId: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT action FROM review_events WHERE lesson_id = ?1 ORDER BY at_ms, rowid").bind(lessonId).all<{ action: string }>();
  return rows.results.map((row) => row.action);
}

export { ORIGIN };
