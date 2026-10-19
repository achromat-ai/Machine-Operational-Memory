/**
 * Hashcash proof of work for POST /api/v1/agents/register (public/skill.md section 2.2).
 *
 *   preimage = UTF8(challenge + public_key + nonce)     (plain concatenation, nonce is lowercase hex text)
 *   valid    = leading_zero_bits(SHA-256(preimage)) >= difficulty_bits
 *
 * The search enumerates counters and formats each as lowercase hex without leading zeros, so the nonce
 * is 1 to 32 characters as the server requires. A search can be strided (worker i of N tries counters
 * i, i + N, i + 2N, ...) so several workers cover disjoint nonces.
 *
 * Pure and synchronous: no DOM, no Web Crypto. runPowJob is the message protocol the worker speaks;
 * pow.worker.ts only wires it to postMessage, and the tests run it in-process.
 */
import { POW_ALGORITHM, powPreimage, utf8 } from "./canonical";
import { bytesToHex, createSuffixHasher, sha256, sha256Midstate, sha256WordsToBytes } from "./sha256";

export { POW_ALGORITHM };

/** The server accepts nonces of 1 to 32 lowercase hex characters. */
export const MAX_NONCE_LENGTH = 32;

/** Largest counter whose hex form is exact in a double. */
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

const HEX_DIGITS = new Uint8Array([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102]); // 0-9a-f

/** Lowercase hex text of a non-negative integer counter: the nonce. */
export function counterToNonce(counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError("counter must be a non-negative safe integer");
  return counter.toString(16);
}

/** The nonce shape the server accepts. */
export function isValidNonce(nonce: string): boolean {
  return /^[0-9a-f]{1,32}$/.test(nonce);
}

/** Leading zero bits of a digest, counted from the most significant bit of the first byte. */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (let i = 0; i < digest.length; i++) {
    const byte = digest[i]!;
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** True when the first `bits` bits of the digest words are zero. */
function meetsDifficulty(words: Uint32Array, bits: number): boolean {
  let remaining = bits;
  for (let i = 0; remaining > 0 && i < words.length; i++) {
    const word = words[i]!;
    if (remaining >= 32) {
      if (word !== 0) return false;
      remaining -= 32;
    } else {
      return Math.clz32(word) >= remaining;
    }
  }
  return true;
}

export interface PowVerification {
  valid: boolean;
  zeroBits: number;
  digestHex: string;
}

/** Recomputes the digest for a nonce and checks it against the difficulty. */
export function verifyPow(challenge: string, publicKey: string, nonce: string, difficultyBits: number): PowVerification {
  const digest = sha256(utf8(powPreimage(challenge, publicKey, nonce)));
  const zeroBits = leadingZeroBits(digest);
  return { valid: isValidNonce(nonce) && zeroBits >= difficultyBits, zeroBits, digestHex: bytesToHex(digest) };
}

export interface PowParams {
  challenge: string;
  publicKey: string;
  difficultyBits: number;
}

export interface PowStride {
  /** First counter this search tries. */
  start: number;
  /** Distance between counters: the number of cooperating searchers. */
  stride: number;
}

export interface PowSolution {
  counter: number;
  nonce: string;
  digestHex: string;
  zeroBits: number;
}

export interface PowSearch {
  /** Trials performed so far. */
  readonly trials: number;
  /** Tries up to `budget` more counters. Returns the first solution found, or null. */
  run(budget: number): PowSolution | null;
}

function assertParams(params: PowParams, { start, stride }: PowStride): void {
  if (!Number.isInteger(params.difficultyBits) || params.difficultyBits < 1 || params.difficultyBits > 256) {
    throw new RangeError("difficultyBits must be an integer from 1 to 256");
  }
  if (!Number.isSafeInteger(start) || start < 0) throw new RangeError("start must be a non-negative safe integer");
  if (!Number.isSafeInteger(stride) || stride < 1) throw new RangeError("stride must be a positive safe integer");
}

/** Writes the lowercase hex digits of `counter` to the front of `out` and returns their count. */
function writeHex(counter: number, out: Uint8Array): number {
  let length = 1;
  for (let rest = counter; rest >= 16; rest = (rest - (rest % 16)) / 16) length++;
  let rest = counter;
  for (let i = length - 1; i >= 0; i--) {
    const digit = rest % 16;
    out[i] = HEX_DIGITS[digit]!;
    rest = (rest - digit) / 16;
  }
  return length;
}

/** A resumable search over the strided counters. The prefix is hashed once; each trial compresses one block. */
export function createPowSearch(params: PowParams, { start, stride }: PowStride = { start: 0, stride: 1 }): PowSearch {
  assertParams(params, { start, stride });
  const hasher = createSuffixHasher(sha256Midstate(utf8(params.challenge + params.publicKey)), MAX_NONCE_LENGTH);
  const suffix = new Uint8Array(MAX_NONCE_LENGTH);
  const difficultyBits = params.difficultyBits;
  let counter = start;
  let trials = 0;

  return {
    get trials() {
      return trials;
    },
    run(budget) {
      for (let done = 0; done < budget; done++) {
        if (counter > MAX_COUNTER) throw new RangeError("nonce space exhausted");
        const length = writeHex(counter, suffix);
        const words = hasher.hash(suffix, length);
        trials++;
        if (meetsDifficulty(words, difficultyBits)) {
          const digest = sha256WordsToBytes(words);
          const found: PowSolution = {
            counter,
            nonce: counterToNonce(counter),
            digestHex: bytesToHex(digest),
            zeroBits: leadingZeroBits(digest),
          };
          counter += stride;
          return found;
        }
        counter += stride;
      }
      return null;
    },
  };
}

/** Finds the first valid nonce at or after `start` along the stride, giving up after `maxTrials`. */
export function searchPow(params: PowParams, stride: PowStride = { start: 0, stride: 1 }, maxTrials = Infinity): PowSolution | null {
  const search = createPowSearch(params, stride);
  const batch = 1 << 14;
  while (search.trials < maxTrials) {
    const found = search.run(Math.min(batch, maxTrials - search.trials));
    if (found) return found;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// Worker message protocol
// ════════════════════════════════════════════════════════════════════════

export interface PowStartMessage extends PowParams, PowStride {
  type: "start";
}

export type PowWorkerInMessage = PowStartMessage;

export type PowWorkerOutMessage =
  /** `trials` is the number of trials since the previous progress message. */
  | { type: "progress"; trials: number }
  /** `trials` is this worker's total. */
  | { type: "found"; nonce: string; digestHex: string; zeroBits: number; counter: number; trials: number }
  | { type: "error"; message: string };

export interface PowJobOptions {
  /** Trials between progress messages and stop checks. */
  batchSize?: number;
  /** Polled once per batch. Return true to abandon the job. */
  shouldStop?: () => boolean;
  /**
   * Awaited between batches. Omit it (the real worker does) and the job is one synchronous loop,
   * cancelled by terminating the worker. Tests supply a macrotask yield so several jobs interleave.
   */
  yieldToEventLoop?: () => Promise<void>;
}

export const DEFAULT_BATCH_SIZE = 1 << 16;

/**
 * Runs one worker's share of the search and reports through `post`.
 * Resolves "found" after posting the solution, or "stopped" when shouldStop asked for it.
 */
export async function runPowJob(
  job: PowStartMessage,
  post: (message: PowWorkerOutMessage) => void,
  options: PowJobOptions = {},
): Promise<"found" | "stopped"> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const search = createPowSearch(job, job);
  let reported = 0;
  for (;;) {
    if (options.shouldStop?.()) return "stopped";
    const found = search.run(batchSize);
    const total = search.trials;
    if (found) {
      if (total > reported) post({ type: "progress", trials: total - reported });
      post({
        type: "found",
        nonce: found.nonce,
        digestHex: found.digestHex,
        zeroBits: found.zeroBits,
        counter: found.counter,
        trials: total,
      });
      return "found";
    }
    post({ type: "progress", trials: total - reported });
    reported = total;
    if (options.yieldToEventLoop) await options.yieldToEventLoop();
  }
}
