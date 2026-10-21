/**
 * API consumption telemetry: one Workers Analytics Engine data point per answered /recall or /calibrate
 * request, per sandbox achromat_recall call on POST /mcp, and per activation-funnel step: a protocol document
 * view, an issued challenge and a registration (dataset achromat_mom_telemetry, binding ANALYTICS).
 *
 *   doubles[0]  1 (request count; sum it, weighted by _sample_interval)
 *   blobs[0]    action: recall | calibrate_trap | calibrate_fix | mcp_sandbox_recall
 *                       | skill_view | challenge_issued | agent_register
 *   blobs[1]    domain; for skill_view the document name (skill.md, fintech.md, ...); "" for the other funnel steps
 *   blobs[2]    tool_name ("" for funnel steps)
 *   blobs[3]    anonymised agent id (see anonymiseAgentKey), or "anonymous" for callers without a key
 *   blobs[4]    status: hit | miss | budget_exhausted (recall), allow | block (calibrate), sample | empty (sandbox),
 *                       served | issued | registered (funnel)
 *   blobs[5]    funnel steps only: the marketing `ref` tag from the URL's query string, or "" (see parseRef)
 *   indexes[0]  the anonymised agent id, so sampling keeps each agent's requests together
 *
 * `agent_register` carries the new key's anonymised id, which is also the id on that key's later recall and
 * calibrate points, so a ref can be followed to first use without a cookie. `ref` is the only caller-supplied
 * string written and it is restricted to a short slug. Never written: the raw Ed25519 key, task descriptions,
 * arguments or IPs. Telemetry is best effort and never changes or delays the response.
 */
import type { Context } from "hono";
import type { Env } from "./env";
import { sha256Hex } from "./schema";

export type TelemetryAction =
  | "recall"
  | "calibrate_trap"
  | "calibrate_fix"
  | "mcp_sandbox_recall"
  | "skill_view"
  | "challenge_issued"
  | "agent_register";
export type TelemetryStatus = "hit" | "miss" | "budget_exhausted" | "allow" | "block" | "sample" | "empty" | "served" | "issued" | "registered";

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
  status: TelemetryStatus;
  /** Funnel steps only: the already-parsed ref ("" for none). When set, it is written as blobs[5]. */
  ref?: string;
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
    env.ANALYTICS.writeDataPoint({
      indexes: [agentId],
      blobs: [event.action, event.domain, event.tool, agentId, event.status, ...(event.ref === undefined ? [] : [event.ref])],
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
