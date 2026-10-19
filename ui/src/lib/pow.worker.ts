/**
 * WebWorker entry point for the Hashcash search. It is a synchronous loop (no yielding), so the pool
 * cancels it by terminating the worker rather than by message.
 *
 * Protocol (see pow.ts): receives one `start` message, then posts `progress` messages and finally
 * either `found` or `error`. The worker is loaded as a same-origin module file, which the page CSP
 * allows (`script-src 'self'`; there is no worker-src, so workers fall back to it). Never load it from a
 * blob: or data: URL.
 */
import { runPowJob, type PowWorkerInMessage, type PowWorkerOutMessage } from "./pow";

// The DOM and WebWorker libs disagree about `self`, so describe only what is used.
interface PowWorkerScope {
  onmessage: ((event: { data: PowWorkerInMessage }) => void) | null;
  postMessage(message: PowWorkerOutMessage): void;
}

const scope = self as unknown as PowWorkerScope;
let started = false;

scope.onmessage = (event) => {
  const message = event.data;
  if (started || message?.type !== "start") return;
  started = true;
  runPowJob(message, (out) => scope.postMessage(out)).catch((error: unknown) => {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : "proof of work failed" });
  });
};
