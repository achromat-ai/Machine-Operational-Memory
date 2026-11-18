/**
 * API consumption telemetry: one Workers Analytics Engine data point per answered /recall or /calibrate
 * request, per sandbox achromat_recall call on POST /mcp, and per activation-funnel step: a protocol document
 * view, an issued challenge and a registration (dataset achromat_mom_telemetry, binding ANALYTICS).
 *
 *   doubles[0]  1 (request count; sum it, weighted by _sample_interval)
 *   blobs[0]    action: recall | recall_unsigned | calibrate_trap | calibrate_fix | mcp_sandbox_recall
 *                       | skill_view | challenge_issued | agent_register | registration_failed
 *                       | human_search | lesson_view
 *   blobs[1]    domain; for skill_view the document name (skill.md, fintech.md, ...); "" for the other funnel steps
 *   blobs[2]    tool_name ("" for funnel steps); for registration_failed the endpoint: challenge | register
 *   blobs[3]    anonymised agent id (see anonymiseAgentKey), or "anonymous" for callers without a key
 *   blobs[4]    status: hit | miss | budget_exhausted (recall), hit | miss | rate_limited (recall_unsigned),
 *                       allow | block (calibrate), sample | empty (sandbox),
 *                       served | issued | registered (funnel), hit | miss (human_search, lesson_view),
 *                       a REGISTRATION_FAILURE_CODES value (registration_failed)
 *   blobs[5]    funnel steps, registration_failed and lesson_view only: the marketing `ref` tag from the URL's
 *               query string, or "" (see parseRef)
 *   blobs[6]    registration_failed: the request field that failed validation (INVALID_REQUEST only, from a fixed
 *               list), else "". lesson_view: the lesson id, which matched a strict UUID pattern. recall and
 *               recall_unsigned: why a miss missed (MISS_REASONS), else "".
 *   blobs[7]    recall and recall_unsigned: who called (CLIENT_LABELS), a coarse label from the User-Agent.
 *   indexes[0]  the anonymised agent id, so sampling keeps each agent's requests together. registration_failed,
 *               human_search, lesson_view, recall_unsigned and mcp_sandbox_recall use an index of their own, so a
 *               flood of them cannot raise the sampling rate of the anonymous funnel events (skill_view,
 *               challenge_issued), which share the index "anonymous".
 *
 * `agent_register` carries the new key's anonymised id, which is also the id on that key's later recall and
 * calibrate points, so a ref can be followed to first use without a cookie. Caller-supplied strings written, and
 * nothing else: `ref` (a short slug) and a lesson id (a strict UUID). A registration_failed point carries only a
 * code and a field name chosen from lists in this file; never the message, the body, a key, a challenge, a nonce,
 * an IP or a network hash. human_search carries the validated domain and never the question. A recall point
 * carries the tool name the caller sent (validated to the ToolName alphabet), never the task text or the arguments. Telemetry is best
 * effort and never changes or delays the response.
 */
import type { Context } from "hono";
import type { Env } from "./env";
import { sha256Hex } from "./schema";

export type TelemetryAction =
  | "recall"
  | "recall_unsigned"
  | "calibrate_trap"
  | "calibrate_fix"
  | "mcp_sandbox_recall"
  | "skill_view"
  | "challenge_issued"
  | "agent_register"
  | "registration_failed"
  | "human_search"
  | "lesson_view";
export type TelemetryStatus =
  | "hit"
  | "miss"
  | "budget_exhausted"
  | "rate_limited"
  | "allow"
  | "block"
  | "sample"
  | "empty"
  | "served"
  | "issued"
  | "registered";

/**
 * Why a recall missed, written to blobs[6] of a recall or recall_unsigned point. A closed list, like the registration
 * failure codes: tool_unknown (the service holds no public lesson for that domain and tool), below_threshold (a
 * candidate was found but scored under the cutoff), no_candidate (nothing came back at all).
 */
export const MISS_REASONS = ["tool_unknown", "below_threshold", "no_candidate"] as const;
export type MissReason = (typeof MISS_REASONS)[number];

/** Who called a recall, from the User-Agent: this package, or anything else. Never the raw header. */
export const CLIENT_LABELS = ["mcp-package", "other"] as const;
export type ClientLabel = (typeof CLIENT_LABELS)[number];
const PACKAGE_USER_AGENT_PREFIX = "achromat-mcp-server/";

export function clientLabel(request: Request): ClientLabel {
  return (request.headers.get("user-agent") ?? "").startsWith(PACKAGE_USER_AGENT_PREFIX) ? "mcp-package" : "other";
}

/** Actions whose index is their own name, so their volume cannot change how the shared "anonymous" index is sampled. */
const DEDICATED_INDEX: ReadonlySet<TelemetryAction> = new Set<TelemetryAction>(["recall_unsigned", "mcp_sandbox_recall"]);
const RECALL_ACTIONS: ReadonlySet<TelemetryAction> = new Set<TelemetryAction>(["recall", "recall_unsigned"]);

/**
 * The reasons a challenge or registration request is refused, as written to blobs[4] of a registration_failed
 * point. A closed list: the status of that action is typed to it, and writeTelemetry writes OTHER for anything else,
 * so no request text can ever reach the dataset. REGISTRATION_LIMIT_PREFIX and REGISTRATION_LIMIT_ASN are two labels
 * for the one response code REGISTRATION_LIMIT, so the dashboard can tell the per-network cap from the per-ASN cap.
 */
export const REGISTRATION_FAILURE_CODES = [
  "CLIENT_IP_UNAVAILABLE",
  "RATE_LIMITED",
  "BODY_TOO_LARGE",
  "INVALID_REQUEST",
  "SERVICE_MISCONFIGURED",
  "CHALLENGE_INVALID",
  "INVALID_CHALLENGE",
  "CHALLENGE_EXPIRED",
  "CHALLENGE_WRONG_NETWORK",
  "POW_INVALID",
  "PROOF_OF_POSSESSION_FAILED",
  "CHALLENGE_USED",
  "AGENT_KEY_EXISTS",
  "REGISTRATION_LIMIT_PREFIX",
  "REGISTRATION_LIMIT_ASN",
  "OTHER",
] as const;
export type RegistrationFailureCode = (typeof REGISTRATION_FAILURE_CODES)[number];

/** The only request fields a registration_failed point may name (the register body's five fields). */
export const REGISTRATION_FIELDS: readonly string[] = ["public_key", "challenge_id", "challenge_signature", "nonce", "proof_signature"];

/** A request field name safe to write: one of the register body's own fields, else "unknown_field". */
export function registrationFieldLabel(path: string | undefined): string {
  return path !== undefined && REGISTRATION_FIELDS.includes(path) ? path : "unknown_field";
}

/** A ref tag: a lowercase slug of 1-32 characters. Anything else (an email, a URL, a sentence) is dropped. */
const REF_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * The ref tag of a request, or "" when it is missing, repeated or malformed. Never throws and never rejects
 * the request: a bad ref only costs the attribution.
 */
export function parseRef(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const ref = raw.trim().toLowerCase();
  return REF_PATTERN.test(ref) ? ref : "";
}

/** The ref of a URL's query string. A repeated `ref` is ambiguous, so it counts as no ref. */
export function refFromUrl(url: string): string {
  try {
    const values = new URL(url).searchParams.getAll("ref");
    return values.length === 1 ? parseRef(values[0]) : "";
  } catch {
    return "";
  }
}

/** The agent id written for unauthenticated callers (the public MCP sandbox), which have no key. */
export const ANONYMOUS_AGENT_ID = "anonymous";

export interface TelemetryEvent {
  action: TelemetryAction;
  domain: string;
  tool: string;
  /** The caller's raw agent key, hashed before it is written. null for unauthenticated callers. */
  agentKey: string | null;
  status: TelemetryStatus | RegistrationFailureCode;
  /** Funnel steps only: the already-parsed ref ("" for none). When set, it is written as blobs[5]. */
  ref?: string;
  /** Written as blobs[6] (with ref as blobs[5], "" if absent). Only values from a fixed list or a strict UUID. */
  detail?: string;
  /** recall and recall_unsigned only: written as blobs[7] (CLIENT_LABELS; anything else is written as "other"). */
  client?: string;
  /** Overrides indexes[0], which is otherwise the agent id. */
  index?: string;
}

/** Hex characters of the SHA-256 digest kept as the agent id (128 bits). */
export const AGENT_ID_HEX_LENGTH = 32;

/**
 * Pseudonymous agent id: the first 128 bits of SHA-256 over a domain-separated agent key. Stable per key,
 * so unique agents can be counted, and distinct from every other hash of the key MOM stores.
 */
export async function anonymiseAgentKey(agentKey: string): Promise<string> {
  return (await sha256Hex(`achromat-telemetry-v1\n${agentKey}`)).slice(0, AGENT_ID_HEX_LENGTH);
}

/** Writes one data point. Never throws: a telemetry failure is logged and otherwise ignored. */
export async function writeTelemetry(env: Env, event: TelemetryEvent): Promise<void> {
  try {
    const agentId = event.agentKey === null ? ANONYMOUS_AGENT_ID : await anonymiseAgentKey(event.agentKey);
    // The status of a failed registration must be one of the known codes; anything else is not written.
    const status =
      event.action === "registration_failed" && !(REGISTRATION_FAILURE_CODES as readonly string[]).includes(event.status) ? "OTHER" : event.status;
    // A recall's detail must be a known miss reason and its client a known label: nothing else is ever written there.
    const recall = RECALL_ACTIONS.has(event.action);
    const detail = recall && event.detail !== undefined && !(MISS_REASONS as readonly string[]).includes(event.detail) ? "" : event.detail;
    const client = event.client === undefined ? undefined : (CLIENT_LABELS as readonly string[]).includes(event.client) ? event.client : "other";
    const trailing: string[] = [];
    if (event.ref !== undefined || detail !== undefined || client !== undefined) trailing.push(event.ref ?? "");
    if (detail !== undefined || client !== undefined) trailing.push(detail ?? "");
    if (client !== undefined) trailing.push(client);
    env.ANALYTICS.writeDataPoint({
      indexes: [event.index ?? (DEDICATED_INDEX.has(event.action) ? event.action : agentId)],
      blobs: [event.action, event.domain, event.tool, agentId, status, ...trailing],
      doubles: [1],
    });
  } catch (error) {
    console.error("achromat-mom telemetry write failed", error instanceof Error ? error.message : error);
  }
}

/**
 * Records telemetry off the response path: the hash and write run under waitUntil, so the handler returns
 * without awaiting them (writeDataPoint itself is non-blocking).
 */
export function recordTelemetry<E extends { Bindings: Env }>(c: Context<E>, event: TelemetryEvent): void {
  const task = writeTelemetry(c.env, event);
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // No execution context (direct unit-test calls): the promise still runs.
  }
}

/** The same for code that has no Hono context (the document routes in src/index.ts). */
export function recordTelemetryWith(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, event: TelemetryEvent): void {
  ctx.waitUntil(writeTelemetry(env, event));
}
