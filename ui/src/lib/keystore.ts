/**
 * The community identity key, kept in IndexedDB.
 *
 * The private key is generated NON-EXTRACTABLE and stored as a CryptoKey object (IndexedDB's structured
 * clone supports them), so its bytes never exist in JavaScript: a script on the page could ask the browser
 * to sign, but cannot read or copy the key. The public key is always exportable and is kept as base64url
 * for the Achromat-Agent-Key header.
 *
 * Storage is behind a tiny KeyValueStore interface. The default is idb-keyval (pinned, ~600 bytes); tests
 * pass an in-memory fake, because workerd has no IndexedDB.
 */
import { createStore, del as idbDel, get as idbGet, set as idbSet } from "idb-keyval";
import { encodeBase64url, isCanonicalBase64url } from "./base64url";

/** What is persisted. Never contains key bytes. */
export interface CommunityKeyRecord {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** The raw 32-byte Ed25519 public key as base64url (43 characters): the Achromat-Agent-Key value. */
  publicKeyB64u: string;
  /** True once the server has accepted this key (registered or already known). */
  registered: boolean;
  /** Epoch milliseconds. */
  createdAt: number;
}

export class UnsupportedBrowserError extends Error {
  readonly code = "UNSUPPORTED_BROWSER";

  constructor(message: string) {
    super(message);
    this.name = "UnsupportedBrowserError";
  }
}

export class KeystoreError extends Error {
  readonly code = "KEYSTORE_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "KeystoreError";
  }
}

export const UNSUPPORTED_MESSAGE =
  "This browser cannot create Ed25519 keys with Web Crypto. Use a current version of Chrome, Edge, Firefox or Safari.";

export const INSECURE_CONTEXT_MESSAGE = "Web Crypto is not available. Open this site over HTTPS.";

// ════════════════════════════════════════════════════════════════════════
// Key generation
// ════════════════════════════════════════════════════════════════════════

export type SubtleLike = Pick<SubtleCrypto, "generateKey" | "exportKey">;

function defaultSubtle(): SubtleLike | undefined {
  return (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
}

/**
 * Generates a fresh community key pair: Ed25519, private key non-extractable. Throws UnsupportedBrowserError
 * when Web Crypto or the Ed25519 algorithm is missing (there is deliberately no JavaScript fallback).
 */
export async function createCommunityKey(subtle: SubtleLike | undefined = defaultSubtle(), now: () => number = Date.now): Promise<CommunityKeyRecord> {
  if (!subtle) throw new UnsupportedBrowserError(INSECURE_CONTEXT_MESSAGE);

  let pair: CryptoKeyPair;
  try {
    pair = (await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  } catch {
    throw new UnsupportedBrowserError(UNSUPPORTED_MESSAGE);
  }
  if (!pair?.privateKey || !pair.publicKey) throw new UnsupportedBrowserError(UNSUPPORTED_MESSAGE);
  if (pair.privateKey.extractable) {
    // A browser that ignores `extractable: false` would leave the private key readable. Refuse it.
    throw new UnsupportedBrowserError("This browser did not create a non-extractable key.");
  }

  let raw: ArrayBuffer;
  try {
    raw = (await subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  } catch {
    throw new UnsupportedBrowserError(UNSUPPORTED_MESSAGE);
  }
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyB64u: encodeBase64url(new Uint8Array(raw)),
    registered: false,
    createdAt: now(),
  };
}

// ════════════════════════════════════════════════════════════════════════
// Storage
// ════════════════════════════════════════════════════════════════════════

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

/**
 * idb-keyval over database `achromat-mom`, object store `identity`. The database is opened on first use,
 * not at import, so importing this module is safe where IndexedDB does not exist.
 */
export function createIdbKeyValStore(databaseName = "achromat-mom", storeName = "identity"): KeyValueStore {
  let store: ReturnType<typeof createStore> | undefined;
  const open = () => (store ??= createStore(databaseName, storeName));
  return {
    get: (key) => idbGet(key, open()),
    set: (key, value) => idbSet(key, value, open()),
    del: (key) => idbDel(key, open()),
  };
}

export const IDENTITY_RECORD_KEY = "community-identity";

export interface Keystore {
  /** The stored identity, or null if there is none or the stored value is not a valid record. */
  load(): Promise<CommunityKeyRecord | null>;
  save(record: CommunityKeyRecord): Promise<void>;
  clear(): Promise<void>;
}

/** Structural check of a stored value. The key objects themselves are opaque, so only their kind is checked. */
export function isCommunityKeyRecord(value: unknown): value is CommunityKeyRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<Record<keyof CommunityKeyRecord, unknown>>;
  const privateKey = record.privateKey as Partial<CryptoKey> | undefined;
  const publicKey = record.publicKey as Partial<CryptoKey> | undefined;
  return (
    privateKey?.type === "private" &&
    privateKey.extractable === false &&
    publicKey?.type === "public" &&
    typeof record.publicKeyB64u === "string" &&
    isCanonicalBase64url(record.publicKeyB64u, 32) &&
    typeof record.registered === "boolean" &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt)
  );
}

export function createKeystore(store: KeyValueStore = createIdbKeyValStore()): Keystore {
  const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch {
      throw new KeystoreError("Browser storage is unavailable, so the session key cannot be kept.");
    }
  };

  return {
    async load() {
      const value = await guard(() => store.get(IDENTITY_RECORD_KEY));
      if (value === undefined || value === null) return null;
      if (isCommunityKeyRecord(value)) return value;
      // Something else (an older shape, a tampered or extractable key) is not trusted: drop it.
      await guard(() => store.del(IDENTITY_RECORD_KEY));
      return null;
    },
    save: (record) => guard(() => store.set(IDENTITY_RECORD_KEY, record)),
    clear: () => guard(() => store.del(IDENTITY_RECORD_KEY)),
  };
}
