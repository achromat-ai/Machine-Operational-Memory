/** Shared fetch plumbing for the identity flow and the signed client. */
import type { ServerClock } from "./clock";

/** fetch with a same-origin path. Injected so the clients run against fakes and the real Worker in tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The `code` of a `{success: false, code}` error body, or null. Reads a clone, so the body stays usable. */
export async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();
    if (typeof body === "object" && body !== null && "code" in body) {
      const code = (body as { code: unknown }).code;
      return typeof code === "string" ? code : null;
    }
  } catch {
    // Not JSON (a proxy error page, an empty body): there is no code.
  }
  return null;
}

/** Wraps a fetch so every response teaches the shared clock the server's time. */
export function observeServerClock(inner: FetchLike, clock: ServerClock, now: () => number = Date.now): FetchLike {
  return async (input, init) => {
    const response = await inner(input, init);
    clock.observe(response, now());
    return response;
  };
}

/** The browser's fetch for same-origin API calls: no cookies, never cached. */
export function browserFetch(): FetchLike {
  // Typed loosely: `credentials` and `redirect` are DOM RequestInit fields that Workers' typings omit.
  const defaults: Record<string, unknown> = { credentials: "omit", cache: "no-store", redirect: "error" };
  return (input, init) => globalThis.fetch(input, { ...defaults, ...init } as RequestInit);
}
