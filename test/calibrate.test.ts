import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { fakeSearch } from "./fixtures/search";
import { pairAttestationMessage } from "../src/crypto/attestation";
import { POLICY_FINTECH_CREDIT_ADVERSE_ACTION, POLICY_FINTECH_WIRE } from "../src/config/domains";
import { GLOBAL_USAGE_KEY, HOUR_MS, agentUsageKey } from "../src/routes/calibrate";
import { canonicalJson, decodeBase64url, encodeBase64url, taskFingerprint, toHex } from "../src/schema";
import {
  POLICY_A,
  POLICY_B,
  TEST_MOM_PUBLIC_KEY_B64URL,
  TEST_RAMEN_PUBLIC_KEY_HEX,
  mockRamen,
  type FakeVerdict,
} from "./fixtures/ramen";
import {
  ORIGIN,
  freshIp,
  registeredAgent,
  signatureHeaders,
  signedCall as deployedSignedCall,
  type SignOptions,
  type TestAgent,
} from "./helpers";

// Receipts in these tests are signed by a throwaway key, so the app under test trusts that
// key instead of the pinned ramen_pk_v1. The deployed default export never takes options.
// Workers AI and Vectorize are replaced by fakes; the background triage a new lesson schedules is awaited below.
const app = createApp({ receiptKeys: { ramen_pk_v1: TEST_RAMEN_PUBLIC_KEY_HEX }, search: fakeSearch().search });

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", freshIp());
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(ORIGIN + path, { ...init, headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function signedCall(agent: TestAgent, path: string, options: SignOptions = {}): Promise<Response> {
  const headers = await signatureHeaders(agent, path, options);
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) init.body = options.body;
  return call(path, init);
}

const PATH = "/api/v1/calibrate";
const TOOL = "transfer_funds";
const DESCRIPTION = "Move client funds to the settlement account before the daily cut-off";
const TRAP_ARGUMENTS = { amount: 50000, currency: "GBP", approval: { second_approver: null } };
const FIX_ARGUMENTS = { amount: 50000, currency: "GBP", approval: { second_approver: "ops-lead" } };

const VIOLATION = {
  rule_id: "0eadfb7d-548d-40ca-896a-c9db9b5a6640",
  rule_name: "Dual authorisation for large transfers",
  reasoning: "Transfer above threshold lacks a second approver.",
  recovery_instruction: "Add a second approver before moving the funds.",
};

/** A BLOCK signed two seconds ago, so the ALLOW that follows is strictly later. */
function block(overrides: Partial<FakeVerdict> = {}): FakeVerdict {
  return {
    allowed: false,
    violations: [VIOLATION],
    anchors: ["FCA SYSC 6.1.1"],
    timestamp: new Date(Date.now() - 2000).toISOString(),
    ...overrides,
  };
}
const ALLOW: FakeVerdict = { allowed: true };

function body(overrides: Record<string, unknown> = {}) {
  return { domain: "fintech", tool: TOOL, task_description: DESCRIPTION, arguments: TRAP_ARGUMENTS, ...overrides };
}

async function calibrateCall(agent: TestAgent, payload: unknown): Promise<{ status: number; json: any; response: Response }> {
  const response = await signedCall(agent, PATH, { method: "POST", body: JSON.stringify(payload) });
  return { status: response.status, json: await response.json(), response };
}

function agentKeyHex(agent: TestAgent): string {
  return toHex(decodeBase64url(agent.publicKey));
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...params).first<{ n: number }>();
  return row?.n ?? 0;
}

let restore: (() => void) | null = null;
function ramen(...verdicts: FakeVerdict[]) {
  const mock = mockRamen(...verdicts);
  restore = mock.restore;
  return mock;
}
afterEach(() => {
  restore?.();
  restore = null;
});

describe("POST /api/v1/calibrate: Turn 1 (BLOCK)", () => {
  it("requires a signed request", async () => {
    const response = await call(PATH, { method: "POST", body: JSON.stringify(body()) });
    expect(response.status).toBe(401);
  });

  it("evaluates upstream with MOM's key and opens a 24-hour trap from the verified receipt", async () => {
    const agent = await registeredAgent();
    const upstream = ramen(block());
    const { status, json } = await calibrateCall(agent, body());

    expect(status).toBe(200);
    expect(json).toMatchObject({
      verdict: "BLOCK",
      allowed: false,
      receipt_verified: true,
      receipt_reason: null,
      steering_directive: VIOLATION.recovery_instruction,
      statutory_anchors: ["FCA SYSC 6.1.1"],
      trap: { recorded: true, attempt_seq: 1, joined: false, violation_rule: VIOLATION.rule_name },
    });

    expect(upstream.requests).toHaveLength(1);
    const sent = upstream.requests[0]!;
    expect(sent.authorization).toBe("Bearer test-only-ramen-api-key");
    // transfer_funds has no tool route, so the domain bundle is sent, and only the bundle.
    expect(sent.bundle_ids).toEqual(["ramen__fintech_banking_invariance"]);
    expect(sent.policy_ids).toEqual([]);
    expect(sent.raw_keys).toEqual(["bundle_ids", "input"]);
    expect(sent.input).toBe(canonicalJson({ tool: TOOL, arguments: TRAP_ARGUMENTS }));
    expect(json.evaluated_input).toBe(sent.input);

    const trap = await env.DB.prepare("SELECT * FROM traps WHERE trap_id = ?").bind(json.trap.trap_id).first<any>();
    expect(trap).toMatchObject({
      agent_key: agentKeyHex(agent),
      domain: "fintech",
      tool_name: TOOL,
      task_fingerprint: await taskFingerprint(DESCRIPTION),
    });
    expect(trap.expires_at_ms - trap.opened_at_ms).toBe(86_400_000);

    const event = await env.DB.prepare("SELECT * FROM trap_events WHERE trap_id = ?").bind(json.trap.trap_id).first<any>();
    expect(event).toMatchObject({
      block_receipt_id: json.receipt_id,
      attempt_seq: 1,
      violation_rule: VIOLATION.rule_name,
      statutory_anchor: "FCA SYSC 6.1.1",
      steering_directive: VIOLATION.recovery_instruction,
      policy_ids_json: JSON.stringify([POLICY_A]),
      bundle_id: "ramen__fintech_banking_invariance",
      evaluated_input: sent.input,
    });
    expect(JSON.parse(event.trap_arguments_json)).toEqual(TRAP_ARGUMENTS);

    const attempt = await env.DB.prepare("SELECT * FROM calibration_attempts WHERE agent_key = ?").bind(agentKeyHex(agent)).first<any>();
    expect(attempt).toMatchObject({ verdict: 0, receipt_verified: 1, receipt_bound: 1, error: null });
  });

  it("joins the open trap on a retry instead of opening a second one", async () => {
    const agent = await registeredAgent();
    ramen(block(), block());
    const first = await calibrateCall(agent, body());
    const second = await calibrateCall(agent, body({ arguments: { ...TRAP_ARGUMENTS, amount: 40000 } }));
    expect(second.json.trap).toMatchObject({ recorded: true, trap_id: first.json.trap.trap_id, attempt_seq: 2, joined: true });
    expect(await count("SELECT count(*) AS n FROM traps WHERE agent_key = ?", agentKeyHex(agent))).toBe(1);
  });

  it("records an unverifiable receipt as an attempt only", async () => {
    const agent = await registeredAgent();
    ramen(block({ tamper: true }), block({ hashOf: "some other input" }));
    const tampered = await calibrateCall(agent, body());
    expect(tampered.json).toMatchObject({ verdict: "BLOCK", receipt_verified: false, trap: { recorded: false, reason: "RECEIPT_UNVERIFIED" } });
    expect(tampered.json.receipt_reason).toBe("receipt signature does not verify against the pinned key");
    // The agent still gets steering, built from the unsigned violations.
    expect(tampered.json.steering_directive).toBe(VIOLATION.recovery_instruction);

    const unbound = await calibrateCall(agent, body());
    expect(unbound.json.receipt_reason).toBe("signed payload_hash does not match the evaluated input");

    const key = agentKeyHex(agent);
    expect(await count("SELECT count(*) AS n FROM traps WHERE agent_key = ?", key)).toBe(0);
    const attempts = await env.DB.prepare(
      "SELECT receipt_verified, receipt_bound FROM calibration_attempts WHERE agent_key = ? ORDER BY created_at_ms, receipt_verified",
    )
      .bind(key)
      .all<{ receipt_verified: number; receipt_bound: number }>();
    expect(attempts.results).toEqual(
      expect.arrayContaining([
        { receipt_verified: 0, receipt_bound: 0 },
        { receipt_verified: 1, receipt_bound: 0 },
      ]),
    );
  });

  it("the deployed Worker trusts only the pinned ramen_pk_v1", async () => {
    const agent = await registeredAgent();
    ramen(block());
    const response = await deployedSignedCall(agent, PATH, { method: "POST", body: JSON.stringify(body()) });
    expect(await response.json()).toMatchObject({
      receipt_verified: false,
      receipt_reason: "receipt signature does not verify against the pinned key",
      trap: { recorded: false },
    });
  });

  it("does not open a trap for a BLOCK caused by policy errors", async () => {
    const agent = await registeredAgent();
    ramen(block({ policiesErrored: 1 }));
    const { json } = await calibrateCall(agent, body());
    expect(json.trap).toMatchObject({ recorded: false, reason: "POLICY_ERRORED" });
    expect(await count("SELECT count(*) AS n FROM traps WHERE agent_key = ?", agentKeyHex(agent))).toBe(0);
  });

  it("rejects an unknown domain before calling upstream", async () => {
    const agent = await registeredAgent();
    const upstream = ramen();
    const { status, json } = await calibrateCall(agent, body({ domain: "healthcare" }));
    expect(status).toBe(400);
    expect(json.code).toBe("DOMAIN_UNKNOWN");
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects an invalid body before calling upstream", async () => {
    const agent = await registeredAgent();
    const upstream = ramen();
    const { status, json } = await calibrateCall(agent, body({ arguments: {} }));
    expect(status).toBe(400);
    expect(json.code).toBe("INVALID_REQUEST");
    expect(upstream.requests).toHaveLength(0);
  });
});

describe("POST /api/v1/calibrate: Turn 2 (ALLOW)", () => {
  it("pairs with the agent's open trap, attests the pair and creates a lesson that triage then moves to pending_review", async () => {
    const agent = await registeredAgent();
    ramen(block(), ALLOW);
    const turn1 = await calibrateCall(agent, body());
    // Whitespace differs: the fingerprint is taken over the normalised description.
    const turn2 = await calibrateCall(agent, body({ arguments: FIX_ARGUMENTS, task_description: `  ${DESCRIPTION.replace(/ /g, "   ")} ` }));

    expect(turn2.status).toBe(200);
    expect(turn2.json).toMatchObject({
      verdict: "ALLOW",
      receipt_verified: true,
      pairing: { paired: true, handle: null, trap_id: turn1.json.trap.trap_id, review_status: "pending_triage" },
    });
    const lessonId = turn2.json.pairing.lesson_id as string;

    const fix = await env.DB.prepare("SELECT * FROM fixes WHERE allow_receipt_id = ?").bind(turn2.json.receipt_id).first<any>();
    expect(fix).toMatchObject({ trap_id: turn1.json.trap.trap_id, pairing_outcome: "paired", fix_source: "community" });

    const lesson = await env.DB.prepare("SELECT * FROM lessons WHERE lesson_id = ?").bind(lessonId).first<any>();
    expect(lesson).toMatchObject({
      trap_id: turn1.json.trap.trap_id,
      trap_event_id: turn1.json.receipt_id,
      fix_event_id: turn2.json.receipt_id,
      violation_rule: VIOLATION.rule_name,
      provenance: "community",
      source_agent_key: agentKeyHex(agent),
      attestation_kid: "mom_pk_v1",
      embed_version: "bge-base-cls/intent-v2",
    });
    expect(JSON.parse(lesson.changed_paths_json)).toEqual(["/approval/second_approver"]);

    const state = await env.DB.prepare("SELECT review_status, visibility FROM lesson_state WHERE lesson_id = ?").bind(lessonId).first();
    // The response reports pending_triage; the background triage that follows it has passed the lesson to
    // pending_review, visible to its submitter only (the visibility token stored on the lesson).
    expect(state).toEqual({ review_status: "pending_review", visibility: lesson.submitter_visibility });

    // The attestation verifies against the MOM public key over the documented message.
    const momKey = await crypto.subtle.importKey("raw", decodeBase64url(TEST_MOM_PUBLIC_KEY_B64URL), { name: "Ed25519" }, false, ["verify"]);
    const message = pairAttestationMessage({
      blockReceiptId: turn1.json.receipt_id,
      allowReceiptId: turn2.json.receipt_id,
      domain: "fintech",
      tool: TOOL,
      taskFingerprint: await taskFingerprint(DESCRIPTION),
      deltaHash: lesson.delta_hash,
    });
    expect(lesson.pair_attestation).toHaveLength(86);
    expect(
      await crypto.subtle.verify({ name: "Ed25519" }, momKey, decodeBase64url(lesson.pair_attestation), new TextEncoder().encode(message)),
    ).toBe(true);

    // Submitter-only visibility token: 'k:' + base64url(HMAC-SHA256(VISIBILITY_KEY, agent_key)).
    const raw = Uint8Array.from(atob(env.VISIBILITY_KEY), (ch) => ch.charCodeAt(0));
    const hmac = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(agentKeyHex(agent))));
    expect(lesson.submitter_visibility).toBe(`k:${encodeBase64url(mac)}`);
  });

  it("confirms a matching trap_id handle", async () => {
    const agent = await registeredAgent();
    ramen(block(), ALLOW);
    const turn1 = await calibrateCall(agent, body());
    const turn2 = await calibrateCall(agent, body({ arguments: FIX_ARGUMENTS, trap_id: turn1.json.trap.trap_id }));
    expect(turn2.json.pairing).toMatchObject({ paired: true, handle: "matched", trap_id: turn1.json.trap.trap_id });
  });

  it("ignores another agent's trap_id and never pairs it", async () => {
    const owner = await registeredAgent();
    const intruder = await registeredAgent();
    ramen(block(), ALLOW);
    const turn1 = await calibrateCall(owner, body());
    const turn2 = await calibrateCall(intruder, body({ arguments: FIX_ARGUMENTS, trap_id: turn1.json.trap.trap_id }));
    expect(turn2.json.pairing).toMatchObject({ paired: false, handle: "ignored", outcome: "unpaired_no_trap" });
    expect(await count("SELECT count(*) AS n FROM fixes WHERE trap_id = ?", turn1.json.trap.trap_id)).toBe(0);
  });

  it("keeps an ALLOW with no open trap as unpaired evidence", async () => {
    const agent = await registeredAgent();
    ramen(ALLOW);
    const { json } = await calibrateCall(agent, body({ arguments: FIX_ARGUMENTS }));
    expect(json.pairing).toMatchObject({ paired: false, outcome: "unpaired_no_trap", reason: "NO_OPEN_TRAP" });
    const fix = await env.DB.prepare("SELECT trap_id, pairing_outcome FROM fixes WHERE allow_receipt_id = ?").bind(json.receipt_id).first();
    expect(fix).toEqual({ trap_id: null, pairing_outcome: "unpaired_no_trap" });
  });

  it("does not pair when the signed policy set differs from the trap's", async () => {
    const agent = await registeredAgent();
    ramen(block(), { allowed: true, policyIds: [POLICY_A, POLICY_B] }, ALLOW);
    const turn1 = await calibrateCall(agent, body());
    const mismatch = await calibrateCall(agent, body({ arguments: FIX_ARGUMENTS }));
    expect(mismatch.json.pairing).toMatchObject({ paired: false, reason: "POLICY_SET_MISMATCH", trap_id: turn1.json.trap.trap_id });
    expect(await count("SELECT count(*) AS n FROM fixes WHERE agent_key = ?", agentKeyHex(agent))).toBe(0);

    // The trap stays open for a proper fix.
    const proper = await calibrateCall(agent, body({ arguments: FIX_ARGUMENTS }));
    expect(proper.json.pairing).toMatchObject({ paired: true, trap_id: turn1.json.trap.trap_id });
  });

  it("does not pair a degenerate fix (no argument changed)", async () => {
    const agent = await registeredAgent();
    ramen(block(), ALLOW);
    await calibrateCall(agent, body());
    const { json } = await calibrateCall(agent, body());
    expect(json.pairing).toMatchObject({ paired: false, reason: "DEGENERATE_DELTA" });
  });

  it("does not pair an ALLOW signed before the BLOCK", async () => {
    const agent = await registeredAgent();
    ramen(block(), { allowed: true, timestamp: new Date(Date.now() - 60_000).toISOString() });
    await calibrateCall(agent, body());
    const { json } = await calibrateCall(agent, body({ arguments: FIX_ARGUMENTS }));
    expect(json.pairing).toMatchObject({ paired: false, reason: "FIX_PREDATES_TRAP" });
  });

  it("closes the trap once paired: a later ALLOW is unpaired", async () => {
    const agent = await registeredAgent();
    ramen(block(), ALLOW, ALLOW);
    await calibrateCall(agent, body());
    expect((await calibrateCall(agent, body({ arguments: FIX_ARGUMENTS }))).json.pairing.paired).toBe(true);
    const late = await calibrateCall(agent, body({ arguments: { ...FIX_ARGUMENTS, currency: "EUR" } }));
    expect(late.json.pairing).toMatchObject({ paired: false, outcome: "unpaired_no_trap" });
  });

  it("records a second agent's pair for the same lesson key as a corroboration", async () => {
    const description = "Release the quarterly dividend payment to registered holders";
    const first = await registeredAgent();
    const second = await registeredAgent();
    ramen(block(), ALLOW, block(), ALLOW);
    await calibrateCall(first, body({ task_description: description }));
    const lesson = await calibrateCall(first, body({ task_description: description, arguments: FIX_ARGUMENTS }));
    expect(lesson.json.pairing.lesson_id).toBeDefined();

    await calibrateCall(second, body({ task_description: description }));
    const corroboration = await calibrateCall(second, body({ task_description: description, arguments: FIX_ARGUMENTS }));
    expect(corroboration.json.pairing).toMatchObject({ paired: true });
    expect(corroboration.json.pairing.corroboration_id).toBeDefined();
    const row = await env.DB.prepare("SELECT lesson_id, agent_key FROM lesson_corroborations WHERE corroboration_id = ?")
      .bind(corroboration.json.pairing.corroboration_id)
      .first();
    expect(row).toEqual({ lesson_id: lesson.json.pairing.lesson_id, agent_key: agentKeyHex(second) });
  });
});

describe("POST /api/v1/calibrate: tool-scoped policy routing", () => {
  const WIRE_TRAP = { amount_usd: 87500, dual_control: false, beneficiary_routing: "021000021" };
  const WIRE_FIX = { amount_usd: 12500, dual_control: true, beneficiary_routing: "021000021" };

  it("evaluates dispatch_wire against the wire policy alone, sending policy_ids and no bundle_ids", async () => {
    const agent = await registeredAgent();
    const description = "Pay the approved office-supply invoice to the verified domestic vendor this week";
    const upstream = ramen(block({ policyIds: [POLICY_FINTECH_WIRE] }), { allowed: true, policyIds: [POLICY_FINTECH_WIRE] });

    const turn1 = await calibrateCall(agent, body({ tool: "dispatch_wire", task_description: description, arguments: WIRE_TRAP }));
    expect(turn1.status).toBe(200);
    expect(turn1.json).toMatchObject({ verdict: "BLOCK", bundle_id: "policies:fintech_wire", policy_ids: [POLICY_FINTECH_WIRE], trap: { recorded: true } });

    const sent = upstream.requests[0]!;
    expect(sent.policy_ids).toEqual([POLICY_FINTECH_WIRE]);
    expect(sent.bundle_ids).toEqual([]);
    expect(sent.raw_keys).toEqual(["input", "policy_ids"]);
    expect(sent.input).toBe(canonicalJson({ tool: "dispatch_wire", arguments: WIRE_TRAP }));

    const event = await env.DB.prepare("SELECT bundle_id, policy_ids_json FROM trap_events WHERE trap_id = ?").bind(turn1.json.trap.trap_id).first<any>();
    expect(event).toEqual({ bundle_id: "policies:fintech_wire", policy_ids_json: JSON.stringify([POLICY_FINTECH_WIRE]) });

    // The fix goes through the same route, so the pair binds exactly as it does with a bundle.
    const turn2 = await calibrateCall(agent, body({ tool: "dispatch_wire", task_description: description, arguments: WIRE_FIX, trap_id: turn1.json.trap.trap_id }));
    expect(turn2.json).toMatchObject({ verdict: "ALLOW", bundle_id: "policies:fintech_wire", pairing: { paired: true, handle: "matched" } });
    expect(upstream.requests[1]!.policy_ids).toEqual([POLICY_FINTECH_WIRE]);
    const fix = await env.DB.prepare("SELECT bundle_id FROM fixes WHERE allow_receipt_id = ?").bind(turn2.json.receipt_id).first<any>();
    expect(fix).toEqual({ bundle_id: "policies:fintech_wire" });
  });

  it("evaluates issue_credit_adverse_action against the credit policy alone", async () => {
    const agent = await registeredAgent();
    const upstream = ramen(block({ policyIds: [POLICY_FINTECH_CREDIT_ADVERSE_ACTION] }));
    const { json } = await calibrateCall(
      agent,
      body({ tool: "issue_credit_adverse_action", task_description: "Notify the applicant of the credit decision on the submitted personal loan application", arguments: { application_id: "APP-1", reason_codes: [] } }),
    );
    expect(json).toMatchObject({ verdict: "BLOCK", bundle_id: "policies:fintech_credit_adverse_action" });
    expect(upstream.requests[0]!.policy_ids).toEqual([POLICY_FINTECH_CREDIT_ADVERSE_ACTION]);
    expect(upstream.requests[0]!.raw_keys).toEqual(["input", "policy_ids"]);
  });

  it("keeps the domain bundle for a tool with no route, and for other domains", async () => {
    const agent = await registeredAgent();
    const upstream = ramen(block(), block());
    await calibrateCall(agent, body({ tool: "wire_transfer", task_description: "Move client funds to the settlement account for the March batch" }));
    await calibrateCall(agent, body({ domain: "devsecops", tool: "dispatch_wire", task_description: "Run the nightly log monitor against the internal syslog path" }));
    expect(upstream.requests.map((request) => request.bundle_ids)).toEqual([["ramen__fintech_banking_invariance"], ["ramen__shield_core_it"]]);
    expect(upstream.requests.map((request) => request.policy_ids)).toEqual([[], []]);
  });

  it("still rejects an unserved domain before anything goes upstream, even for a routed tool", async () => {
    const agent = await registeredAgent();
    const upstream = ramen(block());
    const { status, json } = await calibrateCall(agent, body({ domain: "healthcare", tool: "dispatch_wire" }));
    expect(status).toBe(400);
    expect(json.code).toBe("DOMAIN_UNKNOWN");
    expect(upstream.requests).toHaveLength(0);
  });
});

// The ceiling case below fills the global counter for the rest of the file, so nothing that calls upstream may follow it.
describe("POST /api/v1/calibrate: rate limits", () => {
  async function fillCounter(name: string, count: number): Promise<void> {
    const stub = env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName(name));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("w", { window: Math.floor(Date.now() / HOUR_MS), windowMs: HOUR_MS, count });
    });
  }

  it("allows 120 calls per agent per hour, then answers 429 without calling upstream", async () => {
    const agent = await registeredAgent();
    await fillCounter(agentUsageKey(agentKeyHex(agent)), 120);
    const upstream = ramen();
    const { status, json, response } = await calibrateCall(agent, body());
    expect(status).toBe(429);
    expect(json.code).toBe("RATE_LIMITED");
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(upstream.requests).toHaveLength(0);
  });

  it("counts a fixed hourly window and resets in the next one", async () => {
    const stub = env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName("test:window"));
    // A future window, so the cleanup alarm (set at the window end) cannot fire mid-test.
    const t0 = (Math.floor(Date.now() / HOUR_MS) + 100) * HOUR_MS;
    expect((await stub.consume(2, HOUR_MS, t0)).allowed).toBe(true);
    expect((await stub.consume(2, HOUR_MS, t0 + 1)).allowed).toBe(true);
    expect(await stub.consume(2, HOUR_MS, t0 + 2)).toMatchObject({ allowed: false, remaining: 0 });
    expect((await stub.consume(2, HOUR_MS, t0 + HOUR_MS)).allowed).toBe(true);
  });

  // Runs last in this file: it exhausts the shared global counter.
  it("stops at the 1,000 per hour global upstream ceiling", async () => {
    const agent = await registeredAgent();
    await fillCounter(GLOBAL_USAGE_KEY, 1000);
    const upstream = ramen();
    const { status, json } = await calibrateCall(agent, body());
    expect(status).toBe(503);
    expect(json.code).toBe("UPSTREAM_CAPACITY");
    expect(upstream.requests).toHaveLength(0);
  });
});
