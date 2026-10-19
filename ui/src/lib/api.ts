/**
 * signedFetch: same-origin API calls signed with the community identity (public/skill.md section 3).
 *
 * Per attempt it builds the seven-part canonical string
 *   achromat-mom-v1 LF host LF METHOD LF path+query LF sha256hex(body) LF timestamp LF nonce
 * signs its UTF-8 bytes, and sends Achromat-Agent-Key / -Timestamp / -Nonce / -Signature. The body is
 * converted to bytes once, hashed, and those same bytes are sent, so what is signed is what is received.
 * The timestamp is local time plus the server clock offset learned from earlier responses' Date headers.
 *
 * Retries (each at most once per call, so a call makes at most three attempts):
 *   - AGENT_SIGNATURE_EXPIRED or AGENT_NONCE_REPLAYED: re-learn the clock offset, draw a fresh nonce, resend.
 *   - AGENT_KEY_UNKNOWN or AGENT_KEY_INACTIVE: the server does not accept the stored key. Forget it,
 *     provision and register a new one, resend.
 * Any other response, and the response after an exhausted retry, is returned to the caller unchanged.
 */
import { encodeBase64url } from "./base64url";
import { EMPTY_BODY_SHA256_HEX, requestSigningString, utf8 } from "./canonical";
import { serverClock, type ServerClock } from "./clock";
import { browserFetch, observeServerClock, readErrorCode, type FetchLike } from "./http";
import { getOrRegisterCommunityIdentity, resetCommunityIdentity, type CommunityIdentity, type IdentityService } from "./identity";
import { sha256Hex } from "./sha256";

/** The server rejects bodies over 64 KiB. */
export const MAX_SIGNED_BODY_BYTES = 64 * 1024;

const SIGNATURE_HEADERS = ["Achromat-Agent-Key", "Achromat-Timestamp", "Achromat-Nonce", "Achromat-Signature"] as const;

export interface SignedClientDeps {
  identity: Pick<IdentityService, "getOrRegisterCommunityIdentity" | "resetCommunityIdentity">;
  fetch: FetchLike;
  clock?: ServerClock;
  /** Local epoch milliseconds. */
  now?: () => number;
  /** The host the server sees (location.host). It is part of the signed string. */
  host?: () => string;
  randomBytes?: (length: number) => Uint8Array;
}

export interface SignedClient {
  signedFetch(path: string, options?: RequestInit): Promise<Response>;
}

/**
 * The path and query exactly as the server will parse them. Going through URL applies the same
 * normalisation (percent-encoding, dot segments) the server's URL parser applies to the request line, so
 * the string that is signed is the string that arrives.
 */
export function normalisePath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new TypeError("path must be a same-origin path that starts with a single '/'");
  }
  const base = "https://same-origin.invalid";
  const url = new URL(path, base);
  if (url.origin !== base) throw new TypeError("path must be a same-origin path that starts with a single '/'");
  return url.pathname + url.search;
}

function toBodyBytes(body: BodyInit | null | undefined): Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return utf8(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
  throw new TypeError("a signed request body must be a string, an ArrayBuffer or a typed array");
}

export function createSignedClient(deps: SignedClientDeps): SignedClient {
  const clock = deps.clock ?? serverClock;
  const now = deps.now ?? Date.now;
  const host = deps.host ?? (() => (globalThis as { location?: { host: string } }).location?.host ?? "");
  const randomBytes = deps.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));

  /** Learns the clock from the public health endpoint when a failed response carried no usable Date. */
  async function syncClockFromHealth(): Promise<void> {
    try {
      const response = await deps.fetch("/api/v1/health", { method: "GET" });
      clock.observe(response, now());
    } catch {
      // The retry below will simply fail the same way and be returned to the caller.
    }
  }

  async function signedFetch(path: string, options: RequestInit = {}): Promise<Response> {
    const pathAndQuery = normalisePath(path);
    const method = (options.method ?? "GET").toUpperCase();
    const bytes = toBodyBytes(options.body);
    if (bytes !== undefined && (method === "GET" || method === "HEAD")) throw new TypeError(`${method} requests cannot have a body`);
    if (bytes !== undefined && bytes.length > MAX_SIGNED_BODY_BYTES) throw new RangeError("the request body is over 64 KiB");
    const bodySha256Hex = bytes === undefined ? EMPTY_BODY_SHA256_HEX : sha256Hex(bytes);

    const { body: _ignoredBody, headers: callerHeaders, method: _ignoredMethod, ...rest } = options;

    async function attempt(identity: CommunityIdentity): Promise<Response> {
      const timestamp = String(Math.floor(clock.serverTime(now()) / 1000));
      const nonce = encodeBase64url(randomBytes(16));
      const canonical = requestSigningString({ host: host(), method, pathAndQuery, bodySha256Hex, timestamp, nonce });
      const signature = await identity.signer.sign(utf8(canonical));

      const headers = new Headers(callerHeaders);
      for (const name of SIGNATURE_HEADERS) headers.delete(name);
      headers.set("Achromat-Agent-Key", identity.publicKeyB64u);
      headers.set("Achromat-Timestamp", timestamp);
      headers.set("Achromat-Nonce", nonce);
      headers.set("Achromat-Signature", signature);

      // Typed loosely: `credentials` and `redirect` are DOM RequestInit fields that Workers' typings omit.
      const init: Record<string, unknown> = {
        ...rest,
        method,
        headers,
        ...(bytes === undefined ? {} : { body: new Uint8Array(bytes) }),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      };
      const response = await deps.fetch(pathAndQuery, init as RequestInit);
      clock.observe(response, now());
      return response;
    }

    let signatureRetried = false;
    let identityReset = false;
    for (;;) {
      const identity = await deps.identity.getOrRegisterCommunityIdentity();
      const response = await attempt(identity);
      if (response.status !== 401 && response.status !== 403) return response;

      const code = await readErrorCode(response);
      if ((code === "AGENT_SIGNATURE_EXPIRED" || code === "AGENT_NONCE_REPLAYED") && !signatureRetried) {
        signatureRetried = true;
        // The failed response's Date header was just observed. Without one, ask the health endpoint.
        if (code === "AGENT_SIGNATURE_EXPIRED" && response.headers.get("Date") === null) await syncClockFromHealth();
        continue;
      }
      if ((code === "AGENT_KEY_UNKNOWN" || code === "AGENT_KEY_INACTIVE") && !identityReset) {
        identityReset = true;
        await deps.identity.resetCommunityIdentity(identity.publicKeyB64u);
        continue;
      }
      return response;
    }
  }

  return { signedFetch };
}

// ════════════════════════════════════════════════════════════════════════
// Browser default
// ════════════════════════════════════════════════════════════════════════

let defaultClient: SignedClient | undefined;

/** Signed same-origin request with the browser's community identity. */
export function signedFetch(path: string, options?: RequestInit): Promise<Response> {
  defaultClient ??= createSignedClient({
    identity: { getOrRegisterCommunityIdentity, resetCommunityIdentity },
    fetch: observeServerClock(browserFetch(), serverClock),
  });
  return defaultClient.signedFetch(path, options);
}
