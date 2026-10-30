import { useEffect, useState } from "react";
import { loadLesson, type LinkedLessonState } from "../../lib/feed";
import { lessonIdFromHash } from "../../lib/lessonText";
import { pageRef } from "../../lib/ref";

const currentId = () => (typeof window === "undefined" ? null : lessonIdFromHash(window.location.hash));

/**
 * Follows the `#lesson-<id>` fragment of the address bar. When it names a lesson, fetches it by id
 * (GET /api/v1/feed/<id>, forwarding the page's ref so an opened citation link can be attributed) and reports where
 * the load stands. Follows the fragment when it changes, and abandons a load the visitor has moved on from.
 * Uses a plain fetch, so no identity is created.
 */
export function useLinkedLesson(): LinkedLessonState {
  const [id, setId] = useState<string | null>(currentId);
  const [state, setState] = useState<LinkedLessonState>(() => {
    const first = currentId();
    return first === null ? { phase: "none" } : { phase: "loading", id: first };
  });

  useEffect(() => {
    const onHashChange = () => setId(currentId());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (id === null) {
      setState({ phase: "none" });
      return;
    }
    const abort = new AbortController();
    setState({ phase: "loading", id });
    loadLesson(id, pageRef(), undefined, abort.signal).then(
      (lesson) => {
        if (!abort.signal.aborted) setState(lesson === null ? { phase: "missing", id } : { phase: "ready", id, lesson });
      },
      () => {
        if (!abort.signal.aborted) setState({ phase: "error", id });
      },
    );
    return () => abort.abort();
  }, [id]);

  return state;
}
