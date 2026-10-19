/**
 * Worker pool for the Hashcash search. Spawns N workers that cover disjoint strided counters
 * (worker i tries i, i + N, ...), resolves with the first verified solution, and terminates every
 * worker the moment it settles (found, failed or aborted).
 *
 * DOM-free: workers come from an injected `spawn`, so the pool is unit-testable. The browser
 * factory lives in powWorkerFactory.ts.
 */
import { verifyPow, type PowParams, type PowWorkerInMessage, type PowWorkerOutMessage } from "./pow";

/** The subset of Worker the pool uses. */
export interface PowWorkerLike {
  onmessage: ((event: { data: PowWorkerOutMessage }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(message: PowWorkerInMessage): void;
  terminate(): void;
}

export interface PowPoolSolution {
  nonce: string;
  digestHex: string;
  zeroBits: number;
  /** Trials reported across all workers when the solution arrived (a lower bound on work done). */
  trials: number;
  workers: number;
  elapsedMs: number;
}

export interface PowPoolOptions {
  /** Creates one worker. If it throws, workers already created are terminated. */
  spawn: () => PowWorkerLike;
  /** Number of workers. Default: defaultConcurrency(). */
  concurrency?: number;
  /** Aborting terminates every worker and rejects with PowAbortedError. */
  signal?: AbortSignal;
  /** Called with the total trials reported so far. */
  onProgress?: (trials: number) => void;
}

export class PowAbortedError extends Error {
  constructor() {
    super("proof of work was cancelled");
    this.name = "AbortError";
  }
}

export class PowWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowWorkerError";
  }
}

export const MAX_POOL_SIZE = 4;

/** min(4, hardwareConcurrency), at least 1. */
export function defaultConcurrency(): number {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  const cores = nav?.hardwareConcurrency;
  const count = typeof cores === "number" && Number.isFinite(cores) ? Math.floor(cores) : 1;
  return Math.max(1, Math.min(MAX_POOL_SIZE, count));
}

export function solveWithPool(params: PowParams, options: PowPoolOptions): Promise<PowPoolSolution> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? defaultConcurrency()));
  const { signal } = options;
  const startedAt = Date.now();

  return new Promise<PowPoolSolution>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PowAbortedError());
      return;
    }

    const workers: PowWorkerLike[] = [];
    const reported: number[] = new Array<number>(concurrency).fill(0);
    let settled = false;

    const total = () => reported.reduce((sum, value) => sum + value, 0);

    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      for (const worker of workers) {
        worker.onmessage = null;
        worker.onerror = null;
        try {
          worker.terminate();
        } catch {
          // A worker that cannot be terminated is already gone.
        }
      }
      outcome();
    };

    const onAbort = () => finish(() => reject(new PowAbortedError()));
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for (let index = 0; index < concurrency; index++) {
        const worker = options.spawn();
        workers.push(worker);

        worker.onmessage = (event) => {
          if (settled) return;
          const message = event.data;
          if (message.type === "progress") {
            reported[index] = (reported[index] ?? 0) + message.trials;
            options.onProgress?.(total());
          } else if (message.type === "found") {
            reported[index] = message.trials;
            // Never trust a worker: recompute the digest before accepting the nonce.
            const check = verifyPow(params.challenge, params.publicKey, message.nonce, params.difficultyBits);
            if (!check.valid) {
              finish(() => reject(new PowWorkerError("a worker returned an invalid nonce")));
              return;
            }
            finish(() =>
              resolve({
                nonce: message.nonce,
                digestHex: check.digestHex,
                zeroBits: check.zeroBits,
                trials: total(),
                workers: concurrency,
                elapsedMs: Date.now() - startedAt,
              }),
            );
          } else if (message.type === "error") {
            finish(() => reject(new PowWorkerError(message.message)));
          }
        };
        worker.onerror = (event) => finish(() => reject(new PowWorkerError(event.message || "the proof-of-work worker failed")));
      }

      // Start only once every worker is wired, so no message can arrive at a half-built pool.
      workers.forEach((worker, index) => {
        worker.postMessage({
          type: "start",
          challenge: params.challenge,
          publicKey: params.publicKey,
          difficultyBits: params.difficultyBits,
          start: index,
          stride: concurrency,
        });
      });
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new PowWorkerError("could not start the proof-of-work workers")));
    }
  });
}
