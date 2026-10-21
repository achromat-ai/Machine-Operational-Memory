/**
 * Agent Skills discovery (Cloudflare's agent-skills-discovery-rfc, v0.2.0), so that
 * `npx skills add https://mom.achromat.ai` and other installers find the four skill documents.
 *
 *   GET /.well-known/agent-skills/index.json               the index
 *   GET /.well-known/agent-skills/<name>/SKILL.md          the RFC's conventional location of each skill
 *
 * The index lists the same four documents src/skill.ts serves (the core protocol and the three domain
 * references). Nothing is written twice:
 *   - `name` and `description` are read from each document's own frontmatter, so they cannot drift from it.
 *   - `digest` is the SHA-256 of the document's bytes. The Worker serves that very string as UTF-8, so the digest
 *     is of the bytes a client downloads (a client rejects a skill whose bytes do not match).
 *   - `url` is the document's canonical address. The `<name>/SKILL.md` path serves the same bytes and is what
 *     clients of the legacy (pre-0.2.0) layout request.
 *
 * Each entry also carries `files: ["SKILL.md"]`. v0.2.0 clients ignore unknown fields (the RFC requires it), while
 * clients that only know the legacy `files` shape (skills@1.5.1 rejects entries without it) accept the entry and
 * fetch `<name>/SKILL.md`.
 */
import { SECURITY_HEADERS } from "./app";
import { SITE_ORIGIN } from "./discovery";
import { sha256Hex } from "./schema";
import { AGENT_SKILLS_DIR, AGENT_SKILLS_INDEX_PATH, SKILL_DOCUMENTS, SKILL_PATHS, skillDocumentResponse } from "./skill";

export const AGENT_SKILLS_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/** The RFC's limits on a skill name and description. */
const NAME_PATTERN = /^(?!-)(?!.*--)(?!.*-$)[a-z0-9-]{1,64}$/;
const DESCRIPTION_MAX = 1024;

export interface AgentSkill {
  name: string;
  description: string;
  /** The canonical document path, for example /skill.md. */
  documentPath: string;
  /** The RFC's conventional path, for example /.well-known/agent-skills/achromat-mom/SKILL.md. */
  aliasPath: string;
}

/** The `name` and `description` of a document's YAML frontmatter (both single-line scalars in these documents). */
export function readFrontmatter(markdown: string): { name: string; description: string } {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1];
  if (block === undefined) throw new Error("document has no frontmatter");
  const field = (key: string) => new RegExp(`^${key}: (.+)$`, "m").exec(block)?.[1]?.trim();
  const name = field("name");
  const description = field("description");
  if (!name || !description) throw new Error("frontmatter needs a name and a description");
  return { name, description };
}

let skills: readonly AgentSkill[] | undefined;

/** The four skills, core protocol first. Throws if a document's frontmatter breaks the RFC's rules. */
export function agentSkills(): readonly AgentSkill[] {
  skills ??= SKILL_PATHS.map((documentPath): AgentSkill => {
    const { name, description } = readFrontmatter(SKILL_DOCUMENTS[documentPath]!);
    if (!NAME_PATTERN.test(name)) throw new Error(`skill name ${name} is not a valid Agent Skills name`);
    if (description.length > DESCRIPTION_MAX) throw new Error(`skill ${name} has a description over ${DESCRIPTION_MAX} characters`);
    return { name, description, documentPath, aliasPath: `${AGENT_SKILLS_DIR}/${name}/SKILL.md` };
  });
  return skills;
}

/**
 * True for the index and anything below the directory. Callers test this first, so a request for any other path never
 * reads a document's frontmatter.
 */
export function isAgentSkillsPath(pathname: string): boolean {
  return pathname.startsWith(`${AGENT_SKILLS_DIR}/`);
}

/** The skill whose conventional SKILL.md path this is, or null. */
export function agentSkillByAlias(pathname: string): AgentSkill | null {
  if (!isAgentSkillsPath(pathname)) return null;
  return agentSkills().find((skill) => skill.aliasPath === pathname) ?? null;
}

let indexBody: Promise<string> | undefined;

/** The serialised index. Built once per isolate: the documents are bundled, so it cannot change while it runs. */
export function agentSkillsIndexBody(): Promise<string> {
  indexBody ??= (async () => {
    const entries = await Promise.all(
      agentSkills().map(async (skill) => ({
        name: skill.name,
        type: "skill-md" as const,
        description: skill.description,
        url: `${SITE_ORIGIN}${skill.documentPath}`,
        digest: `sha256:${await sha256Hex(SKILL_DOCUMENTS[skill.documentPath]!)}`,
        files: ["SKILL.md"],
      })),
    );
    return `${JSON.stringify({ $schema: AGENT_SKILLS_SCHEMA, skills: entries }, null, 2)}\n`;
  })();
  indexBody.catch(() => {
    indexBody = undefined; // do not cache a failure
  });
  return indexBody;
}

const INDEX_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=300",
  "Access-Control-Allow-Origin": "*",
};

/**
 * The response for the index or a conventional SKILL.md path, or null if the path is neither (so the caller
 * carries on). GET and HEAD only. The SKILL.md paths answer exactly as the canonical document path does.
 */
export async function agentSkillsResponse(method: string, pathname: string): Promise<Response | null> {
  if ((method !== "GET" && method !== "HEAD") || !isAgentSkillsPath(pathname)) return null;
  if (pathname === AGENT_SKILLS_INDEX_PATH) {
    const headers = new Headers(SECURITY_HEADERS);
    for (const [name, value] of Object.entries(INDEX_HEADERS)) headers.set(name, value);
    return new Response(method === "HEAD" ? null : await agentSkillsIndexBody(), { status: 200, headers });
  }
  const skill = agentSkillByAlias(pathname);
  return skill ? skillDocumentResponse(method, skill.documentPath) : null;
}
