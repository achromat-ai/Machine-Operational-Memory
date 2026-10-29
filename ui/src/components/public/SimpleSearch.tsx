import { useId, useRef, useState, type FormEvent } from "react";
import { DOMAIN_ORDER, domainLabel } from "../../lib/domains";
import { lessonHeading } from "../../lib/lessonText";
import { validateSimpleSearch, type SearchQuery, type SearchState, type SimpleFieldErrors } from "../../lib/search";
import DeltaCard from "./DeltaCard";

export interface SimpleSearchProps {
  /** Receives a validated question. The page sends it with a plain GET (see useSearch). */
  onSearch: (query: SearchQuery) => void | Promise<void>;
  state: SearchState;
}

const FIELD =
  "mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 placeholder:text-slate-500 focus:border-slate-900 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 aria-[invalid=true]:border-blocked";

function Results({ state }: { state: SearchState }) {
  const loading = state.phase === "loading";
  return (
    <section aria-label="Search results" aria-live="polite" aria-busy={loading} className="mt-6 space-y-4">
      {loading ? (
        <p role="status" className="text-sm text-slate-700">
          Searching…
        </p>
      ) : null}

      {state.phase === "error" && state.error ? (
        <div role="alert" className="rounded-lg border-l-4 border-blocked bg-blocked/5 px-5 py-4">
          <p className="text-base font-semibold text-slate-900">The search did not complete</p>
          <p className="mt-1 text-sm text-slate-800">{state.error.message}</p>
        </div>
      ) : null}

      {state.results !== null && state.query !== null && !loading ? (
        state.results.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white px-5 py-4">
            <h3 className="text-base font-semibold text-slate-900">No lesson found</h3>
            <p className="mt-1 text-sm text-slate-700">
              Nothing published in {domainLabel(state.query.domain)} matches this yet. Try different words, or describe the action rather than the tool.
            </p>
          </div>
        ) : (
          state.results.map(({ score, lesson }) => (
            <DeltaCard
              key={lesson.lessonId}
              heading={lessonHeading(lesson)}
              headingLevel={3}
              meta={
                <>
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{`Similarity ${score.toFixed(2)}`}</span>
                  <span className="text-slate-600">{domainLabel(lesson.domain)}</span>
                  <code className="font-mono text-slate-700">{lesson.tool}</code>
                </>
              }
              steeringDirective={lesson.steeringDirective}
              statutoryAnchor={lesson.statutoryAnchor}
              left={null}
              right={lesson.compliantArguments}
              changedPaths={lesson.changedPaths}
              note="This is the compliant call published for the lesson. The values of the call that was originally blocked are never shown."
            />
          ))
        )
      ) : null}
    </section>
  );
}

/**
 * The default search: pick a domain, describe in plain words what your agent is about to do, and read the lessons
 * that match. It calls the public search endpoint, so it needs no session and does no proof of work. The structured
 * lookup by tool name and arguments is the "Advanced Agent Simulator" below it.
 */
export default function SimpleSearch({ onSearch, state }: SimpleSearchProps) {
  const [domain, setDomain] = useState<string>(DOMAIN_ORDER[0]);
  const [query, setQuery] = useState("");
  const [localErrors, setLocalErrors] = useState<SimpleFieldErrors>({});
  const ids = { domain: useId(), query: useId() };
  const domainRef = useRef<HTMLSelectElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const errors: SimpleFieldErrors = { ...state.error?.fieldErrors, ...localErrors };
  const busy = state.phase === "loading";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const result = validateSimpleSearch({ domain, query });
    if (!result.ok) {
      setLocalErrors(result.errors);
      (result.errors.domain ? domainRef : queryRef).current?.focus();
      return;
    }
    setLocalErrors({});
    void onSearch(result.query);
  }

  return (
    <div>
      <form onSubmit={submit} noValidate aria-label="Search lessons" className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-start">
        <div>
          <label htmlFor={ids.domain} className="block text-sm font-semibold text-slate-900">
            Domain
          </label>
          <select
            id={ids.domain}
            ref={domainRef}
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            aria-invalid={errors.domain ? true : undefined}
            aria-describedby={errors.domain ? `${ids.domain}-error` : undefined}
            className={FIELD}
          >
            {DOMAIN_ORDER.map((slug) => (
              <option key={slug} value={slug}>
                {domainLabel(slug)}
              </option>
            ))}
          </select>
          {errors.domain ? (
            <p id={`${ids.domain}-error`} className="mt-1 text-sm font-medium text-blocked">
              {errors.domain}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor={ids.query} className="block text-sm font-semibold text-slate-900">
            What is your agent about to do?
          </label>
          <input
            id={ids.query}
            ref={queryRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            placeholder="Send a large wire transfer to a new beneficiary"
            aria-invalid={errors.query ? true : undefined}
            aria-describedby={`${ids.query}-hint${errors.query ? ` ${ids.query}-error` : ""}`}
            className={FIELD}
          />
          <p id={`${ids.query}-hint`} className="mt-1 text-sm text-slate-600">
            Plain words are enough. Leave out amounts, names and secrets.
          </p>
          {errors.query ? (
            <p id={`${ids.query}-error`} className="mt-1 text-sm font-medium text-blocked">
              {errors.query}
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-slate-900 px-5 py-2.5 text-base font-semibold text-white hover:bg-slate-700 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 disabled:cursor-not-allowed disabled:bg-slate-500 sm:mt-6"
        >
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      <Results state={state} />
    </div>
  );
}
