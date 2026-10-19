import type { RecallEntry, RecallState } from "../../lib/recall";
import DeltaCard from "./DeltaCard";

function Badge({ children, tone }: { children: string; tone: "good" | "neutral" }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${tone === "good" ? "bg-compliant/15 text-compliant" : "bg-slate-100 text-slate-700"}`}>{children}</span>
  );
}

function Entry({ entry }: { entry: RecallEntry }) {
  const { query, outcome } = entry;
  const asked = (
    <>
      <code className="font-mono">{query.tool}</code> in {query.domain}
    </>
  );

  if (outcome.kind === "miss") {
    return (
      <article className="rounded-lg border border-slate-200 bg-white px-5 py-4">
        <h3 className="text-base font-semibold text-slate-900">No lesson found</h3>
        <p className="mt-1 text-sm text-slate-700">
          {outcome.budgetExhausted
            ? "You have reached today's allowance of lessons. Try again tomorrow."
            : "Nothing matches this call yet, so it has not been blocked and fixed before."}
        </p>
        <p className="mt-2 text-sm text-slate-600">Searched for {asked}.</p>
      </article>
    );
  }

  const { lesson } = outcome;
  return (
    <DeltaCard
      heading={lesson.violationRule}
      headingLevel={3}
      meta={
        <>
          <Badge tone="neutral">{outcome.tier === "exact" ? "Exact match" : `Similar task (score ${outcome.score.toFixed(2)})`}</Badge>
          <Badge tone={lesson.reviewStatus === "approved" ? "good" : "neutral"}>
            {lesson.reviewStatus === "approved" ? "Reviewed" : "Your own lesson, awaiting review"}
          </Badge>
          <span className="text-slate-600">Searched for {asked}</span>
        </>
      }
      steeringDirective={lesson.steeringDirective}
      statutoryAnchor={lesson.statutoryAnchor}
      left={query.arguments}
      right={lesson.compliantArguments}
      changedPaths={lesson.changedPaths}
      leftLabel="Your call"
      rightLabel="The fix"
      note="“Your call” is what you typed. The values of the call that was originally blocked are never shown."
    />
  );
}

/** Loading, error and result states for the search. Announced politely to screen readers. */
export default function ResultList({ state }: { state: RecallState }) {
  const loading = state.phase === "loading";
  return (
    <section aria-label="Results" aria-live="polite" aria-busy={loading} className="space-y-4">
      {loading ? (
        <div role="status" className="rounded-lg border border-slate-200 bg-white px-5 py-6">
          <div className="h-3 w-1/3 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" aria-hidden="true" />
          <div className="mt-3 h-3 w-2/3 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" aria-hidden="true" />
          <p className="mt-4 text-sm text-slate-700">Searching. Your first search sets up a secure session and can take a few seconds.</p>
        </div>
      ) : null}

      {state.phase === "error" && state.error ? (
        <div role="alert" className="rounded-lg border-l-4 border-blocked bg-blocked/5 px-5 py-4">
          <p className="text-base font-semibold text-slate-900">The search did not complete</p>
          <p className="mt-1 text-sm text-slate-800">{state.error.message}</p>
        </div>
      ) : null}

      {state.entries.length === 0 && state.phase === "idle" ? (
        <p className="text-sm text-slate-600">Results appear here. Fill in the form and search.</p>
      ) : null}

      {state.entries.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </section>
  );
}
