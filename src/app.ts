/**
 * The achromat-mom Hono app and Worker handlers.
 *
 * Serves the agent API (/api/*) and the public MCP sandbox (POST /mcp, src/routes/mcp.ts). The admin review queue and the bounty board live under
 * /api/v1/admin and /api/v1/bounties, so they inherit the signed-request gate (an unsigned
 * /admin/* path would not). Every other path is answered by Workers Static Assets with the
 * React SPA (wrangler.toml [assets], run_worker_first).
 *
 * Every /api/v1 route requires an Ed25519-signed request except
 * the explicit public list below. Unknown paths fail closed: an unsigned request
 * gets 401 before routing can answer 404.
 *
 * createApp()/createWorker() take options only so tests can trust a throwaway
 * receipt key and replace Workers AI and Vectorize, which only run remotely.
 * The deployed Worker (src/index.ts) passes none, so it always trusts the pinned
 * ramen_pk_v1 and uses the real bindings; no binding, header or request can change that.
 */
import { Hono } from "hono";
import { RAMEN_RECEIPT_KEYS } from "./crypto/ramen-key";
import type { Env } from "./env";
import { requireAgentSignature, type AuthVariables } from "./middleware/auth";
import { reconcile } from "./review/pipeline";
import { createAdminRoutes } from "./routes/admin";
import { agents } from "./routes/agents";
import { createBountyRoutes } from "./routes/bounties";
import { createCalibrateRoutes } from "./routes/calibrate";
import { FEED_LESSON_PATH, FEED_PATH, createFeedRoutes } from "./routes/feed";
import { MCP_PATH, createMcpRoutes } from "./routes/mcp";
import { createRecallRoutes } from "./routes/recall";
import { createSearchRoutes } from "./routes/search";
import { defaultSearch, type SearchFactory } from "./search/vectors";

/** Same policy as ui/public/_headers, so API and SPA responses match. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
    "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

/** Unsigned /api/v1 endpoints, as "METHOD path". Everything else under /api/v1 is signed. */
const PUBLIC_API_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/v1/health",
  "HEAD /api/v1/health",
  "GET /api/v1/agents/challenge",
  "POST /api/v1/agents/register",
  "GET /api/v1/feed",
  "HEAD /api/v1/feed",
  "GET /api/v1/search",
]);

/** Unsigned: the fixed list above, plus reading one lesson by id (GET or HEAD /api/v1/feed/<uuid>). */
function isPublicApiRoute(method: string, path: string): boolean {
  return PUBLIC_API_ROUTES.has(`${method} ${path}`) || ((method === "GET" || method === "HEAD") && FEED_LESSON_PATH.test(path));
}

export interface AppOptions {
  /** ramen-ai receipt keys by kid (raw Ed25519 hex). Default: the pinned production keys. */
  receiptKeys?: Readonly<Record<string, string>>;
  /** Embedder and vector store. Default: the Workers AI and Vectorize bindings. */
  search?: SearchFactory;
  /** Distinct lessons a key may first receive per rolling 24 hours. Default 50; tests lower it. */
  recallDailyDistinctLessons?: number;
  /** Edge cache lifetime of GET /api/v1/feed in seconds. Default 30; tests pass 0 because they share one D1. */
  feedCacheSeconds?: number;
  /** Edge cache lifetime of the MCP sandbox's sample lessons in seconds. Default 300; tests pass 0. */
  mcpCacheSeconds?: number;
}

export function createApp(options: AppOptions = {}) {
  const search = options.search ?? defaultSearch;
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  });

  // Everything under /api is no-store, except a successful answer from the public feed, which sets its own
  // short public lifetime. Errors from the feed (400, 429, 503) stay no-store.
  app.use("/api/*", async (c, next) => {
    await next();
    if (c.req.path === FEED_PATH && c.res.status === 200 && c.res.headers.has("Cache-Control")) return;
    c.header("Cache-Control", "no-store");
  });

  const signed = requireAgentSignature();
  app.use("/api/v1/*", (c, next) =>
    isPublicApiRoute(c.req.method, c.req.path) ? next() : signed(c, next),
  );

  /** Liveness probe. Unauthenticated by design: it reads no data and touches no binding. */
  app.get("/api/v1/health", (c) => c.json({ success: true, service: "achromat-mom" }));

  app.route("/api/v1/agents", agents);
  app.route(FEED_PATH, createFeedRoutes({ ...(options.feedCacheSeconds === undefined ? {} : { cacheSeconds: options.feedCacheSeconds }) }));
  // Public natural-language search over approved lessons: no signature, no identity (src/routes/search.ts).
  app.route("/api/v1/search", createSearchRoutes({ search }));
  // Role-gated on top of the signed gate above: admin only, and admin or internal for the bounty board.
  app.route("/api/v1/admin", createAdminRoutes({ search, receiptKeys: options.receiptKeys ?? RAMEN_RECEIPT_KEYS }));
  app.route("/api/v1/bounties", createBountyRoutes());
  app.route("/api/v1/calibrate", createCalibrateRoutes({ receiptKeys: options.receiptKeys ?? RAMEN_RECEIPT_KEYS, search }));
  app.route(
    "/api/v1/recall",
    createRecallRoutes({
      search,
      ...(options.recallDailyDistinctLessons === undefined ? {} : { dailyDistinctLessons: options.recallDailyDistinctLessons }),
    }),
  );

  // Public MCP sandbox (Streamable HTTP). Outside /api/v1, so the signed gate never applies to it.
  app.route(MCP_PATH, createMcpRoutes({ ...(options.mcpCacheSeconds === undefined ? {} : { cacheSeconds: options.mcpCacheSeconds }) }));

  app.notFound((c) => c.json({ success: false, error: "not found" }, 404));

  app.onError((error, c) => {
    console.error("achromat-mom unhandled error", error);
    return c.json({ success: false, error: "internal error" }, 500);
  });

  return app;
}

export interface MomWorker {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
  /** Cron (every 5 minutes): retries triage and Vectorize sync that the request-time run did not finish. */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
}

export function createWorker(options: AppOptions = {}): MomWorker {
  const app = createApp(options);
  const search = options.search ?? defaultSearch;
  return {
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    async scheduled(_controller, env) {
      const result = await reconcile(env, search(env));
      console.log("achromat-mom reconcile", JSON.stringify(result));
    },
  };
}
