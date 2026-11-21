import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { demandHmac, visibilityToken } from "../src/crypto/attestation";
import { networkPrefix, networkPrefixHmac } from "../src/network";
import {
  ANONYMOUS_DEMAND_TEXT,
  RECALL_ANON_GLOBAL_KEY,
  RECALL_ANON_GLOBAL_PER_HOUR,
  RECALL_LIMIT_PER_AGENT_PER_HOUR,
  RECALL_MIN_SCORE,
  RECALL_TOP_K,
  recallUsageKey,
} from "../src/routes/recall";
import { AnonymousRecallResponse, RecallResponse, normaliseTaskDescription, sha256Hex } from "../src/schema";
import { HOUR_MS } from "../src/usage";
import { FIX_ARGUMENTS, TOOL, TRAP_ARGUMENTS, community, humanReview, lessonState, uniqueDescription } from "./fixtures/ledger";
import { freshWorld, type World } from "./fixtures/world";
import { freshIp, signatureHeaders } from "./helpers";
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
  it("is mounted unsigned in the deployed entry point: a request with no Achromat-* header reaches validation, not a 401", async () => {
    // The deployed Worker has the real (remote-only) search bindings, so only a request that fails validation is sent here.
    // A valid unsigned request is answered by the tests below, which use fake search.
    const response = await call("/api/v1/recall", { method: "POST", body: JSON.stringify(query("too short")) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
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

    // Nor does the upstream rule name leave the ledger: the statutory anchor is all a caller gets.
    expect(body.lesson).not.toHaveProperty("violation_rule");
    expect(text).not.toContain("violation_rule");
    expect(text).not.toContain("Dual authorisation for large transfers");
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


// ════════════════════════════════════════════════════════════════════════
// Unsigned (anonymous) recall
// ════════════════════════════════════════════════════════════════════════

/** The 43-character id under which an anonymous miss is logged, derived from the caller's /24 and never from the IP itself. */
async function networkDemandId(ip: string): Promise<string> {
  return demandHmac(env.VISIBILITY_KEY, `network:${await networkPrefixHmac(env.IP_HMAC_KEY, networkPrefix(ip)!)}`);
}

describe("POST /api/v1/recall: unsigned callers see public approved lessons only", () => {
  it("serves an approved lesson in the public shape: no receipts, no attestation, no budget field", async () => {
    const world = await freshWorld();
    const owner = await community();
    const { lessonId, description } = await approvedLesson(world, owner);
    const before = await env.DB.prepare("SELECT count(*) AS n FROM lesson_deliveries").first<{ n: number }>();

    for (const [label, task, tier] of [["exact", description, "exact"], ["semantic", `${description} today`, "semantic"]] as const) {
      const { status, json } = await world.recallUnsigned(query(task));
      expect(status, label).toBe(200);
      const body = AnonymousRecallResponse.parse(json);
      if (!body.match) throw new Error(`expected a ${label} match: ${JSON.stringify(json)}`);
      expect(body.tier).toBe(tier);
      expect(body.lesson).toEqual({
        lesson_id: lessonId,
        review_status: "approved",
        domain: DOMAIN,
        tool: TOOL,
        steering_directive: "Add a second approver before moving the funds.",
        statutory_anchor: "FCA SYSC 6.1.1",
        compliant_arguments: FIX_ARGUMENTS,
        changed_paths: ["/approval/second_approver"],
      });
      const text = JSON.stringify(json);
      for (const leaked of ["block_receipt", "allow_receipt", "pair_attestation", "attestation_kid", "violation_rule", "trap_arguments", "delta_json", "budget_exhausted"]) {
        expect(text, `${label} must not carry ${leaked}`).not.toContain(leaked);
      }
    }
    // No key, so no delivery row: an anonymous caller is not charged a budget it cannot have.
    expect(await env.DB.prepare("SELECT count(*) AS n FROM lesson_deliveries").first()).toEqual(before);
  });

  it("never serves a pending lesson, even to a request that asks for exactly its task", async () => {
    const world = await freshWorld();
    const owner = await community();
    const { description } = await world.createLesson(owner.agent); // pending: visible to its submitter only
    expect((await world.recallUnsigned(query(description))).json).toEqual({ success: true, match: false });
    // The semantic search admits public lessons only: not the public ones plus a caller token.
    expect(world.store.queryCalls.at(-1)!.options).toEqual({
      namespace: DOMAIN,
      topK: RECALL_TOP_K,
      filter: { tool_name: { $eq: TOOL }, visibility: { $in: ["public"] } },
    });
  });

  it("re-checks every hit in D1: a leaky index cannot hand an anonymous caller a pending or a quarantined lesson", async () => {
    const world = await freshWorld();
    const owner = await community();
    const pending = await world.createLesson(owner.agent);
    const quarantined = await approvedLesson(world, owner);
    await humanReview(quarantined.lessonId, "quarantine", "toxic_content");
    world.store.ignoreFilter = true;
    world.store.scoreOverride.set(pending.lessonId, 0.99);
    world.store.scoreOverride.set(quarantined.lessonId, 0.99);
    for (const task of [`${pending.description} again`, `${quarantined.description} again`]) {
      expect((await world.recallUnsigned(query(task))).json).toEqual({ success: true, match: false });
    }
  });

  it("matches the tool exactly: a lesson of another tool or domain is a miss", async () => {
    const world = await freshWorld();
    const owner = await community();
    const { description } = await approvedLesson(world, owner);
    expect((await world.recallUnsigned(query(`${description} now`, TRAP_ARGUMENTS, { tool: "bash" }))).json).toEqual({ success: true, match: false });
    expect((await world.recallUnsigned(query(`${description} now`, TRAP_ARGUMENTS, { domain: "devsecops" }))).json).toEqual({ success: true, match: false });
  });

  it("validates like a signed call, without embedding anything", async () => {
    const world = await freshWorld();
    const cases: Array<[unknown, string]> = [
      [query(uniqueDescription(), TRAP_ARGUMENTS, { domain: "healthcare" }), "DOMAIN_UNKNOWN"],
      [query(uniqueDescription(), {}), "INVALID_REQUEST"],
      [query("too short"), "INVALID_REQUEST"],
      [query(uniqueDescription(), TRAP_ARGUMENTS, { top_k: 50 }), "INVALID_REQUEST"],
      ["{not json", "INVALID_REQUEST"],
    ];
    for (const [payload, code] of cases) {
      const { status, json } = await world.recallUnsigned(payload);
      expect(status, code).toBe(400);
      expect(json.code).toBe(code);
    }
    expect((await world.recallUnsigned("x".repeat(70 * 1024))).status).toBe(413);
    expect(world.embedder.calls).toHaveLength(0);
  });

  it("fails closed without a caller address", async () => {
    const world = await freshWorld();
    const { status, json } = await world.recallUnsigned(query(uniqueDescription()), { ip: null });
    expect(status).toBe(400);
    expect(json.code).toBe("CLIENT_IP_UNAVAILABLE");
    expect(world.embedder.calls).toHaveLength(0);
  });
});

describe("POST /api/v1/recall: any Achromat-* header means a full signature check (never a silent downgrade)", () => {
  async function expectRefused(world: World, headers: Record<string, string>, code: string, label: string, payload: unknown = query(uniqueDescription())) {
    const before = world.analytics.points.length;
    const { status, json } = await world.recallUnsigned(payload, { headers });
    expect(status, label).toBe(401);
    expect(json.code, label).toBe(code);
    // Refused before the handler: nothing was searched, logged or counted.
    expect(world.embedder.calls, label).toHaveLength(0);
    expect(world.analytics.points, label).toHaveLength(before);
  }

  it("refuses a partial or malformed set of Achromat-* headers with 401", async () => {
    const world = await freshWorld();
    await expectRefused(world, { "Achromat-Nonce": "AAECAwQFBgcICQoLDA0ODw" }, "AGENT_SIGNATURE_REQUIRED", "a lone nonce");
    await expectRefused(world, { "achromat-agent-key": "x" }, "AGENT_SIGNATURE_REQUIRED", "a lone key, lower case");
    await expectRefused(world, { "ACHROMAT-FUTURE-HEADER": "1" }, "AGENT_SIGNATURE_REQUIRED", "an unknown Achromat-* header");
    await expectRefused(
      world,
      { "Achromat-Agent-Key": "not-a-key", "Achromat-Timestamp": "abc", "Achromat-Nonce": "!", "Achromat-Signature": "!" },
      "AGENT_SIGNATURE_INVALID",
      "all four present but malformed",
    );
  });

  it("refuses an expired, a forged and an unregistered signature, and answers a valid one", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const stranger = await (await import("./helpers")).newAgent();
    const body = JSON.stringify(query(uniqueDescription()));
    const signed = async (who: typeof agent, options: Parameters<typeof signatureHeaders>[2] = {}) =>
      Object.fromEntries((await signatureHeaders(who, "/api/v1/recall", { method: "POST", body, ...options })).entries());

    // Expired: a clock more than 60 s off. The package's clock-skew retry depends on exactly this code.
    const sent = JSON.parse(body);
    await expectRefused(world, await signed(agent, { timestamp: Math.floor(Date.now() / 1000) - 120 }), "AGENT_SIGNATURE_EXPIRED", "expired", sent);
    // Forged: signed over a different body than the one sent.
    await expectRefused(world, await signed(agent, { signedBody: "something else" }), "AGENT_SIGNATURE_INVALID", "forged", sent);
    // A well-formed, correct signature from a key the service has never seen.
    await expectRefused(world, await signed(stranger), "AGENT_KEY_UNKNOWN", "unregistered key", sent);

    // And a correct signature is still the signed path: it is not routed through the anonymous limiter.
    const ok = await world.recall(agent, JSON.parse(body));
    expect(ok.status).toBe(200);
    expect(world.analytics.points.at(-1)!.blobs![0]).toBe("recall");
  });

  it("keeps every other route behind a signature, and the optional rule to POST /api/v1/recall alone", async () => {
    const world = await freshWorld();
    const attempts: Array<[string, string, string]> = [
      ["POST", "/api/v1/calibrate", JSON.stringify(query(uniqueDescription()))],
      ["GET", "/api/v1/agents/me", ""],
      ["GET", "/api/v1/admin/telemetry?window=7d", ""],
      ["GET", "/api/v1/bounties", ""],
      ["GET", "/api/v1/recall", ""],
      ["PUT", "/api/v1/recall", JSON.stringify(query(uniqueDescription()))],
      ["POST", "/api/v1/recall/extra", JSON.stringify(query(uniqueDescription()))],
    ];
    for (const [method, path, body] of attempts) {
      const response = await call(path, { method, ...(body ? { body, headers: { "Content-Type": "application/json" } } : {}) });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(await response.json(), `${method} ${path}`).toMatchObject({ code: "AGENT_SIGNATURE_REQUIRED" });
    }
    expect(world.embedder.calls).toHaveLength(0);
  });
});

describe("POST /api/v1/recall: unsigned limits", () => {
  it("allows 30 a minute per network, then answers 429 with Retry-After, without searching, and counts it", async () => {
    const world = await freshWorld();
    const ip = freshIp();
    // Invalid bodies cost nothing to answer but still spend the network's allowance.
    for (let i = 0; i < 30; i++) expect((await world.recallUnsigned(query("too short"), { ip })).status, `request ${i + 1}`).toBe(400);
    world.analytics.points.length = 0;
    const limited = await world.recallUnsigned(query(uniqueDescription()), { ip });
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe("RATE_LIMITED");
    expect(Number(limited.response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(world.embedder.calls).toHaveLength(0);
    // The refusal is a data point of its own (status rate_limited), not a miss.
    expect(world.analytics.points).toEqual([
      { indexes: ["recall_unsigned"], blobs: ["recall_unsigned", "", "", "anonymous", "rate_limited", "", "", "other"], doubles: [1] },
    ]);
    // The allowance is per /24 network, not per address.
    expect((await world.recallUnsigned(query("too short"), { ip: ip.replace(/\.\d+$/, ".99") })).status).toBe(429);
    // A different network is unaffected, and a signed caller never meets this limit.
    expect((await world.recallUnsigned(query("too short"), { ip: freshIp() })).status).toBe(400);
    const { agent } = await community();
    expect((await world.recall(agent, query(uniqueDescription()))).status).toBe(200);
  });

  it("stops at the global hourly cap for everyone, and leaves signed callers alone", async () => {
    const world = await freshWorld();
    const stub = env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName(RECALL_ANON_GLOBAL_KEY));
    const put = (count: number) =>
      runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put("w", { window: Math.floor(Date.now() / HOUR_MS), windowMs: HOUR_MS, count });
      });
    expect(RECALL_ANON_GLOBAL_PER_HOUR).toBe(3000);
    await put(RECALL_ANON_GLOBAL_PER_HOUR);
    try {
      const limited = await world.recallUnsigned(query(uniqueDescription()));
      expect(limited.status).toBe(429);
      expect(limited.json.code).toBe("RATE_LIMITED");
      expect(Number(limited.response.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(world.embedder.calls).toHaveLength(0);
      const { agent } = await community();
      expect((await world.recall(agent, query(uniqueDescription()))).status).toBe(200);
    } finally {
      await put(0);
    }
  });
});

describe("POST /api/v1/recall: what an unsigned miss records", () => {
  it("stores the fingerprint and a fixed placeholder, never the task text, under an id derived from the network", async () => {
    const world = await freshWorld();
    const ip = freshIp();
    const description = `${uniqueDescription()} for the UNSIGNED-TEXT-MARKER account`;
    expect((await world.recallUnsigned(query(description), { ip })).json).toEqual({ success: true, match: false });

    const rows = await env.DB.prepare("SELECT domain, tool_name, task_fingerprint, task_description, nearest_score FROM domain_demand WHERE agent_key_hmac = ?1")
      .bind(await networkDemandId(ip))
      .all<{ domain: string; tool_name: string; task_fingerprint: string; task_description: string; nearest_score: number | null }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      domain: DOMAIN,
      tool_name: TOOL,
      task_fingerprint: await sha256Hex(normaliseTaskDescription(description)),
      task_description: ANONYMOUS_DEMAND_TEXT,
    });
    // The words are nowhere in D1, and the placeholder satisfies the column's 16 to 1000 character rule.
    expect(ANONYMOUS_DEMAND_TEXT.length).toBeGreaterThanOrEqual(16);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM domain_demand WHERE task_description LIKE ?1").bind("%UNSIGNED-TEXT-MARKER%").first()).toEqual({ n: 0 });
    expect(JSON.stringify(world.analytics.points)).not.toContain("UNSIGNED-TEXT-MARKER");
    // One row per caller, task and hour.
    await world.recallUnsigned(query(description), { ip });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM domain_demand WHERE agent_key_hmac = ?1").bind(await networkDemandId(ip)).first()).toEqual({ n: 1 });
  });

  it("records a robotics recall under industrial_iot, the domain it stands for", async () => {
    const world = await freshWorld();
    const ip = freshIp();
    const answer = await world.recallUnsigned(query(uniqueDescription(), TRAP_ARGUMENTS, { domain: "robotics", tool: "move_robot" }), { ip });
    expect(answer.json).toEqual({ success: true, match: false });
    const rows = await env.DB.prepare("SELECT domain FROM domain_demand WHERE agent_key_hmac = ?1").bind(await networkDemandId(ip)).all<{ domain: string }>();
    expect(rows.results).toEqual([{ domain: "industrial_iot" }]);
    expect(world.analytics.points[0]!.blobs![1]).toBe("industrial_iot");
  });
  it("writes one recall_unsigned point, on its own index, with the miss reason and the caller label", async () => {
    const world = await freshWorld();
    // tool_unknown: the service holds no public lesson for this tool.
    await world.recallUnsigned(query(uniqueDescription(), TRAP_ARGUMENTS, { tool: "postgres_query" }));
    // client label: this package's User-Agent.
    await world.recallUnsigned(query(uniqueDescription(), TRAP_ARGUMENTS, { tool: "postgres_query" }), { headers: { "User-Agent": "achromat-mcp-server/0.1.5" } });
    expect(world.analytics.points).toEqual([
      { indexes: ["recall_unsigned"], blobs: ["recall_unsigned", DOMAIN, "postgres_query", "anonymous", "miss", "", "tool_unknown", "other"], doubles: [1] },
      { indexes: ["recall_unsigned"], blobs: ["recall_unsigned", DOMAIN, "postgres_query", "anonymous", "miss", "", "tool_unknown", "mcp-package"], doubles: [1] },
    ]);
    // A lookalike User-Agent is not the package, and nothing of the header is written.
    world.analytics.points.length = 0;
    await world.recallUnsigned(query(uniqueDescription(), TRAP_ARGUMENTS, { tool: "postgres_query" }), { headers: { "User-Agent": "evil achromat-mcp-server/9 SECRET-UA" } });
    expect(world.analytics.points[0]!.blobs![7]).toBe("other");
    expect(JSON.stringify(world.analytics.points)).not.toContain("SECRET-UA");
  });

  it("separates below_threshold from no_candidate for a tool that does have public lessons", async () => {
    const world = await freshWorld();
    const owner = await community();
    const { lessonId, description } = await approvedLesson(world, owner);
    world.analytics.points.length = 0;

    // A candidate came back but scored under the cutoff.
    world.store.scoreOverride.set(lessonId, 0.7);
    await world.recallUnsigned(query(`${description} soon`));
    // Nothing came back at all.
    world.store.records.clear();
    await world.recallUnsigned(query(`${description} later`));
    expect(world.analytics.points.map((point) => [point.blobs![4], point.blobs![6]])).toEqual([
      ["miss", "below_threshold"],
      ["miss", "no_candidate"],
    ]);
  });

  it("writes a hit with an empty reason, and a signed miss with its reason and label too", async () => {
    const world = await freshWorld();
    const owner = await community();
    const { description } = await approvedLesson(world, owner);
    world.analytics.points.length = 0;
    await world.recallUnsigned(query(description), { headers: { "User-Agent": "achromat-mcp-server/0.1.5" } });
    expect(world.analytics.points).toEqual([
      { indexes: ["recall_unsigned"], blobs: ["recall_unsigned", DOMAIN, TOOL, "anonymous", "hit", "", "", "mcp-package"], doubles: [1] },
    ]);
    world.analytics.points.length = 0;
    const { agent, key } = await community();
    await world.recall(agent, query(uniqueDescription(), TRAP_ARGUMENTS, { tool: "not_a_real_tool" }));
    const agentId = await (await import("../src/telemetry")).anonymiseAgentKey(key);
    expect(world.analytics.points).toEqual([
      { indexes: [agentId], blobs: ["recall", DOMAIN, "not_a_real_tool", agentId, "miss", "", "tool_unknown", "other"], doubles: [1] },
    ]);
  });

  it("carries a valid ?ref= and drops an invalid one", async () => {
    const world = await freshWorld();
    const send = (path: string) => world.sendUnsigned(path, query(uniqueDescription(), TRAP_ARGUMENTS, { tool: "postgres_query" }));
    await send("/api/v1/recall?ref=hf_discord");
    await send("/api/v1/recall?ref=Not%20A%20Slug!");
    expect(world.analytics.points.map((point) => point.blobs![5])).toEqual(["hf_discord", ""]);
  });

  it("still answers when the dataset write throws", async () => {
    const world = await freshWorld();
    world.analytics.fail = true;
    const { status, json } = await world.recallUnsigned(query(uniqueDescription()));
    expect(status).toBe(200);
    expect(json).toEqual({ success: true, match: false });
  });
});
