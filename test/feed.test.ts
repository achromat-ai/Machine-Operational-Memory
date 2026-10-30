/**
 * GET /api/v1/feed: the public, unsigned feed of approved lessons. Driven through the real app with the
 * edge cache off (D1 is shared by every case in this file), except for the one case that tests the cache.
 * Lessons are written straight into the ledger and moved through triage and review the way production does.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processLesson } from "../src/review/pipeline";
import { FEED_CACHE_VERSION } from "../src/routes/feed";
import { FEED_LIMIT, FeedLessonResponse, FeedResponse } from "../src/schema";
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

  it("never serves the upstream rule name or number, only the statutory anchor", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const owner = await community();
    const pair = await approvedLesson(world, owner.key);
    // The rule is still stored for admins, so a leak here would be a mapping bug and not missing data.
    const stored = await env.DB.prepare("SELECT violation_rule FROM lessons WHERE lesson_id = ?1").bind(pair.lessonId).first<{ violation_rule: string }>();
    expect(stored?.violation_rule).toBe("Dual authorisation for large transfers");

    const text = await (await getFeed(world)).text();
    expect(text).toContain("FCA SYSC 6.1.1");
    expect(text).not.toContain("violation_rule");
    expect(text).not.toContain(stored!.violation_rule);
    expect(text).not.toMatch(/Rule\s+\d/i);
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
    const cacheKey = new Request(`${ORIGIN}${FEED}?v=${FEED_CACHE_VERSION}`);
    await caches.default.delete(cacheKey);
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
    await caches.default.delete(cacheKey);
  });

  it("never reads a copy cached under the old shape: the key is versioned", async () => {
    const world = await freshWorld({ feedCacheSeconds: 30 });
    const oldKey = new Request(ORIGIN + FEED);
    const newKey = new Request(`${ORIGIN}${FEED}?v=${FEED_CACHE_VERSION}`);
    await caches.default.delete(newKey);
    const owner = await community();
    const pair = await approvedLesson(world, owner.key);
    // A pre-redaction body, as an edge node would still hold it right after a deploy.
    const stale = JSON.stringify({ success: true, lessons: [{ lesson_id: pair.lessonId, violation_rule: "Regulation J: Rule 4" }] });
    await caches.default.put(oldKey, new Response(stale, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } }));

    const text = await (await getFeed(world)).text();
    expect(text).toContain(pair.lessonId);
    expect(text).not.toContain("violation_rule");
    expect(text).not.toContain("Rule 4");
    await caches.default.delete(oldKey);
    await caches.default.delete(newKey);
  });
});

describe("GET /api/v1/feed/<lesson_id>", () => {
  const lessonUrl = (id: string, query = "") => `${FEED}/${id}${query}`;
  async function get(world: World, id: string, init: { ip?: string | null; method?: string; query?: string } = {}): Promise<Response> {
    const { ip = freshIp(), method = "GET", query = "" } = init;
    const ctx = createExecutionContext();
    const request = new Request(ORIGIN + lessonUrl(id, query), { method, headers: ip === null ? {} : { "CF-Connecting-IP": ip } });
    const response = await world.worker.fetch(request, world.env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("serves an approved lesson by id with no signature, in the feed's shape, uncached", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const owner = await community();
    const pair = await approvedLesson(world, owner.key);

    const response = await get(world, pair.lessonId);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");

    const body = FeedLessonResponse.parse(await response.json());
    const listed = (await feedLessons(world)).find((item) => item.lesson_id === pair.lessonId)!;
    expect(body.lesson).toEqual(listed); // exactly what the feed serves for it
    expect(body.lesson).toMatchObject({ lesson_id: pair.lessonId, domain: "fintech", tool: "transfer_funds", statutory_anchor: "FCA SYSC 6.1.1" });
  });

  it("still serves a lesson that has dropped out of the newest 20 (the reason this route exists)", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const created: string[] = [];
    let owner = await community();
    for (let i = 0; i < FEED_LIMIT + 1; i++) {
      if (i % 5 === 0) owner = await community();
      created.push((await approvedLesson(world, owner.key)).lessonId);
    }
    const oldest = created[0]!;
    expect((await feedLessons(world)).map((item) => item.lesson_id)).not.toContain(oldest);

    const response = await get(world, oldest);
    expect(response.status).toBe(200);
    expect(FeedLessonResponse.parse(await response.json()).lesson.lesson_id).toBe(oldest);
  }, 60_000);

  it("answers the same 404 for an unknown id and for every lesson that is not approved, so it cannot probe for private lessons", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const owner = await community();
    const waiting = await pendingLesson(world, owner.key);
    const rejected = await pendingLesson(world, owner.key);
    await humanReview(rejected.lessonId, "reject", "low_quality");
    const quarantined = await approvedLesson(world, owner.key);
    expect((await get(world, quarantined.lessonId)).status).toBe(200);
    await humanReview(quarantined.lessonId, "quarantine", "needs_recheck");
    const untriaged = await insertPair({ ownerKey: owner.key, kind: "community" });

    const bodies = new Set<string>();
    for (const id of [waiting.lessonId, rejected.lessonId, quarantined.lessonId, untriaged.lessonId, uuid()]) {
      const response = await get(world, id);
      expect(response.status, id).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      bodies.add(JSON.stringify(await response.json()));
    }
    expect([...bodies]).toEqual([JSON.stringify({ success: false, error: "lesson is not public", code: "LESSON_NOT_FOUND" })]);
  });

  it("accepts an upper-case id, and answers HEAD", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const pair = await approvedLesson(world, (await community()).key);
    expect((await get(world, pair.lessonId.toUpperCase())).status).toBe(200);
    expect((await get(world, pair.lessonId, { method: "HEAD" })).status).toBe(200);
  });

  it("opens only this shape: other methods, other ids and deeper paths still need a signature", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const id = uuid();
    for (const [method, path] of [
      ["POST", lessonUrl(id)],
      ["PUT", lessonUrl(id)],
      ["DELETE", lessonUrl(id)],
      ["GET", lessonUrl("not-a-uuid")],
      ["GET", `${lessonUrl(id)}/extra`],
      ["GET", `${lessonUrl(id)}/`],
      ["GET", lessonUrl(`${id}0`)],
      ["GET", `${FEED}/${id.slice(0, 35)}`],
    ] as const) {
      const response = await world.worker.fetch(new Request(ORIGIN + path, { method, headers: { "CF-Connecting-IP": freshIp() } }), world.env, createExecutionContext());
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("never serves the blocked call's values, receipts, attestations or who submitted the lesson", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const owner = await community();
    const pair = await approvedLesson(world, owner.key);
    const text = await (await get(world, pair.lessonId)).text();
    expect(text).toContain(pair.lessonId);
    for (const leaked of [MARKER, "trap_arguments", "delta_json", "evaluated_input", "signature", "attestation", "receipt", owner.key, "task_description", "violation_rule", "Dual authorisation for large transfers"]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it("shares the feed's 60-a-minute allowance per network and answers 429 with Retry-After", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const ip = freshIp();
    for (let i = 0; i < 60; i++) expect((await get(world, uuid(), { ip })).status, `request ${i + 1}`).toBe(404);
    const limited = await get(world, uuid(), { ip });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await get(world, uuid(), { ip: null })).toHaveProperty("status", 400);
  });

  describe("lesson_view telemetry", () => {
    it("writes one point when the link carries a ref: the lesson's domain and tool, hit, the ref and the id", async () => {
      const world = await freshWorld({ feedCacheSeconds: 0 });
      const pair = await approvedLesson(world, (await community()).key);
      world.analytics.points.length = 0;
      expect((await get(world, pair.lessonId, { query: "?ref=Audit" })).status).toBe(200);
      expect(world.analytics.points).toEqual([
        { indexes: ["lesson_view"], blobs: ["lesson_view", "fintech", "transfer_funds", "anonymous", "hit", "audit", pair.lessonId], doubles: [1] },
      ]);
    });

    it("writes a miss, with the id, for a link to a lesson that is not public", async () => {
      const world = await freshWorld({ feedCacheSeconds: 0 });
      const waiting = await pendingLesson(world, (await community()).key);
      world.analytics.points.length = 0;
      expect((await get(world, waiting.lessonId, { query: "?ref=audit" })).status).toBe(404);
      expect(world.analytics.points).toEqual([
        { indexes: ["lesson_view"], blobs: ["lesson_view", "", "", "anonymous", "miss", "audit", waiting.lessonId], doubles: [1] },
      ]);
    });

    it("writes nothing without a valid ref, whatever the outcome", async () => {
      const world = await freshWorld({ feedCacheSeconds: 0 });
      const pair = await approvedLesson(world, (await community()).key);
      world.analytics.points.length = 0;
      for (const query of ["", "?ref=", "?ref=NOT%20A%20SLUG", "?ref=a&ref=b", "?other=1"]) {
        expect((await get(world, pair.lessonId, { query })).status, query).toBe(200);
        expect((await get(world, uuid(), { query })).status, query).toBe(404);
      }
      expect(world.analytics.points).toHaveLength(0);
    });

    it("answers the same when the dataset is unavailable", async () => {
      const world = await freshWorld({ feedCacheSeconds: 0 });
      const pair = await approvedLesson(world, (await community()).key);
      world.analytics.fail = true;
      expect((await get(world, pair.lessonId, { query: "?ref=audit" })).status).toBe(200);
      expect((await get(world, uuid(), { query: "?ref=audit" })).status).toBe(404);
      expect(world.analytics.points).toHaveLength(0);
    });
  });
});
