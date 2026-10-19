/**
 * MOM-side signatures and tokens for bound pairs.
 *
 *   pair attestation  Ed25519 (MOM_ATTESTATION_PRIVATE_KEY, kid mom_pk_v1) over
 *                     achromat-pair-v1\n{block id}\n{allow id}\n{domain}\n{tool}\n{fingerprint}\n{delta_hash}
 *                     → 86-character base64url, stored in lessons.pair_attestation.
 *   visibility token  'k:' + base64url(HMAC-SHA256(VISIBILITY_KEY, agent_key)) → 45 characters.
 *                     The submitter-only Vectorize filter value. VISIBILITY_KEY is permanent:
 *                     tokens carry no version and lessons.submitter_visibility is insert-only.
 *
 * Both secrets fail closed: a missing or malformed value throws.
 */
import { encodeBase64url } from "../schema";

export const MOM_ATTESTATION_KID = "mom_pk_v1";
export const PAIR_ATTESTATION_CONTEXT = "achromat-pair-v1";

/** Published verification keys (raw Ed25519, hex). Public by design; served later for offline export checks. */
export const MOM_ATTESTATION_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  mom_pk_v1: "78068fe17215e5765e43ccf222d4d4f2eb899d4c02e775b3c9b91cfc9ef3579b",
});

const encoder = new TextEncoder();
const signingKeys = new Map<string, Promise<CryptoKey>>();
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Accepts a PKCS#8 PEM (real or "\n"-escaped newlines) or bare base64 DER. */
export function pkcs8FromSecret(secret: string): Uint8Array {
  const body = secret
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error("MOM_ATTESTATION_PRIVATE_KEY is not PKCS#8 PEM or base64");
  return base64ToBytes(body);
}

function attestationKey(secret: string | undefined): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.trim() === "") {
    return Promise.reject(new Error("MOM_ATTESTATION_PRIVATE_KEY is not configured"));
  }
  let key = signingKeys.get(secret);
  if (!key) {
    key = (async () => crypto.subtle.importKey("pkcs8", pkcs8FromSecret(secret), { name: "Ed25519" }, false, ["sign"]))();
    // A failed import is not cached, so a fixed secret takes effect without a restart.
    key.catch(() => signingKeys.delete(secret));
    signingKeys.set(secret, key);
  }
  return key;
}

function visibilityKey(secret: string | undefined): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.trim() === "") {
    return Promise.reject(new Error("VISIBILITY_KEY is not configured"));
  }
  let key = hmacKeys.get(secret);
  if (!key) {
    key = (async () => {
      const raw = base64ToBytes(secret.trim());
      if (raw.byteLength !== 32) throw new Error("VISIBILITY_KEY must be base64 of 32 bytes");
      return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })();
    key.catch(() => hmacKeys.delete(secret));
    hmacKeys.set(secret, key);
  }
  return key;
}

/** Resolves when both secrets import. Used to fail closed before any upstream quota is spent. */
export async function assertPairingSecrets(attestationSecret: string | undefined, visibilitySecret: string | undefined): Promise<void> {
  await Promise.all([attestationKey(attestationSecret), visibilityKey(visibilitySecret)]);
}

export interface PairFields {
  blockReceiptId: string;
  allowReceiptId: string;
  domain: string;
  tool: string;
  taskFingerprint: string;
  deltaHash: string;
}

export function pairAttestationMessage(fields: PairFields): string {
  return [
    PAIR_ATTESTATION_CONTEXT,
    fields.blockReceiptId,
    fields.allowReceiptId,
    fields.domain,
    fields.tool,
    fields.taskFingerprint,
    fields.deltaHash,
  ].join("\n");
}

/** 86-character unpadded base64url Ed25519 signature over pairAttestationMessage(fields). */
export async function signPairAttestation(secret: string | undefined, fields: PairFields): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    await attestationKey(secret),
    encoder.encode(pairAttestationMessage(fields)),
  );
  return encodeBase64url(new Uint8Array(signature));
}

/** 'k:' + base64url(HMAC-SHA256(VISIBILITY_KEY, agent_key)), 45 characters. */
export async function visibilityToken(secret: string | undefined, agentKey: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await visibilityKey(secret), encoder.encode(agentKey));
  return `k:${encodeBase64url(new Uint8Array(mac))}`;
}

/**
 * Pseudonymous caller id for the demand radar (domain_demand.agent_key_hmac), 43 characters.
 * Domain-separated from the visibility token, so the two values cannot be linked to each other.
 */
export async function demandHmac(secret: string | undefined, agentKey: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await visibilityKey(secret), encoder.encode(`achromat-demand-v1\n${agentKey}`));
  return encodeBase64url(new Uint8Array(mac));
}
