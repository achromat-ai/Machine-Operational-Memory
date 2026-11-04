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

/**
 * The domains present in `lessons`: the known ones in their usual order, then any others. Deliberately returns no
 * counts. The feed is only the newest slice of the lessons, so a number here would read as a size of the whole set.
 */
export function domainsPresent(lessons: readonly FeedLessonView[]): string[] {
  const present = new Set(lessons.map((lesson) => lesson.domain));
  const known: string[] = DOMAIN_ORDER.filter((domain) => present.has(domain));
  const others = [...present].filter((domain) => !known.includes(domain)).sort();
  return [...known, ...others];
}
