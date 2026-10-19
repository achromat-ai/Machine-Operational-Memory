/**
 * Internal (bounty) lessons: auto-approval and the 10% audit lottery. These pairs need a trap
 * whose window has closed, so they are built with the direct-SQL ledger fixture, which still passes
 * every D1 trigger.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { autoApproveBounty, auditDraw } from "../src/review/triage";
import { processLesson } from "../src/review/pipeline";
import { community, insertInternalAgent, insertPair, lessonState, pauseAutoApprove, reviewActions, uuid, FIX_ARGUMENTS } from "./fixtures/ledger";
import { freshWorld } from "./fixtures/world";

/** A lesson id whose deterministic draw lands on the requested side of the 10% lottery. */
async function lessonIdWhere(sampled: boolean): Promise<string> {
  for (let i = 0; i < 1000; i++) {
    const id = uuid();
    if ((await auditDraw(id)).sampled === sampled) return id;
  }
  throw new Error("no lesson id found");
}

async function bountyPair(options: { lessonId?: string; fixerKey?: string; fixArguments?: Record<string, unknown> } = {}) {
  const owner = await community();
  const fixerKey = options.fixerKey ?? (await insertInternalAgent());
  const pair = await insertPair({
    ownerKey: owner.key,
    kind: "bounty",
    fixerKey,
    ...(options.lessonId ? { lessonId: options.lessonId } : {}),
    ...(options.fixArguments ? { fixArguments: options.fixArguments } : {}),
  });
  return { ...pair, fixerKey, owner };
}

describe("internal bounty lessons", () => {
  it("auto-approves a lesson that passes triage and was not drawn, and publishes its vector", async () => {
    const world = await freshWorld();
    const { lessonId } = await bountyPair({ lessonId: await lessonIdWhere(false) });
    expect((await lessonState(lessonId))!.review_status).toBe("pending_triage");

    const result = await processLesson(env, world.deps, lessonId);
    expect(result).toMatchObject({ triage: { state: "passed" }, approval: "approved" });

    expect(await reviewActions(lessonId)).toEqual(["triage_pass", "approve"]);
    expect(await lessonState(lessonId)).toEqual({ review_status: "approved", visibility: "public", audit_status: "none", desired: 2, synced: 2 });
    expect(world.store.records.get(lessonId)!.metadata).toMatchObject({ visibility: "public", review_status: "approved" });

    // The intermediate pending_review version is skipped: only the final state is published.
    const sync = await env.DB.prepare("SELECT version, operation FROM vector_sync_events WHERE lesson_id = ?1").bind(lessonId).all();
    expect(sync.results).toEqual([{ version: 2, operation: "upsert" }]);
    expect(world.store.upsertCalls).toHaveLength(1);

    const approval = await env.DB.prepare("SELECT actor_type, details_json FROM review_events WHERE lesson_id = ?1 AND action = 'approve'")
      .bind(lessonId)
      .first<{ actor_type: string; details_json: string }>();
    expect(approval!.actor_type).toBe("internal_auto");
    expect(JSON.parse(approval!.details_json)).toMatchObject({ audit_rate: 0.1, sampled: false });
  });

  it("approves a drawn lesson and flags it for a human audit", async () => {
    const world = await freshWorld();
    const { lessonId } = await bountyPair({ lessonId: await lessonIdWhere(true) });
    expect(await processLesson(env, world.deps, lessonId)).toMatchObject({ approval: "approved_and_sampled" });

    expect(await reviewActions(lessonId)).toEqual(["triage_pass", "approve", "sample_for_audit"]);
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "approved", visibility: "public", audit_status: "sampled" });
    const sampler = await env.DB.prepare("SELECT actor_type FROM review_events WHERE lesson_id = ?1 AND action = 'sample_for_audit'").bind(lessonId).first();
    expect(sampler).toEqual({ actor_type: "audit_sampler" });
  });

  it("leaves a lesson for a human when the fixing key's auto-approval is paused", async () => {
    const world = await freshWorld();
    const fixerKey = await insertInternalAgent();
    await pauseAutoApprove(fixerKey);
    const { lessonId } = await bountyPair({ fixerKey });

    await processLesson(env, world.deps, lessonId);
    // internal_anomaly fails (recent audit failure), so triage_fail; bounty lessons go to pending_review, not quarantine.
    expect(await reviewActions(lessonId)).toEqual(["triage_fail"]);
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "pending_review", audit_status: "none" });
    expect(world.store.records.get(lessonId)!.metadata).toMatchObject({ review_status: "pending_review" });
    expect(world.store.records.get(lessonId)!.metadata.visibility).toMatch(/^k:/);
  });

  it("does not auto-approve a bounty lesson that fails triage", async () => {
    const world = await freshWorld();
    const { lessonId } = await bountyPair({ fixArguments: { ...FIX_ARGUMENTS, approval: { second_approver: "jane.doe@example.com" } } });
    expect(await processLesson(env, world.deps, lessonId)).toMatchObject({ triage: { state: "failed", failed: ["secret_pii_scan"] }, approval: "blocked" });
    expect(await reviewActions(lessonId)).toEqual(["triage_fail"]);
    expect((await lessonState(lessonId))!.review_status).toBe("pending_review");
  });

  it("records the internal anomaly check for bounty lessons only", async () => {
    const world = await freshWorld();
    const { lessonId } = await bountyPair({ lessonId: await lessonIdWhere(false) });
    await processLesson(env, world.deps, lessonId);
    const names = (await env.DB.prepare("SELECT check_name FROM triage_checks WHERE lesson_id = ?1").bind(lessonId).all<{ check_name: string }>()).results.map((r) => r.check_name);
    expect(names).toContain("internal_anomaly");
    expect(names).toHaveLength(7);
  });

  it("never auto-approves a community lesson, whatever the draw", async () => {
    const world = await freshWorld();
    const owner = await community();
    const { lessonId } = await insertPair({ ownerKey: owner.key, kind: "community", lessonId: await lessonIdWhere(false) });
    await processLesson(env, world.deps, lessonId);
    expect(await autoApproveBounty(env, lessonId)).toBe("not_applicable");
    expect(await reviewActions(lessonId)).toEqual(["triage_pass"]);
    expect((await lessonState(lessonId))!.review_status).toBe("pending_review");
  });

  it("is picked up by the reconciler if the request-time run died between triage and approval", async () => {
    const world = await freshWorld();
    const { lessonId } = await bountyPair({ lessonId: await lessonIdWhere(false) });
    // Simulate the crash: triage verdict written, nothing after.
    const { runTriage } = await import("../src/review/triage");
    await runTriage(env, lessonId);
    expect((await lessonState(lessonId))!.review_status).toBe("pending_review");

    await world.reconcileAt({ triageMinAgeMs: 0 });
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "approved", visibility: "public" });
    expect(world.store.records.get(lessonId)!.metadata.visibility).toBe("public");
  });
});
