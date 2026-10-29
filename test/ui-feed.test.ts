/**
 * The public feed client (ui/src/lib/feed.ts): response parsing, error wording, the state machine and the
 * load itself. The end-to-end case reads the real Worker with a plain fetch (no identity, no signatures).
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processLesson } from "../src/review/pipeline";
import {
  FEED_PATH,
  FeedError,
  describeFeedFailure,
  feedReducer,
  initialFeedState,
  loadFeed,
  parseFeedResponse,
  type FeedLessonView,
  type FeedState,
} from "../ui/src/lib/feed";
import { FIX_ARGUMENTS, TRAP_ARGUMENTS, community, humanReview, insertPair } from "./fixtures/ledger";
import { freshWorld } from "./fixtures/world";
import { call, freshIp } from "./helpers";

const WIRE = {
  lesson_id: "11111111-1111-4111-8111-111111111111",
  domain: "fintech",
  tool: "transfer_funds",
  steering_directive: "Add a second approver.",
  statutory_anchor: null,
  compliant_arguments: FIX_ARGUMENTS,
  changed_paths: ["/approval/second_approver"],
  display_title: null,
  display_summary: "Large transfers need two people.",
  featured: true,
  updated_at: "2026-10-10T12:00:00.000Z", // still sent by the server; the page neither needs nor keeps it
};

const VIEW: FeedLessonView = {
  lessonId: WIRE.lesson_id,
  domain: "fintech",
  tool: "transfer_funds",
  steeringDirective: "Add a second approver.",
  statutoryAnchor: null,
  compliantArguments: FIX_ARGUMENTS,
  changedPaths: ["/approval/second_approver"],
  displayTitle: null,
  displaySummary: "Large transfers need two people.",
  featured: true,
};

const body = (lessons: unknown[]) => ({ success: true, lessons });
const reply = (status: number, payload: unknown) => async () => new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });

describe("parseFeedResponse", () => {
  it("reads the documented shape", () => {
    expect(parseFeedResponse(body([WIRE]))).toEqual([VIEW]);
    expect(parseFeedResponse(body([]))).toEqual([]);
  });

  it("rejects anything else, including one bad lesson among good ones", () => {
    const bad: unknown[] = [
      null,
      "text",
      [],
      { success: false, lessons: [] },
      { success: true },
      { success: true, lessons: "no" },
      body([null]),
      body([{ ...WIRE, lesson_id: 7 }]),
      body([{ ...WIRE, compliant_arguments: [] }]),
      body([{ ...WIRE, changed_paths: [1] }]),
      body([{ ...WIRE, featured: "yes" }]),
      body([{ ...WIRE, steering_directive: undefined }]),
    ];
    for (const value of bad) expect(parseFeedResponse(value), JSON.stringify(value)).toBeNull();
  });

  it("ignores fields it does not know, so a newer server does not break an older page", () => {
    expect(parseFeedResponse(body([{ ...WIRE, something_new: 1 }]))).toEqual([VIEW]);
  });

  it("does not need updated_at: a missing, null, malformed or odd one neither fails the parse nor is kept", () => {
    const { updated_at: _omitted, ...withoutDate } = WIRE;
    for (const lesson of [withoutDate, { ...WIRE, updated_at: null }, { ...WIRE, updated_at: 12345 }, { ...WIRE, updated_at: "not a date" }, { ...WIRE, updated_at: { nested: true } }]) {
      const parsed = parseFeedResponse(body([lesson]));
      expect(parsed, JSON.stringify(lesson)).toEqual([VIEW]);
      expect(parsed![0]).not.toHaveProperty("updatedAt");
    }
  });

  it("does not need violation_rule and drops it if a cached answer from an older server still carries it", () => {
    const parsed = parseFeedResponse(body([{ ...WIRE, violation_rule: "Regulation J: Rule 4" }]));
    expect(parsed).toEqual([VIEW]);
    expect(JSON.stringify(parsed)).not.toMatch(/Rule 4|violationRule|violation_rule/);
  });
});

describe("loadFeed", () => {
  it("asks for the feed path with a plain, credential-free GET", async () => {
    let seen: { input: string; init?: RequestInit } | undefined;
    const lessons = await loadFeed(async (input, init) => {
      seen = { input, ...(init ? { init } : {}) };
      return new Response(JSON.stringify(body([WIRE])), { status: 200 });
    });
    expect(lessons).toEqual([VIEW]);
    expect(seen!.input).toBe(FEED_PATH);
    expect(seen!.init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
    expect(Object.keys(seen!.init!.headers as Record<string, string>)).toEqual(["Accept"]);
  });

  it("throws FeedError with the status for a failed answer or an unreadable one", async () => {
    await expect(loadFeed(reply(429, { success: false }))).rejects.toMatchObject({ name: "FeedError", status: 429 });
    await expect(loadFeed(reply(503, "down"))).rejects.toMatchObject({ status: 503 });
    await expect(loadFeed(reply(200, "not json"))).rejects.toMatchObject({ status: 200 });
    await expect(loadFeed(reply(200, { success: true, lessons: [{}] }))).rejects.toMatchObject({ status: 200 });
  });

  it("reads the real Worker without any identity, and returns only approved lessons", async () => {
    const world = await freshWorld({ feedCacheSeconds: 0 });
    const owner = await community();
    const make = async () => {
      const pair = await insertPair({ ownerKey: owner.key, kind: "community", trapArguments: TRAP_ARGUMENTS, fixArguments: FIX_ARGUMENTS });
      await processLesson(env, world.deps, pair.lessonId);
      return pair;
    };
    const approved = await make();
    await humanReview(approved.lessonId, "approve");
    const waiting = await make();

    const ip = freshIp();
    // workerd's Request refuses redirect: "error", which browsers accept, so only method and headers are passed on.
    const lessons = await loadFeed((input, init) => call(input, { ...(init?.method ? { method: init.method } : {}), ...(init?.headers ? { headers: init.headers } : {}), ip }));
    const ids = lessons.map((lesson) => lesson.lessonId);
    expect(ids).toContain(approved.lessonId);
    expect(ids).not.toContain(waiting.lessonId);
    const mine = lessons.find((lesson) => lesson.lessonId === approved.lessonId)!;
    expect(mine.compliantArguments).toEqual(FIX_ARGUMENTS);
    expect(mine.changedPaths).toContain("/approval/second_approver");
  });
});

describe("describeFeedFailure", () => {
  it("speaks plainly and leaks no codes", () => {
    expect(describeFeedFailure(new FeedError(429, "x"))).toContain("too often");
    expect(describeFeedFailure(new FeedError(503, "x"))).toContain("temporarily unavailable");
    expect(describeFeedFailure(new FeedError(500, "x"))).toContain("temporarily unavailable");
    expect(describeFeedFailure(new FeedError(200, "x"))).toContain("cannot read");
    expect(describeFeedFailure(new FeedError(404, "x"))).toContain("could not be loaded");
    expect(describeFeedFailure(new TypeError("Failed to fetch"))).toContain("could not be reached");
    for (const error of [new FeedError(429, "secret detail"), new TypeError("secret detail")]) expect(describeFeedFailure(error)).not.toContain("secret");
  });
});

describe("feedReducer", () => {
  const ready: FeedState = { phase: "ready", lessons: [VIEW], refreshing: false, error: null, stale: false };

  it("starts in the loading state", () => {
    expect(initialFeedState).toMatchObject({ phase: "loading", lessons: [], refreshing: false });
  });

  it("shows lessons on success, and an empty list is a ready state", () => {
    expect(feedReducer(initialFeedState, { type: "success", lessons: [VIEW] })).toEqual(ready);
    expect(feedReducer(initialFeedState, { type: "success", lessons: [] })).toMatchObject({ phase: "ready", lessons: [] });
  });

  it("keeps lessons on screen while refreshing, and does not fall back to a skeleton", () => {
    expect(feedReducer(ready, { type: "start" })).toEqual({ ...ready, refreshing: true });
  });

  it("turns a failed first load into the error state, and a retry back into loading", () => {
    const failed = feedReducer(initialFeedState, { type: "failure", message: "down" });
    expect(failed).toEqual({ phase: "error", lessons: [], refreshing: false, error: "down", stale: false });
    expect(feedReducer(failed, { type: "start" })).toEqual(initialFeedState);
  });

  it("keeps old lessons and flags them as possibly out of date when a refresh fails, then clears it on success", () => {
    const stale = feedReducer(feedReducer(ready, { type: "start" }), { type: "failure", message: "down" });
    expect(stale).toEqual({ phase: "ready", lessons: [VIEW], refreshing: false, error: "down", stale: true });
    expect(feedReducer(stale, { type: "success", lessons: [VIEW] })).toEqual(ready);
  });
});

describe("the public feed carries no dates", () => {
  it("has no date formatting helper left", async () => {
    const feedModule = await import("../ui/src/lib/feed");
    expect(feedModule).not.toHaveProperty("relativeTime");
  });
});
