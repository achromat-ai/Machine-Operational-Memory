/**
 * The strings the browser signs and hashes, byte-identical to src/schema.ts (see public/skill.md
 * sections 2 and 3). Newlines are a single LF (0x0A).
 */

/** Domain-separation prefix of every request signature. */
export const REQUEST_SIGNING_CONTEXT = "achromat-mom-v1";

/** Domain-separation prefix of the registration proof of possession. */
export const REGISTRATION_SIGNING_CONTEXT = "achromat-register-v1";

/** Hashcash algorithm identifier returned by the challenge endpoint. */
export const POW_ALGORITHM = "sha256-hashcash-v1";

/** Lowercase hex SHA-256 of an empty body (every GET request). */
export const EMPTY_BODY_SHA256_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface SigningInput {
  /** Request host (`location.host`), lowercased by this function. Includes a non-default port. */
  host: string;
  /** HTTP method, uppercased by this function. */
  method: string;
  /** Path plus query string exactly as sent (`/api/v1/recall`). */
  pathAndQuery: string;
  /** Lowercase hex SHA-256 of the raw request body bytes. */
  bodySha256Hex: string;
  /** The Achromat-Timestamp header value (10 digits). */
  timestamp: string;
  /** The Achromat-Nonce header value (22 characters). */
  nonce: string;
}

/** `achromat-mom-v1 LF host LF METHOD LF path+query LF sha256hex(body) LF timestamp LF nonce`, no trailing LF. */
export function requestSigningString(input: SigningInput): string {
  return [
    REQUEST_SIGNING_CONTEXT,
    input.host.toLowerCase(),
    input.method.toUpperCase(),
    input.pathAndQuery,
    input.bodySha256Hex,
    input.timestamp,
    input.nonce,
  ].join("\n");
}

/** `achromat-register-v1 LF challenge LF public_key`, signed with the key being registered. */
export function registrationSigningString(challenge: string, publicKey: string): string {
  return `${REGISTRATION_SIGNING_CONTEXT}\n${challenge}\n${publicKey}`;
}

/** Hashcash preimage: challenge + public_key + nonce as text, no separator. Hash its UTF-8 bytes. */
export function powPreimage(challenge: string, publicKey: string, nonce: string): string {
  return challenge + publicKey + nonce;
}

const encoder = new TextEncoder();

/** UTF-8 bytes of a string, the form every signed or hashed message takes. */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}
