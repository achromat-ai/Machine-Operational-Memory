import { describe, expect, it } from "vitest";
import { MOM_ATTESTATION_KID, MOM_ATTESTATION_PUBLIC_KEYS } from "../src/crypto/attestation";
import {
  AGENT_SKILL_TYPE,
  AI_CATALOG_PATH,
  AI_SKILL_TYPE,
  ARD_PATH,
  CATALOG,
  CATALOG_BODY,
  DID,
  DID_BODY,
  DID_DOCUMENT,
  DID_KEY_ID,
  DID_PATH,
  MCP_CARD_BODY,
  MCP_CARD_PATH,
  MCP_CARD_TYPE,
  MCP_PACKAGE,
  MCP_SERVER_CARD,
  MCP_SERVER_VERSION,
  ROBOTS_PATH,
  ROBOTS_TXT,
  SITE_ORIGIN,
  TRUST_MANIFEST,
  isCertificateValidationPath,
  isWellKnownPath,
  wellKnownNotFound,
} from "../src/discovery";
import { SKILL_PATH } from "../src/skill";
import { call } from "./helpers";

// ───────────────────────── a small robots.txt reader (RFC 9309 rules) ─────────────────────────

interface Rule {
  allow: boolean;
  pattern: string;
}

/** The rules that apply to `agent`: the group naming it, else the `*` group. Unknown directives are ignored. */
function rulesFor(robots: string, agent: string): Rule[] {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (field === "user-agent") {
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((field === "allow" || field === "disallow") && current !== null) current.rules.push({ allow: field === "allow", pattern: value });
  }
  const named = groups.find((group) => group.agents.includes(agent.toLowerCase()));
  return (named ?? groups.find((group) => group.agents.includes("*")))?.rules ?? [];
}

function matches(pattern: string, path: string): boolean {
  if (pattern === "") return false;
  const anchored = pattern.endsWith("$");
  const source = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

/** Longest matching pattern wins; an Allow wins a tie (what RFC 9309 and Google do). */
function allowedLongest(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    if (best === null || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best === null ? true : best.allow;
}

/** The first matching rule wins (older parsers). */
function allowedFirst(rules: Rule[], path: string): boolean {
  const hit = rules.find((rule) => matches(rule.pattern, path));
  return hit === undefined ? true : hit.allow;
}

// ───────────────────────── routes ─────────────────────────

describe("GET /robots.txt", () => {
  it("is served as plain text, publicly cacheable, with the security headers", async () => {
    const response = await call(ROBOTS_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await response.text()).toBe(ROBOTS_TXT);
  });

  it("answers HEAD without a body, and refuses other methods", async () => {
    const head = await call(ROBOTS_PATH, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await head.text()).toBe("");
    expect((await call(ROBOTS_PATH, { method: "POST", body: "{}" })).status).toBe(404);
  });

  const PUBLIC = [
    "/",
    "/assets/index-abc123.js",
    "/skill.md",
    "/fintech.md",
    "/industrial_iot.md",
    "/devsecops.md",
    "/.well-known/ard.json",
    "/.well-known/ai-catalog.json",
    "/.well-known/did.json",
    "/.well-known/mcp/server-card.json",
    "/api/v1/feed",
    "/mcp",
  ];
  const PRIVATE = [
    "/mcp/anything",
    "/mcpx",
    "/api/v1/admin",
    "/api/v1/admin/pending",
    "/api/v1/bounties",
    "/api/v1/bounties/open",
    "/api/v1/recall",
    "/api/v1/calibrate",
    "/api/v1/agents/register",
    "/api/v1/health",
    "/admin/review",
    "/review",
    "/logo-light.png",
  ];

  it("lets search crawlers read only the public paths, whichever way the crawler resolves a conflict", () => {
    const rules = rulesFor(ROBOTS_TXT, "OAI-SearchBot");
    for (const path of PUBLIC) {
      expect(allowedLongest(rules, path), `longest: ${path}`).toBe(true);
      expect(allowedFirst(rules, path), `first: ${path}`).toBe(true);
    }
    for (const path of PRIVATE) {
      expect(allowedLongest(rules, path), `longest: ${path}`).toBe(false);
      expect(allowedFirst(rules, path), `first: ${path}`).toBe(false);
    }
  });

  it("shuts the training crawler out of everything", () => {
    const rules = rulesFor(ROBOTS_TXT, "GPTBot");
    for (const path of [...PUBLIC, ...PRIVATE]) {
      expect(allowedLongest(rules, path), path).toBe(false);
      expect(allowedFirst(rules, path), path).toBe(false);
    }
  });

  it("points ARD consumers at the catalog, and names nothing that is not public", () => {
    expect(ROBOTS_TXT).toContain(`Agentmap: ${SITE_ORIGIN}${ARD_PATH}`);
    expect(ROBOTS_TXT).not.toMatch(/admin|bount|review|recall|calibrate|register/i);
  });
});

describe("the ARD catalog", () => {
  const BOTH = [ARD_PATH, AI_CATALOG_PATH] as const;

  it("is served at both paths with the same bytes, and the right media type for each", async () => {
    const ard = await call(ARD_PATH);
    const legacy = await call(AI_CATALOG_PATH);
    expect(ard.status).toBe(200);
    expect(legacy.status).toBe(200);
    expect(ard.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(legacy.headers.get("Content-Type")).toBe("application/ai-catalog+json; charset=utf-8");
    const [a, b] = [await ard.text(), await legacy.text()];
    expect(a).toBe(CATALOG_BODY);
    expect(b).toBe(a);
  });

  it("can be read from a browser on another origin, is cacheable, and carries the security headers", async () => {
    for (const path of BOTH) {
      const response = await call(path);
      expect(response.headers.get("Access-Control-Allow-Origin"), path).toBe("*");
      expect(response.headers.get("Cache-Control"), path).toBe("public, max-age=300");
      expect(response.headers.get("X-Content-Type-Options"), path).toBe("nosniff");
      expect(response.headers.get("Content-Security-Policy"), path).toContain("default-src 'none'");
    }
  });

  it("answers HEAD without a body, and refuses other methods", async () => {
    for (const path of BOTH) {
      const head = await call(path, { method: "HEAD" });
      expect(head.status, path).toBe(200);
      expect(await head.text(), path).toBe("");
      expect((await call(path, { method: "POST", body: "{}" })).status, path).toBe(404);
    }
  });

  it("is valid JSON in the shape both specs require", () => {
    const parsed = JSON.parse(CATALOG_BODY) as typeof CATALOG;
    expect(parsed).toEqual(CATALOG);
    expect(parsed.specVersion).toMatch(/^\d+\.\d+$/);
    expect(parsed.host.displayName).toBeTruthy();
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries.length).toBeGreaterThan(0);
  });

  it("gives every entry the required terms, a domain-anchored URN, exactly one of url or data, and a unique identifier", () => {
    const seen = new Set<string>();
    for (const entry of CATALOG.entries as ReadonlyArray<Record<string, unknown>>) {
      expect(typeof entry.identifier).toBe("string");
      // The pattern from the official entry schema (ard-entry.schema.json), and a publisher that is a domain name.
      expect(entry.identifier as string).toMatch(/^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$/);
      expect(entry.identifier as string).toMatch(/^urn:air:[a-z0-9-]+(\.[a-z0-9-]+)+:/);
      expect(typeof entry.displayName).toBe("string");
      expect(entry.type as string).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
      expect(Number("url" in entry) + Number("data" in entry), String(entry.identifier)).toBe(1);
      expect(seen.has(entry.identifier as string), String(entry.identifier)).toBe(false);
      seen.add(entry.identifier as string);
      if ("representativeQueries" in entry) {
        const queries = entry.representativeQueries as string[];
        expect(queries.length).toBeGreaterThanOrEqual(2);
        expect(queries.length).toBeLessThanOrEqual(5);
      }
    }
  });

  it("keeps to the shapes the official schema allows: scalar metadata, string lists, and a flat string-valued term set", () => {
    for (const entry of CATALOG.entries as ReadonlyArray<Record<string, unknown>>) {
      for (const [key, value] of Object.entries((entry.metadata ?? {}) as Record<string, unknown>)) {
        // metadata is "custom key-value pairs, available as metadata.* filter keys": scalars only
        expect(["string", "number", "boolean"].includes(typeof value) || value === null, `metadata.${key}`).toBe(true);
        expect(key, "a dot would read as a nested path").not.toContain(".");
      }
      for (const list of ["tags", "capabilities", "representativeQueries"] as const) {
        if (list in entry) {
          expect(Array.isArray(entry[list]), list).toBe(true);
          expect((entry[list] as unknown[]).every((item) => typeof item === "string"), list).toBe(true);
        }
      }
      for (const term of ["identifier", "displayName", "type", "url", "description"] as const) {
        if (term in entry) expect(typeof entry[term], term).toBe("string");
      }
      expect(() => new URL(entry.url as string)).not.toThrow();
    }
  });

  it("anchors every URN to the host that serves the catalog, and every URL to this site over https", () => {
    const host = new URL(SITE_ORIGIN).hostname;
    for (const entry of CATALOG.entries) {
      expect(entry.identifier.startsWith(`urn:air:${host}:`), entry.identifier).toBe(true);
      expect(entry.url.startsWith(`${SITE_ORIGIN}/`), entry.url).toBe(true);
    }
    expect(CATALOG.host.identifier).toBe(`did:web:${host}`);
  });

  it("lists the agent skill at the route that serves it, as a markdown skill", async () => {
    const skill = CATALOG.entries.find((entry) => entry.type === "application/agent-skills+md");
    expect(skill?.url).toBe(`${SITE_ORIGIN}${SKILL_PATH}`);
    expect(CATALOG.host.documentationUrl).toBe(`${SITE_ORIGIN}${SKILL_PATH}`);
    expect((await call(SKILL_PATH)).status).toBe(200);
  });

  it("keeps the base skill and adds one skill entry per domain reference, each at the route that serves it", async () => {
    const skills = CATALOG.entries.filter((entry) => entry.type === "application/agent-skills+md");
    expect(skills.map((entry) => entry.identifier)).toEqual([
      "urn:air:mom.achromat.ai:skill:achromat-mom",
      "urn:air:mom.achromat.ai:skill:achromat-mom-fintech",
      "urn:air:mom.achromat.ai:skill:achromat-mom-industrial-iot",
      "urn:air:mom.achromat.ai:skill:achromat-mom-devsecops",
    ]);
    const domains = [
      ["achromat-mom-fintech", "/fintech.md", "fintech"],
      ["achromat-mom-industrial-iot", "/industrial_iot.md", "industrial_iot"],
      ["achromat-mom-devsecops", "/devsecops.md", "devsecops"],
    ] as const;
    for (const [name, path, domain] of domains) {
      const entry = skills.find((candidate) => candidate.identifier === `urn:air:mom.achromat.ai:skill:${name}`) as Record<string, unknown> | undefined;
      expect(entry, name).toBeDefined();
      expect(entry!.url, name).toBe(`${SITE_ORIGIN}${path}`);
      expect((entry!.metadata as Record<string, unknown>).domain, name).toBe(domain);
      expect((entry!.metadata as Record<string, unknown>).coreProtocol, name).toBe(`${SITE_ORIGIN}${SKILL_PATH}`);
      expect(entry!.capabilities, name).toEqual(["RecallCompliantArguments", "CalibratePolicy"]);
      expect((entry!.tags as string[]).includes(domain === "industrial_iot" ? "industrial-iot" : domain), name).toBe(true);
      const served = await call(path);
      expect(served.status, path).toBe(200);
      expect(served.headers.get("Content-Type"), path).toBe("text/plain; charset=utf-8");
    }
  });

  it("allows crawlers to read each skill document", () => {
    for (const path of ["/skill.md", "/fintech.md", "/industrial_iot.md", "/devsecops.md"]) expect(ROBOTS_TXT).toContain(`Allow: ${path}\n`);
  });

  it("allows crawlers to read the DID document and the MCP server card", () => {
    expect(ROBOTS_TXT).toContain(`Allow: ${DID_PATH}\n`);
    expect(ROBOTS_TXT).toContain(`Allow: ${MCP_CARD_PATH}\n`);
  });

  it("lists the protocol endpoints exactly as the protocol document describes them, plus the public feed", async () => {
    const skillText = await (await call(SKILL_PATH)).text();
    const metadata = CATALOG.entries[0]!.metadata as Record<string, string>;
    const FEED = "GET /api/v1/feed"; // public and allow-listed, but not part of the agent protocol document
    expect(metadata.publicFeed).toBe(FEED);
    const endpoints = Object.entries(metadata).filter(([key]) => /^(public|signed)[A-Z]/.test(key));
    expect(endpoints.length).toBe(7);
    expect(metadata.apiBaseUrl).toBe(`${SITE_ORIGIN}/api/v1`);
    for (const endpoint of endpoints.map(([, value]) => value).filter((value) => value !== FEED)) {
      const [method, path] = endpoint.split(" ") as [string, string];
      expect(skillText, endpoint).toContain(path);
      expect(skillText, endpoint).toContain(method);
    }
    expect(CATALOG.entries.some((entry) => entry.url === `${SITE_ORIGIN}/api/v1/feed`)).toBe(true);
    expect((await call("/api/v1/feed")).status).toBe(200);
  });
});

// ───────────────────────── the /.well-known shield ─────────────────────────

describe("the /.well-known shield", () => {
  const JSON_TYPE = "application/json; charset=utf-8";
  const UNKNOWN = [
    "/.well-known/does-not-exist",
    "/.well-known/mcp/nope.json",
    "/.well-known/mcp/",
    "/.well-known/security.txt",
    "/.well-known/did.json/extra",
    "/.well-known/ard.json/",
    "/.well-known/mcp-registry-auth",
    "/.well-known/",
    "/.well-known",
  ];

  it("answers every unknown /.well-known path with a 404 and a strict JSON body, never the SPA shell", async () => {
    for (const path of UNKNOWN) {
      const response = await call(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("Content-Type"), path).toBe(JSON_TYPE);
      expect(response.headers.get("Cache-Control"), path).toBe("public, max-age=60");
      expect(response.headers.get("Access-Control-Allow-Origin"), path).toBe("*");
      expect(response.headers.get("X-Content-Type-Options"), path).toBe("nosniff");
      expect(response.headers.get("Content-Security-Policy"), path).toContain("default-src 'none'");
      const text = await response.text();
      expect(text, path).not.toContain("<!doctype");
      expect(JSON.parse(text), path).toEqual({ success: false, error: "not found" });
    }
  });

  it("does the same for HEAD (no body) and for every other method", async () => {
    for (const path of ["/.well-known/does-not-exist", "/.well-known/mcp/nope.json"]) {
      const head = await call(path, { method: "HEAD" });
      expect(head.status, path).toBe(404);
      expect(head.headers.get("Content-Type"), path).toBe(JSON_TYPE);
      expect(await head.text(), path).toBe("");
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await call(path, { method, ...(method === "DELETE" ? {} : { body: "{}" }) });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(response.headers.get("Content-Type"), `${method} ${path}`).toBe(JSON_TYPE);
      }
    }
  });

  it("leaves the real discovery documents alone", async () => {
    for (const path of [ARD_PATH, AI_CATALOG_PATH, DID_PATH, MCP_CARD_PATH]) expect((await call(path)).status, path).toBe(200);
  });

  it("recognises /.well-known paths exactly, and nothing that merely looks like one", () => {
    for (const path of ["/.well-known", "/.well-known/", "/.well-known/x", "/.well-known/mcp/server-card.json"]) {
      expect(isWellKnownPath(path), path).toBe(true);
    }
    for (const path of ["/", "/well-known/x", "/.well-knownx", "/.well-knownx/y", "/api/.well-known/x", "/.WELL-KNOWN/x"]) {
      expect(isWellKnownPath(path), path).toBe(false);
    }
  });

  it("never answers certificate validation paths: the shield steps aside and index.ts hands them to the assets", () => {
    for (const path of ["/.well-known/acme-challenge/token", "/.well-known/acme-challenge/a/b", "/.well-known/pki-validation/file.txt"]) {
      expect(isCertificateValidationPath(path), path).toBe(true);
      for (const method of ["GET", "HEAD", "POST"]) expect(wellKnownNotFound(method, path), `${method} ${path}`).toBeNull();
    }
    // Only the directory prefixes count: a sibling with a similar name is just an unknown path.
    for (const path of ["/.well-known/acme-challenge", "/.well-known/acme-challengeX/t", "/.well-known/pki-validationX/t"]) {
      expect(isCertificateValidationPath(path), path).toBe(false);
      expect(wellKnownNotFound("GET", path)?.status, path).toBe(404);
    }
    expect(wellKnownNotFound("GET", "/api/v1/health")).toBeNull();
    expect(wellKnownNotFound("GET", "/")).toBeNull();
  });

  it("does not hand a certificate validation request to the shield when it reaches the Worker", async () => {
    const response = await call("/.well-known/acme-challenge/some-token");
    expect(response.headers.get("Content-Type")).not.toBe(JSON_TYPE);
    expect(await response.text()).not.toContain('"error":"not found"');
  });
});

// ───────────────────────── the did:web document ─────────────────────────

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58btc decode of a multibase string ('z' + base58btc). */
function decodeMultibase58btc(value: string): Uint8Array {
  expect(value[0]).toBe("z");
  let n = 0n;
  for (const char of value.slice(1)) {
    const digit = BASE58.indexOf(char);
    expect(digit, `base58 character ${char}`).toBeGreaterThanOrEqual(0);
    n = n * 58n + BigInt(digit);
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return Uint8Array.from(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
}

const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("GET /.well-known/did.json", () => {
  it("is served as plain JSON, publicly cacheable, readable cross-origin, with the security headers", async () => {
    const response = await call(DID_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await response.text();
    expect(body).toBe(DID_BODY);
    expect(JSON.parse(body)).toEqual(DID_DOCUMENT);
  });

  it("answers HEAD without a body, and refuses other methods", async () => {
    const head = await call(DID_PATH, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await call(DID_PATH, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("is the document that did:web resolution for this host would fetch, and names itself", () => {
    const host = new URL(SITE_ORIGIN).hostname;
    expect(DID).toBe(`did:web:${host}`);
    expect(DID_DOCUMENT.id).toBe(DID);
    // did:web: replace ':' with '/', prefix https://, append /.well-known/did.json when there is no path.
    const resolved = `https://${DID.slice("did:web:".length).replaceAll(":", "/")}/.well-known/did.json`;
    expect(resolved).toBe(`${SITE_ORIGIN}${DID_PATH}`);
  });

  it("is a well-formed DID document: DID Core context first, absolute DID URLs only, references that resolve", () => {
    expect(DID_DOCUMENT["@context"][0]).toBe("https://www.w3.org/ns/did/v1");
    const methods = DID_DOCUMENT.verificationMethod;
    expect(methods.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const method of methods) {
      expect(method.id.startsWith(`${DID}#`), method.id).toBe(true); // absolute, never a bare fragment
      expect(method.controller).toBe(DID);
      expect(method.type).toBe("Multikey");
      ids.add(method.id);
    }
    for (const reference of [...DID_DOCUMENT.authentication, ...DID_DOCUMENT.assertionMethod]) {
      expect(reference.startsWith(`${DID}#`), reference).toBe(true);
      expect(ids.has(reference), reference).toBe(true);
    }
  });

  it("carries exactly the key that signs pair attestations (mom_pk_v1), so the two cannot drift apart", () => {
    expect(DID_KEY_ID).toBe(`${DID}#${MOM_ATTESTATION_KID}`);
    const method = DID_DOCUMENT.verificationMethod.find((candidate) => candidate.id === DID_KEY_ID);
    expect(method).toBeDefined();
    const bytes = decodeMultibase58btc(method!.publicKeyMultibase);
    expect(bytes.length).toBe(34);
    expect([bytes[0], bytes[1]]).toEqual([0xed, 0x01]); // the multicodec for an Ed25519 public key
    expect(toHex(bytes.slice(2))).toBe(MOM_ATTESTATION_PUBLIC_KEYS[MOM_ATTESTATION_KID]);
  });

  it("holds no private key material", () => {
    expect(DID_BODY).not.toMatch(/private|secret|seed|-----BEGIN/i);
  });
});

// ───────────────────────── the MCP server card ─────────────────────────

describe("GET /.well-known/mcp/server-card.json", () => {
  it("is served as plain JSON, publicly cacheable, readable cross-origin, with the security headers", async () => {
    const response = await call(MCP_CARD_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await response.text();
    expect(body).toBe(MCP_CARD_BODY);
    expect(JSON.parse(body)).toEqual(MCP_SERVER_CARD);
  });

  it("answers HEAD without a body, and refuses other methods", async () => {
    const head = await call(MCP_CARD_PATH, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await call(MCP_CARD_PATH, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("meets the MCP server card schema's required terms and limits", () => {
    const card = MCP_SERVER_CARD;
    expect(card.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/v1\/server-card\.schema\.json$/);
    expect(card.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(card.name.length).toBeGreaterThanOrEqual(3);
    expect(card.name.length).toBeLessThanOrEqual(200);
    expect(card.description.length).toBeGreaterThanOrEqual(1);
    expect(card.description.length).toBeLessThanOrEqual(100);
    expect(card.title.length).toBeLessThanOrEqual(100);
    expect(card.version).toBe(MCP_SERVER_VERSION);
    expect(card.version).not.toMatch(/[\^~><*x]/); // no ranges
    expect(() => new URL(card.websiteUrl)).not.toThrow();
    for (const icon of card.icons) expect(icon.src.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
  });

  it("names the public sandbox as its one remote, and the npm package in a vendor-namespaced _meta key", () => {
    expect(MCP_SERVER_CARD.remotes).toEqual([{ type: "streamable-http", url: `${SITE_ORIGIN}/mcp` }]);
    const meta = MCP_SERVER_CARD._meta;
    expect(Object.keys(meta)).toEqual(["ai.achromat/distribution"]);
    // a _meta prefix with an 'mcp' or 'modelcontextprotocol' label is reserved for MCP itself
    expect(Object.keys(meta)[0]!.split("/")[0]!.split(".")).not.toContain("mcp");
    const distribution = meta["ai.achromat/distribution"];
    expect(distribution.registryType).toBe("npm");
    expect(distribution.identifier).toBe(MCP_PACKAGE);
    expect(distribution.version).toBe(MCP_SERVER_VERSION);
    expect(distribution.transport).toEqual({ type: "stdio" });
    expect(distribution.args).toContain(MCP_PACKAGE);
  });
});

// ───────────────────────── the expanded catalog ─────────────────────────

describe("the expanded ARD catalog", () => {
  const entries = CATALOG.entries;
  const strip = (entry: Record<string, unknown>) => {
    const { identifier: _identifier, type: _type, ...rest } = entry;
    return rest;
  };

  it("publishes every skill twice: once as ARD's agent skill type, once as ai-skill, same document", () => {
    const standard = entries.filter((entry) => entry.type === AGENT_SKILL_TYPE);
    const twins = entries.filter((entry) => entry.type === AI_SKILL_TYPE);
    expect(standard.length).toBe(4);
    expect(twins.length).toBe(4);
    // The base protocol stays first: other tests and clients read entries[0].
    expect(entries[0]!.identifier).toBe("urn:air:mom.achromat.ai:skill:achromat-mom");
    for (const original of standard) {
      const twin = twins.find((candidate) => candidate.identifier === original.identifier.replace(":skill:", ":ai-skill:"));
      expect(twin, original.identifier).toBeDefined();
      expect(twin!.url, original.identifier).toBe(original.url);
      expect(strip(twin as Record<string, unknown>), original.identifier).toEqual(strip(original as Record<string, unknown>));
    }
    expect(twins.map((entry) => entry.identifier)).toEqual([
      "urn:air:mom.achromat.ai:ai-skill:achromat-mom",
      "urn:air:mom.achromat.ai:ai-skill:achromat-mom-fintech",
      "urn:air:mom.achromat.ai:ai-skill:achromat-mom-industrial-iot",
      "urn:air:mom.achromat.ai:ai-skill:achromat-mom-devsecops",
    ]);
  });

  it("lists the MCP server with the card type, pointing at the hosted card and naming the npm package", () => {
    const mcp = entries.filter((entry) => entry.type === MCP_CARD_TYPE);
    expect(mcp.length).toBe(1);
    const entry = mcp[0]!;
    expect(entry.identifier).toBe("urn:air:mom.achromat.ai:server:achromat-mom-mcp");
    expect(entry.url).toBe(`${SITE_ORIGIN}${MCP_CARD_PATH}`);
    expect(entry.version).toBe(MCP_SERVER_CARD.version);
    expect(entry.metadata?.npmPackage).toBe(MCP_SERVER_CARD._meta["ai.achromat/distribution"].identifier);
    expect(entry.metadata?.packageTransport).toBe("stdio");
    expect(entry.metadata?.remoteUrl).toBe(MCP_SERVER_CARD.remotes[0]!.url);
    expect(entry.metadata?.remoteTransport).toBe(MCP_SERVER_CARD.remotes[0]!.type);
    expect(entry.metadata?.remoteAuthentication).toBe("none");
    expect(entry.tags).toContain("streamable-http");
    expect(entry.tags).toContain("mcp");
    expect("data" in entry).toBe(false);
  });

  it("has ten entries in all, every identifier unique", () => {
    expect(entries.length).toBe(10);
    expect(new Set(entries.map((entry) => entry.identifier)).size).toBe(10);
  });

  it("puts the trustManifest on the host and on every entry, and never at the document root", () => {
    const parsed = JSON.parse(CATALOG_BODY) as Record<string, unknown> & { host: Record<string, unknown>; entries: Array<Record<string, unknown>> };
    // The AI Catalog schema rejects any root member other than specVersion, host and entries.
    expect(Object.keys(parsed).sort()).toEqual(["entries", "host", "specVersion"]);
    expect(parsed.host.trustManifest).toEqual(TRUST_MANIFEST);
    expect(parsed.entries.length).toBe(10);
    for (const entry of parsed.entries) expect(entry.trustManifest, String(entry.identifier)).toEqual(TRUST_MANIFEST);
  });

  it("makes the host identifier and every trust identity the did:web, which the DID document names", () => {
    expect(CATALOG.host.identifier).toBe(DID);
    expect(TRUST_MANIFEST.identity).toBe(DID);
    expect(TRUST_MANIFEST.identityType).toBe("did");
    expect(DID_DOCUMENT.id).toBe(TRUST_MANIFEST.identity);
  });

  it("satisfies ARD's publisher authority binding: the trust domain equals the publisher in every entry URN", () => {
    const trustDomain = TRUST_MANIFEST.identity.split(":")[2];
    for (const entry of entries) expect(entry.identifier.split(":")[2], entry.identifier).toBe(trustDomain);
  });

  it("declares its trust framework with the two terms the AI Catalog schema requires", () => {
    expect(TRUST_MANIFEST.trustSchema.identifier).toBe("https://www.w3.org/TR/did-core/");
    expect(TRUST_MANIFEST.trustSchema.version).toBe("1.0");
    expect(TRUST_MANIFEST.trustSchema.verificationMethods).toEqual(["did"]);
  });
});
