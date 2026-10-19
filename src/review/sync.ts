/**
 * Vectorize sync: makes the index agree with lesson_state.
 *
 * lesson_state.visibility drives it (the review_events triggers bump
 * vector_desired_version on every visibility change):
 *
 *   visibility 'k:<token>' (pending_review)  → upsert, review_status "pending_review"
 *   visibility 'public'    (approved)        → upsert, review_status "approved"
 *   visibility 'none'      (rejected, quarantined, audit_reject) → deleteByIds
 *
 * Vectorize and D1 cannot share a transaction, so the order is: call Vectorize,
 * then INSERT the vector_sync_events ack, whose trigger advances
 * vector_synced_version in the same D1 statement. A failure anywhere before the
 * ack leaves vector_synced_version < vector_desired_version, and the cron picks
 * the lesson up again. Upserts and deletes are idempotent, so a repeat is harmless.
 *
 * The task text that is embedded is the lesson's lesson_embedding_text override when it has one
 * (migration 0003), otherwise fixes.task_description. The evidence itself is never rewritten.
 */
import type { Env } from "../env";
import { embedMany } from "../search/embed";
import { buildIndexText, EMBED_VERSION } from "../search/intent";
import type { SearchDeps, VectorRecord } from "../search/vectors";

interface DriftRow {
  lesson_id: string;
  domain: string;
  tool_name: string;
  violation_rule: string;
  review_status: string;
  visibility: string;
  desired: number;
  task_description: string;
  fix_arguments_json: string;
  trap_arguments_json: string;
}

export interface SyncResult {
  upserted: number;
  deleted: number;
  failed: number;
}

export const SYNC_BATCH_LIMIT = 50;

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function syncVectors(
  env: Env,
  deps: SearchDeps,
  options: { lessonId?: string; limit?: number; nowMs?: number } = {},
): Promise<SyncResult> {
  const result: SyncResult = { upserted: 0, deleted: 0, failed: 0 };
  const rows = (
    await env.DB.prepare(
      `SELECT l.lesson_id, l.domain, l.tool_name, l.violation_rule, s.review_status, s.visibility,
              s.vector_desired_version AS desired, COALESCE(o.text, f.task_description) AS task_description,
              f.fix_arguments_json, e.trap_arguments_json
         FROM lesson_state s
         JOIN lessons l ON l.lesson_id = s.lesson_id
         JOIN fixes f ON f.allow_receipt_id = l.fix_event_id
         JOIN trap_events e ON e.block_receipt_id = l.trap_event_id
         LEFT JOIN lesson_embedding_text o ON o.lesson_id = l.lesson_id
        WHERE s.vector_synced_version < s.vector_desired_version AND (?1 IS NULL OR l.lesson_id = ?1)
        ORDER BY s.updated_at_ms
        LIMIT ?2`,
    )
      .bind(options.lessonId ?? null, options.limit ?? SYNC_BATCH_LIMIT)
      .all<DriftRow>()
  ).results;
  if (rows.length === 0) return result;

  const removals = rows.filter((row) => row.visibility === "none");
  const additions = rows.filter((row) => row.visibility !== "none");

  const synced: Array<{ row: DriftRow; operation: "upsert" | "delete" }> = [];

  if (removals.length > 0) {
    try {
      await deps.vectors.deleteByIds(removals.map((row) => row.lesson_id));
      for (const row of removals) synced.push({ row, operation: "delete" });
    } catch (error) {
      result.failed += removals.length;
      console.error("achromat-mom vector delete failed", error instanceof Error ? error.message : error);
    }
  }

  if (additions.length > 0) {
    const vectors = await embedMany(
      deps.embedder,
      additions.map((row) => (scale: number) =>
        buildIndexText(
          {
            taskDescription: row.task_description,
            violationRule: row.violation_rule,
            trapArguments: parse(row.trap_arguments_json),
            fixArguments: parse(row.fix_arguments_json),
          },
          scale,
        ),
      ),
    );
    const records: VectorRecord[] = [];
    const recorded: DriftRow[] = [];
    additions.forEach((row, i) => {
      const values = vectors[i];
      if (!values) {
        result.failed += 1;
        return;
      }
      records.push({
        id: row.lesson_id,
        namespace: row.domain,
        values,
        metadata: {
          tool_name: row.tool_name,
          visibility: row.visibility,
          review_status: row.review_status === "approved" ? "approved" : "pending_review",
          embed_v: EMBED_VERSION,
        },
      });
      recorded.push(row);
    });
    if (records.length > 0) {
      try {
        await deps.vectors.upsert(records);
        for (const row of recorded) synced.push({ row, operation: "upsert" });
      } catch (error) {
        result.failed += records.length;
        console.error("achromat-mom vector upsert failed", error instanceof Error ? error.message : error);
      }
    }
  }

  const nowMs = options.nowMs ?? Date.now();
  for (const { row, operation } of synced) {
    try {
      await env.DB.prepare("INSERT INTO vector_sync_events (lesson_id, version, operation, synced_at_ms) VALUES (?1, ?2, ?3, ?4)")
        .bind(row.lesson_id, row.desired, operation, nowMs)
        .run();
      if (operation === "upsert") result.upserted += 1;
      else result.deleted += 1;
    } catch (error) {
      // Typically a concurrent runner already acknowledged this version.
      console.log("achromat-mom vector ack skipped", row.lesson_id, error instanceof Error ? error.message : error);
    }
  }
  return result;
}
