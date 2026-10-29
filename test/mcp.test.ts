/**
 * POST /mcp: the public MCP sandbox. JSON-RPC payloads as a legacy (initialize-based) client and a modern
 * (2026-07-28) client send them, over the Worker's real routing, rate limiter and D1.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DOMAIN_BUNDLES } from "../src/config/domains";
import { MCP_PACKAGE, MCP_REMOTE_URL, SITE_ORIGIN } from "../src/discovery";
import { processLesson } from "../src/review/pipeline";
import {
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSION,
  RPC,
  SANDBOX_DOMAINS,
  SANDBOX_INSTALL_COMMAND,
  SANDBOX_LESSON_LIMIT,
  SANDBOX_NOTICE,
  SANDBOX_SERVER_INFO,
} from "../src/routes/mcp";
import { FIX_ARGUMENTS, TRAP_ARGUMENTS, community, humanReview, insertPair, uuid } from "./fixtures/ledger";
import { fakeAnalytics, freshWorld, type World } from "./fixtures/world";
import { ORIGIN, call, freshIp } from "./helpers";

const MARKER = "TRAP-ONLY-MARKER";
const NOTICE =
  "This is a sandboxed preview. Do not use these sample arguments for live execution. To access the full semantic vector space and calibration engine, install the local MCP server via 'npx -y @achromat-ai/mcp-server'.";

/** @achromat-ai/mcp-server 0.1.1 achromat_recall inputSchema, as captured from its tools/list. Independent copy. */
const NPM_RECALL_INPUT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    domain: { type: "string", enum: ["fintech", "industrial_iot", "robotics", "devsecops"], description: "The area the tool call belongs to." },
    tool_name: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9][A-Za-z0-9_.:/-]*$",
      description: "The exact name of the tool you are about to call, for example dispatch_wire.",
    },
    task_description: {
      type: "string",
      minLength: 16,
      maxLength: 1000,
      description:
        "What you are trying to do, in plain words, as you would write a ticket title (16 to 1000 characters). Name the concrete action and object. Leave out amounts, identifiers, dates and personal data. Use the same wording for the same task every time.",
    },
    arguments: {
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: {},
      description:
        "REQUIRED. The arguments you intend to send to the tool, as a non-empty JSON object, using the key names the tool really uses. Only the names of the keys (and their nesting) are used for semantic matching, never the values, so the real key names make a recall find the right lesson; an invented or generic shape finds the wrong one or none. Never put secrets or credentials in it.",
    },
  },
  required: ["domain", "tool_name", "task_description", "arguments"],
};

const RECALL_ARGS = {
  domain: "fintech",
  tool_name: "dispatch_wire",
  task_description: "Send a domestic wire transfer to a supplier",
  arguments: { amount: 1, beneficiary: { account: "PRIVATE-VALUE-123" } },
};

interface RpcOptions {
  era?: "modern" | "legacy";
  ip?: string | null;
  headers?: Record<string, string | null>;
  rawBody?: string;
  method?: string;
}

function createHarness(world: World) {
  const analytics = fakeAnalytics();
  const testEnv = { ...env, ANALYTICS: analytics } as typeof env;

  async function send(request: Request): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await world.worker.fetch(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  /** One JSON-RPC message. Modern requests get _meta and the mirrored headers unless a test overrides them. */
  async function rpc(method: string, params: Record<string, unknown> = {}, options: RpcOptions = {}) {
    const era = options.era ?? "modern";
    const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" });
    if (options.ip !== null) headers.set("CF-Connecting-IP", options.ip ?? freshIp());
    let body: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method, params };
    if (era === "modern") {
      body = { ...body, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION } } };
      headers.set("MCP-Protocol-Version", MODERN_PROTOCOL_VERSION);
      headers.set("Mcp-Method", method);
      if (method === "tools/call" && typeof params.name === "string") headers.set("Mcp-Name", params.name);
    } else {
      headers.set("MCP-Protocol-Version", "2025-06-18");
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
    const response = await send(
      new Request(`${ORIGIN}/mcp`, { method: options.method ?? "POST", headers, body: options.rawBody ?? JSON.stringify(body) }),
    );
    const text = await response.text();
    return { response, status: response.status, json: text === "" ? null : JSON.parse(text) };
  }

  const recall = (args: unknown = RECALL_ARGS, options: RpcOptions = {}) => rpc("tools/call", { name: "achromat_recall", arguments: args }, options);
  return { analytics, send, rpc, recall };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

/** A community fintech lesson through triage. The blocked call carries a marker that must never be served. */
async function pendingLesson(world: World, ownerKey: string) {
  await tick();
  const pair = await insertPair({ ownerKey, kind: "community", trapArguments: { ...TRAP_ARGUMENTS, memo: MARKER }, fixArguments: FIX_ARGUMENTS });
  await processLesson(env, world.deps, pair.lessonId);
  return pair;
}

async function reviewEvent(lessonId: string, action: string) {
  await env.DB.prepare(
    `INSERT INTO review_events (event_id, lesson_id, actor_type, actor_id, action, reason_code, details_json, at_ms)
     VALUES (?1, ?2, 'human', 'test-reviewer', ?3, NULL, NULL, ?4)`,
  )
    .bind(uuid(), lessonId, action, Date.now())
    .run();
}

function text(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

// ───────────────────────── first on purpose: D1 is shared and still empty ─────────────────────────

describe("POST /mcp tools/call on an empty corpus", () => {
  it("answers with no lessons, the notice first and last, and records an anonymous 'empty' data point", async () => {
    const world = await freshWorld({ mcpCacheSeconds: 0 });
    const harness = createHarness(world);
    const { status, json } = await harness.recall();
    expect(status).toBe(200);
    const result = json.result;
    expect(result.isError).toBe(false);
    expect(result.resultType).toBe("complete");
    expect(result.structuredContent).toMatchObject({ sandbox: true, match: false, domain: "fintech", lessons: [] });
    expect(text(result).startsWith(NOTICE)).toBe(true);
    expect(text(result).endsWith(NOTICE)).toBe(true);
    expect(harness.analytics.points).toEqual([
      { indexes: ["anonymous"], blobs: ["mcp_sandbox_recall", "fintech", "dispatch_wire", "anonymous", "empty"], doubles: [1] },
    ]);
  });
});

// ───────────────────────── legacy clients ─────────────────────────

describe("POST /mcp: legacy (initialize) clients", () => {
  it("answers initialize statelessly with the requested legacy version, and accepts notifications/initialized", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const init = await harness.rpc(
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "inspector", version: "1" } },
      { era: "legacy", headers: { "MCP-Protocol-Version": null } },
    );
    expect(init.status).toBe(200);
    expect(init.response.headers.get("Content-Type")).toBe("application/json");
    expect(init.response.headers.get("Mcp-Session-Id")).toBeNull();
    expect(init.json).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: SANDBOX_SERVER_INFO },
    });
    expect(init.json.result.instructions).toContain(SANDBOX_NOTICE);

    const response = await harness.send(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "CF-Connecting-IP": freshIp(), "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("offers its newest legacy version to a client asking for one it does not know", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const { json } = await harness.rpc("initialize", { protocolVersion: "2024-01-01", capabilities: {} }, { era: "legacy" });
    expect(json.result.protocolVersion).toBe(LEGACY_PROTOCOL_VERSIONS[0]);
  });

  it("lists achromat_recall with exactly the npm package's input schema, honest sandbox annotations, and no modern-only fields", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const { status, json } = await harness.rpc("tools/list", {}, { era: "legacy" });
    expect(status).toBe(200);
    expect(json.result.tools).toHaveLength(1);
    const tool = json.result.tools[0];
    expect(tool.name).toBe("achromat_recall");
    expect(tool.inputSchema).toEqual(NPM_RECALL_INPUT_SCHEMA);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(tool.description).toContain("SANDBOX PREVIEW");
    expect(tool.description).toContain("do not use their arguments for live execution");
    expect(json.result.resultType).toBeUndefined();
    expect(json.result.ttlMs).toBeUndefined();
  });

  it("calls the tool, answers ping, and treats a request without MCP-Protocol-Version as 2025-03-26", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const called = await harness.recall(RECALL_ARGS, { era: "legacy", headers: { "MCP-Protocol-Version": null } });
    expect(called.status).toBe(200);
    expect(called.json.result.isError).toBe(false);
    expect(called.json.result.resultType).toBeUndefined();
    expect(called.json.result._meta).toBeUndefined();
    expect((await harness.rpc("ping", {}, { era: "legacy" })).json).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("answers an unknown method with -32601 in a 200, and rejects an unsupported legacy version header", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const unknown = await harness.rpc("resources/list", {}, { era: "legacy" });
    expect(unknown.status).toBe(200);
    expect(unknown.json.error.code).toBe(RPC.METHOD_NOT_FOUND);
    const old = await harness.rpc("tools/list", {}, { era: "legacy", headers: { "MCP-Protocol-Version": "2023-01-01" } });
    expect(old.status).toBe(400);
    expect(old.json.error).toMatchObject({ code: RPC.UNSUPPORTED_PROTOCOL_VERSION, data: { requested: "2023-01-01" } });
  });
});

// ───────────────────────── modern clients ─────────────────────────

describe("POST /mcp: modern (2026-07-28) clients", () => {
  it("answers server/discover with every supported version, the tools capability and serverInfo", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const { status, json } = await harness.rpc("server/discover");
    expect(status).toBe(200);
    expect(json.result).toMatchObject({
      resultType: "complete",
      supportedVersions: [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS],
      capabilities: { tools: { listChanged: false } },
      serverInfo: SANDBOX_SERVER_INFO,
      _meta: { "io.modelcontextprotocol/serverInfo": SANDBOX_SERVER_INFO },
    });
  });

  it("answers server/discover as a probe even without _meta", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const { status, json } = await harness.rpc("server/discover", {}, { era: "legacy", headers: { "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION } });
    expect(status).toBe(200);
    expect(json.result.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
  });

  it("lists the tool as a cacheable result", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const { json } = await harness.rpc("tools/list");
    expect(json.result).toMatchObject({ resultType: "complete", ttlMs: 3_600_000, cacheScope: "public" });
    expect(json.result.tools[0].inputSchema).toEqual(NPM_RECALL_INPUT_SCHEMA);
  });

  it("rejects requests whose headers do not mirror the body with 400 HeaderMismatch", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const cases: Array<[string, RpcOptions]> = [
      ["missing MCP-Protocol-Version", { headers: { "MCP-Protocol-Version": null } }],
      ["different MCP-Protocol-Version", { headers: { "MCP-Protocol-Version": "2025-11-25" } }],
      ["missing Mcp-Method", { headers: { "Mcp-Method": null } }],
      ["different Mcp-Method", { headers: { "Mcp-Method": "tools/list" } }],
      ["missing Mcp-Name", { headers: { "Mcp-Name": null } }],
      ["different Mcp-Name", { headers: { "Mcp-Name": "achromat_calibrate" } }],
    ];
    for (const [label, options] of cases) {
      const { status, json } = await harness.recall(RECALL_ARGS, options);
      expect(status, label).toBe(400);
      expect(json.error.code, label).toBe(RPC.HEADER_MISMATCH);
    }
    expect(harness.analytics.points).toHaveLength(0);
  });

  it("accepts a Base64-sentinel Mcp-Name", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const { status, json } = await harness.recall(RECALL_ARGS, { headers: { "Mcp-Name": `=?base64?${btoa("achromat_recall")}?=` } });
    expect(status).toBe(200);
    expect(json.result.isError).toBe(false);
  });

  it("rejects an unknown modern version with -32022 listing the supported ones, and an unknown method with 404", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const body = { jsonrpc: "2.0", id: 9, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2027-01-01" } } };
    const future = await harness.rpc("tools/list", {}, {
      rawBody: JSON.stringify(body),
      headers: { "MCP-Protocol-Version": "2027-01-01" },
    });
    expect(future.status).toBe(400);
    expect(future.json.error).toMatchObject({ code: RPC.UNSUPPORTED_PROTOCOL_VERSION, data: { supported: [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS] } });

    const unknown = await harness.rpc("prompts/list");
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe(RPC.METHOD_NOT_FOUND);
    // ping was removed from the modern protocol.
    expect((await harness.rpc("ping")).status).toBe(404);
  });
});

// ───────────────────────── the sandbox tool ─────────────────────────

describe("POST /mcp tools/call achromat_recall", () => {
  it("serves at most 5 approved public lessons for the domain, featured first, never the blocked call or unreviewed lessons", async () => {
    const world = await freshWorld({ mcpCacheSeconds: 0 });
    const harness = createHarness(world);
    const owner = await community();

    const featured = await pendingLesson(world, owner.key);
    await humanReview(featured.lessonId, "approve");
    const approved: string[] = [];
    for (let i = 0; i < 5; i++) {
      const pair = await pendingLesson(world, owner.key);
      await humanReview(pair.lessonId, "approve");
      approved.push(pair.lessonId);
    }
    await tick();
    await reviewEvent(featured.lessonId, "feature");
    const pending = await pendingLesson(world, owner.key);
    const quarantined = await pendingLesson(world, owner.key);
    await humanReview(quarantined.lessonId, "approve");
    await humanReview(quarantined.lessonId, "quarantine", "needs_recheck");
    world.embedder.calls = [];

    const { status, json } = await harness.recall();
    expect(status).toBe(200);
    const result = json.result;
    expect(result.isError).toBe(false);
    const lessons = result.structuredContent.lessons as Array<Record<string, unknown>>;
    expect(lessons).toHaveLength(SANDBOX_LESSON_LIMIT);
    expect(lessons[0]).toMatchObject({ lesson_id: featured.lessonId, featured: true, domain: "fintech", compliant_arguments: FIX_ARGUMENTS });
    // The rest are the newest approved lessons, newest first.
    expect(lessons.slice(1).map((lesson) => lesson.lesson_id)).toEqual([...approved].reverse().slice(0, 4));
    const ids = lessons.map((lesson) => lesson.lesson_id);
    expect(ids).not.toContain(pending.lessonId);
    expect(ids).not.toContain(quarantined.lessonId);

    const body = JSON.stringify(json);
    expect(body).not.toContain(MARKER);
    expect(body).not.toContain("PRIVATE-VALUE-123"); // the caller's arguments are never echoed
    expect(body).not.toContain(RECALL_ARGS.task_description);
    expect(body).not.toMatch(/receipt|attestation/);

    // The upstream rule name is neither in the structured lessons nor on a "Rule:" line of the text.
    expect(body).not.toContain("violation_rule");
    expect(body).not.toContain("Dual authorisation for large transfers");
    expect(text(result)).not.toMatch(/^\s*Rule:/m);
    for (const lesson of lessons) expect(lesson).not.toHaveProperty("violation_rule");
    expect(text(result)).toContain("Statutory anchor: FCA SYSC 6.1.1");

    // The notice opens and closes the text, and the samples are labelled as such.
    expect(text(result).startsWith(NOTICE)).toBe(true);
    expect(text(result).endsWith(NOTICE)).toBe(true);
    expect(text(result)).toContain("not a match for your call");
    expect(text(result)).toContain("illustration only, do not execute");
    expect(JSON.parse(result.content[1].text)).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({ notice: NOTICE, install: SANDBOX_INSTALL_COMMAND, match: false, sandbox: true });

    // No search: nothing embedded, nothing queried.
    expect(world.embedder.calls).toHaveLength(0);
    expect(world.store.queryCalls).toHaveLength(0);
    expect(harness.analytics.points.at(-1)).toEqual({
      indexes: ["anonymous"],
      blobs: ["mcp_sandbox_recall", "fintech", "dispatch_wire", "anonymous", "sample"],
      doubles: [1],
    });
  }, 60_000);

  it("ignores task_description and arguments: different values give the same lessons, other domains get none", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const first = await harness.recall();
    const second = await harness.recall({
      ...RECALL_ARGS,
      task_description: "Grant production database access to a contractor",
      arguments: { completely: { different: ["shape"] } },
    });
    expect(second.json.result.structuredContent.lessons).toEqual(first.json.result.structuredContent.lessons);
    const other = await harness.recall({ ...RECALL_ARGS, domain: "devsecops" });
    expect(other.json.result.structuredContent.lessons).toEqual([]);
    expect(text(other.json.result)).toContain("No public sample lessons for devsecops yet.");
  });

  it("enforces the npm schema as a tool error that names the fields but never echoes values", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const cases: Array<[string, Record<string, unknown>]> = [
      ["domain", { ...RECALL_ARGS, domain: "healthcare-SECRET" }],
      ["tool_name", { ...RECALL_ARGS, tool_name: "-bad tool SECRET" }],
      ["task_description", { ...RECALL_ARGS, task_description: "SECRET short" }],
      ["arguments", { ...RECALL_ARGS, arguments: {} }],
      ["arguments", { domain: "fintech", tool_name: "dispatch_wire", task_description: RECALL_ARGS.task_description }],
    ];
    for (const [field, args] of cases) {
      const { status, json } = await harness.recall(args);
      expect(status, field).toBe(200);
      expect(json.result.isError, field).toBe(true);
      expect(text(json.result), field).toContain(field);
      expect(text(json.result), field).toContain(NOTICE);
      expect(text(json.result), field).not.toContain("SECRET");
    }
    expect(harness.analytics.points).toHaveLength(0);
  });

  it("answers an unknown tool with -32602", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const { status, json } = await harness.rpc("tools/call", { name: "achromat_calibrate", arguments: RECALL_ARGS });
    expect(status).toBe(200);
    expect(json.error.code).toBe(RPC.INVALID_PARAMS);
  });

  it("caches each domain's lessons at the edge for 300 seconds on the deployed Worker", async () => {
    const world = await freshWorld();
    const owner = await community();
    const cacheKey = new Request(`${ORIGIN}/mcp/_sandbox/v2/fintech`);
    await caches.default.delete(cacheKey);

    const post = () =>
      call("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "achromat_recall", arguments: RECALL_ARGS } }),
      }).then(async (response) => ({ response, json: (await response.json()) as any }));
    const ids = (answer: { json: any }) => (answer.json.result.structuredContent.lessons as Array<{ lesson_id: string }>).map((lesson) => lesson.lesson_id);

    const before = await post();
    // The JSON-RPC answer itself is never cached (its id varies); the lessons behind it are.
    expect(before.response.headers.get("Cache-Control")).toBe("no-store");
    const cached = await caches.default.match(cacheKey);
    expect(cached?.headers.get("Cache-Control")).toBe("public, max-age=300");

    // A newly approved lesson ranks second (after the featured one), but the cached list is served until it expires.
    const pair = await pendingLesson(world, owner.key);
    await humanReview(pair.lessonId, "approve");
    expect(ids(await post())).toEqual(ids(before));
    await caches.default.delete(cacheKey);
    expect(ids(await post())).toContain(pair.lessonId);
    await caches.default.delete(cacheKey);
  }, 60_000);
});

// ───────────────────────── transport ─────────────────────────

describe("/mcp transport", () => {
  it("answers a CORS preflight permissively and puts Access-Control-Allow-Origin on every answer", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const preflight = await harness.send(
      new Request(`${ORIGIN}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:6274",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, mcp-protocol-version, mcp-method, mcp-name, authorization",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe("content-type, mcp-protocol-version, mcp-method, mcp-name, authorization");

    const fromBrowser = await harness.rpc("tools/list", {}, { headers: { Origin: "http://localhost:6274" } });
    expect(fromBrowser.status).toBe(200);
    expect(fromBrowser.response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(fromBrowser.response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("refuses GET and DELETE with 405, and rejects batches, bad JSON, oversized bodies and missing caller IPs", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    for (const method of ["GET", "DELETE"]) {
      const response = await harness.send(new Request(`${ORIGIN}/mcp`, { method, headers: { "CF-Connecting-IP": freshIp() } }));
      expect(response.status, method).toBe(405);
      expect(response.headers.get("Allow"), method).toBe("POST, OPTIONS");
      expect(response.headers.get("Access-Control-Allow-Origin"), method).toBe("*");
    }
    const batch = await harness.rpc("tools/list", {}, { rawBody: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]) });
    expect(batch.status).toBe(400);
    expect(batch.json.error.code).toBe(RPC.INVALID_REQUEST);
    const garbage = await harness.rpc("tools/list", {}, { rawBody: "{not json" });
    expect(garbage.status).toBe(400);
    expect(garbage.json).toMatchObject({ id: null, error: { code: RPC.PARSE_ERROR } });
    const huge = await harness.rpc("tools/list", {}, { rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(70_000) }) });
    expect(huge.status).toBe(413);
    expect((await harness.rpc("tools/list", {}, { ip: null })).status).toBe(400);
  });

  it("allows 60 requests a minute per network, then answers 429 with Retry-After", async () => {
    const harness = createHarness(await freshWorld({ mcpCacheSeconds: 0 }));
    const ip = freshIp();
    for (let i = 0; i < 60; i++) expect((await harness.rpc("server/discover", {}, { ip })).status, `request ${i + 1}`).toBe(200);
    const limited = await harness.rpc("server/discover", {}, { ip });
    expect(limited.status).toBe(429);
    expect(limited.response.headers.get("Retry-After")).toBe("60");
    expect(limited.json.error.code).toBe(RPC.RATE_LIMITED);
    // Another network is unaffected.
    expect((await harness.rpc("server/discover")).status).toBe(200);
  });

  it("is reachable on the deployed Worker without a signature", async () => {
    const response = await call("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).result.tools[0].name).toBe("achromat_recall");
  });
});

describe("sandbox constants", () => {
  it("offer the domains the service serves, and name the package and endpoint the discovery documents name", () => {
    expect([...SANDBOX_DOMAINS].sort()).toEqual(Object.keys(DOMAIN_BUNDLES).sort());
    expect(SANDBOX_INSTALL_COMMAND).toBe(`npx -y ${MCP_PACKAGE}`);
    expect(SANDBOX_NOTICE).toBe(NOTICE);
    expect(MCP_REMOTE_URL).toBe(`${SITE_ORIGIN}/mcp`);
    expect(SANDBOX_SERVER_INFO.websiteUrl).toBe(SITE_ORIGIN);
  });
});
