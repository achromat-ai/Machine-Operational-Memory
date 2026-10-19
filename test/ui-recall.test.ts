/**
 * The public search (ui/src/lib/recall.ts): form validation, the recall call, response parsing, error
 * wording and the results state. The end-to-end cases run the real signed client against the real Worker
 * and an approved lesson in D1; the exact tier needs no embedding, so no AI binding is involved.
 */
import { describe, expect, it } from "vitest";
import { buildDeltaRows, splitRows } from "../ui/src/lib/delta";
import { IdentityError, UnsupportedBrowserError } from "../ui/src/lib/identity";
import { KeystoreError } from "../ui/src/lib/keystore";
import {
  ARGUMENTS_MAX_BYTES,
  DOMAINS,
  MAX_HISTORY,
  RecallError,
  describeRecallFailure,
  initialRecallState,
  normaliseTaskDescription,
  parseRecallResponse,
  recallReducer,
  runRecall,
  validateSearchForm,
  type RecallOutcome,
  type RecallPayload,
  type SearchFormValues,
} from "../ui/src/lib/recall";
import { FIX_ARGUMENTS, TRAP_ARGUMENTS, community, humanReview } from "./fixtures/ledger";
import { makeClient } from "./fixtures/ui-env";
import { freshWorld } from "./fixtures/world";

const GOOD: SearchFormValues = {
  domain: "fintech",
  tool: "transfer_funds",
  taskDescription: "Move client funds to the settlement account for the March batch",
  argumentsJson: '{"amount": 50000, "currency": "GBP"}',
};

function check(overrides: Partial<SearchFormValues>) {
  return validateSearchForm({ ...GOOD, ...overrides });
}

function errorsOf(overrides: Partial<SearchFormValues>) {
  const result = check(overrides);
  if (result.ok) throw new Error("expected validation to fail");
  return result.errors;
}

describe("validateSearchForm", () => {
  it("accepts a good form and builds the request body", () => {
    const result = check({});
    expect(result).toEqual({
      ok: true,
      payload: {
        domain: "fintech",
        tool: "transfer_funds",
        task_description: "Move client funds to the settlement account for the March batch",
        arguments: { amount: 50000, currency: "GBP" },
      },
    });
  });

  it("normalises the description the way the server does (NFC, whitespace collapsed, trimmed)", () => {
    expect(normaliseTaskDescription("  Move   client\n\tfunds  to the account  ")).toBe("Move client funds to the account");
    expect(normaliseTaskDescription("e\u0301 ok")).toBe("\u00e9 ok");
    const result = check({ taskDescription: "  Move\tclient   funds\nto the settlement account " });
    expect(result.ok && result.payload.task_description).toBe("Move client funds to the settlement account");
  });

  it("offers exactly the four served domains and rejects anything else", () => {
    expect([...DOMAINS]).toEqual(["fintech", "industrial_iot", "robotics", "devsecops"]);
    for (const domain of DOMAINS) expect(check({ domain }).ok).toBe(true);
    for (const domain of ["", "Fintech", "banking"]) expect(errorsOf({ domain }).domain).toBeDefined();
    expect(check({ domain: " fintech " }).ok).toBe(true); // trimmed
  });

  it("checks the tool name against the server's pattern", () => {
    for (const tool of ["a", "transfer_funds", "ns:tool.v2/run-1", "A".repeat(64)]) expect(check({ tool }).ok, tool).toBe(true);
    expect(errorsOf({ tool: "" }).tool).toMatch(/Enter the name/);
    for (const tool of ["_lead", "has space", "A".repeat(65), "ünï", "semi;colon"]) expect(errorsOf({ tool }).tool, tool).toMatch(/1 to 64 characters/);
  });

  it("enforces the description rules: 16 characters, 3 words, 1000 at most, no control characters", () => {
    expect(errorsOf({ taskDescription: "too short" }).taskDescription).toMatch(/at least 16/);
    expect(errorsOf({ taskDescription: "" }).taskDescription).toMatch(/at least 16/);
    expect(errorsOf({ taskDescription: "supercalifragilistic expialidocious" }).taskDescription).toMatch(/at least 3 words/);
    expect(check({ taskDescription: "exactly sixteen ch" }).ok).toBe(true);
    expect(check({ taskDescription: `${"word ".repeat(199)}word` }).ok).toBe(true); // 999 characters
    expect(errorsOf({ taskDescription: "word ".repeat(250) }).taskDescription).toMatch(/under 1000/);
    expect(errorsOf({ taskDescription: "move client funds \u0007 now please" }).taskDescription).toMatch(/control characters/);
    // Whitespace padding does not count towards the minimum.
    expect(errorsOf({ taskDescription: "a      b      c" }).taskDescription).toMatch(/at least 16/);
  });

  it("requires the arguments to be a non-empty JSON object within the server's limits", () => {
    expect(errorsOf({ argumentsJson: "" }).arguments).toMatch(/Enter the arguments/);
    expect(errorsOf({ argumentsJson: "   " }).arguments).toMatch(/Enter the arguments/);
    expect(errorsOf({ argumentsJson: "{nope" }).arguments).toMatch(/not valid JSON/);
    for (const text of ["[1,2]", '"text"', "42", "null", "true"]) expect(errorsOf({ argumentsJson: text }).arguments, text).toMatch(/must be a JSON object/);
    expect(errorsOf({ argumentsJson: "{}" }).arguments).toMatch(/at least one/);

    const keys = (n: number) => JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 1])));
    expect(check({ argumentsJson: keys(256) }).ok).toBe(true);
    expect(errorsOf({ argumentsJson: keys(257) }).arguments).toMatch(/at most 256/);

    const nested = (depth: number) => JSON.stringify(Array.from({ length: depth - 1 }).reduce<unknown>((inner) => ({ n: inner }), { leaf: 1 }));
    expect(check({ argumentsJson: nested(8) }).ok).toBe(true);
    expect(errorsOf({ argumentsJson: nested(9) }).arguments).toMatch(/8 levels/);

    expect(errorsOf({ argumentsJson: JSON.stringify({ blob: "x".repeat(ARGUMENTS_MAX_BYTES) }) }).arguments).toMatch(/16 KiB/);
  });

  it("reports every problem at once", () => {
    const result = validateSearchForm({ domain: "x", tool: "", taskDescription: "", argumentsJson: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["arguments", "domain", "taskDescription", "tool"]);
  });
});

describe("parseRecallResponse", () => {
  const lesson = {
    lesson_id: "11111111-1111-4111-8111-111111111111",
    review_status: "approved",
    domain: "fintech",
    tool: "transfer_funds",
    violation_rule: "Dual authorisation for large transfers",
    steering_directive: "Add a second approver before moving the funds.",
    statutory_anchor: "FCA SYSC 6.1.1",
    compliant_arguments: FIX_ARGUMENTS,
    changed_paths: ["/approval/second_approver"],
    block_receipt: { id: "b", signature: "s" },
    allow_receipt: { id: "a", signature: "s" },
    pair_attestation: "x",
    attestation_kid: "y",
  };
  const hit = { success: true, match: true, tier: "exact", score: 1, lesson };

  it("reads a hit into a view model and drops the verification fields", () => {
    const outcome = parseRecallResponse(hit);
    expect(outcome).toEqual({
      kind: "match",
      tier: "exact",
      score: 1,
      lesson: {
        lessonId: lesson.lesson_id,
        reviewStatus: "approved",
        domain: "fintech",
        tool: "transfer_funds",
        violationRule: "Dual authorisation for large transfers",
        steeringDirective: "Add a second approver before moving the funds.",
        statutoryAnchor: "FCA SYSC 6.1.1",
        compliantArguments: FIX_ARGUMENTS,
        changedPaths: ["/approval/second_approver"],
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("attestation");
    expect(JSON.stringify(outcome)).not.toContain("receipt");
  });

  it("accepts null directives, a semantic tier and a pending lesson", () => {
    const outcome = parseRecallResponse({ ...hit, tier: "semantic", score: 0.87, lesson: { ...lesson, steering_directive: null, statutory_anchor: null, review_status: "pending" } });
    expect(outcome).toMatchObject({ kind: "match", tier: "semantic", score: 0.87, lesson: { steeringDirective: null, statutoryAnchor: null, reviewStatus: "pending" } });
  });

  it("reads misses, with and without the exhausted flag", () => {
    expect(parseRecallResponse({ success: true, match: false })).toEqual({ kind: "miss", budgetExhausted: false });
    expect(parseRecallResponse({ success: true, match: false, budget_exhausted: true })).toEqual({ kind: "miss", budgetExhausted: true });
  });

  it("returns null for anything that is not the documented shape", () => {
    const bad: unknown[] = [
      null,
      "text",
      [],
      {},
      { success: false },
      { success: true },
      { success: true, match: true },
      { ...hit, tier: "fuzzy" },
      { ...hit, score: "1" },
      { ...hit, lesson: null },
      { ...hit, lesson: { ...lesson, review_status: "rejected" } },
      { ...hit, lesson: { ...lesson, compliant_arguments: [] } },
      { ...hit, lesson: { ...lesson, changed_paths: [1] } },
      { ...hit, lesson: { ...lesson, steering_directive: 5 } },
      { ...hit, lesson: { ...lesson, lesson_id: undefined } },
    ];
    for (const body of bad) expect(parseRecallResponse(body), JSON.stringify(body)?.slice(0, 60)).toBeNull();
  });
});

describe("runRecall (fake transport)", () => {
  const payload: RecallPayload = { domain: "fintech", tool: "transfer_funds", task_description: GOOD.taskDescription, arguments: { amount: 1 } };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("POSTs the payload as JSON to /api/v1/recall", async () => {
    const seen: Array<{ path: string; init?: RequestInit }> = [];
    const outcome = await runRecall(async (path, init) => {
      seen.push({ path, init });
      return json(200, { success: true, match: false });
    }, payload);
    expect(outcome).toEqual({ kind: "miss", budgetExhausted: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/api/v1/recall");
    expect(seen[0]!.init?.method).toBe("POST");
    expect(new Headers(seen[0]!.init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(seen[0]!.init?.body as string)).toEqual(payload);
  });

  it("throws RecallError with the server's code, status and field details", async () => {
    const error = await runRecall(
      async () => json(400, { success: false, error: "recall body is invalid", code: "INVALID_REQUEST", details: [{ path: "tool", message: "bad tool" }, { nonsense: true }] }),
      payload,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecallError);
    expect(error).toMatchObject({ code: "INVALID_REQUEST", status: 400, details: [{ path: "tool", message: "bad tool" }] });
  });

  it("survives a non-JSON error body and an unreadable success body", async () => {
    const html = await runRecall(async () => new Response("<html>bad gateway</html>", { status: 502 }), payload).catch((e: unknown) => e);
    expect(html).toMatchObject({ code: "HTTP_ERROR", status: 502 });
    const odd = await runRecall(async () => json(200, { success: true, match: "maybe" }), payload).catch((e: unknown) => e);
    expect(odd).toMatchObject({ code: "UNEXPECTED_RESPONSE" });
    const empty = await runRecall(async () => new Response("", { status: 200 }), payload).catch((e: unknown) => e);
    expect(empty).toMatchObject({ code: "UNEXPECTED_RESPONSE" });
  });
});

describe("describeRecallFailure", () => {
  const recallError = (code: string, status = 400, details: Array<{ path: string; message: string }> = []) => new RecallError(code, status, "server text", details);

  it("maps server field errors onto the form fields", () => {
    const view = describeRecallFailure(
      recallError("INVALID_REQUEST", 400, [
        { path: "task_description", message: "task_description must be at least 16 characters" },
        { path: "tool", message: "tool must be at most 64 characters" },
        { path: "arguments", message: "arguments must be a JSON object" },
        { path: "domain", message: "bad" },
        { path: "tool", message: "second tool message is ignored" },
        { path: "mystery", message: "unmapped" },
      ]),
    );
    expect(view.fieldErrors).toEqual({
      taskDescription: "task_description must be at least 16 characters",
      tool: "tool must be at most 64 characters",
      arguments: "arguments must be a JSON object",
      domain: "bad",
    });
    expect(view.message).toMatch(/highlighted fields/);
  });

  it("words the other failures plainly, with no codes, keys or server text", () => {
    const cases: Array<[unknown, RegExp]> = [
      [recallError("DOMAIN_UNKNOWN"), /domain is not served/],
      [recallError("RATE_LIMITED", 429), /too often/],
      [recallError("SEARCH_UNAVAILABLE", 503), /temporarily unavailable/],
      [recallError("UNEXPECTED_RESPONSE", 200), /cannot read/],
      [recallError("AGENT_SIGNATURE_EXPIRED", 401), /clock/],
      [recallError("AGENT_KEY_UNKNOWN", 401), /Reload the page/],
      [recallError("AGENT_KEY_INACTIVE", 403), /Reload the page/],
      [recallError("AGENT_NONCE_REPLAYED", 401), /Reload the page/],
      [recallError("SERVICE_MISCONFIGURED", 503), /temporarily unavailable/],
      [recallError("TEAPOT", 418), /search failed \(TEAPOT\)/],
      [new IdentityError("REGISTRATION_LIMIT", "Too many sessions were created from this network today.", 429), /Too many sessions/],
      [new UnsupportedBrowserError("This browser cannot create Ed25519 keys."), /Ed25519/],
      [new KeystoreError("Browser storage is unavailable."), /storage/],
      [new TypeError("x is not a function"), /Something went wrong/],
      ["a string", /Something went wrong/],
    ];
    for (const [error, pattern] of cases) {
      const view = describeRecallFailure(error);
      expect(view.message).toMatch(pattern);
      expect(view.message).not.toMatch(/server text|x is not a function|undefined/);
    }
  });
});

describe("recallReducer", () => {
  const payload: RecallPayload = { domain: "fintech", tool: "t", task_description: "Move client funds to the settlement account", arguments: { a: 1 } };
  const miss: RecallOutcome = { kind: "miss", budgetExhausted: false };

  it("moves idle -> loading -> idle with the newest result first", () => {
    let state = recallReducer(initialRecallState, { type: "start" });
    expect(state.phase).toBe("loading");
    state = recallReducer(state, { type: "success", query: payload, outcome: miss });
    expect(state).toMatchObject({ phase: "idle", error: null });
    state = recallReducer(state, { type: "success", query: { ...payload, tool: "second" }, outcome: miss });
    expect(state.entries.map((entry) => [entry.id, entry.query.tool])).toEqual([[2, "second"], [1, "t"]]);
  });

  it("keeps earlier results when a search fails, and clears the error on the next search", () => {
    let state = recallReducer(initialRecallState, { type: "success", query: payload, outcome: miss });
    state = recallReducer(state, { type: "failure", failure: { message: "nope" } });
    expect(state).toMatchObject({ phase: "error", error: { message: "nope" } });
    expect(state.entries).toHaveLength(1);
    state = recallReducer(state, { type: "start" });
    expect(state).toMatchObject({ phase: "loading", error: null });
    expect(state.entries).toHaveLength(1);
  });

  it("caps the history", () => {
    let state = initialRecallState;
    for (let i = 0; i < MAX_HISTORY + 5; i++) state = recallReducer(state, { type: "success", query: payload, outcome: miss });
    expect(state.entries).toHaveLength(MAX_HISTORY);
    expect(state.entries[0]!.id).toBe(MAX_HISTORY + 5);
  });

  it("clears everything", () => {
    const state = recallReducer(recallReducer(initialRecallState, { type: "success", query: payload, outcome: miss }), { type: "clear" });
    expect(state).toEqual(initialRecallState);
  });
});

describe("recall against the real Worker", () => {
  async function approvedLesson() {
    const world = await freshWorld();
    const author = await community();
    const { lessonId, description } = await world.createLesson(author.agent);
    await humanReview(lessonId, "approve");
    return { lessonId, description };
  }

  it("finds an approved lesson by its exact description and lays out the delta the page will draw", async () => {
    const { lessonId, description } = await approvedLesson();
    const { signedFetch } = makeClient();

    const outcome = await runRecall(signedFetch, { domain: "fintech", tool: "transfer_funds", task_description: description, arguments: TRAP_ARGUMENTS });
    expect(outcome.kind).toBe("match");
    if (outcome.kind !== "match") return;
    expect(outcome.tier).toBe("exact");
    expect(outcome.score).toBe(1);
    expect(outcome.lesson).toMatchObject({
      lessonId,
      reviewStatus: "approved",
      violationRule: "Dual authorisation for large transfers",
      compliantArguments: FIX_ARGUMENTS,
      changedPaths: ["/approval/second_approver"],
    });
    expect(outcome.lesson.steeringDirective).toBeTruthy();

    // "Your call" (what was typed) against "The fix": one highlighted field.
    const { visible, unchanged } = splitRows(buildDeltaRows(TRAP_ARGUMENTS, outcome.lesson.compliantArguments, outcome.lesson.changedPaths));
    expect(visible.map((row) => [row.path, row.status])).toEqual([["/approval/second_approver", "changed"]]);
    expect(unchanged.map((row) => row.path)).toEqual(["/amount", "/currency"]);
  });

  it("shows a user whose call already complies that nothing needs to change", async () => {
    const { description } = await approvedLesson();
    const { signedFetch } = makeClient();
    const outcome = await runRecall(signedFetch, { domain: "fintech", tool: "transfer_funds", task_description: description, arguments: FIX_ARGUMENTS });
    if (outcome.kind !== "match") throw new Error("expected a match");
    const rows = buildDeltaRows(FIX_ARGUMENTS, outcome.lesson.compliantArguments, outcome.lesson.changedPaths);
    expect(rows.every((row) => row.status === "same")).toBe(true);
    expect(rows.filter((row) => row.highlighted).map((row) => row.path)).toEqual(["/approval/second_approver"]);
  });

  it("turns server refusals into the messages the page shows", async () => {
    const { signedFetch } = makeClient();

    const unknownDomain = await runRecall(signedFetch, { domain: "nowhere", tool: "transfer_funds", task_description: GOOD.taskDescription, arguments: { a: 1 } } as unknown as RecallPayload).catch((e: unknown) => e);
    expect(unknownDomain).toMatchObject({ code: "DOMAIN_UNKNOWN", status: 400 });
    expect(describeRecallFailure(unknownDomain).fieldErrors?.domain).toBeDefined();

    // The service rejects what the form would have caught: field details come back keyed by field.
    const invalid = await runRecall(signedFetch, { domain: "fintech", tool: "bad tool!", task_description: "short", arguments: { a: 1 } }).catch((e: unknown) => e);
    expect(invalid).toMatchObject({ code: "INVALID_REQUEST" });
    const view = describeRecallFailure(invalid);
    expect(view.fieldErrors?.tool).toBeDefined();
    expect(view.fieldErrors?.taskDescription).toBeDefined();

    // Semantic search runs on Workers AI. The service answers 503 SEARCH_UNAVAILABLE when it is down
    // (the Worker side of this is covered in recall.test.ts); here the page's wording for it is checked.
    const down = makeClient({
      intercept: (path) =>
        path === "/api/v1/recall"
          ? new Response(JSON.stringify({ success: false, error: "semantic search is temporarily unavailable; retry shortly", code: "SEARCH_UNAVAILABLE" }), { status: 503 })
          : undefined,
    });
    const unavailable = await runRecall(down.signedFetch, { domain: "fintech", tool: "transfer_funds", task_description: "A task nobody has ever described before today", arguments: { a: 1 } }).catch((e: unknown) => e);
    expect(unavailable).toMatchObject({ code: "SEARCH_UNAVAILABLE", status: 503 });
    expect(describeRecallFailure(unavailable).message).toMatch(/temporarily unavailable/);
  });
});
