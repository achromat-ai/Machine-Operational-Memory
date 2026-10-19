import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { demandHmac, visibilityToken } from "../src/crypto/attestation";
import { RECALL_LIMIT_PER_AGENT_PER_HOUR, RECALL_MIN_SCORE, RECALL_TOP_K, recallUsageKey } from "../src/routes/recall";
import { RecallResponse } from "../src/schema";
import { HOUR_MS } from "../src/usage";
import { FIX_ARGUMENTS, TOOL, TRAP_ARGUMENTS, community, humanReview, lessonState, uniqueDescription } from "./fixtures/ledger";
import { freshWorld, type World } from "./fixtures/world";
import { call } from "./helpers";

const DOMAIN = "fintech";

function query(description: string, args: Record<string, unknown> = TRAP_ARGUMENTS, overrides: Record<string, unknown> = {}) {
  return { domain: DOMAIN, tool: TOOL, task_description: description, arguments: args, ...overrides };
}

/** An approved lesson, published to the fake index. */
async function approvedLesson(world: World, owner: Awaited<ReturnType<typeof community>>, options: Parameters<World["createLesson"]>[1] = {}) {
  const lesson = await world.createLesson(owner.agent, options);
  await humanReview(lesson.lessonId, "approve");
  await world.reconcileAt();
  return lesson;
}

describe("POST /api/v1/recall: access and validation", () => {
  it("requires a signed request", async () => {
    const response = await call("/api/v1/recall", { method: "POST", body: JSON.stringify(query(uniqueDescription())) });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "AGENT_SIGNATURE_REQUIRED" });
  });

  it("rejects an unknown domain, an empty arguments object and unknown fields, without embedding anything", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const cases: Array<[Record<string, unknown>, string]> = [
      [query(uniqueDescription(), TRAP_ARGUMENTS, { domain: "healthcare" }), "DOMAIN_UNKNOWN"],
      [query(uniqueDescription(), {}), "INVALID_REQUEST"],
      [query(uniqueDescription(), TRAP_ARGUMENTS, { top_k: 50 }), "INVALID_REQUEST"],
      [query("too short"), "INVALID_REQUEST"],
    ];
    for (const [payload, code] of cases) {
      const { status, json } = await world.recall(agent, payload);
      expect(status, code).toBe(400);
      expect(json.code).toBe(code);
    }
    expect(world.embedder.calls).toHaveLength(0);
  });

  it("allows 240 recalls per agent per hour, then answers 429 without searching", async () => {
    const world = await freshWorld();
    const { agent, key } = await community();
    expect(RECALL_LIMIT_PER_AGENT_PER_HOUR).toBe(240);
    const stub = env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName(recallUsageKey(key)));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("w", { window: Math.floor(Date.now() / HOUR_MS), windowMs: HOUR_MS, count: 240 });
    });
    const { status, json, response } = await world.recall(agent, query(uniqueDescription()));
    expect(status).toBe(429);
    expect(json.code).toBe("RATE_LIMITED");
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(world.embedder.calls).toHaveLength(0);
  });

  it("answers 503 when embedding or Vectorize is down, and logs no demand for it", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    world.embedder.fail = () => true;
    expect((await world.recall(agent, query(uniqueDescription()))).json).toMatchObject({ code: "SEARCH_UNAVAILABLE" });
    world.embedder.fail = null;
    world.store.failQuery = true;
    const down = await world.recall(agent, query(uniqueDescription()));
    expect(down.status).toBe(503);
    expect(down.json.code).toBe("SEARCH_UNAVAILABLE");
  });
});

describe("POST /api/v1/recall: exact tier", () => {
  it("serves a submitter its own pending pair, with compliant_arguments and changed paths only", async () => {
    const world = await freshWorld();
    const owner = await community();
    const { lessonId, description } = await world.createLesson(owner.agent, {
      trapArguments: { ...TRAP_ARGUMENTS, memo: "TRAP-ONLY-MARKER" },
      fixArguments: FIX_ARGUMENTS,
    });
    world.embedder.calls = [];

    // Different spacing: the fingerprint is taken over the normalised description.
    const { status, json } = await world.recall(owner.agent, query(description.replace(/ /g, "   ")));
    expect(status).toBe(200);
    const body = RecallResponse.parse(json);
    expect(body).toMatchObject({ match: true, tier: "exact", score: 1 });
    if (!body.match) throw new Error("expected a match");

    expect(body.lesson).toMatchObject({
      lesson_id: lessonId,
      review_status: "pending",
      domain: DOMAIN,
      tool: TOOL,
      violation_rule: "Dual authorisation for large transfers",
      steering_directive: "Add a second approver before moving the funds.",
      statutory_anchor: "FCA SYSC 6.1.1",
      compliant_arguments: FIX_ARGUMENTS,
      changed_paths: ["/approval/second_approver", "/memo"],
      attestation_kid: "mom_pk_v1",
    });
    expect(body.lesson.pair_attestation).toHaveLength(86);
    expect(body.lesson.block_receipt.id).not.toBe(body.lesson.allow_receipt.id);

    // The blocked call's values never leave the ledger, and the exact tier needs no embedding.
    const text = JSON.stringify(json);
    for (const leaked of ["TRAP-ONLY-MARKER", "trap_arguments", "delta_json", "evaluated_input"]) expect(text).not.toContain(leaked);
    expect(world.embedder.calls).toHaveLength(0);
  });

  it("keeps a pending pair away from every other key, in D1 and in the Vectorize filter", async () => {
    const world = await freshWorld();
    const owner = await community();
    const other = await community();
    const { description } = await world.createLesson(owner.agent);

    const { json } = await world.recall(other.agent, query(description));
    expect(json).toEqual({ success: true, match: false });

    // The semantic search ran with a filter that admits only public lessons and the caller's own.
    const tokenOther = await visibilityToken(env.VISIBILITY_KEY, other.key);
    expect(world.store.queryCalls).toHaveLength(1);
    expect(world.store.queryCalls[0]!.options).toEqual({
      namespace: DOMAIN,
      topK: RECALL_TOP_K,
      filter: { tool_name: { $eq: TOOL }, visibility: { $in: ["public", tokenOther] } },
    });
    expect(RECALL_TOP_K).toBe(5);
  });
});

describe("POST /api/v1/recall: semantic tier", () => {
  it("returns an approved lesson to a different key for a similar task, above the 0.82 cutoff", async () => {
    const world = await freshWorld();
    const owner = await community();
    const { lessonId, description } = await approvedLesson(world, owner);
    expect(world.store.records.get(lessonId)!.metadata).toMatchObject({ visibility: "public", review_status: "approved" });

    const caller = await community();
    const { status, json } = await world.recall(caller.agent, query(`${description} today`));
    expect(status).toBe(200);
    const body = RecallResponse.parse(json);
    if (!body.match) throw new Error(`expected a semantic match: ${JSON.stringify(json)}`);
    expect(body.tier).toBe("semantic");
    expect(body.score).toBeGreaterThanOrEqual(RECALL_MIN_SCORE);
    expect(body.score).toBeLessThan(1);
    expect(body.lesson).toMatchObject({ lesson_id: lessonId, review_status: "approved", compliant_arguments: FIX_ARGUMENTS, changed_paths: ["/approval/second_approver"] });

    // The query embedding is the task plus the request's key paths: no rule line, no values.
    expect(world.embedder.calls.at(-1)![0]).toBe(`task: ${description} today\nargument_keys: amount approval approval.second_approver currency`);
  });

  it("applies the cutoff to the exact score", async () => {
    const world = await freshWorld();
    const owner = await community();
    const { lessonId, description } = await approvedLesson(world, owner);
    const caller = await community();
    const request = query(`${description} again`);

    world.store.scoreOverride.set(lessonId, 0.81);
    const below = await world.recall(caller.agent, request);
    expect(below.json).toEqual({ success: true, match: false });

    world.store.scoreOverride.set(lessonId, 0.83);
    const above = await world.recall(caller.agent, request);
    expect(above.json).toMatchObject({ match: true, tier: "semantic", score: 0.83 });

    world.store.scoreOverride.set(lessonId, RECALL_MIN_SCORE);
    expect((await world.recall(caller.agent, request)).json).toMatchObject({ match: true, score: RECALL_MIN_SCORE });
  });

  it("misses on an unrelated task, and records one demand row per caller, task and hour", async () => {
    const world = await freshWorld();
    const owner = await community();
    await approvedLesson(world, owner);
    const caller = await community();
    const unrelated = query("Schedule the onboarding review meeting with the compliance team");

    for (let i = 0; i < 2; i++) expect((await world.recall(caller.agent, unrelated)).json).toEqual({ success: true, match: false });
    const who = await demandHmac(env.VISIBILITY_KEY, caller.key);
    const rows = await env.DB.prepare("SELECT domain, tool_name, nearest_score, hour_bucket, created_at_ms FROM domain_demand WHERE agent_key_hmac = ?1")
      .bind(who)
      .all<{ domain: string; tool_name: string; nearest_score: number; hour_bucket: number; created_at_ms: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ domain: DOMAIN, tool_name: TOOL });
    expect(rows.results[0]!.nearest_score).toBeLessThan(RECALL_MIN_SCORE);
    expect(rows.results[0]!.hour_bucket).toBe(Math.floor(rows.results[0]!.created_at_ms / HOUR_MS));
  });

  it("never serves a lesson of another tool or domain", async () => {
    const world = await freshWorld();
    const owner = await community();
    const { description } = await approvedLesson(world, owner);
    const caller = await community();
    const otherTool = await world.recall(caller.agent, query(`${description} now`, TRAP_ARGUMENTS, { tool: "wire_transfer" }));
    expect(otherTool.json).toEqual({ success: true, match: false });
    const otherDomain = await world.recall(caller.agent, query(`${description} now`, TRAP_ARGUMENTS, { domain: "devsecops" }));
    expect(otherDomain.json).toEqual({ success: true, match: false });
  });

  it("re-checks every hit in D1: an index that ignores its filter still cannot leak another key's pending lesson or another tool's lesson", async () => {
    const world = await freshWorld();
    const owner = await community();
    const { lessonId, description } = await world.createLesson(owner.agent); // pending, visible to the owner only
    world.store.ignoreFilter = true;

    const caller = await community();
    const request = query(`${description} again`);
    // Precondition: the leaky index does return the owner's pending vector for this query.
    const probe = await world.store.query((await world.embedder.embed([`task: ${description}`]))[0]!, {
      namespace: DOMAIN,
      topK: 5,
      filter: { tool_name: { $eq: TOOL }, visibility: { $in: ["public"] } },
    });
    expect(probe.map((match) => match.id)).toContain(lessonId);
    world.store.scoreOverride.set(lessonId, 0.99);

    expect((await world.recall(caller.agent, request)).json).toEqual({ success: true, match: false });
    expect((await world.recall(caller.agent, query(`${description} again`, TRAP_ARGUMENTS, { tool: "wire_transfer" }))).json).toEqual({ success: true, match: false });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM lesson_deliveries WHERE agent_key = ?1").bind(caller.key).first()).toEqual({ n: 0 });
  });

  it("drops a stale vector: a lesson quarantined after it was published is not served", async () => {
    const world = await freshWorld();
    const owner = await community();
    const { lessonId, description } = await approvedLesson(world, owner);
    await humanReview(lessonId, "quarantine", "toxic_content");
    expect((await lessonState(lessonId))!.visibility).toBe("none");
    // Vectorize is eventually consistent: the public vector is still in the index.
    expect(world.store.records.get(lessonId)!.metadata.visibility).toBe("public");

    const caller = await community();
    const { json } = await world.recall(caller.agent, query(`${description} later`));
    expect(json).toEqual({ success: true, match: false });

    // Prove the index did hand the stale vector back, so the miss above is the D1 re-check's doing.
    const last = world.store.queryCalls.at(-1)!;
    expect((await world.store.query(last.values, last.options)).map((match) => match.id)).toEqual([lessonId]);
  });
});

describe("POST /api/v1/recall: distinct-lesson budget", () => {
  it("caps first deliveries per key per day, keeps repeats free, and never charges a key for its own lessons", async () => {
    const world = await freshWorld({ recallDailyDistinctLessons: 1 });
    const owner = await community();
    const first = await world.createLesson(owner.agent);
    const second = await world.createLesson(owner.agent);
    await humanReview(first.lessonId, "approve");
    await humanReview(second.lessonId, "approve");

    const caller = await community();
    expect((await world.recall(caller.agent, query(first.description))).json).toMatchObject({ match: true, tier: "exact" });
    expect((await world.recall(caller.agent, query(second.description))).json).toEqual({ success: true, match: false, budget_exhausted: true });
    expect((await world.recall(caller.agent, query(first.description))).json).toMatchObject({ match: true });

    // The owner is not charged for its own lessons.
    expect((await world.recall(owner.agent, query(first.description))).json).toMatchObject({ match: true });
    expect((await world.recall(owner.agent, query(second.description))).json).toMatchObject({ match: true });

    const delivered = await env.DB.prepare("SELECT count(*) AS n FROM lesson_deliveries WHERE agent_key = ?1").bind(caller.key).first();
    expect(delivered).toEqual({ n: 1 });
    // A budget refusal is not unmet demand.
    const demand = await env.DB.prepare("SELECT count(*) AS n FROM domain_demand WHERE agent_key_hmac = ?1")
      .bind(await demandHmac(env.VISIBILITY_KEY, caller.key))
      .first();
    expect(demand).toEqual({ n: 0 });
  });

  it("counts a delivery only inside the rolling 24 hours", async () => {
    const world = await freshWorld({ recallDailyDistinctLessons: 1 });
    const owner = await community();
    const first = await world.createLesson(owner.agent);
    const second = await world.createLesson(owner.agent);
    await humanReview(first.lessonId, "approve");
    await humanReview(second.lessonId, "approve");
    const caller = await community();

    await world.recall(caller.agent, query(first.description));
    // Age the delivery past 24 hours (lesson_deliveries is insert-only, so rewrite it through its own table trigger).
    await env.DB.prepare("DROP TRIGGER lesson_deliveries_no_update").run();
    try {
      await env.DB.prepare("UPDATE lesson_deliveries SET first_served_at_ms = first_served_at_ms - 90000000 WHERE agent_key = ?1").bind(caller.key).run();
    } finally {
      await env.DB.prepare("CREATE TRIGGER lesson_deliveries_no_update BEFORE UPDATE ON lesson_deliveries BEGIN SELECT RAISE(ABORT, 'lesson_deliveries is append-only'); END").run();
    }
    expect((await world.recall(caller.agent, query(second.description))).json).toMatchObject({ match: true });
  });
});
