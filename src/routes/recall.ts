/**
 * POST /api/v1/recall: thresholded point recall. The signature is OPTIONAL (src/app.ts OPTIONAL_SIGNATURE_ROUTES).
 *
 * POST rather than GET because the request carries `arguments` (their key paths
 * feed the query embedding) and a GET cannot have a body.
 *
 * Two callers, one lookup (findLesson):
 *
 *   SIGNED   a request with Achromat-* headers, verified by requireAgentSignature before this handler runs. A request
 *            with ANY such header is never treated as anonymous, so a bad signature is a 401, not a downgrade.
 *            Order: secrets → per-agent limit (240/h) → body → domain → exact tier (D1) → semantic tier (embed →
 *            Vectorize → D1 re-check → cutoff) → daily distinct-lesson budget (50) → hydrate → response.
 *            Sees public (approved) lessons and the caller's own pending lessons. Gets receipts and attestation.
 *
 *   ANONYMOUS  a request with no Achromat-* header at all (handleAnonymousRecall). Order: caller network → per-network
 *            limit (30/min) → global hourly cap → body → domain → the same lookup restricted to PUBLIC lessons →
 *            response. It gets the public feed's fields only: no receipts, no attestation, no pending lesson of anyone.
 *            It has no key, so no delivery budget and no lesson_deliveries row. A miss is logged to domain_demand by
 *            fingerprint only (never the task text) under a network-derived id.
 *
 * At most ONE lesson is returned per call.
 *
 * Isolation: a lesson is visible to a caller only if lesson_state.visibility is
 * 'public' (approved) or the caller's own HMAC token (their pending_review lesson).
 * Vectorize filters on it, and D1 checks it again for every hit, so a stale vector
 * of a rejected or quarantined lesson is never served. The blocked call's
 * arguments and the upstream rule name (lessons.violation_rule) are never read here.
 *
 * Tool names match exactly (domain, tool). A tool the service holds no lesson for is a miss, and the miss reason
 * (MISS_REASONS in src/telemetry.ts) says so.
 */
import { Hono, type Context } from "hono";
import { bundleForDomain } from "../config/domains";
import { demandHmac, visibilityToken } from "../crypto/attestation";
import type { Env } from "../env";
import { apiError, parseJsonBytes, readBodyBytes } from "../http";
import type { AuthVariables } from "../middleware/auth";
import { callerNetwork } from "../network";
import { AnonymousRecallResponse, QueryRequest, RecallResponse, taskFingerprint, toValidationFailure } from "../schema";
import { embedOne } from "../search/embed";
import { buildQueryText } from "../search/intent";
import type { SearchFactory, VectorMatch } from "../search/vectors";
import { clientLabel, recordTelemetry, refFromUrl, type MissReason, type TelemetryStatus } from "../telemetry";
import { DAY_MS, HOUR_MS, consumeUsage, secondsUntil } from "../usage";

export const RECALL_LIMIT_PER_AGENT_PER_HOUR = 240;
/** Distinct lessons first served to one key (other than its own) per rolling 24 hours. */
export const RECALL_DAILY_DISTINCT_LESSONS = 50;
export const RECALL_TOP_K = 5;
/** Cosine similarity cutoff. Provisional (decision D3): tune on the seeded corpus. */
export const RECALL_MIN_SCORE = 0.82;
/** Unsigned recalls per network per minute. The allowance is the binding's (wrangler.toml RECALL_ANON_LIMITER). */
export const RECALL_ANON_LIMIT_PER_NETWORK_PER_MINUTE = 30;
/**
 * Unsigned recalls per hour across every caller. A ceiling on what anonymous traffic can cost in Workers AI and
 * Vectorize, shared by all networks. Signed recalls are unaffected. Deliberately not written in any public document.
 */
export const RECALL_ANON_GLOBAL_PER_HOUR = 3000;
export const RECALL_ANON_GLOBAL_KEY = "recall:anon:global";
/** The signed-body cap, which the anonymous path applies too. */
const MAX_BODY_BYTES = 64 * 1024;
/**
 * domain_demand.task_description is NOT NULL and 16 to 1000 characters, so an anonymous miss stores this fixed text in
 * its place. The caller's words are never written to D1 for an anonymous request; only the fingerprint is.
 */
export const ANONYMOUS_DEMAND_TEXT = "[anonymous caller: task text not stored]";

export function recallUsageKey(agentKey: string): string {
  return `recall:agent:${agentKey}`;
}

type RecallEnv = { Bindings: Env; Variables: AuthVariables };

export interface RecallOptions {
  search: SearchFactory;
  /** Test hook. Production uses RECALL_DAILY_DISTINCT_LESSONS. */
  dailyDistinctLessons?: number;
}

export function createRecallRoutes(options: RecallOptions) {
  const recall = new Hono<RecallEnv>();
  // The two handlers answer with different typed bodies (RecallResponse, AnonymousRecallResponse); both are plain Responses.
  recall.post("/", (c): Promise<Response> => (c.get("anonymous_caller") === true ? handleAnonymousRecall(c, options) : handleRecall(c, options)));
  return recall;
}

interface Candidate {
  lesson_id: string;
  source_agent_key: string;
  review_status: string;
}

interface Hydrated {
  lesson_id: string;
  domain: string;
  tool_name: string;
  changed_paths_json: string;
  pair_attestation: string;
  attestation_kid: string;
  review_status: string;
  fix_arguments_json: string;
  allow_receipt_id: string;
  allow_signature: string;
  block_receipt_id: string;
  block_signature: string;
  steering_directive: string | null;
  statutory_anchor: string | null;
}

type Delivery = "ok" | "exhausted" | "unavailable";

/** Whose lessons a lookup may see: public ones plus the signed caller's own token, or public ones only. */
type Visibility = { kind: "agent"; token: string } | { kind: "public" };

async function claimDelivery(
  env: Env,
  agentKey: string,
  candidate: Candidate,
  nowMs: number,
  limit: number,
): Promise<Delivery> {
  const served = () =>
    env.DB.prepare("SELECT 1 AS served FROM lesson_deliveries WHERE agent_key = ?1 AND lesson_id = ?2")
      .bind(agentKey, candidate.lesson_id)
      .first();
  try {
    if (await served()) return "ok"; // repeat hits are free
    if (candidate.source_agent_key === agentKey) {
      await env.DB.prepare("INSERT OR IGNORE INTO lesson_deliveries (agent_key, lesson_id, first_served_at_ms) VALUES (?1, ?2, ?3)")
        .bind(agentKey, candidate.lesson_id, nowMs)
        .run();
      return "ok";
    }
    // Atomic check-and-claim: the count and the insert are one statement, so concurrent
    // calls cannot both take the last slot. The key's own lessons never count.
    const claimed = await env.DB.prepare(
      `INSERT OR IGNORE INTO lesson_deliveries (agent_key, lesson_id, first_served_at_ms)
       SELECT ?1, ?2, ?3
        WHERE (SELECT count(*) FROM lesson_deliveries d JOIN lessons dl ON dl.lesson_id = d.lesson_id
                WHERE d.agent_key = ?1 AND d.first_served_at_ms > ?4 AND dl.source_agent_key <> ?1) < ?5`,
    )
      .bind(agentKey, candidate.lesson_id, nowMs, nowMs - DAY_MS, limit)
      .run();
    if (claimed.meta.changes > 0) return "ok";
    return (await served()) ? "ok" : "exhausted";
  } catch (error) {
    // The delivery guard refuses lessons that are no longer visible to anyone.
    console.error("achromat-mom recall delivery failed", error instanceof Error ? error.message : error);
    return "unavailable";
  }
}

function hydrate(env: Env, lessonId: string): Promise<Hydrated | null> {
  return env.DB.prepare(
    `SELECT l.lesson_id, l.domain, l.tool_name, l.changed_paths_json, l.pair_attestation, l.attestation_kid,
            s.review_status,
            f.fix_arguments_json, f.allow_receipt_id, f.receipt_signature AS allow_signature,
            e.block_receipt_id, e.receipt_signature AS block_signature, e.steering_directive, e.statutory_anchor
       FROM lessons l
       JOIN lesson_state s ON s.lesson_id = l.lesson_id
       JOIN fixes f ON f.allow_receipt_id = l.fix_event_id
       JOIN trap_events e ON e.block_receipt_id = l.trap_event_id
      WHERE l.lesson_id = ?1`,
  )
    .bind(lessonId)
    .first<Hydrated>();
}

/**
 * Records a recall that found nothing in the demand radar. `callerId` is already a pseudonym (an HMAC of the agent key,
 * or of the caller's network for an anonymous request). `description` is the task text for a signed caller and
 * ANONYMOUS_DEMAND_TEXT for an anonymous one.
 */
async function logMiss(env: Env, args: {
  callerSeed: string;
  domain: string;
  tool: string;
  fingerprint: string;
  description: string;
  nearest: number | null;
  nowMs: number;
}): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO domain_demand
         (miss_id, hour_bucket, domain, tool_name, task_fingerprint, task_description, agent_key_hmac, nearest_score, created_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        crypto.randomUUID(),
        Math.floor(args.nowMs / HOUR_MS),
        args.domain,
        args.tool,
        args.fingerprint,
        args.description,
        await demandHmac(env.VISIBILITY_KEY, args.callerSeed),
        args.nearest,
        args.nowMs,
      )
      .run();
  } catch (error) {
    console.error("achromat-mom demand log failed", error instanceof Error ? error.message : error);
  }
}

/** Why a miss missed. Never throws: a failed check falls back to what the search already told us. */
async function missReason(env: Env, domain: string, tool: string, nearest: number | null): Promise<MissReason> {
  try {
    const held = await env.DB.prepare(
      `SELECT 1 AS held FROM lessons l JOIN lesson_state s ON s.lesson_id = l.lesson_id
        WHERE l.domain = ?1 AND l.tool_name = ?2 AND s.visibility = 'public' LIMIT 1`,
    )
      .bind(domain, tool)
      .first();
    if (held === null) return "tool_unknown";
  } catch (error) {
    console.error("achromat-mom miss reason failed", error instanceof Error ? error.message : error);
  }
  return nearest === null ? "no_candidate" : "below_threshold";
}

type Lookup =
  | { kind: "found"; candidate: Candidate; tier: "exact" | "semantic"; score: number }
  | { kind: "none"; nearest: number | null }
  | { kind: "unavailable" };

/**
 * The one lookup: exact tier (same domain, tool and normalised task), then the semantic tier. `visibility` is the only
 * thing that differs between a signed and an anonymous caller. Exact needs no embedding, and serves the
 * submitter's own pending pair as soon as triage has made it visible (signed callers only).
 */
async function findLesson(
  env: Env,
  options: RecallOptions,
  body: QueryRequest,
  fingerprint: string,
  visibility: Visibility,
): Promise<Lookup> {
  const exactVisible = visibility.kind === "agent" ? "s.visibility IN ('public', ?4)" : "s.visibility = 'public'";
  const exactBinds = visibility.kind === "agent" ? [body.domain, body.tool, fingerprint, visibility.token] : [body.domain, body.tool, fingerprint];
  const exact = await env.DB.prepare(
    `SELECT l.lesson_id, l.source_agent_key, s.review_status
       FROM lessons l JOIN lesson_state s ON s.lesson_id = l.lesson_id
      WHERE l.domain = ?1 AND l.tool_name = ?2 AND l.task_fingerprint = ?3 AND ${exactVisible}
      ORDER BY (s.review_status = 'approved') DESC, l.created_at_ms ASC
      LIMIT 1`,
  )
    .bind(...exactBinds)
    .first<Candidate>();
  if (exact !== null) return { kind: "found", candidate: exact, tier: "exact", score: 1 };

  const search = options.search(env);
  const filterVisibility = visibility.kind === "agent" ? ["public", visibility.token] : ["public"];
  let matches: VectorMatch[];
  try {
    const vector = await embedOne(search.embedder, (scale) =>
      buildQueryText({ taskDescription: body.task_description, requestArguments: body.arguments }, scale),
    );
    matches = await search.vectors.query(vector, {
      namespace: body.domain,
      topK: RECALL_TOP_K,
      filter: { tool_name: { $eq: body.tool }, visibility: { $in: filterVisibility } },
    });
  } catch (error) {
    console.error("achromat-mom recall search failed", error instanceof Error ? error.message : error);
    return { kind: "unavailable" };
  }

  // Re-check every hit in D1: Vectorize is eventually consistent and may still hold a lesson that
  // has since been rejected or quarantined, or one that is not this caller's to see.
  const ids = matches.map((match) => match.id).slice(0, RECALL_TOP_K);
  const visible = new Map<string, Candidate>();
  if (ids.length > 0) {
    const visibleSql = visibility.kind === "agent" ? `s.visibility IN ('public', ?${ids.length + 3})` : "s.visibility = 'public'";
    const binds = visibility.kind === "agent" ? [...ids, body.domain, body.tool, visibility.token] : [...ids, body.domain, body.tool];
    const rows = await env.DB.prepare(
      `SELECT l.lesson_id, l.source_agent_key, s.review_status
         FROM lessons l JOIN lesson_state s ON s.lesson_id = l.lesson_id
        WHERE l.lesson_id IN (${ids.map((_, i) => `?${i + 1}`).join(", ")})
          AND l.domain = ?${ids.length + 1} AND l.tool_name = ?${ids.length + 2}
          AND ${visibleSql}`,
    )
      .bind(...binds)
      .all<Candidate>();
    for (const row of rows.results) visible.set(row.lesson_id, row);
  }

  const usable = matches
    .filter((match) => visible.has(match.id))
    .sort((a, b) => b.score - a.score || Number(visible.get(b.id)!.review_status === "approved") - Number(visible.get(a.id)!.review_status === "approved"));
  const nearest = usable[0]?.score ?? null;
  const best = usable.find((match) => match.score >= RECALL_MIN_SCORE);
  if (best) return { kind: "found", candidate: visible.get(best.id)!, tier: "semantic", score: best.score };
  return { kind: "none", nearest };
}

async function handleRecall(c: Context<RecallEnv>, options: RecallOptions) {
  const env = c.env;
  const agent = c.get("agent");

  let token: string;
  try {
    token = await visibilityToken(env.VISIBILITY_KEY, agent.agentKey);
  } catch (error) {
    console.error("achromat-mom recall misconfigured", error instanceof Error ? error.message : error);
    return apiError(c, 503, "SERVICE_MISCONFIGURED", "recall is temporarily unavailable");
  }

  const usage = await consumeUsage(env, recallUsageKey(agent.agentKey), RECALL_LIMIT_PER_AGENT_PER_HOUR);
  if (!usage.allowed) {
    c.header("Retry-After", secondsUntil(usage.resetAtMs));
    return apiError(c, 429, "RATE_LIMITED", `at most ${RECALL_LIMIT_PER_AGENT_PER_HOUR} recalls per hour per agent key`);
  }

  const parsed = QueryRequest.safeParse(parseJsonBytes(c.get("raw_body")));
  if (!parsed.success) {
    const failure = toValidationFailure(parsed.error);
    return apiError(c, 400, failure.code, "recall body is invalid", failure.details);
  }
  const body = parsed.data;
  if (bundleForDomain(body.domain) === null) {
    return apiError(c, 400, "DOMAIN_UNKNOWN", "domain is not served", [{ path: "domain", message: "unknown domain" }]);
  }

  const nowMs = Date.now();
  const fingerprint = await taskFingerprint(body.task_description);
  const dailyLimit = options.dailyDistinctLessons ?? RECALL_DAILY_DISTINCT_LESSONS;

  const lookup = await findLesson(env, options, body, fingerprint, { kind: "agent", token });
  if (lookup.kind === "unavailable") return apiError(c, 503, "SEARCH_UNAVAILABLE", "semantic search is temporarily unavailable; retry shortly");

  const client = clientLabel(c.req.raw);
  const track = (status: TelemetryStatus, detail?: MissReason) =>
    recordTelemetry(c, { action: "recall", domain: body.domain, tool: body.tool, agentKey: agent.agentKey, status, detail: detail ?? "", client });

  if (lookup.kind === "none") {
    await logMiss(env, { callerSeed: agent.agentKey, domain: body.domain, tool: body.tool, fingerprint, description: body.task_description, nearest: lookup.nearest, nowMs });
    track("miss", await missReason(env, body.domain, body.tool, lookup.nearest));
    return c.json(RecallResponse.parse({ success: true, match: false }));
  }
  const { candidate, tier, score } = lookup;

  const delivery = await claimDelivery(env, agent.agentKey, candidate, nowMs, dailyLimit);
  if (delivery === "exhausted") {
    track("budget_exhausted");
    return c.json(RecallResponse.parse({ success: true, match: false, budget_exhausted: true }));
  }
  if (delivery === "unavailable") {
    track("miss");
    return c.json(RecallResponse.parse({ success: true, match: false }));
  }

  const row = await hydrate(env, candidate.lesson_id);
  if (row === null) {
    track("miss");
    return c.json(RecallResponse.parse({ success: true, match: false }));
  }

  track("hit");
  return c.json(
    RecallResponse.parse({
      success: true,
      match: true,
      tier,
      score,
      lesson: {
        lesson_id: row.lesson_id,
        review_status: row.review_status === "approved" ? "approved" : "pending",
        domain: row.domain,
        tool: row.tool_name,
        steering_directive: row.steering_directive,
        statutory_anchor: row.statutory_anchor,
        compliant_arguments: JSON.parse(row.fix_arguments_json),
        changed_paths: JSON.parse(row.changed_paths_json),
        block_receipt: { id: row.block_receipt_id, signature: row.block_signature },
        allow_receipt: { id: row.allow_receipt_id, signature: row.allow_signature },
        pair_attestation: row.pair_attestation,
        attestation_kid: row.attestation_kid,
      },
    }),
  );
}

/**
 * The anonymous path: no key, no signature, no identity. Everything that costs something is limited first, and the
 * only lessons it can see are public (approved) ones, in the public feed's shape.
 */
async function handleAnonymousRecall(c: Context<RecallEnv>, options: RecallOptions) {
  const env = c.env;
  const ref = refFromUrl(c.req.url);
  const client = clientLabel(c.req.raw);
  const track = (status: TelemetryStatus, domain = "", tool = "", detail?: MissReason) =>
    recordTelemetry(c, { action: "recall_unsigned", domain, tool, agentKey: null, status, ref, detail: detail ?? "", client });

  let network;
  try {
    network = await callerNetwork(c.req.raw, env.IP_HMAC_KEY);
  } catch (error) {
    console.error("achromat-mom recall misconfigured", error instanceof Error ? error.message : error);
    return apiError(c, 503, "SERVICE_MISCONFIGURED", "recall is temporarily unavailable");
  }
  if (network === null) return apiError(c, 400, "CLIENT_IP_UNAVAILABLE", "caller IP address could not be determined");

  const { success } = await env.RECALL_ANON_LIMITER.limit({ key: `recall-anon:${network.prefixHmac}` });
  if (!success) {
    track("rate_limited");
    c.header("Retry-After", "60");
    return apiError(c, 429, "RATE_LIMITED", `at most ${RECALL_ANON_LIMIT_PER_NETWORK_PER_MINUTE} unsigned recalls per minute per network; retry in a minute, or sign your requests with a registered key`);
  }
  const shared = await consumeUsage(env, RECALL_ANON_GLOBAL_KEY, RECALL_ANON_GLOBAL_PER_HOUR);
  if (!shared.allowed) {
    track("rate_limited");
    c.header("Retry-After", secondsUntil(shared.resetAtMs));
    return apiError(c, 429, "RATE_LIMITED", "unsigned recall is busy right now; retry later, or sign your requests with a registered key");
  }

  const bytes = await readBodyBytes(c.req.raw, MAX_BODY_BYTES);
  if (bytes === null) return apiError(c, 413, "BODY_TOO_LARGE", `request body must be at most ${MAX_BODY_BYTES} bytes`);
  const parsed = QueryRequest.safeParse(parseJsonBytes(bytes));
  if (!parsed.success) {
    const failure = toValidationFailure(parsed.error);
    return apiError(c, 400, failure.code, "recall body is invalid", failure.details);
  }
  const body = parsed.data;
  if (bundleForDomain(body.domain) === null) {
    return apiError(c, 400, "DOMAIN_UNKNOWN", "domain is not served", [{ path: "domain", message: "unknown domain" }]);
  }

  const nowMs = Date.now();
  const fingerprint = await taskFingerprint(body.task_description);
  const lookup = await findLesson(env, options, body, fingerprint, { kind: "public" });
  if (lookup.kind === "unavailable") return apiError(c, 503, "SEARCH_UNAVAILABLE", "semantic search is temporarily unavailable; retry shortly");

  const miss = async (nearest: number | null) => {
    // The caller's words are not stored: the fingerprint identifies the task, ANONYMOUS_DEMAND_TEXT fills the column.
    await logMiss(env, { callerSeed: `network:${network.prefixHmac}`, domain: body.domain, tool: body.tool, fingerprint, description: ANONYMOUS_DEMAND_TEXT, nearest, nowMs });
    track("miss", body.domain, body.tool, await missReason(env, body.domain, body.tool, nearest));
    return c.json(AnonymousRecallResponse.parse({ success: true, match: false }));
  };
  if (lookup.kind === "none") return miss(lookup.nearest);

  const row = await hydrate(env, lookup.candidate.lesson_id);
  // Public visibility means approved; a row that says otherwise is not served.
  if (row === null || row.review_status !== "approved") return miss(null);

  track("hit", body.domain, body.tool);
  // Only the public fields are copied out of the hydrated row: its receipts and attestation never leave this function.
  return c.json(
    AnonymousRecallResponse.parse({
      success: true,
      match: true,
      tier: lookup.tier,
      score: lookup.score,
      lesson: {
        lesson_id: row.lesson_id,
        review_status: "approved",
        domain: row.domain,
        tool: row.tool_name,
        steering_directive: row.steering_directive,
        statutory_anchor: row.statutory_anchor,
        compliant_arguments: JSON.parse(row.fix_arguments_json),
        changed_paths: JSON.parse(row.changed_paths_json),
      },
    }),
  );
}
