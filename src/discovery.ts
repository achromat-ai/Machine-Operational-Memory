/**
 * Machine discovery: /robots.txt, the Agentic Resource Discovery (ARD) catalog, the did:web identity document,
 * the MCP server card, and a strict 404 for every other /.well-known path.
 *
 * The documents describe SITE_ORIGIN (achromat.ai) on every host. The one exception is the DID document: the request's
 * Host selects it, so the legacy host mom.achromat.ai gets LEGACY_DID_DOCUMENT (see LEGACY_HOST).
 *
 *   GET /robots.txt                          which crawlers may read what
 *   GET /.well-known/ard.json                the catalog, at the path ARD v0.91 names
 *   GET /.well-known/ai-catalog.json         the same bytes, at ARD's predecessor path (still read by some clients)
 *   GET /.well-known/did.json                the did:web document that the catalog's trustManifest points at
 *   GET /.well-known/mcp/server-card.json    the MCP server card that the catalog's MCP entry points at; its
 *                                            `remotes` names the public sandbox at POST /mcp (src/routes/mcp.ts)
 *   any /.well-known/<anything else>         404 with a JSON body (never the SPA shell)
 *   /llms.txt, /llms-full.txt, /sitemap.xml, /sitemap_index.xml, /agents.md
 *                                            404 with a JSON body (the top-level paths crawlers probe for)
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
import {
  AGENT_SKILLS_DIR,
  COMPLIANCE_PROVENANCE_PATH,
  CONTRACTUAL_ELIGIBILITY_PATH,
  DEVSECOPS_PATH,
  FINTECH_PATH,
  INDUSTRIAL_IOT_PATH,
  SKILL_PATH,
  SKILL_PATHS,
} from "./skill";

export const ROBOTS_PATH = "/robots.txt";
export const ARD_PATH = "/.well-known/ard.json";
export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json";
export const DID_PATH = "/.well-known/did.json";
export const MCP_CARD_PATH = "/.well-known/mcp/server-card.json";

/** The production origin. Fixed, not taken from the request, so the documents are the same on every host. */
export const SITE_ORIGIN = "https://achromat.ai";

/**
 * The host the service was first published on. It keeps answering the API (/api/*), the MCP sandbox (/mcp) and its own
 * DID document indefinitely: every request signature covers the host, so clients that signed for it must keep working.
 * A Cloudflare Redirect Rule (not this Worker) sends its other GET and HEAD traffic to SITE_ORIGIN.
 */
export const LEGACY_HOST = "mom.achromat.ai";

/** The publisher segment of every ARD URN (urn:air:<publisher>:...). It must equal the trust domain of the DID. */
const PUBLISHER = new URL(SITE_ORIGIN).hostname;

const FEED_PATH = "/api/v1/feed";

// ───────────────────────────── identity: did:web, and the trustManifest that points at it ─────────────────────────────

/** did:web for this host. It resolves to https://achromat.ai/.well-known/did.json (DID_PATH). */
export const DID = `did:web:${PUBLISHER}`;

/** The did:web of the original host. Its document is served on that host only (LEGACY_DID_DOCUMENT). */
export const LEGACY_DID = `did:web:${LEGACY_HOST}`;

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

export const LEGACY_DID_KEY_ID = `${LEGACY_DID}#mom_pk_v1`;

/**
 * The DID document for the original host, served only when the request's Host is LEGACY_HOST. A did:web resolver
 * requires the document `id` to equal the DID it resolved, so redirecting this path to the new host would break
 * resolution of did:web:mom.achromat.ai. It carries the same key as DID_DOCUMENT, and `alsoKnownAs` points at the new DID.
 */
export const LEGACY_DID_DOCUMENT = {
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
  id: LEGACY_DID,
  alsoKnownAs: [DID],
  verificationMethod: [
    {
      id: LEGACY_DID_KEY_ID,
      type: "Multikey",
      controller: LEGACY_DID,
      publicKeyMultibase: MOM_PK_V1_MULTIBASE,
    },
  ],
  authentication: [LEGACY_DID_KEY_ID],
  assertionMethod: [LEGACY_DID_KEY_ID],
} as const;

/**
 * ARD trustManifest (spec section 4.5). ARD requires only `identity`, and its trust domain must match the
 * publisher segment of every entry's URN (urn:air:achromat.ai:...). It goes on the host and on every entry:
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
/** The server's name in the Official MCP Registry (server.json `name` in the package repository). */
export const MCP_REGISTRY_NAME = "ai.achromat/mcp-server";
/** The registry's record of the latest published listing for MCP_REGISTRY_NAME. Public, unauthenticated. */
export const MCP_REGISTRY_LATEST_URL = `https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(MCP_REGISTRY_NAME)}/versions/latest`;

/**
 * The two version numbers the discovery documents state. They are separate counters: `server` is the registry
 * listing's own version (server.json `version`), `package` is the npm release that listing points at
 * (server.json `packages[0].version`). The listing may run ahead of npm, so the two can differ.
 */
export interface McpVersions {
  readonly server: string;
  readonly package: string;
}

/**
 * What the documents state until the registry has answered, and whenever it cannot be read or answers with
 * something unexpected. The latest listing at 2026-11-21. A stale value here is harmless: it is replaced as soon as
 * the registry answers, so it never has to be bumped with a release.
 */
export const MCP_VERSIONS_FALLBACK: McpVersions = Object.freeze({ server: "0.1.6", package: "0.1.5" });
/** How long one registry answer is used before it is fetched again. */
export const MCP_VERSION_CACHE_MS = 15 * 60_000;
/** After a failed fetch, how long the last known versions are used before the registry is tried again. */
export const MCP_VERSION_RETRY_MS = 60_000;
/** A discovery response never waits longer than this for the registry. */
export const MCP_REGISTRY_TIMEOUT_MS = 2_000;
/** The registry record is a few KB; anything far larger is not the record. */
const MCP_REGISTRY_MAX_BYTES = 256 * 1024;

/** An exact semantic version (no ranges, no leading "v"), as the registry stores it. */
const EXACT_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The versions in a registry record, or null when the record is not the expected server's or holds no usable
 * server version. A missing or malformed npm package version keeps the fallback's package version.
 */
export function parseRegistryVersions(record: unknown): McpVersions | null {
  const server = isRecordLike(record) ? record.server : undefined;
  if (!isRecordLike(server) || server.name !== MCP_REGISTRY_NAME) return null;
  if (typeof server.version !== "string" || !EXACT_VERSION.test(server.version)) return null;
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const npm = packages.find((entry): entry is Record<string, unknown> => isRecordLike(entry) && entry.registryType === "npm" && entry.identifier === MCP_PACKAGE);
  const packageVersion = npm && typeof npm.version === "string" && EXACT_VERSION.test(npm.version) ? npm.version : MCP_VERSIONS_FALLBACK.package;
  return { server: server.version, package: packageVersion };
}

let versionCache: { versions: McpVersions; expiresAtMs: number } | null = null;
let versionRefresh: Promise<McpVersions> | null = null;

/** Sets the cached versions, for tests (and anything that wants to skip the first fetch). */
export function primeMcpVersions(versions: McpVersions, ttlMs: number, nowMs = Date.now()): void {
  versionCache = { versions, expiresAtMs: nowMs + ttlMs };
}

/** Forgets the cached versions, for tests. */
export function resetMcpVersions(): void {
  versionCache = null;
  versionRefresh = null;
}

async function fetchRegistryVersions(): Promise<McpVersions | null> {
  try {
    const response = await fetch(MCP_REGISTRY_LATEST_URL, {
      headers: { Accept: "application/json", "User-Agent": `achromat-mom (+${SITE_ORIGIN})` },
      signal: AbortSignal.timeout(MCP_REGISTRY_TIMEOUT_MS),
      // Cloudflare caches the answer at the edge for the same 15 minutes, so isolates share it.
      cf: { cacheTtl: MCP_VERSION_CACHE_MS / 1000, cacheEverything: true },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const text = await response.text();
    if (text.length > MCP_REGISTRY_MAX_BYTES) return null;
    return parseRegistryVersions(JSON.parse(text));
  } catch (error) {
    console.error("achromat-mom registry version lookup failed", error instanceof Error ? error.name : "error");
    return null;
  }
}

/**
 * The versions the discovery documents state: the registry's latest listing, cached for MCP_VERSION_CACHE_MS.
 * Never throws and never waits more than MCP_REGISTRY_TIMEOUT_MS. When the registry cannot be read, the last known
 * versions (or MCP_VERSIONS_FALLBACK) are used and the registry is tried again after MCP_VERSION_RETRY_MS.
 * Concurrent requests share one fetch.
 */
export function resolveMcpVersions(nowMs = Date.now()): Promise<McpVersions> {
  if (versionCache !== null && nowMs < versionCache.expiresAtMs) return Promise.resolve(versionCache.versions);
  versionRefresh ??= fetchRegistryVersions().then((fetched) => {
    const known = versionCache?.versions ?? MCP_VERSIONS_FALLBACK;
    const versions = fetched ?? known;
    versionCache = { versions, expiresAtMs: Date.now() + (fetched ? MCP_VERSION_CACHE_MS : MCP_VERSION_RETRY_MS) };
    versionRefresh = null;
    return versions;
  });
  return versionRefresh;
}

/** The public MCP sandbox on this origin (src/routes/mcp.ts): Streamable HTTP, no authentication. */
export const MCP_REMOTE_URL = `${SITE_ORIGIN}${MCP_PATH}`;

/**
 * A card describes how a client reaches a server. This origin hosts one remote endpoint, the public sandbox
 * (`remotes`: Streamable HTTP, no auth, sample lessons through achromat_recall only). The full server is the local
 * stdio npm package; its install details sit in a vendor-namespaced `_meta` key, the card format's own extension point.
 * `version` is the registry listing's version, and the distribution's `version` is the npm release it points at.
 */
export function mcpServerCard(versions: McpVersions) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: MCP_REGISTRY_NAME,
    title: "Achromat Machine Operational Memory",
    description:
      "Achromat Machine Operational Memory recalls compliant tool-call arguments for fintech payments, corporate spend and credit decisions, industrial and robot actuation, DevSecOps commands, deployments and access changes, contractual eligibility decisions and compliance filings. The public sandbox returns sample lessons; the npm server provides full recall and calibration. It does not execute the underlying business tool.",
    version: versions.server,
    websiteUrl: SITE_ORIGIN,
    icons: [{ src: `${SITE_ORIGIN}/logo-light.png`, mimeType: "image/png", theme: "light" }],
    remotes: [{ type: "streamable-http", url: MCP_REMOTE_URL }],
    _meta: {
      "ai.achromat/distribution": {
        registryType: "npm",
        identifier: MCP_PACKAGE,
        version: versions.package,
        transport: { type: "stdio" },
        command: "npx",
        args: ["-y", MCP_PACKAGE],
      },
    },
  } as const;
}

/** The card with the fallback versions: what is served before the registry has answered. */
export const MCP_SERVER_CARD = mcpServerCard(MCP_VERSIONS_FALLBACK);

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
    // The Agent Skills index and each skill's conventional SKILL.md path (src/agent-skills.ts).
    `Allow: ${AGENT_SKILLS_DIR}/`,
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

/** The six skills, typed as ARD names them. Order matters: entries[0] is the base protocol. */
const SKILL_ENTRIES: readonly CatalogEntry[] = [
  {
    identifier: `urn:air:${PUBLISHER}:skill:achromat-mom`,
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
    tags: ["agent-memory", "policy", "compliance", "fintech", "industrial-iot", "devsecops", "contractual-eligibility", "compliance-provenance"],
    // The API contact points are flat keys: api* for the base and the way in, public* and signed* for the endpoints.
    metadata: {
      apiBaseUrl: `${SITE_ORIGIN}/api/v1`,
      apiAuthentication: "Ed25519-signed requests (skill document, section 3)",
      publicHealth: "GET /api/v1/health",
      publicFeed: `GET ${FEED_PATH}`,
      publicChallenge: "GET /api/v1/agents/challenge",
      publicRecall: "POST /api/v1/recall (no signature: public approved lessons only)",
      publicRegister: "POST /api/v1/agents/register",
      signedRecall: "POST /api/v1/recall",
      signedCalibrate: "POST /api/v1/calibrate",
      signedIdentity: "GET /api/v1/agents/me",
    },
  },
  // One entry per domain reference. Each is a skill of its own, so a registry can index and rank them separately.
  // They build on the base entry above: identity, signing, recall and calibrate are in the core protocol.
  {
    identifier: `urn:air:${PUBLISHER}:skill:achromat-mom-fintech`,
    displayName: "Achromat Machine Operational Memory for fintech",
    type: AGENT_SKILL_TYPE,
    url: `${SITE_ORIGIN}${FINTECH_PATH}`,
    description:
      "Tool schemas and placeholders for fintech agents: wire transfers, credit adverse action notices, and corporate spend (budget commitment, expenditure approval, payment release). Recall the verified compliant version of a payment, spend or notice call before acting, and calibrate against live policy when nothing is recalled. Builds on the core protocol at /skill.md.",
    capabilities: ["RecallCompliantArguments", "CalibratePolicy"],
    representativeQueries: [
      "find the compliant version of a blocked wire transfer",
      "what arguments does a domestic wire need to pass dual control and sanctions screening",
      "check an adverse action notice call against policy before sending it",
      "what budget clearance and dual approval evidence does a corporate payment release need",
    ],
    tags: ["agent-memory", "policy", "compliance", "fintech", "payments", "corporate-spend"],
    metadata: {
      domain: "fintech",
      tools: "dispatch_wire, issue_credit_adverse_action, commit_corporate_spend, approve_expenditure, release_payment",
      coreProtocol: `${SITE_ORIGIN}${SKILL_PATH}`,
    },
  },
  {
    identifier: `urn:air:${PUBLISHER}:skill:achromat-mom-industrial-iot`,
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
    identifier: `urn:air:${PUBLISHER}:skill:achromat-mom-devsecops`,
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
  {
    identifier: `urn:air:${PUBLISHER}:skill:achromat-mom-contractual-eligibility`,
    displayName: "Achromat Machine Operational Memory for contractual eligibility",
    type: AGENT_SKILL_TYPE,
    url: `${SITE_ORIGIN}${CONTRACTUAL_ELIGIBILITY_PATH}`,
    description:
      "Tool schemas and evidence placeholders for agents that approve claims, confirm eligibility and bind contract terms. Recall the verified compliant version of a claim or contract call before acting, and calibrate against live policy when nothing is recalled. Builds on the core protocol at /skill.md.",
    capabilities: ["RecallCompliantArguments", "CalibratePolicy"],
    representativeQueries: [
      "check an insurance claim approval call against policy before sending it",
      "what policy record and inspection evidence does an eligibility confirmation need",
      "find the compliant version of a blocked contract term binding",
    ],
    tags: ["agent-memory", "policy", "compliance", "contractual-eligibility", "insurance", "claims"],
    metadata: {
      domain: "contractual_eligibility",
      tools: "approve_eligibility_claim, confirm_eligibility, bind_contract_terms",
      coreProtocol: `${SITE_ORIGIN}${SKILL_PATH}`,
    },
  },
  {
    identifier: `urn:air:${PUBLISHER}:skill:achromat-mom-compliance-provenance`,
    displayName: "Achromat Machine Operational Memory for compliance provenance",
    type: AGENT_SKILL_TYPE,
    url: `${SITE_ORIGIN}${COMPLIANCE_PROVENANCE_PATH}`,
    description:
      "Tool schemas and evidence placeholders for agents that submit regulated records and filings or release compliance reports backed by signed receipts. Recall the verified compliant version of a submission before acting, and calibrate against live policy when nothing is recalled. Builds on the core protocol at /skill.md.",
    capabilities: ["RecallCompliantArguments", "CalibratePolicy"],
    representativeQueries: [
      "check a regulatory filing submission against provenance policy before sending it",
      "what receipt evidence does a regulated record submission need to pass policy",
      "find the compliant version of a blocked compliance report release",
    ],
    tags: ["agent-memory", "policy", "compliance", "compliance-provenance", "regulatory-filing", "audit"],
    metadata: {
      domain: "compliance_provenance",
      tools: "submit_regulated_record, submit_filing, release_report",
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

/** The catalog's MCP entry. Its `version` is the registry listing's, the same as the card's. */
function mcpEntry(versions: McpVersions): CatalogEntry {
  return {
    identifier: `urn:air:${PUBLISHER}:server:achromat-mom-mcp`,
    displayName: "Achromat Machine Operational Memory MCP server",
    type: MCP_CARD_TYPE,
    // The server card, not the npm page: `url` addresses the artifact document. The package is named in the card.
    url: `${SITE_ORIGIN}${MCP_CARD_PATH}`,
    version: versions.server,
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
}

const FEED_ENTRY: CatalogEntry = {
  identifier: `urn:air:${PUBLISHER}:feed:approved-lessons`,
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
export function catalogFor(versions: McpVersions) {
  return {
    specVersion: "1.0",
    host: {
      displayName: "Achromat AI",
      identifier: DID,
      documentationUrl: `${SITE_ORIGIN}${SKILL_PATH}`,
      logoUrl: `${SITE_ORIGIN}/logo-light.png`,
      trustManifest: TRUST_MANIFEST,
    },
    entries: [...SKILL_ENTRIES, ...AI_SKILL_ENTRIES, mcpEntry(versions), FEED_ENTRY].map(
      (entry): CatalogEntry => ({ ...entry, trustManifest: TRUST_MANIFEST }),
    ),
  };
}

/** The catalog with the fallback versions: what is served before the registry has answered. */
export const CATALOG = catalogFor(MCP_VERSIONS_FALLBACK);

/** The serialised catalog: identical bytes at both paths. */
export const CATALOG_BODY = `${JSON.stringify(CATALOG, null, 2)}\n`;
export const DID_BODY = `${JSON.stringify(DID_DOCUMENT, null, 2)}\n`;
export const LEGACY_DID_BODY = `${JSON.stringify(LEGACY_DID_DOCUMENT, null, 2)}\n`;
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

/** The serialised catalog and card for one pair of versions. Few distinct pairs ever occur, so this stays tiny. */
const VERSIONED_BODIES = new Map<string, { catalog: string; card: string }>();

function versionedBodies(versions: McpVersions): { catalog: string; card: string } {
  const key = `${versions.server}|${versions.package}`;
  let bodies = VERSIONED_BODIES.get(key);
  if (bodies === undefined) {
    bodies = { catalog: `${JSON.stringify(catalogFor(versions), null, 2)}\n`, card: `${JSON.stringify(mcpServerCard(versions), null, 2)}\n` };
    if (VERSIONED_BODIES.size >= 8) VERSIONED_BODIES.clear();
    VERSIONED_BODIES.set(key, bodies);
  }
  return bodies;
}

/** The documents that state the MCP server's version. Serve them with resolveMcpVersions() (src/index.ts). */
const VERSIONED_PATHS: ReadonlySet<string> = new Set([ARD_PATH, AI_CATALOG_PATH, MCP_CARD_PATH]);

/** True for a document whose body depends on the registry's versions. */
export function isVersionedDiscoveryPath(pathname: string): boolean {
  return VERSIONED_PATHS.has(pathname);
}

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

/**
 * The response for a discovery path, or null if the request is not one (so the caller carries on).
 * `versions` fills in the MCP server's version on the catalog and the card (resolveMcpVersions).
 * `hostname` is the host the request arrived on. The DID document is the one document that depends on it: a request
 * for LEGACY_HOST gets the legacy document (LEGACY_DID_DOCUMENT), every other host gets the canonical one. The host
 * is matched exactly and case-insensitively, so no other name can obtain the legacy document.
 */
export function discoveryResponse(method: string, pathname: string, hostname = "", versions: McpVersions = MCP_VERSIONS_FALLBACK): Response | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (!Object.hasOwn(DOCUMENTS, pathname)) return null;
  let document = DOCUMENTS[pathname]!;
  if (pathname === DID_PATH && hostname.toLowerCase() === LEGACY_HOST) document = { ...document, body: LEGACY_DID_BODY };
  if (VERSIONED_PATHS.has(pathname)) {
    const bodies = versionedBodies(versions);
    document = { ...document, body: pathname === MCP_CARD_PATH ? bodies.card : bodies.catalog };
  }
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

// ───────────────────────────── the top-level crawler shield ─────────────────────────────

/**
 * Top-level paths that crawlers and agent tooling probe for and that this service does not publish. Without the
 * shield the SPA fallback answers each with index.html and a 200, which their parsers choke on. Exact paths only:
 * wrangler.toml lists each in [assets].run_worker_first (keep the two lists in step; a test pins this one).
 * /robots.txt is not here because it is served (DOCUMENTS above). Publishing one of these later means serving
 * it from DOCUMENTS and removing it here.
 */
export const CRAWLER_SHIELD_PATHS: readonly string[] = Object.freeze([
  "/llms.txt",
  "/llms-full.txt",
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/agents.md",
]);

/** The same strict JSON 404 as the /.well-known shield, for every method. Returns null for any other path. */
export function crawlerNotFound(method: string, pathname: string): Response | null {
  if (!CRAWLER_SHIELD_PATHS.includes(pathname)) return null;
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", JSON_TYPE);
  headers.set("Cache-Control", "public, max-age=60");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(method === "HEAD" ? null : NOT_FOUND_BODY, { status: 404, headers });
}
