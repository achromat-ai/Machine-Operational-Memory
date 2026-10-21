/**
 * The marketing `ref` tag of the page URL (`/?ref=launch-post`), forwarded to the onboarding endpoints and the copied
 * agent prompt so the activation funnel can be attributed. Cookie-free: it is read from the address bar each time and
 * never stored. A missing, repeated or malformed tag is "" (organic traffic), and "" is never sent.
 *
 * Same rule as the server's parseRef (src/telemetry.ts): a lowercase slug of 1-32 characters.
 */
const REF_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The ref in a query string such as "?ref=x", or "". */
export function refFromSearch(search: string): string {
  try {
    const values = new URLSearchParams(search).getAll("ref");
    if (values.length !== 1) return "";
    const ref = (values[0] ?? "").trim().toLowerCase();
    return REF_PATTERN.test(ref) ? ref : "";
  } catch {
    return "";
  }
}

/** The ref of the page being viewed, or "" outside a browser. */
export function pageRef(): string {
  const scope = globalThis as { window?: { location?: { search?: string } } };
  const search = scope.window?.location?.search;
  return typeof search === "string" ? refFromSearch(search) : "";
}

/** `path` with `?ref=` appended when there is a ref, otherwise `path` unchanged. */
export function withRef(path: string, ref: string): string {
  return ref === "" ? path : `${path}${path.includes("?") ? "&" : "?"}ref=${encodeURIComponent(ref)}`;
}
