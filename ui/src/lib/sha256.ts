/**
 * Synchronous SHA-256 (FIPS 180-4) with an exposed midstate.
 *
 * Why not crypto.subtle.digest: it is asynchronous, and the Hashcash search hashes millions of times.
 * Awaiting a promise per hash would dominate the cost, and WebAssembly is off the table because the
 * page CSP has no 'wasm-unsafe-eval'. This is plain JS over typed arrays.
 *
 * The Hashcash preimage is `challenge + public_key + nonce`. The first two parts are 86 bytes and never
 * change, so their complete 64-byte blocks are hashed once (sha256Midstate) and every trial only
 * compresses the final block (createSuffixHasher). No DOM dependency, so it also runs in a WebWorker.
 */

/* prettier-ignore */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);

const EMPTY = new Uint8Array(0);

/**
 * Compresses the 64-byte block at `block[offset..offset+64)` into `state` (8 words, updated in place).
 * Pass a shared `schedule` (64 words) in hot loops to avoid an allocation per call.
 */
export function sha256Compress(state: Uint32Array, block: Uint8Array, offset: number, schedule: Uint32Array = new Uint32Array(64)): void {
  const w = schedule;
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    w[i] = (block[j]! << 24) | (block[j + 1]! << 16) | (block[j + 2]! << 8) | block[j + 3]!;
  }
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15]!;
    const y = w[i - 2]!;
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
  }

  let a = state[0]!;
  let b = state[1]!;
  let c = state[2]!;
  let d = state[3]!;
  let e = state[4]!;
  let f = state[5]!;
  let g = state[6]!;
  let h = state[7]!;

  for (let i = 0; i < 64; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + s1 + ch + K[i]! + w[i]!) | 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }

  // Stores into a Uint32Array wrap modulo 2^32.
  state[0] = (state[0]! + a) | 0;
  state[1] = (state[1]! + b) | 0;
  state[2] = (state[2]! + c) | 0;
  state[3] = (state[3]! + d) | 0;
  state[4] = (state[4]! + e) | 0;
  state[5] = (state[5]! + f) | 0;
  state[6] = (state[6]! + g) | 0;
  state[7] = (state[7]! + h) | 0;
}

/** Writes the message length in bits as a 64-bit big-endian integer ending at `end`. */
function writeBitLength(buffer: Uint8Array, end: number, byteLength: number): void {
  const bits = byteLength * 8;
  const hi = Math.floor(bits / 4294967296);
  const lo = bits >>> 0;
  buffer[end - 8] = hi >>> 24;
  buffer[end - 7] = hi >>> 16;
  buffer[end - 6] = hi >>> 8;
  buffer[end - 5] = hi;
  buffer[end - 4] = lo >>> 24;
  buffer[end - 3] = lo >>> 16;
  buffer[end - 2] = lo >>> 8;
  buffer[end - 1] = lo;
}

/** The 32-byte digest for 8 state words (big-endian). */
export function sha256WordsToBytes(words: Uint32Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const word = words[i]!;
    out[i * 4] = word >>> 24;
    out[i * 4 + 1] = word >>> 16;
    out[i * 4 + 2] = word >>> 8;
    out[i * 4 + 3] = word;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i]! + 256).toString(16).slice(1);
  return out;
}

/**
 * SHA-256 state after the complete 64-byte blocks of a prefix.
 * `tail` holds the remaining (fewer than 64) prefix bytes, `byteLength` the full prefix length.
 */
export interface Sha256Midstate {
  readonly state: Uint32Array;
  readonly tail: Uint8Array;
  readonly byteLength: number;
}

export function sha256Midstate(prefix: Uint8Array): Sha256Midstate {
  const state = IV.slice();
  const schedule = new Uint32Array(64);
  const full = prefix.length - (prefix.length % 64);
  for (let offset = 0; offset < full; offset += 64) sha256Compress(state, prefix, offset, schedule);
  return { state, tail: prefix.slice(full), byteLength: prefix.length };
}

/** Digest of `prefix + suffix`, given the midstate of `prefix`. The midstate is not modified. */
export function sha256Finish(midstate: Sha256Midstate, suffix: Uint8Array = EMPTY): Uint8Array {
  const state = midstate.state.slice();
  const tailLength = midstate.tail.length + suffix.length;
  const paddedLength = Math.ceil((tailLength + 9) / 64) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(midstate.tail, 0);
  buffer.set(suffix, midstate.tail.length);
  buffer[tailLength] = 0x80;
  writeBitLength(buffer, paddedLength, midstate.byteLength + suffix.length);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) sha256Compress(state, buffer, offset, schedule);
  return sha256WordsToBytes(state);
}

export function sha256(data: Uint8Array): Uint8Array {
  return sha256Finish(sha256Midstate(data));
}

export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

export interface SuffixHasher {
  /**
   * Hashes `prefix + suffix[0..length)` and returns the 8 digest words. The returned array is reused by
   * the next call, so read it (or copy it with sha256WordsToBytes) before hashing again.
   */
  hash(suffix: Uint8Array, length: number): Uint32Array;
}

/**
 * A reusable hasher for one prefix and many short suffixes (the Hashcash nonce). It keeps the final
 * block(s) in one buffer and rewrites only the suffix, the 0x80 marker and the length field per call,
 * so each call costs a single block compression when the suffix fits the tail block.
 */
export function createSuffixHasher(midstate: Sha256Midstate, maxSuffixLength: number): SuffixHasher {
  const tailLength = midstate.tail.length;
  const buffer = new Uint8Array(Math.ceil((tailLength + maxSuffixLength + 9) / 64) * 64);
  buffer.set(midstate.tail, 0);
  const words = new Uint32Array(8);
  const schedule = new Uint32Array(64);
  // Everything at or after this index is zero except what the current call writes.
  let writtenEnd = tailLength;

  return {
    hash(suffix, length) {
      if (length > maxSuffixLength) throw new RangeError("suffix is longer than the hasher was built for");
      const end = tailLength + length;
      const paddedEnd = Math.ceil((end + 9) / 64) * 64;
      for (let i = 0; i < length; i++) buffer[tailLength + i] = suffix[i]!;
      // Clear what a longer previous suffix, marker or length field left behind.
      for (let i = end; i < writtenEnd; i++) buffer[i] = 0;
      buffer[end] = 0x80;
      writeBitLength(buffer, paddedEnd, midstate.byteLength + length);
      writtenEnd = paddedEnd;

      words.set(midstate.state);
      for (let offset = 0; offset < paddedEnd; offset += 64) sha256Compress(words, buffer, offset, schedule);
      return words;
    },
  };
}
