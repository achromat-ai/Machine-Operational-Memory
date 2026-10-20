/**
 * API consumption telemetry: one Workers Analytics Engine data point per answered /recall or /calibrate
 * request (dataset achromat_mom_telemetry, binding ANALYTICS).
 *
 *   doubles[0]  1 (request count; sum it, weighted by _sample_interval)
 *   blobs[0]    action: recall | calibrate_trap | calibrate_fix
 *   blobs[1]    domain
 *   blobs[2]    tool_name
 *   blobs[3]    anonymised agent id (see anonymiseAgentKey)
 *   blobs[4]    status: hit | miss | budget_exhausted (recall), allow | block (calibrate)
 *   indexes[0]  the anonymised agent id, so sampling keeps each agent's requests together
 *
 * Only these fields are written: never the raw Ed25519 key, task descriptions, arguments or IPs.
 * Telemetry is best effort and never changes or delays the response.
 */
import type { Context } from "hono";
import type { Env } from "./env";
import { sha256Hex } from "./schema";

export type TelemetryAction = "recall" | "calibrate_trap" | "calibrate_fix";
export type TelemetryStatus = "hit" | "miss" | "budget_exhausted" | "allow" | "block";

export interface TelemetryEvent {
  action: TelemetryAction;
  domain: string;
  tool: string;
  /** The caller's raw agent key. Hashed before it is written. */
  agentKey: string;
  status: TelemetryStatus;
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
    const agentId = await anonymiseAgentKey(event.agentKey);
    env.ANALYTICS.writeDataPoint({
      indexes: [agentId],
      blobs: [event.action, event.domain, event.tool, agentId, event.status],
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
