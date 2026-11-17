/**
 * What the digest sends: each row's choice (the proposal unless the operator changed it) turned into review inputs.
 * Kept apart from digest.ts, which has no imports of values, so the out-of-band script can embed it unchanged.
 */
import { isOwnLesson, type ReviewInput, type ReviewReasonCode } from "./adminApi";
import type { DigestRow, Proposal } from "./digest";

/** One row's decision: approve, leave it in the queue, or reject with a reason code. */
export type DigestChoice = "approve" | "leave" | `reject:${ReviewReasonCode}`;

export function choiceOf(proposal: Proposal): DigestChoice {
  if (proposal.decision === "reject") return `reject:${proposal.reasonCode}`;
  return proposal.decision;
}

/** The decisions to send, in digest order: every row that is not "leave" and not the operator's own lesson. */
export function inputsFrom(rows: readonly DigestRow[], choices: Readonly<Record<string, DigestChoice>>, agentKeyHex: string): ReviewInput[] {
  const inputs: ReviewInput[] = [];
  for (const row of rows) {
    if (isOwnLesson(row.lesson, agentKeyHex)) continue;
    const choice = choices[row.lesson.lessonId] ?? choiceOf(row.proposal);
    if (choice === "approve") inputs.push({ lessonId: row.lesson.lessonId, decision: "approve" });
    else if (choice.startsWith("reject:")) inputs.push({ lessonId: row.lesson.lessonId, decision: "reject", reasonCode: choice.slice("reject:".length) as ReviewReasonCode });
  }
  return inputs;
}

/** Row numbers from text such as "3, 8 and 11". Numbers outside 1..max are dropped. */
export function parseRowNumbers(text: string, max: number): number[] {
  return [...new Set((text.match(/\d+/g) ?? []).map(Number).filter((n) => n >= 1 && n <= max))];
}

