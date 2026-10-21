/**
 * Machine discovery: /robots.txt, the Agentic Resource Discovery (ARD) catalog, the did:web identity document,
 * the MCP server card, and a strict 404 for every other /.well-known path.
 *
 *   GET /robots.txt                          which crawlers may read what
 *   GET /.well-known/ard.json                the catalog, at the path ARD v0.91 names
 *   GET /.well-known/ai-catalog.json         the same bytes, at ARD's predecessor path (still read by some clients)
 *   GET /.well-known/did.json                the did:web document that the catalog's trustManifest points at
 *   GET /.well-known/mcp/server-card.json    the MCP server card that the catalog's MCP entry points at; its
 *                                            `remotes` names the public sandbox at POST /mcp (src/routes/mcp.ts)
 *   any /.well-known/<anything else>         404 with a JSON body (never the SPA shell)
 *
 * All of them are public and static. src/index.ts routes them ahead of the Hono app, and wrangler.toml lists
 * /.well-known/* in [assets].run_worker_first, otherwise the SPA fallback would answer each of them (and every
 * unknown /.well-known path) with index.html and a 200. Certificate validation paths (acme-challenge and
 * pki-validation) are the one exception: they are excluded from run_worker_first and, if a request for one ever
 * does reach the Worker, it is handed to the static assets exactly as before (src/index.ts).
 *
 * robots.txt is an allow-list: the public paths are allowed and everything else is disallowed. That keeps
 * every other path out of crawlers' reach without naming any of them in a public file.
 */
import { SECURITY_HEADERS } from "./app";
import { MCP_PATH } from "./routes/mcp";
import { DEVSECOPS_PATH, FINTECH_PATH, INDUSTRIAL_IOT_PATH, SKILL_PATH, SKILL_PATHS } from "./skill";

export const ROBOTS_PATH = "/robots.txt";
export const ARD_PATH = "/.well-known/ard.json";
export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json";
export const DID_PATH = "/.well-known/did.json";
export const MCP_CARD_PATH = "/.well-known/mcp/server-card.json";

/** The production origin. Fixed, not taken from the request, so the documents are the same on every host. */
export const SITE_ORIGIN = "https://mom.achromat.ai";

const FEED_PATH = "/api/v1/feed";

// ───────────────────────────── identity: did:web, and the trustManifest that points at it ─────────────────────────────

/** did:web for this host. It resolves to https://mom.achromat.ai/.well-known/did.json (DID_PATH). */
export const DID = `did:web:${new URL(SITE_ORIGIN).hostname}`;

/**
 * The verification key id and its public key. This is the key that already signs every pair attestation
 * (src/crypto/attestation.ts, kid mom_pk_v1), so anyone can check a lesson's attestation against the DID.
 * `publicKeyMultibase` is 'z' + base58btc(0xed01 || the 32-byte public key), the Multikey form of Ed25519.
 * A test pins it to MOM_ATTESTATION_PUBLIC_KEYS.mom_pk_v1, so the two cannot drift. To rotate, add a second
 * verification method next to this one rather than replacing it.
 */
export const DID_KEY_ID = `${DID}#mom_pk_v1`;
const MOM_PK_V1_MULTIBASE = "z6MknXnmme28mD9gDQNNgroXvWWo4Fz6cuakTXonPqLy38z6";

export const DID_DOCUMENT = {
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
  id: DID,
  verificationMethod: [
    {
      id: DID_KEY_ID,
      type: "Multikey",
      controller: DID,
      publicKeyMultibase: MOM_PK_V1_MULTIBASE,
    },
  ],
  authentication: [DID_KEY_ID],
  assertionMethod: [DID_KEY_ID],
} as const;

/**
 * ARD trustManifest (spec section 4.5). ARD requires only `identity`, and its trust domain must match the
 * publisher segment of every entry's URN (urn:air:mom.achromat.ai:...). It goes on the host and on every entry:
 * the AI Catalog schema allows it there and does NOT allow it at the document root.
 */
export const TRUST_MANIFEST = {
  identity: DID,
  identityType: "did",
  trustSchema: {
    identifier: "https://www.w3.org/TR/did-core/",
    version: "1.0",
    verificationMethods: ["did"],
  },
} as const;

// ───────────────────────────── MCP server card ─────────────────────────────

export const MCP_PACKAGE = "@achromat-ai/mcp-server";
/** Keep in step with the published npm package. */
export const MCP_SERVER_VERSION = "0.1.1";

/** The public MCP sandbox on this origin (src/routes/mcp.ts): Streamable HTTP, no authentication. */
export const MCP_REMOTE_URL = `${SITE_ORIGIN}${MCP_PATH}`;

/**
 * A card describes how a client reaches a server. This origin hosts one remote endpoint, the public sandbox
 * (`remotes`: Streamable HTTP, no auth, sample lessons through achromat_recall only). The full server is the local
 * stdio npm package; its install details sit in a vendor-namespaced `_meta` key, the card format's own extension point.
 */
export const MCP_SERVER_CARD = {
  $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  name: "ai.achromat/mcp-server",
  title: "Achromat Machine Operational Memory",
  description: "Policy lessons for agent tool calls: a public sandbox here, full recall and calibrate via npm.",
  version: MCP_SERVER_VERSION,
  websiteUrl: SITE_ORIGIN,
  icons: [{ src: `${SITE_ORIGIN}/logo-light.png`, mimeType: "image/png", theme: "light" }],
  remotes: [{ type: "streamable-http", url: MCP_REMOTE_URL }],
  _meta: {
    "ai.achromat/distribution": {
      registryType: "npm",
      identifier: MCP_PACKAGE,
      version: MCP_SERVER_VERSION,
      transport: { type: "stdio" },
      command: "npx",
      args: ["-y", MCP_PACKAGE],
    },
  },
} as const;

// ───────────────────────────── robots.txt ─────────────────────────────

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
    `Allow: ${DID_PATH}`,
    `Allow: ${MCP_CARD_PATH}`,
    `Allow: ${FEED_PATH}`,
    // The public MCP sandbox, exactly (the $ keeps any longer path under the Disallow below).
    `Allow: ${MCP_PATH}$`,
    "Disallow: /",
    "",
    `Agentmap: ${SITE_ORIGIN}${ARD_PATH}`,
  ].join("\n") + "\n";

// ───────────────────────────── the catalog ─────────────────────────────

/** ARD's own name for a markdown skill. */
export const AGENT_SKILL_TYPE = "application/agent-skills+md";
/** What Hugging Face's Discover service emits and filters on for skills. */
export const AI_SKILL_TYPE = "application/ai-skill";
export const MCP_CARD_TYPE = "application/mcp-server-card+json";

type TrustManifest = typeof TRUST_MANIFEST;
type Scalar = string | number | boolean | null;

/** A catalog entry as published. A type alias (not an interface) so it also reads as a plain string-keyed record. */
export type CatalogEntry = {
  identifier: string;
  displayName: string;
  type: string;
  url: string;
  version?: string;
  description?: string;
  capabilities?: readonly string[];
  representativeQueries?: readonly string[];
  tags?: readonly string[];
  // ARD allows only scalar values in `metadata` (each key is a `metadata.*` filter).
  metadata?: Readonly<Record<string, Scalar>>;
  trustManifest?: TrustManifest;
};

/** The four skills, typed as ARD names them. Order matters: entries[0] is the base protocol. */
const SKILL_ENTRIES: readonly CatalogEntry[] = [
  {
    identifier: "urn:air:mom.achromat.ai:skill:achromat-mom",
    displayName: "Achromat Machine Operational Memory",
    type: AGENT_SKILL_TYPE,
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
    // The API contact points are flat keys: api* for the base and the way in, public* and signed* for the endpoints.
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
    displayName: "Achromat Machine Operational Memory for fintech",
    type: AGENT_SKILL_TYPE,
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
    displayName: "Achromat Machine Operational Memory for industrial IoT",
    type: AGENT_SKILL_TYPE,
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
    displayName: "Achromat Machine Operational Memory for DevSecOps",
    type: AGENT_SKILL_TYPE,
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
];

/**
 * Each skill is published twice, once under ARD's own media type and once under the type Hugging Face's Discover
 * filters on, so a consumer that filters by either finds it. The twin is generated from the original, so the two
 * can never differ except in `type` and `identifier` (`:skill:` becomes `:ai-skill:`, which keeps the URN unique).
 * Both point at the same document.
 */
const AI_SKILL_ENTRIES: readonly CatalogEntry[] = SKILL_ENTRIES.map((entry) => ({
  ...entry,
  identifier: entry.identifier.replace(":skill:", ":ai-skill:"),
  type: AI_SKILL_TYPE,
}));

const MCP_ENTRY: CatalogEntry = {
  identifier: "urn:air:mom.achromat.ai:server:achromat-mom-mcp",
  displayName: "Achromat Machine Operational Memory MCP server",
  type: MCP_CARD_TYPE,
  // The server card, not the npm page: `url` addresses the artifact document. The package is named in the card.
  url: `${SITE_ORIGIN}${MCP_CARD_PATH}`,
  version: MCP_SERVER_VERSION,
  description:
    "Achromat Machine Operational Memory over MCP. A public Streamable HTTP sandbox at /mcp (no authentication) returns sample verified lessons through achromat_recall; the full npm server (stdio) gives any MCP host recall and calibrate tools.",
  capabilities: ["RecallCompliantArguments", "CalibratePolicy", "RegisterIdentity", "RecallSampleLessons"],
  representativeQueries: [
    "add policy-checked memory of blocked tool calls to my MCP host",
    "install an MCP server that recalls the compliant version of a tool call",
    "check an agent tool call against live policy from Claude Desktop",
    "try a remote MCP server with sample compliance lessons without installing anything",
  ],
  tags: ["mcp", "agent-memory", "policy", "compliance", "npm", "stdio", "streamable-http", "remote"],
  // Scalars only (ARD). The package* keys describe the npm server, the remote* keys the sandbox on this origin.
  metadata: {
    npmPackage: MCP_PACKAGE,
    packageRegistry: "npm",
    packageTransport: "stdio",
    command: `npx -y ${MCP_PACKAGE}`,
    remoteUrl: MCP_REMOTE_URL,
    remoteTransport: "streamable-http",
    remoteAuthentication: "none",
    remoteScope: "sandbox: sample approved lessons through achromat_recall only",
    coreProtocol: `${SITE_ORIGIN}${SKILL_PATH}`,
  },
};

const FEED_ENTRY: CatalogEntry = {
  identifier: "urn:air:mom.achromat.ai:feed:approved-lessons",
  displayName: "Achromat Machine Operational Memory approved lessons",
  type: "application/json",
  url: `${SITE_ORIGIN}${FEED_PATH}`,
  description: "The newest approved lessons: each pairs a policy-blocked tool call with the compliant fix that was then allowed.",
  representativeQueries: [
    "show verified examples of blocked agent tool calls and their fixes",
    "browse approved compliance lessons for agent tool use",
  ],
};

/**
 * One document for both catalog paths. ARD requires only `entries`; the AI Catalog format adds `specVersion`
 * and `host`. Both are present, so either kind of client can read it. `trustManifest` is on the host and on
 * every entry, never at the root (the AI Catalog schema rejects extra root properties).
 */
export const CATALOG = {
  specVersion: "1.0",
  host: {
    displayName: "Achromat AI",
    identifier: DID,
    documentationUrl: `${SITE_ORIGIN}${SKILL_PATH}`,
    logoUrl: `${SITE_ORIGIN}/logo-light.png`,
    trustManifest: TRUST_MANIFEST,
  },
  entries: [...SKILL_ENTRIES, ...AI_SKILL_ENTRIES, MCP_ENTRY, FEED_ENTRY].map(
    (entry): CatalogEntry => ({ ...entry, trustManifest: TRUST_MANIFEST }),
  ),
};

/** The serialised catalog: identical bytes at both paths. */
export const CATALOG_BODY = `${JSON.stringify(CATALOG, null, 2)}\n`;
export const DID_BODY = `${JSON.stringify(DID_DOCUMENT, null, 2)}\n`;
export const MCP_CARD_BODY = `${JSON.stringify(MCP_SERVER_CARD, null, 2)}\n`;

// ───────────────────────────── serving ─────────────────────────────

interface Document {
  contentType: string;
  body: string;
  headers: Record<string, string>;
}

/** Readable by browser-based validators and resolvers too: these documents are public and carry no credentials. */
const CORS = { "Access-Control-Allow-Origin": "*" };
const JSON_TYPE = "application/json; charset=utf-8";
const PUBLIC_5_MIN = { ...CORS, "Cache-Control": "public, max-age=300" };

const DOCUMENTS: Readonly<Record<string, Document>> = {
  [ROBOTS_PATH]: { contentType: "text/plain; charset=utf-8", body: ROBOTS_TXT, headers: { "Cache-Control": "public, max-age=3600" } },
  // ARD does not name a media type for ard.json; plain JSON is what every fetch tool and validator accepts.
  [ARD_PATH]: { contentType: JSON_TYPE, body: CATALOG_BODY, headers: PUBLIC_5_MIN },
  // The AI Catalog format's own media type, which Hugging Face's catalog is also served with.
  [AI_CATALOG_PATH]: { contentType: "application/ai-catalog+json; charset=utf-8", body: CATALOG_BODY, headers: PUBLIC_5_MIN },
  // The did:web method expects a DID document to be fetchable as plain JSON.
  [DID_PATH]: { contentType: JSON_TYPE, body: DID_BODY, headers: PUBLIC_5_MIN },
  [MCP_CARD_PATH]: { contentType: JSON_TYPE, body: MCP_CARD_BODY, headers: PUBLIC_5_MIN },
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

// ───────────────────────────── the /.well-known shield ─────────────────────────────

const WELL_KNOWN = "/.well-known";
/** Certificate authorities validate domain control here. Nothing in this file may ever answer these paths. */
const CERTIFICATE_VALIDATION_PREFIXES = ["/.well-known/acme-challenge/", "/.well-known/pki-validation/"] as const;
const NOT_FOUND_BODY = `${JSON.stringify({ success: false, error: "not found" })}\n`;

/** /.well-known itself, or anything below it. */
export function isWellKnownPath(pathname: string): boolean {
  return pathname === WELL_KNOWN || pathname.startsWith(`${WELL_KNOWN}/`);
}

/** The ACME and PKI validation paths. src/index.ts hands these to the static assets untouched. */
export function isCertificateValidationPath(pathname: string): boolean {
  return CERTIFICATE_VALIDATION_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * A strict 404 for any /.well-known path that is not a document above, for every method. Without it the SPA
 * fallback answers 200 with index.html, which registry parsers choke on. Returns null for paths that are not
 * under /.well-known and for certificate validation paths, so the caller carries on.
 */
export function wellKnownNotFound(method: string, pathname: string): Response | null {
  if (!isWellKnownPath(pathname) || isCertificateValidationPath(pathname)) return null;
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", JSON_TYPE);
  headers.set("Cache-Control", "public, max-age=60");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(method === "HEAD" ? null : NOT_FOUND_BODY, { status: 404, headers });
}
