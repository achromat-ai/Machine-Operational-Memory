/**
 * Hashcash search, worker protocol and worker pool (ui/src/lib/pow*.ts).
 *
 * workerd has no Web Worker API, so the pool is driven through its injected `spawn` with in-process
 * fake workers that run the real search (runPowJob) and yield to the event loop between batches. What
 * the browser adds on top (module worker loading under the page CSP) is covered by the build checks.
 */
import { describe, expect, it } from "vitest";
import { leadingZeroBits as serverLeadingZeroBits, powPreimage as serverPowPreimage, toHex } from "../src/schema";
import {
  counterToNonce,
  createPowSearch,
  isValidNonce,
  leadingZeroBits,
  runPowJob,
  searchPow,
  verifyPow,
  type PowStartMessage,
  type PowWorkerInMessage,
  type PowWorkerOutMessage,
} from "../ui/src/lib/pow";
import {
  PowAbortedError,
  PowWorkerError,
  defaultConcurrency,
  solveWithPool,
  type PowWorkerLike,
} from "../ui/src/lib/powPool";

// SKILL.md section 8: the first counter whose digest has at least 16 zero bits is 0x7549,
// and its digest happens to have 17.
const PUBLIC_KEY = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg";
const CHALLENGE = "EoI8yTsHQvEUsyaAHydHIjYhx8tIlHh26aHmIaKqZlQ";
const NONCE = "7549";
const DIGEST = "0000646354041268aa8fbf9d704f08bf54591d4f0247fef3b95ec8a117c257ec";
const PARAMS_17 = { challenge: CHALLENGE, publicKey: PUBLIC_KEY, difficultyBits: 17 };
const WINNING_COUNTER = 0x7549;

/** Digest and zero bits computed only with crypto.subtle and the server's helpers. */
async function independentCheck(nonce: string, challenge = CHALLENGE, publicKey = PUBLIC_KEY) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serverPowPreimage(challenge, publicKey, nonce))));
  const hex = toHex(digest);
  return { hex, zeroBits: serverLeadingZeroBits(hex) };
}

const sleep = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Hashcash primitives", () => {
  it("formats nonces as lowercase hex text and validates their shape", () => {
    expect(counterToNonce(0)).toBe("0");
    expect(counterToNonce(255)).toBe("ff");
    expect(counterToNonce(WINNING_COUNTER)).toBe(NONCE);
    expect(counterToNonce(Number.MAX_SAFE_INTEGER)).toBe("1fffffffffffff");
    expect(() => counterToNonce(-1)).toThrow(RangeError);
    expect(() => counterToNonce(1.5)).toThrow(RangeError);
    expect(isValidNonce("7549")).toBe(true);
    expect(isValidNonce("f".repeat(32))).toBe(true);
    for (const bad of ["", "7549A", "75 49", "0x75", "g", "f".repeat(33)]) expect(isValidNonce(bad), JSON.stringify(bad)).toBe(false);
  });

  it("counts leading zero bits like the server", () => {
    for (let i = 0; i < 200; i++) {
      const digest = crypto.getRandomValues(new Uint8Array(32));
      // Force a run of leading zero bytes and bits so the counter is exercised, not just the first byte.
      digest.fill(0, 0, i % 5);
      if (i % 3 === 0) digest[i % 5] = 1 << (i % 8);
      expect(leadingZeroBits(digest)).toBe(serverLeadingZeroBits(toHex(digest)));
    }
    expect(leadingZeroBits(new Uint8Array(32))).toBe(256);
    expect(leadingZeroBits(Uint8Array.from([0, 0, 0x0f]))).toBe(20);
  });

  it("verifies the skill.md vector and rejects anything weaker", () => {
    const ok = verifyPow(CHALLENGE, PUBLIC_KEY, NONCE, 16);
    expect(ok).toEqual({ valid: true, zeroBits: 17, digestHex: DIGEST });
    expect(verifyPow(CHALLENGE, PUBLIC_KEY, NONCE, 17).valid).toBe(true);
    expect(verifyPow(CHALLENGE, PUBLIC_KEY, NONCE, 18).valid).toBe(false);
    expect(verifyPow(CHALLENGE, PUBLIC_KEY, "7548", 16).valid).toBe(false);
    expect(verifyPow(CHALLENGE, PUBLIC_KEY, "00007549", 16).valid).toBe(false);
    expect(verifyPow(CHALLENGE, `${PUBLIC_KEY}A`, NONCE, 16).valid).toBe(false);
    // Upper-case hex is a different text and not an accepted nonce shape.
    expect(verifyPow(CHALLENGE, PUBLIC_KEY, NONCE.toUpperCase(), 1).valid).toBe(true); // digits only: identical text
    expect(verifyPow(CHALLENGE, PUBLIC_KEY, "ABC", 0).valid).toBe(false);
  });
});

describe("Hashcash search", () => {
  it("finds the skill.md nonce from counter 0 for 16 and 17 bits, and the server agrees", async () => {
    for (const difficultyBits of [16, 17]) {
      const found = searchPow({ ...PARAMS_17, difficultyBits })!;
      expect(found.counter).toBe(WINNING_COUNTER);
      expect(found.nonce).toBe(NONCE);
      expect(found.digestHex).toBe(DIGEST);
      expect(found.zeroBits).toBe(17);
    }
    expect(await independentCheck(NONCE)).toEqual({ hex: DIGEST, zeroBits: 17 });
  });

  it("returns null when the trial budget runs out, and keeps counting trials", () => {
    expect(searchPow({ ...PARAMS_17, difficultyBits: 40 }, { start: 0, stride: 1 }, 3000)).toBeNull();
    const search = createPowSearch({ ...PARAMS_17, difficultyBits: 40 });
    expect(search.run(1000)).toBeNull();
    expect(search.trials).toBe(1000);
    expect(search.run(500)).toBeNull();
    expect(search.trials).toBe(1500);
  });

  it("covers disjoint counters when strided, and every hit verifies independently", async () => {
    const stride = 4;
    const hits = [];
    for (let start = 0; start < stride; start++) {
      const found = searchPow(PARAMS_17, { start, stride })!;
      expect(found.counter % stride).toBe(start);
      hits.push(found);
    }
    // Nothing below 0x7549 qualifies, so the strided worker that owns it finds exactly that counter.
    expect(Math.min(...hits.map((hit) => hit.counter))).toBe(WINNING_COUNTER);
    expect(hits.find((hit) => hit.counter === WINNING_COUNTER)!.nonce).toBe(NONCE);
    for (const hit of hits) {
      expect(hit.zeroBits).toBeGreaterThanOrEqual(17);
      const check = await independentCheck(hit.nonce);
      expect(check.hex).toBe(hit.digestHex);
      expect(check.zeroBits).toBe(hit.zeroBits);
    }
  });

  it("resumes after a hit instead of repeating it", () => {
    const search = createPowSearch({ ...PARAMS_17, difficultyBits: 12 });
    const seen = new Set<number>();
    for (let i = 0; i < 5; i++) {
      const found = search.run(1_000_000)!;
      expect(seen.has(found.counter)).toBe(false);
      seen.add(found.counter);
      expect(verifyPow(CHALLENGE, PUBLIC_KEY, found.nonce, 12).valid).toBe(true);
    }
  });

  it("searches correctly across nonce lengths 1, 2 ... 9 and across the block boundary", async () => {
    // A challenge/key pair whose prefix is not 86 bytes also exercises other tail offsets.
    for (const [challenge, publicKey] of [
      [CHALLENGE, PUBLIC_KEY],
      ["short", "k"],
      ["c".repeat(100), "k".repeat(40)],
    ] as const) {
      const search = createPowSearch({ challenge, publicKey, difficultyBits: 8 });
      for (let i = 0; i < 6; i++) {
        const found = search.run(5_000_000)!;
        const check = await independentCheck(found.nonce, challenge, publicKey);
        expect(check.hex).toBe(found.digestHex);
        expect(check.zeroBits).toBeGreaterThanOrEqual(8);
      }
    }
    // Directly: large counters switch the nonce to 8+ hex characters.
    const far = createPowSearch({ ...PARAMS_17, difficultyBits: 1 }, { start: 0x123456789a, stride: 1 });
    const found = far.run(100)!;
    expect(found.nonce.length).toBeGreaterThanOrEqual(9);
    expect((await independentCheck(found.nonce)).hex).toBe(found.digestHex);
  });

  it("rejects invalid parameters", () => {
    for (const difficultyBits of [0, -1, 1.5, 257, Number.NaN]) {
      expect(() => createPowSearch({ ...PARAMS_17, difficultyBits })).toThrow(RangeError);
    }
    expect(() => createPowSearch(PARAMS_17, { start: -1, stride: 1 })).toThrow(RangeError);
    expect(() => createPowSearch(PARAMS_17, { start: 0, stride: 0 })).toThrow(RangeError);
    expect(() => createPowSearch(PARAMS_17, { start: 0.5, stride: 1 })).toThrow(RangeError);
  });
});

describe("worker message protocol (runPowJob)", () => {
  const job = (overrides: Partial<PowStartMessage> = {}): PowStartMessage => ({ type: "start", ...PARAMS_17, start: 0, stride: 1, ...overrides });

  it("reports progress deltas that add up to the final trial count, then the solution", async () => {
    const messages: PowWorkerOutMessage[] = [];
    const result = await runPowJob(job(), (message) => messages.push(message), { batchSize: 4096 });
    expect(result).toBe("found");

    const last = messages[messages.length - 1]!;
    expect(last.type).toBe("found");
    if (last.type !== "found") throw new Error("unreachable");
    expect(last).toMatchObject({ nonce: NONCE, digestHex: DIGEST, zeroBits: 17, counter: WINNING_COUNTER, trials: WINNING_COUNTER + 1 });

    const progress = messages.filter((message) => message.type === "progress") as Array<{ type: "progress"; trials: number }>;
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.every((message) => message.trials > 0)).toBe(true);
    expect(progress.reduce((sum, message) => sum + message.trials, 0)).toBe(last.trials);
    expect(messages.filter((message) => message.type === "found")).toHaveLength(1);
  });

  it("stops between batches when asked, without posting a solution", async () => {
    const messages: PowWorkerOutMessage[] = [];
    let polls = 0;
    const result = await runPowJob(job({ difficultyBits: 40 }), (message) => messages.push(message), {
      batchSize: 1000,
      shouldStop: () => ++polls > 3,
    });
    expect(result).toBe("stopped");
    expect(messages.every((message) => message.type === "progress")).toBe(true);
    expect(messages).toHaveLength(3);
  });

  it("yields to the event loop between batches when given a yield function", async () => {
    let yields = 0;
    await runPowJob(job(), () => undefined, {
      batchSize: 8192,
      yieldToEventLoop: async () => {
        yields++;
        await sleep();
      },
    });
    expect(yields).toBe(Math.floor(WINNING_COUNTER / 8192));
  });
});

// ════════════════════════════════════════════════════════════════════════
// Worker pool
// ════════════════════════════════════════════════════════════════════════

type Behaviour = "search" | "endless" | "fail" | "forge";

/** An in-process stand-in for a module Worker. */
class FakeWorker implements PowWorkerLike {
  onmessage: PowWorkerLike["onmessage"] = null;
  onerror: PowWorkerLike["onerror"] = null;
  terminated = false;
  started: PowWorkerInMessage | null = null;
  result: "found" | "stopped" | "endless" | "pending" = "pending";
  ticks = 0;
  postsAfterTerminate = 0;

  readonly behaviour: Behaviour;

  constructor(behaviour: Behaviour) {
    this.behaviour = behaviour;
  }

  postMessage(message: PowWorkerInMessage): void {
    this.started = message;
    void this.run(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(message: PowWorkerOutMessage): void {
    if (this.terminated) {
      this.postsAfterTerminate++;
      return;
    }
    this.onmessage?.({ data: message });
  }

  private async run(job: PowStartMessage): Promise<void> {
    if (this.behaviour === "search") {
      this.result = await runPowJob(job, (message) => this.emit(message), {
        batchSize: 256,
        shouldStop: () => this.terminated,
        yieldToEventLoop: () => sleep(),
      });
    } else if (this.behaviour === "endless") {
      while (!this.terminated) {
        this.ticks++;
        this.emit({ type: "progress", trials: 1 });
        await sleep();
      }
      this.result = "endless";
    } else if (this.behaviour === "fail") {
      await sleep();
      this.emit({ type: "error", message: "boom" });
    } else {
      await sleep();
      this.emit({ type: "found", nonce: "0", digestHex: "00", zeroBits: 99, counter: 0, trials: 1 });
    }
  }
}

function factory(behaviours: Behaviour[]) {
  const workers: FakeWorker[] = [];
  const spawn = () => {
    const worker = new FakeWorker(behaviours[workers.length] ?? "endless");
    workers.push(worker);
    return worker;
  };
  return { workers, spawn };
}

describe("PoW worker pool", () => {
  it("reaches the 17-bit skill.md target with four striding workers and verifies the result independently", async () => {
    const { workers, spawn } = factory(["search", "search", "search", "search"]);
    const progress: number[] = [];
    const solution = await solveWithPool(PARAMS_17, { spawn, concurrency: 4, onProgress: (total) => progress.push(total) });

    expect(solution.nonce).toBe(NONCE);
    expect(solution.digestHex).toBe(DIGEST);
    expect(solution.zeroBits).toBe(17);
    expect(solution.workers).toBe(4);
    // Worker 1 owns counter 0x7549 (stride 4, start 1) and did (0x7549 - 1) / 4 + 1 trials to get there.
    expect(solution.trials).toBeGreaterThanOrEqual((WINNING_COUNTER - 1) / 4 + 1);
    expect(solution.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(await independentCheck(solution.nonce)).toEqual({ hex: DIGEST, zeroBits: 17 });

    // Disjoint strided jobs: worker i starts at i and steps by 4.
    expect(workers.map((worker) => worker.started)).toEqual(
      [0, 1, 2, 3].map((start) => ({ type: "start", ...PARAMS_17, start, stride: 4 })),
    );
    // Progress is monotonic.
    expect(progress.length).toBeGreaterThan(0);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it("terminates every worker the moment one wins, and the losers stop working", async () => {
    // Worker 1 can win; the others would run forever.
    const { workers, spawn } = factory(["endless", "search", "endless", "endless"]);
    const solution = await solveWithPool(PARAMS_17, { spawn, concurrency: 4 });
    expect(solution.nonce).toBe(NONCE);

    expect(workers).toHaveLength(4);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
    expect(workers[0]!.ticks).toBeGreaterThan(0); // they were really running

    const ticksAtResolve = workers.map((worker) => worker.ticks);
    await sleep(40);
    expect(workers.map((worker) => worker.ticks)).toEqual(ticksAtResolve); // and then stopped
    expect(workers.filter((worker) => worker.behaviour !== "search").every((worker) => worker.result === "endless")).toBe(true);
    // The winner posted nothing after the pool terminated it.
    expect(workers[1]!.result).toBe("found");
  });

  it("stops competing searchers that were still mid-search (shouldStop sees the termination)", async () => {
    const { workers, spawn } = factory(["search", "search", "search", "search"]);
    await solveWithPool(PARAMS_17, { spawn, concurrency: 4 });
    await sleep(30);
    const results = workers.map((worker) => worker.result).sort();
    expect(results.filter((result) => result === "found")).toHaveLength(1);
    expect(results.filter((result) => result === "stopped")).toHaveLength(3);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("settles once: a second `found` after the first is ignored", async () => {
    const { workers, spawn } = factory(["search", "endless"]);
    const first = await solveWithPool({ ...PARAMS_17, difficultyBits: 12 }, { spawn, concurrency: 2 });
    expect(verifyPow(CHALLENGE, PUBLIC_KEY, first.nonce, 12).valid).toBe(true);
    // The pool detached its handlers, so a late message goes nowhere.
    expect(workers.every((worker) => worker.onmessage === null && worker.onerror === null)).toBe(true);
  });

  it("rejects and terminates everything when a worker reports an error", async () => {
    const { workers, spawn } = factory(["endless", "fail", "endless"]);
    await expect(solveWithPool(PARAMS_17, { spawn, concurrency: 3 })).rejects.toThrow(PowWorkerError);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("does not trust a worker: a forged nonce is rejected and every worker is terminated", async () => {
    const { workers, spawn } = factory(["endless", "forge"]);
    await expect(solveWithPool(PARAMS_17, { spawn, concurrency: 2 })).rejects.toThrow(/invalid nonce/);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("forwards a Worker error event", async () => {
    const { workers, spawn } = factory(["endless", "endless"]);
    const pending = solveWithPool(PARAMS_17, { spawn, concurrency: 2 });
    await sleep(5);
    workers[1]!.onerror?.({ message: "script failed to load" });
    await expect(pending).rejects.toThrow("script failed to load");
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("cancels on abort: rejects with an AbortError and terminates every worker", async () => {
    const { workers, spawn } = factory(["endless", "endless", "endless"]);
    const controller = new AbortController();
    const pending = solveWithPool(PARAMS_17, { spawn, concurrency: 3, signal: controller.signal });
    await sleep(10);
    controller.abort();
    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PowAbortedError);
    expect((error as Error).name).toBe("AbortError");
    expect(workers.every((worker) => worker.terminated)).toBe(true);
    const ticks = workers.map((worker) => worker.ticks);
    await sleep(30);
    expect(workers.map((worker) => worker.ticks)).toEqual(ticks);
  });

  it("does not spawn anything when the signal is already aborted", async () => {
    const { workers, spawn } = factory([]);
    const controller = new AbortController();
    controller.abort();
    await expect(solveWithPool(PARAMS_17, { spawn, signal: controller.signal })).rejects.toBeInstanceOf(PowAbortedError);
    expect(workers).toHaveLength(0);
  });

  it("terminates the workers already created if a later spawn throws", async () => {
    const created: FakeWorker[] = [];
    const spawn = () => {
      if (created.length === 2) throw new Error("Worker is not allowed here");
      const worker = new FakeWorker("endless");
      created.push(worker);
      return worker;
    };
    await expect(solveWithPool(PARAMS_17, { spawn, concurrency: 4 })).rejects.toThrow("Worker is not allowed here");
    expect(created).toHaveLength(2);
    expect(created.every((worker) => worker.terminated)).toBe(true);
    expect(created.every((worker) => worker.started === null)).toBe(true); // nothing was started on a half-built pool
  });

  it("works with a single worker (stride 1) and matches the single-threaded search", async () => {
    const { spawn } = factory(["search"]);
    const solution = await solveWithPool(PARAMS_17, { spawn, concurrency: 1 });
    expect(solution.nonce).toBe(NONCE);
    expect(solution.workers).toBe(1);
  });

  it("sizes the pool from hardwareConcurrency, between 1 and 4", () => {
    const size = defaultConcurrency();
    expect(Number.isInteger(size)).toBe(true);
    expect(size).toBeGreaterThanOrEqual(1);
    expect(size).toBeLessThanOrEqual(4);
  });
});
