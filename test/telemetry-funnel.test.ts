/**
 * Activation-funnel telemetry: skill_view (every protocol document), challenge_issued and agent_register, each
 * carrying the optional ?ref= tag in blobs[5]. A missing or malformed ref is "", never an error, and a telemetry
 * failure never changes a response.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import entry from "../src/index";
import skillMarkdown from "../SKILL.md";
import fintechMarkdown from "../public/fintech.md";
import { CLIENT_LABELS, MISS_REASONS, anonymiseAgentKey, clientLabel, parseRef, refFromUrl, writeTelemetry, type TelemetryAction } from "../src/telemetry";
import { TOOL, TRAP_ARGUMENTS, agentKeyHex } from "./fixtures/ledger";
import { fakeAnalytics, freshWorld, type World } from "./fixtures/world";
import { ORIGIN, freshIp, getChallenge, newAgent, registrationBody, type Challenge } from "./helpers";

describe("parseRef and refFromUrl", () => {
  it("accepts a lowercase slug of 1 to 32 characters and lowercases what it is given", () => {
    for (const ref of ["a", "launch", "hn-2026_10", "0day", "a".repeat(32)]) expect(parseRef(ref), ref).toBe(ref);
    expect(parseRef("  Launch-Post ")).toBe("launch-post");
  });

  it("defaults anything missing or malformed to an empty string", () => {
    for (const raw of [undefined, null, "", "   ", "-lead", "_lead", "a.b", "a b", "a@b.com", "https://x.test", "a/b", "é", "a".repeat(33), "<script>"]) {
      expect(parseRef(raw), String(raw)).toBe("");
    }
  });

  it("reads the query string, and treats a repeated ref as no ref", () => {
    expect(refFromUrl("https://achromat.ai/skill.md?ref=Launch")).toBe("launch");
    expect(refFromUrl("https://achromat.ai/skill.md?x=1&ref=hn")).toBe("hn");
    expect(refFromUrl("https://achromat.ai/skill.md")).toBe("");
    expect(refFromUrl("https://achromat.ai/skill.md?ref=")).toBe("");
    expect(refFromUrl("https://achromat.ai/skill.md?ref=a&ref=b")).toBe("");
    expect(refFromUrl("not a url")).toBe("");
  });
});

describe("telemetry: protocol documents (skill_view)", () => {
  async function fetchDoc(path: string, method = "GET") {
    const analytics = fakeAnalytics();
    const ctx = createExecutionContext();
    const response = await entry.fetch(new Request(ORIGIN + path, { method }), { ...env, ANALYTICS: analytics } as typeof env, ctx);
    await waitOnExecutionContext(ctx);
    return { response, points: analytics.points };
  }

  it("logs a skill.md view with the document name in the domain field and the ref in blobs[5]", async () => {
    const { response, points } = await fetchDoc("/skill.md?ref=launch-post");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(skillMarkdown);
    expect(points).toEqual([{ indexes: ["anonymous"], blobs: ["skill_view", "skill.md", "", "anonymous", "served", "launch-post"], doubles: [1] }]);
  });

  it("logs the three domain documents as skill_view too, each under its own name", async () => {
    for (const name of ["fintech.md", "industrial_iot.md", "devsecops.md"]) {
      const { response, points } = await fetchDoc(`/${name}?ref=hn`);
      expect(response.status, name).toBe(200);
      expect(points, name).toEqual([{ indexes: ["anonymous"], blobs: ["skill_view", name, "", "anonymous", "served", "hn"], doubles: [1] }]);
    }
    expect(await (await fetchDoc("/fintech.md")).response.text()).toBe(fintechMarkdown);
  });

  it("writes an empty ref when there is none, or when it is malformed or repeated, and still serves the document", async () => {
    for (const query of ["", "?ref=", "?ref=a%40b.com", "?ref=a&ref=b", `?ref=${"a".repeat(40)}`]) {
      const { response, points } = await fetchDoc(`/skill.md${query}`);
      expect(response.status, query).toBe(200);
      expect(points, query).toHaveLength(1);
      expect(points[0]!.blobs, query).toEqual(["skill_view", "skill.md", "", "anonymous", "served", ""]);
    }
  });

  it("does not log HEAD requests, other methods, other paths or the discovery documents", async () => {
    expect((await fetchDoc("/skill.md?ref=x", "HEAD")).points).toHaveLength(0);
    expect((await fetchDoc("/robots.txt?ref=x")).points).toHaveLength(0);
    expect((await fetchDoc("/.well-known/ard.json?ref=x")).points).toHaveLength(0);
    expect((await fetchDoc("/skill.md/extra?ref=x")).points).toHaveLength(0);
    expect((await fetchDoc("/skill.md?ref=x", "POST")).points).toHaveLength(0);
  });

  it("serves the document unchanged and cacheable when the dataset is unavailable", async () => {
    const analytics = fakeAnalytics();
    analytics.fail = true;
    const ctx = createExecutionContext();
    const response = await entry.fetch(new Request(`${ORIGIN}/skill.md?ref=x`), { ...env, ANALYTICS: analytics } as typeof env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await response.text()).toBe(skillMarkdown);
  });
});

describe("telemetry: onboarding (challenge_issued, agent_register)", () => {
  async function viaWorld(world: World, path: string, init: { ip: string; method?: string; body?: unknown }) {
    const ctx = createExecutionContext();
    const request = new Request(ORIGIN + path, {
      method: init.method ?? "GET",
      headers: { "CF-Connecting-IP": init.ip, "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const response = await world.worker.fetch(request, world.env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  async function challenge(world: World, ip: string, query = "") {
    const response = await viaWorld(world, `/api/v1/agents/challenge${query}`, { ip });
    expect(response.status).toBe(200);
    return (await response.json()) as Challenge;
  }

  it("logs an issued challenge with the ref, without an agent id", async () => {
    const world = await freshWorld();
    const issued = await challenge(world, freshIp(), "?ref=launch-post");
    expect(issued.challenge_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(world.analytics.points).toEqual([{ indexes: ["anonymous"], blobs: ["challenge_issued", "", "", "anonymous", "issued", "launch-post"], doubles: [1] }]);
  });

  it("writes an empty ref for a missing or malformed one, and the response is the same either way", async () => {
    const world = await freshWorld();
    for (const query of ["", "?ref=", "?ref=NOT%20A%20SLUG", "?ref=a&ref=b"]) {
      world.analytics.points.length = 0;
      const response = await viaWorld(world, `/api/v1/agents/challenge${query}`, { ip: freshIp() });
      expect(response.status, query).toBe(200);
      expect(Object.keys((await response.json()) as object).sort(), query).toEqual(
        ["algorithm", "challenge", "challenge_id", "challenge_signature", "challenge_signature_note", "difficulty_bits", "expires_at", "pow", "proof_message", "success"],
      );
      expect(world.analytics.points, query).toHaveLength(1);
      expect(world.analytics.points[0]!.blobs, query).toEqual(["challenge_issued", "", "", "anonymous", "issued", ""]);
    }
  });

  it("logs no challenge_issued for a challenge that was not issued, only the refusal", async () => {
    const world = await freshWorld();
    const response = await world.worker.fetch(new Request(`${ORIGIN}/api/v1/agents/challenge?ref=x`), world.env, createExecutionContext());
    expect(response.status).toBe(400); // no client address
    expect(world.analytics.points).toEqual([
      { indexes: ["registration_failed"], blobs: ["registration_failed", "", "challenge", "anonymous", "CLIENT_IP_UNAVAILABLE", "x", ""], doubles: [1] },
    ]);
  });

  it("logs a registration with the new key's anonymised id, which is the id its later calls carry", async () => {
    const world = await freshWorld();
    const ip = freshIp();
    const agent = await newAgent();
    const issued = await challenge(world, ip, "?ref=launch-post");
    world.analytics.points.length = 0;

    const response = await viaWorld(world, "/api/v1/agents/register?ref=Launch-Post", { ip, method: "POST", body: await registrationBody(agent, issued) });
    expect(response.status).toBe(201);
    const id = await anonymiseAgentKey(agentKeyHex(agent));
    expect(world.analytics.points).toEqual([{ indexes: [id], blobs: ["agent_register", "", "", id, "registered", "launch-post"], doubles: [1] }]);
    expect(JSON.stringify(world.analytics.points)).not.toContain(agent.publicKey);
    expect(JSON.stringify(world.analytics.points)).not.toContain(agentKeyHex(agent));

    // The same id is on that key's recall points, so the ref can be followed to first use without a cookie.
    world.analytics.points.length = 0;
    const recalled = await world.recall(agent, { domain: "fintech", tool: TOOL, task_description: "Move client funds to the settlement account", arguments: TRAP_ARGUMENTS });
    expect(recalled.status).toBe(200);
    expect(world.analytics.points.map((point) => point.indexes)).toEqual([[id]]);
  });

  it("writes an empty ref for a registration without one", async () => {
    const world = await freshWorld();
    const ip = freshIp();
    const agent = await newAgent();
    const issued = await getChallenge(ip);
    world.analytics.points.length = 0;
    expect((await viaWorld(world, "/api/v1/agents/register", { ip, method: "POST", body: await registrationBody(agent, issued) })).status).toBe(201);
    expect(world.analytics.points).toHaveLength(1);
    expect(world.analytics.points[0]!.blobs?.at(-1)).toBe("");
  });

  it("logs no agent_register for a registration that fails, only the refusal, and does not accept the ref in the body", async () => {
    const world = await freshWorld();
    const ip = freshIp();
    const agent = await newAgent();
    const issued = await challenge(world, ip);
    world.analytics.points.length = 0;

    const body = await registrationBody(agent, issued);
    const bodyRef = await viaWorld(world, "/api/v1/agents/register?ref=x", { ip, method: "POST", body: { ...body, ref: "x" } });
    expect(bodyRef.status).toBe(400);
    expect(await bodyRef.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const bad = await viaWorld(world, "/api/v1/agents/register?ref=x", { ip, method: "POST", body: { ...body, proof_signature: body.nonce.padEnd(86, "A") } });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    // Two refusals, no registration: the field-level detail names the one field that failed validation.
    expect(world.analytics.points.map((point) => point.blobs)).toEqual([
      ["registration_failed", "", "register", "anonymous", "INVALID_REQUEST", "x", "unknown_field"],
      ["registration_failed", "", "register", "anonymous", expect.stringMatching(/^(POW_INVALID|PROOF_OF_POSSESSION_FAILED)$/), "x", ""],
    ]);
    expect(world.analytics.points.some((point) => point.blobs?.[0] === "agent_register")).toBe(false);
  });

  it("registers and issues challenges normally when the dataset is unavailable", async () => {
    const world = await freshWorld();
    world.analytics.fail = true;
    const ip = freshIp();
    const agent = await newAgent();
    const issued = await challenge(world, ip, "?ref=x");
    expect((await viaWorld(world, "/api/v1/agents/register?ref=x", { ip, method: "POST", body: await registrationBody(agent, issued) })).status).toBe(201);
    expect(world.analytics.points).toHaveLength(0);
  });
});


/**
 * Analytics Engine samples a busy index, and every unauthenticated funnel event (skill_view, challenge_issued) shares the
 * index "anonymous". If unsigned recalls or sandbox calls were written to that index too, a burst of them would raise the
 * sampling rate of the funnel counts. They have indexes of their own, applied in writeTelemetry so no call site can forget.
 */
describe("telemetry: sampling indexes", () => {
  async function pointFor(event: Parameters<typeof writeTelemetry>[1]) {
    const analytics = fakeAnalytics();
    await writeTelemetry({ ...env, ANALYTICS: analytics } as typeof env, event);
    return analytics.points[0]!;
  }

  it("gives recall_unsigned and mcp_sandbox_recall an index of their own, not the shared 'anonymous' one", async () => {
    const unsigned = await pointFor({ action: "recall_unsigned", domain: "fintech", tool: "x", agentKey: null, status: "miss" });
    const sandbox = await pointFor({ action: "mcp_sandbox_recall", domain: "fintech", tool: "x", agentKey: null, status: "sample" });
    expect(unsigned.indexes).toEqual(["recall_unsigned"]);
    expect(sandbox.indexes).toEqual(["mcp_sandbox_recall"]);
    // Both still say who called: nobody.
    expect(unsigned.blobs![3]).toBe("anonymous");
    expect(sandbox.blobs![3]).toBe("anonymous");
  });

  it("keeps the 'anonymous' index for the funnel events only", async () => {
    const indexes = new Map<TelemetryAction, string>();
    for (const action of ["skill_view", "challenge_issued"] as const) {
      indexes.set(action, (await pointFor({ action, domain: "", tool: "", agentKey: null, status: "served", ref: "" })).indexes![0] as string);
    }
    expect([...indexes.values()]).toEqual(["anonymous", "anonymous"]);
    // The two recall actions that can have no agent key never land there, whatever their call site passes. (registration_failed,
    // human_search and lesson_view also avoid it, but through the explicit `index` their call sites give them.)
    for (const action of ["recall_unsigned", "mcp_sandbox_recall"] as const) {
      const point = await pointFor({ action, domain: "", tool: "", agentKey: null, status: "miss" });
      expect(point.indexes![0], action).toBe(action);
    }
  });

  it("lets a caller-chosen index override, and still gives a signed recall its agent's index", async () => {
    expect((await pointFor({ action: "recall_unsigned", domain: "", tool: "", agentKey: null, status: "miss", index: "custom" })).indexes).toEqual(["custom"]);
    const agentKey = "a".repeat(64);
    const id = await anonymiseAgentKey(agentKey);
    expect((await pointFor({ action: "recall", domain: "fintech", tool: "x", agentKey, status: "hit" })).indexes).toEqual([id]);
  });
});

describe("telemetry: recall miss reason and caller label", () => {
  async function blobsFor(event: Partial<Parameters<typeof writeTelemetry>[1]>) {
    const analytics = fakeAnalytics();
    await writeTelemetry({ ...env, ANALYTICS: analytics } as typeof env, { action: "recall_unsigned", domain: "fintech", tool: "t", agentKey: null, status: "miss", ...event });
    return analytics.points[0]!.blobs as string[];
  }

  it("writes only a known miss reason and a known caller label, and never anything else", async () => {
    for (const reason of MISS_REASONS) expect((await blobsFor({ detail: reason, client: "other" }))[6], reason).toBe(reason);
    for (const client of CLIENT_LABELS) expect((await blobsFor({ detail: "", client }))[7], client).toBe(client);
    // Free text in either slot is replaced, not written.
    const hostile = await blobsFor({ detail: "my secret task text", client: "Mozilla/5.0 (secret)" });
    expect(hostile[6]).toBe("");
    expect(hostile[7]).toBe("other");
    expect(JSON.stringify(hostile)).not.toMatch(/secret/);
  });

  it("pads the ref, reason and label slots in order, and writes nothing extra when none is given", async () => {
    expect(await blobsFor({})).toEqual(["recall_unsigned", "fintech", "t", "anonymous", "miss"]);
    expect(await blobsFor({ client: "mcp-package" })).toEqual(["recall_unsigned", "fintech", "t", "anonymous", "miss", "", "", "mcp-package"]);
    expect(await blobsFor({ ref: "hn", detail: "tool_unknown", client: "other" })).toEqual(["recall_unsigned", "fintech", "t", "anonymous", "miss", "hn", "tool_unknown", "other"]);
  });

  it("recognises this package by the User-Agent prefix and nothing looser", () => {
    const label = (userAgent?: string) => clientLabel(new Request("https://achromat.ai/", userAgent === undefined ? {} : { headers: { "User-Agent": userAgent } }));
    expect(label("achromat-mcp-server/0.1.5")).toBe("mcp-package");
    for (const other of [undefined, "", "curl/8.4.0", "achromat-mcp-server", "Achromat-MCP-Server/1", "x achromat-mcp-server/1"]) {
      expect(label(other), String(other)).toBe("other");
    }
  });
});
