/**
 * The simple search: GET /api/v1/search?domain=&q=, response parsing, error messages and the state machine
 * behind the results. The endpoint is unauthenticated, so this uses a plain fetch: no identity, no proof of work,
 * no signature. No DOM, so it runs in the test suite against the real Worker.
 *
 * The advanced, structured lookup (tool name and arguments, signed POST /api/v1/recall) is in ./recall.ts.
 */
import { parseFeedResponse, type FeedLessonView } from "./feed";
import { DOMAINS, normaliseTaskDescription, type Domain } from "./recall";

export const SEARCH_PATH = "/api/v1/search";
export const QUERY_MIN_CHARACTERS = 3;
export const QUERY_MAX_CHARACTERS = 300;

export interface SimpleSearchValues {
  domain: string;
  query: string;
}

export type SimpleFieldName = "domain" | "query";
export type SimpleFieldErrors = Partial<Record<SimpleFieldName, string>>;

export interface SearchQuery {
  domain: Domain;
  q: string;
}

/** Validates the box like the server does and returns the normalised question. */
export function validateSimpleSearch(values: SimpleSearchValues): { ok: true; query: SearchQuery } | { ok: false; errors: SimpleFieldErrors } {
  const errors: SimpleFieldErrors = {};
  const domain = values.domain.trim();
  if (!(DOMAINS as readonly string[]).includes(domain)) errors.domain = "Choose one of the listed domains.";

  const q = normaliseTaskDescription(values.query);
  const length = [...q].length;
  if (length < QUERY_MIN_CHARACTERS) errors.query = `Type at least ${QUERY_MIN_CHARACTERS} characters.`;
  else if (length > QUERY_MAX_CHARACTERS) errors.query = `Keep the question under ${QUERY_MAX_CHARACTERS} characters.`;
  // eslint-disable-next-line no-control-regex
  else if (/[\u0000-\u001F\u007F-\u009F]/u.test(q)) errors.query = "Remove control characters from the question.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, query: { domain: domain as Domain, q } };
}

/** The request path, query string included. */
export function searchPath(query: SearchQuery): string {
  return `${SEARCH_PATH}?${new URLSearchParams({ domain: query.domain, q: query.q }).toString()}`;
}

// ════════════════════════════════════════════════════════════════════════
// Response
// ════════════════════════════════════════════════════════════════════════

export interface SearchResultView {
  /** Cosine similarity of the question to the lesson. */
  score: number;
  lesson: FeedLessonView;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a 200 body. Returns null if it is not the documented shape (one bad result rejects the whole answer). */
export function parseSearchResponse(body: unknown): SearchResultView[] | null {
  if (!isRecord(body) || body.success !== true || !Array.isArray(body.results)) return null;
  const scores: number[] = [];
  const lessons: unknown[] = [];
  for (const item of body.results) {
    if (!isRecord(item) || typeof item.score !== "number" || !Number.isFinite(item.score)) return null;
    scores.push(item.score);
    lessons.push(item.lesson);
  }
  // A search result's lesson is exactly a feed lesson, so the feed's reader checks it.
  const parsed = parseFeedResponse({ success: true, lessons });
  if (parsed === null) return null;
  return parsed.map((lesson, index) => ({ score: scores[index]!, lesson }));
}

// ════════════════════════════════════════════════════════════════════════
// Request and errors
// ════════════════════════════════════════════════════════════════════════

export class SearchError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Array<{ path: string; message: string }>;

  constructor(code: string, status: number, message: string, details: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = "SearchError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type SearchFetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** GET /api/v1/search. Throws SearchError for any non-success answer or unreadable body. */
export async function runSearch(fetcher: SearchFetcher, query: SearchQuery, signal?: AbortSignal): Promise<SearchResultView[]> {
  // Typed loosely: `credentials` and `redirect` are DOM RequestInit fields that Workers' typings omit.
  const init: Record<string, unknown> = {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    ...(signal ? { signal } : {}),
  };
  const response = await fetcher(searchPath(query), init as RequestInit);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.status === 200) {
    const results = parseSearchResponse(body);
    if (results === null) throw new SearchError("UNEXPECTED_RESPONSE", 200, "The service sent an unexpected answer.");
    return results;
  }

  const record = isRecord(body) ? body : {};
  const code = typeof record.code === "string" ? record.code : "HTTP_ERROR";
  const details = Array.isArray(record.details)
    ? record.details.flatMap((detail) =>
        isRecord(detail) && typeof detail.path === "string" && typeof detail.message === "string" ? [{ path: detail.path, message: detail.message }] : [],
      )
    : [];
  throw new SearchError(code, response.status, typeof record.error === "string" ? record.error : `Request failed (${response.status})`, details);
}

export interface SearchFailureView {
  message: string;
  fieldErrors?: SimpleFieldErrors;
}

/** What to tell the visitor about a failed search. Never includes codes, keys or stack traces. */
export function describeSearchFailure(error: unknown): SearchFailureView {
  if (error instanceof SearchError) {
    switch (error.code) {
      case "DOMAIN_UNKNOWN":
        return { message: "That domain is not served.", fieldErrors: { domain: "Choose one of the listed domains." } };
      case "INVALID_REQUEST": {
        const q = error.details.find((detail) => detail.path === "q");
        return q
          ? { message: "The service did not accept the question.", fieldErrors: { query: q.message } }
          : { message: "The service did not accept the search. Check what you typed." };
      }
      case "RATE_LIMITED":
        return { message: "You have searched too often from this network. Wait a minute and try again." };
      case "SEARCH_UNAVAILABLE":
        return { message: "Search is temporarily unavailable. Try again shortly." };
      case "UNEXPECTED_RESPONSE":
        return { message: "The service sent an answer this page cannot read. Try again." };
      default:
        return error.status >= 500
          ? { message: "The service is temporarily unavailable. Try again later." }
          : { message: "The search could not be completed. Try again." };
    }
  }
  return { message: "The search could not reach the service. Check your connection and try again." };
}

// ════════════════════════════════════════════════════════════════════════
// Results state
// ════════════════════════════════════════════════════════════════════════

export interface SearchState {
  phase: "idle" | "loading" | "error";
  error: SearchFailureView | null;
  /** The question the results answer, or null before the first search. */
  query: SearchQuery | null;
  /** The newest answer. Null before the first search; an empty list means nothing matched. */
  results: SearchResultView[] | null;
}

export type SearchAction =
  | { type: "start" }
  | { type: "success"; query: SearchQuery; results: SearchResultView[] }
  | { type: "failure"; failure: SearchFailureView }
  | { type: "clear" };

export const initialSearchState: SearchState = { phase: "idle", error: null, query: null, results: null };

export function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case "start":
      // The previous answer stays on screen (dimmed by the page) until the new one arrives.
      return { ...state, phase: "loading", error: null };
    case "success":
      return { phase: "idle", error: null, query: action.query, results: action.results };
    case "failure":
      return { ...state, phase: "error", error: action.failure };
    case "clear":
      return initialSearchState;
  }
}
