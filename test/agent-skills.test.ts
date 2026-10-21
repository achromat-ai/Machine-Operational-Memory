/**
 * The Agent Skills index (src/agent-skills.ts) and the top-level crawler shield (src/discovery.ts).
 *
 * The index is checked the way an installer checks it: every entry is validated against the RFC's rules, and every
 * digest is compared with the SHA-256 of the bytes the Worker really serves at that entry's url.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import skillMarkdown from "../SKILL.md";
import { AGENT_SKILLS_SCHEMA, agentSkills, agentSkillsIndexBody, readFrontmatter } from "../src/agent-skills";
import { CRAWLER_SHIELD_PATHS, SITE_ORIGIN } from "../src/discovery";
import entry from "../src/index";
import { SKILL_DOCUMENTS, SKILL_PATHS } from "../src/skill";
import { sha256Hex } from "../src/schema";
import { fakeAnalytics } from "./fixtures/world";
import { ORIGIN, call } from "./helpers";

const INDEX = "/.well-known/agent-skills/index.json";
const JSON_TYPE = "application/json; charset=utf-8";

interface IndexEntry {
  name: string;
  type: string;
  description: string;
  url: string;
  digest: string;
  files: string[];
}

async function fetchIndex(): Promise<{ response: Response; body: { $schema: string; skills: IndexEntry[] } }> {
  const response = await call(INDEX);
  return { response, body: JSON.parse(await response.text()) };
}

describe("GET /.well-known/agent-skills/index.json", () => {
  it("is served as public, cross-origin readable JSON with the security headers", async () => {
    const { response, body } = await fetchIndex();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(JSON_TYPE);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(body.$schema).toBe(AGENT_SKILLS_SCHEMA);
    expect(Object.keys(body).sort()).toEqual(["$schema", "skills"]);
  });

  it("answers HEAD without a body, and nothing else on that path", async () => {
    const head = await call(INDEX, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe(JSON_TYPE);
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await call(INDEX, { method, body: "{}" });
      expect(response.status, method).toBe(404);
      expect(response.headers.get("Content-Type"), method).toBe(JSON_TYPE);
    }
  });

  it("lists the core protocol first and then the three domain references, by name", async () => {
    const { body } = await fetchIndex();
    expect(body.skills.map((skill) => skill.name)).toEqual(["achromat-mom", "achromat-mom-fintech", "achromat-mom-industrial-iot", "achromat-mom-devsecops"]);
    expect(body.skills.map((skill) => skill.url)).toEqual(SKILL_PATHS.map((path) => `${SITE_ORIGIN}${path}`));
  });

  it("gives every entry the fields the RFC requires, in the shapes it requires", async () => {
    const { body } = await fetchIndex();
    for (const skill of body.skills) {
      expect(skill.type, skill.name).toBe("skill-md");
      expect(skill.name, skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(skill.name.length, skill.name).toBeLessThanOrEqual(64);
      expect(skill.description.length, skill.name).toBeGreaterThan(0);
      expect(skill.description.length, skill.name).toBeLessThanOrEqual(1024);
      expect(skill.digest, skill.name).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(() => new URL(skill.url), skill.name).not.toThrow();
      // The legacy (pre-0.2.0) shape, for installers that only know `files`.
      expect(skill.files, skill.name).toEqual(["SKILL.md"]);
    }
  });

  it("takes each name and description from the document's own frontmatter", async () => {
    const { body } = await fetchIndex();
    for (const [index, path] of SKILL_PATHS.entries()) {
      const frontmatter = readFrontmatter(SKILL_DOCUMENTS[path]!);
      expect(body.skills[index]).toMatchObject({ name: frontmatter.name, description: frontmatter.description });
    }
  });

  it("publishes a digest of exactly the bytes the Worker serves at each url (an installer rejects any other)", async () => {
    const { body } = await fetchIndex();
    for (const skill of body.skills) {
      const path = new URL(skill.url).pathname;
      const served = await call(path);
      expect(served.status, path).toBe(200);
      const bytes = new Uint8Array(await served.arrayBuffer());
      const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      expect(skill.digest, path).toBe(`sha256:${hex}`);
      expect(skill.digest, path).toBe(`sha256:${await sha256Hex(SKILL_DOCUMENTS[path]!)}`);
    }
  });

  it("builds the same body every time, and rejects nothing in the real documents", async () => {
    expect(await agentSkillsIndexBody()).toBe(await agentSkillsIndexBody());
    expect(agentSkills()).toHaveLength(4);
  });
});

describe("the conventional SKILL.md paths", () => {
  it("serve each skill's document byte for byte, as the canonical path does", async () => {
    const { body } = await fetchIndex();
    for (const skill of body.skills) {
      const alias = await call(`/.well-known/agent-skills/${skill.name}/SKILL.md`);
      expect(alias.status, skill.name).toBe(200);
      expect(alias.headers.get("Content-Type"), skill.name).toBe("text/plain; charset=utf-8");
      expect(alias.headers.get("Cache-Control"), skill.name).toBe("public, max-age=300");
      expect(await alias.text(), skill.name).toBe(await (await call(new URL(skill.url).pathname)).text());
    }
    expect(await (await call("/.well-known/agent-skills/achromat-mom/SKILL.md")).text()).toBe(skillMarkdown);
  });

  it("answer HEAD without a body, and refuse other methods and look-alikes with the JSON 404", async () => {
    const head = await call("/.well-known/agent-skills/achromat-mom-fintech/SKILL.md", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const [method, path] of [
      ["POST", "/.well-known/agent-skills/achromat-mom/SKILL.md"],
      ["GET", "/.well-known/agent-skills/achromat-mom/skill.md"],
      ["GET", "/.well-known/agent-skills/achromat-mom/"],
      ["GET", "/.well-known/agent-skills/nope/SKILL.md"],
      ["GET", "/.well-known/agent-skills/"],
      ["GET", "/.well-known/agent-skills/index.json/extra"],
      ["GET", "/.well-known/skills/index.json"],
    ] as const) {
      const response = await call(path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.headers.get("Content-Type"), `${method} ${path}`).toBe(JSON_TYPE);
      expect(await response.text(), `${method} ${path}`).toBe('{"success":false,"error":"not found"}\n');
    }
  });

  it("are counted as skill_view of their document, with the ref; the index is not", async () => {
    const analytics = fakeAnalytics();
    const get = async (path: string) => {
      const ctx = createExecutionContext();
      const response = await entry.fetch(new Request(ORIGIN + path), { ...env, ANALYTICS: analytics } as typeof env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };
    expect((await get("/.well-known/agent-skills/achromat-mom-devsecops/SKILL.md?ref=Launch")).status).toBe(200);
    expect(analytics.points).toEqual([{ indexes: ["anonymous"], blobs: ["skill_view", "devsecops.md", "", "anonymous", "served", "launch"], doubles: [1] }]);
    analytics.points.length = 0;
    expect((await get(INDEX)).status).toBe(200);
    expect(analytics.points).toHaveLength(0);
  });
});

describe("readFrontmatter", () => {
  it("reads name and description, and refuses a document without them", () => {
    expect(readFrontmatter("---\nname: a-b\ndescription: Does a thing.\n---\n# Body\n")).toEqual({ name: "a-b", description: "Does a thing." });
    expect(() => readFrontmatter("# no frontmatter\n")).toThrow(/frontmatter/);
    expect(() => readFrontmatter("---\nname: a\n---\nbody\n")).toThrow(/description/);
  });
});

describe("the top-level crawler shield", () => {
  const JSON_404 = '{"success":false,"error":"not found"}\n';

  it("covers the paths crawlers probe for", () => {
    expect([...CRAWLER_SHIELD_PATHS].sort()).toEqual(["/agents.md", "/llms-full.txt", "/llms.txt", "/sitemap.xml", "/sitemap_index.xml"]);
  });

  it("answers each with a strict JSON 404, never the SPA shell, for every method", async () => {
    for (const path of CRAWLER_SHIELD_PATHS) {
      for (const method of ["GET", "POST", "PUT", "DELETE", "OPTIONS"]) {
        const response = await call(path, { method, ...(method === "GET" || method === "OPTIONS" ? {} : { body: "{}" }) });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(response.headers.get("Content-Type"), `${method} ${path}`).toBe(JSON_TYPE);
        expect(response.headers.get("X-Content-Type-Options"), `${method} ${path}`).toBe("nosniff");
        expect(await response.text(), `${method} ${path}`).toBe(JSON_404);
      }
      const head = await call(path, { method: "HEAD" });
      expect(head.status, `HEAD ${path}`).toBe(404);
      expect(await head.text(), `HEAD ${path}`).toBe("");
    }
  });

  it("ignores the query string and the Accept header, as a crawler or a browser may send either", async () => {
    const response = await call("/llms.txt?x=1", { headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate" } });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(JSON_404);
  });

  it("leaves what is served alone: robots.txt, the documents and the catalog", async () => {
    expect((await call("/robots.txt")).status).toBe(200);
    expect((await call("/skill.md")).status).toBe(200);
    expect((await call("/.well-known/ard.json")).status).toBe(200);
  });
});
