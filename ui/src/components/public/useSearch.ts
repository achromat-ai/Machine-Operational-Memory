import { useCallback, useEffect, useReducer, useRef } from "react";
import { describeSearchFailure, initialSearchState, runSearch, searchReducer, type SearchQuery, type SearchState } from "../../lib/search";

/**
 * Runs simple searches against the public GET /api/v1/search with a plain fetch, so no identity is created. Only the
 * newest search may update the page: starting another aborts the one in flight, and unmounting aborts the last.
 */
export function useSearch(): { state: SearchState; search: (query: SearchQuery) => Promise<void> } {
  const [state, dispatch] = useReducer(searchReducer, initialSearchState);
  const latest = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const search = useCallback(async (query: SearchQuery) => {
    const ticket = ++latest.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    dispatch({ type: "start" });
    try {
      const results = await runSearch((input, init) => fetch(input, init), query, abort.signal);
      if (ticket === latest.current) dispatch({ type: "success", query, results });
    } catch (error) {
      if (ticket === latest.current && !abort.signal.aborted) dispatch({ type: "failure", failure: describeSearchFailure(error) });
    }
  }, []);

  useEffect(
    () => () => {
      latest.current++;
      controller.current?.abort();
    },
    [],
  );

  return { state, search };
}
