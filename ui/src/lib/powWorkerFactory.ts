/**
 * Browser wiring for the PoW pool: the only module that touches the Worker constructor.
 *
 * `new Worker(new URL(...), { type: "module" })` is the form Vite recognises; it emits the worker as
 * its own same-origin file (assets/pow.worker-*.js), which the page CSP allows. Do not switch to
 * `?worker&inline` or a Blob URL: `script-src 'self'` blocks both.
 */
import type { PowParams } from "./pow";
import { solveWithPool, type PowPoolOptions, type PowPoolSolution, type PowWorkerLike } from "./powPool";

// Declared here so this file also typechecks in the test project, which has no DOM lib (workerd has no
// Worker). At runtime these resolve to the browser's own Worker and import.meta.url.
declare const Worker: new (url: URL, options?: { type?: "module" | "classic" }) => unknown;
declare global {
  interface ImportMeta {
    url: string;
  }
}

export function spawnPowWorker(): PowWorkerLike {
  return new Worker(new URL("./pow.worker.ts", import.meta.url), { type: "module" }) as unknown as PowWorkerLike;
}

/** Solves a registration challenge in background workers. */
export function solvePow(params: PowParams, options: Omit<PowPoolOptions, "spawn"> = {}): Promise<PowPoolSolution> {
  return solveWithPool(params, { ...options, spawn: spawnPowWorker });
}
