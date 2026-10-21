/**
 * Browser identity (ui/src/lib: keystore, signer, identity). Key generation and signing use the real Web
 * Crypto of workerd; registration runs against the real Worker (src/index.ts, D1, Durable Objects);
 * IndexedDB and Web Locks are replaced by the doubles in fixtures/ui-env.ts.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { verifyEd25519 } from "../src/schema";
import { decodeBase64url, isCanonicalBase64url } from "../ui/src/lib/base64url";
import { requestSigningString, utf8 } from "../ui/src/lib/canonical";
import {
  IDENTITY_LOCK_NAME,
  IdentityError,
  createIdentityService,
  type LockManagerLike,
} from "../ui/src/lib/identity";
import {
  IDENTITY_RECORD_KEY,
  KeystoreError,
  UnsupportedBrowserError,
  createCommunityKey,
  createKeystore,
  isCommunityKeyRecord,
  type SubtleLike,
} from "../ui/src/lib/keystore";
import { PemError } from "../ui/src/lib/pem";
import { ED25519_PKCS8_PREFIX } from "../ui/src/lib/pem";
import { fingerprint, sign, signerFromKey, signerFromPkcs8Pem } from "../ui/src/lib/signer";
import { toHex } from "../src/schema";
import { MemoryStore, errorResponse, makeIdentity, makeSolver, workerEdge } from "./fixtures/ui-env";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const PUBLIC_KEY = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"; // public key of SEED (SKILL.md section 8)
const REQUEST_SIGNATURE = "mPAMbWJ24bSAseFFTHQL0zo7UcmAb50J9LjFPHU8jxXuweWXE9J9pdzuOQqHMp4801FXi3SSLKHKRRzmB0t9BA";
const REQUEST_STRING_INPUT = {
  host: "mom.achromat.ai",
  method: "POST",
  pathAndQuery: "/api/v1/recall",
  bodySha256Hex: "91f119d8da6881e815ac07761bfc9b89a3d0289af5dceb724b42926a455bbf88",
  timestamp: "1790000000",
  nonce: "AAECAwQFBgcICQoLDA0ODw",
};

function pemOf(seed: Uint8Array, label = "PRIVATE KEY"): string {
  const der = new Uint8Array([...ED25519_PKCS8_PREFIX, ...seed]);
  const body = btoa(String.fromCharCode(...der));
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

async function accountOf(publicKeyB64u: string) {
  return env.DB.prepare("SELECT s.role, s.status FROM agent_state s WHERE s.agent_key = ?1")
    .bind(toHex(decodeBase64url(publicKeyB64u)))
    .first<{ role: string; status: string }>();
}

// ════════════════════════════════════════════════════════════════════════
// Key generation
// ════════════════════════════════════════════════════════════════════════

describe("createCommunityKey", () => {
  it("makes an Ed25519 pair whose private key can sign but never be exported", async () => {
    const record = await createCommunityKey(undefined, () => 1_790_000_000_000);
    expect(record.privateKey.type).toBe("private");
    expect(record.privateKey.extractable).toBe(false);
    expect(record.privateKey.algorithm).toMatchObject({ name: "Ed25519" });
    expect([...record.privateKey.usages]).toEqual(["sign"]);
    expect(record.publicKey.type).toBe("public");
    expect(record.registered).toBe(false);
    expect(record.createdAt).toBe(1_790_000_000_000);

    expect(isCanonicalBase64url(record.publicKeyB64u, 32)).toBe(true);
    expect(record.publicKeyB64u).toHaveLength(43);
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", record.publicKey)) as ArrayBuffer);
    expect(Array.from(decodeBase64url(record.publicKeyB64u))).toEqual(Array.from(raw));

    await expect(crypto.subtle.exportKey("pkcs8", record.privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("jwk", record.privateKey)).rejects.toThrow();

    const signature = await sign(record.privateKey, utf8("hello"));
    expect(signature).toHaveLength(86);
    expect(await verifyEd25519(record.publicKeyB64u, signature, "hello")).toBe(true);
    expect(isCommunityKeyRecord(record)).toBe(true);
  });

  it("asks Web Crypto for exactly: Ed25519, extractable false, sign and verify", async () => {
    const calls: unknown[][] = [];
    const real = crypto.subtle;
    const spy: SubtleLike = {
      generateKey: ((...args: unknown[]) => {
        calls.push(args);
        return (real.generateKey as (...a: unknown[]) => Promise<CryptoKeyPair>)(...args);
      }) as SubtleCrypto["generateKey"],
      exportKey: real.exportKey.bind(real) as SubtleCrypto["exportKey"],
    };
    await createCommunityKey(spy);
    expect(calls).toEqual([[{ name: "Ed25519" }, false, ["sign", "verify"]]]);
  });

  it("generates a different key every time", async () => {
    const a = await createCommunityKey();
    const b = await createCommunityKey();
    expect(a.publicKeyB64u).not.toBe(b.publicKeyB64u);
  });

  it("fails with a clear UnsupportedBrowserError when Web Crypto or Ed25519 is missing", async () => {
    const missing = await createCommunityKey({ ...crypto.subtle, generateKey: async () => { throw new DOMException("Unrecognized name.", "NotSupportedError"); }, exportKey: async () => new ArrayBuffer(0) } as unknown as SubtleLike).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(UnsupportedBrowserError);
    expect((missing as UnsupportedBrowserError).code).toBe("UNSUPPORTED_BROWSER");
    expect((missing as Error).message).toMatch(/Ed25519.*Chrome, Edge, Firefox or Safari/);

    // No crypto.subtle at all (an insecure context): says to use HTTPS.
    const insecure = await createCommunityKey(null as unknown as SubtleLike).catch((e: unknown) => e);
    expect(insecure).toBeInstanceOf(UnsupportedBrowserError);
    expect((insecure as Error).message).toMatch(/HTTPS/);
  });

  it("refuses a browser that hands back an extractable private key", async () => {
    const real = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const leaky: SubtleLike = {
      generateKey: (async () => real) as unknown as SubtleCrypto["generateKey"],
      exportKey: crypto.subtle.exportKey.bind(crypto.subtle) as SubtleCrypto["exportKey"],
    };
    await expect(createCommunityKey(leaky)).rejects.toThrow(UnsupportedBrowserError);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Keystore
// ════════════════════════════════════════════════════════════════════════

describe("keystore", () => {
  it("saves and loads the record, and clears it", async () => {
    const store = new MemoryStore();
    const keystore = createKeystore(store);
    expect(await keystore.load()).toBeNull();

    const record = await createCommunityKey();
    await keystore.save(record);
    expect(store.map.has(IDENTITY_RECORD_KEY)).toBe(true);
    const loaded = (await keystore.load())!;
    expect(Object.keys(loaded).sort()).toEqual(["createdAt", "privateKey", "publicKey", "publicKeyB64u", "registered"]);
    expect(loaded.publicKeyB64u).toBe(record.publicKeyB64u);
    expect(loaded.registered).toBe(false);

    await keystore.save({ ...record, registered: true });
    expect((await keystore.load())!.registered).toBe(true);

    await keystore.clear();
    expect(await keystore.load()).toBeNull();
  });

  it("stores key objects, never key bytes or text", async () => {
    const store = new MemoryStore();
    const keystore = createKeystore(store);
    await keystore.save(await createCommunityKey());
    const stored = store.map.get(IDENTITY_RECORD_KEY) as Record<string, unknown>;
    expect(stored.privateKey).toBeInstanceOf(CryptoKey);
    expect(stored.publicKey).toBeInstanceOf(CryptoKey);
    expect(Object.values(stored).filter((value) => value instanceof Uint8Array || value instanceof ArrayBuffer)).toEqual([]);
  });

  it("drops a stored value that is not a valid record, including one with an extractable private key", async () => {
    const store = new MemoryStore();
    const keystore = createKeystore(store);
    const good = await createCommunityKey();
    const extractable = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;

    const bad: unknown[] = [
      "nonsense",
      42,
      {},
      { ...good, publicKeyB64u: "short" },
      { ...good, registered: "yes" },
      { ...good, createdAt: Number.NaN },
      { ...good, privateKey: good.publicKey },
      { ...good, privateKey: extractable.privateKey },
    ];
    for (const value of bad) {
      store.map.set(IDENTITY_RECORD_KEY, value);
      expect(await keystore.load(), JSON.stringify(value)?.slice(0, 40)).toBeNull();
      expect(store.map.has(IDENTITY_RECORD_KEY)).toBe(false);
    }
  });

  it("reports unavailable storage as a KeystoreError", async () => {
    const store = new MemoryStore();
    store.failWith = new Error("QuotaExceededError");
    const keystore = createKeystore(store);
    await expect(keystore.load()).rejects.toThrow(KeystoreError);
    await expect(keystore.save(await createCommunityKey())).rejects.toThrow(KeystoreError);
    await expect(keystore.clear()).rejects.toThrow(KeystoreError);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Signer
// ════════════════════════════════════════════════════════════════════════

describe("signer", () => {
  it("signs for a keystore key and the server verifies it", async () => {
    const record = await createCommunityKey();
    const signer = signerFromKey(record.privateKey, record.publicKeyB64u);
    expect(signer.publicKeyB64u).toBe(record.publicKeyB64u);
    const signature = await signer.sign(utf8("message"));
    expect(isCanonicalBase64url(signature, 64)).toBe(true);
    expect(await verifyEd25519(record.publicKeyB64u, signature, "message")).toBe(true);
    expect(await verifyEd25519(record.publicKeyB64u, signature, "other")).toBe(false);
  });

  it("rejects a public key as the signing key and a malformed public key string", async () => {
    const record = await createCommunityKey();
    expect(() => signerFromKey(record.publicKey, record.publicKeyB64u)).toThrow(TypeError);
    expect(() => signerFromKey(record.privateKey, "short")).toThrow(TypeError);
  });

  it("builds a memory-only signer from an Ed25519 PKCS#8 PEM, with the skill.md public key and signature", async () => {
    const signer = await signerFromPkcs8Pem(pemOf(SEED));
    expect(signer.publicKeyB64u).toBe(PUBLIC_KEY);
    expect(await signer.sign(utf8(requestSigningString(REQUEST_STRING_INPUT)))).toBe(REQUEST_SIGNATURE);
    // The signer exposes no key material.
    expect(Object.keys(signer).sort()).toEqual(["publicKeyB64u", "sign"]);
  });

  it("explains why a PEM cannot be used", async () => {
    for (const [pem, message] of [
      [pemOf(SEED, "ENCRYPTED PRIVATE KEY"), /encrypted/],
      [pemOf(SEED, "OPENSSH PRIVATE KEY"), /OpenSSH/],
      ["", /No key provided/],
      [pemOf(SEED.slice(0, 31)), /not an Ed25519/],
    ] as const) {
      await expect(signerFromPkcs8Pem(pem)).rejects.toThrow(PemError);
      await expect(signerFromPkcs8Pem(pem)).rejects.toThrow(message);
    }
  });

  it("shortens a public key to a display fingerprint", () => {
    expect(fingerprint(PUBLIC_KEY)).toBe("A6EHv_…BJVMbg");
    expect(() => fingerprint("nope")).toThrow(TypeError);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Lazy registration, against the real Worker
// ════════════════════════════════════════════════════════════════════════

describe("getOrRegisterCommunityIdentity", () => {
  it("generates, stores, solves, registers and marks the key registered, on first use", async () => {
    const tab = makeIdentity();
    expect(tab.store.map.size).toBe(0); // nothing happens until an identity is needed

    const identity = await tab.service.getOrRegisterCommunityIdentity();
    expect(isCanonicalBase64url(identity.publicKeyB64u, 32)).toBe(true);

    // Exactly: GET challenge, POST register.
    expect(tab.edge.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/v1/agents/challenge", "POST /api/v1/agents/register"]);
    expect(tab.edge.requests.map((r) => r.status)).toEqual([200, 201]);
    expect(tab.solver.calls).toHaveLength(1);
    expect(tab.solver.calls[0]).toMatchObject({ publicKey: identity.publicKeyB64u, difficultyBits: 16 });
    expect(tab.created).toHaveLength(1);

    const stored = (await tab.keystore.load())!;
    expect(stored.registered).toBe(true);
    expect(stored.publicKeyB64u).toBe(identity.publicKeyB64u);
    expect(stored.privateKey.extractable).toBe(false);

    // The server created an active community identity for exactly this key.
    expect(await accountOf(identity.publicKeyB64u)).toEqual({ role: "community", status: "active" });

    // The identity can sign requests the server accepts.
    const signature = await identity.signer.sign(utf8("x"));
    expect(await verifyEd25519(identity.publicKeyB64u, signature, "x")).toBe(true);
  });

  it("is free afterwards: the same tab, and a later tab, use the stored key without any request", async () => {
    const first = makeIdentity();
    const identity = await first.service.getOrRegisterCommunityIdentity();
    const requestsAfterFirst = first.edge.requests.length;

    expect(await first.service.getOrRegisterCommunityIdentity()).toBe(identity);
    expect(first.edge.requests).toHaveLength(requestsAfterFirst);

    const reopened = makeIdentity({ store: first.store });
    const again = await reopened.service.getOrRegisterCommunityIdentity();
    expect(again.publicKeyB64u).toBe(identity.publicKeyB64u);
    expect(reopened.edge.requests).toHaveLength(0);
    expect(reopened.created).toHaveLength(0);
    expect(reopened.locks.requested).toEqual([]); // the fast path does not even take the lock
  });

  it("registers an interrupted key (stored, not yet registered) instead of generating a new one", async () => {
    const tab = makeIdentity();
    const record = await createCommunityKey();
    await tab.keystore.save(record);

    const identity = await tab.service.getOrRegisterCommunityIdentity();
    expect(identity.publicKeyB64u).toBe(record.publicKeyB64u);
    expect(tab.created).toHaveLength(0);
    expect((await tab.keystore.load())!.registered).toBe(true);
    expect(await accountOf(record.publicKeyB64u)).toEqual({ role: "community", status: "active" });
  });

  it("treats 409 AGENT_KEY_EXISTS as success and marks the key registered", async () => {
    const first = makeIdentity();
    const identity = await first.service.getOrRegisterCommunityIdentity();
    // Registered on the server, but this browser lost the flag (a crash between POST and save).
    await first.keystore.save({ ...(await first.keystore.load())!, registered: false });

    const second = makeIdentity({ store: first.store });
    const again = await second.service.getOrRegisterCommunityIdentity();
    expect(again.publicKeyB64u).toBe(identity.publicKeyB64u);
    expect(second.edge.requests.map((r) => r.status)).toEqual([200, 409]);
    expect((await second.keystore.load())!.registered).toBe(true);
    expect(second.created).toHaveLength(0);
  });

  it("serialises two tabs behind the achromat-identity lock: one key, one registration", async () => {
    const tabA = makeIdentity();
    const tabB = makeIdentity({ store: tabA.store, locks: tabA.locks, edge: tabA.edge, solver: tabA.solver });

    const [a, b] = await Promise.all([tabA.service.getOrRegisterCommunityIdentity(), tabB.service.getOrRegisterCommunityIdentity()]);

    expect(a.publicKeyB64u).toBe(b.publicKeyB64u);
    expect(tabA.created.length + tabB.created.length).toBe(1);
    expect(tabA.edge.to("/api/v1/agents/register")).toHaveLength(1);
    expect(tabA.edge.to("/api/v1/agents/challenge")).toHaveLength(1);
    expect(tabA.locks.requested).toEqual([IDENTITY_LOCK_NAME, IDENTITY_LOCK_NAME]);
    expect(tabA.locks.maxActive).toBe(1);
  });

  it("shares one provisioning between concurrent callers in the same tab", async () => {
    const tab = makeIdentity();
    const identities = await Promise.all(Array.from({ length: 6 }, () => tab.service.getOrRegisterCommunityIdentity()));
    expect(new Set(identities.map((i) => i.publicKeyB64u)).size).toBe(1);
    expect(tab.created).toHaveLength(1);
    expect(tab.locks.requested).toHaveLength(1);
    expect(tab.edge.to("/api/v1/agents/register")).toHaveLength(1);
  });

  it("still works in a browser without Web Locks", async () => {
    const harness = makeIdentity();
    const bare = createIdentityService({
      keystore: harness.keystore,
      fetch: harness.edge.fetch,
      solve: harness.solver.solve,
      locks: null,
    });
    const identity = await bare.getOrRegisterCommunityIdentity();
    expect((await harness.keystore.load())!.publicKeyB64u).toBe(identity.publicKeyB64u);
  });

  it("does nothing and stores nothing when the browser lacks Ed25519", async () => {
    const edge = workerEdge();
    const store = new MemoryStore();
    const service = createIdentityService({
      keystore: createKeystore(store),
      fetch: edge.fetch,
      solve: makeSolver().solve,
      createKey: () => createCommunityKey({ generateKey: async () => { throw new Error("nope"); }, exportKey: async () => new ArrayBuffer(0) } as unknown as SubtleLike),
    });
    await expect(service.getOrRegisterCommunityIdentity()).rejects.toThrow(UnsupportedBrowserError);
    expect(edge.requests).toHaveLength(0);
    expect(store.map.size).toBe(0);
  });

  it("never asks the browser for persistent storage (it can raise a permission prompt in Firefox)", async () => {
    const persist = { calls: 0 };
    const storage = { persist: async () => { persist.calls++; return true; }, persisted: async () => false };
    const navigatorObject = (globalThis as { navigator?: object }).navigator;
    const hadStorage = navigatorObject !== undefined && "storage" in navigatorObject;
    let installed = false;
    try {
      if (navigatorObject) {
        Object.defineProperty(navigatorObject, "storage", { value: storage, configurable: true });
        installed = true;
      }
    } catch {
      // A sealed navigator object: the source scan in scripts/check-ui-source.mjs covers this case.
    }
    try {
      const tab = makeIdentity();
      await tab.service.getOrRegisterCommunityIdentity();
      expect(persist.calls).toBe(0);
    } finally {
      if (installed && !hadStorage) delete (navigatorObject as { storage?: unknown }).storage;
    }
  });

  it("retries a stale challenge once with a fresh one, and no more", async () => {
    // First registration attempt is told the challenge expired; the second goes to the real Worker.
    let registerCalls = 0;
    const edge = workerEdge({
      intercept: (path) => (path === "/api/v1/agents/register" && ++registerCalls === 1 ? errorResponse(400, "CHALLENGE_EXPIRED") : undefined),
    });
    const tab = makeIdentity({ edge });
    await tab.service.getOrRegisterCommunityIdentity();
    expect(edge.to("/api/v1/agents/challenge")).toHaveLength(2);
    expect(edge.to("/api/v1/agents/register").map((r) => r.status)).toEqual([400, 201]);
    expect(tab.solver.calls).toHaveLength(2);

    const stubborn = workerEdge({ intercept: (path) => (path === "/api/v1/agents/register" ? errorResponse(400, "CHALLENGE_EXPIRED") : undefined) });
    const other = makeIdentity({ edge: stubborn });
    await expect(other.service.getOrRegisterCommunityIdentity()).rejects.toThrow(IdentityError);
    expect(stubborn.to("/api/v1/agents/challenge")).toHaveLength(2);
    expect((await other.keystore.load())!.registered).toBe(false); // kept, to be retried later
  });

  it("maps server refusals to clear errors and keeps the unregistered key for a later retry", async () => {
    const cases: Array<[number, string, RegExp]> = [
      [429, "REGISTRATION_LIMIT", /Too many sessions.*tomorrow/],
      [429, "RATE_LIMITED", /Wait a minute/],
      [400, "CLIENT_IP_UNAVAILABLE", /network address/],
      [503, "SERVICE_MISCONFIGURED", /temporarily unavailable/],
      [500, "BOOM", /temporarily unavailable/],
      [418, "TEAPOT", /Could not create a session \(TEAPOT\)/],
    ];
    for (const [status, code, message] of cases) {
      const edge = workerEdge({ intercept: (path) => (path === "/api/v1/agents/register" ? errorResponse(status, code) : undefined) });
      const tab = makeIdentity({ edge });
      const error = await tab.service.getOrRegisterCommunityIdentity().catch((e: unknown) => e);
      expect(error, code).toBeInstanceOf(IdentityError);
      expect((error as IdentityError).code).toBe(code);
      expect((error as IdentityError).status).toBe(status);
      expect((error as Error).message).toMatch(message);
      expect((await tab.keystore.load())!.registered).toBe(false);
      // A retry later (the next signed call) reuses the same key.
      expect(tab.created).toHaveLength(1);
    }
  });

  it("reports an unreachable service, and a malformed challenge", async () => {
    const down = makeIdentity({ fetch: async () => { throw new TypeError("Failed to fetch"); } });
    const unreachable = await down.service.getOrRegisterCommunityIdentity().catch((e: unknown) => e);
    expect((unreachable as IdentityError).code).toBe("NETWORK");

    const odd = makeIdentity({ fetch: async () => new Response(JSON.stringify({ challenge_id: 1 }), { status: 200 }) });
    const malformed = await odd.service.getOrRegisterCommunityIdentity().catch((e: unknown) => e);
    expect((malformed as IdentityError).code).toBe("UNEXPECTED_RESPONSE");

    const wrongAlgorithm = makeIdentity({
      fetch: async () =>
        new Response(JSON.stringify({ challenge_id: "x", challenge: "y", challenge_signature: "z", algorithm: "argon2id-v1", difficulty_bits: 16 }), { status: 200 }),
    });
    expect(((await wrongAlgorithm.service.getOrRegisterCommunityIdentity().catch((e: unknown) => e)) as IdentityError).code).toBe("UNEXPECTED_RESPONSE");
  });

  it("passes an abort through to the solver and leaves the key for later", async () => {
    const controller = new AbortController();
    const tab = makeIdentity();
    const service = createIdentityService({
      keystore: tab.keystore,
      fetch: tab.edge.fetch,
      locks: tab.locks,
      solve: (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          controller.abort();
        }),
    });
    await expect(service.getOrRegisterCommunityIdentity({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(tab.edge.to("/api/v1/agents/register")).toHaveLength(0);
    expect((await tab.keystore.load())!.registered).toBe(false);
  });
});

describe("resetCommunityIdentity", () => {
  it("forgets the key so the next call provisions and registers a new one", async () => {
    const tab = makeIdentity();
    const first = await tab.service.getOrRegisterCommunityIdentity();
    await tab.service.resetCommunityIdentity(first.publicKeyB64u);
    expect(await tab.keystore.load()).toBeNull();

    const second = await tab.service.getOrRegisterCommunityIdentity();
    expect(second.publicKeyB64u).not.toBe(first.publicKeyB64u);
    expect(tab.created).toHaveLength(2);
    expect(await accountOf(second.publicKeyB64u)).toEqual({ role: "community", status: "active" });
  });

  it("keeps a newer key that another tab already stored in place of the rejected one", async () => {
    const tab = makeIdentity();
    const rejected = await tab.service.getOrRegisterCommunityIdentity();
    const replacement = await createCommunityKey();
    await tab.keystore.save({ ...replacement, registered: true });

    await tab.service.resetCommunityIdentity(rejected.publicKeyB64u);
    expect((await tab.keystore.load())!.publicKeyB64u).toBe(replacement.publicKeyB64u);
    // This tab's cache was dropped, so it now picks up the newer key without registering anything.
    const requestsBefore = tab.edge.requests.length;
    expect((await tab.service.getOrRegisterCommunityIdentity()).publicKeyB64u).toBe(replacement.publicKeyB64u);
    expect(tab.edge.requests).toHaveLength(requestsBefore);
  });

  it("clears unconditionally when no key is named", async () => {
    const tab = makeIdentity();
    await tab.service.getOrRegisterCommunityIdentity();
    await tab.service.resetCommunityIdentity();
    expect(await tab.keystore.load()).toBeNull();
  });
});

describe("lock manager contract", () => {
  it("is satisfied by a plain object with request()", async () => {
    const calls: string[] = [];
    const locks: LockManagerLike = {
      request: async (name, callback) => {
        calls.push(name);
        return callback();
      },
    };
    const harness = makeIdentity();
    const service = createIdentityService({ keystore: harness.keystore, fetch: harness.edge.fetch, solve: harness.solver.solve, locks });
    await service.getOrRegisterCommunityIdentity();
    expect(calls).toEqual(["achromat-identity"]);
  });
});
