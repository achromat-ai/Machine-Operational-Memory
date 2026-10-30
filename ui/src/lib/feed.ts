/**
 * The public feed: GET /api/v1/feed, response parsing, error messages and the state machine behind the
 * landing page. The endpoint is unauthenticated, so this uses a plain fetch: no identity, no proof of work.
 * No DOM, so it runs in the test suite against the real Worker.
 *
 * A feed lesson has the shape /recall serves (directive, anchor, compliant arguments, changed paths)
 * without receipts, plus editorial fields. The values of the blocked call and the upstream rule name are not
 * part of it. A `violation_rule` key from an older server is ignored. So is `updated_at`: the server still
 * sends it, but the public page shows no dates, so it is neither required nor kept.
 */
import type { JsonObject } from "./delta";
import { withRef } from "./ref";

export const FEED_PATH = "/api/v1/feed";
/** The server caches the feed for 30 seconds, so asking more often only returns the same answer. */
export const FEED_REFRESH_MS = 60_000;

export interface FeedLessonView {
  lessonId: string;
  domain: string;
  tool: string;
  steeringDirective: string | null;
  statutoryAnchor: string | null;
  compliantArguments: JsonObject;
  changedPaths: string[];
  displayTitle: string | null;
  displaySummary: string | null;
  featured: boolean;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** Reads one lesson as the feed and the single-lesson route send it. Null if it is not the documented shape. */
export function parseFeedLesson(item: unknown): FeedLessonView | null {
  if (!isPlainObject(item)) return null;
  const steering = nullableString(item.steering_directive);
  const anchor = nullableString(item.statutory_anchor);
  const title = nullableString(item.display_title);
  const summary = nullableString(item.display_summary);
  if (
    typeof item.lesson_id !== "string" ||
    typeof item.domain !== "string" ||
    typeof item.tool !== "string" ||
    steering === undefined ||
    anchor === undefined ||
    title === undefined ||
    summary === undefined ||
    !isPlainObject(item.compliant_arguments) ||
    !Array.isArray(item.changed_paths) ||
    !item.changed_paths.every((path) => typeof path === "string") ||
    typeof item.featured !== "boolean"
  ) {
    return null;
  }
  return {
    lessonId: item.lesson_id,
    domain: item.domain,
    tool: item.tool,
    steeringDirective: steering,
    statutoryAnchor: anchor,
    compliantArguments: item.compliant_arguments,
    changedPaths: item.changed_paths as string[],
    displayTitle: title,
    displaySummary: summary,
    featured: item.featured,
  };
}

/** Reads a 200 body. Returns null if it is not the documented shape (one bad lesson rejects the whole answer). */
export function parseFeedResponse(body: unknown): FeedLessonView[] | null {
  if (!isPlainObject(body) || body.success !== true || !Array.isArray(body.lessons)) return null;
  const lessons: FeedLessonView[] = [];
  for (const item of body.lessons) {
    const lesson = parseFeedLesson(item);
    if (lesson === null) return null;
    lessons.push(lesson);
  }
  return lessons;
}

/** Reads the 200 body of GET /api/v1/feed/<lesson_id>. Null if it is not the documented shape. */
export function parseLessonResponse(body: unknown): FeedLessonView | null {
  if (!isPlainObject(body) || body.success !== true) return null;
  return parseFeedLesson(body.lesson);
}

export class FeedError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FeedError";
    this.status = status;
  }
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** GET /api/v1/feed. Throws FeedError for any non-success answer or unreadable body. */
export async function loadFeed(fetcher: Fetcher = (input, init) => fetch(input, init), signal?: AbortSignal): Promise<FeedLessonView[]> {
  // Typed loosely: `credentials` and `redirect` are DOM RequestInit fields that Workers' typings omit.
  // No `cache` field: the feed is public, so the browser may keep it for the 30 seconds the server allows.
  const init: Record<string, unknown> = {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "omit",
    redirect: "error",
    ...(signal ? { signal } : {}),
  };
  const response = await fetcher(FEED_PATH, init as RequestInit);
  if (response.status !== 200) throw new FeedError(response.status, `Request failed (${response.status})`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const lessons = parseFeedResponse(body);
  if (lessons === null) throw new FeedError(200, "The service sent an unexpected answer.");
  return lessons;
}

/** The path of one lesson. `id` must already be a UUID (lessonIdFromHash guarantees it). */
export const lessonPath = (id: string) => `${FEED_PATH}/${id}`;

/**
 * GET /api/v1/feed/<lesson_id>[?ref=]: one approved, public lesson, whether or not it is among the newest in the
 * feed. Resolves to null when the service says the lesson is not public (404): unknown, withdrawn, or not yet
 * approved. Any other failure throws FeedError. A ref is forwarded so the service can attribute the visit.
 */
export async function loadLesson(
  id: string,
  ref: string,
  fetcher: Fetcher = (input, init) => fetch(input, init),
  signal?: AbortSignal,
): Promise<FeedLessonView | null> {
  const init: Record<string, unknown> = {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "omit",
    redirect: "error",
    ...(signal ? { signal } : {}),
  };
  const response = await fetcher(withRef(lessonPath(id), ref), init as RequestInit);
  if (response.status === 404) return null;
  if (response.status !== 200) throw new FeedError(response.status, `Request failed (${response.status})`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const lesson = parseLessonResponse(body);
  if (lesson === null) throw new FeedError(200, "The service sent an unexpected answer.");
  return lesson;
}

/** The lesson a `#lesson-<id>` link names, as the page sees it. */
export type LinkedLessonState =
  | { phase: "none" }
  | { phase: "loading"; id: string }
  | { phase: "ready"; id: string; lesson: FeedLessonView }
  | { phase: "missing"; id: string }
  | { phase: "error"; id: string };

/** What to tell the visitor about a failed load. Never includes codes, keys or stack traces. */
export function describeFeedFailure(error: unknown): string {
  if (error instanceof FeedError) {
    if (error.status === 429) return "The feed has been requested too often from this network. Wait a minute and try again.";
    if (error.status === 200) return "The service sent an answer this page cannot read. Try again.";
    if (error.status >= 500) return "The feed is temporarily unavailable. Try again shortly.";
    return "The feed could not be loaded. Try again.";
  }
  return "The feed could not be reached. Check your connection and try again.";
}

// ════════════════════════════════════════════════════════════════════════
// State
// ════════════════════════════════════════════════════════════════════════

export interface FeedState {
  /** loading: first load, nothing to show yet. ready: lessons on screen (refreshing keeps them there). */
  phase: "loading" | "ready" | "error";
  lessons: FeedLessonView[];
  /** A refresh is running over lessons already on screen. */
  refreshing: boolean;
  error: string | null;
  /** The last refresh failed but older lessons are still shown. */
  stale: boolean;
}

export type FeedAction =
  | { type: "start" }
  | { type: "success"; lessons: FeedLessonView[] }
  | { type: "failure"; message: string };

export const initialFeedState: FeedState = { phase: "loading", lessons: [], refreshing: false, error: null, stale: false };

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case "start":
      return state.phase === "ready" ? { ...state, refreshing: true } : { ...initialFeedState };
    case "success":
      return { phase: "ready", lessons: action.lessons, refreshing: false, error: null, stale: false };
    case "failure":
      // Lessons already on screen stay; only a first load that fails becomes the error state.
      return state.lessons.length > 0
        ? { ...state, phase: "ready", refreshing: false, stale: true, error: action.message }
        : { phase: "error", lessons: [], refreshing: false, error: action.message, stale: false };
  }
}
