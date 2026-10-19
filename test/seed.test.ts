/**
 * POST /api/v1/admin/seed: receipt-verified BLOCK/ALLOW pairs written straight to approved, public lessons.
 * Driven over HTTP through the real app with fake Workers AI and Vectorize. Receipts are signed by the test
 * ramen key, which the app under test trusts instead of the pinned production key.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { POLICY_FINTECH_WIRE, POLICY_ROBOTICS_MANIPULATION } from "../src/config/domains";
import { SEED_MAX_PAIRS } from "../src/schema";
import { canonicalJson } from "../src/schema";
import { community, lessonState, provisionAgent, uniqueDescription } from "./fixtures/ledger";
import { ALLOW as ALLOW_VERDICT, POLICY_A, ramenResponse, type FakeVerdict } from "./fixtures/ramen";
import { VIOLATION, blockVerdict, freshWorld, type World } from "./fixtures/world";
import { ORIGIN, call, freshIp, signatureHeaders, type TestAgent } from "./helpers";

const SEED = "/api/v1/admin/seed";
const WIRE_FAILED = { amount_usd: 87500, dual_control: false, authorization_evidence: "[UNVERIFIED_STATE]" };
const WIRE_COMPLIANT = { amount_usd: 87500, dual_control: true, authorization_evidence: "[VERIFIED_STATE]" };

interface ApiResult {
  status: number;
  json: any;
  response: Response;
}

async function post(world: World, agent: TestAgent, payload: unknown): Promise<ApiResult> {
  const body = JSON.stringify(payload);
  const headers = await signatureHeaders(agent, SEED, { method: "POST", body });
  headers.set("CF-Connecting-IP", freshIp());
  headers.set("Content-Type", "application/json");
  const ctx = createExecutionContext();
  const response = await world.worker.fetch(new Request(ORIGIN + SEED, { method: "POST", headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, json: await response.json(), response };
}

async function receiptFor(input: string, verdict: FakeVerdict): Promise<any> {
  const response = await ramenResponse({ url: "", authorization: null, bundle_ids: [], policy_ids: [], input }, verdict);
  return ((await response.json()) as any).data.receipt;
}

interface PairOptions {
  domain?: string;
  tool?: string;
  failed?: Record<string, unknown>;
  compliant?: Record<string, unknown>;
  policyIds?: string[];
  block?: Partial<FakeVerdict>;
  allow?: Partial<FakeVerdict>;
  steering?: string;
  rule?: string;
  description?: string;
}

/** A pair as the executor would send it: receipts for the exact inputs MOM will rebuild. */
async function pair(options: PairOptions = {}) {
  const tool = options.tool ?? "dispatch_wire";
  const failed = options.failed ?? WIRE_FAILED;
  const compliant = options.compliant ?? WIRE_COMPLIANT;
  const policyIds = options.policyIds ?? [POLICY_FINTECH_WIRE];
  return {
    domain: options.domain ?? "fintech",
    tool_name: tool,
    task_description: options.description ?? uniqueDescription("seed"),
    failed_arguments: failed,
    compliant_arguments: compliant,
    block_receipt: await receiptFor(canonicalJson({ tool, arguments: failed }), blockVerdict({ policyIds, ...options.block })),
    allow_receipt: await receiptFor(canonicalJson({ tool, arguments: compliant }), { ...ALLOW_VERDICT, policyIds, ...options.allow }),
    violation_rule: options.rule ?? VIOLATION.rule_name,
    steering_directive: options.steering ?? VIOLATION.recovery_instruction,
  };
}

async function rowCount(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

describe("POST /api/v1/admin/seed: access and body", () => {
  it("needs a signed request from an admin key", async () => {
    const world = await freshWorld();
    expect((await call(SEED, { method: "POST", body: "[]" })).status).toBe(401);

    const member = await community();
    expect((await post(world, member.agent, [await pair()])).status).toBe(403);
    const internal = await provisionAgent("internal");
    expect((await post(world, internal.agent, [await pair()])).status).toBe(403);
    expect(await rowCount("seed_runs")).toBe(0);
  });

  it("rejects a malformed body whole: not an array, empty, too long, unknown fields", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const good = await pair();
    const bad: unknown[] = [
      {},
      [],
      Array.from({ length: SEED_MAX_PAIRS + 1 }, () => good),
      [{ ...good, auto_ingested: true }],
      [{ ...good, steering_directive: "" }],
      [{ ...good, failed_arguments: {} }],
      [{ ...good, block_receipt: "nope" }],
    ];
    for (const payload of bad) {
      const result = await post(world, admin.agent, payload);
      expect(result.status, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
    expect(await rowCount("seed_runs")).toBe(0);
  });
});

describe("POST /api/v1/admin/seed: a verified pair becomes an approved, public lesson", () => {
  it("writes the whole chain in one transaction and publishes it", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const input = await pair();

    const { status, json } = await post(world, admin.agent, [input]);
    expect(status).toBe(201);
    expect(json).toMatchObject({ success: true, requested: 1, rejected: [], review_status: "approved", vector_sync: "scheduled" });
    expect(json.seeded).toHaveLength(1);
    const seeded = json.seeded[0];

    const lesson = await env.DB.prepare("SELECT * FROM lessons WHERE lesson_id = ?1").bind(seeded.lesson_id).first<any>();
    expect(lesson).toMatchObject({
      provenance: "admin_seed",
      source_agent_key: admin.key,
      fixed_by_key: null,
      domain: "fintech",
      tool_name: "dispatch_wire",
      violation_rule: VIOLATION.rule_name,
      trap_id: seeded.trap_id,
      trap_event_id: seeded.block_receipt_id,
      fix_event_id: seeded.allow_receipt_id,
    });
    expect(JSON.parse(lesson.changed_paths_json)).toEqual(["/authorization_evidence", "/dual_control"]);
    expect(lesson.pair_attestation).toHaveLength(86);

    expect(await lessonState(seeded.lesson_id)).toMatchObject({ review_status: "approved", visibility: "public" });

    const fix = await env.DB.prepare("SELECT fix_source, pairing_outcome, seed_run_id, bundle_id, policy_ids_json FROM fixes WHERE allow_receipt_id = ?1")
      .bind(seeded.allow_receipt_id)
      .first<any>();
    expect(fix).toEqual({
      fix_source: "admin_seed",
      pairing_outcome: "paired",
      seed_run_id: seeded.seed_run_id,
      bundle_id: "policies:fintech_wire",
      policy_ids_json: JSON.stringify([POLICY_FINTECH_WIRE]),
    });
    const event = await env.DB.prepare("SELECT attempt_seq, steering_directive, statutory_anchor, evaluated_input FROM trap_events WHERE block_receipt_id = ?1")
      .bind(seeded.block_receipt_id)
      .first<any>();
    expect(event).toEqual({
      attempt_seq: 1,
      steering_directive: VIOLATION.recovery_instruction,
      statutory_anchor: "FCA SYSC 6.1.1",
      evaluated_input: canonicalJson({ tool: "dispatch_wire", arguments: WIRE_FAILED }),
    });

    // The state machine was walked through its own rows, not bypassed.
    const actions = await env.DB.prepare("SELECT action, actor_type, actor_id FROM review_events WHERE lesson_id = ?1 ORDER BY rowid")
      .bind(seeded.lesson_id)
      .all<any>();
    expect(actions.results).toEqual([
      { action: "triage_pass", actor_type: "triage", actor_id: "admin-seed-v1" },
      { action: "approve", actor_type: "human", actor_id: admin.key },
    ]);
    const manifest = await env.DB.prepare("SELECT manifest_json, created_by FROM seed_runs WHERE run_id = ?1").bind(seeded.seed_run_id).first<any>();
    expect(manifest.created_by).toBe(admin.key);
    expect(JSON.parse(manifest.manifest_json)).toMatchObject({ block_receipt_id: seeded.block_receipt_id, allow_receipt_id: seeded.allow_receipt_id });

    // Vectorize was synced after the response: one public vector, acknowledged at the final version.
    const record = world.store.records.get(seeded.lesson_id);
    expect(record).toBeDefined();
    expect(record!.metadata).toMatchObject({ tool_name: "dispatch_wire", visibility: "public", review_status: "approved" });
    const state = await env.DB.prepare("SELECT vector_desired_version AS desired, vector_synced_version AS synced FROM lesson_state WHERE lesson_id = ?1")
      .bind(seeded.lesson_id)
      .first<any>();
    expect(state.synced).toBe(state.desired);
  });

  it("shows up in the public feed without any trap value", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const admin = await provisionAgent("admin");
    const { json } = await post(world, admin.agent, [await pair({ failed: { ...WIRE_FAILED, note: "TRAP-ONLY-MARKER" } })]);
    const lessonId = json.seeded[0].lesson_id;

    const ctx = createExecutionContext();
    const response = await world.worker.fetch(new Request(`${ORIGIN}/api/v1/feed`, { headers: { "CF-Connecting-IP": freshIp() } }), env, ctx);
    await waitOnExecutionContext(ctx);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain(lessonId);
    expect(text).not.toContain("TRAP-ONLY-MARKER");
    expect(JSON.parse(text).lessons.find((item: any) => item.lesson_id === lessonId).compliant_arguments).toEqual(WIRE_COMPLIANT);
  });

  it("is not held to the community burst limit: 10 pairs in one request and 3 more after all publish", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const first = await post(world, admin.agent, await Promise.all(Array.from({ length: SEED_MAX_PAIRS }, () => pair())));
    expect(first.status).toBe(201);
    expect(first.json.seeded).toHaveLength(SEED_MAX_PAIRS);
    const second = await post(world, admin.agent, await Promise.all(Array.from({ length: 3 }, () => pair())));
    expect(second.json.seeded).toHaveLength(3);

    for (const item of [...first.json.seeded, ...second.json.seeded]) {
      expect(await lessonState(item.lesson_id)).toMatchObject({ review_status: "approved", visibility: "public" });
    }
    const triageRows = await env.DB.prepare("SELECT count(*) AS n FROM triage_checks WHERE lesson_id = ?1").bind(first.json.seeded[0].lesson_id).first<any>();
    expect(triageRows.n).toBe(0); // community triage never ran
  });

  it("seeds dispatch_manipulation through its own policy, in both the robotics and industrial_iot domains", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const base = { tool: "dispatch_manipulation", policyIds: [POLICY_ROBOTICS_MANIPULATION], failed: { speed_mm_s: 900, human_in_cell: true }, compliant: { speed_mm_s: 250, human_in_cell: true } };
    const { status, json } = await post(world, admin.agent, [await pair({ ...base, domain: "robotics" }), await pair({ ...base, domain: "industrial_iot" })]);
    expect(status).toBe(201);
    expect(json.seeded).toHaveLength(2);
    const fix = await env.DB.prepare("SELECT bundle_id FROM fixes WHERE allow_receipt_id = ?1").bind(json.seeded[0].allow_receipt_id).first<any>();
    expect(fix).toEqual({ bundle_id: "policies:robotics_manipulation" });
  });
});

describe("POST /api/v1/admin/seed: what it refuses", () => {
  async function refused(overrides: PairOptions, mutate?: (item: any) => void) {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const item: any = await pair(overrides);
    mutate?.(item);
    const before = [await rowCount("lessons"), await rowCount("traps"), await rowCount("fixes"), await rowCount("seed_runs")];
    const result = await post(world, admin.agent, [item]);
    expect(result.status).toBe(200);
    expect(result.json.seeded).toEqual([]);
    expect(result.json.vector_sync).toBe("none");
    // A refused pair leaves nothing behind.
    expect([await rowCount("lessons"), await rowCount("traps"), await rowCount("fixes"), await rowCount("seed_runs")]).toEqual(before);
    return result.json.rejected[0];
  }

  it("a receipt whose signature was tampered with", async () => {
    const rejected = await refused({}, (item) => {
      const flipped = item.block_receipt.signature.startsWith("A") ? "B" : "A";
      item.block_receipt = { ...item.block_receipt, signature: flipped + item.block_receipt.signature.slice(1) };
    });
    expect(rejected).toMatchObject({ index: 0, code: "BLOCK_RECEIPT_INVALID" });
  });

  it("verdicts in the wrong slots: an ALLOW receipt offered as the BLOCK", async () => {
    const rejected = await refused({}, (item) => {
      item.block_receipt = item.allow_receipt;
    });
    expect(rejected.code).toBe("BLOCK_RECEIPT_INVALID");
  });

  it("receipts bound to different inputs than the arguments sent", async () => {
    const rejected = await refused({}, (item) => {
      item.compliant_arguments = { ...WIRE_COMPLIANT, amount_usd: 1 };
    });
    expect(rejected.code).toBe("ALLOW_RECEIPT_INVALID");
  });

  it("a receipt older than five minutes", async () => {
    const rejected = await refused({ block: { timestamp: new Date(Date.now() - 10 * 60_000).toISOString() } });
    expect(rejected.code).toBe("BLOCK_RECEIPT_INVALID");
  });

  it("receipts signed over a different policy set than the tool is scoped to", async () => {
    expect((await refused({ policyIds: [POLICY_A] })).code).toBe("POLICY_SET_MISMATCH");
    expect((await refused({ allow: { policyIds: [POLICY_FINTECH_WIRE, POLICY_A] } })).code).toBe("POLICY_SET_MISMATCH");
  });

  it("an ALLOW signed before the BLOCK", async () => {
    const rejected = await refused({ allow: { timestamp: new Date(Date.now() - 20_000).toISOString() }, block: { timestamp: new Date(Date.now() - 2000).toISOString() } });
    expect(rejected.code).toBe("FIX_PREDATES_TRAP");
  });

  it("steering that is not the steering the BLOCK signed", async () => {
    expect((await refused({ steering: "Do something else entirely." })).code).toBe("STEERING_MISMATCH");
  });

  it("a BLOCK that signed no steering", async () => {
    const rejected = await refused({ block: { steering: "", reasoning: "" }, steering: "anything" });
    expect(rejected.code).toBe("STEERING_MISSING");
  });

  it("identical failed and compliant arguments", async () => {
    const rejected = await refused({ failed: WIRE_COMPLIANT, compliant: WIRE_COMPLIANT });
    expect(rejected.code).toBe("DEGENERATE_DELTA");
  });

  it("a tool with no scoped policy list, and a domain that is not served", async () => {
    expect((await refused({ tool: "transfer_funds" })).code).toBe("TOOL_NOT_SCOPED");
    expect((await refused({ domain: "healthcare" })).code).toBe("DOMAIN_UNKNOWN");
  });

  it("a duplicate: the same pair twice, and the same task and rule with new receipts", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const original = await pair();
    const lessonsBefore = await rowCount("lessons");
    expect((await post(world, admin.agent, [original])).status).toBe(201);

    const again = await post(world, admin.agent, [original]);
    expect(again.status).toBe(200);
    expect(again.json.rejected[0].code).toBe("DUPLICATE_LESSON");

    const sameTask = await pair({ description: original.task_description });
    const second = await post(world, admin.agent, [sameTask]);
    expect(second.json.rejected[0].code).toBe("DUPLICATE_LESSON");
    expect(await rowCount("lessons")).toBe(lessonsBefore + 1);
  });

  it("one bad pair does not stop the good ones around it", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const good1 = await pair();
    const bad: any = await pair();
    bad.steering_directive = "wrong";
    const good2 = await pair();
    const lessonsBefore = await rowCount("lessons");

    const { status, json } = await post(world, admin.agent, [good1, bad, good2]);
    expect(status).toBe(201);
    expect(json.requested).toBe(3);
    expect(json.seeded.map((item: any) => item.index)).toEqual([0, 2]);
    expect(json.rejected).toEqual([{ index: 1, code: "STEERING_MISMATCH", message: expect.any(String) }]);
    expect(await rowCount("lessons")).toBe(lessonsBefore + 2);
  });
});

describe("canonical JSON vector", () => {
  // A fixed vector for the canonical JSON that receipts are bound to. If the canonicalisation drifts,
  // every receipt fails its payload_hash binding.
  it("canonicalJson matches the fixed vector", () => {
    const input = { tool: "dispatch_wire", arguments: { b: [1, true, null], a: "x\u00e9", c: { z: 0, y: "[VERIFIED_STATE]" } } };
    expect(canonicalJson(input)).toBe('{"arguments":{"a":"x\u00e9","b":[1,true,null],"c":{"y":"[VERIFIED_STATE]","z":0}},"tool":"dispatch_wire"}');
  });

  it("prints numbers the way the executor does (2.0 as 2, -0 as 0, plain decimals, large integral floats in full)", () => {
    expect(canonicalJson({ a: 1.0, b: -0.467, c: 2.5, d: -0, e: 1e20 })).toBe('{"a":1,"b":-0.467,"c":2.5,"d":0,"e":100000000000000000000}');
  });
});
