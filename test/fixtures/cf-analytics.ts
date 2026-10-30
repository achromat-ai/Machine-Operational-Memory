/**
 * Fake Cloudflare Analytics Engine SQL API for GET /api/v1/admin/telemetry tests.
 *
 * Replaces global fetch. Only POST to the test account's analytics_engine/sql endpoint is answered; any other
 * outbound request throws, so a test can never reach the real network. The three queries the route sends are told
 * apart by their SQL text and answered from canned rows. Nothing here is a secret.
 */
import { vi } from "vitest";

export const TEST_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const TEST_ANALYTICS_TOKEN = "test-only-analytics-api-token";
export const ANALYTICS_URL = `https://api.cloudflare.com/client/v4/accounts/${TEST_ACCOUNT_ID}/analytics_engine/sql`;

export type CfQueryName = "funnel" | "registrations" | "activity" | "failures" | "searches" | "lessonViews";

export interface CfRows {
  funnel?: unknown[];
  registrations?: unknown[];
  activity?: unknown[];
  failures?: unknown[];
  searches?: unknown[];
  lessonViews?: unknown[];
}

/** How one query is answered instead of the canned rows. */
export interface CfBehaviour {
  /** HTTP status of the reply. Default 200. */
  status?: number;
  /** Raw reply body, used instead of the JSON built from the rows. */
  body?: string;
  /** Make fetch itself fail (network error, TimeoutError). */
  throws?: Error;
}

export interface RecordedCfRequest {
  query: CfQueryName;
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  sql: string;
}

export function classify(sql: string): CfQueryName {
  if (sql.includes("'registration_failed'")) return "failures";
  if (sql.includes("'human_search'")) return "searches";
  if (sql.includes("'lesson_view'")) return "lessonViews";
  if (sql.includes("'recall'")) return "activity";
  if (sql.includes("'skill_view'")) return "funnel";
  return "registrations";
}

export function mockCloudflareAnalytics(
  rows: CfRows = {},
  behaviour: Partial<Record<CfQueryName, CfBehaviour>> = {},
): { requests: RecordedCfRequest[]; restore: () => void } {
  const requests: RecordedCfRequest[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== ANALYTICS_URL || request.method !== "POST") {
      throw new Error(`unexpected outbound fetch: ${request.method} ${request.url}`);
    }
    const sql = await request.text();
    const query = classify(sql);
    requests.push({
      query,
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      sql,
    });
    const how = behaviour[query] ?? {};
    if (how.throws) throw how.throws;
    const data = rows[query] ?? [];
    return new Response(how.body ?? JSON.stringify({ meta: [], data, rows: data.length }), {
      status: how.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { requests, restore: () => spy.mockRestore() };
}
