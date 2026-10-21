/**
 * GET /api/v1/search?domain=X&q=Y (public, unsigned): natural-language search over approved lessons, for the
 * landing page. It needs no identity, no proof of work and no signature.
 *
 * Order: caller network → per-network limit (30/min) → query string → embed q → Vectorize → D1 re-check → response.
 *
 * Unlike POST /api/v1/recall, the caller names no tool and sends no arguments, so Vectorize is queried by domain
 * namespace and the visibility gate alone. The gate is strictly `public`: a pending lesson is private to its
 * submitter and is never served here, because nothing identifies the caller. Every hit is re-checked in D1
 * (PUBLIC_LESSON_SQL: approved and public), so a stale vector of a rejected or quarantined lesson is never served.
 *
 * Each result has the public feed's shape: no receipts, no attestation, no values of the blocked call and no
 * submitter. The question itself is embedded and then dropped: it is not stored, logged or counted as demand.
 */
import { Hono, type Context } from "hono";
import { bundleForDomain } from "../config/domains";
import type { Env } from "../env";
import { apiError, queryParams } from "../http";
import type { AuthVariables } from "../middleware/auth";
import { callerNetwork } from "../network";
import { DomainSlug, SEARCH_LIMIT, SearchResponse, normaliseTaskDescription } from "../schema";
import { embedOne } from "../search/embed";
import { buildQueryText } from "../search/intent";
import type { SearchFactory, VectorMatch } from "../search/vectors";
import { PUBLIC_LESSON_SQL, presentPublicLesson, type FeedRow } from "./feed";

export const SEARCH_PATH = "/api/v1/search";
export const SEARCH_LIMIT_PER_NETWORK_PER_MINUTE = 30;
/** Characters of the normalised question (code points). The embedding clips it to its token budget anyway. */
export const SEARCH_QUERY_MIN_CHARACTERS = 3;
export const SEARCH_QUERY_MAX_CHARACTERS = 300;
/**
 * Cosine similarity cutoff for a free-text question. Lower than recall's 0.82 (decision D3), which is tuned for a
 * task description matched against a lesson's own: a short question scores lower against the same lesson.
 * Provisional: tune on the seeded corpus.
 */
export const SEARCH_MIN_SCORE = 0.55;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;
const ALLOWED_PARAMETERS: ReadonlySet<string> = new Set(["domain", "q"]);

type SearchEnv = { Bindings: Env; Variables: AuthVariables };

export interface SearchOptions {
  search: SearchFactory;
}

export function createSearchRoutes(options: SearchOptions) {
  const search = new Hono<SearchEnv>();
  search.get("/", (c) => handleSearch(c, options));
  return search;
}

function invalid(c: Context<SearchEnv>, path: string, message: string) {
  return apiError(c, 400, "INVALID_REQUEST", "search query is invalid", [{ path, message }]);
}

async function handleSearch(c: Context<SearchEnv>, options: SearchOptions) {
  let network;
  try {
    network = await callerNetwork(c.req.raw, c.env.IP_HMAC_KEY);
  } catch (error) {
    console.error("achromat-mom search misconfigured", error instanceof Error ? error.message : error);
    return apiError(c, 503, "SERVICE_MISCONFIGURED", "search is temporarily unavailable");
  }
  if (network === null) return apiError(c, 400, "CLIENT_IP_UNAVAILABLE", "caller IP address could not be determined");

  const { success } = await c.env.SEARCH_LIMITER.limit({ key: `search:${network.prefixHmac}` });
  if (!success) {
    c.header("Retry-After", "60");
    return apiError(c, 429, "RATE_LIMITED", `at most ${SEARCH_LIMIT_PER_NETWORK_PER_MINUTE} searches per minute per network; retry in a minute`);
  }

  const params = queryParams(c.req.url);
  if (params === null) return invalid(c, "query", "each parameter may appear only once");
  for (const name of Object.keys(params)) {
    if (!ALLOWED_PARAMETERS.has(name)) return invalid(c, name, "unknown parameter");
  }

  const domain = params.domain ?? "";
  if (!DomainSlug.safeParse(domain).success || bundleForDomain(domain) === null) {
    return apiError(c, 400, "DOMAIN_UNKNOWN", "domain is not served", [{ path: "domain", message: "unknown domain" }]);
  }

  const question = normaliseTaskDescription(params.q ?? "");
  const length = [...question].length;
  if (length < SEARCH_QUERY_MIN_CHARACTERS) return invalid(c, "q", `q must be at least ${SEARCH_QUERY_MIN_CHARACTERS} characters`);
  if (length > SEARCH_QUERY_MAX_CHARACTERS) return invalid(c, "q", `q must be at most ${SEARCH_QUERY_MAX_CHARACTERS} characters`);
  if (CONTROL_CHARACTERS.test(question)) return invalid(c, "q", "q must not contain control characters");

  const deps = options.search(c.env);
  let matches: VectorMatch[];
  try {
    const vector = await embedOne(deps.embedder, (scale) => buildQueryText({ taskDescription: question, requestArguments: {} }, scale));
    matches = await deps.vectors.query(vector, {
      namespace: domain,
      topK: SEARCH_LIMIT,
      filter: { visibility: { $in: ["public"] } },
    });
  } catch (error) {
    console.error("achromat-mom search failed", error instanceof Error ? error.message : error);
    return apiError(c, 503, "SEARCH_UNAVAILABLE", "search is temporarily unavailable; retry shortly");
  }

  const hits = matches.filter((match) => match.score >= SEARCH_MIN_SCORE).slice(0, SEARCH_LIMIT);
  const rows = new Map<string, FeedRow>();
  if (hits.length > 0) {
    const found = await c.env.DB.prepare(
      `${PUBLIC_LESSON_SQL}
         AND l.domain = ?1 AND l.lesson_id IN (${hits.map((_, i) => `?${i + 2}`).join(", ")})`,
    )
      .bind(domain, ...hits.map((match) => match.id))
      .all<FeedRow>();
    for (const row of found.results) rows.set(row.lesson_id, row);
  }

  const results = hits
    .filter((match) => rows.has(match.id))
    .sort((a, b) => b.score - a.score)
    .map((match) => ({ score: match.score, lesson: presentPublicLesson(rows.get(match.id)!) }));
  return c.json(SearchResponse.parse({ success: true, results }));
}
