import { useId, useState } from "react";
import {
  REASONING_MAX_CHARACTERS,
  REVIEW_REASONS,
  type ReviewFailureView,
  type ReviewInput,
  type ReviewReasonCode,
} from "../../lib/adminApi";

export interface ReviewActionsProps {
  lessonId: string;
  /** The lesson failed automated checks. Approving it needs an extra confirmation. */
  quarantined: boolean;
  /** This key submitted or fixed the lesson; the service would refuse it. */
  ownLesson: boolean;
  /** Sends the decision. Resolves null on success, or the reason it failed. */
  onDecide: (input: ReviewInput) => Promise<ReviewFailureView | null>;
}

type Mode = "idle" | "reject" | "confirm-approve";

const BUTTON = "rounded-md px-4 py-2 text-sm font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Approve and Reject for one queue item. Reject asks for a reason code and an optional note first.
 * A refusal from the service (including SELF_REVIEW_FORBIDDEN) is shown here in plain words and the
 * buttons come back, so nothing is lost.
 */
export default function ReviewActions({ lessonId, quarantined, ownLesson, onDecide }: ReviewActionsProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [reason, setReason] = useState<ReviewReasonCode | "">("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const reasonId = useId();
  const noteId = useId();
  const errorId = useId();

  async function send(input: ReviewInput) {
    setPending(true);
    setFailure(null);
    const result = await onDecide(input);
    // On success the parent removes this card; on failure the controls come back with the reason.
    if (result !== null) {
      setFailure(result.message);
      setPending(false);
      if (result.code === "SELF_REVIEW_FORBIDDEN") setMode("idle");
    }
  }

  function approve() {
    if (quarantined && mode !== "confirm-approve") {
      setMode("confirm-approve");
      return;
    }
    void send({ lessonId, decision: "approve", ...(note.trim() ? { reasoning: note } : {}) });
  }

  function reject() {
    if (mode !== "reject") {
      setMode("reject");
      return;
    }
    if (reason === "") {
      setFailure("Choose a reason for rejecting.");
      return;
    }
    void send({ lessonId, decision: "reject", reasonCode: reason, ...(note.trim() ? { reasoning: note } : {}) });
  }

  if (ownLesson) {
    return (
      <div>
        <p className="text-sm text-slate-700">You submitted or fixed this lesson, so a different reviewer has to decide it.</p>
        <div className="mt-3 flex gap-3">
          <button type="button" disabled className={`${BUTTON} bg-slate-900 text-white`}>
            Approve
          </button>
          <button type="button" disabled className={`${BUTTON} border border-slate-400 bg-white text-slate-900`}>
            Reject
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {mode === "confirm-approve" ? (
        <p className="rounded-md border-l-4 border-blocked bg-blocked/5 px-3 py-2 text-sm text-slate-900">
          This lesson failed an automated check and was held back. Approving it makes it public. Check the triage results above, then confirm.
        </p>
      ) : null}

      {mode === "reject" ? (
        <div className="space-y-3">
          <div>
            <label htmlFor={reasonId} className="block text-sm font-semibold text-slate-900">
              Reason
            </label>
            <select
              id={reasonId}
              value={reason}
              onChange={(event) => setReason(event.target.value as ReviewReasonCode | "")}
              className="mt-1 block w-full max-w-sm rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900"
            >
              <option value="">Choose a reason</option>
              {REVIEW_REASONS.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={noteId} className="block text-sm font-semibold text-slate-900">
              Note (optional)
            </label>
            <textarea
              id={noteId}
              rows={2}
              maxLength={REASONING_MAX_CHARACTERS}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="mt-1 block w-full max-w-lg rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900"
            />
            <p className="mt-1 text-xs text-slate-600">Kept permanently with the decision. Do not include secrets.</p>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {mode !== "reject" ? (
          <button type="button" onClick={approve} disabled={pending} aria-busy={pending} className={`${BUTTON} bg-slate-900 text-white hover:bg-slate-700`}>
            {mode === "confirm-approve" ? "Confirm approval" : "Approve"}
          </button>
        ) : null}
        {mode !== "confirm-approve" ? (
          <button
            type="button"
            onClick={reject}
            disabled={pending}
            aria-busy={pending}
            className={`${BUTTON} ${mode === "reject" ? "bg-blocked text-white hover:opacity-90" : "border border-slate-400 bg-white text-slate-900 hover:bg-slate-100"}`}
          >
            {mode === "reject" ? "Confirm rejection" : "Reject"}
          </button>
        ) : null}
        {mode !== "idle" ? (
          <button
            type="button"
            onClick={() => {
              setMode("idle");
              setFailure(null);
            }}
            disabled={pending}
            className={`${BUTTON} text-slate-900 underline`}
          >
            Cancel
          </button>
        ) : null}
      </div>

      {failure ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-blocked">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
