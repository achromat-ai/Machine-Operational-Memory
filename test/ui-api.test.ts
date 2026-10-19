/**
 * Signed API client (ui/src/lib/api.ts, clock.ts). Requests go to the REAL Worker through a fake CDN edge
 * (fixtures/ui-env.ts), so the Worker's own auth middleware judges every signature, timestamp and nonce.
 * Where a precise server answer is needed (a replay, a rejected key), the edge swaps in that answer.
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { requestSigningString as serverRequestSigningString, toHex, verifyEd25519, sha256Hex as serverSha256Hex, decodeBase64url as serverDecode } from "../src/schema";
import { MAX_SIGNED_BODY_BYTES, normalisePath } from "../ui/src/lib/api";
import { ServerClock } from "../ui/src/lib/clock";
import { createCommunityKey } from "../ui/src/lib/keystore";
import { agentEvent } from "./fixtures/ledger";
import { HOST, errorResponse, makeClient } from "./fixtures/ui-env";

const ME = "/api/v1/agents/me";
const HEALTH = "/api/v1/health";
const FIVE_MINUTES = 5 * 60 * 1000;

async function agentKeyOf(response: Response): Promise<string> {
  return ((await response.json()) as { agent: { agent_key: string } }).agent.agent_key;
}

// ════════════════════════════════════════════════════════════════════════
// Clock
// ════════════════════════════════════════════════════════════════════════

describe("ServerClock", () => {
  const at = (iso: string) => ({ headers: new Headers({ Date: new Date(iso).toUTCString() }) });

  it("learns the offset from a Date header and applies it", () => {
    const clock = new ServerClock();
    expect(clock.isSynchronised).toBe(false);
    expect(clock.serverTime(1_000)).toBe(1_000);

    const local = Date.parse("2026-10-11T12:00:00Z");
    // The device is five minutes fast: the server says 12:00:00 when the device reads 12:05:00.
    expect(clock.observe(at("2026-10-11T12:00:00Z"), local + FIVE_MINUTES)).toBe(true);
    expect(clock.offsetMs).toBe(-FIVE_MINUTES);
    expect(clock.isSynchronised).toBe(true);
    expect(clock.serverTime(local + FIVE_MINUTES + 7_000)).toBe(local + 7_000);

    // And slow by ten minutes.
    clock.observe(at("2026-10-11T12:10:00Z"), local);
    expect(clock.offsetMs).toBe(10 * 60 * 1000);
  });

  it("ignores a missing or unparsable Date and keeps the last good offset", () => {
    const clock = new ServerClock();
    clock.observe(at("2026-10-11T12:00:00Z"), Date.parse("2026-10-11T12:01:00Z"));
    const learned = clock.offsetMs;
    expect(clock.observe({ headers: new Headers() }, 5)).toBe(false);
    expect(clock.observe({ headers: new Headers({ Date: "yesterday-ish" }) }, 5)).toBe(false);
    expect(clock.offsetMs).toBe(learned);
    clock.reset();
    expect(clock.offsetMs).toBe(0);
    expect(clock.isSynchronised).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// signedFetch against the real Worker
// ════════════════════════════════════════════════════════════════════════

describe("signedFetch", () => {
  it("provisions an identity on first use and the Worker accepts the signed request", async () => {
    const { signedFetch, edge, tab } = makeClient();
    const response = await signedFetch(ME);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { agent: { role: string; status: string; agent_key: string } };
    expect(body.agent).toMatchObject({ role: "community", status: "active" });
    expect(body.agent.agent_key).toBe(toHex(serverDecode((await tab.keystore.load())!.publicKeyB64u)));

    expect(edge.requests.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual([
      "GET /api/v1/agents/challenge 200",
      "POST /api/v1/agents/register 201",
      `GET ${ME} 200`,
    ]);
  });

  it("sends the four headers in their exact formats, with a fresh nonce every time", async () => {
    const { signedFetch, edge } = makeClient();
    for (let i = 0; i < 3; i++) expect((await signedFetch(ME)).status).toBe(200);
    const sent = edge.to(ME);
    expect(sent).toHaveLength(3);
    const nonces = new Set<string>();
    for (const request of sent) {
      expect(request.headers.get("Achromat-Agent-Key")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(request.headers.get("Achromat-Timestamp")).toMatch(/^\d{10}$/);
      expect(request.headers.get("Achromat-Nonce")).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(request.headers.get("Achromat-Signature")).toMatch(/^[A-Za-z0-9_-]{86}$/);
      nonces.add(request.headers.get("Achromat-Nonce")!);
    }
    expect(nonces.size).toBe(3);
  });

  it("signs the seven-part string the server builds, over the exact bytes it sends", async () => {
    let captured: { init: RequestInit; path: string } | undefined;
    const { signedFetch, tab } = makeClient({
      intercept: (path, init) => {
        if (path === "/api/v1/recall") captured = { init, path };
        return undefined;
      },
    });
    const text = JSON.stringify({ task_description: "Überweisung 💸 an das Konto", note: "ünï" });
    const response = await signedFetch("/api/v1/recall", { method: "post", body: text, headers: { "Content-Type": "application/json" } });
    // Authentication passed (a bad signature or body hash would be a 401); the strict schema then refuses the body.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_REQUEST");

    const { init, path } = captured!;
    const sentBytes = init.body as Uint8Array;
    expect(sentBytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(sentBytes)).toEqual(Array.from(new TextEncoder().encode(text)));

    const headers = new Headers(init.headers);
    const canonical = serverRequestSigningString({
      host: HOST,
      method: "POST",
      pathAndQuery: path,
      bodySha256Hex: await serverSha256Hex(sentBytes),
      timestamp: headers.get("Achromat-Timestamp")!,
      nonce: headers.get("Achromat-Nonce")!,
    });
    const publicKey = (await tab.keystore.load())!.publicKeyB64u;
    expect(headers.get("Achromat-Agent-Key")).toBe(publicKey);
    expect(await verifyEd25519(publicKey, headers.get("Achromat-Signature")!, canonical)).toBe(true);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store", redirect: "error" });
  });

  it("signs the normalised path and query, the form the server parses", async () => {
    expect(normalisePath("/api/v1/agents/me")).toBe(ME);
    expect(normalisePath("/api/v1/agents/me?x=1&y=a b")).toBe("/api/v1/agents/me?x=1&y=a%20b");
    expect(normalisePath("/api/v1/../v1/agents/./me#frag")).toBe(ME);

    const { signedFetch, edge } = makeClient();
    expect((await signedFetch("/api/v1/agents/me?x=1&y=a b")).status).toBe(200);
    expect(edge.to(ME).at(-1)!.path).toBe("/api/v1/agents/me?x=1&y=a%20b");
  });

  it("replaces caller-supplied signature headers and keeps the caller's other headers", async () => {
    const { signedFetch, edge } = makeClient();
    const response = await signedFetch(ME, {
      headers: { "X-Trace": "abc", "achromat-signature": "forged", "Achromat-Agent-Key": "forged", "ACHROMAT-NONCE": "forged" },
    });
    expect(response.status).toBe(200);
    const headers = edge.to(ME)[0]!.headers;
    expect(headers.get("X-Trace")).toBe("abc");
    expect(headers.get("Achromat-Signature")).toHaveLength(86);
    expect(headers.get("Achromat-Agent-Key")).toHaveLength(43);
    expect(headers.get("Achromat-Nonce")).toHaveLength(22);
  });

  it("refuses anything but a same-origin path, before any identity work or request", async () => {
    const { signedFetch, edge, tab } = makeClient();
    for (const bad of ["https://evil.example/api/v1/agents/me", "//evil.example/x", "/\\evil.example/x", "api/v1/agents/me", "", "http://localhost/x"]) {
      await expect(signedFetch(bad), JSON.stringify(bad)).rejects.toThrow(TypeError);
    }
    expect(edge.requests).toHaveLength(0);
    expect(tab.store.map.size).toBe(0);
  });

  it("refuses a body on GET and HEAD, an unsupported body type, and a body over 64 KiB", async () => {
    const { signedFetch, edge } = makeClient();
    await expect(signedFetch(ME, { body: "x" })).rejects.toThrow(TypeError);
    await expect(signedFetch(ME, { method: "HEAD", body: "x" })).rejects.toThrow(TypeError);
    await expect(signedFetch("/api/v1/recall", { method: "POST", body: new URLSearchParams("a=b") })).rejects.toThrow(TypeError);
    await expect(signedFetch("/api/v1/recall", { method: "POST", body: new FormData() })).rejects.toThrow(TypeError);
    await expect(signedFetch("/api/v1/recall", { method: "POST", body: "x".repeat(MAX_SIGNED_BODY_BYTES + 1) })).rejects.toThrow(RangeError);
    expect(edge.requests).toHaveLength(0);

    // Exactly 64 KiB is allowed by the client and by the server (which then rejects the content, not the size).
    const response = await signedFetch("/api/v1/recall", { method: "POST", body: " ".repeat(MAX_SIGNED_BODY_BYTES) });
    expect(response.status).toBe(400);
  });

  it("accepts a body given as ArrayBuffer or typed array and signs those bytes", async () => {
    const { signedFetch } = makeClient();
    const bytes = new TextEncoder().encode("{}");
    expect((await signedFetch("/api/v1/recall", { method: "POST", body: bytes })).status).toBe(400);
    expect((await signedFetch("/api/v1/recall", { method: "POST", body: bytes.buffer as ArrayBuffer })).status).toBe(400);
    const view = new Uint8Array([9, 9, ...bytes, 9]).subarray(2, 4); // a view into a larger buffer
    expect((await signedFetch("/api/v1/recall", { method: "POST", body: view })).status).toBe(400);
  });

  it("passes non-authentication errors straight through without retrying", async () => {
    const answers: Array<[number, string]> = [
      [401, "AGENT_SIGNATURE_INVALID"],
      [401, "AGENT_SIGNATURE_REQUIRED"],
      [403, "AGENT_ROLE_FORBIDDEN"],
      [429, "RATE_LIMITED"],
    ];
    for (const [status, code] of answers) {
      const { signedFetch, edge, resets } = makeClient({ intercept: (path) => (path === ME ? errorResponse(status, code) : undefined) });
      const response = await signedFetch(ME);
      expect(response.status).toBe(status);
      expect(((await response.json()) as { code: string }).code).toBe(code);
      expect(edge.to(ME)).toHaveLength(1);
      expect(resets()).toBe(0);
    }
    // A 403 that is not our JSON shape (a proxy page) is also returned untouched.
    const { signedFetch, edge } = makeClient({ intercept: (path) => (path === ME ? new Response("<html>denied</html>", { status: 403 }) : undefined) });
    expect((await signedFetch(ME)).status).toBe(403);
    expect(edge.to(ME)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Clock skew
// ════════════════════════════════════════════════════════════════════════

describe("signedFetch clock skew", () => {
  const secondsFrom = (request: { headers: Headers }) => Number(request.headers.get("Achromat-Timestamp"));

  it("re-learns the offset from the failed response and succeeds on the single retry (device five minutes fast)", async () => {
    const { signedFetch, edge, clock } = makeClient({ skewMs: FIVE_MINUTES });
    const response = await signedFetch(ME);
    expect(response.status).toBe(200);

    const attempts = edge.to(ME);
    expect(attempts.map((r) => r.status)).toEqual([401, 200]);
    // The first timestamp was five minutes in the future, the retry is within seconds of real time.
    expect(secondsFrom(attempts[0]!) - Date.now() / 1000).toBeGreaterThan(290);
    expect(Math.abs(secondsFrom(attempts[1]!) - Date.now() / 1000)).toBeLessThan(5);
    expect(Math.abs(clock.offsetMs + FIVE_MINUTES)).toBeLessThan(2500);

    // From now on the offset is applied up front: one attempt.
    expect((await signedFetch(ME)).status).toBe(200);
    expect(edge.to(ME).map((r) => r.status)).toEqual([401, 200, 200]);
  });

  it("handles a device that is ten minutes slow", async () => {
    const { signedFetch, edge, clock } = makeClient({ skewMs: -10 * 60 * 1000 });
    expect((await signedFetch(ME)).status).toBe(200);
    expect(edge.to(ME).map((r) => r.status)).toEqual([401, 200]);
    expect(Math.abs(clock.offsetMs - 10 * 60 * 1000)).toBeLessThan(2500);
  });

  it("needs no retry when registration already taught the clock", async () => {
    const { signedFetch, edge, clock } = makeClient({ skewMs: FIVE_MINUTES, observeRegistration: true });
    expect(clock.isSynchronised).toBe(false);
    expect((await signedFetch(ME)).status).toBe(200);
    expect(clock.isSynchronised).toBe(true);
    expect(edge.to(ME).map((r) => r.status)).toEqual([200]);
  });

  it("asks the public health endpoint for the time when the failed response has no Date header", async () => {
    const { signedFetch, edge } = makeClient({ skewMs: FIVE_MINUTES, omitDate: [ME] });
    expect((await signedFetch(ME)).status).toBe(200);
    expect(edge.requests.filter((r) => r.path === ME || r.path === HEALTH).map((r) => `${r.path} ${r.status}`)).toEqual([
      `${ME} 401`,
      `${HEALTH} 200`,
      `${ME} 200`,
    ]);
  });

  it("gives up after one retry when no response can teach the clock, returning the 401", async () => {
    const { signedFetch, edge } = makeClient({ skewMs: FIVE_MINUTES, omitDate: true });
    const response = await signedFetch(ME);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("AGENT_SIGNATURE_EXPIRED");
    expect(edge.to(ME)).toHaveLength(2);
    expect(edge.to(HEALTH)).toHaveLength(1);
  });

  it("retries EXPIRED exactly once even when the server keeps saying so", async () => {
    const { signedFetch, edge, resets } = makeClient({ intercept: (path) => (path === ME ? errorResponse(401, "AGENT_SIGNATURE_EXPIRED", { Date: new Date().toUTCString() }) : undefined) });
    const response = await signedFetch(ME);
    expect(response.status).toBe(401);
    expect(edge.to(ME)).toHaveLength(2);
    expect(resets()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Nonce replay
// ════════════════════════════════════════════════════════════════════════

describe("signedFetch nonce replay", () => {
  it("retries with a fresh nonce when the Worker reports a real replay", async () => {
    // The edge delivers the first /me twice, so the Worker answers the second with AGENT_NONCE_REPLAYED.
    const { signedFetch, edge } = makeClient({ replayOnce: (route) => route === ME });
    const response = await signedFetch(ME);
    expect(response.status).toBe(200);

    const attempts = edge.to(ME);
    expect(attempts.map((r) => r.status)).toEqual([401, 200]);
    expect(attempts[0]!.headers.get("Achromat-Nonce")).not.toBe(attempts[1]!.headers.get("Achromat-Nonce"));
    expect(attempts[0]!.headers.get("Achromat-Signature")).not.toBe(attempts[1]!.headers.get("Achromat-Signature"));
  });

  it("retries a replay exactly once, then returns the 401", async () => {
    const { signedFetch, edge } = makeClient({ intercept: (path) => (path === ME ? errorResponse(401, "AGENT_NONCE_REPLAYED") : undefined) });
    const response = await signedFetch(ME);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("AGENT_NONCE_REPLAYED");
    expect(edge.to(ME)).toHaveLength(2);
  });

  it("spends one retry for the signature class: EXPIRED then REPLAYED is not retried a second time", async () => {
    const codes = ["AGENT_SIGNATURE_EXPIRED", "AGENT_NONCE_REPLAYED"];
    const { signedFetch, edge } = makeClient({
      intercept: (path, _init, attempt) => (path === ME ? errorResponse(401, codes[attempt - 1] ?? "AGENT_NONCE_REPLAYED", { Date: new Date().toUTCString() }) : undefined),
    });
    const response = await signedFetch(ME);
    expect(response.status).toBe(401);
    expect(edge.to(ME)).toHaveLength(2);
  });

  it("resends the same body bytes on a retry", async () => {
    const bodies: Uint8Array[] = [];
    const { signedFetch } = makeClient({
      intercept: (path, init, attempt) => {
        if (path !== "/api/v1/recall") return undefined;
        bodies.push(init.body as Uint8Array);
        return attempt === 1 ? errorResponse(401, "AGENT_NONCE_REPLAYED") : undefined;
      },
    });
    await signedFetch("/api/v1/recall", { method: "POST", body: '{"a":"é"}' });
    expect(bodies).toHaveLength(2);
    expect(Array.from(bodies[1]!)).toEqual(Array.from(bodies[0]!));
  });
});

// ════════════════════════════════════════════════════════════════════════
// Rejected keys
// ════════════════════════════════════════════════════════════════════════

describe("signedFetch rejected identity", () => {
  it("replaces a stored key the server does not know (AGENT_KEY_UNKNOWN) and retries once", async () => {
    const { signedFetch, edge, tab, resets } = makeClient();
    const orphan = await createCommunityKey();
    await tab.keystore.save({ ...orphan, registered: true }); // e.g. the server database was reset

    const response = await signedFetch(ME);
    expect(response.status).toBe(200);
    expect(resets()).toBe(1);
    expect(edge.to(ME).map((r) => r.status)).toEqual([401, 200]);
    expect(edge.to("/api/v1/agents/register").map((r) => r.status)).toEqual([201]);

    const stored = (await tab.keystore.load())!;
    expect(stored.publicKeyB64u).not.toBe(orphan.publicKeyB64u);
    expect(stored.registered).toBe(true);
    expect(await agentKeyOf(await signedFetch(ME))).toBe(toHex(serverDecode(stored.publicKeyB64u)));
  });

  it("replaces a revoked key (403 AGENT_KEY_INACTIVE) with a freshly registered one", async () => {
    const { signedFetch, edge, tab } = makeClient();
    expect((await signedFetch(ME)).status).toBe(200);
    const revoked = (await tab.keystore.load())!;
    await agentEvent(toHex(serverDecode(revoked.publicKeyB64u)), "revoked");

    const response = await signedFetch(ME);
    expect(response.status).toBe(200);
    expect(edge.to(ME).map((r) => r.status)).toEqual([200, 403, 200]);
    const replacement = (await tab.keystore.load())!;
    expect(replacement.publicKeyB64u).not.toBe(revoked.publicKeyB64u);
    const state = await env.DB.prepare("SELECT status FROM agent_state WHERE agent_key = ?1").bind(toHex(serverDecode(replacement.publicKeyB64u))).first<{ status: string }>();
    expect(state!.status).toBe("active");
  });

  it("resets the identity at most once per call and then returns the rejection", async () => {
    for (const [status, code] of [[401, "AGENT_KEY_UNKNOWN"], [403, "AGENT_KEY_INACTIVE"]] as const) {
      const { signedFetch, edge, resets } = makeClient({ intercept: (path) => (path === ME ? errorResponse(status, code) : undefined) });
      const response = await signedFetch(ME);
      expect(response.status).toBe(status);
      expect(((await response.json()) as { code: string }).code).toBe(code);
      expect(edge.to(ME)).toHaveLength(2);
      expect(resets()).toBe(1);
      expect(edge.to("/api/v1/agents/register")).toHaveLength(2); // original key, then its replacement
    }
  });

  it("combines the two budgets: a skewed clock and an unknown key in one call", async () => {
    const { signedFetch, edge, tab } = makeClient({ skewMs: FIVE_MINUTES });
    const orphan = await createCommunityKey();
    await tab.keystore.save({ ...orphan, registered: true });
    const response = await signedFetch(ME);
    expect(response.status).toBe(200);
    // EXPIRED first (the signature check precedes the key lookup), then UNKNOWN, then success.
    expect(edge.to(ME).map((r) => r.status)).toEqual([401, 401, 200]);
  });

  it("surfaces a registration failure as an error instead of a response", async () => {
    const { signedFetch, edge } = makeClient({ intercept: (path) => (path === "/api/v1/agents/register" ? errorResponse(429, "REGISTRATION_LIMIT") : undefined) });
    await expect(signedFetch(ME)).rejects.toMatchObject({ name: "IdentityError", code: "REGISTRATION_LIMIT" });
    expect(edge.to(ME)).toHaveLength(0);
  });
});
