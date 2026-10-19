/** Client-side filtering of the loaded feed (the server sends at most the newest 20 lessons). Pure, no DOM. */
import { DOMAIN_ORDER, domainLabel } from "./domains";
import type { FeedLessonView } from "./feed";

export interface FeedFilter {
  /** A domain slug, or null for all of them. */
  domain: string | null;
  text: string;
}

export const NO_FILTER: FeedFilter = { domain: null, text: "" };

function haystack(lesson: FeedLessonView): string {
  return [
    domainLabel(lesson.domain),
    lesson.domain,
    lesson.tool,
    lesson.violationRule,
    lesson.steeringDirective ?? "",
    lesson.statutoryAnchor ?? "",
    lesson.displayTitle ?? "",
    lesson.displaySummary ?? "",
    ...lesson.changedPaths,
  ]
    .join("\n")
    .toLowerCase();
}

export function filterLessons(lessons: readonly FeedLessonView[], filter: FeedFilter): FeedLessonView[] {
  const needle = filter.text.trim().toLowerCase();
  return lessons.filter((lesson) => (filter.domain === null || lesson.domain === filter.domain) && (needle === "" || haystack(lesson).includes(needle)));
}

/** The domains present in `lessons` with their counts: the known ones in their usual order, then any others. */
export function domainCounts(lessons: readonly FeedLessonView[]): Array<{ domain: string; count: number }> {
  const counts = new Map<string, number>();
  for (const lesson of lessons) counts.set(lesson.domain, (counts.get(lesson.domain) ?? 0) + 1);
  const known: string[] = DOMAIN_ORDER.filter((domain) => counts.has(domain));
  const others = [...counts.keys()].filter((domain) => !known.includes(domain)).sort();
  return [...known, ...others].map((domain) => ({ domain, count: counts.get(domain)! }));
}
