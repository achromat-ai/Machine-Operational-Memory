/** State of the review queue, as a reducer so its transitions are tested without a DOM. */
import type { PendingLesson, QueueStatus } from "./adminApi";

export interface QueueState {
  status: QueueStatus;
  lessons: PendingLesson[];
  nextCursor: string | null;
  /** A page is being fetched. */
  loading: boolean;
  /** At least one page has been loaded for the current status. */
  loaded: boolean;
  error: string | null;
  /** Result of the last decision, announced to screen readers. */
  notice: string | null;
}

export const initialQueueState: QueueState = {
  status: "pending_review",
  lessons: [],
  nextCursor: null,
  loading: false,
  loaded: false,
  error: null,
  notice: null,
};

export type QueueAction =
  | { type: "select-status"; status: QueueStatus }
  | { type: "load-start" }
  | { type: "load-success"; lessons: PendingLesson[]; nextCursor: string | null; append: boolean }
  | { type: "load-failure"; message: string }
  | { type: "removed"; lessonId: string; notice: string }
  | { type: "dismiss-notice" };

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "select-status":
      if (action.status === state.status) return state;
      return { ...initialQueueState, status: action.status };
    case "load-start":
      return { ...state, loading: true, error: null };
    case "load-success": {
      const known = new Set(action.append ? state.lessons.map((lesson) => lesson.lessonId) : []);
      const fresh = action.lessons.filter((lesson) => !known.has(lesson.lessonId));
      return {
        ...state,
        lessons: action.append ? [...state.lessons, ...fresh] : fresh,
        nextCursor: action.nextCursor,
        loading: false,
        loaded: true,
        error: null,
      };
    }
    case "load-failure":
      return { ...state, loading: false, error: action.message };
    case "removed":
      return { ...state, lessons: state.lessons.filter((lesson) => lesson.lessonId !== action.lessonId), notice: action.notice };
    case "dismiss-notice":
      return state.notice === null ? state : { ...state, notice: null };
  }
}
