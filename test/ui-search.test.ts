/**
 * The simple search (ui/src/lib/search.ts): validation, the request path, response parsing, error wording and the
 * results state. The end-to-end cases run the real GET /api/v1/search through the Worker with fake Workers AI and
 * Vectorize, as a browser would: a plain fetch, no identity.
 */
import { describe, expect, it } from "vitest";
import {
  QUERY_MAX_CHARACTERS,
  SearchError,
  describeSearchFailure,
  initialSearchState,
  parseSearchResponse,
  runSearch,
  searchPath,
  searchReducer,
  validateSimpleSearch,
  type SearchResultView,
  type SearchQuery,
} from "../ui/src/lib/search";
import { refFromSearch, withRef } from "../ui/src/lib/ref";
import { agentPrompt } from "../ui/src/lib/site";
import { community, humanReview } from "./fixtures/ledger";
import { workerEdge } from "./fixtures/ui-env";
import { freshWorld } from "./fixtures/world";

const QUERY: SearchQuery = { domain: "fintech", q: "Move client funds to the settlement account" };

const API_LESSON = {
  lesson_id: "5e5dc086-bfd7-428e-a694-d328d9e0ffa6",
  domain: "fintech",
  tool: "transfer_funds",
  violation_rule: "Dual authorisation for large transfers",
  steering_directive: "Add a second approver.",
  statutory_anchor: null,
  compliant_arguments: { approval: { second_approver: "ops-lead" } },
  changed_paths: ["/approval/second_approver"],
  display_title: null,
  display_summary: null,
  featured: false,
  updated_at: "2026-10-01T00:00:00.000Z",
};

describe("validateSimpleSearch", () => {
  it("accepts a domain and a question and returns the normalised question", () => {
    expect(validateSimpleSearch({ domain: "fintech", query: "  Send   a wire\ttransfer \n" })).toEqual({ ok: true, query: { domain: "fintech", q: "Send a wire transfer" } });
  });

  it("rejects an unknown domain, a short question, a long question and control characters, all at once", () => {
    const failed = (values: { domain: string; query: string }) => {
      const result = validateSimpleSearch(values);
      if (result.ok) throw new Error("expected validation to fail");
      return result.errors;
    };
    expect(failed({ domain: "healthcare", query: "ok" })).toEqual({ domain: expect.stringMatching(/listed domains/), query: expect.stringMatching(/at least 3/) });
    expect(failed({ domain: "fintech", query: "x".repeat(QUERY_MAX_CHARACTERS + 1) }).query).toMatch(/under 300/);
    expect(failed({ domain: "fintech", query: "wire\u0007transfer" }).query).toMatch(/control characters/);
    expect(validateSimpleSearch({ domain: "fintech", query: "x".repeat(QUERY_MAX_CHARACTERS) }).ok).toBe(true);
    expect(validateSimpleSearch({ domain: "fintech", query: "abc" }).ok).toBe(true);
  });
});

describe("searchPath", () => {
  it("encodes the question into the query string", () => {
    const path = searchPath({ domain: "devsecops", q: "run rm -rf & more=1" });
    expect(path.startsWith("/api/v1/search?")).toBe(true);
    const params = new URL(path, "https://mom.achromat.ai").searchParams;
    expect([...params.keys()]).toEqual(["domain", "q"]);
    expect(params.get("q")).toBe("run rm -rf & more=1");
  });
});

describe("parseSearchResponse", () => {
  it("reads results with their scores", () => {
    const parsed = parseSearchResponse({ success: true, results: [{ score: 0.7, lesson: API_LESSON }] });
    expect(parsed).toHaveLength(1);
    expect(parsed![0]).toMatchObject({ score: 0.7, lesson: { lessonId: API_LESSON.lesson_id, tool: "transfer_funds", changedPaths: ["/approval/second_approver"] } });
    expect(parseSearchResponse({ success: true, results: [] })).toEqual([]);
  });

  it("rejects anything that is not the documented shape", () => {
    for (const body of [null, "x", { success: false }, { success: true }, { success: true, results: [{ lesson: API_LESSON }] }, { success: true, results: [{ score: 1, lesson: { ...API_LESSON, tool: 4 } }] }]) {
      expect(parseSearchResponse(body)).toBeNull();
    }
  });
});

describe("describeSearchFailure", () => {
  it("words the known failures and never leaks codes", () => {
    const err = (code: string, status: number, details: Array<{ path: string; message: string }> = []) => describeSearchFailure(new SearchError(code, status, "x", details));
    expect(err("RATE_LIMITED", 429).message).toMatch(/too often/);
    expect(err("SEARCH_UNAVAILABLE", 503).message).toMatch(/temporarily unavailable/);
    expect(err("DOMAIN_UNKNOWN", 400).fieldErrors).toEqual({ domain: expect.any(String) });
    expect(err("INVALID_REQUEST", 400, [{ path: "q", message: "q must be at least 3 characters" }]).fieldErrors).toEqual({ query: "q must be at least 3 characters" });
    expect(err("SOMETHING_ELSE", 500).message).toMatch(/temporarily unavailable/);
    expect(describeSearchFailure(new TypeError("fetch failed")).message).toMatch(/could not reach/);
    for (const view of [err("RATE_LIMITED", 429), err("SOMETHING_ELSE", 418)]) expect(view.message).not.toMatch(/RATE_LIMITED|SOMETHING_ELSE/);
  });
});

describe("searchReducer", () => {
  const results: SearchResultView[] = [];

  it("goes idle -> loading -> idle with the answer", () => {
    const loading = searchReducer(initialSearchState, { type: "start" });
    expect(loading).toMatchObject({ phase: "loading", error: null, results: null });
    expect(searchReducer(loading, { type: "success", query: QUERY, results })).toEqual({ phase: "idle", error: null, query: QUERY, results });
  });

  it("keeps the previous answer on screen while a new search runs, and after a failed one", () => {
    const answered = searchReducer(initialSearchState, { type: "success", query: QUERY, results });
    const loading = searchReducer(answered, { type: "start" });
    expect(loading.results).toBe(results);
    const failed = searchReducer(loading, { type: "failure", failure: { message: "nope" } });
    expect(failed).toMatchObject({ phase: "error", error: { message: "nope" }, query: QUERY });
    expect(failed.results).toBe(results);
    expect(searchReducer(failed, { type: "start" }).error).toBeNull();
  });

  it("clears back to the start", () => {
    expect(searchReducer(searchReducer(initialSearchState, { type: "success", query: QUERY, results }), { type: "clear" })).toEqual(initialSearchState);
  });
});

describe("the ref tag of the page", () => {
  it("is read from the query string, lowercased, and is empty for anything malformed or repeated", () => {
    expect(refFromSearch("?ref=Launch-Post")).toBe("launch-post");
    expect(refFromSearch("?x=1&ref=hn_2026")).toBe("hn_2026");
    for (const search of ["", "?", "?ref=", "?ref=-bad", "?ref=a%40b.com", `?ref=${"a".repeat(33)}`, "?ref=a&ref=b", "?ref=has space"]) expect(refFromSearch(search), search).toBe("");
  });

  it("is appended to a path only when there is one", () => {
    expect(withRef("/api/v1/agents/challenge", "")).toBe("/api/v1/agents/challenge");
    expect(withRef("/skill.md", "launch")).toBe("/skill.md?ref=launch");
    expect(withRef("/x?a=1", "launch")).toBe("/x?a=1&ref=launch");
  });

  it("rides on the copied prompt's skill.md URL for tagged visitors only", () => {
    expect(agentPrompt("https://mom.achromat.ai", "launch")).toContain("https://mom.achromat.ai/skill.md?ref=launch ");
    expect(agentPrompt("https://mom.achromat.ai")).toContain("https://mom.achromat.ai/skill.md and");
  });
});

describe("runSearch against the real Worker", () => {
  it("finds an approved lesson with a plain GET, no signature headers, and never shows the blocked call", async () => {
    const world = await freshWorld();
    const owner = await community();
    const lesson = await world.createLesson(owner.agent, { description: "Move client funds to the settlement account for the March batch" });
    await humanReview(lesson.lessonId, "approve");
    await world.reconcileAt();

    const edge = workerEdge({ worker: world.worker });
    const results = await runSearch(edge.fetch, { domain: "fintech", q: "Move client funds to the settlement account for the March batch" });
    expect(results.map((item) => item.lesson.lessonId)).toContain(lesson.lessonId);
    expect(results[0]!.score).toBeGreaterThan(0.5);

    const [request] = edge.to("/api/v1/search");
    expect(request!.method).toBe("GET");
    for (const name of ["Achromat-Agent-Key", "Achromat-Signature", "Achromat-Nonce", "Achromat-Timestamp"]) expect(request!.headers.has(name)).toBe(false);
    expect(edge.to("/api/v1/agents/challenge")).toHaveLength(0);
  });

  it("turns a server error into a SearchError the wording code understands", async () => {
    const world = await freshWorld();
    const edge = workerEdge({ worker: world.worker });
    await expect(runSearch(edge.fetch, { domain: "fintech", q: "ab" })).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    world.store.failQuery = true;
    const failure = await runSearch(edge.fetch, QUERY).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SearchError);
    expect(describeSearchFailure(failure).message).toMatch(/temporarily unavailable/);
  });
});
