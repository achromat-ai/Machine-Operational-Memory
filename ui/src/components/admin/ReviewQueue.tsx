import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  BATCH_MAX,
  describeBatch,
  describeReviewFailure,
  fetchPending,
  isOwnLesson,
  submitBatch,
  submitReview,
  type PendingLesson,
  type QueueStatus,
  type ReviewFailureView,
  type ReviewInput,
} from "../../lib/adminApi";
import type { AdminSession } from "../../lib/adminSession";
import { initialQueueState, queueReducer } from "../../lib/queue";
import DeltaCard from "../public/DeltaCard";
import ReviewActions from "./ReviewActions";
import ReviewDigest from "./ReviewDigest";

const TABS: ReadonlyArray<{ status: QueueStatus; label: string }> = [
  { status: "pending_review", label: "Awaiting review" },
  { status: "quarantined", label: "Held back by checks" },
];

function TriageList({ lesson }: { lesson: PendingLesson }) {
  if (lesson.triage.length === 0) return null;
  return (
    <div>
      <h4 className="text-sm font-semibold text-slate-900">Automated checks</h4>
      <ul className="mt-1 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {lesson.triage.map((check) => (
          <li key={check.check} className="flex items-baseline gap-2">
            <span className={check.passed ? "font-semibold text-compliant" : "font-semibold text-blocked"}>{check.passed ? "✓ passed" : "✕ failed"}</span>
            <span className="font-mono text-xs text-slate-800">{check.check}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Facts({ lesson }: { lesson: PendingLesson }) {
  return (
    <div className="space-y-3 text-sm text-slate-800">
      <div>
        <h4 className="text-sm font-semibold text-slate-900">Task</h4>
        <p className="mt-0.5 break-words">{lesson.taskDescription}</p>
      </div>
      <p>
        <span className="font-semibold text-slate-900">Submitted by </span>
        <code className="font-mono text-xs break-all">{lesson.submitterKey.slice(0, 8)}…{lesson.submitterKey.slice(-6)}</code>
        {` (${lesson.submitterApproved} approved, ${lesson.submitterRejected} rejected)`}
        {lesson.corroborations > 0 ? `, corroborated ${lesson.corroborations} ${lesson.corroborations === 1 ? "time" : "times"}` : ""}
      </p>
      <TriageList lesson={lesson} />
    </div>
  );
}

/**
 * The pending queue. Each item shows the original trap beside the fix, with the fields the lesson changed
 * highlighted. Everything in an item is untrusted text from the community and is rendered as plain text.
 */
export default function ReviewQueue({ session, agentKeyHex, initialView = "cards" }: { session: AdminSession; agentKeyHex: string; initialView?: "cards" | "digest" }) {
  const [state, dispatch] = useReducer(queueReducer, initialQueueState);
  const [view, setView] = useState<"cards" | "digest">(initialView);
  const ticket = useRef(0);

  const failWith = useCallback(
    (failure: ReviewFailureView) => {
      if (failure.locked) session.lock();
    },
    [session],
  );

  const load = useCallback(
    async (status: QueueStatus, cursor: string | null) => {
      const mine = ++ticket.current;
      dispatch({ type: "load-start" });
      try {
        const page = await fetchPending((path, options) => session.signedFetch(path, options), { status, limit: 20, cursor });
        if (mine === ticket.current) dispatch({ type: "load-success", lessons: page.lessons, nextCursor: page.nextCursor, append: cursor !== null });
      } catch (error) {
        const failure = describeReviewFailure(error);
        failWith(failure);
        if (mine === ticket.current) dispatch({ type: "load-failure", message: failure.message });
      }
    },
    [session, failWith],
  );

  useEffect(() => {
    void load(state.status, null);
  }, [load, state.status]);

  async function decide(lesson: PendingLesson, input: ReviewInput): Promise<ReviewFailureView | null> {
    try {
      await submitReview((path, options) => session.signedFetch(path, options), input);
      dispatch({ type: "removed", lessonId: lesson.lessonId, notice: input.decision === "approve" ? "Approved. The lesson is now public." : "Rejected. The lesson will not be shown." });
      return null;
    } catch (error) {
      const failure = describeReviewFailure(error);
      failWith(failure);
      if (failure.stale) {
        dispatch({ type: "removed", lessonId: lesson.lessonId, notice: failure.message });
        return null;
      }
      return failure;
    }
  }

  /** Sends the digest's decisions as batches of at most BATCH_MAX, then drops every lesson that is no longer waiting. */
  async function decideBatch(inputs: ReviewInput[]): Promise<void> {
    const batchId = `digest-${new Date().toISOString().slice(0, 16).replace(/\D/g, "")}`;
    const gone: string[] = [];
    const notices: string[] = [];
    for (let start = 0; start < inputs.length; start += BATCH_MAX) {
      try {
        const result = await submitBatch((path, options) => session.signedFetch(path, options), inputs.slice(start, start + BATCH_MAX), batchId);
        for (const item of result.results) if (item.ok || item.status === 404 || item.status === 409) gone.push(item.lessonId);
        notices.push(describeBatch(result));
      } catch (error) {
        const failure = describeReviewFailure(error);
        failWith(failure);
        notices.push(`${failure.message} The rest of the batch was not sent.`);
        break;
      }
    }
    dispatch({ type: "removed-many", lessonIds: gone, notice: notices.join(" ") });
  }

  return (
    <div className="space-y-6">
      <div role="group" aria-label="View" className="flex flex-wrap gap-2">
        {(["cards", "digest"] as const).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={view === name}
            onClick={() => setView(name)}
            className={`rounded-md border px-4 py-2 text-sm font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 ${
              view === name ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-900 hover:bg-slate-100"
            }`}
          >
            {name === "cards" ? "Cards" : "Digest"}
          </button>
        ))}
      </div>
      <div role="tablist" aria-label="Queue" className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            role="tab"
            aria-selected={state.status === tab.status}
            onClick={() => dispatch({ type: "select-status", status: tab.status })}
            className={`rounded-md border px-4 py-2 text-sm font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 ${
              state.status === tab.status ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-900 hover:bg-slate-100"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div aria-live="polite" className="min-h-6 text-sm text-slate-800">
        {state.notice ? (
          <p>
            {state.notice}{" "}
            <button type="button" onClick={() => dispatch({ type: "dismiss-notice" })} className="underline">
              Dismiss
            </button>
          </p>
        ) : null}
      </div>

      {state.error ? (
        <div role="alert" className="rounded-lg border-l-4 border-blocked bg-blocked/5 px-5 py-4">
          <p className="text-sm font-medium text-slate-900">{state.error}</p>
          <button type="button" onClick={() => void load(state.status, null)} className="mt-2 text-sm font-semibold underline">
            Try again
          </button>
        </div>
      ) : null}

      {state.loading && state.lessons.length === 0 ? (
        <p role="status" className="text-sm text-slate-700">
          Loading the queue…
        </p>
      ) : null}

      {state.loaded && !state.loading && state.lessons.length === 0 && !state.error ? (
        <p className="rounded-lg border border-slate-200 bg-white px-5 py-6 text-sm text-slate-700">Nothing is waiting here.</p>
      ) : null}

      {view === "digest" ? (
        <ReviewDigest
          lessons={state.lessons}
          agentKeyHex={agentKeyHex}
          onSubmit={decideBatch}
          hasMore={state.nextCursor !== null}
          loading={state.loading}
          onLoadMore={() => void load(state.status, state.nextCursor)}
        />
      ) : null}
      <div className="space-y-6">
        {(view === "cards" ? state.lessons : []).map((lesson) => (
          <DeltaCard
            key={lesson.lessonId}
            heading={lesson.violationRule}
            headingLevel={3}
            meta={
              <>
                <code className="font-mono">{lesson.tool}</code>
                <span>in {lesson.domain}</span>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{lesson.provenance}</span>
                <span className="text-slate-600">created {lesson.createdAt.slice(0, 16).replace("T", " ")} UTC</span>
              </>
            }
            steeringDirective={lesson.steeringDirective}
            statutoryAnchor={lesson.statutoryAnchor}
            left={lesson.trapArguments}
            right={lesson.fixArguments}
            changedPaths={lesson.changedPaths}
            leftLabel="The trap"
            rightLabel="The fix"
            footer={
              <ReviewActions
                lessonId={lesson.lessonId}
                quarantined={lesson.reviewStatus === "quarantined"}
                ownLesson={isOwnLesson(lesson, agentKeyHex)}
                onDecide={(input) => decide(lesson, input)}
              />
            }
          >
            <Facts lesson={lesson} />
          </DeltaCard>
        ))}
      </div>

      {state.nextCursor && view === "cards" ? (
        <button
          type="button"
          disabled={state.loading}
          onClick={() => void load(state.status, state.nextCursor)}
          className="rounded-md border border-slate-400 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-100 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 disabled:opacity-50"
        >
          {state.loading ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
