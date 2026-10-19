/**
 * Background lesson pipeline: triage → (bounty) auto-approval + audit lottery → Vectorize sync.
 *
 * processLesson runs right after /calibrate binds a pair (ctx.waitUntil, 30 s budget).
 * reconcile runs on a cron every 5 minutes and retries whatever a crash, a Workers AI
 * error or a Vectorize error left behind, using only durable D1 state.
 */
import type { Env } from "../env";
import type { SearchDeps } from "../search/vectors";
import { syncVectors, SYNC_BATCH_LIMIT, type SyncResult } from "./sync";
import { autoApproveBounty, runTriage, type AutoApproveOutcome, type TriageOutcome } from "./triage";

export interface ProcessResult {
  triage: TriageOutcome;
  approval: AutoApproveOutcome;
  sync: SyncResult;
}

export async function processLesson(env: Env, deps: SearchDeps, lessonId: string, nowMs: number = Date.now()): Promise<ProcessResult> {
  const triage = await runTriage(env, lessonId, nowMs);
  const approval = await autoApproveBounty(env, lessonId, nowMs);
  const sync = await syncVectors(env, deps, { lessonId, nowMs });
  return { triage, approval, sync };
}

/** A lesson still pending_triage after this long was missed by its waitUntil run. */
export const TRIAGE_MIN_AGE_MS = 2 * 60 * 1000;
export const TRIAGE_BATCH_LIMIT = 25;

export interface ReconcileResult {
  triaged: number;
  failed: number;
  sync: SyncResult;
}

export async function reconcile(
  env: Env,
  deps: SearchDeps,
  /** triageMinAgeMs only shifts which lessons count as "stuck"; every write still uses the real clock (the D1 clock guards require it). */
  options: { triageMinAgeMs?: number } = {},
): Promise<ReconcileResult> {
  const nowMs = Date.now();
  const cutoff = nowMs - (options.triageMinAgeMs ?? TRIAGE_MIN_AGE_MS);

  // Lessons the waitUntil run never triaged, plus bounty lessons stuck between triage_pass and auto-approval.
  const stuck = (
    await env.DB.prepare(
      `SELECT s.lesson_id FROM lesson_state s WHERE s.review_status = 'pending_triage' AND s.updated_at_ms <= ?1
       UNION
       SELECT l.lesson_id FROM lessons l
         JOIN lesson_state s ON s.lesson_id = l.lesson_id
         JOIN agent_state a ON a.agent_key = l.fixed_by_key AND a.auto_approve_enabled = 1
        WHERE l.provenance = 'community_trap+internal_fix' AND s.review_status = 'pending_review' AND s.updated_at_ms <= ?1
          AND EXISTS (SELECT 1 FROM review_events r WHERE r.lesson_id = l.lesson_id AND r.action = 'triage_pass')
       LIMIT ?2`,
    )
      .bind(cutoff, TRIAGE_BATCH_LIMIT)
      .all<{ lesson_id: string }>()
  ).results;

  let triaged = 0;
  let failed = 0;
  for (const { lesson_id } of stuck) {
    try {
      // Sync happens once below, in one batch, rather than per lesson.
      await runTriage(env, lesson_id, nowMs);
      await autoApproveBounty(env, lesson_id, nowMs);
      triaged += 1;
    } catch (error) {
      failed += 1;
      console.error("achromat-mom reconcile triage failed", lesson_id, error instanceof Error ? error.message : error);
    }
  }

  const sync = await syncVectors(env, deps, { limit: SYNC_BATCH_LIMIT, nowMs });
  return { triaged, failed, sync };
}
