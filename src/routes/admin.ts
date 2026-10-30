/**
 * Admin review API (signed, admin role only).
 *
 *   GET  /api/v1/admin/pending  the review queue: full trap/fix pair context for each lesson
 *   POST /api/v1/admin/review   approve, reject or quarantine (retract) one lesson
 *   POST /api/v1/admin/seed     write up to 10 receipt-verified BLOCK/ALLOW pairs as approved lessons
 *                               (src/review/seed.ts)
 *   GET  /api/v1/admin/telemetry  the activation funnel by ref over a trailing window (?window=24h|7d, default 7d),
 *                               read from Analytics Engine through the Cloudflare SQL API (src/analytics-query.ts).
 *                               Needs CLOUDFLARE_ACCOUNT_ID and the ANALYTICS_API_TOKEN secret; answers 503 without them.
 *
 * Access: app.ts puts every /api/v1 route behind the Ed25519 signed-request middleware, then this
 * router's requireAdminIdentity() requires an active admin key (agent_state role + the insert-only
 * agent_identities record), and a per-key hourly budget bounds how fast a key can read the queue.
 *
 * A review decision is exactly ONE row in the append-only review_events table. The review_events
 * triggers (migrations/0001_event_ledger.sql) own everything else, in the same statement:
 *   approve → lesson_state review_status 'approved', visibility 'public', submitter approved_count + 1
 *   reject  → lesson_state review_status 'rejected', visibility 'none',   submitter rejected_count + 1
 *   quarantine → review_status 'quarantined', visibility 'none', featured 0 (from review or from approved;
 *                this is how a live lesson is retracted; reject it afterwards to close it for good)
 * and every visibility change bumps vector_desired_version. This route never writes lesson_state.
 * Vectorize is then brought in line by syncVectors() after the response (upsert replaces the
 * submitter-only `k:` vector with the public one; reject and quarantine delete it), and the 5-minute cron retries
 * whatever that run does not finish.
 *
 * Four-eyes: a key cannot review a lesson it submitted or fixed. Lessons seeded by an admin
 * (provenance 'admin_seed') are exempt, because seeding is an admin act published by admins.
 */
import { Hono } from "hono";
import { AnalyticsQueryError, analyticsConfig, loadTelemetryReport } from "../analytics-query";
import type { Env } from "../env";
import { apiError, parseJsonBytes, queryParams } from "../http";
import { requireAdminIdentity, type AuthVariables } from "../middleware/auth";
import { seedPairs } from "../review/seed";
import { SYNC_BATCH_LIMIT, syncVectors } from "../review/sync";
import { assertPairingSecrets } from "../crypto/attestation";
import { RAMEN_RECEIPT_KEYS } from "../crypto/ramen-key";
import {
  AdminReviewRequest,
  SeedRequest,
  PendingQuery,
  TelemetryQuery,
  decodeCursor,
  encodeCursor,
  sha256Hex,
  toValidationFailure,
} from "../schema";
import type { SearchFactory } from "../search/vectors";
import { consumeUsage, secondsUntil } from "../usage";

export const ADMIN_LIMIT_PER_AGENT_PER_HOUR = 600;

export function adminUsageKey(agentKey: string): string {
  return `admin:agent:${agentKey}`;
}

type AdminEnv = { Bindings: Env; Variables: AuthVariables };

export interface AdminOptions {
  /** Embedder and vector store for the post-review Vectorize sync. */
  search: SearchFactory;
  /** ramen-ai receipt keys by kid, for POST /seed. Default: the pinned production keys. */
  receiptKeys?: Readonly<Record<string, string>>;
}

interface PendingRow {
  lesson_id: string;
  domain: string;
  tool_name: string;
  violation_rule: string;
  provenance: string;
  source_agent_key: string;
  fixed_by_key: string | null;
  created_at_ms: number;
  delta_json: string;
  delta_hash: string;
  changed_paths_json: string;
  review_status: string;
  audit_status: string;
  updated_at_ms: number;
  task_description: string;
  fix_arguments_json: string;
  allow_receipt_id: string;
  fix_source: string;
  block_receipt_id: string;
  trap_arguments_json: string;
  steering_directive: string | null;
  statutory_anchor: string | null;
  rule_ids_json: string | null;
  policy_ids_json: string | null;
  bundle_id: string | null;
  approved_count: number;
  rejected_count: number;
  triage_json: string | null;
  corroborations: number;
}

interface TriageCheck {
  check: string;
  passed: number;
  score: number | null;
  details: unknown;
}

/** The review queue, oldest first. Keyset-paged on (lesson_state.updated_at_ms, lesson_id). */
const PENDING_SQL = `
SELECT l.lesson_id, l.domain, l.tool_name, l.violation_rule, l.provenance, l.source_agent_key, l.fixed_by_key,
       l.created_at_ms, l.delta_json, l.delta_hash, l.changed_paths_json,
       s.review_status, s.audit_status, s.updated_at_ms,
       f.task_description, f.fix_arguments_json, f.allow_receipt_id, f.fix_source,
       e.block_receipt_id, e.trap_arguments_json, e.steering_directive, e.statutory_anchor,
       e.rule_ids_json, e.policy_ids_json, e.bundle_id,
       a.approved_count, a.rejected_count,
       (SELECT json_group_array(json_object('check', t.check_name, 'passed', t.passed,
                                            'score', t.score, 'details', json(t.details_json)))
          FROM triage_checks t WHERE t.lesson_id = l.lesson_id) AS triage_json,
       (SELECT count(*) FROM lesson_corroborations c WHERE c.lesson_id = l.lesson_id) AS corroborations
  FROM lesson_state s
  JOIN lessons l     ON l.lesson_id = s.lesson_id
  JOIN fixes f       ON f.allow_receipt_id = l.fix_event_id
  JOIN trap_events e ON e.block_receipt_id = l.trap_event_id
  JOIN agent_state a ON a.agent_key = l.source_agent_key
 WHERE s.review_status = ?1
   AND (?2 IS NULL OR l.domain = ?2)
   AND (?3 IS NULL OR (s.updated_at_ms, l.lesson_id) > (?3, ?4))
 ORDER BY s.updated_at_ms, l.lesson_id
 LIMIT ?5`;

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function presentLesson(row: PendingRow) {
  const checks = (parseJson(row.triage_json) as TriageCheck[] | null) ?? [];
  return {
    lesson_id: row.lesson_id,
    review_status: row.review_status,
    audit_status: row.audit_status,
    domain: row.domain,
    tool: row.tool_name,
    provenance: row.provenance,
    task_description: row.task_description,
    violation_rule: row.violation_rule,
    steering_directive: row.steering_directive,
    statutory_anchor: row.statutory_anchor,
    bundle_id: row.bundle_id,
    policy_ids: parseJson(row.policy_ids_json),
    rule_ids: parseJson(row.rule_ids_json),
    trap_arguments: parseJson(row.trap_arguments_json),
    fix_arguments: parseJson(row.fix_arguments_json),
    delta: parseJson(row.delta_json),
    delta_hash: row.delta_hash,
    changed_paths: parseJson(row.changed_paths_json),
    triage: checks.map((check) => ({ check: check.check, passed: check.passed === 1, score: check.score, details: check.details })),
    submitter: {
      agent_key: row.source_agent_key,
      approved_count: row.approved_count,
      rejected_count: row.rejected_count,
    },
    fixed_by_key: row.fixed_by_key,
    fix_source: row.fix_source,
    corroborations: row.corroborations,
    block_receipt_id: row.block_receipt_id,
    allow_receipt_id: row.allow_receipt_id,
    created_at: iso(row.created_at_ms),
    queued_at: iso(row.updated_at_ms),
  };
}

interface ReviewTarget {
  provenance: string;
  source_agent_key: string;
  fixed_by_key: string | null;
  review_status: string;
}

export function createAdminRoutes(options: AdminOptions) {
  const admin = new Hono<AdminEnv>();

  admin.use("*", requireAdminIdentity());
  admin.use("*", async (c, next) => {
    const usage = await consumeUsage(c.env, adminUsageKey(c.get("agent").agentKey), ADMIN_LIMIT_PER_AGENT_PER_HOUR);
    if (!usage.allowed) {
      c.header("Retry-After", secondsUntil(usage.resetAtMs));
      return apiError(c, 429, "RATE_LIMITED", `at most ${ADMIN_LIMIT_PER_AGENT_PER_HOUR} admin requests per hour per agent key`);
    }
    await next();
  });

  admin.get("/pending", async (c) => {
    const params = queryParams(c.req.url);
    if (params === null) return apiError(c, 400, "INVALID_REQUEST", "query parameters must not repeat");
    const parsed = PendingQuery.safeParse(params);
    if (!parsed.success) {
      const failure = toValidationFailure(parsed.error);
      return apiError(c, 400, failure.code, "query is invalid", failure.details);
    }
    const query = parsed.data;
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      return apiError(c, 400, "INVALID_REQUEST", "query is invalid", [{ path: "cursor", message: "cursor is not valid" }]);
    }

    const rows = (
      await c.env.DB.prepare(PENDING_SQL)
        .bind(query.status, query.domain ?? null, cursor?.timestampMs ?? null, cursor?.id ?? null, query.limit + 1)
        .all<PendingRow>()
    ).results;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return c.json({
      success: true,
      status: query.status,
      lessons: page.map(presentLesson),
      next_cursor: rows.length > query.limit && last ? encodeCursor(last.updated_at_ms, last.lesson_id) : null,
    });
  });

  /**
   * The activation funnel by ref. Read-only and side-effect free: six flat Analytics Engine SQL queries,
   * merged in the Worker (src/analytics-query.ts). Cloudflare's error text is never relayed.
   */
  admin.get("/telemetry", async (c) => {
    const params = queryParams(c.req.url);
    if (params === null) return apiError(c, 400, "INVALID_REQUEST", "query parameters must not repeat");
    const parsed = TelemetryQuery.safeParse(params);
    if (!parsed.success) {
      const failure = toValidationFailure(parsed.error);
      return apiError(c, 400, failure.code, "query is invalid", failure.details);
    }
    const config = analyticsConfig(c.env);
    if (config === null) {
      console.error("achromat-mom telemetry misconfigured: CLOUDFLARE_ACCOUNT_ID or ANALYTICS_API_TOKEN is missing or malformed");
      return apiError(c, 503, "SERVICE_MISCONFIGURED", "telemetry is temporarily unavailable");
    }
    try {
      return c.json({ success: true, ...(await loadTelemetryReport(config, parsed.data.window)) });
    } catch (error) {
      if (error instanceof AnalyticsQueryError) return apiError(c, error.status, error.code, error.message);
      throw error;
    }
  });

  admin.post("/review", async (c) => {
    const env = c.env;
    const agent = c.get("agent");

    const parsed = AdminReviewRequest.safeParse(parseJsonBytes(c.get("raw_body")));
    if (!parsed.success) {
      const failure = toValidationFailure(parsed.error);
      return apiError(c, 400, failure.code, "review body is invalid", failure.details);
    }
    const body = parsed.data;

    const target = await env.DB.prepare(
      `SELECT l.provenance, l.source_agent_key, l.fixed_by_key, s.review_status
         FROM lessons l JOIN lesson_state s ON s.lesson_id = l.lesson_id
        WHERE l.lesson_id = ?1`,
    )
      .bind(body.lesson_id)
      .first<ReviewTarget>();
    if (target === null) return apiError(c, 404, "LESSON_NOT_FOUND", "lesson does not exist");

    // Four-eyes. Lessons are immutable, so this check cannot race. admin_seed lessons are exempt.
    if (target.provenance !== "admin_seed" && (target.source_agent_key === agent.agentKey || target.fixed_by_key === agent.agentKey)) {
      return apiError(c, 403, "SELF_REVIEW_FORBIDDEN", "a lesson cannot be reviewed by the key that submitted or fixed it");
    }
    // approve and reject act on a lesson awaiting a decision. quarantine also retracts an approved lesson.
    const reviewable =
      body.decision === "quarantine"
        ? target.review_status === "pending_review" || target.review_status === "approved"
        : target.review_status === "pending_review" || target.review_status === "quarantined";
    if (!reviewable) {
      return apiError(
        c,
        409,
        "LESSON_NOT_REVIEWABLE",
        body.decision === "quarantine"
          ? `lesson is ${target.review_status}; only a lesson in review or an approved lesson can be quarantined`
          : `lesson is ${target.review_status}, not awaiting review`,
      );
    }

    const details = {
      ...(body.reasoning === undefined ? {} : { reasoning: body.reasoning }),
      // Ties the append-only audit row to the exact signed request that caused it.
      request_body_sha256: await sha256Hex(c.get("raw_body")),
      request_nonce: c.req.header("achromat-nonce") ?? null,
    };
    try {
      await env.DB.prepare(
        `INSERT INTO review_events (event_id, lesson_id, actor_type, actor_id, action, reason_code, details_json, at_ms)
         VALUES (?1, ?2, 'human', ?3, ?4, ?5, ?6, ?7)`,
      )
        .bind(
          crypto.randomUUID(),
          body.lesson_id,
          agent.agentKey,
          body.decision,
          body.decision === "approve" ? null : body.reason_code,
          JSON.stringify(details),
          Date.now(),
        )
        .run();
    } catch (error) {
      // The ledger guard is authoritative: a concurrent reviewer got there first.
      const text = error instanceof Error ? error.message : String(error);
      if (
        text.includes("approve and reject need a lesson in review or quarantine") ||
        text.includes("lesson cannot be quarantined from its current state")
      ) {
        return apiError(c, 409, "LESSON_NOT_REVIEWABLE", "lesson is no longer awaiting review");
      }
      throw error;
    }

    const state = await env.DB.prepare("SELECT review_status, visibility FROM lesson_state WHERE lesson_id = ?1")
      .bind(body.lesson_id)
      .first<{ review_status: string; visibility: string }>();

    // Approve: upsert with visibility 'public' (replaces the `k:` vector). Reject: delete the vector.
    const sync = syncVectors(env, options.search(env), { lessonId: body.lesson_id }).catch((error) =>
      console.error("achromat-mom review vector sync failed", error instanceof Error ? error.message : error),
    );
    try {
      c.executionCtx.waitUntil(sync);
    } catch {
      // No execution context (direct unit-test calls): the promise still runs.
    }

    return c.json({
      success: true,
      lesson_id: body.lesson_id,
      decision: body.decision,
      review_status: state?.review_status ?? null,
      visibility: state?.visibility === "public" ? "public" : "none",
      vector_sync: "scheduled",
    });
  });

  /**
   * Seeding: a JSON array of pairs, each carrying two ramen receipts. Every pair is verified and written in
   * its own transaction (src/review/seed.ts), so one bad pair never blocks the rest. 201 when at least one
   * pair was written, 200 when none was; `rejected` explains each refusal. Vectorize is synced after the
   * response, and the cron retries whatever that run does not finish.
   */
  admin.post("/seed", async (c) => {
    const env = c.env;
    const agent = c.get("agent");

    const raw = c.get("raw_body");
    const parsed = SeedRequest.safeParse(parseJsonBytes(raw));
    if (!parsed.success) {
      const failure = toValidationFailure(parsed.error);
      return apiError(c, 400, failure.code, "seed body is invalid", failure.details);
    }
    try {
      await assertPairingSecrets(env.MOM_ATTESTATION_PRIVATE_KEY, env.VISIBILITY_KEY);
    } catch (error) {
      console.error("achromat-mom seed misconfigured", error instanceof Error ? error.message : error);
      return apiError(c, 503, "SERVICE_MISCONFIGURED", "seeding is temporarily unavailable");
    }

    const outcome = await seedPairs(env, agent.agentKey, parsed.data, await sha256Hex(raw), {
      receiptKeys: options.receiptKeys ?? RAMEN_RECEIPT_KEYS,
    });

    if (outcome.seeded.length > 0) {
      const sync = syncVectors(env, options.search(env), { limit: SYNC_BATCH_LIMIT }).catch((error) =>
        console.error("achromat-mom seed vector sync failed", error instanceof Error ? error.message : error),
      );
      try {
        c.executionCtx.waitUntil(sync);
      } catch {
        // No execution context (direct unit-test calls): the promise still runs.
      }
    }

    return c.json(
      {
        success: true,
        requested: parsed.data.length,
        seeded: outcome.seeded,
        rejected: outcome.rejected,
        review_status: "approved",
        vector_sync: outcome.seeded.length > 0 ? "scheduled" : "none",
      },
      outcome.seeded.length > 0 ? 201 : 200,
    );
  });

  return admin;
}
