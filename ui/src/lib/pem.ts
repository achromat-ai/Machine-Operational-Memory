/**
 * Strict PKCS#8 PEM reader for the admin's Ed25519 key (the file `openssl genpkey -algorithm ed25519`
 * writes). It validates the armor, the base64 and the DER structure before anything reaches
 * crypto.subtle.importKey, so a wrong file fails with a clear message instead of an opaque DOMException.
 *
 * Accepted: exactly one unencrypted `PRIVATE KEY` block holding the 48-byte Ed25519 PKCS#8 v1 structure.
 * Rejected: encrypted keys, other key types and formats (RSA, EC, OpenSSH, public keys), PEM headers
 * (Proc-Type, DEK-Info), text before or after the block, more than one block, malformed or
 * non-canonical base64, and any other DER layout.
 *
 * Nothing here logs or stores the key, and error messages never contain key material.
 */

export class PemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PemError";
  }
}

const BEGIN = "-----BEGIN PRIVATE KEY-----";
const END = "-----END PRIVATE KEY-----";

/**
 * DER prefix of an Ed25519 PrivateKeyInfo (RFC 8410): SEQUENCE(46) { INTEGER 0, SEQUENCE { OID 1.3.101.112 },
 * OCTET STRING(34) { OCTET STRING(32) <seed> } }. The 32-byte seed follows.
 */
export const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export const ED25519_PKCS8_LENGTH = ED25519_PKCS8_PREFIX.length + 32;

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_TABLE = (() => {
  const table = new Uint8Array(128).fill(255);
  for (let i = 0; i < BASE64.length; i++) table[BASE64.charCodeAt(i)] = i;
  return table;
})();

/** Strict standard base64 (RFC 4648 section 4): alphabet, `=` padding to a multiple of 4, zero trailing bits. */
function decodeBase64Strict(text: string): Uint8Array {
  if (text.length === 0 || text.length % 4 !== 0) throw new PemError("The key body is not valid base64.");
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const dataLength = text.length - padding;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < dataLength; i++) {
    const code = text.charCodeAt(i);
    const digit = code < 128 ? BASE64_TABLE[code]! : 255;
    if (digit === 255) throw new PemError("The key body is not valid base64.");
    acc = (acc << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) throw new PemError("The key body is not canonical base64.");
  return out;
}

const WRONG_FORMAT: ReadonlyArray<readonly [RegExp, string]> = [
  [/BEGIN ENCRYPTED PRIVATE KEY/, "This key is encrypted. Provide an unencrypted PKCS#8 Ed25519 key."],
  [/BEGIN OPENSSH PRIVATE KEY/, "This is an OpenSSH key. Provide a PKCS#8 PEM (BEGIN PRIVATE KEY)."],
  [/BEGIN (RSA|EC|DSA) PRIVATE KEY/, "This is not a PKCS#8 Ed25519 key. Provide a PEM that starts with BEGIN PRIVATE KEY."],
  [/BEGIN (PUBLIC KEY|CERTIFICATE)/, "This is a public key or certificate. The private key is required."],
];

/** Extracts and validates the PKCS#8 DER from a PEM string. Throws PemError. */
export function parsePkcs8Pem(pem: string): Uint8Array {
  const text = pem.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) throw new PemError("No key provided.");

  for (const [pattern, message] of WRONG_FORMAT) {
    if (pattern.test(text)) throw new PemError(message);
  }

  const lines = text.split("\n").map((line) => line.trim());
  if (lines[0] !== BEGIN) throw new PemError("Expected a PEM that starts with -----BEGIN PRIVATE KEY-----.");
  if (lines[lines.length - 1] !== END) throw new PemError("Expected the PEM to end with -----END PRIVATE KEY-----.");

  const body = lines.slice(1, -1);
  if (body.length === 0) throw new PemError("The key body is empty.");
  for (const line of body) {
    if (line.length === 0) throw new PemError("Unexpected blank line inside the key.");
    if (line.includes("-----")) throw new PemError("Only one key block is allowed.");
    if (line.includes(":")) throw new PemError("PEM headers are not supported. Provide an unencrypted key.");
    if (line.length > 76) throw new PemError("A line of the key body is too long.");
  }

  const der = decodeBase64Strict(body.join(""));
  assertEd25519Pkcs8(der);
  return der;
}

function assertEd25519Pkcs8(der: Uint8Array): void {
  if (der.length !== ED25519_PKCS8_LENGTH) {
    throw new PemError("This is not an Ed25519 PKCS#8 key (generate one with: openssl genpkey -algorithm ed25519).");
  }
  for (let i = 0; i < ED25519_PKCS8_PREFIX.length; i++) {
    if (der[i] !== ED25519_PKCS8_PREFIX[i]) {
      throw new PemError("This is not an Ed25519 PKCS#8 key (generate one with: openssl genpkey -algorithm ed25519).");
    }
  }
}

/** The 32-byte Ed25519 seed inside a validated PKCS#8 DER. */
export function ed25519SeedFromPkcs8(der: Uint8Array): Uint8Array {
  assertEd25519Pkcs8(der);
  return der.slice(ED25519_PKCS8_PREFIX.length);
}
