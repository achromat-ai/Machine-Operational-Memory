/**
 * Unpadded base64url (RFC 4648 section 5), matching the server's encodeBase64url/decodeBase64url in
 * src/schema.ts byte for byte.
 *
 * The server's decoder is lenient (atob) and its schemas then insist on canonical form, i.e. that
 * re-encoding the decoded bytes gives back the same string. This decoder applies that rule itself:
 * it throws on padding, on characters outside the alphabet, on an impossible length, and on non-zero
 * trailing bits. Pure functions with no DOM dependency, so they also run in a WebWorker.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** char code -> 6-bit value, or 255 for characters outside the alphabet. */
const DECODE_TABLE = (() => {
  const table = new Uint8Array(128).fill(255);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** Number of base64url characters for `byteLength` bytes: ceil(n * 4 / 3). */
export function base64urlLength(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3);
}

export function encodeBase64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/** Strict decode. Throws a RangeError for anything that is not canonical unpadded base64url. */
export function decodeBase64url(value: string): Uint8Array {
  const length = value.length;
  if (length % 4 === 1) throw new RangeError("base64url: impossible length");
  const out = new Uint8Array(Math.floor((length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < length; i++) {
    const code = value.charCodeAt(i);
    const digit = code < 128 ? DECODE_TABLE[code]! : 255;
    if (digit === 255) throw new RangeError("base64url: character outside the alphabet");
    acc = (acc << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  // Whatever is left over must be zero, otherwise two strings would decode to the same bytes.
  if (acc !== 0) throw new RangeError("base64url: non-canonical trailing bits");
  return out;
}

/** True when `value` is canonical unpadded base64url, optionally of exactly `byteLength` bytes. */
export function isCanonicalBase64url(value: string, byteLength?: number): boolean {
  if (byteLength !== undefined && value.length !== base64urlLength(byteLength)) return false;
  try {
    decodeBase64url(value);
    return true;
  } catch {
    return false;
  }
}
