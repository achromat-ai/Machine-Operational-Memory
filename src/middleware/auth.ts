/**
 * Ed25519 signed-request middleware.
 *
 * Headers: Achromat-Agent-Key, Achromat-Timestamp, Achromat-Nonce, Achromat-Signature.
 * Signed string (src/schema.ts requestSigningString):
 *   achromat-mom-v1\n{host}\n{METHOD}\n{path+query}\n{sha256hex(body)}\n{timestamp}\n{nonce}
 *
 * Checks run cheapest-first, so an unauthenticated caller never reaches D1, the
 * nonce registry or the JSON parser:
 *   1. header shapes            401 AGENT_SIGNATURE_REQUIRED / AGENT_SIGNATURE_INVALID
 *   2. |now - timestamp| ≤ 60 s 401 AGENT_SIGNATURE_EXPIRED
 *   3. body size                413 BODY_TOO_LARGE
 *   4. Ed25519 signature        401 AGENT_SIGNATURE_INVALID
 *   5. key registered, live     401 AGENT_KEY_UNKNOWN / 403 AGENT_KEY_INACTIVE / AGENT_ROLE_FORBIDDEN
 *   6. nonce unused (120 s)     401 AGENT_NONCE_REPLAYED
 *
 * On success the route sees c.var.agent_pubkey (64-char hex, the D1 agent_key),
 * c.var.agent and c.var.raw_body (the exact bytes that were signed).
 *
 * Role-based access control for a route group is a second, cheap layer that runs AFTER this
 * middleware: requireRole() (any role list), requireAdminIdentity() (admin routes) and
 * requireAdminOrInternalIdentity() (bounty board). They must
 * not re-run requireAgentSignature: the body stream is already consumed and the nonce is spent.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { apiError, readBodyBytes } from "../http";
import { readSignatureHeaders, requestSigningString, sha256Hex, timestampWithinSkew, verifyProofOfPossession } from "../schema";

export type AgentRole = "community" | "internal" | "admin" | "platform";
export type AgentStatus = "active" | "throttled" | "revoked" | "rotated";

export interface AuthenticatedAgent {
  /** 64-char lowercase hex: the D1 agent_key. */
  agentKey: string;
  /** Unpadded base64url, as sent in Achromat-Agent-Key. */
  publicKey: string;
  role: AgentRole;
  status: AgentStatus;
}

export interface AuthVariables {
  agent_pubkey: string;
  agent: AuthenticatedAgent;
  raw_body: Uint8Array;
}

export interface AgentSignatureOptions {
  /** Roles allowed on the route. Default: every role. */
  roles?: readonly AgentRole[];
  /** Maximum signed body size. Default 64 KiB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export function requireAgentSignature(
  options: AgentSignatureOptions = {},
): MiddlewareHandler<{ Bindings: Env; Variables: AuthVariables }> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (c, next) => {
    const parsed = readSignatureHeaders(c.req.raw.headers);
    if (!parsed.ok) {
      const message =
        parsed.code === "AGENT_SIGNATURE_REQUIRED"
          ? "this endpoint requires an Ed25519-signed request"
          : "signature headers are malformed";
      return apiError(c, 401, parsed.code, message, parsed.failure.details);
    }
    const headers = parsed.value;

    if (!timestampWithinSkew(headers.timestampSeconds)) {
      return apiError(c, 401, "AGENT_SIGNATURE_EXPIRED", "Achromat-Timestamp must be within 60 seconds of server time");
    }

    const body = await readBodyBytes(c.req.raw, maxBodyBytes);
    if (body === null) return apiError(c, 413, "BODY_TOO_LARGE", `request body must be at most ${maxBodyBytes} bytes`);

    const url = new URL(c.req.url);
    const signingString = requestSigningString({
      host: url.host,
      method: c.req.method,
      pathAndQuery: url.pathname + url.search,
      bodySha256Hex: await sha256Hex(body),
      timestamp: headers.timestamp,
      nonce: headers.nonce,
    });
    if (!(await verifyProofOfPossession(headers, signingString))) {
      return apiError(c, 401, "AGENT_SIGNATURE_INVALID", "signature does not verify for this key and request");
    }

    const state = await c.env.DB.prepare("SELECT role, status FROM agent_state WHERE agent_key = ?")
      .bind(headers.agentKeyHex)
      .first<{ role: AgentRole; status: AgentStatus }>();
    if (state === null) {
      return apiError(c, 401, "AGENT_KEY_UNKNOWN", "agent key is not registered; see POST /api/v1/agents/register");
    }
    if (state.status === "revoked" || state.status === "rotated") {
      return apiError(c, 403, "AGENT_KEY_INACTIVE", `agent key is ${state.status}`);
    }
    if (options.roles && !options.roles.includes(state.role)) {
      return apiError(c, 403, "AGENT_ROLE_FORBIDDEN", "agent key role is not allowed on this endpoint");
    }

    const registry = c.env.NONCE_REGISTRY.get(c.env.NONCE_REGISTRY.idFromName(headers.agentKeyHex));
    if (!(await registry.consume(headers.nonce))) {
      return apiError(c, 401, "AGENT_NONCE_REPLAYED", "Achromat-Nonce has already been used");
    }

    c.set("agent_pubkey", headers.agentKeyHex);
    c.set("agent", { agentKey: headers.agentKeyHex, publicKey: headers.agentKey, role: state.role, status: state.status });
    c.set("raw_body", body);
    await next();
  };
}

type AuthContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

/**
 * Role gate for a route group. Mount it after the signed-request middleware (app.ts applies that to
 * every non-public /api/v1 route). Fails closed: a route mounted outside the signed gate has no
 * c.var.agent and answers 403. Only an `active` key passes, so a `throttled` key cannot use these
 * endpoints even though the signed-request middleware lets it through.
 */
export function requireRole(...roles: readonly AgentRole[]): MiddlewareHandler<{ Bindings: Env; Variables: AuthVariables }> {
  return async (c, next) => {
    const agent = c.get("agent") as AuthenticatedAgent | undefined;
    if (!agent || agent.status !== "active" || !roles.includes(agent.role)) {
      return apiError(c, 403, "AGENT_ROLE_FORBIDDEN", "agent key role is not allowed on this endpoint");
    }
    await next();
  };
}

/**
 * Defense in depth for admin routes. agent_state is a projection with no UPDATE guard, so its role is
 * not trusted alone: the caller must also be an admin in agent_identities, the insert-only registration
 * record (agent_identities_no_update). Status still comes from agent_state, where revocation lives.
 */
export async function assertAdminIdentity(c: AuthContext): Promise<boolean> {
  const agent = c.get("agent") as AuthenticatedAgent | undefined;
  if (!agent || agent.role !== "admin" || agent.status !== "active") return false;
  const row = await c.env.DB.prepare(
    `SELECT 1 AS ok
       FROM agent_identities i JOIN agent_state s ON s.agent_key = i.agent_key
      WHERE i.agent_key = ?1 AND i.role = 'admin' AND s.role = 'admin' AND s.status = 'active'`,
  )
    .bind(agent.agentKey)
    .first<{ ok: number }>();
  return row !== null;
}

/**
 * Defense in depth for the bounty board (admin or internal keys). Same reasoning as assertAdminIdentity:
 * the board exposes raw failure parameters, so the role must also be present in the insert-only
 * agent_identities record, not only in the agent_state projection.
 */
export async function assertAdminOrInternalIdentity(c: AuthContext): Promise<boolean> {
  const agent = c.get("agent") as AuthenticatedAgent | undefined;
  if (!agent || agent.status !== "active" || (agent.role !== "admin" && agent.role !== "internal")) return false;
  const row = await c.env.DB.prepare("SELECT 1 AS ok FROM agent_identities WHERE agent_key = ?1 AND role IN ('admin', 'internal')")
    .bind(agent.agentKey)
    .first<{ ok: number }>();
  return row !== null;
}

/** Bounty-board gate: the requireRole("admin", "internal") rules plus the assertAdminOrInternalIdentity cross-check. */
export function requireAdminOrInternalIdentity(): MiddlewareHandler<{ Bindings: Env; Variables: AuthVariables }> {
  return async (c, next) => {
    if (!(await assertAdminOrInternalIdentity(c))) {
      return apiError(c, 403, "AGENT_ROLE_FORBIDDEN", "agent key role is not allowed on this endpoint");
    }
    await next();
  };
}

/** Admin-route gate: the requireRole("admin") rules plus the assertAdminIdentity cross-check. */
export function requireAdminIdentity(): MiddlewareHandler<{ Bindings: Env; Variables: AuthVariables }> {
  return async (c, next) => {
    // Role and status come from the in-request agent_state read; the identity row is checked in D1.
    if (!(await assertAdminIdentity(c))) {
      return apiError(c, 403, "AGENT_ROLE_FORBIDDEN", "agent key role is not allowed on this endpoint");
    }
    await next();
  };
}
