/**
 * The operator's signing session. The key lives in this module's memory and nowhere else: not in React
 * state, not in storage, not in the keystore. Locking, an idle timeout, a rejected key or closing the tab
 * drops it.
 *
 * unlock(pem) turns the pasted PEM into a non-extractable signer (signer.ts), proves the key works by
 * calling GET /api/v1/agents/me with it, and requires the server to report the admin role. Only then is
 * the signer kept. The PEM string itself is never stored by this module; the caller should clear its input.
 *
 * Requests go through the same signed client as the public pages (api.ts), so clock offset and
 * replay retries behave identically. The community-identity hooks of that client are replaced by stubs:
 * an operator key is provisioned out of band and must never be replaced by a generated one.
 */
import { createSignedClient, type SignedClient } from "./api";
import { serverClock, type ServerClock } from "./clock";
import { browserFetch, observeServerClock, readErrorCode, type FetchLike } from "./http";
import type { CommunityIdentity } from "./identity";
import { fingerprint, signerFromPkcs8Pem, type Signer } from "./signer";
import { agentKeyHex } from "./adminApi";

export const DEFAULT_IDLE_MS = 10 * 60 * 1000;

export class AdminLockedError extends Error {
  constructor() {
    super("The console is locked.");
    this.name = "AdminLockedError";
  }
}

export class AdminAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AdminAuthError";
    this.code = code;
  }
}

export interface AdminSessionState {
  status: "locked" | "unlocked";
  /** First and last characters of the public key, for the operator to recognise. */
  fingerprint: string | null;
  /** The key's 64-character server identifier, used to spot lessons this key may not review. */
  agentKeyHex: string | null;
}

const LOCKED: AdminSessionState = { status: "locked", fingerprint: null, agentKeyHex: null };

export interface AdminSessionDeps {
  fetch: FetchLike;
  clock?: ServerClock;
  now?: () => number;
  host?: () => string;
  /** Idle time after which the key is dropped. */
  idleMs?: number;
  timers?: {
    set: (callback: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
}

export interface AdminSession {
  getState(): AdminSessionState;
  subscribe(listener: () => void): () => void;
  /** Throws PemError for an unusable key and AdminAuthError if the server does not accept it as an admin key. */
  unlock(pem: string): Promise<void>;
  lock(): void;
  /** Resets the idle timer. Every signed call does this already. */
  touch(): void;
  /** Signed same-origin request. Throws AdminLockedError while locked. */
  signedFetch(path: string, options?: RequestInit): Promise<Response>;
}

const KEY_REJECTED = new Set(["AGENT_KEY_UNKNOWN", "AGENT_KEY_INACTIVE"]);

export function createAdminSession(deps: AdminSessionDeps): AdminSession {
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const timers = deps.timers ?? {
    set: (callback, ms) => globalThis.setTimeout(callback, ms),
    clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const listeners = new Set<() => void>();
  let state: AdminSessionState = LOCKED;
  let signer: Signer | null = null;
  let idleTimer: unknown = null;

  const setState = (next: AdminSessionState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const identity = {
    // The signed client asks for an identity before every attempt. Only ever the unlocked operator key.
    getOrRegisterCommunityIdentity: async (): Promise<CommunityIdentity> => {
      if (signer === null) throw new AdminLockedError();
      return { publicKeyB64u: signer.publicKeyB64u, signer };
    },
    // A rejected operator key is never replaced: the console locks instead (see signedFetch below).
    resetCommunityIdentity: async (): Promise<void> => undefined,
  };

  const client: SignedClient = createSignedClient({
    identity,
    fetch: deps.fetch,
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.host ? { host: deps.host } : {}),
  });

  function clearTimer() {
    if (idleTimer !== null) timers.clear(idleTimer);
    idleTimer = null;
  }

  function armTimer() {
    clearTimer();
    if (signer !== null) idleTimer = timers.set(() => session.lock(), idleMs);
  }

  const session: AdminSession = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async unlock(pem) {
      const candidate = await signerFromPkcs8Pem(pem);
      // Prove the key and its role before keeping it.
      signer = candidate;
      let response: Response;
      try {
        response = await client.signedFetch("/api/v1/agents/me");
      } catch (error) {
        signer = null;
        throw error;
      }
      if (response.status !== 200) {
        const code = await readErrorCode(response);
        signer = null;
        if (code !== null && KEY_REJECTED.has(code)) {
          throw new AdminAuthError(code, code === "AGENT_KEY_INACTIVE" ? "This key has been revoked." : "This key is not registered with the service.");
        }
        throw new AdminAuthError(code ?? "HTTP_ERROR", "The service did not accept this key.");
      }
      let role: unknown;
      try {
        role = ((await response.json()) as { agent?: { role?: unknown } }).agent?.role;
      } catch {
        role = undefined;
      }
      if (role !== "admin") {
        signer = null;
        throw new AdminAuthError("NOT_AN_ADMIN_KEY", "This key is not an operator key.");
      }
      setState({ status: "unlocked", fingerprint: fingerprint(candidate.publicKeyB64u), agentKeyHex: agentKeyHex(candidate.publicKeyB64u) });
      armTimer();
    },

    lock() {
      clearTimer();
      signer = null;
      if (state !== LOCKED) setState(LOCKED);
    },

    touch() {
      if (signer !== null) armTimer();
    },

    async signedFetch(path, options) {
      if (signer === null) throw new AdminLockedError();
      armTimer();
      const response = await client.signedFetch(path, options);
      if (response.status === 401 || response.status === 403) {
        const code = await readErrorCode(response);
        if (code !== null && (KEY_REJECTED.has(code) || code === "AGENT_ROLE_FORBIDDEN")) session.lock();
      }
      return response;
    },
  };

  return session;
}

// ════════════════════════════════════════════════════════════════════════
// Browser default
// ════════════════════════════════════════════════════════════════════════

let defaultSession: AdminSession | undefined;

/** The one console session for this tab, created on first use. */
export function getAdminSession(): AdminSession {
  return (defaultSession ??= createAdminSession({ fetch: observeServerClock(browserFetch(), serverClock), clock: serverClock }));
}
