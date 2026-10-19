/**
 * achromat-mom Worker entry point. Routing and middleware live in src/app.ts.
 * The deployed Worker trusts only the pinned ramen-ai receipt keys and uses the
 * real Workers AI and Vectorize bindings.
 *
 * GET /skill.md (the core agent protocol), the three domain references (/fintech.md, /industrial_iot.md and
 * /devsecops.md, src/skill.ts) and the machine discovery documents (/robots.txt and the ARD catalog,
 * src/discovery.ts) are routed here, ahead of the app.
 */
import { createWorker, type MomWorker } from "./app";
import { discoveryResponse } from "./discovery";
import { skillDocumentResponse } from "./skill";

export { NonceRegistry } from "./durable/nonce-registry";
export { UsageCounter } from "./durable/usage-counter";

const worker = createWorker();

export default {
  fetch(request, env, ctx) {
    if (request.method === "GET" || request.method === "HEAD") {
      const { pathname } = new URL(request.url);
      const skill = skillDocumentResponse(request.method, pathname);
      if (skill) return skill;
      const discovery = discoveryResponse(request.method, pathname);
      if (discovery) return discovery;
    }
    return worker.fetch(request, env, ctx);
  },
  scheduled: (controller, env, ctx) => worker.scheduled(controller, env, ctx),
} satisfies MomWorker;
