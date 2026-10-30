import { useEffect, useRef } from "react";
import type { FeedLessonView, LinkedLessonState } from "../../lib/feed";
import { lessonHeading, rowAnchor } from "../../lib/lessonText";
import { DomainPill, LessonDetail, ToolChip } from "./FeedTable";

export interface LinkedLessonProps {
  state: LinkedLessonState;
  /**
   * True when the directory below already lists this lesson. The directory then opens and scrolls to it itself, so
   * showing it twice would only repeat it.
   */
  inFeed: boolean;
}

const BOX = "rounded-xl border border-slate-200 bg-white p-5 shadow-sm";

function Ready({ lesson }: { lesson: FeedLessonView }) {
  const box = useRef<HTMLElement>(null);
  // Arriving by a link: move focus to the lesson (so a screen reader starts there) and bring it into view once.
  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "start" });
  }, [lesson.lessonId]);
  return (
    <section ref={box} id={rowAnchor(lesson.lessonId)} tabIndex={-1} aria-labelledby="linked-lesson-heading" className={`${BOX} focus:outline-2 focus:outline-offset-2 focus:outline-slate-900`}>
      <p className="eyebrow">Linked lesson</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <DomainPill domain={lesson.domain} />
        <ToolChip tool={lesson.tool} />
      </div>
      <h2 id="linked-lesson-heading" className="mt-3 text-xl font-semibold tracking-tight text-ink">
        {lessonHeading(lesson)}
      </h2>
      <div className="mt-4">
        <LessonDetail lesson={lesson} />
      </div>
    </section>
  );
}

/**
 * The lesson a `#lesson-<id>` link names, fetched by id so that it opens even when it is not among the newest
 * lessons the directory lists. A lesson the service will not show (unknown, withdrawn, not yet approved) gets one
 * neutral line that does not say which.
 */
export default function LinkedLesson({ state, inFeed }: LinkedLessonProps) {
  if (state.phase === "none" || (state.phase === "ready" && inFeed)) return null;
  if (state.phase === "loading") {
    return (
      <p role="status" className={`${BOX} text-sm text-slate-700`}>
        Loading the linked lesson…
      </p>
    );
  }
  if (state.phase === "missing") {
    return (
      <div role="status" className="rounded-lg border-l-4 border-slate-400 bg-slate-50 px-5 py-4">
        <p className="text-base font-semibold text-slate-900">This lesson is not public</p>
        <p className="mt-1 text-sm text-slate-800">It may have been withdrawn, or the link may be wrong. The approved lessons are listed below.</p>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div role="alert" className="rounded-lg border-l-4 border-blocked bg-blocked/5 px-5 py-4">
        <p className="text-base font-semibold text-slate-900">The linked lesson did not load</p>
        <p className="mt-1 text-sm text-slate-800">Reload the page to try again.</p>
      </div>
    );
  }
  return <Ready lesson={state.lesson} />;
}
