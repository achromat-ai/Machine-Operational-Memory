/**
 * Schema V5 receipt verification: the only receipt verifier in MOM.
 *
 * A receipt is trusted only if
 *   1. its Ed25519 signature over the exact canonical_payload bytes verifies
 *      against the pinned key for its kid (src/crypto/ramen-key.ts; only tests
 *      pass other keys, through createApp options),
 *   2. the signed payload parses as the ten V5 keys and agrees with the
 *      unsigned envelope (id, kid, verdict, statutory_anchors),
 *   3. signed payload_hash == SHA-256(the input MOM sent upstream) (binding),
 *   4. the signed verdict is the one the caller expects, and
 *   5. the signed timestamp is within RECEIPT_MAX_SKEW_MS of now.
 * Everything downstream reads the signed fields, never the envelope.
 * verifyRamenReceipt never throws, and its reasons never quote input.
 */
import { RAMEN_RECEIPT_KEYS } from "./ramen-key";
import { RamenReceipt, SignedPayloadV5, decodeBase64url, hexToBytes, sha256Hex } from "../schema";

/** Signed canonical payloads above this size are rejected (matches the D1 CHECK). */
export const MAX_CANONICAL_PAYLOAD_BYTES = 16 * 1024;
/** A receipt MOM just requested must be signed within this distance of the Worker clock. */
export const RECEIPT_MAX_SKEW_MS = 5 * 60 * 1000;

export interface VerifiedReceipt {
  /** Signed id, verbatim (the D1 CHECK compares it to the stored column). */
  id: string;
  /** Unsigned envelope signature string, verbatim. */
  signature: string;
  /** The exact signed bytes. */
  canonicalPayload: string;
  signed: SignedPayloadV5;
  /** The envelope as received, for the attempt log. */
  envelope: Record<string, unknown>;
}

export interface ReceiptCheck {
  /** Signature verifies and the signed fields are well formed and consistent. */
  verified: boolean;
  /** verified, and payload_hash binds the receipt to the evaluated input. */
  bound: boolean;
  /** bound, with the expected verdict and a fresh timestamp: safe to ingest. */
  ok: boolean;
  reason: string | null;
  receipt: VerifiedReceipt | null;
}

export interface VerifyOptions {
  /** Trusted keys by kid (raw Ed25519 hex). Default: the pinned production keys. */
  keys?: Readonly<Record<string, string>>;
  nowMs?: number;
}

const encoder = new TextEncoder();
/** Imported keys, cached per isolate by their hex value. */
const keyCache = new Map<string, Promise<CryptoKey>>();

function receiptKey(keys: Readonly<Record<string, string>>, kid: string): Promise<CryptoKey> | null {
  if (!Object.hasOwn(keys, kid)) return null;
  const hex = keys[kid]!;
  let key = keyCache.get(hex);
  if (!key) {
    key = crypto.subtle.importKey("raw", hexToBytes(hex), { name: "Ed25519" }, false, ["verify"]);
    keyCache.set(hex, key);
  }
  return key;
}

function fail(reason: string, verified = false, receipt: VerifiedReceipt | null = null): ReceiptCheck {
  return { verified, bound: false, ok: false, reason, receipt };
}

export async function verifyRamenReceipt(
  receipt: unknown,
  evaluatedInput: string,
  expectedVerdict: 0 | 1,
  options: VerifyOptions = {},
): Promise<ReceiptCheck> {
  const keys = options.keys ?? RAMEN_RECEIPT_KEYS;
  const nowMs = options.nowMs ?? Date.now();
  if (receipt === undefined || receipt === null) return fail("no receipt returned");
  const envelope = RamenReceipt.safeParse(receipt);
  if (!envelope.success) return fail("receipt envelope is malformed");
  const { id, kid, signature, canonical_payload: canonical } = envelope.data;

  const canonicalBytes = encoder.encode(canonical);
  if (canonicalBytes.byteLength > MAX_CANONICAL_PAYLOAD_BYTES) return fail("receipt.canonical_payload is too large");
  const key = receiptKey(keys, kid);
  if (key === null) return fail("receipt kid is not a pinned key");

  let signatureValid = false;
  try {
    const signatureBytes = decodeBase64url(signature.replace(/=+$/, ""));
    if (signatureBytes.byteLength !== 64) return fail("receipt.signature must decode to 64 bytes");
    signatureValid = await crypto.subtle.verify({ name: "Ed25519" }, await key, signatureBytes, canonicalBytes);
  } catch {
    return fail("receipt signature could not be checked");
  }
  if (!signatureValid) return fail("receipt signature does not verify against the pinned key");

  // From here on only the signed bytes are trusted.
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(canonical);
  } catch {
    return fail("signed canonical_payload is not JSON");
  }
  const signedResult = SignedPayloadV5.safeParse(parsedPayload);
  if (!signedResult.success) return fail("signed canonical_payload is not a Schema V5 payload");
  const signed = signedResult.data;

  if (signed.id !== id) return fail("signed id does not match receipt.id");
  if (signed.kid !== kid) return fail("signed kid does not match receipt.kid");
  if (envelope.data.verdict !== undefined && envelope.data.verdict !== signed.verdict) {
    return fail("receipt.verdict does not match the signed verdict");
  }
  if (
    envelope.data.statutory_anchors !== undefined &&
    JSON.stringify(envelope.data.statutory_anchors) !== JSON.stringify(signed.statutory_anchors)
  ) {
    return fail("receipt.statutory_anchors do not match the signed anchors");
  }

  const verified: VerifiedReceipt = {
    id: signed.id,
    signature,
    canonicalPayload: canonical,
    signed,
    envelope: envelope.data as Record<string, unknown>,
  };

  if (signed.payload_hash !== (await sha256Hex(evaluatedInput))) {
    return fail("signed payload_hash does not match the evaluated input", true, verified);
  }
  const base = { verified: true, bound: true, receipt: verified };
  if (signed.verdict !== expectedVerdict) return { ...base, ok: false, reason: "signed verdict does not match the evaluation" };
  const signedAt = Date.parse(signed.timestamp);
  if (!Number.isFinite(signedAt) || Math.abs(nowMs - signedAt) > RECEIPT_MAX_SKEW_MS) {
    return { ...base, ok: false, reason: "signed timestamp is outside the allowed skew" };
  }
  return { ...base, ok: true, reason: null };
}
