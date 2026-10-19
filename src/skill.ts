/**
 * The agent protocol documents, bundled into the Worker as text:
 *
 *   GET /skill.md           the core protocol: identity, request signing, recall and calibrate (public/skill.md)
 *   GET /fintech.md         fintech tool schemas and placeholders           (public/fintech.md)
 *   GET /industrial_iot.md  industrial IoT tool schemas and placeholders   (public/industrial_iot.md)
 *   GET /devsecops.md       devsecops tool shapes and placeholders          (public/devsecops.md)
 *
 * They are served as text/plain, not text/markdown: browsers show text/plain inline (so the link in the site header
 * opens it in a new tab), while an unfamiliar text subtype is typically downloaded. Agents read the bytes either way.
 *
 * The documents are public and static, so they are cacheable. src/index.ts routes them explicitly, ahead of the
 * Hono app, and wrangler.toml lists each path in [assets].run_worker_first so the SPA's not-found handling never
 * answers them first.
 */
import devsecopsMarkdown from "../public/devsecops.md";
import fintechMarkdown from "../public/fintech.md";
import industrialIotMarkdown from "../public/industrial_iot.md";
import skillMarkdown from "../public/skill.md";
import { SECURITY_HEADERS } from "./app";

export const SKILL_PATH = "/skill.md";
export const FINTECH_PATH = "/fintech.md";
export const INDUSTRIAL_IOT_PATH = "/industrial_iot.md";
export const DEVSECOPS_PATH = "/devsecops.md";

/** Every served document by path. The core protocol comes first. */
export const SKILL_DOCUMENTS: Readonly<Record<string, string>> = Object.freeze({
  [SKILL_PATH]: skillMarkdown,
  [FINTECH_PATH]: fintechMarkdown,
  [INDUSTRIAL_IOT_PATH]: industrialIotMarkdown,
  [DEVSECOPS_PATH]: devsecopsMarkdown,
});

/** The paths of the served documents, for routing and for the robots.txt allow-list. */
export const SKILL_PATHS: readonly string[] = Object.freeze(Object.keys(SKILL_DOCUMENTS));

/** True if `pathname` is one of the served documents. */
export function isSkillPath(pathname: string): boolean {
  return Object.hasOwn(SKILL_DOCUMENTS, pathname);
}

/** The response for a document path, or null if the path is not one (so the caller carries on). GET and HEAD only. */
export function skillDocumentResponse(method: string, pathname: string): Response | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (!isSkillPath(pathname)) return null;
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=300");
  return new Response(method === "HEAD" ? null : SKILL_DOCUMENTS[pathname]!, { status: 200, headers });
}

/** The core protocol document. Kept for callers that serve /skill.md directly. */
export function skillResponse(method: string): Response {
  return skillDocumentResponse(method, SKILL_PATH)!;
}
