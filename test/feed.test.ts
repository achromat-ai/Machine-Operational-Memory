/**
 * GET /api/v1/feed: the public, unsigned feed of approved lessons. Driven through the real app with the
 * edge cache off (D1 is shared by every case in this file), except for the one case that tests the cache.
 * Lessons are written straight into the ledger and moved through triage and review the way production does.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processLesson } from "../src/review/pipeline";
import { FEED_LIMIT, FeedResponse } from "../src/schema";
import { FIX_ARGUMENTS, TRAP_ARGUMENTS, community, humanReview, insertPair, lessonState, uuid } from "./fixtures/ledger";
import { freshWorld, type World } from "./fixtures/world";
import { ORIGIN, call, freshIp } from "./helpers";

const FEED = "/api/v1/feed";
const MARKER = "TRAP-ONLY-MARKER";

async function getFeed(world: World, init: { ip?: string | null; method?: string; path?: string } = {}): Promise<Response> {
  const { ip = freshIp(), method = "GET", path = FEED } = init;
  const ctx = createExecutionContext();
  const request = new Request(ORIGIN + path, { method, headers: ip === null ? {} : { "CF-Connecting-IP": ip } });
  const response = await world.worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function feedLessons(world: World): Promise<FeedResponse["lessons"]> {
  const response = await getFeed(world);
  expect(response.status).toBe(200);
  return FeedResponse.parse(await response.json()).lessons;
}

/** A lesson that has been through triage and is waiting for a reviewer. The blocked call carries a marker. */
async function pendingLesson(world: World, ownerKey: string, over: Partial<Parameters<typeof insertPair>[0]> = {}) {
  const pair = await insertPair({
    ownerKey,
    kind: "community",
    trapArguments: { ...TRAP_ARGUMENTS, memo: MARKER },
    fixArguments: FIX_ARGUMENTS,
    ...over,
  });
  await processLesson(env, world.deps, pair.lessonId);
  expect((await lessonState(pair.lessonId))!.review_status).toBe("pending_review");
  return pair;
}

/** Each approval gets its own millisecond, so updated_at_ms gives a strict order. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

async function approvedLesson(world: World, ownerKey: string) {
  await tick();
  const pair = await pendingLesson(world, ownerKey);
  await humanReview(pair.lessonId, "approve");
  return pair;
}

describe("GET /api/v1/feed", () => {
  // First on purpose: D1 is shared by the cases below, and nothing has been approved yet.
  it("answers an empty feed with an empty list", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const response = await getFeed(world);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, lessons: [] });
  });

  it("needs no signature and answers with a strict, cacheable JSON body and the security headers", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const owner = await community();
    const pair = await approvedLesson(world, owner.key);

    const response = await getFeed(world);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const body = FeedResponse.parse(await response.json());
    const lesson = body.lessons.find((item) => item.lesson_id === pair.lessonId)!;
    expect(lesson).toEqual({
      lesson_id: pair.lessonId,
      domain: "fintech",
      tool: "transfer_funds",
      violation_rule: "Dual authorisation for large transfers",
      steering_directive: "Add a second approver before moving the funds.",
      statutory_anchor: "FCA SYSC 6.1.1",
      compliant_arguments: FIX_ARGUMENTS,
      changed_paths: expect.arrayContaining(["/approval/second_approver"]),
      display_title: null,
      display_summary: null,
      featured: false,
      updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("also answers HEAD, and does not answer other methods or sub-paths without a signature", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    expect((await getFeed(world, { method: "HEAD" })).status).toBe(200);
    for (const [method, path] of [["POST", FEED], ["PUT", FEED], ["GET", `${FEED}/extra`]] as const) {
      const response = await getFeed(world, { method, path });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("never serves the blocked call's values, receipts, attestations or who submitted a lesson", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const owner = await community();
    const pair = await approvedLesson(world, owner.key);
    const response = await getFeed(world);
    const text = await response.text();

    expect(text).toContain(pair.lessonId);
    for (const leaked of [MARKER, "trap_arguments", "delta_json", "evaluated_input", "signature", "attestation", "receipt", owner.key, "task_description"]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it("lists only approved lessons: pending, rejected and quarantined ones are left out", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const owner = await community();
    const approved = await approvedLesson(world, owner.key);
    const waiting = await pendingLesson(world, owner.key);
    const rejected = await pendingLesson(world, owner.key);
    await humanReview(rejected.lessonId, "reject", "low_quality");
    const quarantined = await approvedLesson(world, owner.key);
    expect((await feedLessons(world)).map((item) => item.lesson_id)).toContain(quarantined.lessonId);
    await humanReview(quarantined.lessonId, "quarantine", "needs_recheck");
    const untriaged = await insertPair({ ownerKey: owner.key, kind: "community" });

    const ids = (await feedLessons(world)).map((item) => item.lesson_id);
    expect(ids).toContain(approved.lessonId);
    for (const hidden of [waiting, rejected, quarantined, untriaged]) expect(ids, hidden.lessonId).not.toContain(hidden.lessonId);
  });

  it("returns the most recently updated first, and at most 20", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const created: string[] = [];
    let owner = await community();
    for (let i = 0; i < FEED_LIMIT + 1; i++) {
      // Triage quarantines a key's sixth lesson in an hour (burst check), so every fifth lesson gets a new key.
      if (i % 5 === 0) owner = await community();
      created.push((await approvedLesson(world, owner.key)).lessonId);
    }

    const lessons = await feedLessons(world);
    expect(lessons).toHaveLength(FEED_LIMIT);
    // The newest 20 of the 21 just approved, newest first; the first one approved has dropped off.
    expect(lessons.map((item) => item.lesson_id)).toEqual(created.slice(1).reverse());
    const times = lessons.map((item) => Date.parse(item.updated_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  }, 60_000);

  it("shows editorial titles and the featured flag, and moves an edited lesson to the top", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const owner = await community();
    const older = await approvedLesson(world, owner.key);
    const newer = await approvedLesson(world, owner.key);
    expect((await feedLessons(world))[0]!.lesson_id).toBe(newer.lessonId);

    await tick();
    await env.DB.prepare(
      `INSERT INTO review_events (event_id, lesson_id, actor_type, actor_id, action, reason_code, details_json, at_ms)
       VALUES (?1, ?2, 'human', 'test-reviewer', 'set_editorial', NULL, ?3, ?4)`,
    )
      .bind(uuid(), older.lessonId, JSON.stringify({ display_title: "Second approver on big transfers", display_summary: "Large transfers need two people." }), Date.now())
      .run();
    await tick();
    await env.DB.prepare(
      `INSERT INTO review_events (event_id, lesson_id, actor_type, actor_id, action, reason_code, details_json, at_ms)
       VALUES (?1, ?2, 'human', 'test-reviewer', 'feature', NULL, NULL, ?3)`,
    )
      .bind(uuid(), older.lessonId, Date.now())
      .run();

    const [first] = await feedLessons(world);
    expect(first).toMatchObject({
      lesson_id: older.lessonId,
      display_title: "Second approver on big transfers",
      display_summary: "Large transfers need two people.",
      featured: true,
    });
  });

});

describe("GET /api/v1/feed: limits", () => {
  it("allows 60 requests a minute per network, then answers 429 with Retry-After and no caching", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const ip = freshIp();
    for (let i = 0; i < 60; i++) expect((await getFeed(world, { ip })).status, `request ${i + 1}`).toBe(200);

    const limited = await getFeed(world, { ip });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ success: false, code: "RATE_LIMITED" });
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(limited.headers.get("Cache-Control")).toBe("no-store");

    // Another /24 is unaffected; so is another address in the same /24 only until the shared bucket is spent.
    expect((await getFeed(world, { ip: freshIp() })).status).toBe(200);
    const sameNetwork = ip.replace(/\.\d+$/, ".99");
    expect((await getFeed(world, { ip: sameNetwork })).status).toBe(429);
  }, 60_000);

  it("fails closed without a client address", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const response = await getFeed(world, { ip: null });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CLIENT_IP_UNAVAILABLE" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("goes through the deployed entry point too (the route is mounted in the real Worker)", async () => {
    const response = await call(FEED);
    expect(response.status).toBe(200);
    FeedResponse.parse(await response.json());
  });
});

describe("GET /api/v1/feed: edge cache", () => {
  it("serves one cached copy for the cache lifetime, whatever the query string", async () => {
    const world = await freshWorld({ feedCacheSeconds: 30 });
    // An earlier case may have cached a copy through the deployed entry point; start from none.
    await caches.default.delete(new Request(ORIGIN + FEED));
    const owner = await community();
    const first = await approvedLesson(world, owner.key);

    const before = FeedResponse.parse(await (await getFeed(world)).json());
    expect(before.lessons.map((item) => item.lesson_id)).toContain(first.lessonId);

    const second = await approvedLesson(world, owner.key);
    const cached = await getFeed(world, { path: `${FEED}?x=1` });
    const after = FeedResponse.parse(await cached.json());
    expect(cached.headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(after.lessons.map((item) => item.lesson_id)).not.toContain(second.lessonId);
    expect(after).toEqual(before);
  });
});
