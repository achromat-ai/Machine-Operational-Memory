import { Fragment, useId, useState } from "react";
import { BATCH_MAX, REVIEW_REASONS, isOwnLesson, type PendingLesson, type ReviewInput } from "../../lib/adminApi";
import { buildDigest } from "../../lib/digest";
import { choiceOf, inputsFrom, parseRowNumbers, type DigestChoice } from "../../lib/digestDecisions";
import DeltaCard from "../public/DeltaCard";

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const CELL = "px-3 py-2 align-top text-sm text-slate-800";
const BUTTON =
  "rounded-md px-4 py-2 text-sm font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-50";

function TriageSummary({ lesson }: { lesson: PendingLesson }) {
  if (lesson.triage.length === 0) return <span className="text-slate-600">none</span>;
  const failed = lesson.triage.filter((check) => !check.passed);
  if (failed.length === 0) return <span className="font-semibold text-compliant">✓ {lesson.triage.length}/{lesson.triage.length}</span>;
  return (
    <span className="font-semibold text-blocked">
      ✕ {failed.map((check) => check.check).join(", ")}
    </span>
  );
}

export interface ReviewDigestProps {
  lessons: readonly PendingLesson[];
  agentKeyHex: string;
  /** Sends the decisions as batches. Resolves when done; the parent removes decided lessons from `lessons`. */
  onSubmit: (inputs: ReviewInput[]) => Promise<void>;
  /** The queue has more pages. */
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}

/**
 * The review digest: the queue as one scannable table, numbered, with the mechanical checks already run. Clean rows
 * start as "Approve", flagged rows as "Reject" (a hard flag) or "Leave" (any doubt), and the operator changes any row
 * before sending everything in one batch. Nothing is sent until the summary has been confirmed. Everything shown
 * comes from community text and is rendered as plain text.
 */
export default function ReviewDigest({ lessons, agentKeyHex, onSubmit, hasMore, loading, onLoadMore }: ReviewDigestProps) {
  const rows = buildDigest(lessons);
  const [choices, setChoices] = useState<Record<string, DigestChoice>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [leaveText, setLeaveText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const leaveId = useId();

  const inputs = inputsFrom(rows, choices, agentKeyHex);
  const approves = inputs.filter((input) => input.decision === "approve").length;
  const rejects = inputs.length - approves;
  const flaggedApproves = rows.filter((row) => inputs.some((input) => input.lessonId === row.lesson.lessonId && input.decision === "approve") && row.flags.length > 0).length;

  function choose(lessonId: string, choice: DigestChoice) {
    setConfirming(false);
    setChoices((current) => ({ ...current, [lessonId]: choice }));
  }

  function leaveRows() {
    const numbers = new Set(parseRowNumbers(leaveText, rows.length));
    setConfirming(false);
    setChoices((current) => {
      const next = { ...current };
      for (const row of rows) if (numbers.has(row.index)) next[row.lesson.lessonId] = "leave";
      return next;
    });
  }

  function toggle(lessonId: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(lessonId)) next.add(lessonId);
      return next;
    });
  }

  async function send() {
    setSending(true);
    try {
      await onSubmit(inputs);
      setChoices({});
    } finally {
      setSending(false);
      setConfirming(false);
    }
  }

  if (rows.length === 0) return null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-700">
        {rows.length} {rows.length === 1 ? "lesson" : "lessons"} loaded. Clean rows start as Approve, rows with a hard flag as Reject, and anything doubtful as Leave. Check each flag,
        change any row, then send everything at once (at most {BATCH_MAX} per request).
      </p>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200">
          <caption className="sr-only">Lessons waiting for a decision, one row each</caption>
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-700">
            <tr>
              <th scope="col" className="px-3 py-2">#</th>
              <th scope="col" className="px-3 py-2">Tool</th>
              <th scope="col" className="px-3 py-2">Task</th>
              <th scope="col" className="px-3 py-2">Rule class</th>
              <th scope="col" className="px-3 py-2">Change</th>
              <th scope="col" className="px-3 py-2">Checks</th>
              <th scope="col" className="px-3 py-2">Coverage</th>
              <th scope="col" className="px-3 py-2">Flags</th>
              <th scope="col" className="px-3 py-2">Decision</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => {
              const lesson = row.lesson;
              const own = isOwnLesson(lesson, agentKeyHex);
              const choice = own ? "leave" : (choices[lesson.lessonId] ?? choiceOf(row.proposal));
              const hard = row.flags.some((flag) => flag.severity === "reject");
              const expanded = open.has(lesson.lessonId);
              return (
                <Fragment key={lesson.lessonId}>
                  <tr className={hard ? "bg-blocked/5" : undefined}>
                    <th scope="row" className={`${CELL} font-semibold`}>{row.index}</th>
                    <td className={CELL}>
                      <code className="font-mono text-xs">{lesson.tool}</code>
                      <div className="text-xs text-slate-600">{lesson.domain}</div>
                    </td>
                    <td className={`${CELL} max-w-xs break-words`}>{short(lesson.taskDescription, 70)}</td>
                    <td className={`${CELL} max-w-xs break-all font-mono text-xs`}>{row.ruleClass}</td>
                    <td className={`${CELL} max-w-xs font-mono text-xs`}>
                      {row.changes.map((change) => (
                        <div key={change.path} className="break-all">
                          {short(change.path, 28)}: {change.before} → {change.after}
                        </div>
                      ))}
                    </td>
                    <td className={CELL}><TriageSummary lesson={lesson} /></td>
                    <td className={CELL}>
                      {row.coverage.kind === "new" ? (
                        <span className="font-semibold text-compliant">NEW</span>
                      ) : (
                        <span className="text-slate-800">covered by <code className="font-mono text-xs">{row.coverage.by.slice(0, 8)}</code></span>
                      )}
                    </td>
                    <td className={`${CELL} max-w-xs`}>
                      {row.flags.length === 0 ? (
                        <span className="text-slate-600">none</span>
                      ) : (
                        <ul className="space-y-1">
                          {row.flags.map((flag) => (
                            <li key={flag.code} className={flag.severity === "reject" ? "font-semibold text-blocked" : "text-slate-900"}>
                              {flag.severity === "reject" ? "✕ " : "• "}
                              {flag.text}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className={CELL}>
                      <label className="sr-only" htmlFor={`${leaveId}-${row.index}`}>Decision for row {row.index}</label>
                      <select
                        id={`${leaveId}-${row.index}`}
                        value={choice}
                        disabled={own || sending}
                        onChange={(event) => choose(lesson.lessonId, event.target.value as DigestChoice)}
                        className="block w-44 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900"
                      >
                        <option value="approve">Approve</option>
                        <option value="leave">Leave in queue</option>
                        {REVIEW_REASONS.map((reason) => (
                          <option key={reason.code} value={`reject:${reason.code}`}>
                            Reject: {reason.code}
                          </option>
                        ))}
                      </select>
                      {own ? <div className="mt-1 text-xs text-slate-600">Your own lesson</div> : null}
                      <button
                        type="button"
                        onClick={() => toggle(lesson.lessonId)}
                        aria-expanded={expanded}
                        className="mt-1 text-xs font-semibold underline underline-offset-2 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900"
                      >
                        {expanded ? "Hide details" : "Show details"}
                      </button>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr>
                      <td colSpan={9} className="bg-slate-50 px-3 py-4">
                        <DeltaCard
                          heading={lesson.violationRule}
                          headingLevel={3}
                          meta={<code className="font-mono">{lesson.tool}</code>}
                          steeringDirective={lesson.steeringDirective}
                          statutoryAnchor={lesson.statutoryAnchor}
                          left={lesson.trapArguments}
                          right={lesson.fixArguments}
                          changedPaths={lesson.changedPaths}
                          leftLabel="The trap"
                          rightLabel="The fix"
                        >
                          <p className="text-sm text-slate-800 break-words">{lesson.taskDescription}</p>
                        </DeltaCard>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={leaveId} className="block text-sm font-semibold text-slate-900">
            Leave out rows
          </label>
          <input
            id={leaveId}
            type="text"
            inputMode="numeric"
            value={leaveText}
            onChange={(event) => setLeaveText(event.target.value)}
            placeholder="for example 3, 8"
            autoComplete="off"
            className="mt-1 w-48 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900"
          />
        </div>
        <button type="button" onClick={leaveRows} disabled={sending || parseRowNumbers(leaveText, rows.length).length === 0} className={`${BUTTON} border border-slate-400 bg-white text-slate-900 hover:bg-slate-100`}>
          Leave them out
        </button>
        {hasMore ? (
          <button type="button" onClick={onLoadMore} disabled={loading || sending} className={`${BUTTON} border border-slate-400 bg-white text-slate-900 hover:bg-slate-100`}>
            {loading ? "Loading…" : "Load more lessons"}
          </button>
        ) : null}
      </div>

      <div className="sticky bottom-0 space-y-2 border-t border-slate-200 bg-white/95 py-3">
        <p aria-live="polite" className="text-sm text-slate-900">
          Ready to send: <strong>{approves}</strong> to approve, <strong>{rejects}</strong> to reject, {rows.length - inputs.length} left in the queue.
        </p>
        {confirming ? (
          <div className="space-y-2 rounded-md border-l-4 border-blocked bg-blocked/5 px-3 py-2">
            <p className="text-sm text-slate-900">
              Approving makes {approves} {approves === 1 ? "lesson" : "lessons"} public to every agent.
              {flaggedApproves > 0 ? ` ${flaggedApproves} of them carry a flag: check those rows again.` : ""} Send this batch?
            </p>
            <div className="flex gap-3">
              <button type="button" onClick={() => void send()} disabled={sending} aria-busy={sending} className={`${BUTTON} bg-slate-900 text-white hover:bg-slate-700`}>
                {sending ? "Sending…" : "Confirm and send"}
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={sending} className={`${BUTTON} text-slate-900 underline`}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} disabled={inputs.length === 0 || sending} className={`${BUTTON} bg-slate-900 text-white hover:bg-slate-700`}>
            Review and send {inputs.length} {inputs.length === 1 ? "decision" : "decisions"}
          </button>
        )}
      </div>
    </div>
  );
}
