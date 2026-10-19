/**
 * Test doubles for the browser identity and signed-client code (ui/src/lib), which expects IndexedDB,
 * Web Locks and a CDN edge that workerd does not provide.
 *
 *   MemoryStore    stands in for IndexedDB (workerd cannot structured-clone a CryptoKey, so values are held
 *                  by reference; the real persistence path needs a browser)
 *   FakeLocks      a FIFO mutex with the shape of navigator.locks
 *   workerEdge     a FetchLike that sends every request to the REAL Worker (src/index.ts, real D1 and
 *                  Durable Objects), adds the CF-Connecting-IP the Cloudflare edge would, and stamps the
 *                  `Date` header the edge adds to every response
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { createSignedClient } from "../../ui/src/lib/api";
import { ServerClock } from "../../ui/src/lib/clock";
import { observeServerClock, type FetchLike } from "../../ui/src/lib/http";
import { createIdentityService, type IdentityService, type LockManagerLike } from "../../ui/src/lib/identity";
import { createKeystore, createCommunityKey, type CommunityKeyRecord, type KeyValueStore, type Keystore } from "../../ui/src/lib/keystore";
import { searchPow, type PowParams } from "../../ui/src/lib/pow";
import { ORIGIN, freshIp } from "../helpers";

export const HOST = new URL(ORIGIN).host;

export class MemoryStore implements KeyValueStore {
  readonly map = new Map<string, unknown>();
  failWith: Error | null = null;

  async get(key: string): Promise<unknown> {
    if (this.failWith) throw this.failWith;
    return this.map.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.map.set(key, value);
  }

  async del(key: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.map.delete(key);
  }
}

/** First-come, first-served mutex per lock name. */
export class FakeLocks implements LockManagerLike {
  readonly requested: string[] = [];
  active = 0;
  maxActive = 0;
  private tail: Promise<unknown> = Promise.resolve();

  request<T>(name: string, callback: () => Promise<T>): Promise<T> {
    this.requested.push(name);
    const run = async () => {
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        return await callback();
      } finally {
        this.active--;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export interface RecordedRequest {
  path: string;
  method: string;
  headers: Headers;
  status: number;
}

export interface Edge {
  fetch: FetchLike;
  requests: RecordedRequest[];
  /** Requests whose path (without query) equals `path`. */
  to(path: string): RecordedRequest[];
}

export interface EdgeOptions {
  /** Caller network. Challenge and registration must come from the same /24. */
  ip?: string;
  /** Do not stamp a Date header on responses to these paths (all paths when true). */
  omitDate?: boolean | string[];
  /** Replace the response to a request before it reaches the Worker. Return undefined to pass it through. */
  intercept?: (path: string, init: RequestInit, attempt: number) => Response | Promise<Response> | undefined;
  /** Send the request to the Worker twice and return the second response (the second is a real replay). */
  replayOnce?: (path: string) => boolean;
  /**
   * A Worker built with fake Workers AI and Vectorize (createWorld().worker). Without it the real entry
   * point is used, whose search bindings only exist remotely. Background work is awaited.
   */
  worker?: { fetch(request: Request, env: never, ctx: ExecutionContext): Response | Promise<Response> };
}

export function workerEdge(options: EdgeOptions = {}): Edge {
  const ip = options.ip ?? freshIp();
  const requests: RecordedRequest[] = [];
  const seen = new Map<string, number>();
  const replayed = new Set<string>();

  const withDate = (path: string, response: Response): Response => {
    const skip = options.omitDate === true || (Array.isArray(options.omitDate) && options.omitDate.includes(path.split("?")[0]!));
    if (skip) return response;
    const headers = new Headers(response.headers);
    headers.set("Date", new Date().toUTCString());
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };

  const toWorker = async (path: string, init: RequestInit): Promise<Response> => {
    // workerd rejects redirect: "error" and ignores cache/credentials; the browser accepts all three.
    const { redirect: _redirect, cache: _cache, credentials: _credentials, ...rest } = init as RequestInit & Record<string, unknown>;
    const headers = new Headers(rest.headers);
    headers.set("CF-Connecting-IP", ip);
    const request = new Request(ORIGIN + path, { ...rest, headers });
    if (!options.worker) return exports.default.fetch(request);
    const ctx = createExecutionContext();
    const response = await options.worker.fetch(request, env as never, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };

  const edgeFetch: FetchLike = async (path, init = {}) => {
    const route = path.split("?")[0]!;
    const attempt = (seen.get(route) ?? 0) + 1;
    seen.set(route, attempt);

    let response: Response | undefined = await options.intercept?.(path, init, attempt);
    if (response === undefined) {
      if (options.replayOnce?.(route) && !replayed.has(route)) {
        replayed.add(route);
        await toWorker(path, init); // consumes the nonce
      }
      response = await toWorker(path, init);
    }
    const stamped = withDate(path, response);
    requests.push({ path, method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers), status: stamped.status });
    return stamped;
  };

  return { fetch: edgeFetch, requests, to: (path) => requests.filter((request) => request.path.split("?")[0] === path) };
}

/** A Hashcash solver for tests: the search is fast at the test Worker's 16-bit difficulty. */
export function makeSolver() {
  const calls: PowParams[] = [];
  const solve = async (params: PowParams): Promise<{ nonce: string }> => {
    calls.push(params);
    const found = searchPow(params);
    if (!found) throw new Error("no nonce found");
    return { nonce: found.nonce };
  };
  return { solve, calls };
}

export interface IdentityHarness {
  service: IdentityService;
  keystore: Keystore;
  store: MemoryStore;
  locks: FakeLocks;
  edge: Edge;
  solver: ReturnType<typeof makeSolver>;
  /** Keys generated through this harness's createKey. */
  created: CommunityKeyRecord[];
}

/** A browser tab: identity service wired to fakes, talking to the real Worker unless `edge` is replaced. */
export function makeIdentity(shared: Partial<Pick<IdentityHarness, "store" | "locks" | "edge" | "solver">> & { fetch?: FetchLike } = {}): IdentityHarness {
  const store = shared.store ?? new MemoryStore();
  const locks = shared.locks ?? new FakeLocks();
  const edge = shared.edge ?? workerEdge();
  const solver = shared.solver ?? makeSolver();
  const keystore = createKeystore(store);
  const created: CommunityKeyRecord[] = [];
  const harness: IdentityHarness = { service: undefined as unknown as IdentityService, keystore, store, locks, edge, solver, created };
  harness.service = createIdentityService({
    keystore,
    fetch: shared.fetch ?? edge.fetch,
    solve: solver.solve,
    locks,
    createKey: async () => {
      const record = await createCommunityKey();
      created.push(record);
      return record;
    },
  });
  return harness;
}

/** A Response with the server's JSON error shape. */
export function errorResponse(status: number, code: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: false, error: code, code }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * A browser tab's signed client: the real identity flow and signedFetch against the real Worker.
 * `skewMs` moves the device clock; `observeRegistration` lets the (unsigned) registration responses teach
 * the clock, as the browser's shared fetch does.
 */
export function makeClient(options: EdgeOptions & { skewMs?: number; observeRegistration?: boolean } = {}) {
  const skewMs = options.skewMs ?? 0;
  const now = () => Date.now() + skewMs;
  const clock = new ServerClock();
  const edge = workerEdge(options);
  const tab = makeIdentity({ edge, fetch: options.observeRegistration ? observeServerClock(edge.fetch, clock, now) : edge.fetch });
  let resets = 0;
  const client = createSignedClient({
    identity: {
      getOrRegisterCommunityIdentity: (o) => tab.service.getOrRegisterCommunityIdentity(o),
      resetCommunityIdentity: async (key) => {
        resets++;
        await tab.service.resetCommunityIdentity(key);
      },
    },
    fetch: edge.fetch,
    clock,
    now,
    host: () => HOST,
  });
  return { ...client, clock, edge, tab, now, resets: () => resets };
}
