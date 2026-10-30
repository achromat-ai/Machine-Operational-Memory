/**
 * GET /api/v1/search: the public, unsigned natural-language search. Driven through the real app with fake Workers AI
 * and Vectorize (both run only against the real account). Lessons go through the real HTTP flow and review, then
 * reconcile publishes them to the fake index, exactly as in the recall tests.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SEARCH_LIMIT, SearchResponse } from "../src/schema";
import { SEARCH_MIN_SCORE, SEARCH_QUERY_MAX_CHARACTERS } from "../src/routes/search";
import { FIX_ARGUMENTS, TRAP_ARGUMENTS, community, humanReview, uniqueDescription } from "./fixtures/ledger";
import { freshWorld, type World } from "./fixtures/world";
import { ORIGIN, call, freshIp } from "./helpers";

const SEARCH = "/api/v1/search";
const MARKER = "TRAP-ONLY-MARKER";

async function get(world: World, query: Record<string, string> | string, init: { ip?: string | null; method?: string } = {}): Promise<Response> {
  const { ip = freshIp(), method = "GET" } = init;
  const qs = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const ctx = createExecutionContext();
  const request = new Request(`${ORIGIN}${SEARCH}?${qs}`, { method, headers: ip === null ? {} : { "CF-Connecting-IP": ip } });
  const response = await world.worker.fetch(request, world.env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** An approved lesson, published to the fake index. */
async function approvedLesson(world: World, owner: Awaited<ReturnType<typeof community>>, options: Parameters<World["createLesson"]>[1] = {}) {
  const lesson = await world.createLesson(owner.agent, options);
  await humanReview(lesson.lessonId, "approve");
  await world.reconcileAt();
  return lesson;
}

describe("GET /api/v1/search: results", () => {
  it("needs no signature and answers a strict, uncached JSON body with the security headers", async () => {
    const world = await freshWorld();
    const owner = await community();
    const lesson = await approvedLesson(world, owner);

    const response = await get(world, { domain: "fintech", q: lesson.description });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");

    const raw = await response.text();
    const body = SearchResponse.parse(JSON.parse(raw));
    const [first] = body.results;
    expect(first!.lesson).toMatchObject({
      lesson_id: lesson.lessonId,
      domain: "fintech",
      tool: "transfer_funds",
      compliant_arguments: FIX_ARGUMENTS,
    });
    expect(first!.score).toBeGreaterThanOrEqual(SEARCH_MIN_SCORE);

    // The upstream rule name is never served, only the statutory anchor.
    expect(first!.lesson).not.toHaveProperty("violation_rule");
    expect(raw).not.toContain("violation_rule");
    expect(raw).not.toContain("Dual authorisation for large transfers");
    expect(raw).not.toMatch(/Rule\s+\d/i);
  });

  it("asks Vectorize for the domain namespace and public lessons only, with no tool filter", async () => {
    const world = await freshWorld();
    await get(world, { domain: "fintech", q: "move client funds to the settlement account" });
    expect(world.embedder.calls).toHaveLength(1);
    expect(world.embedder.calls[0]![0]).toContain("move client funds to the settlement account");
    expect(world.store.queryCalls).toHaveLength(1);
    const { options } = world.store.queryCalls[0]!;
    expect(options.namespace).toBe("fintech");
    expect(options.topK).toBe(SEARCH_LIMIT);
    expect(options.filter).toEqual({ visibility: { $in: ["public"] } });
  });

  it("finds lessons of any tool in the domain, best match first", async () => {
    const world = await freshWorld();
    const owner = await community();
    const description = uniqueDescription("quarterly");
    const exact = await approvedLesson(world, owner, { description });
    const [record] = [...world.store.records.values()].filter((item) => item.id === exact.lessonId);
    // A second public lesson under a different tool name, and a weaker score for it.
    world.store.records.set("00000000-0000-4000-8000-000000000001", { ...record!, id: "00000000-0000-4000-8000-000000000001", metadata: { ...record!.metadata, tool_name: "other_tool" } });
    const body = SearchResponse.parse(await (await get(world, { domain: "fintech", q: description })).json());
    expect(body.results[0]!.lesson.lesson_id).toBe(exact.lessonId);
    expect(body.results.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps domains apart", async () => {
    const world = await freshWorld();
    const owner = await community();
    const lesson = await approvedLesson(world, owner);
    const body = SearchResponse.parse(await (await get(world, { domain: "devsecops", q: lesson.description })).json());
    expect(body.results).toEqual([]);
  });

  it("answers an empty list when nothing is close enough", async () => {
    const world = await freshWorld();
    const owner = await community();
    const lesson = await approvedLesson(world, owner);
    world.store.scoreOverride.set(lesson.lessonId, SEARCH_MIN_SCORE - 0.01);
    expect(await (await get(world, { domain: "fintech", q: lesson.description })).json()).toEqual({ success: true, results: [] });
  });

  it("never serves a pending lesson, even the caller's own", async () => {
    const world = await freshWorld();
    const owner = await community();
    const pending = await world.createLesson(owner.agent);
    const body = SearchResponse.parse(await (await get(world, { domain: "fintech", q: pending.description })).json());
    expect(body.results.map((item) => item.lesson.lesson_id)).not.toContain(pending.lessonId);
  });

  it("re-checks every hit in D1: a stale vector of a rejected or quarantined lesson is not served", async () => {
    const world = await freshWorld();
    const owner = await community();
    const rejected = await world.createLesson(owner.agent);
    const quarantined = await approvedLesson(world, owner);
    const staleVectors = [rejected, quarantined].map((lesson) => world.store.records.get(lesson.lessonId)!);
    await humanReview(rejected.lessonId, "reject", "low_quality");
    await humanReview(quarantined.lessonId, "quarantine", "needs_recheck");
    await world.reconcileAt();
    // Vectorize is eventually consistent: both vectors reappear in the index as public, as a lagging replica could show them.
    for (const record of staleVectors) world.store.records.set(record.id, { ...record, metadata: { ...record.metadata, visibility: "public" } });
    expect(world.store.records.size).toBe(2);

    for (const lesson of [rejected, quarantined]) {
      const body = SearchResponse.parse(await (await get(world, { domain: "fintech", q: lesson.description })).json());
      expect(body.results.map((item) => item.lesson.lesson_id)).not.toContain(lesson.lessonId);
    }
    // The index did offer them: only the D1 check kept them out.
    expect(world.store.queryCalls.length).toBeGreaterThan(0);
  });

  it("never serves the blocked call's values, receipts, attestations or who submitted a lesson", async () => {
    const world = await freshWorld();
    const owner = await community();
    const lesson = await approvedLesson(world, owner, { trapArguments: { ...TRAP_ARGUMENTS, memo: MARKER } });
    const text = await (await get(world, { domain: "fintech", q: lesson.description })).text();
    expect(text).toContain(lesson.lessonId);
    for (const leaked of [MARKER, "trap_arguments", "delta_json", "evaluated_input", "signature", "attestation", "receipt", owner.key, "task_description"]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it("counts the search by domain and never the question: one human_search point, no demand row", async () => {
    const world = await freshWorld();
    const question = "a question nobody has an answer to yet";
    world.analytics.points.length = 0;
    const demandBefore = (await env.DB.prepare("SELECT count(*) AS n FROM domain_demand").first<{ n: number }>())!.n;

    expect((await get(world, { domain: "fintech", q: question })).status).toBe(200);
    expect(world.analytics.points).toEqual([{ indexes: ["human_search"], blobs: ["human_search", "fintech", "", "anonymous", "miss"], doubles: [1] }]);
    expect(JSON.stringify(world.analytics.points)).not.toContain("nobody");
    expect((await env.DB.prepare("SELECT count(*) AS n FROM domain_demand").first<{ n: number }>())!.n).toBe(demandBefore);
  });

  it("records a hit when a lesson is returned, under its own domain", async () => {
    const world = await freshWorld();
    const owner = await community();
    const lesson = await approvedLesson(world, owner);
    world.analytics.points.length = 0;
    const body = SearchResponse.parse(await (await get(world, { domain: "fintech", q: lesson.description })).json());
    expect(body.results.length).toBeGreaterThan(0);
    expect(world.analytics.points).toEqual([{ indexes: ["human_search"], blobs: ["human_search", "fintech", "", "anonymous", "hit"], doubles: [1] }]);
  });

  it("writes nothing for a search that did not run: unknown domain, bad question, or a backend failure", async () => {
    const world = await freshWorld();
    world.analytics.points.length = 0;
    const invalid: Array<Record<string, string>> = [{ domain: "healthcare", q: "move funds to the account" }, { domain: "fintech", q: "ab" }, { domain: "fintech" }];
    for (const query of invalid) {
      expect((await get(world, query)).status).toBe(400);
    }
    world.store.failQuery = true;
    expect((await get(world, { domain: "fintech", q: "move funds to the account" })).status).toBe(503);
    world.store.failQuery = false;
    expect(world.analytics.points).toHaveLength(0);
  });

  it("answers the same when the telemetry dataset is unavailable", async () => {
    const world = await freshWorld();
    world.analytics.fail = true;
    const response = await get(world, { domain: "fintech", q: "move funds to the account" });
    expect(response.status).toBe(200);
    expect(SearchResponse.parse(await response.json()).results).toBeDefined();
    expect(world.analytics.points).toHaveLength(0);
  });
});

describe("GET /api/v1/search: validation", () => {
  async function rejected(query: Record<string, string> | string, code: string, status = 400) {
    const world = await freshWorld();
    const response = await get(world, query);
    expect(response.status, JSON.stringify(query)).toBe(status);
    expect(await response.json()).toMatchObject({ success: false, code });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(world.embedder.calls).toHaveLength(0);
    expect(world.store.queryCalls).toHaveLength(0);
  }

  it("rejects an unknown or missing domain without searching", async () => {
    await rejected({ domain: "healthcare", q: "move funds to the account" }, "DOMAIN_UNKNOWN");
    await rejected({ domain: "Fintech", q: "move funds to the account" }, "DOMAIN_UNKNOWN");
    await rejected({ q: "move funds to the account" }, "DOMAIN_UNKNOWN");
  });

  it("rejects a missing, short, long or control-character question without searching", async () => {
    await rejected({ domain: "fintech" }, "INVALID_REQUEST");
    await rejected({ domain: "fintech", q: "  a  " }, "INVALID_REQUEST");
    await rejected({ domain: "fintech", q: "x".repeat(SEARCH_QUERY_MAX_CHARACTERS + 1) }, "INVALID_REQUEST");
    await rejected({ domain: "fintech", q: "wire\u0007transfer" }, "INVALID_REQUEST");
  });

  it("rejects unknown and repeated parameters, so no filter can be smuggled in", async () => {
    await rejected({ domain: "fintech", q: "move funds to the account", tool: "transfer_funds" }, "INVALID_REQUEST");
    await rejected({ domain: "fintech", q: "move funds to the account", top_k: "50" }, "INVALID_REQUEST");
    await rejected("domain=fintech&q=move+funds&q=to+the+account", "INVALID_REQUEST");
    await rejected("domain=fintech&domain=devsecops&q=move+funds", "INVALID_REQUEST");
  });

  it("accepts a question at the length limits", async () => {
    const world = await freshWorld();
    for (const q of ["abc", "x".repeat(SEARCH_QUERY_MAX_CHARACTERS)]) expect((await get(world, { domain: "fintech", q })).status).toBe(200);
  });

  it("answers 503 when embedding or Vectorize is down", async () => {
    const world = await freshWorld();
    world.embedder.fail = () => true;
    expect(await (await get(world, { domain: "fintech", q: "move funds to the account" })).json()).toMatchObject({ code: "SEARCH_UNAVAILABLE" });
    world.embedder.fail = null;
    world.store.failQuery = true;
    const response = await get(world, { domain: "fintech", q: "move funds to the account" });
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /api/v1/search: access and limits", () => {
  it("is the only unsigned way in: other methods and sub-paths still need a signature", async () => {
    const world = await freshWorld();
    for (const [method, path] of [["POST", SEARCH], ["PUT", SEARCH], ["GET", `${SEARCH}/extra`]] as const) {
      const response = await world.worker.fetch(new Request(ORIGIN + path, { method, headers: { "CF-Connecting-IP": freshIp() } }), world.env, createExecutionContext());
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("is mounted in the deployed entry point (it answers before any signature check)", async () => {
    const response = await call(`${SEARCH}?domain=fintech&q=ab`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("allows 30 searches a minute per network, then answers 429 with Retry-After and no searching", async () => {
    const world = await freshWorld();
    const ip = freshIp();
    // Invalid questions cost nothing to answer but still spend the network's allowance.
    for (let i = 0; i < 30; i++) expect((await get(world, { domain: "fintech", q: "ab" }, { ip })).status, `request ${i + 1}`).toBe(400);

    const limited = await get(world, { domain: "fintech", q: "move client funds to the settlement account" }, { ip });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ success: false, code: "RATE_LIMITED" });
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect(world.embedder.calls).toHaveLength(0);
    expect(world.analytics.points).toHaveLength(0);

    // Another /24 is unaffected; another address in the same /24 shares the spent bucket.
    expect((await get(world, { domain: "fintech", q: "ab" }, { ip: freshIp() })).status).toBe(400);
    expect((await get(world, { domain: "fintech", q: "ab" }, { ip: ip.replace(/\.\d+$/, ".99") })).status).toBe(429);
  });

  it("fails closed without a client address", async () => {
    const world = await freshWorld();
    const response = await get(world, { domain: "fintech", q: "move client funds to the account" }, { ip: null });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CLIENT_IP_UNAVAILABLE" });
    expect(world.embedder.calls).toHaveLength(0);
  });
});
