/**
 * ramen-ai evaluation client for the passive /calibrate proxy.
 *
 * MOM sends the evaluated input itself, with its own Enterprise key, to a fixed
 * https endpoint. The key is never sent anywhere else, and upstream error bodies
 * (which can describe the enterprise account) are logged truncated, never relayed.
 */
import type { UpstreamScope } from "../config/domains";
import { UpstreamEvaluation } from "../schema";

export const RAMEN_EVALUATE_URL = "https://api.ramenai.dev/api/v1/paas/evaluate";
export const UPSTREAM_TIMEOUT_MS = 20_000;
/** Upper bound on the response body MOM will parse. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type UpstreamResult =
  | { ok: true; evaluation: UpstreamEvaluation }
  | { ok: false; status: 502 | 504; code: "UPSTREAM_TIMEOUT" | "UPSTREAM_UNAVAILABLE" | "UPSTREAM_INVALID"; error: string };

/** Sends exactly one of `policy_ids` (a tool-scoped list) or `bundle_ids` (the domain bundle), never both. */
export async function evaluateUpstream(apiKey: string, scope: UpstreamScope, input: string): Promise<UpstreamResult> {
  let response: Response;
  try {
    response = await fetch(RAMEN_EVALUATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(scope.kind === "policies" ? { policy_ids: [...scope.policyIds], input } : { bundle_ids: [scope.id], input }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    console.error("achromat-mom calibrate upstream fetch failed", timedOut ? "timeout" : error);
    return timedOut
      ? { ok: false, status: 504, code: "UPSTREAM_TIMEOUT", error: "ramen-ai evaluation timed out" }
      : { ok: false, status: 502, code: "UPSTREAM_UNAVAILABLE", error: "ramen-ai evaluation unreachable" };
  }

  const text = await response.text();
  if (!response.ok) {
    console.error("achromat-mom calibrate upstream error", response.status, text.slice(0, 500));
    return { ok: false, status: 502, code: "UPSTREAM_UNAVAILABLE", error: "ramen-ai evaluation failed" };
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    return { ok: false, status: 502, code: "UPSTREAM_INVALID", error: "ramen-ai returned an oversized response" };
  }

  let data: unknown;
  try {
    data = (JSON.parse(text) as { data?: unknown } | null)?.data;
  } catch {
    data = undefined;
  }
  const parsed = UpstreamEvaluation.safeParse(data);
  if (!parsed.success) {
    return { ok: false, status: 502, code: "UPSTREAM_INVALID", error: "ramen-ai returned an unexpected response shape" };
  }
  return { ok: true, evaluation: parsed.data };
}
