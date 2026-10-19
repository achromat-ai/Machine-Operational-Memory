import { useId, useState } from "react";
import { domainLabel } from "../../lib/domains";
import type { FeedState } from "../../lib/feed";
import { NO_FILTER, domainCounts, filterLessons, type FeedFilter } from "../../lib/feedFilter";
import FeedTable from "./FeedTable";

const BUTTON =
  "inline-flex min-h-10 items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-900 hover:bg-slate-50 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 disabled:cursor-not-allowed disabled:text-slate-500";

function Skeleton() {
  return (
    <div role="status" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="space-y-0 divide-y divide-slate-100" aria-hidden="true">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="grid grid-cols-[8rem_9rem_1fr] gap-4 px-4 py-4 md:grid-cols-[11rem_12rem_1fr_1.4fr]">
            <div className="h-4 w-24 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
            <div className="h-4 w-28 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
            <div className="h-4 w-full animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
            <div className="hidden h-4 w-3/4 animate-pulse rounded bg-slate-200 motion-reduce:animate-none md:block" />
          </div>
        ))}
      </div>
      <p className="border-t border-slate-200 px-4 py-3 text-sm text-slate-700">Loading the latest lessons…</p>
    </div>
  );
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex min-h-9 items-center rounded-full border px-3 text-sm font-medium focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 ${
        pressed ? "border-ink bg-ink text-white" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

export interface FeedListProps {
  state: FeedState;
  onRefresh: () => void;
}

/**
 * The live feed of approved lessons: loading, error, empty and populated states. The newest lessons are
 * filtered in the browser by domain and by a text box; only a short count line is announced, so typing in the
 * box does not read the whole list out again.
 */
export default function FeedList({ state, onRefresh }: FeedListProps) {
  const busy = state.phase === "loading" || state.refreshing;
  const [filter, setFilter] = useState<FeedFilter>(NO_FILTER);
  const filterId = useId();
  const filtering = filter.domain !== null || filter.text.trim() !== "";
  const shown = filterLessons(state.lessons, filter);
  const domains = domainCounts(state.lessons);

  return (
    <section aria-labelledby="feed-heading" aria-busy={busy} className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Live feed</p>
          <h2 id="feed-heading" className="mt-1 text-2xl font-semibold tracking-tight text-ink">
            Latest approved lessons
          </h2>
        </div>
        <button type="button" onClick={onRefresh} disabled={busy} className={BUTTON}>
          {state.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {state.phase === "ready" && state.lessons.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="Filter by domain" className="flex flex-wrap gap-2">
            <Chip pressed={filter.domain === null} onClick={() => setFilter({ ...filter, domain: null })}>
              {`All (${state.lessons.length})`}
            </Chip>
            {domains.map(({ domain, count }) => (
              <Chip key={domain} pressed={filter.domain === domain} onClick={() => setFilter({ ...filter, domain })}>
                {`${domainLabel(domain)} (${count})`}
              </Chip>
            ))}
          </div>
          <div className="w-full sm:w-auto">
            <label htmlFor={filterId} className="sr-only">
              Filter these lessons
            </label>
            <input
              id={filterId}
              type="search"
              value={filter.text}
              onChange={(event) => setFilter({ ...filter, text: event.target.value })}
              placeholder="Filter by tool, rule or field"
              autoComplete="off"
              className="min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-500 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 sm:w-72"
            />
          </div>
        </div>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {state.phase === "ready" && state.lessons.length > 0 ? `Showing ${shown.length} of ${state.lessons.length} lessons.` : ""}
      </p>

      {state.phase === "loading" ? <Skeleton /> : null}

      {state.phase === "error" && state.error ? (
        <div role="alert" className="rounded-lg border-l-4 border-blocked bg-blocked/5 px-5 py-4">
          <p className="text-base font-semibold text-slate-900">The feed did not load</p>
          <p className="mt-1 text-sm text-slate-800">{state.error}</p>
          <button type="button" onClick={onRefresh} className={`${BUTTON} mt-3`}>
            Try again
          </button>
        </div>
      ) : null}

      {state.stale && state.error ? (
        <p role="status" className="rounded-md border-l-4 border-blocked bg-blocked/5 px-4 py-2 text-sm text-slate-800">
          {state.error} The lessons below may be out of date.
        </p>
      ) : null}

      {state.phase === "ready" && state.lessons.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white px-5 py-6">
          <p className="text-base font-semibold text-slate-900">No approved lessons yet</p>
          <p className="mt-1 text-sm text-slate-700">New lessons appear here as soon as they are approved.</p>
        </div>
      ) : null}

      {state.lessons.length > 0 && shown.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white px-5 py-6">
          <p className="text-base font-semibold text-slate-900">No lessons match this filter</p>
          <button type="button" onClick={() => setFilter(NO_FILTER)} className={`${BUTTON} mt-3`}>
            Clear the filter
          </button>
        </div>
      ) : null}

      {shown.length > 0 ? <FeedTable lessons={shown} labelledBy="feed-heading" /> : null}

      {filtering && shown.length > 0 ? (
        <p className="text-sm text-slate-600">
          Showing {shown.length} of {state.lessons.length} lessons.{" "}
          <button type="button" onClick={() => setFilter(NO_FILTER)} className="font-medium underline underline-offset-4 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900">
            Clear the filter
          </button>
        </p>
      ) : null}
    </section>
  );
}
