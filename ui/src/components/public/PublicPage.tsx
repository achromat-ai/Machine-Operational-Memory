import { useEffect, useId, useState } from "react";
import FeedList from "./FeedList";
import Hero from "./Hero";
import ResultList from "./ResultList";
import SearchInput from "./SearchInput";
import { useFeed } from "./useFeed";
import { useRecall } from "./useRecall";

const TOGGLE =
  "inline-flex min-h-10 items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900";

/**
 * The landing page: the hero, then the live feed of approved lessons, which needs no form and no identity.
 * The structured search ("Advanced Agent Search") sits in a collapsed panel above the feed. The panel is
 * always mounted and only hidden, so what was typed survives a collapse, and it opens by itself when a
 * search runs.
 */
export default function PublicPage() {
  const feed = useFeed();
  const { state: search, search: runSearch } = useRecall();
  const [searchOpen, setSearchOpen] = useState(false);
  const panelId = useId();

  const searching = search.phase === "loading" || search.phase === "error" || search.entries.length > 0;
  useEffect(() => {
    if (searching) setSearchOpen(true);
  }, [searching]);

  return (
    <>
      <Hero />
      <div className="mx-auto max-w-6xl space-y-8 px-6 py-12">
        <section aria-labelledby="advanced-heading" className="space-y-4">
          <h2 id="advanced-heading" className="sr-only">
            Advanced Agent Search
          </h2>
          <button type="button" onClick={() => setSearchOpen((open) => !open)} aria-expanded={searchOpen} aria-controls={panelId} className={TOGGLE}>
            <span aria-hidden="true">{searchOpen ? "−" : "+"}</span>
            Advanced Agent Search
          </button>
          <div id={panelId} hidden={!searchOpen} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="mb-5 max-w-2xl text-sm text-slate-700">
              Look up a call you are about to make: describe it and see how it differs from the compliant version. The first search sets up a secure session on this device.
            </p>
            <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
              <SearchInput onSearch={runSearch} busy={search.phase === "loading"} {...(search.error?.fieldErrors ? { serverErrors: search.error.fieldErrors } : {})} />
              <ResultList state={search} />
            </div>
          </div>
        </section>

        <FeedList state={feed.state} onRefresh={feed.refresh} />

        <p className="max-w-3xl text-sm text-slate-600">
          Everything is kept honest by a record that is only ever added to: a lesson exists only when a verified block and a later verified allow for the same task are bound together.
        </p>
      </div>
    </>
  );
}
