import { useCallback, useEffect, useReducer, useRef } from "react";
import { FEED_REFRESH_MS, describeFeedFailure, feedReducer, initialFeedState, loadFeed, type FeedState } from "../../lib/feed";

/**
 * Loads the public feed on mount and refreshes it every minute while the tab is visible (and once more when
 * it becomes visible again). Uses a plain fetch, so no identity is created. Only the newest request may
 * update the page, and unmounting aborts the one in flight.
 */
export function useFeed(): { state: FeedState; refresh: () => void } {
  const [state, dispatch] = useReducer(feedReducer, initialFeedState);
  const latest = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    const ticket = ++latest.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    dispatch({ type: "start" });
    loadFeed(undefined, abort.signal).then(
      (lessons) => {
        if (ticket === latest.current) dispatch({ type: "success", lessons });
      },
      (error: unknown) => {
        if (ticket === latest.current && !abort.signal.aborted) dispatch({ type: "failure", message: describeFeedFailure(error) });
      },
    );
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, FEED_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      latest.current++;
      controller.current?.abort();
    };
  }, [refresh]);

  return { state, refresh };
}
