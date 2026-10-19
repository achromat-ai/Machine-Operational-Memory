/**
 * HMAC signatures on Hashcash challenges (POW_CHALLENGE_HMAC_KEY).
 *
 * GET /api/v1/agents/challenge returns `challenge_signature`, an HMAC-SHA256 over every server-chosen
 * field of the challenge, including the difficulty and the network it was issued to:
 *
 *   achromat-pow-challenge-v1\n{challenge_id}\n{challenge}\n{algorithm}\n{difficulty_bits}\n{ip_prefix_hmac}\n{expires_at_ms}
 *
 * POST /api/v1/agents/register must echo it back, and the Worker re-computes and verifies it against the
 * stored challenge row BEFORE it spends any effort on the proof of work. A challenge whose stored fields
 * were altered (an easier difficulty, a longer lifetime, another network) or that was never issued by this
 * Worker therefore cannot be redeemed, even if its row exists in D1. Verification is constant-time
 * (crypto.subtle.verify). Like IP_HMAC_KEY, a missing or short key fails closed.
 */
import { decodeBase64url, encodeBase64url } from "../schema";

export const POW_CHALLENGE_SIGNING_CONTEXT = "achromat-pow-challenge-v1";

/** Shortest accepted POW_CHALLENGE_HMAC_KEY (32 characters of base64 ≈ 192 bits). */
const MIN_SECRET_LENGTH = 32;

export interface SignedChallengeFields {
  challengeId: string;
  challenge: string;
  algorithm: string;
  difficultyBits: number;
  ipPrefixHmac: string;
  expiresAtMs: number;
}

export function challengeSigningString(fields: SignedChallengeFields): string {
  return [
    POW_CHALLENGE_SIGNING_CONTEXT,
    fields.challengeId,
    fields.challenge,
    fields.algorithm,
    String(fields.difficultyBits),
    fields.ipPrefixHmac,
    String(fields.expiresAtMs),
  ].join("\n");
}

/** True when the secret is present and long enough to use. */
export function powChallengeKeyConfigured(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  if (!powChallengeKeyConfigured(secret)) throw new Error("POW_CHALLENGE_HMAC_KEY is not configured");
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keyCache.set(secret, key);
  }
  return key;
}

/** 43-character base64url HMAC-SHA256 of the challenge. Throws if POW_CHALLENGE_HMAC_KEY is missing or short. */
export async function signChallenge(secret: string | undefined, fields: SignedChallengeFields): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret as string), new TextEncoder().encode(challengeSigningString(fields)));
  return encodeBase64url(new Uint8Array(mac));
}

/** Constant-time check of a submitted signature. Returns false for any malformed or wrong signature. */
export async function verifyChallengeSignature(
  secret: string | undefined,
  fields: SignedChallengeFields,
  signature: string,
): Promise<boolean> {
  const key = await hmacKey(secret as string);
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64url(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(challengeSigningString(fields)));
}
