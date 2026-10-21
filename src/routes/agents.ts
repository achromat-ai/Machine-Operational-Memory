/**
 * Agent onboarding.
 *
 *   GET  /api/v1/agents/challenge  unsigned  issue a single-use Hashcash challenge
 *   POST /api/v1/agents/register   unsigned  redeem it for a community key
 *   GET  /api/v1/agents/me         signed    the caller's own key state
 *
 * Every challenge carries an HMAC (challenge_signature, src/crypto/pow-challenge.ts) that registration
 * verifies against the stored row before anything else: unverified challenges get 400 INVALID_CHALLENGE.
 * Registration then proves two things in one request:
 *   - work:       SHA-256(utf8(challenge + public_key + nonce)) has ≥ difficulty_bits leading zero bits
 *   - possession: Ed25519 signature over "achromat-register-v1\n{challenge}\n{public_key}"
 *
 * The D1 triggers in 0001_event_ledger.sql re-check single use, expiry, the
 * network binding and the digest difficulty, so a bug here cannot mint a key
 * the ledger would reject.
 */
import { Hono, type Context } from "hono";
import { powChallengeKeyConfigured, signChallenge, verifyChallengeSignature } from "../crypto/pow-challenge";
import type { Env } from "../env";
import { apiError, parseJsonBytes, readBodyBytes } from "../http";
import type { AuthVariables } from "../middleware/auth";
import { callerNetwork } from "../network";
import { recordTelemetry, refFromUrl } from "../telemetry";
import {
  AgentRegistration,
  POW_ALGORITHM,
  REGISTRATION_SIGNING_CONTEXT,
  decodeBase64url,
  encodeBase64url,
  leadingZeroBits,
  powPreimage,
  registrationSigningString,
  sha256Hex,
  toHex,
  toValidationFailure,
  verifyEd25519,
} from "../schema";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DIFFICULTY_BITS = 22;
const REGISTER_MAX_BODY_BYTES = 4 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Successful registrations allowed per /24 (or /48) per rolling 24 hours. */
export const REGISTRATIONS_PER_PREFIX_PER_DAY = 10;
/** Successful registrations allowed per ASN per rolling 24 hours. */
export const REGISTRATIONS_PER_ASN_PER_DAY = 500;

type AgentsEnv = { Bindings: Env; Variables: AuthVariables };

export const agents = new Hono<AgentsEnv>();

/** Resolves the caller network from CF-Connecting-IP. Fails closed if it is missing or unparsable. */
function callerNetworkOf(c: Context<AgentsEnv>) {
  return callerNetwork(c.req.raw, c.env.IP_HMAC_KEY);
}

function difficultyBits(env: Env): number {
  const bits = Number.parseInt(env.POW_DIFFICULTY_BITS ?? "", 10);
  // The pow_challenges CHECK allows 16-40.
  return Number.isInteger(bits) && bits >= 16 && bits <= 40 ? bits : DEFAULT_DIFFICULTY_BITS;
}

function misconfigured(c: Context<AgentsEnv>) {
  console.error("achromat-mom onboarding misconfigured: POW_CHALLENGE_HMAC_KEY is missing or too short");
  return apiError(c, 503, "SERVICE_MISCONFIGURED", "registration is temporarily unavailable");
}

async function rateLimited(c: Context<AgentsEnv>, scope: string, prefixHmac: string): Promise<boolean> {
  const { success } = await c.env.ONBOARDING_LIMITER.limit({ key: `${scope}:${prefixHmac}` });
  return !success;
}

agents.get("/challenge", async (c) => {
  const network = await callerNetworkOf(c);
  if (network === null) return apiError(c, 400, "CLIENT_IP_UNAVAILABLE", "caller IP address could not be determined");
  if (await rateLimited(c, "challenge", network.prefixHmac)) {
    return apiError(c, 429, "RATE_LIMITED", "too many challenge requests from this network; retry in a minute");
  }

  if (!powChallengeKeyConfigured(c.env.POW_CHALLENGE_HMAC_KEY)) return misconfigured(c);

  const challengeId = crypto.randomUUID();
  const challenge = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
  const bits = difficultyBits(c.env);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + CHALLENGE_TTL_MS;
  const challengeSignature = await signChallenge(c.env.POW_CHALLENGE_HMAC_KEY, {
    challengeId,
    challenge,
    algorithm: POW_ALGORITHM,
    difficultyBits: bits,
    ipPrefixHmac: network.prefixHmac,
    expiresAtMs: expiresAt,
  });

  await c.env.DB.prepare(
    `INSERT INTO pow_challenges (challenge_id, challenge, algorithm, difficulty_bits, ip_prefix_hmac, issued_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(challengeId, challenge, POW_ALGORITHM, bits, network.prefixHmac, issuedAt, expiresAt)
    .run();

  // Funnel step 2 (after skill_view): only challenges that were actually issued are counted.
  recordTelemetry(c, {
    action: "challenge_issued",
    domain: "",
    tool: "",
    agentKey: null,
    status: "issued",
    ref: refFromUrl(c.req.url),
  });

  return c.json({
    success: true,
    challenge_id: challengeId,
    challenge,
    challenge_signature: challengeSignature,
    algorithm: POW_ALGORITHM,
    difficulty_bits: bits,
    expires_at: new Date(expiresAt).toISOString(),
    pow: "sha256(utf8(challenge + public_key + nonce)) must have difficulty_bits leading zero bits; nonce is 1-32 lowercase hex characters",
    proof_message: `${REGISTRATION_SIGNING_CONTEXT}\\n{challenge}\\n{public_key}`,
    challenge_signature_note: "send challenge_signature back unchanged in the register body; challenges without a valid signature are rejected",
  });
});

interface ChallengeRow {
  challenge: string;
  algorithm: string;
  difficulty_bits: number;
  ip_prefix_hmac: string;
  expires_at_ms: number;
}

interface RegistrationCounts {
  challenge_used: number;
  key_exists: number;
  prefix_count: number;
  asn_count: number;
}

/** Maps a D1 trigger abort (the database backstop) to the same errors the route returns itself. */
function triggerConflict(error: unknown): { status: 400 | 409; code: string; message: string } | null {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("already registered") || text.includes("UNIQUE constraint failed")) {
    return { status: 409, code: "CHALLENGE_USED", message: "challenge has already been redeemed or the key is registered" };
  }
  if (text.includes("PoW challenge has expired")) {
    return { status: 400, code: "CHALLENGE_EXPIRED", message: "challenge has expired; request a new one" };
  }
  if (text.includes("different network")) {
    return { status: 400, code: "CHALLENGE_WRONG_NETWORK", message: "challenge was issued to a different network" };
  }
  if (text.includes("difficulty")) {
    return { status: 400, code: "POW_INVALID", message: "proof of work does not meet the challenge difficulty" };
  }
  return null;
}

agents.post("/register", async (c) => {
  const network = await callerNetworkOf(c);
  if (network === null) return apiError(c, 400, "CLIENT_IP_UNAVAILABLE", "caller IP address could not be determined");
  if (await rateLimited(c, "register", network.prefixHmac)) {
    return apiError(c, 429, "RATE_LIMITED", "too many registration attempts from this network; retry in a minute");
  }

  const bytes = await readBodyBytes(c.req.raw, REGISTER_MAX_BODY_BYTES);
  if (bytes === null) return apiError(c, 413, "BODY_TOO_LARGE", `request body must be at most ${REGISTER_MAX_BODY_BYTES} bytes`);
  const parsed = AgentRegistration.safeParse(parseJsonBytes(bytes));
  if (!parsed.success) {
    const failure = toValidationFailure(parsed.error);
    return apiError(c, 400, failure.code, "registration body is invalid", failure.details);
  }
  const body = parsed.data;
  if (!powChallengeKeyConfigured(c.env.POW_CHALLENGE_HMAC_KEY)) return misconfigured(c);
  const agentKey = toHex(decodeBase64url(body.public_key));

  const challenge = await c.env.DB.prepare(
    "SELECT challenge, algorithm, difficulty_bits, ip_prefix_hmac, expires_at_ms FROM pow_challenges WHERE challenge_id = ?",
  )
    .bind(body.challenge_id)
    .first<ChallengeRow>();
  if (challenge === null) return apiError(c, 400, "CHALLENGE_INVALID", "challenge_id is unknown");
  // Authenticity first: the stored challenge must carry a valid HMAC from this Worker. Nothing below
  // (expiry, network, hashing, signature checks) runs for a challenge that fails it.
  const signed = await verifyChallengeSignature(
    c.env.POW_CHALLENGE_HMAC_KEY,
    {
      challengeId: body.challenge_id,
      challenge: challenge.challenge,
      algorithm: challenge.algorithm,
      difficultyBits: challenge.difficulty_bits,
      ipPrefixHmac: challenge.ip_prefix_hmac,
      expiresAtMs: challenge.expires_at_ms,
    },
    body.challenge_signature,
  );
  if (!signed) return apiError(c, 400, "INVALID_CHALLENGE", "challenge signature does not verify; request a new challenge");
  if (Date.now() >= challenge.expires_at_ms) {
    return apiError(c, 400, "CHALLENGE_EXPIRED", "challenge has expired; request a new one");
  }
  if (challenge.ip_prefix_hmac !== network.prefixHmac) {
    return apiError(c, 400, "CHALLENGE_WRONG_NETWORK", "challenge was issued to a different network");
  }

  const powHash = await sha256Hex(powPreimage(challenge.challenge, body.public_key, body.nonce));
  if (leadingZeroBits(powHash) < challenge.difficulty_bits) {
    return apiError(c, 400, "POW_INVALID", "proof of work does not meet the challenge difficulty");
  }
  const possession = await verifyEd25519(
    body.public_key,
    body.proof_signature,
    registrationSigningString(challenge.challenge, body.public_key),
  );
  if (!possession) {
    return apiError(c, 401, "PROOF_OF_POSSESSION_FAILED", "proof_signature does not verify for public_key");
  }

  const since = Date.now() - DAY_MS;
  const counts = (await c.env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM agent_identities WHERE challenge_id = ?1) AS challenge_used,
       (SELECT count(*) FROM agent_identities WHERE agent_key = ?2) AS key_exists,
       (SELECT count(*) FROM agent_identities WHERE ip_prefix_hmac = ?3 AND registered_at_ms > ?4) AS prefix_count,
       (SELECT count(*) FROM agent_identities WHERE asn = ?5 AND registered_at_ms > ?4) AS asn_count`,
  )
    .bind(body.challenge_id, agentKey, network.prefixHmac, since, network.asn)
    .first<RegistrationCounts>())!;
  if (counts.challenge_used > 0) return apiError(c, 409, "CHALLENGE_USED", "challenge has already been redeemed");
  if (counts.key_exists > 0) return apiError(c, 409, "AGENT_KEY_EXISTS", "public_key is already registered");
  if (counts.prefix_count >= REGISTRATIONS_PER_PREFIX_PER_DAY) {
    return apiError(c, 429, "REGISTRATION_LIMIT", "registration limit reached for this network; try again tomorrow");
  }
  if (network.asn !== null && counts.asn_count >= REGISTRATIONS_PER_ASN_PER_DAY) {
    return apiError(c, 429, "REGISTRATION_LIMIT", "registration limit reached for this network; try again tomorrow");
  }

  const registeredAt = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO agent_identities
         (agent_key, role, challenge_id, pow_nonce, pow_hash, rotated_from_key, ip_prefix_hmac, asn, registered_at_ms)
       VALUES (?, 'community', ?, ?, ?, NULL, ?, ?, ?)`,
    )
      .bind(agentKey, body.challenge_id, body.nonce, powHash, network.prefixHmac, network.asn, registeredAt)
      .run();
  } catch (error) {
    const conflict = triggerConflict(error);
    if (conflict) return apiError(c, conflict.status, conflict.code, conflict.message);
    throw error;
  }

  // Funnel step 3: carries the new key's anonymised id, which later recall and calibrate points share.
  recordTelemetry(c, {
    action: "agent_register",
    domain: "",
    tool: "",
    agentKey,
    status: "registered",
    ref: refFromUrl(c.req.url),
  });

  return c.json(
    {
      success: true,
      agent: {
        public_key: body.public_key,
        agent_key: agentKey,
        role: "community",
        status: "active",
        registered_at: new Date(registeredAt).toISOString(),
      },
    },
    201,
  );
});

/** Signed: index.ts applies requireAgentSignature to every non-public /api/v1 route. */
agents.get("/me", async (c) => {
  const agent = c.get("agent");
  const row = await c.env.DB.prepare(
    `SELECT s.role, s.status, s.approved_count, s.rejected_count, i.registered_at_ms
       FROM agent_state s JOIN agent_identities i ON i.agent_key = s.agent_key
      WHERE s.agent_key = ?`,
  )
    .bind(agent.agentKey)
    .first<{ role: string; status: string; approved_count: number; rejected_count: number; registered_at_ms: number }>();
  if (row === null) return apiError(c, 401, "AGENT_KEY_UNKNOWN", "agent key is not registered");
  return c.json({
    success: true,
    agent: {
      public_key: agent.publicKey,
      agent_key: agent.agentKey,
      role: row.role,
      status: row.status,
      approved_count: row.approved_count,
      rejected_count: row.rejected_count,
      registered_at: new Date(row.registered_at_ms).toISOString(),
    },
  });
});
