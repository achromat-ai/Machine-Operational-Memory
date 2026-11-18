/**
 * Admin review queue (GET /admin/pending, POST /admin/review) and the bounty board (GET /bounties):
 * role gating on top of the Ed25519 gate, the four-eyes rule, the ledger-owned state change and the
 * Vectorize sync that follows a decision. Everything goes over HTTP through the real Worker with fake
 * Workers AI and Vectorize; admin and internal keys are provisioned straight into D1, as in production.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ADMIN_LIMIT_PER_AGENT_PER_HOUR, adminUsageKey } from "../src/routes/admin";
import { BOUNTY_LIMIT_PER_AGENT_PER_HOUR, bountyUsageKey } from "../src/routes/bounties";
import { processLesson } from "../src/review/pipeline";
import { REVIEW_BATCH_MAX, encodeBase64url, sha256Hex } from "../src/schema";
import { consumeUsage } from "../src/usage";
import {
  FIX_ARGUMENTS,
  HOUR,
  TRAP_ARGUMENTS,
  agentEvent,
  community,
  insertOpenTrap,
  insertPair,
  lessonState,
  pauseAutoApprove,
  provisionAgent,
  reviewActions,
  uniqueDescription,
  uuid,
} from "./fixtures/ledger";
import { ANALYTICS_URL, TEST_ANALYTICS_TOKEN, mockCloudflareAnalytics, type CfRows } from "./fixtures/cf-analytics";
import { freshWorld, type World } from "./fixtures/world";
import { ORIGIN, call, freshIp, signatureHeaders, type TestAgent } from "./helpers";

const REVIEW = "/api/v1/admin/review";
const REVIEW_BATCH = "/api/v1/admin/review/batch";
const PENDING = "/api/v1/admin/pending";
const TELEMETRY = "/api/v1/admin/telemetry";
const BOUNTIES = "/api/v1/bounties";

interface ApiResult {
  status: number;
  json: any;
  response: Response;
}

/** A signed request through the Worker, with the post-response background work awaited. */
async function api(
  world: World,
  agent: TestAgent,
  path: string,
  init: { payload?: unknown; nonce?: string; env?: typeof env } = {},
): Promise<ApiResult> {
  const method = init.payload === undefined ? "GET" : "POST";
  const body = init.payload === undefined ? undefined : JSON.stringify(init.payload);
  const headers = await signatureHeaders(agent, path, {
    method,
    ...(body === undefined ? {} : { body }),
    ...(init.nonce === undefined ? {} : { nonce: init.nonce }),
  });
  headers.set("CF-Connecting-IP", freshIp());
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const ctx = createExecutionContext();
  const response = await world.worker.fetch(new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body }) }), init.env ?? env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, json: await response.json(), response };
}

/** Every item of a paged listing, following next_cursor. */
async function walk(world: World, agent: TestAgent, base: string, limit = 50): Promise<any[]> {
  const field = base.startsWith(BOUNTIES) ? "bounties" : "lessons";
  const items: any[] = [];
  let cursor: string | null = null;
  do {
    const joiner = base.includes("?") ? "&" : "?";
    const result: ApiResult = await api(world, agent, `${base}${joiner}limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
    expect(result.status).toBe(200);
    items.push(...result.json[field]);
    cursor = result.json.next_cursor;
  } while (cursor);
  return items;
}

async function humanEvents(lessonId: string) {
  return (
    await env.DB.prepare(
      "SELECT actor_type, actor_id, action, reason_code, details_json FROM review_events WHERE lesson_id = ?1 AND actor_type = 'human' ORDER BY rowid",
    )
      .bind(lessonId)
      .all<{ actor_type: string; actor_id: string; action: string; reason_code: string | null; details_json: string }>()
  ).results;
}

async function syncOperations(lessonId: string): Promise<Array<[number, string]>> {
  const rows = await env.DB.prepare("SELECT version, operation FROM vector_sync_events WHERE lesson_id = ?1 ORDER BY version")
    .bind(lessonId)
    .all<{ version: number; operation: string }>();
  return rows.results.map((row) => [row.version, row.operation]);
}

async function counts(agentKey: string) {
  return env.DB.prepare("SELECT approved_count, rejected_count FROM agent_state WHERE agent_key = ?1")
    .bind(agentKey)
    .first<{ approved_count: number; rejected_count: number }>();
}

/** A pending_review community lesson and its owner, indexed for the owner only. */
async function pendingLesson(world: World) {
  const owner = await community();
  const { lessonId, description } = await world.createLesson(owner.agent);
  expect((await lessonState(lessonId))!.review_status).toBe("pending_review");
  return { owner, lessonId, description };
}

/** A community lesson whose fix only removes a field: triage quarantines it. */
async function quarantinedLesson(world: World) {
  const owner = await community();
  const { lessonId } = await world.createLesson(owner.agent, {
    trapArguments: { ...TRAP_ARGUMENTS, memo: "some note" },
    fixArguments: { ...TRAP_ARGUMENTS },
  });
  expect((await lessonState(lessonId))!.review_status).toBe("quarantined");
  return { owner, lessonId };
}

// ════════════════════════════════════════════════════════════════════════
// RBAC
// ════════════════════════════════════════════════════════════════════════

describe("role-based access control", () => {
  it("answers 401 to unsigned requests on all three endpoints", async () => {
    for (const [path, method] of [[PENDING, "GET"], [REVIEW, "POST"], [BOUNTIES, "GET"]] as const) {
      const response = await call(path, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(response.status, path).toBe(401);
      expect(await response.json()).toMatchObject({ code: "AGENT_SIGNATURE_REQUIRED" });
    }
  });

  it("gives a community key 403 on all three endpoints, and a rejected review writes nothing", async () => {
    const world = await freshWorld();
    const { lessonId } = await pendingLesson(world);
    const stranger = await community();
    const before = await reviewActions(lessonId);

    for (const [path, payload] of [
      [PENDING, undefined],
      [REVIEW, { lesson_id: lessonId, decision: "approve" }],
      [BOUNTIES, undefined],
    ] as const) {
      const result = await api(world, stranger.agent, path, payload === undefined ? {} : { payload });
      expect(result.status, path).toBe(403);
      expect(result.json).toMatchObject({ success: false, code: "AGENT_ROLE_FORBIDDEN" });
    }
    expect(await reviewActions(lessonId)).toEqual(before);
    expect((await lessonState(lessonId))!.review_status).toBe("pending_review");
  });

  it("keeps internal and platform keys off the admin endpoints", async () => {
    const world = await freshWorld();
    const { lessonId } = await pendingLesson(world);
    for (const role of ["internal", "platform"] as const) {
      const { agent } = await provisionAgent(role);
      expect((await api(world, agent, PENDING)).status, role).toBe(403);
      const review = await api(world, agent, REVIEW, { payload: { lesson_id: lessonId, decision: "approve" } });
      expect(review.status, role).toBe(403);
      expect(review.json.code).toBe("AGENT_ROLE_FORBIDDEN");
    }
    expect((await lessonState(lessonId))!.review_status).toBe("pending_review");
  });

  it("lets admin and internal keys read the bounty board, but not platform keys", async () => {
    const world = await freshWorld();
    expect((await api(world, (await provisionAgent("admin")).agent, BOUNTIES)).status).toBe(200);
    expect((await api(world, (await provisionAgent("internal")).agent, BOUNTIES)).status).toBe(200);
    const platform = await api(world, (await provisionAgent("platform")).agent, BOUNTIES);
    expect(platform.status).toBe(403);
    expect(platform.json.code).toBe("AGENT_ROLE_FORBIDDEN");
  });

  it("refuses a revoked admin (AGENT_KEY_INACTIVE) and a throttled admin (AGENT_ROLE_FORBIDDEN)", async () => {
    const world = await freshWorld();
    const revoked = await provisionAgent("admin");
    await agentEvent(revoked.key, "revoked");
    const gone = await api(world, revoked.agent, PENDING);
    expect(gone.status).toBe(403);
    expect(gone.json.code).toBe("AGENT_KEY_INACTIVE");

    const throttled = await provisionAgent("admin");
    await agentEvent(throttled.key, "throttled");
    for (const path of [PENDING, BOUNTIES]) {
      const result = await api(world, throttled.agent, path);
      expect(result.status, path).toBe(403);
      expect(result.json.code).toBe("AGENT_ROLE_FORBIDDEN");
    }
  });

  it("cross-checks the insert-only agent_identities record: a tampered agent_state role is not enough", async () => {
    const world = await freshWorld();
    const { lessonId } = await pendingLesson(world);
    const impostor = await community();
    // A projection that drifted or was edited: agent_state says admin, the registration record says community.
    await env.DB.prepare("UPDATE agent_state SET role = 'admin' WHERE agent_key = ?1").bind(impostor.key).run();

    expect((await api(world, impostor.agent, PENDING)).status).toBe(403);
    const review = await api(world, impostor.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "approve" } });
    expect(review.status).toBe(403);
    expect(review.json.code).toBe("AGENT_ROLE_FORBIDDEN");
    expect((await lessonState(lessonId))!.review_status).toBe("pending_review");
  });

  it("applies the same identity cross-check to the bounty board: a community key edited to admin or internal in agent_state is 403", async () => {
    const world = await freshWorld();
    for (const forged of ["admin", "internal"]) {
      const impostor = await community();
      await env.DB.prepare("UPDATE agent_state SET role = ?2 WHERE agent_key = ?1").bind(impostor.key, forged).run();
      // The in-request role now says admin/internal, so requireRole alone would let this through.
      expect((await env.DB.prepare("SELECT role FROM agent_state WHERE agent_key = ?1").bind(impostor.key).first<{ role: string }>())!.role).toBe(forged);
      const result = await api(world, impostor.agent, BOUNTIES);
      expect(result.status, forged).toBe(403);
      expect(result.json, forged).toMatchObject({ success: false, code: "AGENT_ROLE_FORBIDDEN" });
    }
    // Genuine admin and internal keys (identity and state agree) still pass.
    expect((await api(world, (await provisionAgent("admin")).agent, BOUNTIES)).status).toBe(200);
    expect((await api(world, (await provisionAgent("internal")).agent, BOUNTIES)).status).toBe(200);
  });

  it("spends each nonce once: a replayed admin request is 401", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const nonce = encodeBase64url(crypto.getRandomValues(new Uint8Array(16)));
    expect((await api(world, admin.agent, PENDING, { nonce })).status).toBe(200);
    const replay = await api(world, admin.agent, PENDING, { nonce });
    expect(replay.status).toBe(401);
    expect(replay.json.code).toBe("AGENT_NONCE_REPLAYED");
  });

  it("budgets admin and bounty reads per key per hour", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    for (let i = 0; i < ADMIN_LIMIT_PER_AGENT_PER_HOUR; i++) await consumeUsage(env, adminUsageKey(admin.key), ADMIN_LIMIT_PER_AGENT_PER_HOUR);
    const limited = await api(world, admin.agent, PENDING);
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe("RATE_LIMITED");
    expect(limited.response.headers.get("Retry-After")).toMatch(/^\d+$/);

    const internal = await provisionAgent("internal");
    for (let i = 0; i < BOUNTY_LIMIT_PER_AGENT_PER_HOUR; i++) await consumeUsage(env, bountyUsageKey(internal.key), BOUNTY_LIMIT_PER_AGENT_PER_HOUR);
    expect((await api(world, internal.agent, BOUNTIES)).status).toBe(429);
  });
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/v1/admin/pending
// ════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/admin/pending", () => {
  it("defaults to pending_review and returns the full pair context", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { owner, lessonId, description } = await pendingLesson(world);
    const { lessonId: quarantinedId } = await quarantinedLesson(world);

    const result = await api(world, admin.agent, PENDING);
    expect(result.status).toBe(200);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(result.json).toMatchObject({ success: true, status: "pending_review" });

    const queue = await walk(world, admin.agent, PENDING);
    const lesson = queue.find((item) => item.lesson_id === lessonId);
    expect(lesson).toBeDefined();
    expect(queue.some((item) => item.lesson_id === quarantinedId)).toBe(false);
    expect(queue.every((item) => item.review_status === "pending_review")).toBe(true);

    expect(lesson).toMatchObject({
      review_status: "pending_review",
      domain: "fintech",
      tool: "transfer_funds",
      provenance: "community",
      task_description: description,
      violation_rule: "Dual authorisation for large transfers",
      steering_directive: "Add a second approver before moving the funds.",
      trap_arguments: TRAP_ARGUMENTS,
      fix_arguments: FIX_ARGUMENTS,
      submitter: { agent_key: owner.key, approved_count: 0, rejected_count: 0 },
      fixed_by_key: null,
    });
    expect(lesson.statutory_anchor).toBeTruthy();
    expect(lesson.delta.changes.length).toBeGreaterThan(0);
    expect(lesson.changed_paths.length).toBeGreaterThan(0);
    expect(lesson.delta_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(lesson.block_receipt_id).toBeTruthy();
    expect(lesson.allow_receipt_id).toBeTruthy();
    expect(lesson.triage.map((check: any) => check.check).sort()).toEqual([
      "burst",
      "near_duplicate",
      "non_degenerate_delta",
      "same_tool_bundle",
      "secret_pii_scan",
      "submitter_reputation",
    ]);
    expect(lesson.triage.every((check: any) => check.passed === true)).toBe(true);
    // Receipts' evaluated inputs are heavy and not part of the queue view.
    expect(lesson).not.toHaveProperty("evaluated_input");
  });

  it("lists quarantined lessons on request, with the triage failure that put them there", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { lessonId: pendingId } = await pendingLesson(world);
    const { lessonId } = await quarantinedLesson(world);

    const queue = await walk(world, admin.agent, `${PENDING}?status=quarantined`);
    expect(queue.some((item) => item.lesson_id === pendingId)).toBe(false);
    const lesson = queue.find((item) => item.lesson_id === lessonId);
    expect(lesson.review_status).toBe("quarantined");
    expect(lesson.triage.find((check: any) => check.check === "non_degenerate_delta")).toMatchObject({ passed: false });
  });

  it("filters by domain", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { lessonId } = await pendingLesson(world);
    expect((await walk(world, admin.agent, `${PENDING}?domain=fintech`)).some((item) => item.lesson_id === lessonId)).toBe(true);
    expect(await walk(world, admin.agent, `${PENDING}?domain=no-such-domain`)).toEqual([]);
  });

  it("pages oldest first with a keyset cursor, without gaps or repeats", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const first = await pendingLesson(world);
    const second = await pendingLesson(world);

    const page = await api(world, admin.agent, `${PENDING}?limit=1`);
    expect(page.json.lessons).toHaveLength(1);
    expect(page.json.next_cursor).toEqual(expect.any(String));

    const all = await walk(world, admin.agent, PENDING, 1);
    const ids = all.map((item) => item.lesson_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.indexOf(first.lessonId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(first.lessonId)).toBeLessThan(ids.indexOf(second.lessonId));
    const queuedAt = all.map((item) => item.queued_at);
    expect([...queuedAt].sort()).toEqual(queuedAt);
  });

  it("rejects bad query parameters with 400", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    for (const query of ["limit=0", "limit=51", "limit=abc", "status=approved", "status=pending_triage", "domain=BAD_DOMAIN", "page=2", "limit=1&limit=2", "cursor=not-a-cursor"]) {
      const result = await api(world, admin.agent, `${PENDING}?${query}`);
      expect(result.status, query).toBe(400);
      expect(result.json.code, query).toBe("INVALID_REQUEST");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// POST /api/v1/admin/review
// ════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/admin/review: approve", () => {
  it("appends one human review_event, publishes the lesson, and replaces the submitter-only vector with a public one", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { owner, lessonId } = await pendingLesson(world);
    const before = world.store.records.get(lessonId)!;
    expect(before.metadata).toMatchObject({ review_status: "pending_review" });
    expect(before.metadata.visibility).toMatch(/^k:/);

    const payload = { lesson_id: lessonId, decision: "approve", reasoning: "Delta is correct and the steering text is clear." };
    const nonce = encodeBase64url(crypto.getRandomValues(new Uint8Array(16)));
    const result = await api(world, admin.agent, REVIEW, { payload, nonce });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      success: true,
      lesson_id: lessonId,
      decision: "approve",
      review_status: "approved",
      visibility: "public",
      vector_sync: "scheduled",
    });

    // The ledger triggers projected the decision; the route wrote only the event.
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "approved", visibility: "public", desired: 2, synced: 2 });
    const events = await humanEvents(lessonId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_type: "human", actor_id: admin.key, action: "approve", reason_code: null });
    expect(JSON.parse(events[0]!.details_json)).toEqual({
      reasoning: payload.reasoning,
      request_body_sha256: await sha256Hex(JSON.stringify(payload)),
      request_nonce: nonce,
    });
    expect(await counts(owner.key)).toEqual({ approved_count: 1, rejected_count: 0 });

    // Vectorize: the same id was upserted again, now public and approved.
    const after = world.store.records.get(lessonId)!;
    expect(after.id).toBe(lessonId);
    expect(after.namespace).toBe("fintech");
    expect(after.metadata).toMatchObject({ visibility: "public", review_status: "approved", tool_name: "transfer_funds" });
    expect(after.values).toHaveLength(768);
    expect(await syncOperations(lessonId)).toEqual([[1, "upsert"], [2, "upsert"]]);
  });

  it("serves the approved lesson to a different key through recall", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { lessonId, description } = await pendingLesson(world);
    expect((await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "approve" } })).status).toBe(200);

    const other = await community();
    const recall = await world.recall(other.agent, { domain: "fintech", tool: "transfer_funds", task_description: description, arguments: TRAP_ARGUMENTS });
    expect(recall.json).toMatchObject({ match: true, lesson: { lesson_id: lessonId, review_status: "approved" } });
  });

  it("approves a quarantined lesson too, and indexes it publicly for the first time", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { lessonId } = await quarantinedLesson(world);
    expect(world.store.records.has(lessonId)).toBe(false);

    const result = await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "approve" } });
    expect(result.status).toBe(200);
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "approved", visibility: "public", desired: 1, synced: 1 });
    expect(world.store.records.get(lessonId)!.metadata).toMatchObject({ visibility: "public", review_status: "approved" });
  });

  it("leaves the decision in D1 when Vectorize is down, and the cron finishes the sync", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { lessonId } = await pendingLesson(world);

    world.store.failUpsert = true;
    const result = await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "approve" } });
    expect(result.status).toBe(200);
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "approved", visibility: "public", desired: 2, synced: 1 });
    expect(world.store.records.get(lessonId)!.metadata.visibility).toMatch(/^k:/); // stale, submitter-only

    world.store.failUpsert = false;
    await world.runCron();
    expect(await lessonState(lessonId)).toMatchObject({ desired: 2, synced: 2 });
    expect(world.store.records.get(lessonId)!.metadata).toMatchObject({ visibility: "public", review_status: "approved" });
  });
});

describe("POST /api/v1/admin/review: reject", () => {
  it("records the reason code, rejects the lesson and deletes its vector", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { owner, lessonId } = await pendingLesson(world);
    expect(world.store.records.has(lessonId)).toBe(true);

    const result = await api(world, admin.agent, REVIEW, {
      payload: { lesson_id: lessonId, decision: "reject", reason_code: "incorrect_fix", reasoning: "The second approver is not a real role." },
    });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ decision: "reject", review_status: "rejected", visibility: "none" });

    expect(await lessonState(lessonId)).toMatchObject({ review_status: "rejected", visibility: "none", desired: 2, synced: 2 });
    const events = await humanEvents(lessonId);
    expect(events).toEqual([expect.objectContaining({ actor_id: admin.key, action: "reject", reason_code: "incorrect_fix" })]);
    expect(JSON.parse(events[0]!.details_json).reasoning).toBe("The second approver is not a real role.");
    expect(await counts(owner.key)).toEqual({ approved_count: 0, rejected_count: 1 });

    expect(world.store.records.has(lessonId)).toBe(false);
    expect(world.store.deleteCalls.flat()).toContain(lessonId);
    expect(await syncOperations(lessonId)).toEqual([[1, "upsert"], [2, "delete"]]);

    // Terminal: it cannot be reviewed again, and it left the queue.
    const again = await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "approve" } });
    expect(again.status).toBe(409);
    expect((await walk(world, admin.agent, PENDING)).some((item) => item.lesson_id === lessonId)).toBe(false);
  });

  it("is invisible to the submitter's recall afterwards", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { owner, lessonId, description } = await pendingLesson(world);
    await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "reject", reason_code: "low_quality" } });
    const recall = await world.recall(owner.agent, { domain: "fintech", tool: "transfer_funds", task_description: description, arguments: TRAP_ARGUMENTS });
    expect(recall.json).toMatchObject({ success: true, match: false });
  });
});

describe("POST /api/v1/admin/review: validation and state", () => {
  it("rejects malformed bodies with 400 and writes nothing", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { lessonId } = await pendingLesson(world);
    const bodies: Array<[string, unknown]> = [
      ["reject without reason_code", { lesson_id: lessonId, decision: "reject" }],
      ["unknown reason_code", { lesson_id: lessonId, decision: "reject", reason_code: "because" }],
      ["reason_code on approve", { lesson_id: lessonId, decision: "approve", reason_code: "duplicate" }],
      ["quarantine without reason_code", { lesson_id: lessonId, decision: "quarantine" }],
      ["quarantine with an unknown reason_code", { lesson_id: lessonId, decision: "quarantine", reason_code: "because" }],
      ["unknown decision", { lesson_id: lessonId, decision: "retract", reason_code: "incorrect_fix" }],
      ["unknown field", { lesson_id: lessonId, decision: "approve", extra: true }],
      ["bad lesson_id", { lesson_id: "not-a-uuid", decision: "approve" }],
      ["missing lesson_id", { decision: "approve" }],
      ["empty reasoning", { lesson_id: lessonId, decision: "approve", reasoning: "   " }],
      ["oversized reasoning", { lesson_id: lessonId, decision: "approve", reasoning: "x".repeat(1001) }],
      ["credential in reasoning", { lesson_id: lessonId, decision: "approve", reasoning: "see key AKIAIOSFODNN7EXAMPLE" }],
      ["not an object", ["approve"]],
    ];
    for (const [label, payload] of bodies) {
      const result = await api(world, admin.agent, REVIEW, { payload });
      expect(result.status, label).toBe(400);
      expect(result.json.code, label).toBe("INVALID_REQUEST");
    }
    expect(await humanEvents(lessonId)).toEqual([]);
    expect((await lessonState(lessonId))!.review_status).toBe("pending_review");
  });

  it("answers 404 for an unknown lesson", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const result = await api(world, admin.agent, REVIEW, { payload: { lesson_id: crypto.randomUUID(), decision: "approve" } });
    expect(result.status).toBe(404);
    expect(result.json.code).toBe("LESSON_NOT_FOUND");
  });

  it("answers 409 for a lesson that is not awaiting review, and for a second decision", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");

    const owner = await community();
    const untriaged = await insertPair({ ownerKey: owner.key, kind: "community" });
    expect((await lessonState(untriaged.lessonId))!.review_status).toBe("pending_triage");
    const early = await api(world, admin.agent, REVIEW, { payload: { lesson_id: untriaged.lessonId, decision: "approve" } });
    expect(early.status).toBe(409);
    expect(early.json.code).toBe("LESSON_NOT_REVIEWABLE");

    const { lessonId } = await pendingLesson(world);
    expect((await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "approve" } })).status).toBe(200);
    const second = await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "reject", reason_code: "duplicate" } });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("LESSON_NOT_REVIEWABLE");
    expect(await humanEvents(lessonId)).toHaveLength(1);
    expect((await lessonState(lessonId))!.review_status).toBe("approved");
  });
});

describe("POST /api/v1/admin/review: quarantine (retracting a live lesson)", () => {
  async function publish(world: World, admin: { agent: TestAgent }) {
    const lesson = await pendingLesson(world);
    expect((await api(world, admin.agent, REVIEW, { payload: { lesson_id: lesson.lessonId, decision: "approve" } })).status).toBe(200);
    expect(world.store.records.get(lesson.lessonId)!.metadata).toMatchObject({ visibility: "public", review_status: "approved" });
    return lesson;
  }

  it("takes an approved lesson out of the feed and recall, records who and why, and deletes its vector", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const admin = await provisionAgent("admin");
    const { owner, lessonId, description } = await publish(world, admin);
    const other = await community();
    const ask = () => world.recall(other.agent, { domain: "fintech", tool: "transfer_funds", task_description: description, arguments: TRAP_ARGUMENTS });
    const feedIds = async () => {
      const ctx = createExecutionContext();
      const response = await world.worker.fetch(new Request(`${ORIGIN}/api/v1/feed`, { headers: { "CF-Connecting-IP": freshIp() } }), env, ctx);
      await waitOnExecutionContext(ctx);
      return ((await response.json()) as any).lessons.map((item: any) => item.lesson_id) as string[];
    };
    expect(await feedIds()).toContain(lessonId);
    expect((await ask()).json).toMatchObject({ match: true });

    const payload = { lesson_id: lessonId, decision: "quarantine", reason_code: "incorrect_fix", reasoning: "Hallucinated cryptographic strings in the fix." };
    const result = await api(world, admin.agent, REVIEW, { payload });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      success: true,
      lesson_id: lessonId,
      decision: "quarantine",
      review_status: "quarantined",
      visibility: "none",
      vector_sync: "scheduled",
    });

    // Projected by the ledger triggers: not public, one more vector version to apply, and the sync applied it.
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "quarantined", visibility: "none", desired: 3, synced: 3 });
    expect(await syncOperations(lessonId)).toEqual([[1, "upsert"], [2, "upsert"], [3, "delete"]]);
    expect(world.store.records.has(lessonId)).toBe(false);
    expect(world.store.deleteCalls.flat()).toContain(lessonId);

    const events = await humanEvents(lessonId);
    expect(events.map((event) => [event.action, event.reason_code])).toEqual([["approve", null], ["quarantine", "incorrect_fix"]]);
    expect(events[1]).toMatchObject({ actor_type: "human", actor_id: admin.key });
    expect(JSON.parse(events[1]!.details_json)).toMatchObject({ reasoning: payload.reasoning, request_body_sha256: await sha256Hex(JSON.stringify(payload)) });
    // A retraction is not a rejection: the submitter's counters do not move.
    expect(await counts(owner.key)).toEqual({ approved_count: 1, rejected_count: 0 });

    expect(await feedIds()).not.toContain(lessonId);
    expect((await ask()).json).toEqual({ success: true, match: false });
  });

  it("clears the featured flag, so a retracted lesson cannot stay featured", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { lessonId } = await publish(world, admin);
    await env.DB.prepare(
      `INSERT INTO review_events (event_id, lesson_id, actor_type, actor_id, action, reason_code, details_json, at_ms)
       VALUES (?1, ?2, 'human', ?3, 'feature', NULL, NULL, ?4)`,
    )
      .bind(crypto.randomUUID(), lessonId, admin.key, Date.now())
      .run();
    expect((await env.DB.prepare("SELECT featured FROM lesson_state WHERE lesson_id = ?1").bind(lessonId).first<any>()).featured).toBe(1);

    expect((await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "quarantine", reason_code: "adversarial" } })).status).toBe(200);
    expect((await env.DB.prepare("SELECT featured FROM lesson_state WHERE lesson_id = ?1").bind(lessonId).first<any>()).featured).toBe(0);
  });

  it("can be closed for good with a reject, which moves the submitter's reject counter", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { owner, lessonId } = await publish(world, admin);
    expect((await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "quarantine", reason_code: "incorrect_fix" } })).status).toBe(200);

    const rejected = await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "reject", reason_code: "incorrect_fix", reasoning: "Retracted and closed." } });
    expect(rejected.status).toBe(200);
    expect(rejected.json).toMatchObject({ decision: "reject", review_status: "rejected", visibility: "none" });
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "rejected", visibility: "none", desired: 3, synced: 3 });
    expect(await counts(owner.key)).toEqual({ approved_count: 1, rejected_count: 1 });
    expect((await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "approve" } })).status).toBe(409);
  });

  it("can be undone: approving a quarantined lesson publishes it again", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { lessonId } = await publish(world, admin);
    await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "quarantine", reason_code: "low_quality" } });
    expect(world.store.records.has(lessonId)).toBe(false);

    expect((await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "approve" } })).status).toBe(200);
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "approved", visibility: "public", desired: 4, synced: 4 });
    expect(world.store.records.get(lessonId)!.metadata).toMatchObject({ visibility: "public", review_status: "approved" });
  });

  it("also moves a lesson that is still in the review queue into quarantine", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { lessonId } = await pendingLesson(world);
    const result = await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "quarantine", reason_code: "duplicate" } });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ review_status: "quarantined", visibility: "none" });
    expect(world.store.records.has(lessonId)).toBe(false); // the submitter-only vector is gone too
    expect((await walk(world, admin.agent, `${PENDING}?status=quarantined`)).some((item) => item.lesson_id === lessonId)).toBe(true);
    expect((await walk(world, admin.agent, PENDING)).some((item) => item.lesson_id === lessonId)).toBe(false);
  });

  it("answers 409 for a lesson that is rejected, already quarantined or still awaiting triage, and writes nothing", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const quarantine = { decision: "quarantine", reason_code: "low_quality" };

    const { lessonId: rejectedId } = await pendingLesson(world);
    await api(world, admin.agent, REVIEW, { payload: { lesson_id: rejectedId, decision: "reject", reason_code: "low_quality" } });
    const { lessonId: quarantinedId } = await quarantinedLesson(world);
    const owner = await community();
    const untriaged = await insertPair({ ownerKey: owner.key, kind: "community" });

    for (const lessonId of [rejectedId, quarantinedId, untriaged.lessonId]) {
      const before = (await lessonState(lessonId))!.review_status;
      const result = await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, ...quarantine } });
      expect(result.status, lessonId).toBe(409);
      expect(result.json.code).toBe("LESSON_NOT_REVIEWABLE");
      expect((await lessonState(lessonId))!.review_status).toBe(before);
    }
    expect(await humanEvents(quarantinedId)).toEqual([]);
    expect(await humanEvents(untriaged.lessonId)).toEqual([]);
  });

  it("is admin only, and an admin who seeded a lesson may retract it", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { lessonId } = await publish(world, admin);
    const stranger = await community();
    const denied = await api(world, stranger.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "quarantine", reason_code: "low_quality" } });
    expect(denied.status).toBe(403);
    expect((await lessonState(lessonId))!.review_status).toBe("approved");

    const seeded = await insertPair({ ownerKey: admin.key, kind: "seed" });
    await processLesson(env, world.deps, seeded.lessonId);
    expect((await api(world, admin.agent, REVIEW, { payload: { lesson_id: seeded.lessonId, decision: "approve" } })).status).toBe(200);
    const retracted = await api(world, admin.agent, REVIEW, { payload: { lesson_id: seeded.lessonId, decision: "quarantine", reason_code: "incorrect_fix" } });
    expect(retracted.status).toBe(200);
    expect(retracted.json).toMatchObject({ review_status: "quarantined", visibility: "none" });
  });
});

// ════════════════════════════════════════════════════════════════════════
// Four-eyes
// ════════════════════════════════════════════════════════════════════════

describe("four-eyes rule", () => {
  it("blocks an admin from reviewing a lesson that key submitted, and lets a second admin decide", async () => {
    const world = await freshWorld();
    const author = await provisionAgent("admin");
    const reviewer = await provisionAgent("admin");
    const { lessonId } = await insertPair({ ownerKey: author.key, kind: "community" });
    await processLesson(env, world.deps, lessonId);
    expect((await lessonState(lessonId))!.review_status).toBe("pending_review");

    for (const payload of [
      { lesson_id: lessonId, decision: "approve" },
      { lesson_id: lessonId, decision: "reject", reason_code: "low_quality" },
      { lesson_id: lessonId, decision: "quarantine", reason_code: "low_quality" },
    ]) {
      const blocked = await api(world, author.agent, REVIEW, { payload });
      expect(blocked.status).toBe(403);
      expect(blocked.json).toMatchObject({ success: false, code: "SELF_REVIEW_FORBIDDEN" });
    }
    expect(await humanEvents(lessonId)).toEqual([]);
    expect((await lessonState(lessonId))!.review_status).toBe("pending_review");

    const approved = await api(world, reviewer.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "approve" } });
    expect(approved.status).toBe(200);
    expect((await humanEvents(lessonId))[0]).toMatchObject({ actor_id: reviewer.key, action: "approve" });
  });

  it("exempts admin_seed lessons: the admin who seeded one can publish it", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { lessonId } = await insertPair({ ownerKey: admin.key, kind: "seed" });
    const source = await env.DB.prepare("SELECT provenance, source_agent_key FROM lessons WHERE lesson_id = ?1")
      .bind(lessonId)
      .first<{ provenance: string; source_agent_key: string }>();
    expect(source).toEqual({ provenance: "admin_seed", source_agent_key: admin.key });
    await processLesson(env, world.deps, lessonId);
    expect((await lessonState(lessonId))!.review_status).toBe("pending_review");

    const result = await api(world, admin.agent, REVIEW, { payload: { lesson_id: lessonId, decision: "approve", reasoning: "Seeded scenario, reviewed." } });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ review_status: "approved", visibility: "public" });
    expect((await humanEvents(lessonId))[0]).toMatchObject({ actor_id: admin.key, action: "approve" });
    expect(world.store.records.get(lessonId)!.metadata.visibility).toBe("public");
  });
});

// ════════════════════════════════════════════════════════════════════════
// POST /api/v1/admin/review/batch
// ════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/admin/review/batch", () => {
  /** Three pending lessons, each from its own community key. */
  async function pendingThree(world: World) {
    const first = await pendingLesson(world);
    const second = await pendingLesson(world);
    const third = await pendingLesson(world);
    return [first, second, third] as const;
  }

  it("applies each decision exactly as POST /review does, tags every audit row with the batch, and syncs vectors once", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const [a, b, c] = await pendingThree(world);
    world.store.upsertCalls.length = 0;
    world.store.deleteCalls.length = 0;

    const payload = {
      batch_id: "fintech-2026-11-18a",
      decisions: [
        { lesson_id: a.lessonId, decision: "approve", reasoning: "Clear delta." },
        { lesson_id: b.lessonId, decision: "approve" },
        { lesson_id: c.lessonId, decision: "reject", reason_code: "duplicate", reasoning: "Covered by an approved lesson." },
      ],
    };
    const result = await api(world, admin.agent, REVIEW_BATCH, { payload });
    expect(result.status).toBe(200);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(result.json).toEqual({
      success: true,
      batch_id: "fintech-2026-11-18a",
      requested: 3,
      applied: 3,
      failed: 0,
      results: [
        { lesson_id: a.lessonId, decision: "approve", ok: true, review_status: "approved", visibility: "public" },
        { lesson_id: b.lessonId, decision: "approve", ok: true, review_status: "approved", visibility: "public" },
        { lesson_id: c.lessonId, decision: "reject", ok: true, review_status: "rejected", visibility: "none" },
      ],
      vector_sync: "scheduled",
    });

    // One human review_event per lesson, every one tied to the whole signed request and the batch label.
    const bodyHash = await sha256Hex(JSON.stringify(payload));
    for (const [pair, action, reason] of [[a, "approve", null], [b, "approve", null], [c, "reject", "duplicate"]] as const) {
      const events = await humanEvents(pair.lessonId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor_id: admin.key, action, reason_code: reason });
      expect(JSON.parse(events[0]!.details_json)).toMatchObject({ batch_id: "fintech-2026-11-18a", request_body_sha256: bodyHash });
    }
    expect(await counts(a.owner.key)).toEqual({ approved_count: 1, rejected_count: 0 });
    expect(await counts(c.owner.key)).toEqual({ approved_count: 0, rejected_count: 1 });

    // ONE sync for the whole batch: one upsert call carrying both approvals, one delete call for the rejection.
    expect(world.store.upsertCalls).toHaveLength(1);
    expect(world.store.upsertCalls[0]!.map((record) => record.id).sort()).toEqual([a.lessonId, b.lessonId].sort());
    expect(world.store.deleteCalls).toEqual([[c.lessonId]]);
    expect(await lessonState(a.lessonId)).toMatchObject({ review_status: "approved", visibility: "public", desired: 2, synced: 2 });
    expect(await lessonState(c.lessonId)).toMatchObject({ review_status: "rejected", visibility: "none", desired: 2, synced: 2 });
  });

  it("applies the good items and reports the rest per item: not found, self-review, already decided", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const [good, decided] = [await pendingLesson(world), await pendingLesson(world)];
    await api(world, admin.agent, REVIEW, { payload: { lesson_id: decided.lessonId, decision: "reject", reason_code: "low_quality" } });
    const own = await insertPair({ ownerKey: admin.key, kind: "community" });
    await processLesson(env, world.deps, own.lessonId);
    const missing = "00000000-0000-4000-8000-000000000000";

    const result = await api(world, admin.agent, REVIEW_BATCH, {
      payload: {
        decisions: [
          { lesson_id: missing, decision: "approve" },
          { lesson_id: own.lessonId, decision: "approve" },
          { lesson_id: decided.lessonId, decision: "approve" },
          { lesson_id: good.lessonId, decision: "approve" },
        ],
      },
    });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ success: true, batch_id: null, requested: 4, applied: 1, failed: 3, vector_sync: "scheduled" });
    expect(result.json.results).toEqual([
      { lesson_id: missing, decision: "approve", ok: false, status: 404, code: "LESSON_NOT_FOUND", error: "lesson does not exist" },
      { lesson_id: own.lessonId, decision: "approve", ok: false, status: 403, code: "SELF_REVIEW_FORBIDDEN", error: expect.any(String) },
      { lesson_id: decided.lessonId, decision: "approve", ok: false, status: 409, code: "LESSON_NOT_REVIEWABLE", error: expect.any(String) },
      { lesson_id: good.lessonId, decision: "approve", ok: true, review_status: "approved", visibility: "public" },
    ]);
    // Nothing was written for the refused items; a batch with no label stores none.
    expect(await humanEvents(own.lessonId)).toEqual([]);
    expect((await lessonState(decided.lessonId))!.review_status).toBe("rejected");
    expect(JSON.parse((await humanEvents(good.lessonId))[0]!.details_json)).not.toHaveProperty("batch_id");
  });

  it("does no sync when nothing was applied", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    world.store.upsertCalls.length = 0;
    const result = await api(world, admin.agent, REVIEW_BATCH, { payload: { decisions: [{ lesson_id: "00000000-0000-4000-8000-000000000000", decision: "approve" }] } });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ applied: 0, failed: 1, vector_sync: "none" });
    expect(world.store.upsertCalls).toHaveLength(0);
  });

  it("accepts REVIEW_BATCH_MAX decisions and refuses one more", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const ids = Array.from({ length: REVIEW_BATCH_MAX + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const ok = await api(world, admin.agent, REVIEW_BATCH, { payload: { decisions: ids.slice(0, REVIEW_BATCH_MAX).map((lesson_id) => ({ lesson_id, decision: "approve" })) } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ requested: REVIEW_BATCH_MAX, applied: 0, failed: REVIEW_BATCH_MAX });
    const tooMany = await api(world, admin.agent, REVIEW_BATCH, { payload: { decisions: ids.map((lesson_id) => ({ lesson_id, decision: "approve" })) } });
    expect(tooMany.status).toBe(400);
  });

  it("rejects malformed batches with 400 and writes nothing", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const { lessonId } = await pendingLesson(world);
    const approve = { lesson_id: lessonId, decision: "approve" };
    const bodies: Array<[string, unknown]> = [
      ["no decisions", { decisions: [] }],
      ["decisions missing", { batch_id: "x" }],
      ["not an object", [approve]],
      ["the same lesson twice", { decisions: [approve, { lesson_id: lessonId, decision: "reject", reason_code: "low_quality" }] }],
      ["reject without reason_code", { decisions: [{ lesson_id: lessonId, decision: "reject" }] }],
      ["one bad item among good ones", { decisions: [approve, { lesson_id: "not-a-uuid", decision: "approve" }] }],
      ["unknown field", { decisions: [approve], approve_all: true }],
      ["a wildcard instead of ids", { decisions: [{ lesson_id: "*", decision: "approve" }] }],
      ["bad batch_id", { batch_id: "has spaces", decisions: [approve] }],
      ["empty batch_id", { batch_id: "", decisions: [approve] }],
      ["long batch_id", { batch_id: "a".repeat(65), decisions: [approve] }],
    ];
    for (const [name, payload] of bodies) {
      const result = await api(world, admin.agent, REVIEW_BATCH, { payload });
      expect(result.status, name).toBe(400);
      expect(result.json, name).toMatchObject({ success: false });
    }
    expect(await humanEvents(lessonId)).toEqual([]);
    expect((await lessonState(lessonId))!.review_status).toBe("pending_review");
  });

  it("is admin only: 401 unsigned, 403 for community, internal and platform keys, and nothing is written", async () => {
    const world = await freshWorld();
    const { lessonId } = await pendingLesson(world);
    const payload = { decisions: [{ lesson_id: lessonId, decision: "approve" }] };
    expect((await call(REVIEW_BATCH, { method: "POST", body: JSON.stringify(payload) })).status).toBe(401);
    for (const agent of [(await community()).agent, (await provisionAgent("internal")).agent, (await provisionAgent("platform")).agent]) {
      expect((await api(world, agent, REVIEW_BATCH, { payload })).status).toBe(403);
    }
    expect(await humanEvents(lessonId)).toEqual([]);
  });

  it("leaves every decision in D1 when Vectorize is down, and the cron finishes the one sync", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const [a, b] = [await pendingLesson(world), await pendingLesson(world)];
    world.store.failUpsert = true;
    const result = await api(world, admin.agent, REVIEW_BATCH, { payload: { decisions: [a, b].map((pair) => ({ lesson_id: pair.lessonId, decision: "approve" })) } });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ applied: 2, failed: 0 });
    expect(await lessonState(a.lessonId)).toMatchObject({ review_status: "approved", desired: 2, synced: 1 });
    world.store.failUpsert = false;
    await world.runCron();
    for (const pair of [a, b]) {
      expect(await lessonState(pair.lessonId)).toMatchObject({ desired: 2, synced: 2 });
      expect(world.store.records.get(pair.lessonId)!.metadata).toMatchObject({ visibility: "public", review_status: "approved" });
    }
  });

  it("counts as one request against the hourly admin budget", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const lessons = await pendingThree(world);
    const used = async () => (await consumeUsage(env, adminUsageKey(admin.key), ADMIN_LIMIT_PER_AGENT_PER_HOUR)).remaining;
    const before = await used();
    await api(world, admin.agent, REVIEW_BATCH, { payload: { decisions: lessons.map((pair) => ({ lesson_id: pair.lessonId, decision: "approve" })) } });
    // The probe above and this request each spent one unit: the three decisions together spent exactly one.
    expect(before - (await used())).toBe(2);
  });
});

describe("GET /api/v1/admin/pending: coverage", () => {
  it("names an approved lesson with the same tool and changed paths, and one with the same delta; null when nothing covers it", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    // The ledger is shared by every case in this file, so the argument keys are unique to this one.
    const key = `field_${uuid().slice(0, 8)}`;
    const lessonWith = async (field: string) => {
      const owner = await community();
      const { lessonId } = await world.createLesson(owner.agent, {
        trapArguments: { ...TRAP_ARGUMENTS, [field]: null },
        fixArguments: { ...FIX_ARGUMENTS, [field]: "ops-lead" },
      });
      return { lessonId };
    };
    const first = await lessonWith(key);
    const second = await lessonWith(key);
    const { lessonId: different } = await lessonWith(`other_${uuid().slice(0, 8)}`);
    expect((await lessonState(different))!.review_status).toBe("pending_review");

    const before = (await walk(world, admin.agent, PENDING)).find((item) => item.lesson_id === second.lessonId);
    expect(before.coverage).toEqual({ same_rule_class: null, same_delta: null });

    expect((await api(world, admin.agent, REVIEW, { payload: { lesson_id: first.lessonId, decision: "approve" } })).status).toBe(200);
    const queue = await walk(world, admin.agent, PENDING);
    expect(queue.find((item) => item.lesson_id === second.lessonId).coverage).toEqual({ same_rule_class: first.lessonId, same_delta: first.lessonId });
    expect(queue.find((item) => item.lesson_id === different).coverage).toEqual({ same_rule_class: null, same_delta: null });
    expect(queue.some((item) => item.lesson_id === first.lessonId)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/v1/bounties
// ════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/bounties", () => {
  it("lists traps whose window closed without a fix, with the failure context and no submitter identity", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const owner = await community();
    const tool = "probe_list";
    const expired = await insertOpenTrap({ ownerKey: owner.key, ageMs: 25 * HOUR, tool });
    const open = await insertOpenTrap({ ownerKey: owner.key, ageMs: 23 * HOUR, tool });
    const fresh = await insertOpenTrap({ ownerKey: owner.key, ageMs: 0, tool });

    const result = await api(world, admin.agent, `${BOUNTIES}?tool=${tool}`);
    expect(result.status).toBe(200);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(result.json).toMatchObject({ success: true, untrusted_content: true, next_cursor: null });

    // 23 h old and brand new are still inside their pairing window.
    expect(result.json.bounties.map((item: any) => item.trap_id)).toEqual([expired.trapId]);
    expect([open.trapId, fresh.trapId]).not.toContain(result.json.bounties[0].trap_id);
    expect(result.json.bounties[0]).toMatchObject({
      trap_id: expired.trapId,
      domain: "fintech",
      tool,
      task_description: expired.description,
      trap_arguments: TRAP_ARGUMENTS,
      violation_rule: "Dual authorisation for large transfers",
      steering_directive: "Add a second approver before moving the funds.",
      attempts: 1,
    });
    expect(Date.parse(result.json.bounties[0].expired_at)).toBeLessThanOrEqual(Date.now());
    expect(JSON.stringify(result.json)).not.toContain(owner.key);
  });

  it("excludes traps that already have a fix, whatever happened to the lesson", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const owner = await community();
    const internal = await provisionAgent("internal");
    // Auto-approval is paused for this fixer, so the bounty lesson waits for a human.
    await pauseAutoApprove(internal.key);
    const fixed = await insertPair({ ownerKey: owner.key, kind: "bounty", fixerKey: internal.key });
    const open = await insertOpenTrap({ ownerKey: owner.key, ageMs: 25 * HOUR });

    const ids = (await walk(world, admin.agent, BOUNTIES)).map((item) => item.trap_id);
    expect(ids).toContain(open.trapId);
    expect(ids).not.toContain(fixed.trapId);

    // A rejected fix still consumes its trap (fixes_one_per_trap).
    await processLesson(env, world.deps, fixed.lessonId);
    expect((await lessonState(fixed.lessonId))!.review_status).toBe("pending_review");
    const rejected = await api(world, admin.agent, REVIEW, { payload: { lesson_id: fixed.lessonId, decision: "reject", reason_code: "low_quality" } });
    expect(rejected.status).toBe(200);
    expect((await lessonState(fixed.lessonId))!.review_status).toBe("rejected");
    const afterReject = (await walk(world, admin.agent, BOUNTIES)).map((item) => item.trap_id);
    expect(afterReject).toContain(open.trapId);
    expect(afterReject).not.toContain(fixed.trapId);
  });

  it("hides a trap under another key's live lease, and keeps it visible to the lease holder", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const holder = await provisionAgent("internal");
    const owner = await community();
    const tool = "probe_lease";
    const leased = await insertOpenTrap({ ownerKey: owner.key, ageMs: 25 * HOUR, leaseKey: holder.key, tool });

    expect((await api(world, admin.agent, `${BOUNTIES}?tool=${tool}`)).json.bounties).toEqual([]);
    expect((await api(world, (await provisionAgent("internal")).agent, `${BOUNTIES}?tool=${tool}`)).json.bounties).toEqual([]);
    const own = await api(world, holder.agent, `${BOUNTIES}?tool=${tool}`);
    expect(own.json.bounties.map((item: any) => item.trap_id)).toEqual([leased.trapId]);
  });

  it("filters by domain and tool", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const owner = await community();
    const a = await insertOpenTrap({ ownerKey: owner.key, ageMs: 25 * HOUR, tool: "probe_a" });
    const b = await insertOpenTrap({ ownerKey: owner.key, ageMs: 25 * HOUR, tool: "probe_b", domain: "other-domain" });

    expect((await api(world, admin.agent, `${BOUNTIES}?tool=probe_a`)).json.bounties.map((item: any) => item.trap_id)).toEqual([a.trapId]);
    expect((await api(world, admin.agent, `${BOUNTIES}?domain=other-domain`)).json.bounties.map((item: any) => item.trap_id)).toEqual([b.trapId]);
    expect((await api(world, admin.agent, `${BOUNTIES}?domain=other-domain&tool=probe_a`)).json.bounties).toEqual([]);
  });

  it("pages oldest first with a keyset cursor", async () => {
    const world = await freshWorld();
    const admin = await provisionAgent("admin");
    const owner = await community();
    const tool = "probe_page";
    const oldest = await insertOpenTrap({ ownerKey: owner.key, ageMs: 27 * HOUR, tool });
    const middle = await insertOpenTrap({ ownerKey: owner.key, ageMs: 26 * HOUR, tool });
    const newest = await insertOpenTrap({ ownerKey: owner.key, ageMs: 25 * HOUR, tool });

    const first = await api(world, admin.agent, `${BOUNTIES}?tool=${tool}&limit=2`);
    expect(first.json.bounties.map((item: any) => item.trap_id)).toEqual([oldest.trapId, middle.trapId]);
    expect(first.json.next_cursor).toEqual(expect.any(String));
    const second = await api(world, admin.agent, `${BOUNTIES}?tool=${tool}&limit=2&cursor=${first.json.next_cursor}`);
    expect(second.json.bounties.map((item: any) => item.trap_id)).toEqual([newest.trapId]);
    expect(second.json.next_cursor).toBeNull();
  });

  it("rejects bad query parameters with 400", async () => {
    const world = await freshWorld();
    const internal = await provisionAgent("internal");
    for (const query of ["limit=0", "limit=51", "domain=BAD_DOMAIN", "tool=%20", "status=open", "limit=1&limit=2", "cursor=nope"]) {
      const result = await api(world, internal.agent, `${BOUNTIES}?${query}`);
      expect(result.status, query).toBe(400);
      expect(result.json.code, query).toBe("INVALID_REQUEST");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/v1/admin/telemetry (Cloudflare Analytics Engine SQL API, mocked)
// ════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/admin/telemetry", () => {
  /** Funnel events by ref (some counts arrive as strings, as Cloudflare's JSON format can send them). */
  const ROWS: CfRows = {
    funnel: [
      { ref_tag: "launch-post", step: "skill_view", events: "300" },
      { ref_tag: "launch-post", step: "challenge_issued", events: 70 },
      { ref_tag: "launch-post", step: "agent_register", events: 3 },
      { ref_tag: "", step: "skill_view", events: 100 },
      { ref_tag: "", step: "agent_register", events: 1 },
      { ref_tag: "NOT A SLUG", step: "skill_view", events: 5 },
      { ref_tag: "hn", step: "skill_view", events: 20 },
      { ref_tag: "hn", step: "challenge_issued", events: 10 },
    ],
    registrations: [
      { agent_id: "a1", ref_tag: "launch-post" },
      { agent_id: "a2", ref_tag: "launch-post" },
      { agent_id: "a3", ref_tag: "launch-post" },
      { agent_id: "a4", ref_tag: "" },
    ],
    activity: [
      { agent_id: "a1", step: "recall", events: "5" },
      { agent_id: "a1", step: "calibrate_trap", events: 2 },
      { agent_id: "a1", step: "calibrate_fix", events: 1 },
      { agent_id: "a2", step: "recall", events: 3 },
      { agent_id: "a4", step: "recall", events: 4 },
      // Registered before the window: not in the cohort, so ignored.
      { agent_id: "a9", step: "recall", events: 100 },
      { agent_id: "a9", step: "calibrate_trap", events: 100 },
    ],
    failures: [
      { code: "POW_INVALID", endpoint: "register", ref_tag: "launch-post", events: 4 },
      { code: "CHALLENGE_WRONG_NETWORK", endpoint: "register", ref_tag: "", events: "3" },
      { code: "POW_INVALID", endpoint: "register", ref_tag: "", events: 1 },
      { code: "RATE_LIMITED", endpoint: "challenge", ref_tag: "NOT A SLUG", events: 2 },
    ],
    searches: [
      { domain: "fintech", outcome: "hit", events: 12 },
      { domain: "fintech", outcome: "miss", events: "6" },
      { domain: "devsecops", outcome: "miss", events: 2 },
    ],
    lessonViews: [
      { ref_tag: "audit", outcome: "hit", events: 9 },
      { ref_tag: "audit", outcome: "miss", events: 1 },
      { ref_tag: "launch-post", outcome: "hit", events: "2" },
    ],
    // recall (signed), recall_unsigned and mcp_sandbox_recall, by action, domain, status, miss reason and client.
    recallCalls: [
      { action: "recall", domain: "fintech", status: "hit", reason: "", client: "mcp-package", events: 6 },
      { action: "recall", domain: "fintech", status: "miss", reason: "below_threshold", client: "mcp-package", events: "2" },
      { action: "recall", domain: "devsecops", status: "budget_exhausted", reason: "", client: "other", events: 1 },
      { action: "recall", domain: "devsecops", status: "miss", reason: "", client: "", events: 3 }, // before miss reasons existed
      { action: "recall_unsigned", domain: "devsecops", status: "hit", reason: "", client: "mcp-package", events: 4 },
      { action: "recall_unsigned", domain: "devsecops", status: "miss", reason: "tool_unknown", client: "mcp-package", events: 9 },
      { action: "recall_unsigned", domain: "fintech", status: "miss", reason: "tool_unknown", client: "other", events: "5" },
      { action: "recall_unsigned", domain: "fintech", status: "miss", reason: "no_candidate", client: "other", events: 1 },
      { action: "recall_unsigned", domain: "", status: "rate_limited", reason: "", client: "other", events: 7 },
      { action: "mcp_sandbox_recall", domain: "fintech", status: "sample", reason: "", client: "", events: 11 },
      { action: "mcp_sandbox_recall", domain: "devsecops", status: "empty", reason: "", client: "", events: 2 },
    ],
    unmatchedTools: [
      { tool: "bash", reason: "tool_unknown", events: 8 },
      { tool: "postgres_query", reason: "tool_unknown", events: "6" },
      { tool: "dispatch_wire", reason: "below_threshold", events: 4 },
      { tool: "shell", reason: "", events: 1 }, // a miss recorded before reasons existed
    ],
  };

  const EMPTY_TOTALS = { skill_view: 0, challenge_issued: 0, agent_register: 0, agents_recalled: 0, agents_calibrated: 0, recall_requests: 0, calibrate_requests: 0, registration_failed: 0 };

  it("answers 401 to unsigned requests and 403 to non-admin keys, without calling Cloudflare", async () => {
    const mock = mockCloudflareAnalytics(ROWS);
    try {
      const world = await freshWorld();
      const unsigned = await call(TELEMETRY);
      expect(unsigned.status).toBe(401);
      expect(await unsigned.json()).toMatchObject({ code: "AGENT_SIGNATURE_REQUIRED" });

      for (const agent of [(await community()).agent, (await provisionAgent("internal")).agent, (await provisionAgent("platform")).agent]) {
        const result = await api(world, agent, TELEMETRY);
        expect(result.status).toBe(403);
        expect(result.json.code).toBe("AGENT_ROLE_FORBIDDEN");
      }
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  it("queries the SQL API with the read-only token and returns the merged funnel by ref", async () => {
    const mock = mockCloudflareAnalytics(ROWS);
    try {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      const result = await api(world, admin.agent, TELEMETRY);

      expect(result.status).toBe(200);
      expect(result.response.headers.get("Cache-Control")).toBe("no-store");

      // Eight requests, one per query, each to the account's SQL endpoint with the bearer token and nothing request-controlled.
      expect(mock.requests.map((request) => request.query).sort()).toEqual(["activity", "failures", "funnel", "lessonViews", "recallCalls", "registrations", "searches", "unmatchedTools"]);
      for (const request of mock.requests) {
        expect(request.url).toBe(ANALYTICS_URL);
        expect(request.method).toBe("POST");
        expect(request.authorization).toBe(`Bearer ${TEST_ANALYTICS_TOKEN}`);
        expect(request.contentType).toBe("text/plain");
        expect(request.sql).toContain("FROM achromat_mom_telemetry");
        expect(request.sql).toContain("timestamp > NOW() - INTERVAL '7' DAY");
        expect(request.sql).toContain("FORMAT JSON");
        expect(request.sql).not.toMatch(/\bJOIN\b|\bUNION\b/i);
      }
      // Counts are weighted by the sample interval, never plain row counts.
      expect(mock.requests.find((request) => request.query === "funnel")!.sql).toContain("SUM(_sample_interval)");
      expect(mock.requests.find((request) => request.query === "activity")!.sql).toContain("SUM(_sample_interval)");
      expect(mock.requests.find((request) => request.query === "recallCalls")!.sql).toContain("SUM(_sample_interval)");
      expect(mock.requests.find((request) => request.query === "unmatchedTools")!.sql).toContain("SUM(_sample_interval)");
      // The unmatched-tools query is bounded, and the recall-calls query reads only the three recall actions.
      expect(mock.requests.find((request) => request.query === "unmatchedTools")!.sql).toMatch(/ORDER BY events DESC\nLIMIT 25\n/);
      expect(mock.requests.find((request) => request.query === "recallCalls")!.sql).toContain("blob1 IN ('recall', 'recall_unsigned', 'mcp_sandbox_recall')");

      const json = result.json;
      expect(Object.keys(json).sort()).toEqual([
        "activity_all_agents", "audit_links", "by_ref", "conversion", "dataset", "failures", "generated_at", "ledger", "notes",
        "recall_summary", "searches", "success", "totals", "truncated", "unmatched_tools", "window",
      ]);
      expect(json.success).toBe(true);
      expect(json.dataset).toBe("achromat_mom_telemetry");
      expect(json.truncated).toBe(false);
      expect(json.window.name).toBe("7d");
      expect(Date.parse(json.window.to) - Date.parse(json.window.from)).toBe(7 * 24 * 60 * 60 * 1000);
      expect(json.generated_at).toBe(json.window.to);

      // Sorted by registrations; the invalid slug and the empty ref both land under null; a ref with no registrations still shows.
      expect(json.by_ref).toEqual([
        { ref: "launch-post", skill_view: 300, challenge_issued: 70, agent_register: 3, agents_recalled: 2, agents_calibrated: 1, recall_requests: 8, calibrate_requests: 3, registration_failed: 4 },
        { ref: null, skill_view: 105, challenge_issued: 0, agent_register: 1, agents_recalled: 1, agents_calibrated: 0, recall_requests: 4, calibrate_requests: 0, registration_failed: 6 },
        { ref: "hn", skill_view: 20, challenge_issued: 10, agent_register: 0, agents_recalled: 0, agents_calibrated: 0, recall_requests: 0, calibrate_requests: 0, registration_failed: 0 },
      ]);
      expect(json.totals).toEqual({ skill_view: 425, challenge_issued: 80, agent_register: 4, agents_recalled: 3, agents_calibrated: 1, recall_requests: 12, calibrate_requests: 3, registration_failed: 10 });

      // Refusals by response code and endpoint (counts that arrive as strings are summed), most frequent first.
      expect(json.failures).toEqual({
        total: 10,
        by_code: [
          { code: "POW_INVALID", endpoint: "register", events: 5 },
          { code: "CHALLENGE_WRONG_NETWORK", endpoint: "register", events: 3 },
          { code: "RATE_LIMITED", endpoint: "challenge", events: 2 },
        ],
      });
      expect(json.searches).toEqual({
        total: 20,
        hits: 12,
        by_domain: [
          { domain: "fintech", searches: 18, hits: 12 },
          { domain: "devsecops", searches: 2, hits: 0 },
        ],
      });
      expect(json.audit_links).toEqual({
        views: 12,
        found: 11,
        by_ref: [
          { ref: "audit", views: 10, found: 9 },
          { ref: "launch-post", views: 2, found: 2 },
        ],
      });
      expect(json.conversion).toEqual({
        view_to_challenge: 0.1882,
        challenge_to_register: 0.05,
        register_to_recall: 0.75,
        register_to_calibrate: 0.25,
      });

      // ALL agents, with no cohort filter: a9 (registered before the window) is counted here and nowhere above.
      expect(json.activity_all_agents).toEqual({
        recall: { requests: 112, agents: 4 }, // 5 + 3 + 4 + 100, from a1, a2, a4 and a9
        calibrate: { requests: 103, agents: 2 }, // 2 + 1 + 100, from a1 and a9
      });
      // ... while the cohort fields above still exclude a9.
      expect(json.totals.recall_requests).toBe(12);

      // Signed, unsigned and sandbox recalls, side by side.
      expect(json.recall_summary.signed).toEqual({
        requests: 12,
        hit: 6,
        miss: 5,
        budget_exhausted: 1,
        rate_limited: 0,
        by_domain: [
          { domain: "fintech", requests: 8, hit: 6 },
          { domain: "devsecops", requests: 4, hit: 0 },
        ],
        miss_reasons: [{ reason: "below_threshold", events: 2 }], // the 3 misses with no reason are not invented a reason
        by_client: [
          { client: "mcp-package", requests: 8 },
          { client: "other", requests: 1 },
        ],
      });
      expect(json.recall_summary.unsigned).toEqual({
        requests: 26,
        hit: 4,
        miss: 15,
        budget_exhausted: 0,
        rate_limited: 7,
        by_domain: [
          { domain: "devsecops", requests: 13, hit: 4 },
          { domain: "", requests: 7, hit: 0 },
          { domain: "fintech", requests: 6, hit: 0 },
        ],
        miss_reasons: [
          { reason: "tool_unknown", events: 14 },
          { reason: "no_candidate", events: 1 },
        ],
        // A tie (13 each) is broken alphabetically.
        by_client: [
          { client: "mcp-package", requests: 13 },
          { client: "other", requests: 13 },
        ],
      });
      expect(json.recall_summary.mcp_sandbox).toEqual({
        calls: 13,
        sample: 11,
        empty: 2,
        by_domain: [
          { domain: "fintech", calls: 11 },
          { domain: "devsecops", calls: 2 },
        ],
      });
      // The tool names recalls missed on: most missed first, a missing reason is null, counts that arrive as strings are summed.
      expect(json.unmatched_tools).toEqual([
        { tool: "bash", reason: "tool_unknown", events: 8 },
        { tool: "postgres_query", reason: "tool_unknown", events: 6 },
        { tool: "dispatch_wire", reason: "below_threshold", events: 4 },
        { tool: "shell", reason: null, events: 1 },
      ]);

      // The notes explain the sampling behaviour and the cohort.
      const notes: string = json.notes.join("\n");
      expect(json.notes.length).toBeGreaterThan(0);
      expect(notes).toContain("SUM(_sample_interval)");
      expect(notes).toMatch(/downsamples/);
      expect(notes).toContain("'anonymous'");
      expect(notes).toMatch(/failures count every refused/);
      expect(notes).toMatch(/audit_links counts opened citation links/);
      expect(notes).toMatch(/registered inside the window|fell inside the window/);
      expect(notes).toMatch(/activity_all_agents counts every agent/);
      expect(notes).toMatch(/tool_unknown/);
      expect(notes).toMatch(/ledger is read from D1/);

      // Neither the token nor any request detail leaks into the response.
      expect(JSON.stringify(json)).not.toContain(TEST_ANALYTICS_TOKEN);
      expect(JSON.stringify(json)).not.toContain("a9");
    } finally {
      mock.restore();
    }
  });

  it("uses a 24 hour window on request", async () => {
    const mock = mockCloudflareAnalytics(ROWS);
    try {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      const result = await api(world, admin.agent, `${TELEMETRY}?window=24h`);
      expect(result.status).toBe(200);
      expect(result.json.window.name).toBe("24h");
      expect(Date.parse(result.json.window.to) - Date.parse(result.json.window.from)).toBe(24 * 60 * 60 * 1000);
      expect(mock.requests).toHaveLength(8);
      for (const request of mock.requests) {
        expect(request.sql).toContain("INTERVAL '1' DAY");
        expect(request.sql).not.toContain("INTERVAL '7' DAY");
      }
      expect((await api(world, admin.agent, `${TELEMETRY}?window=7d`)).json.window.name).toBe("7d");
    } finally {
      mock.restore();
    }
  });

  it("rejects bad query parameters with 400 before any call to Cloudflare, and never puts them in SQL", async () => {
    const mock = mockCloudflareAnalytics(ROWS);
    try {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      const attacks = ["window=30d", "window=1h", "window=", "window=7D", "window=7d%27%20OR%201%3D1", "window=24h&window=7d", "limit=5", "ref=launch-post", "window=7d&x=1"];
      for (const query of attacks) {
        const result = await api(world, admin.agent, `${TELEMETRY}?${query}`);
        expect(result.status, query).toBe(400);
        expect(result.json.code, query).toBe("INVALID_REQUEST");
      }
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  it("returns zero totals and null rates, never NaN, when there is no data", async () => {
    const mock = mockCloudflareAnalytics({});
    try {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      const result = await api(world, admin.agent, TELEMETRY);
      expect(result.status).toBe(200);
      expect(result.json.by_ref).toEqual([]);
      expect(result.json.totals).toEqual(EMPTY_TOTALS);
      expect(result.json.failures).toEqual({ total: 0, by_code: [] });
      expect(result.json.searches).toEqual({ total: 0, hits: 0, by_domain: [] });
      expect(result.json.audit_links).toEqual({ views: 0, found: 0, by_ref: [] });
      expect(result.json.conversion).toEqual({ view_to_challenge: null, challenge_to_register: null, register_to_recall: null, register_to_calibrate: null });
      expect(result.json.activity_all_agents).toEqual({ recall: { requests: 0, agents: 0 }, calibrate: { requests: 0, agents: 0 } });
      const none = { requests: 0, hit: 0, miss: 0, budget_exhausted: 0, rate_limited: 0, by_domain: [], miss_reasons: [], by_client: [] };
      expect(result.json.recall_summary).toEqual({ signed: none, unsigned: none, mcp_sandbox: { calls: 0, sample: 0, empty: 0, by_domain: [] } });
      expect(result.json.unmatched_tools).toEqual([]);
      expect(result.json.truncated).toBe(false);
    } finally {
      mock.restore();
    }
  });

  it("flags truncation when a query returns its row limit", async () => {
    const full = Array.from({ length: 10_000 }, (_, index) => ({ agent_id: `agent-${index}`, ref_tag: "" }));
    const mock = mockCloudflareAnalytics({ registrations: full });
    try {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      const result = await api(world, admin.agent, TELEMETRY);
      expect(result.status).toBe(200);
      expect(result.json.truncated).toBe(true);
    } finally {
      mock.restore();
    }
  });

  it("answers 503 without calling Cloudflare when the account ID or token is missing or malformed", async () => {
    const mock = mockCloudflareAnalytics(ROWS);
    try {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      const broken: Array<Record<string, string>> = [
        { ANALYTICS_API_TOKEN: "" },
        { ANALYTICS_API_TOKEN: "   " },
        { CLOUDFLARE_ACCOUNT_ID: "" },
        { CLOUDFLARE_ACCOUNT_ID: "<YOUR_CLOUDFLARE_ACCOUNT_ID>" },
        { CLOUDFLARE_ACCOUNT_ID: "0123456789ABCDEF0123456789ABCDEF" },
        { CLOUDFLARE_ACCOUNT_ID: "../../evil" },
      ];
      for (const override of broken) {
        const result = await api(world, admin.agent, TELEMETRY, { env: { ...env, ...override } as typeof env });
        expect(result.status, JSON.stringify(override)).toBe(503);
        expect(result.json.code).toBe("SERVICE_MISCONFIGURED");
      }
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  it("answers 502 UPSTREAM_UNAVAILABLE when Cloudflare refuses, without relaying its error text or the token", async () => {
    const body = JSON.stringify({ success: false, errors: [{ message: "secret account detail" }] });
    for (const status of [400, 403, 429, 500]) {
      const mock = mockCloudflareAnalytics(ROWS, { funnel: { status, body } });
      try {
        const world = await freshWorld();
        const admin = await provisionAgent("admin");
        const result = await api(world, admin.agent, TELEMETRY);
        expect(result.status, String(status)).toBe(502);
        expect(result.json.code).toBe("UPSTREAM_UNAVAILABLE");
        const text = JSON.stringify(result.json);
        expect(text).not.toContain("secret account detail");
        expect(text).not.toContain(TEST_ANALYTICS_TOKEN);
      } finally {
        mock.restore();
      }
    }
  });

  it("answers 502 when the network fails and 504 when Cloudflare times out", async () => {
    const network = mockCloudflareAnalytics(ROWS, { activity: { throws: new TypeError("connection reset") } });
    try {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      const result = await api(world, admin.agent, TELEMETRY);
      expect(result.status).toBe(502);
      expect(result.json.code).toBe("UPSTREAM_UNAVAILABLE");
    } finally {
      network.restore();
    }

    const timeout = mockCloudflareAnalytics(ROWS, { registrations: { throws: Object.assign(new Error("timed out"), { name: "TimeoutError" }) } });
    try {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      const result = await api(world, admin.agent, TELEMETRY);
      expect(result.status).toBe(504);
      expect(result.json.code).toBe("UPSTREAM_TIMEOUT");
    } finally {
      timeout.restore();
    }
  });

  it("answers 502 UPSTREAM_INVALID for a reply that is not the expected JSON", async () => {
    const replies = ["not json", "{}", JSON.stringify({ data: "nope" }), JSON.stringify({ data: [{ ref_tag: "x", step: "skill_view", events: "many" }] }), JSON.stringify({ data: [{ ref_tag: "x", step: "skill_view", events: -1 }] })];
    for (const body of replies) {
      const mock = mockCloudflareAnalytics(ROWS, { funnel: { body } });
      try {
        const world = await freshWorld();
        const admin = await provisionAgent("admin");
        const result = await api(world, admin.agent, TELEMETRY);
        expect(result.status, body).toBe(502);
        expect(result.json.code, body).toBe("UPSTREAM_INVALID");
      } finally {
        mock.restore();
      }
    }
  });

  describe("the D1 ledger section (exact, not sampled)", () => {
    /** The ledger as the endpoint reports it, with the Analytics Engine returning no rows. */
    async function ledgerOf(world: World, admin: { agent: TestAgent }, window = "7d") {
      const mock = mockCloudflareAnalytics({});
      try {
        const result = await api(world, admin.agent, `${TELEMETRY}?window=${window}`);
        expect(result.status).toBe(200);
        return result.json.ledger as {
          registrations: Array<{ role: string; in_window: number; all_time: number }>;
          calibrate: { attempts: number; agents: number; block: number; allow: number };
          recall_hits: { first_deliveries: number; agents: number };
          recall_misses: { misses: number; callers: number };
        };
      } finally {
        mock.restore();
      }
    }
    const role = (ledger: Awaited<ReturnType<typeof ledgerOf>>, name: string) => ledger.registrations.find((row) => row.role === name) ?? { role: name, in_window: 0, all_time: 0 };

    it("counts every agent's calibrations, recall hits and recall misses, and new registrations, exactly", async () => {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      const before = await ledgerOf(world, admin);

      // One new community agent makes a lesson (a BLOCK and an ALLOW), and a second agent reads it and then misses once.
      const owner = await community();
      const { description } = await world.createLesson(owner.agent);
      const reader = await community();
      expect((await world.recall(owner.agent, { domain: "fintech", tool: "transfer_funds", task_description: description, arguments: TRAP_ARGUMENTS })).json.match).toBe(true);
      expect((await world.recall(reader.agent, { domain: "fintech", tool: "bash", task_description: uniqueDescription(), arguments: TRAP_ARGUMENTS })).json.match).toBe(false);

      const after = await ledgerOf(world, admin);
      expect(role(after, "community").in_window - role(before, "community").in_window).toBe(2);
      expect(role(after, "community").all_time - role(before, "community").all_time).toBe(2);
      expect(after.calibrate.attempts - before.calibrate.attempts).toBe(2);
      expect(after.calibrate.agents - before.calibrate.agents).toBe(1);
      expect(after.calibrate.block - before.calibrate.block).toBe(1);
      expect(after.calibrate.allow - before.calibrate.allow).toBe(1);
      expect(after.recall_hits.first_deliveries - before.recall_hits.first_deliveries).toBe(1);
      expect(after.recall_hits.agents - before.recall_hits.agents).toBe(1);
      expect(after.recall_misses.misses - before.recall_misses.misses).toBe(1);
      expect(after.recall_misses.callers - before.recall_misses.callers).toBe(1);
    });

    it("sees an agent that registered before the window, which the cohort fields cannot", async () => {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      const veteran = await community();
      // Age the registration to 10 days ago (agent_identities is insert-only, so its update trigger is dropped around the rewrite).
      await env.DB.prepare("DROP TRIGGER agent_identities_no_update").run();
      try {
        await env.DB.prepare("UPDATE agent_identities SET registered_at_ms = registered_at_ms - ?2 WHERE agent_key = ?1").bind(veteran.key, 10 * 24 * HOUR).run();
      } finally {
        await env.DB.prepare("CREATE TRIGGER agent_identities_no_update BEFORE UPDATE ON agent_identities BEGIN SELECT RAISE(ABORT, 'agent_identities is append-only'); END").run();
      }
      const before = await ledgerOf(world, admin);
      await world.createLesson(veteran.agent);
      const after = await ledgerOf(world, admin);
      // The ledger counts the veteran's two calibrations although it registered outside the 7 day window ...
      expect(after.calibrate.attempts - before.calibrate.attempts).toBe(2);
      expect(after.calibrate.agents - before.calibrate.agents).toBe(1);
      // ... and the registration is in all_time but not in the window.
      expect(role(after, "community").in_window).toBe(role(before, "community").in_window);
      expect(role(after, "community").all_time).toBe(role(before, "community").all_time);
    });

    it("reads a 24 hour window from its own cut-off, and returns only counts", async () => {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      const week = await ledgerOf(world, admin, "7d");
      const day = await ledgerOf(world, admin, "24h");
      expect(day.calibrate.attempts).toBeLessThanOrEqual(week.calibrate.attempts);
      for (const ledger of [week, day]) {
        expect(Object.keys(ledger).sort()).toEqual(["calibrate", "recall_hits", "recall_misses", "registrations"]);
        const text = JSON.stringify(ledger);
        expect(text).not.toMatch(/[0-9a-f]{64}/); // no agent key
        expect(text).not.toContain("task_description");
      }
    });

    it("is null, with the rest of the report intact, when D1 cannot be read", async () => {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      const mock = mockCloudflareAnalytics(ROWS);
      try {
        const brokenDb = new Proxy(env.DB, {
          get(target, property) {
            if (property === "batch") return () => Promise.reject(new Error("D1 down"));
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const result = await api(world, admin.agent, TELEMETRY, { env: { ...env, DB: brokenDb } as typeof env });
        expect(result.status).toBe(200);
        expect(result.json.ledger).toBeNull();
        expect(result.json.totals.agent_register).toBe(4);
        expect(JSON.stringify(result.json)).not.toContain("D1 down");
      } finally {
        mock.restore();
      }
    });
  });

  it("shares the per-key admin budget with the other admin reads", async () => {
    const mock = mockCloudflareAnalytics(ROWS);
    try {
      const world = await freshWorld();
      const admin = await provisionAgent("admin");
      for (let i = 0; i < ADMIN_LIMIT_PER_AGENT_PER_HOUR; i++) await consumeUsage(env, adminUsageKey(admin.key), ADMIN_LIMIT_PER_AGENT_PER_HOUR);
      const limited = await api(world, admin.agent, TELEMETRY);
      expect(limited.status).toBe(429);
      expect(limited.json.code).toBe("RATE_LIMITED");
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });
});
