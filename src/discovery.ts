/**
 * Machine discovery: /robots.txt and the Agentic Resource Discovery (ARD) catalog.
 *
 *   GET /robots.txt                      which crawlers may read what
 *   GET /.well-known/ard.json            the catalog, at the path ARD v0.91 names
 *   GET /.well-known/ai-catalog.json     the same bytes, at ARD's predecessor path (still read by some clients)
 *
 * All three are public and static. src/index.ts routes them ahead of the Hono app, and wrangler.toml lists
 * them in [assets].run_worker_first, otherwise the SPA fallback would answer each with index.html.
 *
 * robots.txt is an allow-list: the public paths are allowed and everything else is disallowed. That keeps
 * every other path out of crawlers' reach without naming any of them in a public file.
 */
import { SECURITY_HEADERS } from "./app";
import { DEVSECOPS_PATH, FINTECH_PATH, INDUSTRIAL_IOT_PATH, SKILL_PATH, SKILL_PATHS } from "./skill";

export const ROBOTS_PATH = "/robots.txt";
export const ARD_PATH = "/.well-known/ard.json";
export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json";

/** The production origin. Fixed, not taken from the request, so the documents are the same on every host. */
export const SITE_ORIGIN = "https://mom.achromat.ai";

const FEED_PATH = "/api/v1/feed";

/**
 * Allow-list, Allow lines first: a parser that takes the longest match and one that takes the first match
 * reach the same answer. GPTBot (training) is shut out; OAI-SearchBot (search) falls under `*` and is allowed.
 * `Agentmap` points ARD consumers at the catalog and is ignored by parsers that do not know it.
 */
export const ROBOTS_TXT =
  [
    "User-agent: GPTBot",
    "Disallow: /",
    "",
    "User-agent: *",
    "Allow: /$",
    "Allow: /assets/",
    // The core protocol first, then the domain references.
    ...SKILL_PATHS.map((path) => `Allow: ${path}`),
    `Allow: ${ARD_PATH}`,
    `Allow: ${AI_CATALOG_PATH}`,
    `Allow: ${FEED_PATH}`,
    "Disallow: /",
    "",
    `Agentmap: ${SITE_ORIGIN}${ARD_PATH}`,
  ].join("\n") + "\n";

/**
 * One document for both catalog paths. ARD requires only `entries`; the AI Catalog format adds `specVersion`
 * and `host`. Both are present, so either kind of client can read it.
 */
export const CATALOG = {
  specVersion: "1.0",
  host: {
    displayName: "Achromat AI",
    identifier: "mom.achromat.ai",
    documentationUrl: `${SITE_ORIGIN}${SKILL_PATH}`,
    logoUrl: `${SITE_ORIGIN}/logo-light.png`,
  },
  entries: [
    {
      identifier: "urn:air:mom.achromat.ai:skill:achromat-mom",
      displayName: "Achromat MOM",
      type: "application/agent-skills+md",
      url: `${SITE_ORIGIN}${SKILL_PATH}`,
      description:
        "Verified memory of blocked agent actions and their compliant fixes. Register an agent identity, recall the compliant version of a tool call before acting, and calibrate against live policy when nothing is recalled.",
      capabilities: ["RecallCompliantArguments", "CalibratePolicy"],
      representativeQueries: [
        "check whether a tool call will be blocked by policy before running it",
        "find the compliant version of a blocked wire transfer",
        "learn from earlier policy blocks so my agent gets the call right the first time",
        "get verified safe arguments for an industrial robot command",
      ],
      tags: ["agent-memory", "policy", "compliance", "fintech", "industrial-iot", "devsecops"],
      // ARD allows only scalar values in `metadata` (each key is a `metadata.*` filter), so the API contact
      // points are flat keys: api* for the base and the way in, public* and signed* for the endpoints.
      metadata: {
        apiBaseUrl: `${SITE_ORIGIN}/api/v1`,
        apiAuthentication: "Ed25519-signed requests (skill document, section 3)",
        publicHealth: "GET /api/v1/health",
        publicFeed: `GET ${FEED_PATH}`,
        publicChallenge: "GET /api/v1/agents/challenge",
        publicRegister: "POST /api/v1/agents/register",
        signedRecall: "POST /api/v1/recall",
        signedCalibrate: "POST /api/v1/calibrate",
        signedIdentity: "GET /api/v1/agents/me",
      },
    },
    // One entry per domain reference. Each is a skill of its own, so a registry can index and rank them separately.
    // They build on the base entry above: identity, signing, recall and calibrate are in the core protocol.
    {
      identifier: "urn:air:mom.achromat.ai:skill:achromat-mom-fintech",
      displayName: "Achromat MOM for fintech",
      type: "application/agent-skills+md",
      url: `${SITE_ORIGIN}${FINTECH_PATH}`,
      description:
        "Tool schemas and placeholders for fintech agents: wire transfers and credit adverse action notices. Recall the verified compliant version of a payment or notice call before acting, and calibrate against live policy when nothing is recalled. Builds on the core protocol at /skill.md.",
      capabilities: ["RecallCompliantArguments", "CalibratePolicy"],
      representativeQueries: [
        "find the compliant version of a blocked wire transfer",
        "what arguments does a domestic wire need to pass dual control and sanctions screening",
        "check an adverse action notice call against policy before sending it",
      ],
      tags: ["agent-memory", "policy", "compliance", "fintech", "payments"],
      metadata: {
        domain: "fintech",
        tools: "dispatch_wire, issue_credit_adverse_action",
        coreProtocol: `${SITE_ORIGIN}${SKILL_PATH}`,
      },
    },
    {
      identifier: "urn:air:mom.achromat.ai:skill:achromat-mom-industrial-iot",
      displayName: "Achromat MOM for industrial IoT",
      type: "application/agent-skills+md",
      url: `${SITE_ORIGIN}${INDUSTRIAL_IOT_PATH}`,
      description:
        "Tool schemas and safety interlock placeholders for industrial IoT and robotics agents: manipulation and actuation commands. Recall verified compliant arguments before moving equipment, and calibrate against live policy when nothing is recalled. Builds on the core protocol at /skill.md.",
      capabilities: ["RecallCompliantArguments", "CalibratePolicy"],
      representativeQueries: [
        "get verified safe arguments for an industrial robot command",
        "check a manipulator motion command against safety policy before sending it",
        "what speed and interlock evidence does a collaborative robot move need to pass policy",
      ],
      tags: ["agent-memory", "policy", "compliance", "industrial-iot", "robotics", "safety"],
      metadata: {
        domain: "industrial_iot",
        tools: "dispatch_manipulation",
        coreProtocol: `${SITE_ORIGIN}${SKILL_PATH}`,
      },
    },
    {
      identifier: "urn:air:mom.achromat.ai:skill:achromat-mom-devsecops",
      displayName: "Achromat MOM for DevSecOps",
      type: "application/agent-skills+md",
      url: `${SITE_ORIGIN}${DEVSECOPS_PATH}`,
      description:
        "Expected tool shapes and environment and authorization placeholders for DevSecOps agents: commands, deployments and access grants. Recall verified compliant arguments before running a pipeline or operations action, and calibrate against live policy when nothing is recalled. Builds on the core protocol at /skill.md.",
      capabilities: ["RecallCompliantArguments", "CalibratePolicy"],
      representativeQueries: [
        "check a production deployment call against policy before running it",
        "find the compliant version of a blocked shell command in a pipeline",
        "what approval evidence does an access grant need to pass policy",
      ],
      tags: ["agent-memory", "policy", "compliance", "devsecops", "ci-cd"],
      metadata: {
        domain: "devsecops",
        tools: "execute_command, deploy_release, grant_access",
        coreProtocol: `${SITE_ORIGIN}${SKILL_PATH}`,
      },
    },
    {
      identifier: "urn:air:mom.achromat.ai:feed:approved-lessons",
      displayName: "Achromat MOM approved lessons",
      type: "application/json",
      url: `${SITE_ORIGIN}${FEED_PATH}`,
      description: "The newest approved lessons: each pairs a policy-blocked tool call with the compliant fix that was then allowed.",
      representativeQueries: [
        "show verified examples of blocked agent tool calls and their fixes",
        "browse approved compliance lessons for agent tool use",
      ],
    },
  ],
} as const;

/** The serialised catalog: identical bytes at both paths. */
export const CATALOG_BODY = `${JSON.stringify(CATALOG, null, 2)}\n`;

interface Document {
  contentType: string;
  body: string;
  headers: Record<string, string>;
}

/** Readable by browser-based validators too: the catalog is public and carries no credentials. */
const CORS = { "Access-Control-Allow-Origin": "*" };

const DOCUMENTS: Readonly<Record<string, Document>> = {
  [ROBOTS_PATH]: { contentType: "text/plain; charset=utf-8", body: ROBOTS_TXT, headers: { "Cache-Control": "public, max-age=3600" } },
  // ARD does not name a media type for ard.json; plain JSON is what every fetch tool and validator accepts.
  [ARD_PATH]: { contentType: "application/json; charset=utf-8", body: CATALOG_BODY, headers: { ...CORS, "Cache-Control": "public, max-age=300" } },
  // The AI Catalog format's own media type, which Hugging Face's catalog is also served with.
  [AI_CATALOG_PATH]: {
    contentType: "application/ai-catalog+json; charset=utf-8",
    body: CATALOG_BODY,
    headers: { ...CORS, "Cache-Control": "public, max-age=300" },
  },
};

/** The response for a discovery path, or null if the request is not one (so the caller carries on). */
export function discoveryResponse(method: string, pathname: string): Response | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (!Object.hasOwn(DOCUMENTS, pathname)) return null;
  const document = DOCUMENTS[pathname]!;
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", document.contentType);
  for (const [name, value] of Object.entries(document.headers)) headers.set(name, value);
  return new Response(method === "HEAD" ? null : document.body, { status: 200, headers });
}
