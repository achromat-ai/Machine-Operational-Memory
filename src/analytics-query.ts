/**
 * Funnel report for GET /api/v1/admin/telemetry, read from the achromat_mom_telemetry Analytics Engine dataset
 * (written by src/telemetry.ts) through the Analytics Engine SQL API:
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql
 *   Authorization: Bearer {ANALYTICS_API_TOKEN}      (read-only: Account | Account Analytics | Read)
 *
 * That API takes SQL text and has no JOIN or UNION, so the report is built from eight flat queries that are
 * merged here, in the Worker, plus a handful of read-only D1 aggregates (the ledger section):
 *
 *   funnel         anonymous and authenticated funnel steps by ref: skill_view, challenge_issued, agent_register
 *   registrations  one row per agent registered in the window: its anonymised id and the ref it registered with
 *   activity       recall and calibrate counts per agent
 *   failures       refused challenge and register requests, by response code, endpoint and ref
 *   searches       landing-page searches (human_search), by domain and outcome
 *   lesson_views   opened audit links that carried a ref (lesson_view), by ref and outcome
 *   recall_calls   recall (signed), recall_unsigned and mcp_sandbox_recall by domain, status, miss reason and client
 *   unmatched      the tool names that recalls missed on, by miss reason (top 25)
 *
 * The cohort fields (totals, by_ref, conversion) describe agents registered inside the window. activity_all_agents
 * is the same activity with no cohort filter, and recall_summary splits recalls into signed, unsigned and sandbox.
 * The ledger section is exact (D1 is not sampled); everything else comes from the sampled Analytics Engine.
 *
 * /recall and /calibrate points carry no ref. They are attributed through the anonymised agent id that
 * agent_register shares with that key's later points, so the per-ref recall and calibrate figures describe the cohort
 * of agents registered inside the window; activity by older agents is not in those, only in activity_all_agents.
 *
 * Nothing request-controlled reaches the SQL text: the window is an enum mapped to a fixed number of days.
 * The token is sent only in the Authorization header. Cloudflare's error bodies are logged truncated, never relayed.
 */
import { z } from "zod";
import type { Env } from "./env";
import { parseRef } from "./telemetry";

export const TELEMETRY_DATASET = "achromat_mom_telemetry";
export const ANALYTICS_QUERY_TIMEOUT_MS = 10_000;
/** Rows requested per query. A query that returns this many is reported as truncated. */
export const ANALYTICS_ROW_LIMIT = 10_000;
/** Upper bound on a response body MOM will parse. */
const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Tool names listed in the report's unmatched_tools. */
export const UNMATCHED_TOOL_LIMIT = 25;

export const TELEMETRY_WINDOWS = {
  "24h": { days: 1 },
  "7d": { days: 7 },
} as const;
export type TelemetryWindow = keyof typeof TELEMETRY_WINDOWS;

export interface AnalyticsConfig {
  accountId: string;
  token: string;
}

/** The account ID and token, or null when either is missing or malformed (including the unfilled wrangler.toml placeholder). */
export function analyticsConfig(env: Pick<Env, "CLOUDFLARE_ACCOUNT_ID" | "ANALYTICS_API_TOKEN">): AnalyticsConfig | null {
  const accountId = typeof env.CLOUDFLARE_ACCOUNT_ID === "string" ? env.CLOUDFLARE_ACCOUNT_ID.trim() : "";
  const token = typeof env.ANALYTICS_API_TOKEN === "string" ? env.ANALYTICS_API_TOKEN.trim() : "";
  if (!ACCOUNT_ID_PATTERN.test(accountId) || token.length === 0) return null;
  return { accountId, token };
}

export function analyticsEndpoint(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
}

// ════════════════════════════════════════════════════════════════════════
// SQL (the only interpolated value is the day count of a server-side window)
// ════════════════════════════════════════════════════════════════════════

function since(days: number): string {
  return `timestamp > NOW() - INTERVAL '${days}' DAY`;
}

/** Events per ref and funnel step, weighted by _sample_interval. blob6 is the ref ("" for none). */
export function funnelSql(window: TelemetryWindow): string {
  return `SELECT blob6 AS ref_tag, blob1 AS step, SUM(_sample_interval) AS events
FROM ${TELEMETRY_DATASET}
WHERE ${since(TELEMETRY_WINDOWS[window].days)} AND blob1 IN ('skill_view', 'challenge_issued', 'agent_register')
GROUP BY ref_tag, step
LIMIT ${ANALYTICS_ROW_LIMIT}
FORMAT JSON`;
}

/** The registration cohort: each agent registered in the window and the ref it registered with. */
export function registrationsSql(window: TelemetryWindow): string {
  return `SELECT blob4 AS agent_id, blob6 AS ref_tag
FROM ${TELEMETRY_DATASET}
WHERE ${since(TELEMETRY_WINDOWS[window].days)} AND blob1 = 'agent_register'
LIMIT ${ANALYTICS_ROW_LIMIT}
FORMAT JSON`;
}

/** Recall and calibrate volume per agent. Anonymous (sandbox) events are excluded. */
export function activitySql(window: TelemetryWindow): string {
  return `SELECT blob4 AS agent_id, blob1 AS step, SUM(_sample_interval) AS events
FROM ${TELEMETRY_DATASET}
WHERE ${since(TELEMETRY_WINDOWS[window].days)} AND blob1 IN ('recall', 'calibrate_trap', 'calibrate_fix') AND blob4 != 'anonymous'
GROUP BY agent_id, step
LIMIT ${ANALYTICS_ROW_LIMIT}
FORMAT JSON`;
}

/** Refused challenge/register requests, by code, endpoint and ref. blob5 is the code, blob3 the endpoint. */
export function failuresSql(window: TelemetryWindow): string {
  return `SELECT blob5 AS code, blob3 AS endpoint, blob6 AS ref_tag, SUM(_sample_interval) AS events
FROM ${TELEMETRY_DATASET}
WHERE ${since(TELEMETRY_WINDOWS[window].days)} AND blob1 = 'registration_failed'
GROUP BY code, endpoint, ref_tag
LIMIT ${ANALYTICS_ROW_LIMIT}
FORMAT JSON`;
}

/** Landing-page searches by validated domain and outcome (hit or miss). */
export function searchesSql(window: TelemetryWindow): string {
  return `SELECT blob2 AS domain, blob5 AS outcome, SUM(_sample_interval) AS events
FROM ${TELEMETRY_DATASET}
WHERE ${since(TELEMETRY_WINDOWS[window].days)} AND blob1 = 'human_search'
GROUP BY domain, outcome
LIMIT ${ANALYTICS_ROW_LIMIT}
FORMAT JSON`;
}

/** Audit-link visits (only ever written when the link carried a ref), by ref and outcome. */
export function lessonViewsSql(window: TelemetryWindow): string {
  return `SELECT blob6 AS ref_tag, blob5 AS outcome, SUM(_sample_interval) AS events
FROM ${TELEMETRY_DATASET}
WHERE ${since(TELEMETRY_WINDOWS[window].days)} AND blob1 = 'lesson_view'
GROUP BY ref_tag, outcome
LIMIT ${ANALYTICS_ROW_LIMIT}
FORMAT JSON`;
}

/**
 * Every recall point by action, domain, status, miss reason (blob7) and client label (blob8), for signed callers,
 * unsigned callers and the sandbox alike. No cohort and no agent id: this is volume, not people.
 */
export function recallCallsSql(window: TelemetryWindow): string {
  return `SELECT blob1 AS action, blob2 AS domain, blob5 AS status, blob7 AS reason, blob8 AS client, SUM(_sample_interval) AS events
FROM ${TELEMETRY_DATASET}
WHERE ${since(TELEMETRY_WINDOWS[window].days)} AND blob1 IN ('recall', 'recall_unsigned', 'mcp_sandbox_recall')
GROUP BY action, domain, status, reason, client
LIMIT ${ANALYTICS_ROW_LIMIT}
FORMAT JSON`;
}

/** The tool names recalls missed on (blob3, a caller-chosen string already limited to the ToolName alphabet), most missed first. */
export function unmatchedToolsSql(window: TelemetryWindow): string {
  return `SELECT blob3 AS tool, blob7 AS reason, SUM(_sample_interval) AS events
FROM ${TELEMETRY_DATASET}
WHERE ${since(TELEMETRY_WINDOWS[window].days)} AND blob1 IN ('recall', 'recall_unsigned') AND blob5 = 'miss'
GROUP BY tool, reason
ORDER BY events DESC
LIMIT ${UNMATCHED_TOOL_LIMIT}
FORMAT JSON`;
}

// ════════════════════════════════════════════════════════════════════════
// Ledger: exact counts from D1 (not sampled)
// ════════════════════════════════════════════════════════════════════════

export interface Ledger {
  /** Registrations by role: inside the window, and since the service began. */
  registrations: Array<{ role: string; in_window: number; all_time: number }>;
  /** Calibrate attempts by every agent, whenever it registered. Raw attempts are kept 30 days. */
  calibrate: { attempts: number; agents: number; block: number; allow: number };
  /** First-time lesson deliveries (recall hits). A repeat hit writes no row, so this is a floor on hits. */
  recall_hits: { first_deliveries: number; agents: number };
  /** Recall misses logged for the demand radar: one per caller, task and hour, so a floor on misses. */
  recall_misses: { misses: number; callers: number };
}

/**
 * Read-only aggregates over the ledger. Counts only: no agent key, task text or row ever leaves D1 here. The window is
 * bound as a number from the server-side enum, never from the request.
 */
export async function loadLedger(db: D1Database, window: TelemetryWindow, nowMs: number): Promise<Ledger> {
  const from = nowMs - TELEMETRY_WINDOWS[window].days * DAY_MS;
  const [registrations, calibrate, hits, misses] = await db.batch([
    db.prepare("SELECT role, COUNT(*) AS all_time, SUM(registered_at_ms > ?1) AS in_window FROM agent_identities GROUP BY role ORDER BY role").bind(from),
    db.prepare(
      "SELECT COUNT(*) AS n, COUNT(DISTINCT agent_key) AS m, COALESCE(SUM(verdict = 0), 0) AS a, COALESCE(SUM(verdict = 1), 0) AS b FROM calibration_attempts WHERE created_at_ms > ?1",
    ).bind(from),
    db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT agent_key) AS m FROM lesson_deliveries WHERE first_served_at_ms > ?1").bind(from),
    db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT agent_key_hmac) AS m FROM domain_demand WHERE created_at_ms > ?1").bind(from),
  ]);
  const one = (result: D1Result) => Counts.parse((result.results as unknown[])[0] ?? { n: 0 });
  const calibrateRow = one(calibrate!);
  const hitRow = one(hits!);
  const missRow = one(misses!);
  return {
    registrations: z
      .array(z.object({ role: z.string(), all_time: Count, in_window: Count.nullish().transform((value) => value ?? 0) }))
      .parse(registrations!.results),
    calibrate: { attempts: calibrateRow.n, agents: calibrateRow.m ?? 0, block: calibrateRow.a ?? 0, allow: calibrateRow.b ?? 0 },
    recall_hits: { first_deliveries: hitRow.n, agents: hitRow.m ?? 0 },
    recall_misses: { misses: missRow.n, callers: missRow.m ?? 0 },
  };
}

// ════════════════════════════════════════════════════════════════════════
// Transport
// ════════════════════════════════════════════════════════════════════════

export class AnalyticsQueryError extends Error {
  constructor(
    readonly status: 502 | 504,
    readonly code: "UPSTREAM_TIMEOUT" | "UPSTREAM_UNAVAILABLE" | "UPSTREAM_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "AnalyticsQueryError";
  }
}

/** Cloudflare's JSON format returns 64-bit integers as strings, so numbers are coerced (and must be finite and >= 0). */
const Count = z.coerce.number().min(0);
const Text = z.string().nullish().transform((value) => value ?? "");

/** One row of a ledger aggregate: a count and up to three more (D1 returns plain numbers, 64-bit values are not in play). */
const Counts = z.object({ n: Count, m: Count.optional(), a: Count.optional(), b: Count.optional() });

const FunnelRow = z.object({ ref_tag: Text, step: z.string(), events: Count });
const RegistrationRow = z.object({ agent_id: z.string().min(1), ref_tag: Text });
const ActivityRow = z.object({ agent_id: z.string().min(1), step: z.string(), events: Count });
const FailureRow = z.object({ code: z.string(), endpoint: Text, ref_tag: Text, events: Count });
const SearchRow = z.object({ domain: Text, outcome: z.string(), events: Count });
const LessonViewRow = z.object({ ref_tag: Text, outcome: z.string(), events: Count });
const RecallCallRow = z.object({ action: z.string(), domain: Text, status: Text, reason: Text, client: Text, events: Count });
const UnmatchedToolRow = z.object({ tool: Text, reason: Text, events: Count });

function envelope<T extends z.ZodType>(row: T) {
  return z.object({ data: z.array(row) });
}

/** Runs one query and returns its parsed rows. Throws AnalyticsQueryError; never returns Cloudflare's error text. */
export async function queryAnalyticsEngine<T extends z.ZodType>(config: AnalyticsConfig, sql: string, row: T): Promise<Array<z.output<T>>> {
  let response: Response;
  try {
    response = await fetch(analyticsEndpoint(config.accountId), {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "text/plain" },
      body: sql,
      signal: AbortSignal.timeout(ANALYTICS_QUERY_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    console.error("achromat-mom telemetry query fetch failed", timedOut ? "timeout" : error instanceof Error ? error.name : "error");
    throw timedOut
      ? new AnalyticsQueryError(504, "UPSTREAM_TIMEOUT", "Cloudflare Analytics Engine query timed out")
      : new AnalyticsQueryError(502, "UPSTREAM_UNAVAILABLE", "Cloudflare Analytics Engine is unreachable");
  }

  const text = await response.text();
  if (!response.ok) {
    console.error("achromat-mom telemetry query error", response.status, text.slice(0, 500));
    throw new AnalyticsQueryError(502, "UPSTREAM_UNAVAILABLE", "Cloudflare Analytics Engine query failed");
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new AnalyticsQueryError(502, "UPSTREAM_INVALID", "Cloudflare Analytics Engine returned an oversized response");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = envelope(row).safeParse(json);
  if (!parsed.success) {
    throw new AnalyticsQueryError(502, "UPSTREAM_INVALID", "Cloudflare Analytics Engine returned an unexpected response shape");
  }
  return parsed.data.data as Array<z.output<T>>;
}

// ════════════════════════════════════════════════════════════════════════
// Merge
// ════════════════════════════════════════════════════════════════════════

export type FunnelRow = z.output<typeof FunnelRow>;
export type RegistrationRow = z.output<typeof RegistrationRow>;
export type ActivityRow = z.output<typeof ActivityRow>;
export type FailureRow = z.output<typeof FailureRow>;
export type SearchRow = z.output<typeof SearchRow>;
export type LessonViewRow = z.output<typeof LessonViewRow>;
export type RecallCallRow = z.output<typeof RecallCallRow>;
export type UnmatchedToolRow = z.output<typeof UnmatchedToolRow>;

export interface RefMetrics {
  /** null: no ref, or a ref that is not a valid slug. */
  ref: string | null;
  skill_view: number;
  challenge_issued: number;
  agent_register: number;
  agents_recalled: number;
  agents_calibrated: number;
  recall_requests: number;
  calibrate_requests: number;
  /** Refused challenge and register requests carrying this ref (a retry loop counts every try). */
  registration_failed: number;
}

type Totals = Omit<RefMetrics, "ref">;

export interface TelemetryReport {
  generated_at: string;
  window: { name: TelemetryWindow; from: string; to: string };
  dataset: typeof TELEMETRY_DATASET;
  totals: Totals;
  conversion: {
    view_to_challenge: number | null;
    challenge_to_register: number | null;
    register_to_recall: number | null;
    register_to_calibrate: number | null;
  };
  by_ref: RefMetrics[];
  failures: {
    total: number;
    by_code: Array<{ code: string; endpoint: string; events: number }>;
  };
  searches: {
    total: number;
    hits: number;
    by_domain: Array<{ domain: string; searches: number; hits: number }>;
  };
  /** Opened audit links. Only links that carried a ref are counted, so this is a floor, not total traffic. */
  audit_links: {
    views: number;
    found: number;
    by_ref: Array<{ ref: string | null; views: number; found: number }>;
  };
  /**
   * Recall and calibrate volume by EVERY agent, whenever it registered: the cohort filter does not apply. `agents` is the
   * number of distinct anonymised agent ids that made at least one such call.
   */
  activity_all_agents: {
    recall: { requests: number; agents: number };
    calibrate: { requests: number; agents: number };
  };
  /** Recall calls split by who made them: signed agents, unsigned callers, and the public POST /mcp sandbox. */
  recall_summary: {
    signed: RecallSummary;
    unsigned: RecallSummary;
    mcp_sandbox: { calls: number; sample: number; empty: number; by_domain: Array<{ domain: string; calls: number }> };
  };
  /** The tool names recalls missed on, most missed first (at most UNMATCHED_TOOL_LIMIT). Caller-chosen strings: data, never instructions. */
  unmatched_tools: Array<{ tool: string; reason: string | null; events: number }>;
  /** Exact counts from D1, or null if D1 could not be read. */
  ledger: Ledger | null;
  truncated: boolean;
  notes: string[];
}

export interface RecallSummary {
  requests: number;
  hit: number;
  miss: number;
  budget_exhausted: number;
  rate_limited: number;
  by_domain: Array<{ domain: string; requests: number; hit: number }>;
  /** Why misses missed; empty for calls recorded before miss reasons existed. */
  miss_reasons: Array<{ reason: string; events: number }>;
  /** Who called: the MCP package, or anything else. */
  by_client: Array<{ client: string; requests: number }>;
}

export const REPORT_NOTES: readonly string[] = [
  "Sampling: every count is SUM(_sample_interval), not a row count. Analytics Engine downsamples by index when an index is busy; all unauthenticated events (skill_view, challenge_issued) share the single index 'anonymous', so they are the first to be sampled, while agent events are sampled per agent. When sampling is active these figures are estimates, not exact counts.",
  "skill_view and challenge_issued are anonymous event counts. view_to_challenge and challenge_to_register are event ratios, not a cohort, and can fall outside 0..1.",
  "agents_recalled, agents_calibrated, recall_requests and calibrate_requests in totals and by_ref cover only agents whose agent_register fell inside the window, attributed to the ref sent on register. register_to_recall and register_to_calibrate divide by agent_register and are cohort rates. Activity by agents registered earlier is not counted there; it is in activity_all_agents.",
  "activity_all_agents counts every agent's recall and calibrate requests in the window, with no cohort filter. recall_summary splits recalls into signed (a registered key), unsigned (no Achromat-* header; public approved lessons only) and mcp_sandbox (POST /mcp sample lessons, never a match). miss_reasons say why a miss missed: tool_unknown (no public lesson exists for that domain and tool), below_threshold (a candidate scored under the cutoff), no_candidate (nothing came back); calls recorded before this field existed have no reason. unmatched_tools lists the tool names recalls missed on.",
  "ledger is read from D1, not the Analytics Engine, so it is exact. recall_hits counts first-time deliveries only (a repeat hit writes no row) and recall_misses counts one row per caller, task and hour, so both are floors. Raw calibration attempts are kept 30 days. It is null when D1 could not be read.",
  "ref null means no ref was sent, or it was not a valid slug. An agent that read a document with a ref but registered without one is counted under null.",
  "failures count every refused challenge or register request, so one client retrying in a loop adds many; by_code names the reason (for example CHALLENGE_WRONG_NETWORK or POW_INVALID). registration_failed on a ref row counts the refusals that carried that ref.",
  "searches come from any unauthenticated client of the search route; the landing page is its documented caller, so they approximate human interest by domain. The question text is never recorded.",
  "audit_links counts opened citation links (lesson pages) that carried a ref. A link without a ref is not recorded, so views is a lower bound.",
  "truncated is true when a query returned its row limit, so the figures are a lower bound.",
  "Analytics Engine retains three months of data.",
];

function emptyMetrics(ref: string | null): RefMetrics {
  return { ref, skill_view: 0, challenge_issued: 0, agent_register: 0, agents_recalled: 0, agents_calibrated: 0, recall_requests: 0, calibrate_requests: 0, registration_failed: 0 };
}

/** parseRef maps anything that is not a valid slug to "". null is the public name of "no usable ref". */
function normaliseRef(raw: string): string | null {
  return parseRef(raw) || null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

function compareRefs(a: RefMetrics, b: RefMetrics): number {
  return (
    b.agent_register - a.agent_register ||
    b.skill_view - a.skill_view ||
    (a.ref === null ? 1 : 0) - (b.ref === null ? 1 : 0) ||
    (a.ref ?? "").localeCompare(b.ref ?? "")
  );
}

export interface ReportInput {
  window: TelemetryWindow;
  funnel: readonly FunnelRow[];
  registrations: readonly RegistrationRow[];
  activity: readonly ActivityRow[];
  failures: readonly FailureRow[];
  searches: readonly SearchRow[];
  lessonViews: readonly LessonViewRow[];
  recallCalls?: readonly RecallCallRow[];
  unmatchedTools?: readonly UnmatchedToolRow[];
  ledger?: Ledger | null;
  nowMs: number;
}

function emptySummary(): RecallSummary {
  return { requests: 0, hit: 0, miss: 0, budget_exhausted: 0, rate_limited: 0, by_domain: [], miss_reasons: [], by_client: [] };
}

/** Folds the recall_calls rows of one action into a summary. */
function summariseRecall(rows: readonly RecallCallRow[], action: string): RecallSummary {
  const summary = emptySummary();
  const domains = new Map<string, { domain: string; requests: number; hit: number }>();
  const reasons = new Map<string, number>();
  const clients = new Map<string, number>();
  for (const row of rows) {
    if (row.action !== action) continue;
    summary.requests += row.events;
    if (row.status === "hit") summary.hit += row.events;
    else if (row.status === "miss") summary.miss += row.events;
    else if (row.status === "budget_exhausted") summary.budget_exhausted += row.events;
    else if (row.status === "rate_limited") summary.rate_limited += row.events;
    const domain = domains.get(row.domain) ?? { domain: row.domain, requests: 0, hit: 0 };
    domain.requests += row.events;
    if (row.status === "hit") domain.hit += row.events;
    domains.set(row.domain, domain);
    if (row.status === "miss" && row.reason !== "") reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + row.events);
    if (row.client !== "") clients.set(row.client, (clients.get(row.client) ?? 0) + row.events);
  }
  summary.by_domain = [...domains.values()].sort((a, b) => b.requests - a.requests || a.domain.localeCompare(b.domain));
  summary.miss_reasons = [...reasons].map(([reason, events]) => ({ reason, events })).sort((a, b) => b.events - a.events || a.reason.localeCompare(b.reason));
  summary.by_client = [...clients].map(([client, requests]) => ({ client, requests })).sort((a, b) => b.requests - a.requests || a.client.localeCompare(b.client));
  return summary;
}

/** Pure merge of the six query results. */
export function buildReport(input: ReportInput): TelemetryReport {
  const refs = new Map<string, RefMetrics>();
  const entry = (ref: string | null): RefMetrics => {
    const key = ref ?? "";
    let metrics = refs.get(key);
    if (metrics === undefined) {
      metrics = emptyMetrics(ref);
      refs.set(key, metrics);
    }
    return metrics;
  };

  for (const row of input.funnel) {
    const metrics = entry(normaliseRef(row.ref_tag));
    if (row.step === "skill_view") metrics.skill_view += row.events;
    else if (row.step === "challenge_issued") metrics.challenge_issued += row.events;
    else if (row.step === "agent_register") metrics.agent_register += row.events;
  }

  // The cohort: agent id → ref. An id registers once; if it somehow appears twice the first row wins.
  const cohort = new Map<string, string | null>();
  for (const row of input.registrations) if (!cohort.has(row.agent_id)) cohort.set(row.agent_id, normaliseRef(row.ref_tag));

  // Every agent, before the cohort filter below drops the ones that registered earlier.
  const allRecall = { requests: 0, agents: new Set<string>() };
  const allCalibrate = { requests: 0, agents: new Set<string>() };
  for (const row of input.activity) {
    if (row.step === "recall") {
      allRecall.requests += row.events;
      allRecall.agents.add(row.agent_id);
    } else if (row.step === "calibrate_trap" || row.step === "calibrate_fix") {
      allCalibrate.requests += row.events;
      allCalibrate.agents.add(row.agent_id);
    }
  }

  const perAgent = new Map<string, { recalls: number; calibrations: number }>();
  for (const row of input.activity) {
    if (!cohort.has(row.agent_id)) continue;
    const totals = perAgent.get(row.agent_id) ?? { recalls: 0, calibrations: 0 };
    if (row.step === "recall") totals.recalls += row.events;
    else if (row.step === "calibrate_trap" || row.step === "calibrate_fix") totals.calibrations += row.events;
    perAgent.set(row.agent_id, totals);
  }
  for (const [agentId, totals] of perAgent) {
    const metrics = entry(cohort.get(agentId) ?? null);
    metrics.recall_requests += totals.recalls;
    metrics.calibrate_requests += totals.calibrations;
    if (totals.recalls > 0) metrics.agents_recalled += 1;
    if (totals.calibrations > 0) metrics.agents_calibrated += 1;
  }

  // Refused requests by response code, and per ref.
  const byCode = new Map<string, { code: string; endpoint: string; events: number }>();
  let failureTotal = 0;
  for (const row of input.failures) {
    entry(normaliseRef(row.ref_tag)).registration_failed += row.events;
    failureTotal += row.events;
    const key = `${row.code}\n${row.endpoint}`;
    const current = byCode.get(key) ?? { code: row.code, endpoint: row.endpoint, events: 0 };
    current.events += row.events;
    byCode.set(key, current);
  }

  const domains = new Map<string, { domain: string; searches: number; hits: number }>();
  let searchTotal = 0;
  let searchHits = 0;
  for (const row of input.searches) {
    const current = domains.get(row.domain) ?? { domain: row.domain, searches: 0, hits: 0 };
    current.searches += row.events;
    searchTotal += row.events;
    if (row.outcome === "hit") {
      current.hits += row.events;
      searchHits += row.events;
    }
    domains.set(row.domain, current);
  }

  const viewRefs = new Map<string, { ref: string | null; views: number; found: number }>();
  let viewTotal = 0;
  let viewFound = 0;
  for (const row of input.lessonViews) {
    const ref = normaliseRef(row.ref_tag);
    const current = viewRefs.get(ref ?? "") ?? { ref, views: 0, found: 0 };
    current.views += row.events;
    viewTotal += row.events;
    if (row.outcome === "hit") {
      current.found += row.events;
      viewFound += row.events;
    }
    viewRefs.set(ref ?? "", current);
  }

  const byRef = [...refs.values()].sort(compareRefs);
  const totals: Totals = {
    skill_view: 0,
    challenge_issued: 0,
    agent_register: 0,
    agents_recalled: 0,
    agents_calibrated: 0,
    recall_requests: 0,
    calibrate_requests: 0,
    registration_failed: 0,
  };
  for (const metrics of byRef) {
    totals.skill_view += metrics.skill_view;
    totals.challenge_issued += metrics.challenge_issued;
    totals.agent_register += metrics.agent_register;
    totals.agents_recalled += metrics.agents_recalled;
    totals.agents_calibrated += metrics.agents_calibrated;
    totals.recall_requests += metrics.recall_requests;
    totals.calibrate_requests += metrics.calibrate_requests;
    totals.registration_failed += metrics.registration_failed;
  }

  const recallCalls = input.recallCalls ?? [];
  const sandbox = { calls: 0, sample: 0, empty: 0 };
  const sandboxDomains = new Map<string, number>();
  for (const row of recallCalls) {
    if (row.action !== "mcp_sandbox_recall") continue;
    sandbox.calls += row.events;
    if (row.status === "sample") sandbox.sample += row.events;
    else if (row.status === "empty") sandbox.empty += row.events;
    sandboxDomains.set(row.domain, (sandboxDomains.get(row.domain) ?? 0) + row.events);
  }
  const unmatched = new Map<string, { tool: string; reason: string | null; events: number }>();
  for (const row of input.unmatchedTools ?? []) {
    const key = `${row.tool}\n${row.reason}`;
    const current = unmatched.get(key) ?? { tool: row.tool, reason: row.reason === "" ? null : row.reason, events: 0 };
    current.events += row.events;
    unmatched.set(key, current);
  }

  const limit = ANALYTICS_ROW_LIMIT;
  return {
    generated_at: new Date(input.nowMs).toISOString(),
    window: {
      name: input.window,
      from: new Date(input.nowMs - TELEMETRY_WINDOWS[input.window].days * DAY_MS).toISOString(),
      to: new Date(input.nowMs).toISOString(),
    },
    dataset: TELEMETRY_DATASET,
    totals,
    conversion: {
      view_to_challenge: ratio(totals.challenge_issued, totals.skill_view),
      challenge_to_register: ratio(totals.agent_register, totals.challenge_issued),
      register_to_recall: ratio(totals.agents_recalled, totals.agent_register),
      register_to_calibrate: ratio(totals.agents_calibrated, totals.agent_register),
    },
    by_ref: byRef,
    failures: {
      total: failureTotal,
      by_code: [...byCode.values()].sort((a, b) => b.events - a.events || a.code.localeCompare(b.code) || a.endpoint.localeCompare(b.endpoint)),
    },
    searches: {
      total: searchTotal,
      hits: searchHits,
      by_domain: [...domains.values()].sort((a, b) => b.searches - a.searches || a.domain.localeCompare(b.domain)),
    },
    audit_links: {
      views: viewTotal,
      found: viewFound,
      by_ref: [...viewRefs.values()].sort((a, b) => b.views - a.views || (a.ref ?? "").localeCompare(b.ref ?? "")),
    },
    activity_all_agents: {
      recall: { requests: allRecall.requests, agents: allRecall.agents.size },
      calibrate: { requests: allCalibrate.requests, agents: allCalibrate.agents.size },
    },
    recall_summary: {
      signed: summariseRecall(recallCalls, "recall"),
      unsigned: summariseRecall(recallCalls, "recall_unsigned"),
      mcp_sandbox: {
        ...sandbox,
        by_domain: [...sandboxDomains].map(([domain, calls]) => ({ domain, calls })).sort((a, b) => b.calls - a.calls || a.domain.localeCompare(b.domain)),
      },
    },
    unmatched_tools: [...unmatched.values()].sort((a, b) => b.events - a.events || a.tool.localeCompare(b.tool)).slice(0, UNMATCHED_TOOL_LIMIT),
    ledger: input.ledger ?? null,
    truncated: [input.funnel, input.registrations, input.activity, input.failures, input.searches, input.lessonViews, recallCalls].some((rows) => rows.length >= limit),
    notes: [...REPORT_NOTES],
  };
}

/**
 * Runs the eight Analytics Engine queries in parallel, reads the D1 ledger, and merges them. Throws AnalyticsQueryError
 * if any Analytics Engine query fails. A D1 failure does not fail the report: `ledger` is null and the cause is logged.
 */
export async function loadTelemetryReport(
  config: AnalyticsConfig,
  window: TelemetryWindow,
  nowMs: number = Date.now(),
  db?: D1Database,
): Promise<TelemetryReport> {
  const [funnel, registrations, activity, failures, searches, lessonViews, recallCalls, unmatchedTools, ledger] = await Promise.all([
    queryAnalyticsEngine(config, funnelSql(window), FunnelRow),
    queryAnalyticsEngine(config, registrationsSql(window), RegistrationRow),
    queryAnalyticsEngine(config, activitySql(window), ActivityRow),
    queryAnalyticsEngine(config, failuresSql(window), FailureRow),
    queryAnalyticsEngine(config, searchesSql(window), SearchRow),
    queryAnalyticsEngine(config, lessonViewsSql(window), LessonViewRow),
    queryAnalyticsEngine(config, recallCallsSql(window), RecallCallRow),
    queryAnalyticsEngine(config, unmatchedToolsSql(window), UnmatchedToolRow),
    db === undefined
      ? Promise.resolve(null)
      : loadLedger(db, window, nowMs).catch((error: unknown) => {
          console.error("achromat-mom telemetry ledger failed", error instanceof Error ? error.message : error);
          return null;
        }),
  ]);
  return buildReport({ window, funnel, registrations, activity, failures, searches, lessonViews, recallCalls, unmatchedTools, ledger, nowMs });
}
