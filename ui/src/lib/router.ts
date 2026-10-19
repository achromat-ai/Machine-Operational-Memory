/** Pathname to route. Two real pages; everything else is a not-found page. */

export const HOME_PATH = "/";
export const REVIEW_PATH = "/admin/review";

export type Route = { name: "home" } | { name: "review" } | { name: "not-found"; path: string };

/** A trailing slash is ignored. Matching is exact and case-sensitive. */
export function resolveRoute(pathname: string): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
  if (path === HOME_PATH || path === "") return { name: "home" };
  if (path === REVIEW_PATH) return { name: "review" };
  return { name: "not-found", path: pathname };
}
