/**
 * Ed25519 signing for the SPA. A Signer holds a non-extractable CryptoKey and the base64url public key
 * the server knows it by; nothing here ever exposes private key bytes.
 *
 * Two sources:
 *   - the community key from the keystore (signerFromKey), and
 *   - an operator key pasted as an unencrypted PKCS#8 PEM (signerFromPkcs8Pem). That signer lives only in
 *     the memory of the caller: this module never writes it anywhere. There is no JWT form in this
 *     protocol, so no JWT parser exists.
 */
import { encodeBase64url, isCanonicalBase64url } from "./base64url";
import { parsePkcs8Pem, PemError } from "./pem";

export interface Signer {
  /** Raw 32-byte public key, base64url (43 characters): the Achromat-Agent-Key header value. */
  readonly publicKeyB64u: string;
  /** Signs the bytes and returns the 64-byte signature as base64url (86 characters). */
  sign(data: Uint8Array): Promise<string>;
}

/** Signs `data` with an Ed25519 private key and returns the base64url signature. */
export async function sign(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer-backed array, the form Web Crypto's typings accept.
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new Uint8Array(data));
  return encodeBase64url(new Uint8Array(signature));
}

/** The base64url raw public key of a CryptoKey of type "public". */
export async function publicKeyToB64u(publicKey: CryptoKey): Promise<string> {
  return encodeBase64url(new Uint8Array((await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer));
}

export function signerFromKey(privateKey: CryptoKey, publicKeyB64u: string): Signer {
  if (privateKey.type !== "private") throw new TypeError("a private key is required");
  if (!isCanonicalBase64url(publicKeyB64u, 32)) throw new TypeError("publicKeyB64u must be a 32-byte base64url key");
  return {
    publicKeyB64u,
    sign: (data) => sign(privateKey, data),
  };
}

/**
 * Builds a memory-only signer from an unencrypted Ed25519 PKCS#8 PEM.
 *
 * Web Crypto cannot derive a public key from a non-extractable private key, and the server needs it for
 * the Achromat-Agent-Key header. So the DER is imported twice: once extractable, only to read the public
 * half (`x`) from its JWK, and once non-extractable for signing. The extractable key object is dropped
 * immediately. The PEM text and DER bytes remain on the JS heap until garbage collection, which is why
 * callers should clear their input fields and drop references straight after this resolves.
 *
 * Throws PemError for anything that is not an unencrypted Ed25519 PKCS#8 key.
 */
export async function signerFromPkcs8Pem(pem: string): Promise<Signer> {
  const der = parsePkcs8Pem(pem);
  let publicKeyB64u: string;
  try {
    const readable = await crypto.subtle.importKey("pkcs8", new Uint8Array(der), { name: "Ed25519" }, true, ["sign"]);
    const jwk = (await crypto.subtle.exportKey("jwk", readable)) as JsonWebKey;
    publicKeyB64u = typeof jwk.x === "string" ? jwk.x : "";
  } catch {
    throw new PemError("This browser could not read the key.");
  }
  if (!isCanonicalBase64url(publicKeyB64u, 32)) throw new PemError("This browser could not read the key.");

  const privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array(der), { name: "Ed25519" }, false, ["sign"]);
  der.fill(0);
  return signerFromKey(privateKey, publicKeyB64u);
}

/** A short, non-secret fingerprint of a public key for display: the first and last 6 characters. */
export function fingerprint(publicKeyB64u: string): string {
  if (!isCanonicalBase64url(publicKeyB64u, 32)) throw new TypeError("not a public key");
  return `${publicKeyB64u.slice(0, 6)}…${publicKeyB64u.slice(-6)}`;
}
