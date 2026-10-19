/**
 * The review console's logic (ui/src/lib: router, queue, adminApi, adminSession). The session and the
 * queue calls run against the real Worker: real admin keys in D1, real lessons, the real review triggers.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processLesson } from "../src/review/pipeline";
import { decodeBase64url, toHex } from "../src/schema";
import {
  AdminApiError,
  REVIEW_REASONS,
  agentKeyHex,
  buildReviewPayload,
  describeReviewFailure,
  fetchPending,
  isOwnLesson,
  parsePendingPage,
  pendingPath,
  submitReview,
  type PendingLesson,
} from "../ui/src/lib/adminApi";
import { AdminAuthError, AdminLockedError, createAdminSession, type AdminSessionDeps } from "../ui/src/lib/adminSession";
import { ServerClock } from "../ui/src/lib/clock";
import { buildDeltaRows, splitRows } from "../ui/src/lib/delta";
import { PemError } from "../ui/src/lib/pem";
import { initialQueueState, queueReducer } from "../ui/src/lib/queue";
import { resolveRoute } from "../ui/src/lib/router";
import { FIX_ARGUMENTS, TRAP_ARGUMENTS, agentEvent, community, insertPair, provisionAgent } from "./fixtures/ledger";
import { HOST, workerEdge, type EdgeOptions } from "./fixtures/ui-env";
import { freshWorld } from "./fixtures/world";
import type { TestAgent } from "./helpers";

async function pemOf(agent: TestAgent): Promise<string> {
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", agent.keys.privateKey)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
}

/** Timers that only run when a test says so. */
function manualTimers() {
  const scheduled: Array<{ callback: () => void; ms: number; cleared: boolean; fired: boolean }> = [];
  const deps: NonNullable<AdminSessionDeps["timers"]> = {
    set: (callback, ms) => {
      const timer = { callback, ms, cleared: false, fired: false };
      scheduled.push(timer);
      return timer;
    },
    clear: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  return {
    deps,
    scheduled,
    live: () => scheduled.filter((timer) => !timer.cleared && !timer.fired),
    fire() {
      const timer = this.live().at(-1);
      if (!timer) throw new Error("no timer is armed");
      timer.fired = true;
      timer.callback();
    },
  };
}

function makeSession(options: EdgeOptions = {}) {
  const edge = workerEdge(options);
  const timers = manualTimers();
  const session = createAdminSession({ fetch: edge.fetch, clock: new ServerClock(), host: () => HOST, idleMs: 600_000, timers: timers.deps });
  return { session, edge, timers };
}

async function unlockedSession(options: EdgeOptions = {}) {
  const admin = await provisionAgent("admin");
  const made = makeSession(options);
  await made.session.unlock(await pemOf(admin.agent));
  return { ...made, admin };
}

const fetcher = (session: { signedFetch: (path: string, options?: RequestInit) => Promise<Response> }) => (path: string, options?: RequestInit) => session.signedFetch(path, options);

// ════════════════════════════════════════════════════════════════════════
// Router
// ════════════════════════════════════════════════════════════════════════

describe("resolveRoute", () => {
  it("serves the search at / and the console at /admin/review, nothing else", () => {
    expect(resolveRoute("/")).toEqual({ name: "home" });
    expect(resolveRoute("")).toEqual({ name: "home" });
    expect(resolveRoute("/admin/review")).toEqual({ name: "review" });
    expect(resolveRoute("/admin/review/")).toEqual({ name: "review" });
    expect(resolveRoute("/admin/review///")).toEqual({ name: "review" });
  });

  it("is exact and case-sensitive; everything else is not found, with the path kept", () => {
    for (const path of ["/admin", "/admin/", "/Admin/Review", "/admin/review/extra", "/admin/reviews", "/review", "/index.html", "//", "/api/v1/health"]) {
      const route = resolveRoute(path);
      expect(route.name, path).toBe(path === "//" ? "home" : "not-found");
    }
    expect(resolveRoute("/nope")).toEqual({ name: "not-found", path: "/nope" });
  });
});

// ════════════════════════════════════════════════════════════════════════
// Queue state
// ════════════════════════════════════════════════════════════════════════

describe("queueReducer", () => {
  const lesson = (id: string) => ({ lessonId: id }) as PendingLesson;

  it("loads a page, appends the next without duplicates, and tracks the cursor", () => {
    let state = queueReducer(initialQueueState, { type: "load-start" });
    expect(state).toMatchObject({ loading: true, loaded: false });
    state = queueReducer(state, { type: "load-success", lessons: [lesson("a"), lesson("b")], nextCursor: "c1", append: false });
    expect(state).toMatchObject({ loading: false, loaded: true, nextCursor: "c1" });
    state = queueReducer(state, { type: "load-success", lessons: [lesson("b"), lesson("c")], nextCursor: null, append: true });
    expect(state.lessons.map((l) => l.lessonId)).toEqual(["a", "b", "c"]);
    expect(state.nextCursor).toBeNull();
    state = queueReducer(state, { type: "load-success", lessons: [lesson("z")], nextCursor: null, append: false });
    expect(state.lessons.map((l) => l.lessonId)).toEqual(["z"]);
  });

  it("switching the queue starts clean, and re-selecting the same one changes nothing", () => {
    const loaded = queueReducer(initialQueueState, { type: "load-success", lessons: [lesson("a")], nextCursor: "x", append: false });
    expect(queueReducer(loaded, { type: "select-status", status: "pending_review" })).toBe(loaded);
    expect(queueReducer(loaded, { type: "select-status", status: "quarantined" })).toEqual({ ...initialQueueState, status: "quarantined" });
  });

  it("removes a decided lesson and announces it; failures keep what is on screen", () => {
    let state = queueReducer(initialQueueState, { type: "load-success", lessons: [lesson("a"), lesson("b")], nextCursor: null, append: false });
    state = queueReducer(state, { type: "removed", lessonId: "a", notice: "Approved." });
    expect(state.lessons.map((l) => l.lessonId)).toEqual(["b"]);
    expect(state.notice).toBe("Approved.");
    expect(queueReducer(state, { type: "dismiss-notice" }).notice).toBeNull();
    const failed = queueReducer(queueReducer(state, { type: "load-start" }), { type: "load-failure", message: "Offline" });
    expect(failed).toMatchObject({ loading: false, error: "Offline" });
    expect(failed.lessons).toHaveLength(1);
    expect(queueReducer(failed, { type: "load-start" }).error).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Requests and wording
// ════════════════════════════════════════════════════════════════════════

describe("pendingPath and buildReviewPayload", () => {
  it("builds the queue URL", () => {
    expect(pendingPath()).toBe("/api/v1/admin/pending?status=pending_review");
    expect(pendingPath({ status: "quarantined", limit: 20 })).toBe("/api/v1/admin/pending?status=quarantined&limit=20");
    expect(pendingPath({ cursor: "ab-_c" })).toBe("/api/v1/admin/pending?status=pending_review&cursor=ab-_c");
    expect(pendingPath({ cursor: null })).toBe("/api/v1/admin/pending?status=pending_review");
  });

  it("builds the review body the service expects", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(buildReviewPayload({ lessonId: id, decision: "approve" })).toEqual({ lesson_id: id, decision: "approve" });
    expect(buildReviewPayload({ lessonId: id, decision: "approve", reasoning: "  looks right  " })).toEqual({ lesson_id: id, decision: "approve", reasoning: "looks right" });
    expect(buildReviewPayload({ lessonId: id, decision: "reject", reasonCode: "duplicate" })).toEqual({ lesson_id: id, decision: "reject", reason_code: "duplicate" });
    expect(buildReviewPayload({ lessonId: id, decision: "reject", reasonCode: "low_quality", reasoning: "thin" })).toEqual({
      lesson_id: id,
      decision: "reject",
      reason_code: "low_quality",
      reasoning: "thin",
    });
    expect(buildReviewPayload({ lessonId: id, decision: "approve", reasoning: "   " })).toEqual({ lesson_id: id, decision: "approve" });
  });

  it("refuses an invalid decision before anything is sent", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(() => buildReviewPayload({ lessonId: id, decision: "reject" })).toThrow(/reason/);
    expect(() => buildReviewPayload({ lessonId: id, decision: "reject", reasonCode: "because" as never })).toThrow(RangeError);
    expect(() => buildReviewPayload({ lessonId: id, decision: "approve", reasonCode: "duplicate" })).toThrow(RangeError);
    expect(() => buildReviewPayload({ lessonId: id, decision: "approve", reasoning: "x".repeat(1001) })).toThrow(/1000/);
  });

  it("offers exactly the reason codes the service accepts", () => {
    expect(REVIEW_REASONS.map((r) => r.code)).toEqual([
      "pii_or_secret",
      "degenerate_delta",
      "incorrect_fix",
      "duplicate",
      "out_of_scope",
      "policy_conflict",
      "low_quality",
      "adversarial",
    ]);
    expect(new Set(REVIEW_REASONS.map((r) => r.label)).size).toBe(8);
  });
});

describe("describeReviewFailure", () => {
  const api = (code: string, status = 400, details: Array<{ path: string; message: string }> = []) => new AdminApiError(code, status, "server text", details);

  it("explains a self-review refusal calmly, without removing the lesson or locking", () => {
    const view = describeReviewFailure(api("SELF_REVIEW_FORBIDDEN", 403));
    expect(view).toMatchObject({ code: "SELF_REVIEW_FORBIDDEN", stale: false, locked: false });
    expect(view.message).toMatch(/different reviewer/);
  });

  it("drops lessons that were decided or deleted meanwhile", () => {
    for (const code of ["LESSON_NOT_REVIEWABLE", "LESSON_NOT_FOUND"]) {
      expect(describeReviewFailure(api(code, code === "LESSON_NOT_FOUND" ? 404 : 409)), code).toMatchObject({ stale: true, locked: false });
    }
  });

  it("locks the console when the key is no longer allowed", () => {
    for (const code of ["AGENT_KEY_UNKNOWN", "AGENT_KEY_INACTIVE", "AGENT_ROLE_FORBIDDEN"]) {
      expect(describeReviewFailure(api(code, 403)), code).toMatchObject({ locked: true, stale: false });
    }
    expect(describeReviewFailure(new AdminLockedError())).toMatchObject({ code: "AGENT_LOCKED", locked: true });
  });

  it("words the rest plainly and never leaks server text", () => {
    expect(describeReviewFailure(api("RATE_LIMITED", 429)).message).toMatch(/Too many requests/);
    expect(describeReviewFailure(api("INVALID_REQUEST", 400, [{ path: "reasoning", message: "reasoning must not contain credentials" }])).message).toBe("reasoning must not contain credentials");
    expect(describeReviewFailure(api("INVALID_REQUEST")).message).toMatch(/did not accept/);
    expect(describeReviewFailure(api("AGENT_SIGNATURE_EXPIRED", 401)).message).toMatch(/clock/);
    expect(describeReviewFailure(api("BOOM", 500)).message).toMatch(/temporarily unavailable/);
    expect(describeReviewFailure(api("ODD", 418)).message).toMatch(/\(ODD\)/);
    expect(describeReviewFailure(new RangeError("Choose a reason for rejecting."))).toMatchObject({ code: "INVALID_INPUT", message: "Choose a reason for rejecting." });
    expect(describeReviewFailure(new Error("secret internals")).message).toBe("Something went wrong. Try again.");
    for (const error of [api("BOOM", 500), api("ODD", 418), new Error("x")]) expect(describeReviewFailure(error).message).not.toContain("server text");
  });
});

describe("isOwnLesson", () => {
  const mine = "a".repeat(64);
  const lesson = (over: Partial<PendingLesson>) => ({ submitterKey: "b".repeat(64), fixedByKey: null, provenance: "community", ...over });

  it("matches the service's four-eyes rule", () => {
    expect(isOwnLesson(lesson({ submitterKey: mine }), mine)).toBe(true);
    expect(isOwnLesson(lesson({ fixedByKey: mine }), mine)).toBe(true);
    expect(isOwnLesson(lesson({}), mine)).toBe(false);
    expect(isOwnLesson(lesson({ submitterKey: mine, provenance: "admin_seed" }), mine)).toBe(false); // seeded lessons are exempt
  });

  it("turns a base64url public key into the service's hex key", () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const b64 = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(agentKeyHex(b64)).toBe(toHex(raw));
    expect(agentKeyHex(b64)).toBe(toHex(decodeBase64url(b64)));
  });
});

describe("parsePendingPage", () => {
  it("rejects bodies that are not the documented shape", () => {
    for (const body of [null, {}, { success: true }, { success: true, status: "approved", lessons: [], next_cursor: null }, { success: true, status: "pending_review", lessons: [{}], next_cursor: null }, { success: true, status: "pending_review", lessons: [], next_cursor: 5 }]) {
      expect(parsePendingPage(body), JSON.stringify(body)).toBeNull();
    }
    expect(parsePendingPage({ success: true, status: "quarantined", lessons: [], next_cursor: null })).toEqual({ status: "quarantined", lessons: [], nextCursor: null });
  });
});

// ════════════════════════════════════════════════════════════════════════
// The operator session, against the real Worker
// ════════════════════════════════════════════════════════════════════════

describe("admin session", () => {
  it("unlocks with an operator key, proves the role with the service, and never registers a community key", async () => {
    const admin = await provisionAgent("admin");
    const { session, edge, timers } = makeSession();
    let notifications = 0;
    session.subscribe(() => notifications++);
    expect(session.getState()).toEqual({ status: "locked", fingerprint: null, agentKeyHex: null });

    await session.unlock(await pemOf(admin.agent));

    const state = session.getState();
    expect(state.status).toBe("unlocked");
    expect(state.agentKeyHex).toBe(admin.key);
    expect(state.fingerprint).toBe(`${admin.agent.publicKey.slice(0, 6)}…${admin.agent.publicKey.slice(-6)}`);
    expect(notifications).toBe(1);
    expect(edge.requests.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(["GET /api/v1/agents/me 200"]);
    expect(edge.requests[0]!.headers.get("Achromat-Agent-Key")).toBe(admin.agent.publicKey);
    expect(timers.live()).toHaveLength(1);
    expect(timers.live()[0]!.ms).toBe(600_000);
  });

  it("refuses a key that is not an operator key and keeps the console locked", async () => {
    const author = await community();
    const { session, edge, timers } = makeSession();
    let notifications = 0;
    session.subscribe(() => notifications++);

    const error = await session.unlock(await pemOf(author.agent)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdminAuthError);
    expect((error as AdminAuthError).code).toBe("NOT_AN_ADMIN_KEY");
    expect(session.getState().status).toBe("locked");
    expect(notifications).toBe(0);
    expect(timers.live()).toHaveLength(0);
    await expect(session.signedFetch("/api/v1/admin/pending")).rejects.toBeInstanceOf(AdminLockedError);
    expect(edge.to("/api/v1/admin/pending")).toHaveLength(0);
  });

  it("explains an unregistered key and a revoked key", async () => {
    const { newAgent } = await import("./helpers");
    const stranger = await newAgent();
    const unknown = await makeSession().session.unlock(await pemOf(stranger)).catch((e: unknown) => e);
    expect(unknown).toMatchObject({ name: "AdminAuthError", code: "AGENT_KEY_UNKNOWN" });
    expect((unknown as Error).message).toMatch(/not registered/);

    const revoked = await provisionAgent("admin");
    await agentEvent(revoked.key, "revoked");
    const inactive = await makeSession().session.unlock(await pemOf(revoked.agent)).catch((e: unknown) => e);
    expect(inactive).toMatchObject({ code: "AGENT_KEY_INACTIVE" });
    expect((inactive as Error).message).toMatch(/revoked/);
  });

  it("rejects text that is not an unencrypted Ed25519 key without any network request", async () => {
    const { session, edge } = makeSession();
    for (const pem of ["", "nonsense", "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----"]) {
      await expect(session.unlock(pem), pem).rejects.toBeInstanceOf(PemError);
    }
    expect(edge.requests).toHaveLength(0);
    expect(session.getState().status).toBe("locked");
  });

  it("locks on request, forgets the key, and can be unlocked again", async () => {
    const { session, timers, admin } = await unlockedSession();
    expect(session.getState().status).toBe("unlocked");
    session.lock();
    expect(session.getState()).toEqual({ status: "locked", fingerprint: null, agentKeyHex: null });
    expect(timers.live()).toHaveLength(0);
    await expect(session.signedFetch("/api/v1/admin/pending")).rejects.toBeInstanceOf(AdminLockedError);
    session.lock(); // harmless twice

    await session.unlock(await pemOf(admin.agent));
    expect((await session.signedFetch("/api/v1/admin/pending")).status).toBe(200);
  });

  it("drops the key after the idle time, and activity postpones that", async () => {
    const { session, timers } = await unlockedSession();
    const first = timers.live()[0]!;

    session.touch();
    expect(first.cleared).toBe(true);
    expect(timers.live()).toHaveLength(1);

    await session.signedFetch("/api/v1/agents/me");
    expect(timers.live()).toHaveLength(1); // re-armed, never stacked

    timers.fire();
    expect(session.getState().status).toBe("locked");
    expect(timers.live()).toHaveLength(0);
    session.touch(); // nothing to keep alive
    expect(timers.live()).toHaveLength(0);
  });

  it("locks itself when the service stops accepting the key mid-session", async () => {
    const { session, admin } = await unlockedSession();
    expect((await session.signedFetch("/api/v1/admin/pending")).status).toBe(200);

    await agentEvent(admin.key, "revoked");
    const response = await session.signedFetch("/api/v1/admin/pending");
    expect(response.status).toBe(403);
    expect(session.getState().status).toBe("locked");
  });

  it("locks when the key loses its operator role (a throttled key can still sign but is refused the console)", async () => {
    const { session, admin } = await unlockedSession();
    await agentEvent(admin.key, "throttled");
    const page = await fetchPending(fetcher(session)).catch((e: unknown) => e);
    expect(page).toBeInstanceOf(AdminApiError);
    expect(describeReviewFailure(page).locked).toBe(true);
    expect(session.getState().status).toBe("locked");
  });
});

describe("the review queue against the real Worker", () => {
  it("lists a pending lesson with the full pair, lays out its delta, and approves it", async () => {
    const world = await freshWorld();
    const author = await community();
    const { lessonId } = await world.createLesson(author.agent);
    expect(world.store.records.get(lessonId)!.metadata.visibility).toMatch(/^k:/); // visible to its author only
    const { session, admin } = await unlockedSession({ worker: world.worker });

    const page = await fetchPending(fetcher(session), { status: "pending_review", limit: 50 });
    expect(page.status).toBe("pending_review");
    const item = page.lessons.find((l) => l.lessonId === lessonId)!;
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      reviewStatus: "pending_review",
      domain: "fintech",
      tool: "transfer_funds",
      provenance: "community",
      violationRule: "Dual authorisation for large transfers",
      trapArguments: TRAP_ARGUMENTS,
      fixArguments: FIX_ARGUMENTS,
      changedPaths: ["/approval/second_approver"],
      statutoryAnchor: "FCA SYSC 6.1.1",
      submitterKey: author.key,
      fixedByKey: null,
    });
    expect(item.steeringDirective).toBeTruthy();
    expect(item.triage.length).toBeGreaterThanOrEqual(6);
    expect(item.triage.every((check) => check.passed)).toBe(true);

    // The trap on the left, the fix on the right, one highlighted field.
    const { visible } = splitRows(buildDeltaRows(item.trapArguments, item.fixArguments, item.changedPaths));
    expect(visible.map((row) => [row.path, row.status, row.left, row.right])).toEqual([["/approval/second_approver", "changed", null, "ops-lead"]]);
    expect(isOwnLesson(item, admin.key)).toBe(false);

    const result = await submitReview(fetcher(session), { lessonId, decision: "approve", reasoning: "Delta is correct." });
    expect(result).toEqual({ lessonId, decision: "approve", reviewStatus: "approved" });
    // The Worker re-indexed the lesson as public in the background.
    expect(world.store.records.get(lessonId)!.metadata).toMatchObject({ visibility: "public", review_status: "approved" });
    expect((await fetchPending(fetcher(session), { limit: 50 })).lessons.some((l) => l.lessonId === lessonId)).toBe(false);

    // A second decision is refused, and the page treats that as "already decided".
    const again = await submitReview(fetcher(session), { lessonId, decision: "reject", reasonCode: "duplicate" }).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(AdminApiError);
    expect(describeReviewFailure(again)).toMatchObject({ code: "LESSON_NOT_REVIEWABLE", stale: true, locked: false });
  });

  it("rejects with a reason code and note", async () => {
    const world = await freshWorld();
    const author = await community();
    const { lessonId } = await world.createLesson(author.agent);
    const { session, edge } = await unlockedSession({ worker: world.worker });

    // An invalid decision never reaches the network.
    const before = edge.requests.length;
    await expect(submitReview(fetcher(session), { lessonId, decision: "reject" })).rejects.toBeInstanceOf(RangeError);
    expect(edge.requests).toHaveLength(before);

    const result = await submitReview(fetcher(session), { lessonId, decision: "reject", reasonCode: "incorrect_fix", reasoning: "The approver role does not exist." });
    expect(result.reviewStatus).toBe("rejected");
    expect(world.store.records.has(lessonId)).toBe(false); // and removed from the index
    const event = await env.DB.prepare("SELECT action, reason_code, details_json FROM review_events WHERE lesson_id = ?1 AND actor_type = 'human'").bind(lessonId).first<{ action: string; reason_code: string; details_json: string }>();
    expect(event).toMatchObject({ action: "reject", reason_code: "incorrect_fix" });
    expect(JSON.parse(event!.details_json).reasoning).toBe("The approver role does not exist.");
  });

  it("shows the service's refusal when a reviewer tries to decide their own lesson", async () => {
    const world = await freshWorld();
    const { session, admin } = await unlockedSession();
    const own = await insertPair({ ownerKey: admin.key, kind: "community" });
    await processLesson(env, world.deps, own.lessonId);

    const page = await fetchPending(fetcher(session), { limit: 50 });
    const item = page.lessons.find((l) => l.lessonId === own.lessonId)!;
    expect(item.submitterKey).toBe(admin.key);
    expect(isOwnLesson(item, session.getState().agentKeyHex!)).toBe(true);

    // The page disables the buttons, but the service is the authority: ask it anyway.
    const refused = await submitReview(fetcher(session), { lessonId: own.lessonId, decision: "approve" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AdminApiError);
    expect(refused).toMatchObject({ code: "SELF_REVIEW_FORBIDDEN", status: 403 });
    const view = describeReviewFailure(refused);
    expect(view).toMatchObject({ stale: false, locked: false });
    expect(view.message).toMatch(/different reviewer/);
    expect(session.getState().status).toBe("unlocked"); // a refusal is not a reason to lock
    const state = await env.DB.prepare("SELECT review_status FROM lesson_state WHERE lesson_id = ?1").bind(own.lessonId).first<{ review_status: string }>();
    expect(state!.review_status).toBe("pending_review");
  });

  it("pages with the cursor and lists held-back lessons under their own tab", async () => {
    const world = await freshWorld();
    const first = await world.createLesson((await community()).agent);
    const second = await world.createLesson((await community()).agent);
    const held = await world.createLesson((await community()).agent, { trapArguments: { ...TRAP_ARGUMENTS, memo: "some note" }, fixArguments: { ...TRAP_ARGUMENTS } });
    const { session } = await unlockedSession();

    const one = await fetchPending(fetcher(session), { limit: 1 });
    expect(one.lessons).toHaveLength(1);
    expect(one.nextCursor).toEqual(expect.any(String));
    const seen = new Set(one.lessons.map((l) => l.lessonId));
    let cursor = one.nextCursor;
    while (cursor) {
      const next = await fetchPending(fetcher(session), { limit: 1, cursor });
      for (const lesson of next.lessons) {
        expect(seen.has(lesson.lessonId)).toBe(false);
        seen.add(lesson.lessonId);
      }
      cursor = next.nextCursor;
    }
    expect(seen.has(first.lessonId) && seen.has(second.lessonId)).toBe(true);
    expect(seen.has(held.lessonId)).toBe(false);

    const quarantined = await fetchPending(fetcher(session), { status: "quarantined", limit: 50 });
    const item = quarantined.lessons.find((l) => l.lessonId === held.lessonId)!;
    expect(item.reviewStatus).toBe("quarantined");
    expect(item.triage.find((check) => check.check === "non_degenerate_delta")).toMatchObject({ passed: false });
  });

  it("turns a bad cursor and an unreadable body into errors the page can word", async () => {
    const { session } = await unlockedSession();
    const bad = await fetchPending(fetcher(session), { cursor: "not-a-cursor" }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(AdminApiError);
    expect(describeReviewFailure(bad).message).toMatch(/not valid|did not accept/);

    const odd = await fetchPending(async () => new Response("{}", { status: 200 })).catch((e: unknown) => e);
    expect(odd).toMatchObject({ code: "UNEXPECTED_RESPONSE" });
    const html = await fetchPending(async () => new Response("<html>", { status: 502 })).catch((e: unknown) => e);
    expect(html).toMatchObject({ code: "HTTP_ERROR", status: 502 });
  });
});
