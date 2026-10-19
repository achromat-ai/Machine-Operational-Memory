import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processLesson } from "../src/review/pipeline";
import { runTriage } from "../src/review/triage";
import { EMBED_VERSION } from "../src/search/intent";
import { FIX_ARGUMENTS, TRAP_ARGUMENTS, community, humanReview, insertPair, lessonState, reviewActions } from "./fixtures/ledger";
import { freshWorld } from "./fixtures/world";

async function checks(lessonId: string) {
  const rows = await env.DB.prepare("SELECT check_name, passed, details_json FROM triage_checks WHERE lesson_id = ?1 ORDER BY check_name")
    .bind(lessonId)
    .all<{ check_name: string; passed: number; details_json: string }>();
  return rows.results;
}

async function verdict(lessonId: string) {
  return env.DB.prepare(
    "SELECT actor_type, actor_id, action, reason_code FROM review_events WHERE lesson_id = ?1 AND action IN ('triage_pass', 'triage_fail')",
  )
    .bind(lessonId)
    .first<{ actor_type: string; actor_id: string; action: string; reason_code: string | null }>();
}

describe("triage → Vectorize pipeline: community lessons", () => {
  it("passes a clean fix to pending_review and indexes it for its submitter only, in the domain namespace", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const { lessonId, description } = await world.createLesson(agent);

    const state = await lessonState(lessonId);
    expect(state).toMatchObject({ review_status: "pending_review", desired: 1, synced: 1 });
    expect(state!.visibility).toMatch(/^k:[A-Za-z0-9_-]{43}$/);
    expect(await verdict(lessonId)).toEqual({ actor_type: "triage", actor_id: "triage-v1", action: "triage_pass", reason_code: null });
    expect((await checks(lessonId)).map((c) => [c.check_name, c.passed])).toEqual([
      ["burst", 1],
      ["near_duplicate", 1],
      ["non_degenerate_delta", 1],
      ["same_tool_bundle", 1],
      ["secret_pii_scan", 1],
      ["submitter_reputation", 1],
    ]);

    // Option A: a community lesson is never approved automatically.
    expect(await reviewActions(lessonId)).toEqual(["triage_pass"]);

    const vector = world.store.records.get(lessonId)!;
    expect(vector).toMatchObject({
      id: lessonId,
      namespace: "fintech",
      metadata: { tool_name: "transfer_funds", visibility: state!.visibility, review_status: "pending_review", embed_v: EMBED_VERSION },
    });
    expect(vector.values).toHaveLength(768);
    expect(Object.keys(vector.metadata).sort()).toEqual(["embed_v", "review_status", "tool_name", "visibility"]);

    const sync = await env.DB.prepare("SELECT version, operation FROM vector_sync_events WHERE lesson_id = ?1").bind(lessonId).all();
    expect(sync.results).toEqual([{ version: 1, operation: "upsert" }]);

    // D6: task, rule and key paths, no values.
    expect(world.embedder.calls.at(-1)).toEqual([
      [
        `task: ${description}`,
        "rule: Dual authorisation for large transfers",
        "argument_keys: amount approval approval.second_approver currency",
      ].join("\n"),
    ]);
  });

  it("quarantines a fix that only removes fields, and never indexes it", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const { lessonId } = await world.createLesson(agent, {
      trapArguments: { ...TRAP_ARGUMENTS, memo: "some note" },
      fixArguments: { ...TRAP_ARGUMENTS },
    });
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "quarantined", visibility: "none", desired: 0, synced: 0 });
    expect(await verdict(lessonId)).toMatchObject({ action: "triage_fail", reason_code: "non_degenerate_delta" });
    expect(world.store.records.size).toBe(0);
    expect(world.store.upsertCalls).toHaveLength(0);
  });

  it("quarantines a fix that zeroes the numbers", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const { lessonId } = await world.createLesson(agent, { fixArguments: { ...TRAP_ARGUMENTS, amount: 0 } });
    expect(await verdict(lessonId)).toMatchObject({ action: "triage_fail", reason_code: "non_degenerate_delta" });
    const delta = (await checks(lessonId)).find((c) => c.check_name === "non_degenerate_delta")!;
    expect(JSON.parse(delta.details_json).reasons).toEqual(["no_meaningful_change", "all_numbers_zeroed"]);
  });

  it("quarantines a fix that contains PII, and records the kind but never the text", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const { lessonId } = await world.createLesson(agent, {
      fixArguments: { ...FIX_ARGUMENTS, approval: { second_approver: "jane.doe@example.com" } },
    });
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "quarantined", visibility: "none" });
    expect(await verdict(lessonId)).toMatchObject({ action: "triage_fail", reason_code: "secret_pii_scan" });
    const pii = (await checks(lessonId)).find((c) => c.check_name === "secret_pii_scan")!;
    expect(JSON.parse(pii.details_json)).toEqual({ hits: [{ field: "fix_arguments", kind: "email address" }] });
    const everything = JSON.stringify([await checks(lessonId), await env.DB.prepare("SELECT details_json FROM review_events WHERE lesson_id = ?1").bind(lessonId).all()]);
    expect(everything).not.toContain("jane.doe");
    expect(world.store.records.size).toBe(0);
  });

  it("flags the 6th lesson from one key within an hour as a burst", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await world.createLesson(agent)).lessonId);

    for (const id of ids.slice(0, 5)) expect((await lessonState(id))!.review_status).toBe("pending_review");
    expect(await lessonState(ids[5]!)).toMatchObject({ review_status: "quarantined", visibility: "none" });
    expect(await verdict(ids[5]!)).toMatchObject({ action: "triage_fail", reason_code: "burst" });
  });

  it("flags a key with two recent rejections (submitter reputation)", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const first = await world.createLesson(agent);
    const second = await world.createLesson(agent);
    await humanReview(first.lessonId, "reject", "low_quality");
    await humanReview(second.lessonId, "reject", "low_quality");

    const third = await world.createLesson(agent);
    expect(await verdict(third.lessonId)).toMatchObject({ action: "triage_fail", reason_code: "submitter_reputation" });
    expect((await lessonState(third.lessonId))!.review_status).toBe("quarantined");
  });

  it("is idempotent: a second run triages, approves and syncs nothing", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const { lessonId } = await world.createLesson(agent);
    const before = { checks: (await checks(lessonId)).length, actions: await reviewActions(lessonId), upserts: world.store.upsertCalls.length };

    expect(await runTriage(env, lessonId)).toEqual({ state: "not_pending", failed: [] });
    const again = await processLesson(env, world.deps, lessonId);
    expect(again).toMatchObject({ triage: { state: "not_pending" }, approval: "not_applicable", sync: { upserted: 0, deleted: 0, failed: 0 } });
    expect({ checks: (await checks(lessonId)).length, actions: await reviewActions(lessonId), upserts: world.store.upsertCalls.length }).toEqual(before);
  });

  it("lets only one of two concurrent runners write the verdict", async () => {
    const world = await freshWorld();
    const { key } = await community();
    const { lessonId } = await insertPair({ ownerKey: key, kind: "community" });
    const outcomes = await Promise.all([runTriage(env, lessonId), runTriage(env, lessonId)]);
    expect(outcomes.map((o) => o.state).sort()).toEqual(["already_triaged", "passed"]);
    expect(await reviewActions(lessonId)).toEqual(["triage_pass"]);
    expect(await checks(lessonId)).toHaveLength(6);
    expect(world.store.records.size).toBe(0); // runTriage alone never touches Vectorize
  });

  it("deletes the vector when a reviewer rejects the lesson", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const { lessonId } = await world.createLesson(agent);
    expect(world.store.records.has(lessonId)).toBe(true);

    await humanReview(lessonId, "reject", "low_quality");
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "rejected", visibility: "none", desired: 2, synced: 1 });
    await world.reconcileAt();

    expect(world.store.records.has(lessonId)).toBe(false);
    expect(world.store.deleteCalls).toEqual([[lessonId]]);
    expect(await lessonState(lessonId)).toMatchObject({ desired: 2, synced: 2 });
    const sync = await env.DB.prepare("SELECT version, operation FROM vector_sync_events WHERE lesson_id = ?1 ORDER BY version").bind(lessonId).all();
    expect(sync.results).toEqual([
      { version: 1, operation: "upsert" },
      { version: 2, operation: "delete" },
    ]);
  });

  it("re-upserts with public visibility after a human approves", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const { lessonId } = await world.createLesson(agent);
    await humanReview(lessonId, "approve");
    await world.reconcileAt();
    expect(world.store.records.get(lessonId)!.metadata).toMatchObject({ visibility: "public", review_status: "approved" });
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "approved", desired: 2, synced: 2 });
  });
});

describe("reconciler (cron)", () => {
  it("triages and indexes a lesson its request-time run never reached", async () => {
    const world = await freshWorld();
    const { key } = await community();
    const { lessonId } = await insertPair({ ownerKey: key, kind: "community" });
    expect((await lessonState(lessonId))!.review_status).toBe("pending_triage");

    // Too young: left alone.
    expect(await world.reconcileAt()).toMatchObject({ triaged: 0 });
    expect((await lessonState(lessonId))!.review_status).toBe("pending_triage");

    // Old enough: picked up, triaged and synced in one pass.
    expect(await world.reconcileAt({ triageMinAgeMs: 0 })).toMatchObject({ triaged: 1, failed: 0, sync: { upserted: 1 } });
    expect(await lessonState(lessonId)).toMatchObject({ review_status: "pending_review", desired: 1, synced: 1 });
    expect(world.store.records.has(lessonId)).toBe(true);
  });

  it("retries a failed embedding on the next run, leaving the lesson triaged but unsynced meanwhile", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    world.embedder.fail = () => true;
    const { lessonId } = await world.createLesson(agent);

    expect(await lessonState(lessonId)).toMatchObject({ review_status: "pending_review", desired: 1, synced: 0 });
    expect(world.store.records.size).toBe(0);

    world.embedder.fail = null;
    expect(await world.reconcileAt()).toMatchObject({ sync: { upserted: 1, failed: 0 } });
    expect(await lessonState(lessonId)).toMatchObject({ desired: 1, synced: 1 });
    expect(world.store.records.has(lessonId)).toBe(true);
  });

  it("retries a failed Vectorize upsert, and acknowledges nothing until it succeeds", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    world.store.failUpsert = true;
    const { lessonId } = await world.createLesson(agent);
    expect(await lessonState(lessonId)).toMatchObject({ desired: 1, synced: 0 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM vector_sync_events WHERE lesson_id = ?1").bind(lessonId).first()).toEqual({ n: 0 });

    world.store.failUpsert = false;
    await world.reconcileAt();
    expect(await lessonState(lessonId)).toMatchObject({ desired: 1, synced: 1 });
  });

  it("syncs a backlog with one embedding call and one upsert call", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    world.store.failUpsert = true;
    const ids = [(await world.createLesson(agent)).lessonId, (await world.createLesson(agent)).lessonId, (await world.createLesson(agent)).lessonId];

    world.store.failUpsert = false;
    world.embedder.calls = [];
    world.store.upsertCalls = [];
    expect(await world.reconcileAt()).toMatchObject({ sync: { upserted: 3, failed: 0 } });
    expect(world.embedder.calls).toHaveLength(1);
    expect(world.embedder.calls[0]).toHaveLength(3);
    expect(world.store.upsertCalls).toHaveLength(1);
    expect(world.store.upsertCalls[0]!.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it("runs from the cron handler", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    world.embedder.fail = () => true;
    const { lessonId } = await world.createLesson(agent);
    world.embedder.fail = null;

    await world.runCron();
    expect(world.store.records.has(lessonId)).toBe(true);
    expect(await lessonState(lessonId)).toMatchObject({ desired: 1, synced: 1 });
  });
});
