/**
 * GET /api/v1/feed (public, unsigned): the most recently updated approved lessons, for the landing page.
 *
 * Order: caller network → per-network limit (60/min) → edge cache → D1 → response.
 *
 * Reads D1 only (no embedding, no Vectorize), so it needs no identity and costs nothing per visitor.
 * Each lesson has the same shape /recall serves minus its receipts and attestation: the steering directive,
 * the statutory anchor, the compliant arguments and the changed paths. The upstream rule name or number
 * (lessons.violation_rule) is never selected here, so it cannot reach a public payload. The blocked call's
 * values are never read either. Only lessons with review_status 'approved' and visibility 'public' are returned, so a
 * quarantined or rejected lesson leaves the feed as soon as its cached copy expires (at most 30 seconds, plus
 * the browser's own 30).
 *
 * This is the one /api route that may be cached: it sets `Cache-Control: public, max-age=30`, and the global
 * no-store middleware in app.ts leaves a 200 on this exact path alone.
 *
 * GET /api/v1/feed/<lesson_id> (public, unsigned) serves one lesson by id, so a citation link to any approved
 * lesson stays valid however far down the feed it has moved. Only a lesson that is approved AND public is served;
 * every other id (unknown, pending, rejected, quarantined, retracted) gets the same 404, so the route cannot be
 * used to learn whether a private lesson exists. It is never cached, so a withdrawal takes effect at once. When
 * the request carries a valid `?ref=` it writes one lesson_view telemetry point (hit or miss) for audit-link
 * attribution; without a ref it writes nothing.
 */
import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { apiError } from "../http";
import type { AuthVariables } from "../middleware/auth";
import { callerNetwork } from "../network";
import { FEED_LIMIT, FeedLessonResponse, FeedResponse, MomUuid } from "../schema";
import { recordTelemetry, refFromUrl } from "../telemetry";

export const FEED_PATH = "/api/v1/feed";
/** A single-lesson path under the feed. app.ts lets exactly this shape through unsigned. */
export const FEED_LESSON_PATH = /^\/api\/v1\/feed\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FEED_CACHE_SECONDS = 30;
export const FEED_CACHE_CONTROL = `public, max-age=${FEED_CACHE_SECONDS}`;
/**
 * Version of the cached body's shape. Bump it when the payload changes so a copy cached under the old shape is
 * never read again. (v2: violation_rule removed.)
 */
export const FEED_CACHE_VERSION = "2";

type FeedEnv = { Bindings: Env; Variables: AuthVariables };

export interface FeedOptions {
  /** Edge cache lifetime in seconds. 0 turns the edge cache off (tests, which share one D1 across cases). */
  cacheSeconds?: number;
}

/** One public lesson row, as the feed and the MCP sandbox (src/routes/mcp.ts) read it. */
export interface FeedRow {
  lesson_id: string;
  domain: string;
  tool_name: string;
  changed_paths_json: string;
  display_title: string | null;
  display_summary: string | null;
  featured: number;
  updated_at_ms: number;
  fix_arguments_json: string;
  steering_directive: string | null;
  statutory_anchor: string | null;
}

/**
 * The public columns of an approved, publicly visible lesson. Never the blocked call's values, receipts or
 * attestation. Callers append their own ORDER BY and LIMIT.
 */
export const PUBLIC_LESSON_SQL = `
SELECT l.lesson_id, l.domain, l.tool_name, l.changed_paths_json,
       s.display_title, s.display_summary, s.featured, s.updated_at_ms,
       f.fix_arguments_json,
       e.steering_directive, e.statutory_anchor
  FROM lesson_state s
  JOIN lessons l     ON l.lesson_id = s.lesson_id
  JOIN fixes f       ON f.allow_receipt_id = l.fix_event_id
  JOIN trap_events e ON e.block_receipt_id = l.trap_event_id
 WHERE s.review_status = 'approved' AND s.visibility = 'public'`;

/** Uses lesson_state_by_status (review_status, updated_at_ms); only ties on updated_at_ms are sorted. */
const FEED_SQL = `${PUBLIC_LESSON_SQL}
 ORDER BY s.updated_at_ms DESC, l.lesson_id DESC
 LIMIT ?1`;

export function presentPublicLesson(row: FeedRow) {
  return {
    lesson_id: row.lesson_id,
    domain: row.domain,
    tool: row.tool_name,
    steering_directive: row.steering_directive,
    statutory_anchor: row.statutory_anchor,
    compliant_arguments: JSON.parse(row.fix_arguments_json),
    changed_paths: JSON.parse(row.changed_paths_json),
    display_title: row.display_title,
    display_summary: row.display_summary,
    featured: row.featured === 1,
    updated_at: new Date(row.updated_at_ms).toISOString(),
  };
}

function json(c: Context<FeedEnv>, body: string) {
  c.header("Content-Type", "application/json");
  c.header("Cache-Control", FEED_CACHE_CONTROL);
  return c.body(body, 200);
}

export function createFeedRoutes(options: FeedOptions = {}) {
  const cacheSeconds = options.cacheSeconds ?? FEED_CACHE_SECONDS;
  const feed = new Hono<FeedEnv>();

  feed.get("/", async (c) => {
    let network;
    try {
      network = await callerNetwork(c.req.raw, c.env.IP_HMAC_KEY);
    } catch (error) {
      console.error("achromat-mom feed misconfigured", error instanceof Error ? error.message : error);
      return apiError(c, 503, "SERVICE_MISCONFIGURED", "the feed is temporarily unavailable");
    }
    if (network === null) return apiError(c, 400, "CLIENT_IP_UNAVAILABLE", "caller IP address could not be determined");

    const { success } = await c.env.FEED_LIMITER.limit({ key: `feed:${network.prefixHmac}` });
    if (!success) {
      c.header("Retry-After", "60");
      return apiError(c, 429, "RATE_LIMITED", "too many feed requests from this network; retry in a minute");
    }

    // One cache entry for the whole feed: the key is built here from the path and FEED_CACHE_VERSION, never from
    // the caller's query string, so callers cannot create variants.
    const cacheKey = new Request(new URL(`${FEED_PATH}?v=${FEED_CACHE_VERSION}`, c.req.url).toString());
    const cache = cacheSeconds > 0 ? caches.default : null;
    if (cache) {
      try {
        const hit = await cache.match(cacheKey);
        if (hit) return json(c, await hit.text());
      } catch (error) {
        console.error("achromat-mom feed cache read failed", error instanceof Error ? error.message : error);
      }
    }

    const rows = await c.env.DB.prepare(FEED_SQL).bind(FEED_LIMIT).all<FeedRow>();
    const body = JSON.stringify(FeedResponse.parse({ success: true, lessons: rows.results.map(presentPublicLesson) }));

    if (cache) {
      const store = cache
        .put(cacheKey, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${cacheSeconds}` } }))
        .catch((error: unknown) => console.error("achromat-mom feed cache write failed", error instanceof Error ? error.message : error));
      try {
        c.executionCtx.waitUntil(store);
      } catch {
        await store; // no execution context (a direct call): finish the write before answering
      }
    }
    return json(c, body);
  });

  feed.get("/:lessonId", async (c) => {
    let network;
    try {
      network = await callerNetwork(c.req.raw, c.env.IP_HMAC_KEY);
    } catch (error) {
      console.error("achromat-mom feed misconfigured", error instanceof Error ? error.message : error);
      return apiError(c, 503, "SERVICE_MISCONFIGURED", "the feed is temporarily unavailable");
    }
    if (network === null) return apiError(c, 400, "CLIENT_IP_UNAVAILABLE", "caller IP address could not be determined");

    const { success } = await c.env.FEED_LIMITER.limit({ key: `feed:${network.prefixHmac}` });
    if (!success) {
      c.header("Retry-After", "60");
      return apiError(c, 429, "RATE_LIMITED", "too many feed requests from this network; retry in a minute");
    }

    const lessonId = c.req.param("lessonId").toLowerCase();
    const ref = refFromUrl(c.req.url);
    const row = MomUuid.safeParse(lessonId).success
      ? await c.env.DB.prepare(`${PUBLIC_LESSON_SQL} AND l.lesson_id = ?1`).bind(lessonId).first<FeedRow>()
      : null;

    if (ref !== "") {
      // lessonId matched the strict UUID pattern above, or is not written at all; the ref is a validated slug.
      recordTelemetry(c, {
        action: "lesson_view",
        domain: row?.domain ?? "",
        tool: row?.tool_name ?? "",
        agentKey: null,
        status: row === null ? "miss" : "hit",
        ref,
        detail: MomUuid.safeParse(lessonId).success ? lessonId : "",
        index: "lesson_view",
      });
    }
    if (row === null) return apiError(c, 404, "LESSON_NOT_FOUND", "lesson is not public");
    return c.json(FeedLessonResponse.parse({ success: true, lesson: presentPublicLesson(row) }));
  });

  return feed;
}
