import { useSyncExternalStore } from "react";
import { getAdminSession, type AdminSession, type AdminSessionState } from "../../lib/adminSession";

/** The tab's console session and its current state. */
export function useAdminSession(): { session: AdminSession; state: AdminSessionState } {
  const session = getAdminSession();
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return { session, state };
}
