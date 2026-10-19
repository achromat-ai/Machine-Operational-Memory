/** Shared JSON error responses and bounded body reading for API routes. */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * `{success: false, error, code, details?}`. `error` stays a plain string, matching
 * the existing 404/500 shape; `code` is the stable machine-readable value.
 */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: readonly ErrorDetail[],
) {
  return c.json({ success: false, error: message, code, ...(details && details.length ? { details } : {}) }, status);
}

/**
 * Reads the request body as bytes, stopping as soon as it exceeds `maxBytes`, so
 * a chunked upload without Content-Length cannot make the Worker buffer it.
 * Returns null when the body is too large.
 */
export async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return null;
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Parses a JSON body. Returns undefined (not throw) on malformed JSON or invalid UTF-8. */
export function parseJsonBytes(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return undefined;
  }
}

/**
 * Reads a URL's query string as a plain object. Returns null when a name repeats, so a signed
 * request cannot carry two values for one filter and have the route silently pick one.
 */
export function queryParams(url: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [name, value] of new URL(url).searchParams) {
    if (Object.hasOwn(out, name)) return null;
    out[name] = value;
  }
  return out;
}
