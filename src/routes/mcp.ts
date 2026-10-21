/**
 * POST /mcp (public, unauthenticated): the Achromat MOM MCP sandbox, over Streamable HTTP.
 *
 * A marketing preview for registries and MCP hosts that cannot sign requests. It exposes one tool,
 * achromat_recall, whose input schema is byte-for-byte the one the npm package (@achromat-ai/mcp-server)
 * advertises. The sandbox validates that input but never reads task_description or arguments: it does not
 * embed, query Vectorize, log demand or count deliveries. It returns up to 5 approved, public lessons for
 * the requested domain (featured first, then the most recently updated), the same public fields
 * GET /api/v1/feed already serves, with a notice that they are samples and how to get the full server.
 *
 * Dual-era (MCP 2026-07-28 "modern" and the 2025-xx "legacy" Streamable HTTP revisions), stateless:
 *   modern   every request carries _meta["io.modelcontextprotocol/protocolVersion"]; the MCP-Protocol-Version,
 *            Mcp-Method and (tools/call) Mcp-Name headers must match the body (else 400, -32020 HeaderMismatch).
 *            server/discover, tools/list, tools/call. Results carry resultType and _meta serverInfo.
 *   legacy   initialize (answered without a session id), ping, tools/list, tools/call; notifications get 202.
 * Every answer is a single application/json object (nothing here streams). GET and DELETE get 405.
 *
 * CORS is permissive (any Origin, preflight answered) so browser tools such as MCP Inspector can call it. That is
 * the Origin policy the transport asks servers to apply: the endpoint is public, read-only and needs no
 * credentials, so there is nothing a DNS-rebinding page could reach that any client could not.
 *
 * Order: caller network → per-network limit (60/min per /24 or /48) → body (64 KiB) → JSON-RPC envelope →
 * era and header checks → dispatch.
 */
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Env } from "../env";
import { parseJsonBytes, readBodyBytes } from "../http";
import type { AuthVariables } from "../middleware/auth";
import { callerNetwork } from "../network";
import { recordTelemetry } from "../telemetry";
import { PUBLIC_LESSON_SQL, presentPublicLesson, type FeedRow } from "./feed";

export const MCP_PATH = "/mcp";
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
/** Newest first. A legacy initialize asking for anything else is answered with the first one. */
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS] as const;
/** What a legacy request without MCP-Protocol-Version is taken to speak (the transport's own fallback rule). */
const LEGACY_VERSION_WITHOUT_HEADER = "2025-03-26";

export const SANDBOX_LESSON_LIMIT = 5;
/** Edge cache lifetime of one domain's sample lessons. */
export const SANDBOX_CACHE_SECONDS = 300;
export const SANDBOX_MAX_BODY_BYTES = 64 * 1024;
export const SANDBOX_TOOL_NAME = "achromat_recall";
export const SANDBOX_INSTALL_COMMAND = "npx -y @achromat-ai/mcp-server";

/** Shown first and last in every tool result, including empty and error results. */
export const SANDBOX_NOTICE =
  "This is a sandboxed preview. Do not use these sample arguments for live execution. To access the full semantic vector space and calibration engine, install the local MCP server via 'npx -y @achromat-ai/mcp-server'.";

export const SANDBOX_SERVER_INFO = {
  name: "ai.achromat/mom-sandbox",
  title: "Achromat MOM (sandbox)",
  version: "0.1.0",
  websiteUrl: "https://mom.achromat.ai",
} as const;

const SERVER_INSTRUCTIONS =
  `Public sandbox of Achromat MOM. achromat_recall returns sample verified lessons for a domain; it does not match or evaluate your call. ${SANDBOX_NOTICE}`;

const CAPABILITIES = { tools: { listChanged: false } } as const;

// ───────────────────────────── the tool ─────────────────────────────

/** The domains the npm package's schema offers (the keys of src/config/domains.ts DOMAIN_BUNDLES; a test pins it). */
export const SANDBOX_DOMAINS = ["fintech", "industrial_iot", "robotics", "devsecops"] as const;

/**
 * The npm package's achromat_recall inputSchema, exactly as its tools/list advertises it (@achromat-ai/mcp-server
 * 0.1.1, the JSON Schema its SDK generates from src/tools.ts recallInput). Keep it identical: an agent that learnt
 * the call here must be able to make the same call against the full server.
 */
export const RECALL_INPUT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    domain: {
      type: "string",
      enum: [...SANDBOX_DOMAINS],
      description: "The area the tool call belongs to.",
    },
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
} as const;

export const SANDBOX_RECALL_TOOL = {
  name: SANDBOX_TOOL_NAME,
  title: "Recall a verified compliant tool call (sandbox preview)",
  description:
    "SANDBOX PREVIEW of Achromat MOM. It takes the same input as the full achromat_recall, but this public endpoint does not search: it ignores task_description and arguments and returns up to 5 featured, approved sample lessons for the domain, each pairing a policy-blocked agent tool call with the compliant fix that was then allowed. The results are examples, never a match for your call: do not use their arguments for live execution. For semantic recall of your own call and live calibration, the user can install the local MCP server: npx -y @achromat-ai/mcp-server.",
  inputSchema: RECALL_INPUT_SCHEMA,
  annotations: {
    title: "Recall a verified compliant tool call (sandbox preview)",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

/** The same limits the npm package enforces on this input (its src/tools.ts recallInput). Unknown keys are ignored. */
const RecallInput = z.object({
  domain: z.enum(SANDBOX_DOMAINS),
  tool_name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/, "1 to 64 characters from A-Z a-z 0-9 _ . : / -, starting with a letter or digit"),
  task_description: z
    .string()
    .min(16)
    .max(1000)
    .refine((value) => value.trim().split(/\s+/).length >= 3, "at least 3 words"),
  arguments: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0, "arguments must not be empty"),
});

// ───────────────────────────── JSON-RPC ─────────────────────────────

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Implementation-defined range: the per-network limit. */
  RATE_LIMITED: -32000,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
} as const;

type RpcId = string | number | null;
type Era = "modern" | "legacy";
type McpEnv = { Bindings: Env; Variables: AuthVariables };
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" } as const;

function rpcResult(c: Context<McpEnv>, id: RpcId, result: JsonObject) {
  return c.body(JSON.stringify({ jsonrpc: "2.0", id, result }), 200, JSON_HEADERS);
}

function rpcError(c: Context<McpEnv>, status: ContentfulStatusCode, id: RpcId, code: number, message: string, data?: unknown) {
  const error = data === undefined ? { code, message } : { code, message, data };
  return c.body(JSON.stringify({ jsonrpc: "2.0", id, error }), status, JSON_HEADERS);
}

/** Header values may carry the transport's Base64 sentinel, =?base64?…?=. null if it does not decode. */
export function decodeHeaderValue(value: string): string | null {
  const encoded = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (!encoded) return value;
  try {
    const binary = atob(encoded[1]!);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

function withModernMeta(result: JsonObject, era: Era): JsonObject {
  return era === "modern"
    ? { resultType: "complete", ...result, _meta: { "io.modelcontextprotocol/serverInfo": SANDBOX_SERVER_INFO } }
    : result;
}

// ───────────────────────────── sandbox lessons ─────────────────────────────

type SampleLesson = ReturnType<typeof presentPublicLesson>;

/** Featured lessons first, then the most recently updated. Only approved, public lessons (PUBLIC_LESSON_SQL). */
const SANDBOX_SQL = `${PUBLIC_LESSON_SQL}
   AND l.domain = ?1
 ORDER BY s.featured DESC, s.updated_at_ms DESC, l.lesson_id DESC
 LIMIT ?2`;

async function sampleLessons(c: Context<McpEnv>, domain: string, cacheSeconds: number): Promise<SampleLesson[]> {
  // One cache entry per domain, keyed on a synthetic path. The domain is an enum, so callers cannot create more.
  const cacheKey = new Request(new URL(`${MCP_PATH}/_sandbox/${domain}`, c.req.url).toString());
  const cache = cacheSeconds > 0 ? caches.default : null;
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return (await hit.json()) as SampleLesson[];
    } catch (error) {
      console.error("achromat-mom mcp sandbox cache read failed", error instanceof Error ? error.message : error);
    }
  }

  const rows = await c.env.DB.prepare(SANDBOX_SQL).bind(domain, SANDBOX_LESSON_LIMIT).all<FeedRow>();
  const lessons = rows.results.map(presentPublicLesson);

  if (cache) {
    const body = JSON.stringify(lessons);
    const store = cache
      .put(cacheKey, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${cacheSeconds}` } }))
      .catch((error: unknown) => console.error("achromat-mom mcp sandbox cache write failed", error instanceof Error ? error.message : error));
    try {
      c.executionCtx.waitUntil(store);
    } catch {
      await store; // no execution context (a direct call): finish the write before answering
    }
  }
  return lessons;
}

function lessonLines(lesson: SampleLesson, index: number): string[] {
  const lines = [`${index + 1}. ${lesson.display_title ?? lesson.violation_rule} (tool: ${lesson.tool})`, `   Rule: ${lesson.violation_rule}`];
  if (lesson.steering_directive) lines.push(`   Steering: ${lesson.steering_directive}`);
  if (lesson.statutory_anchor) lines.push(`   Statutory anchor: ${lesson.statutory_anchor}`);
  lines.push(`   Changed paths: ${lesson.changed_paths.join(", ")}`);
  lines.push(`   Sample compliant arguments (illustration only, do not execute): ${JSON.stringify(lesson.compliant_arguments)}`);
  return lines;
}

/** The tool result: the notice first and last in the text, the same data as structuredContent and as JSON text. */
export function sandboxToolResult(domain: string, lessons: readonly SampleLesson[]): JsonObject {
  const structured = {
    sandbox: true,
    match: false,
    notice: SANDBOX_NOTICE,
    install: SANDBOX_INSTALL_COMMAND,
    domain,
    lessons,
  };
  const body =
    lessons.length === 0
      ? [`No public sample lessons for ${domain} yet.`]
      : [
          `Sample verified lessons for ${domain}. They are examples, not a match for your call:`,
          "",
          ...lessons.flatMap((lesson, index) => [...lessonLines(lesson, index), ""]),
        ];
  const text = [SANDBOX_NOTICE, "", ...body, "", SANDBOX_NOTICE].join("\n").replace(/\n{3,}/g, "\n\n");
  return {
    content: [
      { type: "text", text },
      { type: "text", text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
    isError: false,
  };
}

/** A tool execution error: the model sees why, and the notice, and can correct the call. */
function toolError(message: string): JsonObject {
  return { content: [{ type: "text", text: `${message}\n\n${SANDBOX_NOTICE}` }], isError: true };
}

async function callRecall(c: Context<McpEnv>, args: unknown, cacheSeconds: number): Promise<JsonObject> {
  const parsed = RecallInput.safeParse(args ?? {});
  if (!parsed.success) {
    // Paths and messages only: the caller's values are never echoed.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`);
    return toolError(`Invalid achromat_recall input. ${problems.join("; ")}`);
  }
  const { domain, tool_name: tool } = parsed.data;
  let lessons: SampleLesson[];
  try {
    lessons = await sampleLessons(c, domain, cacheSeconds);
  } catch (error) {
    console.error("achromat-mom mcp sandbox lessons failed", error instanceof Error ? error.message : error);
    return toolError("The Achromat MOM sandbox is temporarily unavailable. Retry shortly.");
  }
  recordTelemetry(c, { action: "mcp_sandbox_recall", domain, tool, agentKey: null, status: lessons.length > 0 ? "sample" : "empty" });
  return sandboxToolResult(domain, lessons);
}

// ───────────────────────────── routes ─────────────────────────────

const DEFAULT_ALLOWED_HEADERS = "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID";
/** A requested header list is echoed only if it is a plain list of header names. */
const HEADER_LIST = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+(\s*,\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/;

export interface McpRoutesOptions {
  /** Edge cache lifetime of the sample lessons in seconds. Default 300; tests pass 0 because they share one D1. */
  cacheSeconds?: number;
}

export function createMcpRoutes(options: McpRoutesOptions = {}) {
  const cacheSeconds = options.cacheSeconds ?? SANDBOX_CACHE_SECONDS;
  const mcp = new Hono<McpEnv>();

  // Permissive CORS on every answer, errors and 405s included.
  mcp.use("*", async (c, next) => {
    await next();
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Expose-Headers", "MCP-Protocol-Version, Retry-After");
  });

  mcp.options("/", (c) => {
    const requested = c.req.header("access-control-request-headers")?.trim();
    c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", requested && HEADER_LIST.test(requested) ? requested : DEFAULT_ALLOWED_HEADERS);
    c.header("Access-Control-Max-Age", "86400");
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  });

  mcp.post("/", (c) => handleMcp(c, cacheSeconds));

  // Streamable HTTP 2026-07-28: no standalone GET stream and no sessions to DELETE.
  mcp.all("/", (c) => {
    c.header("Allow", "POST, OPTIONS");
    return rpcError(c, 405, null, RPC.INVALID_REQUEST, "use POST for MCP requests");
  });

  return mcp;
}

async function handleMcp(c: Context<McpEnv>, cacheSeconds: number) {
  let network;
  try {
    network = await callerNetwork(c.req.raw, c.env.IP_HMAC_KEY);
  } catch (error) {
    console.error("achromat-mom mcp sandbox misconfigured", error instanceof Error ? error.message : error);
    return rpcError(c, 503, null, RPC.INTERNAL_ERROR, "the sandbox is temporarily unavailable");
  }
  if (network === null) return rpcError(c, 400, null, RPC.INVALID_REQUEST, "caller IP address could not be determined");

  const { success } = await c.env.MCP_LIMITER.limit({ key: `mcp:${network.prefixHmac}` });
  if (!success) {
    c.header("Retry-After", "60");
    return rpcError(c, 429, null, RPC.RATE_LIMITED, "too many requests from this network; retry in a minute");
  }

  const bytes = await readBodyBytes(c.req.raw, SANDBOX_MAX_BODY_BYTES);
  if (bytes === null) return rpcError(c, 413, null, RPC.INVALID_REQUEST, `request body must be at most ${SANDBOX_MAX_BODY_BYTES} bytes`);
  const message = parseJsonBytes(bytes);
  if (message === undefined) return rpcError(c, 400, null, RPC.PARSE_ERROR, "body is not valid JSON");
  if (Array.isArray(message)) return rpcError(c, 400, null, RPC.INVALID_REQUEST, "JSON-RPC batches are not supported");
  if (!isObject(message) || message.jsonrpc !== "2.0") return rpcError(c, 400, null, RPC.INVALID_REQUEST, "body must be a JSON-RPC 2.0 message");

  const { method } = message;
  if (typeof method !== "string") return rpcError(c, 400, null, RPC.INVALID_REQUEST, "only JSON-RPC requests and notifications are accepted");
  const isNotification = !Object.hasOwn(message, "id");
  if (isNotification) return c.body(null, 202, { "Cache-Control": "no-store" });
  const { id } = message;
  if (typeof id !== "string" && typeof id !== "number") return rpcError(c, 400, null, RPC.INVALID_REQUEST, "id must be a string or a number");

  if (message.params !== undefined && !isObject(message.params)) return rpcError(c, 400, id, RPC.INVALID_PARAMS, "params must be an object");
  const params: JsonObject = message.params ?? {};
  const meta = isObject(params._meta) ? params._meta : {};
  const metaVersion = meta["io.modelcontextprotocol/protocolVersion"];

  // The headers mirror the body. Whichever era, a header that is sent must match it.
  const headerVersion = c.req.header("mcp-protocol-version");
  const headerMethod = c.req.header("mcp-method");
  if (headerMethod !== undefined && headerMethod !== method) {
    return rpcError(c, 400, id, RPC.HEADER_MISMATCH, "Mcp-Method header does not match the request method");
  }

  if (method === "initialize") return legacyInitialize(c, id, params);

  let era: Era;
  if (typeof metaVersion === "string") {
    era = "modern";
    if (headerVersion !== metaVersion) {
      return rpcError(c, 400, id, RPC.HEADER_MISMATCH, "MCP-Protocol-Version header must match _meta io.modelcontextprotocol/protocolVersion");
    }
    if (headerMethod === undefined) return rpcError(c, 400, id, RPC.HEADER_MISMATCH, "Mcp-Method header is required");
    if (metaVersion !== MODERN_PROTOCOL_VERSION) {
      return rpcError(c, 400, id, RPC.UNSUPPORTED_PROTOCOL_VERSION, "unsupported protocol version", {
        supported: [...SUPPORTED_PROTOCOL_VERSIONS],
        requested: metaVersion,
      });
    }
    if (method === "tools/call") {
      const name = c.req.header("mcp-name");
      if (name === undefined || decodeHeaderValue(name) !== params.name) {
        return rpcError(c, 400, id, RPC.HEADER_MISMATCH, "Mcp-Name header must match params.name");
      }
    }
  } else {
    era = "legacy";
    const version = headerVersion ?? LEGACY_VERSION_WITHOUT_HEADER;
    // server/discover is also a version probe, so it is answered whatever version the header names.
    if (method !== "server/discover" && !(LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      return rpcError(c, 400, id, RPC.UNSUPPORTED_PROTOCOL_VERSION, "unsupported protocol version", {
        supported: [...SUPPORTED_PROTOCOL_VERSIONS],
        requested: version,
      });
    }
  }

  switch (method) {
    case "server/discover":
      return rpcResult(
        c,
        id,
        withModernMeta(
          {
            supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
            capabilities: CAPABILITIES,
            serverInfo: SANDBOX_SERVER_INFO,
            instructions: SERVER_INSTRUCTIONS,
          },
          era,
        ),
      );
    case "tools/list":
      return rpcResult(
        c,
        id,
        withModernMeta(era === "modern" ? { tools: [SANDBOX_RECALL_TOOL], ttlMs: 3_600_000, cacheScope: "public" } : { tools: [SANDBOX_RECALL_TOOL] }, era),
      );
    case "tools/call": {
      if (params.name !== SANDBOX_TOOL_NAME) {
        return rpcError(c, 200, id, RPC.INVALID_PARAMS, `unknown tool; this sandbox offers only ${SANDBOX_TOOL_NAME}`);
      }
      return rpcResult(c, id, withModernMeta(await callRecall(c, params.arguments, cacheSeconds), era));
    }
    case "ping":
      if (era === "legacy") return rpcResult(c, id, {});
      break;
  }
  // Modern servers answer an unimplemented method with 404, so a client can tell it from a legacy-only server.
  return rpcError(c, era === "modern" ? 404 : 200, id, RPC.METHOD_NOT_FOUND, "method not found");
}

/** Legacy handshake (2025-03-26 to 2025-11-25), answered statelessly: no Mcp-Session-Id is minted. */
function legacyInitialize(c: Context<McpEnv>, id: string | number, params: JsonObject) {
  const requested = params.protocolVersion;
  const protocolVersion =
    typeof requested === "string" && (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0];
  return rpcResult(c, id, { protocolVersion, capabilities: CAPABILITIES, serverInfo: SANDBOX_SERVER_INFO, instructions: SERVER_INSTRUCTIONS });
}
