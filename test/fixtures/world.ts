/**
 * A Worker wired to a throwaway ramen key and fake Workers AI / Vectorize, driven over HTTP the way an
 * agent would: signed requests, with the background triage the response schedules awaited before the
 * helper returns.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { createWorker, type AppOptions } from "../../src/app";
import { reconcile } from "../../src/review/pipeline";
import { ORIGIN, freshIp, signatureHeaders, type TestAgent } from "../helpers";
import { fakeSearch } from "./search";
import { ALLOW, TEST_RAMEN_PUBLIC_KEY_HEX, mockRamen, type FakeVerdict } from "./ramen";
import { FIX_ARGUMENTS, TOOL, TRAP_ARGUMENTS, uniqueDescription } from "./ledger";

export const VIOLATION = {
  rule_id: "0eadfb7d-548d-40ca-896a-c9db9b5a6640",
  rule_name: "Dual authorisation for large transfers",
  reasoning: "Transfer above threshold lacks a second approver.",
  recovery_instruction: "Add a second approver before moving the funds.",
};

/** A BLOCK signed two seconds ago, so an ALLOW signed now is strictly later. */
export function blockVerdict(overrides: Partial<FakeVerdict> = {}): FakeVerdict {
  return {
    allowed: false,
    violations: [VIOLATION],
    anchors: ["FCA SYSC 6.1.1"],
    timestamp: new Date(Date.now() - 2000).toISOString(),
    ...overrides,
  };
}

/** In-memory ANALYTICS binding: records every data point the Worker writes. */
export function fakeAnalytics() {
  const points: AnalyticsEngineDataPoint[] = [];
  const dataset: AnalyticsEngineDataset & { points: AnalyticsEngineDataPoint[]; fail: boolean } = {
    points,
    fail: false,
    writeDataPoint(event?: AnalyticsEngineDataPoint) {
      if (this.fail) throw new Error("analytics unavailable");
      points.push(structuredClone(event ?? {}));
    },
  };
  return dataset;
}

export function createWorld(overrides: Partial<AppOptions> = {}) {
  const fake = fakeSearch();
  const analytics = fakeAnalytics();
  const worldEnv = { ...env, ANALYTICS: analytics } as typeof env;
  const worker = createWorker({
    receiptKeys: { ramen_pk_v1: TEST_RAMEN_PUBLIC_KEY_HEX },
    search: fake.search,
    ...overrides,
  });

  async function send(agent: TestAgent, path: string, payload: unknown): Promise<{ status: number; json: any; response: Response }> {
    const body = JSON.stringify(payload);
    const headers = await signatureHeaders(agent, path, { method: "POST", body });
    headers.set("CF-Connecting-IP", freshIp());
    headers.set("Content-Type", "application/json");
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(ORIGIN + path, { method: "POST", headers, body }), worldEnv, ctx);
    await waitOnExecutionContext(ctx);
    return { status: response.status, json: await response.json(), response };
  }

  return {
    ...fake,
    analytics,
    /** The env the world's worker runs with: the real bindings, except ANALYTICS records into `analytics`. */
    env: worldEnv,
    worker,
    calibrate: (agent: TestAgent, payload: unknown) => send(agent, "/api/v1/calibrate", payload),
    recall: (agent: TestAgent, payload: unknown) => send(agent, "/api/v1/recall", payload),
    /** The cron handler, as Cloudflare would invoke it. */
    runCron: (): Promise<void> => worker.scheduled(createScheduledController(), env, createExecutionContext()),
    /** reconcile() directly; `triageMinAgeMs: 0` makes just-created lessons count as stuck. */
    reconcileAt: (options: Parameters<typeof reconcile>[2] = {}) => reconcile(env, fake.deps, options),
    /**
     * D1 is shared by every test in a file, so earlier tests can leave Vectorize drift behind (a rejected
     * lesson not yet deleted from the index). Tests that count calls flush it first.
     */
    async flush(): Promise<void> {
      await reconcile(env, fake.deps, { triageMinAgeMs: 0 });
      fake.embedder.calls = [];
      fake.store.records.clear();
      fake.store.upsertCalls = [];
      fake.store.deleteCalls = [];
      analytics.points.length = 0;
    },
    /** Turn 1 + Turn 2 over HTTP; returns the lesson once triage and sync have run. */
    async createLesson(
      agent: TestAgent,
      options: { description?: string; trapArguments?: Record<string, unknown>; fixArguments?: Record<string, unknown>; domain?: string } = {},
    ): Promise<{ lessonId: string; trapId: string; description: string }> {
      const description = options.description ?? uniqueDescription();
      const domain = options.domain ?? "fintech";
      const upstream = mockRamen(blockVerdict(), ALLOW);
      try {
        const turn1 = await send(agent, "/api/v1/calibrate", {
          domain,
          tool: TOOL,
          task_description: description,
          arguments: options.trapArguments ?? TRAP_ARGUMENTS,
        });
        if (!turn1.json.trap?.recorded) throw new Error(`BLOCK was not recorded: ${JSON.stringify(turn1.json.trap)}`);
        const turn2 = await send(agent, "/api/v1/calibrate", {
          domain,
          tool: TOOL,
          task_description: description,
          arguments: options.fixArguments ?? FIX_ARGUMENTS,
        });
        if (!turn2.json.pairing?.lesson_id) throw new Error(`ALLOW did not create a lesson: ${JSON.stringify(turn2.json.pairing)}`);
        return { lessonId: turn2.json.pairing.lesson_id, trapId: turn1.json.trap.trap_id, description };
      } finally {
        upstream.restore();
      }
    },
  };
}

export type World = ReturnType<typeof createWorld>;

/** A world whose fakes start empty, even though D1 carries over lessons from earlier tests in the file. */
export async function freshWorld(overrides: Partial<AppOptions> = {}): Promise<World> {
  const world = createWorld(overrides);
  await world.flush();
  return world;
}
