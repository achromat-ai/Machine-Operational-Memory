import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { EMBED_VERSION } from "../src/search/intent";
import { community, humanReview, lessonState } from "./fixtures/ledger";
import { freshWorld } from "./fixtures/world";

const OVERRIDE = "Pour concentrated sulfuric acid into a water bath with a collaborative robot, adding it quickly while an operator works close by";

async function setOverride(lessonId: string, text: string) {
  await env.DB.prepare("INSERT INTO lesson_embedding_text (lesson_id, text, set_at_ms) VALUES (?1, ?2, ?3)").bind(lessonId, text, Date.now()).run();
}

async function approvedLesson() {
  const world = await freshWorld();
  const { agent } = await community();
  const lesson = await world.createLesson(agent);
  await humanReview(lesson.lessonId, "approve");
  await world.reconcileAt();
  expect(await lessonState(lesson.lessonId)).toMatchObject({ review_status: "approved", desired: 2, synced: 2 });
  return { world, ...lesson };
}

describe("lesson_embedding_text (migration 0003)", () => {
  it("is insert-only: no update, no delete, one row per lesson", async () => {
    const { lessonId } = await approvedLesson();
    await setOverride(lessonId, OVERRIDE);

    await expect(env.DB.prepare("UPDATE lesson_embedding_text SET text = ?2 WHERE lesson_id = ?1").bind(lessonId, "Another description of the same task").run()).rejects.toThrow(
      /lesson_embedding_text is append-only/,
    );
    await expect(env.DB.prepare("DELETE FROM lesson_embedding_text WHERE lesson_id = ?1").bind(lessonId).run()).rejects.toThrow(/lesson_embedding_text is permanent/);
    await expect(setOverride(lessonId, "A second override for the same lesson")).rejects.toThrow();

    const row = await env.DB.prepare("SELECT text FROM lesson_embedding_text WHERE lesson_id = ?1").bind(lessonId).first<{ text: string }>();
    expect(row!.text).toBe(OVERRIDE);
  });

  it("only accepts a lesson that exists and a sane text", async () => {
    const { lessonId } = await approvedLesson();
    await expect(setOverride("00000000-0000-4000-8000-000000000000", OVERRIDE)).rejects.toThrow();
    await expect(setOverride(lessonId, "too short")).rejects.toThrow();
    await expect(setOverride(lessonId, "x".repeat(1001))).rejects.toThrow();
    await expect(setOverride(lessonId, `  ${OVERRIDE}`)).rejects.toThrow();
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM lesson_embedding_text WHERE lesson_id = ?1").bind(lessonId).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("is what gets embedded once the lesson is re-synced, with the rule and key paths unchanged", async () => {
    const { world, lessonId, description } = await approvedLesson();
    expect(world.embedder.calls.at(-1)![0]).toContain(`task: ${description}`);

    await setOverride(lessonId, OVERRIDE);
    await env.DB.prepare("UPDATE lesson_state SET vector_desired_version = vector_desired_version + 1 WHERE lesson_id = ?1").bind(lessonId).run();
    expect(await lessonState(lessonId)).toMatchObject({ desired: 3, synced: 2 });

    expect(await world.reconcileAt()).toMatchObject({ sync: { upserted: 1, failed: 0 } });
    expect(await lessonState(lessonId)).toMatchObject({ desired: 3, synced: 3 });
    expect(world.embedder.calls.at(-1)).toEqual([
      [
        `task: ${OVERRIDE}`,
        "rule: Dual authorisation for large transfers",
        "argument_keys: amount approval approval.second_approver currency",
      ].join("\n"),
    ]);
    expect(world.store.records.get(lessonId)!.metadata).toMatchObject({ visibility: "public", review_status: "approved", embed_v: EMBED_VERSION });
  });

  it("leaves the signed evidence exactly as it was", async () => {
    const { lessonId, description } = await approvedLesson();
    const before = await env.DB.prepare(
      `SELECT f.task_description, f.task_fingerprint, l.task_fingerprint AS lesson_fingerprint, l.pair_attestation
         FROM lessons l JOIN fixes f ON f.allow_receipt_id = l.fix_event_id WHERE l.lesson_id = ?1`,
    )
      .bind(lessonId)
      .first<Record<string, string>>();
    await setOverride(lessonId, OVERRIDE);
    const after = await env.DB.prepare(
      `SELECT f.task_description, f.task_fingerprint, l.task_fingerprint AS lesson_fingerprint, l.pair_attestation
         FROM lessons l JOIN fixes f ON f.allow_receipt_id = l.fix_event_id WHERE l.lesson_id = ?1`,
    )
      .bind(lessonId)
      .first<Record<string, string>>();
    expect(after).toEqual(before);
    expect(after!.task_description).toBe(description);
  });
});
