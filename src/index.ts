/**
 * achromat-mom Worker entry point. Routing and middleware live in src/app.ts.
 * The deployed Worker trusts only the pinned ramen-ai receipt keys and uses the
 * real Workers AI and Vectorize bindings.
 *
 * GET /skill.md (the core agent protocol), the three domain references (/fintech.md, /industrial_iot.md and
 * /devsecops.md, src/skill.ts) and the machine discovery documents (/robots.txt, the ARD catalog, the did:web
 * document and the MCP server card, src/discovery.ts) are routed here, ahead of the app. Each GET of a protocol
 * document writes one skill_view telemetry point (src/telemetry.ts) carrying the optional ?ref= tag.
 *
 * The public MCP sandbox (POST /mcp, OPTIONS for CORS, 405 for other methods; src/routes/mcp.ts) is served by
 * the app, like /api/*. wrangler.toml lists /mcp in run_worker_first so a GET never gets the SPA shell.
 *
 * Any other /.well-known path gets a JSON 404 (wellKnownNotFound), for every method, instead of the SPA shell.
 * Certificate validation paths are the exception: they go to the static assets exactly as they did before.
 */
import { createWorker, type MomWorker } from "./app";
import { discoveryResponse, isCertificateValidationPath, wellKnownNotFound } from "./discovery";
import { skillDocumentResponse } from "./skill";
import { recordTelemetryWith, refFromUrl } from "./telemetry";

export { NonceRegistry } from "./durable/nonce-registry";
export { UsageCounter } from "./durable/usage-counter";

const worker = createWorker();

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // wrangler.toml keeps these out of run_worker_first. If one reaches the Worker anyway, behave as if it had not.
    if (isCertificateValidationPath(pathname)) return env.ASSETS.fetch(request);
    if (request.method === "GET" || request.method === "HEAD") {
      const skill = skillDocumentResponse(request.method, pathname);
      if (skill) {
        // One skill_view per GET (not HEAD): the document name goes in the domain field, the ?ref= tag in blobs[5].
        if (request.method === "GET") {
          recordTelemetryWith(env, ctx, {
            action: "skill_view",
            domain: pathname.slice(1),
            tool: "",
            agentKey: null,
            status: "served",
            ref: refFromUrl(request.url),
          });
        }
        return skill;
      }
      const discovery = discoveryResponse(request.method, pathname);
      if (discovery) return discovery;
    }
    const missing = wellKnownNotFound(request.method, pathname);
    if (missing) return missing;
    return worker.fetch(request, env, ctx);
  },
  scheduled: (controller, env, ctx) => worker.scheduled(controller, env, ctx),
} satisfies MomWorker;
