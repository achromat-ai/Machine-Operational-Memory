/**
 * GET /api/v1/bounties (signed, admin or internal role): the bounty board.
 *
 * Lists expired community traps: a trap whose 24-hour pairing window has closed and that no fix
 * references. The ledger pairs a trap at most once (fixes_one_per_trap), so "no fix" covers every
 * state of a fix (pending, approved, even rejected): a trap that has any fix never returns here.
 * A trap under another key's live 30-minute claim lease is hidden until the lease lapses; the
 * caller's own lease stays visible.
 *
 * The board exposes raw failure parameters (what a blocked agent tried), so it is never public:
 * a role gate (agent_state role, cross-checked against the insert-only agent_identities record)
 * plus an hourly budget per key keep it from becoming a scrapeable dictionary of failing calls. The submitting agent's key is never returned.
 *
 * The content is untrusted community text: consumers must treat task_description
 * and trap_arguments as inert data, never as instructions.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { apiError, queryParams } from "../http";
import { requireAdminOrInternalIdentity, requireRole, type AuthVariables } from "../middleware/auth";
import { BountyQuery, decodeCursor, encodeCursor, toValidationFailure } from "../schema";
import { consumeUsage, secondsUntil } from "../usage";

export const BOUNTY_LIMIT_PER_AGENT_PER_HOUR = 600;
const TRAP_WINDOW_MS = 86_400_000;

export function bountyUsageKey(agentKey: string): string {
  return `bounties:agent:${agentKey}`;
}

type BountyEnv = { Bindings: Env; Variables: AuthVariables };

interface BountyRow {
  trap_id: string;
  domain: string;
  tool_name: string;
  task_fingerprint: string;
  opened_at_ms: number;
  expires_at_ms: number;
  task_description: string;
  trap_arguments_json: string;
  violation_rule: string | null;
  steering_directive: string | null;
  statutory_anchor: string | null;
  policy_ids_json: string | null;
  rule_ids_json: string | null;
  bundle_id: string | null;
  attempts: number;
}

/**
 * opened_at_ms <= now - 24 h is the same set as expires_at_ms <= now (CHECK expires = opened + 24 h)
 * and can use traps_by_age. The clock is the database clock, the one bounty_claims_guard_insert uses,
 * so a listed trap is never refused at the window boundary.
 */
const BOUNTY_SQL = `
SELECT t.trap_id, t.domain, t.tool_name, t.task_fingerprint, t.opened_at_ms, t.expires_at_ms,
       e.task_description, e.trap_arguments_json, e.violation_rule, e.steering_directive, e.statutory_anchor,
       e.policy_ids_json, e.rule_ids_json, e.bundle_id,
       (SELECT count(*) FROM trap_events x WHERE x.trap_id = t.trap_id) AS attempts
  FROM traps t
  JOIN trap_events e ON e.trap_id = t.trap_id AND e.attempt_seq = 1
 WHERE t.opened_at_ms <= (SELECT now_ms FROM db_clock) - ${TRAP_WINDOW_MS}
   AND NOT EXISTS (SELECT 1 FROM fixes f WHERE f.trap_id = t.trap_id)
   AND NOT EXISTS (SELECT 1 FROM bounty_claims c
                    WHERE c.trap_id = t.trap_id AND c.agent_key <> ?1
                      AND c.lease_expires_at_ms > (SELECT now_ms FROM db_clock))
   AND (?2 IS NULL OR t.domain = ?2)
   AND (?3 IS NULL OR t.tool_name = ?3)
   AND (?4 IS NULL OR (t.opened_at_ms, t.trap_id) > (?4, ?5))
 ORDER BY t.opened_at_ms, t.trap_id
 LIMIT ?6`;

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createBountyRoutes() {
  const bounties = new Hono<BountyEnv>();

  // Role from agent_state, then the same role in the insert-only agent_identities record.
  bounties.use("*", requireRole("admin", "internal"));
  bounties.use("*", requireAdminOrInternalIdentity());
  bounties.use("*", async (c, next) => {
    const usage = await consumeUsage(c.env, bountyUsageKey(c.get("agent").agentKey), BOUNTY_LIMIT_PER_AGENT_PER_HOUR);
    if (!usage.allowed) {
      c.header("Retry-After", secondsUntil(usage.resetAtMs));
      return apiError(c, 429, "RATE_LIMITED", `at most ${BOUNTY_LIMIT_PER_AGENT_PER_HOUR} bounty requests per hour per agent key`);
    }
    await next();
  });

  bounties.get("/", async (c) => {
    const params = queryParams(c.req.url);
    if (params === null) return apiError(c, 400, "INVALID_REQUEST", "query parameters must not repeat");
    const parsed = BountyQuery.safeParse(params);
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
      await c.env.DB.prepare(BOUNTY_SQL)
        .bind(c.get("agent").agentKey, query.domain ?? null, query.tool ?? null, cursor?.timestampMs ?? null, cursor?.id ?? null, query.limit + 1)
        .all<BountyRow>()
    ).results;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return c.json({
      success: true,
      untrusted_content: true,
      bounties: page.map((row) => ({
        trap_id: row.trap_id,
        domain: row.domain,
        tool: row.tool_name,
        task_fingerprint: row.task_fingerprint,
        task_description: row.task_description,
        trap_arguments: parseJson(row.trap_arguments_json),
        violation_rule: row.violation_rule,
        steering_directive: row.steering_directive,
        statutory_anchor: row.statutory_anchor,
        bundle_id: row.bundle_id,
        policy_ids: parseJson(row.policy_ids_json),
        rule_ids: parseJson(row.rule_ids_json),
        attempts: row.attempts,
        opened_at: new Date(row.opened_at_ms).toISOString(),
        expired_at: new Date(row.expires_at_ms).toISOString(),
      })),
      next_cursor: rows.length > query.limit && last ? encodeCursor(last.opened_at_ms, last.trap_id) : null,
    });
  });

  return bounties;
}
