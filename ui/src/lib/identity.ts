/**
 * Lazy community identity: the first call that needs one provisions it, silently.
 *
 *   keystore has a registered key  -> use it (no network, no lock)
 *   otherwise, inside the "achromat-identity" Web Lock (so two tabs cannot both register):
 *     1. re-check the keystore (another tab may have finished while this one waited)
 *     2. no key yet: generate an Ed25519 key pair (private key non-extractable) and store it, unregistered
 *     3. GET  /api/v1/agents/challenge
 *     4. solve the Hashcash challenge in the worker pool
 *     5. sign the proof-of-possession message
 *     6. POST /api/v1/agents/register   201 or 409 AGENT_KEY_EXISTS -> mark the stored key registered
 *
 * The key is stored BEFORE registering, so a failed attempt (network, rate limit) retries with the same
 * key instead of leaving orphans. If the server later rejects a stored key (AGENT_KEY_UNKNOWN or
 * AGENT_KEY_INACTIVE), the signed client calls resetCommunityIdentity() and provisions a new one once.
 *
 * createIdentityService takes every dependency, so tests run it against fakes and the real Worker.
 * The exported functions at the bottom wire the browser defaults, built on first use, never at import.
 */
import { POW_ALGORITHM, registrationSigningString, utf8 } from "./canonical";
import { serverClock } from "./clock";
import { browserFetch, observeServerClock, readErrorCode, type FetchLike } from "./http";
import { createCommunityKey, createKeystore, type CommunityKeyRecord, type Keystore } from "./keystore";
import type { PowParams } from "./pow";
import { pageRef, withRef } from "./ref";
import { signerFromKey, type Signer } from "./signer";

export { UnsupportedBrowserError, KeystoreError } from "./keystore";

export const IDENTITY_LOCK_NAME = "achromat-identity";

export interface CommunityIdentity {
  /** The Achromat-Agent-Key value. */
  readonly publicKeyB64u: string;
  readonly signer: Signer;
}

/** The slice of navigator.locks the flow uses. */
export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export class IdentityError extends Error {
  /** A server `code` (REGISTRATION_LIMIT, RATE_LIMITED, ...) or NETWORK / UNEXPECTED_RESPONSE. */
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
    this.status = status;
  }
}

export interface IdentityDeps {
  keystore: Keystore;
  fetch: FetchLike;
  /** Solves a Hashcash challenge. The browser default runs the worker pool. */
  solve: (params: PowParams, signal?: AbortSignal) => Promise<{ nonce: string }>;
  /** Web Locks. Null runs without cross-tab serialisation (browsers that lack the API). */
  locks?: LockManagerLike | null;
  /** Key generation. Defaults to createCommunityKey. */
  createKey?: () => Promise<CommunityKeyRecord>;
  /**
   * The marketing ref tag sent as `?ref=` on the challenge and register calls, or "" for none (the default:
   * organic traffic sends no ref). The browser default is the ref in the page URL.
   */
  ref?: () => string;
}

export interface IdentityOptions {
  /** Aborts the challenge, the proof of work and the registration request. */
  signal?: AbortSignal;
}

export interface IdentityService {
  /** The ready identity, provisioning and registering a key first if there is none. */
  getOrRegisterCommunityIdentity(options?: IdentityOptions): Promise<CommunityIdentity>;
  /**
   * Forgets the stored key. Pass the public key the server rejected: if another tab already replaced it,
   * the newer key is kept.
   */
  resetCommunityIdentity(rejectedPublicKeyB64u?: string): Promise<void>;
}

interface Challenge {
  id: string;
  challenge: string;
  signature: string;
  difficultyBits: number;
}

/** Errors a fresh challenge can fix: the first attempt may retry once. */
const RETRY_WITH_NEW_CHALLENGE: ReadonlySet<string> = new Set([
  "CHALLENGE_EXPIRED",
  "CHALLENGE_USED",
  "CHALLENGE_INVALID",
  "INVALID_CHALLENGE",
  "CHALLENGE_WRONG_NETWORK",
  "POW_INVALID",
]);

const REGISTRATION_MESSAGES: Readonly<Record<string, string>> = {
  REGISTRATION_LIMIT: "Too many sessions were created from this network today. Try again tomorrow.",
  RATE_LIMITED: "Too many attempts from this network. Wait a minute and try again.",
  CLIENT_IP_UNAVAILABLE: "The service could not determine your network address.",
  SERVICE_MISCONFIGURED: "The service is temporarily unavailable. Try again later.",
};

function registrationError(status: number, code: string | null): IdentityError {
  const known = code === null ? undefined : REGISTRATION_MESSAGES[code];
  if (known) return new IdentityError(code!, known, status);
  if (status >= 500) return new IdentityError(code ?? "UNAVAILABLE", "The service is temporarily unavailable. Try again later.", status);
  return new IdentityError(code ?? "UNEXPECTED_RESPONSE", `Could not create a session${code ? ` (${code})` : ""}.`, status);
}

function parseChallenge(body: unknown): Challenge | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const bits = b.difficulty_bits;
  if (
    typeof b.challenge_id !== "string" ||
    typeof b.challenge !== "string" ||
    typeof b.challenge_signature !== "string" ||
    b.algorithm !== POW_ALGORITHM ||
    typeof bits !== "number" ||
    !Number.isInteger(bits) ||
    bits < 1 ||
    bits > 40
  ) {
    return null;
  }
  return { id: b.challenge_id, challenge: b.challenge, signature: b.challenge_signature, difficultyBits: bits };
}

export function createIdentityService(deps: IdentityDeps): IdentityService {
  const createKey = deps.createKey ?? (() => createCommunityKey());
  const ref = deps.ref ?? (() => "");
  let cached: CommunityIdentity | null = null;
  let inflight: Promise<CommunityIdentity> | null = null;

  const toIdentity = (record: CommunityKeyRecord): CommunityIdentity => ({
    publicKeyB64u: record.publicKeyB64u,
    signer: signerFromKey(record.privateKey, record.publicKeyB64u),
  });

  const withLock = <T>(task: () => Promise<T>): Promise<T> => (deps.locks ? deps.locks.request(IDENTITY_LOCK_NAME, task) : task());

  async function send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await deps.fetch(path, init);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new IdentityError("NETWORK", "Could not reach the service. Check your connection and try again.");
    }
  }

  async function fetchChallenge(signal?: AbortSignal): Promise<Challenge> {
    const response = await send(withRef("/api/v1/agents/challenge", ref()), { method: "GET", ...(signal ? { signal } : {}) });
    if (response.status !== 200) throw registrationError(response.status, await readErrorCode(response));
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const challenge = parseChallenge(body);
    if (challenge === null) throw new IdentityError("UNEXPECTED_RESPONSE", "The service sent an unexpected challenge.", response.status);
    return challenge;
  }

  async function registerKey(record: CommunityKeyRecord, signal?: AbortSignal): Promise<void> {
    const signer = signerFromKey(record.privateKey, record.publicKeyB64u);
    for (let attempt = 0; ; attempt++) {
      const challenge = await fetchChallenge(signal);
      const solution = await deps.solve(
        { challenge: challenge.challenge, publicKey: record.publicKeyB64u, difficultyBits: challenge.difficultyBits },
        signal,
      );
      const proof = await signer.sign(utf8(registrationSigningString(challenge.challenge, record.publicKeyB64u)));
      const response = await send(withRef("/api/v1/agents/register", ref()), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          public_key: record.publicKeyB64u,
          challenge_id: challenge.id,
          challenge_signature: challenge.signature,
          nonce: solution.nonce,
          proof_signature: proof,
        }),
        ...(signal ? { signal } : {}),
      });

      if (response.status === 201) return;
      const code = await readErrorCode(response);
      if (code === "AGENT_KEY_EXISTS") return; // the server already knows this key
      if (attempt === 0 && code !== null && RETRY_WITH_NEW_CHALLENGE.has(code)) continue;
      throw registrationError(response.status, code);
    }
  }

  async function provision(signal?: AbortSignal): Promise<CommunityIdentity> {
    const stored = await deps.keystore.load();
    if (stored?.registered) return toIdentity(stored);

    return withLock(async () => {
      let record = await deps.keystore.load();
      if (record?.registered) return toIdentity(record); // another tab finished while this one waited
      if (!record) {
        // Throws UnsupportedBrowserError before anything is stored or sent.
        record = await createKey();
        await deps.keystore.save(record);
      }
      await registerKey(record, signal);
      record = { ...record, registered: true };
      await deps.keystore.save(record);
      return toIdentity(record);
    });
  }

  return {
    async getOrRegisterCommunityIdentity(options = {}) {
      if (cached) return cached;
      inflight ??= provision(options.signal)
        .then((identity) => {
          cached = identity;
          return identity;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },

    async resetCommunityIdentity(rejectedPublicKeyB64u) {
      if (cached && (rejectedPublicKeyB64u === undefined || cached.publicKeyB64u === rejectedPublicKeyB64u)) cached = null;
      await withLock(async () => {
        const record = await deps.keystore.load();
        if (record && (rejectedPublicKeyB64u === undefined || record.publicKeyB64u === rejectedPublicKeyB64u)) {
          await deps.keystore.clear();
        }
      });
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// Browser defaults (built on first use)
// ════════════════════════════════════════════════════════════════════════

type BrowserGlobals = {
  navigator?: { locks?: LockManagerLike };
};

let defaultService: IdentityService | undefined;

function defaultIdentity(): IdentityService {
  return (defaultService ??= createIdentityService({
    keystore: createKeystore(),
    fetch: observeServerClock(browserFetch(), serverClock),
    solve: async (params, signal) => {
      // Loaded only when a key actually has to be registered, so returning visitors never fetch the worker.
      const { solvePow } = await import("./powWorkerFactory");
      return solvePow(params, signal ? { signal } : {});
    },
    locks: (globalThis as BrowserGlobals).navigator?.locks ?? null,
    ref: pageRef,
  }));
}

/** The ready community identity for this browser, registering a key on first use. */
export function getOrRegisterCommunityIdentity(options?: IdentityOptions): Promise<CommunityIdentity> {
  return defaultIdentity().getOrRegisterCommunityIdentity(options);
}

/** Drops the stored community key so the next call provisions a new one. */
export function resetCommunityIdentity(rejectedPublicKeyB64u?: string): Promise<void> {
  return defaultIdentity().resetCommunityIdentity(rejectedPublicKeyB64u);
}
