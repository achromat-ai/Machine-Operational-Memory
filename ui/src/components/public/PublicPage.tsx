import { useEffect, useId, useState } from "react";
import FeedList from "./FeedList";
import Hero from "./Hero";
import LinkedLesson from "./LinkedLesson";
import ResultList from "./ResultList";
import SearchInput from "./SearchInput";
import SimpleSearch from "./SimpleSearch";
import { useFeed } from "./useFeed";
import { useLinkedLesson } from "./useLinkedLesson";
import { useRecall } from "./useRecall";
import { useSearch } from "./useSearch";

const TOGGLE =
  "inline-flex min-h-10 items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900";

/**
 * The landing page: the hero, a plain-language search, the lesson a #lesson-<id> link names (fetched by id, so any approved lesson can be linked), then the directory of approved lessons. None of these needs an
 * identity. The structured, signed lookup by tool name and arguments sits in a collapsed "Advanced Agent Simulator"
 * panel. The panel is always mounted and only hidden, so what was typed survives a collapse, and it opens by itself
 * when an advanced search runs.
 */
export default function PublicPage() {
  const feed = useFeed();
  const linked = useLinkedLesson();
  const linkedId = linked.phase === "none" ? null : linked.id;
  const inFeed = linkedId !== null && feed.state.lessons.some((lesson) => lesson.lessonId === linkedId);
  const { state: simple, search: runSimple } = useSearch();
  const { state: recall, search: runRecall } = useRecall();
  const [simulatorOpen, setSimulatorOpen] = useState(false);
  const panelId = useId();

  const simulating = recall.phase === "loading" || recall.phase === "error" || recall.entries.length > 0;
  useEffect(() => {
    if (simulating) setSimulatorOpen(true);
  }, [simulating]);

  return (
    <>
      <Hero />
      <div className="mx-auto max-w-6xl space-y-8 px-6 py-12">
        <section aria-labelledby="search-heading" className="space-y-4">
          <h2 id="search-heading" className="text-xl font-semibold tracking-tight text-slate-900">
            Search lessons
          </h2>
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <SimpleSearch onSearch={runSimple} state={simple} />
          </div>
        </section>

        <section aria-labelledby="advanced-heading" className="space-y-4">
          <h2 id="advanced-heading" className="sr-only">
            Advanced Agent Simulator
          </h2>
          <button type="button" onClick={() => setSimulatorOpen((open) => !open)} aria-expanded={simulatorOpen} aria-controls={panelId} className={TOGGLE}>
            <span aria-hidden="true">{simulatorOpen ? "−" : "+"}</span>
            Advanced Agent Simulator
          </button>
          <div id={panelId} hidden={!simulatorOpen} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="mb-5 max-w-2xl text-sm text-slate-700">
              Look up a call you are about to make: name the tool, paste its arguments and see how they differ from the compliant version. The first search sets up a secure session on this device.
            </p>
            <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
              <SearchInput onSearch={runRecall} busy={recall.phase === "loading"} {...(recall.error?.fieldErrors ? { serverErrors: recall.error.fieldErrors } : {})} />
              <ResultList state={recall} />
            </div>
          </div>
        </section>

        <LinkedLesson state={linked} inFeed={inFeed} />

        <FeedList state={feed.state} onRefresh={feed.refresh} />

        <p className="max-w-3xl text-sm text-slate-600">
          Everything is kept honest by a record that is only ever added to: a lesson exists only when a verified block and a later verified allow for the same task are bound together.
        </p>
      </div>
    </>
  );
}
