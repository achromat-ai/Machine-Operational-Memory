/**
 * Funnel report for GET /api/v1/admin/telemetry, read from the achromat_mom_telemetry Analytics Engine dataset
 * (written by src/telemetry.ts) through the Analytics Engine SQL API:
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql
 *   Authorization: Bearer {ANALYTICS_API_TOKEN}      (read-only: Account | Account Analytics | Read)
 *
 * That API takes SQL text and has no JOIN or UNION, so the report is built from three flat queries that are
 * merged here, in the Worker:
 *
 *   funnel         anonymous and authenticated funnel steps by ref: skill_view, challenge_issued, agent_register
 *   registrations  one row per agent registered in the window: its anonymised id and the ref it registered with
 *   activity       recall and calibrate counts per agent
 *
 * /recall and /calibrate points carry no ref. They are attributed through the anonymised agent id that
 * agent_register shares with that key's later points, so recall and calibrate figures describe the cohort of agents
 * registered inside the window; activity by older agents is ignored.
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

const FunnelRow = z.object({ ref_tag: Text, step: z.string(), events: Count });
const RegistrationRow = z.object({ agent_id: z.string().min(1), ref_tag: Text });
const ActivityRow = z.object({ agent_id: z.string().min(1), step: z.string(), events: Count });

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
  truncated: boolean;
  notes: string[];
}

export const REPORT_NOTES: readonly string[] = [
  "Sampling: every count is SUM(_sample_interval), not a row count. Analytics Engine downsamples by index when an index is busy; all unauthenticated events (skill_view, challenge_issued) share the single index 'anonymous', so they are the first to be sampled, while agent events are sampled per agent. When sampling is active these figures are estimates, not exact counts.",
  "skill_view and challenge_issued are anonymous event counts. view_to_challenge and challenge_to_register are event ratios, not a cohort, and can fall outside 0..1.",
  "agents_recalled, agents_calibrated, recall_requests and calibrate_requests cover only agents whose agent_register fell inside the window, attributed to the ref sent on register. register_to_recall and register_to_calibrate divide by agent_register and are cohort rates. Activity by agents registered earlier is not counted.",
  "ref null means no ref was sent, or it was not a valid slug. An agent that read a document with a ref but registered without one is counted under null.",
  "truncated is true when a query returned its row limit, so the figures are a lower bound.",
  "Analytics Engine retains three months of data.",
];

function emptyMetrics(ref: string | null): RefMetrics {
  return { ref, skill_view: 0, challenge_issued: 0, agent_register: 0, agents_recalled: 0, agents_calibrated: 0, recall_requests: 0, calibrate_requests: 0 };
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
  nowMs: number;
}

/** Pure merge of the three query results. */
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

  const byRef = [...refs.values()].sort(compareRefs);
  const totals: Totals = {
    skill_view: 0,
    challenge_issued: 0,
    agent_register: 0,
    agents_recalled: 0,
    agents_calibrated: 0,
    recall_requests: 0,
    calibrate_requests: 0,
  };
  for (const metrics of byRef) {
    totals.skill_view += metrics.skill_view;
    totals.challenge_issued += metrics.challenge_issued;
    totals.agent_register += metrics.agent_register;
    totals.agents_recalled += metrics.agents_recalled;
    totals.agents_calibrated += metrics.agents_calibrated;
    totals.recall_requests += metrics.recall_requests;
    totals.calibrate_requests += metrics.calibrate_requests;
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
    truncated: input.funnel.length >= limit || input.registrations.length >= limit || input.activity.length >= limit,
    notes: [...REPORT_NOTES],
  };
}

/** Runs the three queries in parallel and merges them. Throws AnalyticsQueryError. */
export async function loadTelemetryReport(config: AnalyticsConfig, window: TelemetryWindow, nowMs: number = Date.now()): Promise<TelemetryReport> {
  const [funnel, registrations, activity] = await Promise.all([
    queryAnalyticsEngine(config, funnelSql(window), FunnelRow),
    queryAnalyticsEngine(config, registrationsSql(window), RegistrationRow),
    queryAnalyticsEngine(config, activitySql(window), ActivityRow),
  ]);
  return buildReport({ window, funnel, registrations, activity, nowMs });
}
