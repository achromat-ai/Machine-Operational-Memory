import { useCallback, useReducer, useRef } from "react";
import { signedFetch } from "../../lib/api";
import { describeRecallFailure, initialRecallState, recallReducer, runRecall, type RecallPayload, type RecallState } from "../../lib/recall";

/**
 * Runs searches against POST /api/v1/recall with the browser's community identity (signedFetch registers
 * one on the first search). Only the newest search may update the page: a slow older answer is dropped.
 */
export function useRecall(): { state: RecallState; search: (payload: RecallPayload) => Promise<void> } {
  const [state, dispatch] = useReducer(recallReducer, initialRecallState);
  const latest = useRef(0);

  const search = useCallback(async (payload: RecallPayload) => {
    const ticket = ++latest.current;
    dispatch({ type: "start" });
    try {
      const outcome = await runRecall(signedFetch, payload);
      if (ticket === latest.current) dispatch({ type: "success", query: payload, outcome });
    } catch (error) {
      if (ticket === latest.current) dispatch({ type: "failure", failure: describeRecallFailure(error) });
    }
  }, []);

  return { state, search };
}
