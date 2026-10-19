/**
 * POST /api/v1/recall (signed): thresholded point recall.
 *
 * POST rather than GET because the request carries `arguments` (their key paths
 * feed the query embedding) and a GET cannot have a body.
 *
 * Order: secrets → per-agent limit (240/h) → body → domain → exact tier (D1) →
 * semantic tier (embed → Vectorize → D1 re-check → cutoff) → daily distinct-lesson
 * budget (50) → hydrate → response. At most ONE lesson is returned per call.
 *
 * Isolation: a lesson is visible to a caller only if lesson_state.visibility is
 * 'public' (approved) or the caller's own HMAC token (their pending_review lesson).
 * Vectorize filters on it, and D1 checks it again for every hit, so a stale vector
 * of a rejected or quarantined lesson is never served. The blocked call's
 * arguments are never read here.
 */
import { Hono, type Context } from "hono";
import { bundleForDomain } from "../config/domains";
import { demandHmac, visibilityToken } from "../crypto/attestation";
import type { Env } from "../env";
import { apiError, parseJsonBytes } from "../http";
import type { AuthVariables } from "../middleware/auth";
import { QueryRequest, RecallResponse, taskFingerprint, toValidationFailure } from "../schema";
import { embedOne } from "../search/embed";
import { buildQueryText } from "../search/intent";
import type { SearchFactory, VectorMatch } from "../search/vectors";
import { DAY_MS, HOUR_MS, consumeUsage, secondsUntil } from "../usage";

export const RECALL_LIMIT_PER_AGENT_PER_HOUR = 240;
/** Distinct lessons first served to one key (other than its own) per rolling 24 hours. */
export const RECALL_DAILY_DISTINCT_LESSONS = 50;
export const RECALL_TOP_K = 5;
/** Cosine similarity cutoff. Provisional (decision D3): tune on the seeded corpus. */
export const RECALL_MIN_SCORE = 0.82;

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
  recall.post("/", (c) => handleRecall(c, options));
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
  violation_rule: string;
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
    `SELECT l.lesson_id, l.domain, l.tool_name, l.violation_rule, l.changed_paths_json, l.pair_attestation, l.attestation_kid,
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

async function logMiss(env: Env, args: {
  agentKey: string;
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
        await demandHmac(env.VISIBILITY_KEY, args.agentKey),
        args.nearest,
        args.nowMs,
      )
      .run();
  } catch (error) {
    console.error("achromat-mom demand log failed", error instanceof Error ? error.message : error);
  }
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

  // Exact tier: same domain, tool and normalised task. Needs no embedding, and serves the
  // submitter's own pending pair as soon as triage has made it visible.
  let candidate: Candidate | null = await env.DB.prepare(
    `SELECT l.lesson_id, l.source_agent_key, s.review_status
       FROM lessons l JOIN lesson_state s ON s.lesson_id = l.lesson_id
      WHERE l.domain = ?1 AND l.tool_name = ?2 AND l.task_fingerprint = ?3 AND s.visibility IN ('public', ?4)
      ORDER BY (s.review_status = 'approved') DESC, l.created_at_ms ASC
      LIMIT 1`,
  )
    .bind(body.domain, body.tool, fingerprint, token)
    .first<Candidate>();
  let tier: "exact" | "semantic" = "exact";
  let score = 1;
  let nearest: number | null = null;

  if (candidate === null) {
    const search = options.search(env);
    let matches: VectorMatch[];
    try {
      const vector = await embedOne(search.embedder, (scale) =>
        buildQueryText({ taskDescription: body.task_description, requestArguments: body.arguments }, scale),
      );
      matches = await search.vectors.query(vector, {
        namespace: body.domain,
        topK: RECALL_TOP_K,
        filter: { tool_name: { $eq: body.tool }, visibility: { $in: ["public", token] } },
      });
    } catch (error) {
      console.error("achromat-mom recall search failed", error instanceof Error ? error.message : error);
      return apiError(c, 503, "SEARCH_UNAVAILABLE", "semantic search is temporarily unavailable; retry shortly");
    }

    // Re-check every hit in D1: Vectorize is eventually consistent and may still hold a lesson that
    // has since been rejected or quarantined, or one that is not this caller's to see.
    const ids = matches.map((match) => match.id).slice(0, RECALL_TOP_K);
    const visible = new Map<string, Candidate>();
    if (ids.length > 0) {
      const rows = await env.DB.prepare(
        `SELECT l.lesson_id, l.source_agent_key, s.review_status
           FROM lessons l JOIN lesson_state s ON s.lesson_id = l.lesson_id
          WHERE l.lesson_id IN (${ids.map((_, i) => `?${i + 1}`).join(", ")})
            AND l.domain = ?${ids.length + 1} AND l.tool_name = ?${ids.length + 2}
            AND s.visibility IN ('public', ?${ids.length + 3})`,
      )
        .bind(...ids, body.domain, body.tool, token)
        .all<Candidate>();
      for (const row of rows.results) visible.set(row.lesson_id, row);
    }

    const usable = matches
      .filter((match) => visible.has(match.id))
      .sort((a, b) => b.score - a.score || Number(visible.get(b.id)!.review_status === "approved") - Number(visible.get(a.id)!.review_status === "approved"));
    nearest = usable[0]?.score ?? null;
    const best = usable.find((match) => match.score >= RECALL_MIN_SCORE);
    if (best) {
      candidate = visible.get(best.id)!;
      tier = "semantic";
      score = best.score;
    }
  }

  if (candidate === null) {
    await logMiss(env, { agentKey: agent.agentKey, domain: body.domain, tool: body.tool, fingerprint, description: body.task_description, nearest, nowMs });
    return c.json(RecallResponse.parse({ success: true, match: false }));
  }

  const delivery = await claimDelivery(env, agent.agentKey, candidate, nowMs, dailyLimit);
  if (delivery === "exhausted") {
    return c.json(RecallResponse.parse({ success: true, match: false, budget_exhausted: true }));
  }
  if (delivery === "unavailable") return c.json(RecallResponse.parse({ success: true, match: false }));

  const row = await hydrate(env, candidate.lesson_id);
  if (row === null) return c.json(RecallResponse.parse({ success: true, match: false }));

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
        violation_rule: row.violation_rule,
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
