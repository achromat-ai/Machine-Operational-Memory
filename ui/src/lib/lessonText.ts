/**
 * Text helpers for a feed row. A lesson's `steering_directive` can hold several alternatives joined with
 * " | ". The table shows the short form and the detail row shows all of it. The public payload carries no
 * rule name or number, only the statutory anchor. Pure functions, no DOM.
 */
import { pathLabel } from "./delta";

/** The title of a lesson card: the editorial title, else the statutory anchor, else a generic line naming the tool. */
export function lessonHeading(lesson: { displayTitle?: string | null; statutoryAnchor: string | null; tool: string }): string {
  const title = lesson.displayTitle?.trim();
  if (title) return title;
  const anchor = lesson.statutoryAnchor?.trim();
  if (anchor) return anchor;
  return `Policy violation: ${lesson.tool}`;
}

export interface SteeringParts {
  /** The first alternative: what to show in the table. */
  lead: string | null;
  /** The others, shown in the detail row. */
  more: string[];
}

export function splitSteering(steeringDirective: string | null): SteeringParts {
  const parts = (steeringDirective ?? "")
    .split(/\s\|\s/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return { lead: parts[0] ?? null, more: parts.slice(1) };
}

/** The first few changed field names for the row, and how many more there are. */
export function changedFieldLabels(changedPaths: readonly string[], max = 3): { shown: string[]; hidden: number } {
  const labels = [...new Set(changedPaths.map(pathLabel))];
  return { shown: labels.slice(0, max), hidden: Math.max(0, labels.length - max) };
}

/** Anchor ids. A lesson is drawn twice (a table row and a small-screen card), so each form has its own. */
export const rowAnchor = (lessonId: string) => `lesson-${lessonId}`;
export const cardAnchor = (lessonId: string) => `lesson-card-${lessonId}`;

/** The lesson id named by a `#lesson-<id>` or `#lesson-card-<id>` fragment, or null. */
export function lessonIdFromHash(hash: string): string | null {
  const match = /^#lesson-(?:card-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(hash);
  return match ? match[1]!.toLowerCase() : null;
}

/** A tool name cut after each separator, so a long one wraps between words and not in the middle of one. */
export function toolSegments(tool: string): string[] {
  return tool.match(/[^_.:/-]+[_.:/-]*|[_.:/-]+/g) ?? [tool];
}
