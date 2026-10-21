/**
 * Documentation hygiene. README.md and public/skill.md are public: README.md is on the repository front
 * page and skill.md is served at /skill.md. They describe only the external agent workflow
 * (register, recall, calibrate). Operational detail belongs in private operator documentation, which is not part of this repository.
 *
 * The machine discovery documents (/robots.txt and the ARD catalog, src/discovery.ts) are public too, and
 * crawlers and registries copy them far and wide, so they get the same scan.
 */
import { describe, expect, it } from "vitest";
import readme from "../README.md";
import devsecops from "../public/devsecops.md";
import fintech from "../public/fintech.md";
import industrialIot from "../public/industrial_iot.md";
import skill from "../public/skill.md";
import { CATALOG_BODY, DID_BODY, MCP_CARD_BODY, ROBOTS_TXT } from "../src/discovery";

/** Compared case-insensitively as substrings, so "administrator" and "ADMIN" are caught too. */
const FORBIDDEN_TERMS = [
  "Kiro",
  "bounty",
  "admin",
  "/admin",
  "POW_CHALLENGE_HMAC_KEY",
  "IP_HMAC_KEY",
  "RAMEN_API_KEY",
  "MOM_ATTESTATION",
  "VISIBILITY_KEY",
  "agent_identities",
  "INSERT INTO",
  "ramen",
] as const;

/** The core protocol and the three domain references are all served publicly, so all four get the full scan. */
const SKILL_DOCS = [
  ["public/skill.md", skill],
  ["public/fintech.md", fintech],
  ["public/industrial_iot.md", industrialIot],
  ["public/devsecops.md", devsecops],
] as const;

const PUBLIC_DOCS = [["README.md", readme], ...SKILL_DOCS] as const;

/** The discovery documents are short by design, so they are scanned for the same leaks but not for length. */
const DISCOVERY_DOCS = [
  ["/robots.txt", ROBOTS_TXT],
  ["/.well-known/ard.json", CATALOG_BODY],
  ["/.well-known/did.json", DID_BODY],
  ["/.well-known/mcp/server-card.json", MCP_CARD_BODY],
] as const;

/** Every line that contains the term, for a failure message that points at the leak. */
function offendingLines(text: string, term: string): string[] {
  const needle = term.toLowerCase();
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.toLowerCase().includes(needle))
    .map(({ line, number }) => `${number}: ${line.trim().slice(0, 120)}`);
}

describe("public documentation hygiene", () => {
  for (const [name, text] of PUBLIC_DOCS) {
    describe(name, () => {
      it("is not empty", () => {
        expect(text.length).toBeGreaterThan(1000);
      });

      for (const term of FORBIDDEN_TERMS) {
        it(`does not mention "${term}"`, () => {
          expect(offendingLines(text, term), `${name} contains "${term}"`).toEqual([]);
        });
      }

      it("contains no local filesystem paths", () => {
        expect(offendingLines(text, "/Users/"), `${name} contains a local path`).toEqual([]);
        expect(offendingLines(text, "/home/"), `${name} contains a local path`).toEqual([]);
        expect(offendingLines(text, "~/."), `${name} contains a home-directory path`).toEqual([]);
      });
    });
  }

  for (const [name, text] of DISCOVERY_DOCS) {
    describe(name, () => {
      it("is not empty", () => {
        expect(text.length).toBeGreaterThan(100);
      });

      for (const term of FORBIDDEN_TERMS) {
        it(`does not mention "${term}"`, () => {
          expect(offendingLines(text, term), `${name} contains "${term}"`).toEqual([]);
        });
      }

      it("contains no local filesystem paths", () => {
        expect(offendingLines(text, "/Users/"), `${name} contains a local path`).toEqual([]);
        expect(offendingLines(text, "/home/"), `${name} contains a local path`).toEqual([]);
        expect(offendingLines(text, "~/."), `${name} contains a home-directory path`).toEqual([]);
      });
    });
  }

  it("detects a leak (the matcher itself works)", () => {
    expect(offendingLines("fine\nthe Example Crew board\nfine", "example")).toEqual(["2: the Example Crew board"]);
    expect(offendingLines("POST /api/v1/ADMIN/review", "/admin")).toHaveLength(1);
    expect(offendingLines("nothing here", "ramen")).toEqual([]);
  });
});

describe("public documentation covers the agent workflow", () => {
  it("README.md walks Identity, Turn 0, Turn 1 and Turn 2 in order and lists only public endpoints", () => {
    const order = ["Identity", "Turn 0", "Turn 1", "Turn 2"].map((step) => readme.indexOf(step));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const endpoint of [
      "GET /api/v1/health",
      "GET /api/v1/agents/challenge",
      "POST /api/v1/agents/register",
      "GET /api/v1/agents/me",
      "POST /api/v1/recall",
      "POST /api/v1/calibrate",
      "GET /api/v1/search",
      "GET /skill.md",
    ]) {
      expect(readme, endpoint).toContain(endpoint);
    }
    // Every endpoint the README names is one of the public ones.
    const named = [...readme.matchAll(/`(?:GET|POST|PUT|PATCH|DELETE) (\/[^`\s]*)`/g)].map((match) => match[1]);
    const allowed = new Set([
      "/api/v1/health",
      "/api/v1/agents/challenge",
      "/api/v1/agents/register",
      "/api/v1/agents/me",
      "/api/v1/recall",
      "/api/v1/calibrate",
      "/api/v1/search",
      "/skill.md",
    ]);
    expect(named.filter((path) => !allowed.has(path ?? ""))).toEqual([]);
  });

  it("skill.md documents the four steps, the exact task_description matching and the per-key limits", () => {
    for (const heading of ["## 2. Step 1: Identity registration", "## 4. Step 2: Turn 0 recall", "## 5. Step 3: Turn 1 calibrate", "## 6. Step 4: Turn 2 calibrate"]) {
      expect(skill, heading).toContain(heading);
    }
    expect(skill).toContain("### 4.2 How `task_description` is matched");
    expect(skill).toContain("**Exact tier.**");
    expect(skill).toContain("**Semantic tier.**");
    expect(skill).toContain("240 recalls per hour per key");
    expect(skill).toContain("120 calibrations per hour per key");
  });

  it("keeps the core protocol free of domain tool names, and each reference to its own domain", () => {
    for (const tool of ["dispatch_wire", "issue_credit_adverse_action", "dispatch_manipulation", "execute_command", "deploy_release", "grant_access"]) {
      expect(skill, `skill.md names ${tool}`).not.toContain(tool);
    }
    const references = [
      ["public/fintech.md", fintech, "fintech", ["dispatch_wire", "issue_credit_adverse_action"], "achromat-mom-fintech"],
      ["public/industrial_iot.md", industrialIot, "industrial_iot", ["dispatch_manipulation"], "achromat-mom-industrial-iot"],
      ["public/devsecops.md", devsecops, "devsecops", ["execute_command", "deploy_release", "grant_access"], "achromat-mom-devsecops"],
    ] as const;
    for (const [name, text, domain, tools, skillName] of references) {
      expect(text.startsWith(`---\nname: ${skillName}\n`), `${name} front matter`).toBe(true);
      expect(text, name).toContain(`"domain": "${domain}"`);
      expect(text, name).toContain("https://mom.achromat.ai/skill.md");
      expect(text, name).toContain("[VERIFIED_STATE]");
      for (const tool of tools) expect(text, `${name} ${tool}`).toContain(`"tool": "${tool}"`);
    }
  });

  it("links the core protocol to all three domain references", () => {
    for (const path of ["/fintech.md", "/industrial_iot.md", "/devsecops.md"]) expect(skill, path).toContain(`https://mom.achromat.ai${path}`);
  });

  it("no public document exposes a shared, global capacity figure", () => {
    for (const [name, text] of [...PUBLIC_DOCS, ...DISCOVERY_DOCS]) {
      expect(text, name).not.toMatch(/\b1,?000\b[^.\n]*\b(hour|upstream|global|community)/i);
      expect(text.toLowerCase(), name).not.toContain("community-wide");
      expect(text.toLowerCase(), name).not.toContain("global limit");
    }
  });
});
