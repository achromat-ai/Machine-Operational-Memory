import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/app";
import {
  challengeSigningString,
  powChallengeKeyConfigured,
  signChallenge,
  verifyChallengeSignature,
  type SignedChallengeFields,
} from "../src/crypto/pow-challenge";
import { REGISTRATIONS_PER_PREFIX_PER_DAY } from "../src/routes/agents";
import { encodeBase64url, leadingZeroBits, registrationSigningString } from "../src/schema";
import {
  ORIGIN,
  call,
  failingNonce,
  freshIp,
  getChallenge,
  newAgent,
  postRegister,
  registrationBody,
  sign,
  solvePow,
} from "./helpers";

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/v1/agents/challenge", () => {
  it("issues a single-use, network-bound challenge without storing the IP", async () => {
    const ip = freshIp();
    const response = await call("/api/v1/agents/challenge", { ip });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ success: true, algorithm: "sha256-hashcash-v1", difficulty_bits: 16 });
    expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(body.expires_at as string) - Date.now()).toBeGreaterThan(9 * 60 * 1000);

    const row = await env.DB.prepare("SELECT * FROM pow_challenges WHERE challenge_id = ?")
      .bind(body.challenge_id)
      .first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    expect(row!.ip_prefix_hmac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(row)).not.toContain(ip.split(".").slice(0, 3).join("."));
  });

  it("fails closed without a caller IP", async () => {
    const response = await call("/api/v1/agents/challenge", { ip: null });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CLIENT_IP_UNAVAILABLE" });
  });

  it("rate-limits each network to 10 challenges a minute", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call("/api/v1/agents/challenge", { ip })).status);
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("POST /api/v1/agents/register", () => {
  it("registers a community key after valid PoW and proof of possession", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    const challenge = await getChallenge(ip);
    const response = await postRegister(await registrationBody(agent, challenge), ip);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { agent: Record<string, string> };
    expect(body.agent).toMatchObject({ public_key: agent.publicKey, role: "community", status: "active" });
    expect(body.agent.agent_key).toMatch(/^[0-9a-f]{64}$/);

    const state = await env.DB.prepare(
      "SELECT s.status, s.role, i.pow_hash, i.challenge_id FROM agent_state s JOIN agent_identities i USING (agent_key) WHERE agent_key = ?",
    )
      .bind(body.agent.agent_key)
      .first<{ status: string; role: string; pow_hash: string; challenge_id: string }>();
    expect(state).toMatchObject({ status: "active", role: "community", challenge_id: challenge.challenge_id });
    expect(leadingZeroBits(state!.pow_hash)).toBeGreaterThanOrEqual(16);
  });

  it("rejects insufficient proof of work", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    const challenge = await getChallenge(ip);
    const body = await registrationBody(agent, challenge);
    body.nonce = await failingNonce(challenge.challenge, agent.publicKey, challenge.difficulty_bits);
    const response = await postRegister(body, ip);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "POW_INVALID" });
  });

  it("rejects a proof signed by a different key", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    const impostor = await newAgent();
    const challenge = await getChallenge(ip);
    const body = await registrationBody(agent, challenge);
    body.proof_signature = await sign(impostor, registrationSigningString(challenge.challenge, agent.publicKey));
    const response = await postRegister(body, ip);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "PROOF_OF_POSSESSION_FAILED" });
  });

  it("rejects a proof over a different message", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    const challenge = await getChallenge(ip);
    const body = await registrationBody(agent, challenge);
    body.proof_signature = await sign(agent, challenge.challenge);
    expect((await postRegister(body, ip)).status).toBe(401);
  });

  it("allows each challenge to be redeemed once", async () => {
    const ip = freshIp();
    const challenge = await getChallenge(ip);
    const first = await newAgent();
    expect((await postRegister(await registrationBody(first, challenge), ip)).status).toBe(201);
    const second = await newAgent();
    const response = await postRegister(await registrationBody(second, challenge), ip);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CHALLENGE_USED" });
  });

  it("rejects a key that is already registered", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    expect((await postRegister(await registrationBody(agent, await getChallenge(ip)), ip)).status).toBe(201);
    const response = await postRegister(await registrationBody(agent, await getChallenge(ip)), ip);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "AGENT_KEY_EXISTS" });
  });

  it("binds the challenge to the network it was issued to", async () => {
    const agent = await newAgent();
    const challenge = await getChallenge("192.0.2.10");
    const response = await postRegister(await registrationBody(agent, challenge), "198.51.100.10");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CHALLENGE_WRONG_NETWORK" });
  });

  it("accepts a different host on the same /24", async () => {
    const agent = await newAgent();
    const challenge = await getChallenge("203.0.113.10");
    expect((await postRegister(await registrationBody(agent, challenge), "203.0.113.200")).status).toBe(201);
  });

  it("rejects an expired challenge", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    const challenge = await getChallenge(ip);
    const body = await registrationBody(agent, challenge);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(challenge.expires_at) + 1);
    const response = await postRegister(body, ip);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("rejects unknown challenges and malformed bodies", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    const body = await registrationBody(agent, await getChallenge(ip));

    const unknown = await postRegister({ ...body, challenge_id: crypto.randomUUID() }, ip);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: "CHALLENGE_INVALID" });

    const extra = await postRegister({ ...body, role: "admin" }, ip);
    expect(extra.status).toBe(400);
    expect(await extra.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const hexKey = await postRegister({ ...body, public_key: "ab".repeat(32) }, ip);
    expect(hexKey.status).toBe(400);

    const notJson = await postRegister("{nope", ip);
    expect(notJson.status).toBe(400);

    const huge = await postRegister({ ...body, padding: "x".repeat(5000) }, ip);
    expect(huge.status).toBe(413);
  });

  it("caps registrations per network per day", async () => {
    const ip = freshIp();
    const prefixHmac = (
      await env.DB.prepare("SELECT ip_prefix_hmac FROM pow_challenges WHERE challenge_id = ?")
        .bind((await getChallenge(ip)).challenge_id)
        .first<{ ip_prefix_hmac: string }>()
    )!.ip_prefix_hmac;

    // Fill the cap directly through the ledger (the triggers still check every row).
    const now = Date.now();
    for (let i = 0; i < REGISTRATIONS_PER_PREFIX_PER_DAY; i++) {
      const challengeId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO pow_challenges VALUES (?, ?, 'sha256-hashcash-v1', 16, ?, ?, ?)",
        ).bind(challengeId, `cap${i}`.padEnd(43, "A"), prefixHmac, now, now + 600000),
        env.DB.prepare(
          "INSERT INTO agent_identities VALUES (?, 'community', ?, 'ff', ?, NULL, ?, NULL, ?)",
        ).bind(crypto.randomUUID().replace(/-/g, "").padEnd(64, "0"), challengeId, "0".repeat(64), prefixHmac, now),
      ]);
    }

    const agent = await newAgent();
    const response = await postRegister(await registrationBody(agent, await getChallenge(ip)), ip);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "REGISTRATION_LIMIT" });
  });
});

// ════════════════════════════════════════════════════════════════════════
// HMAC-signed challenges (POW_CHALLENGE_HMAC_KEY)
// ════════════════════════════════════════════════════════════════════════

interface StoredChallenge {
  challenge_id: string;
  challenge: string;
  algorithm: string;
  difficulty_bits: number;
  ip_prefix_hmac: string;
  expires_at_ms: number;
}

async function storedChallenge(challengeId: string): Promise<StoredChallenge> {
  return (await env.DB.prepare(
    "SELECT challenge_id, challenge, algorithm, difficulty_bits, ip_prefix_hmac, expires_at_ms FROM pow_challenges WHERE challenge_id = ?",
  )
    .bind(challengeId)
    .first<StoredChallenge>())!;
}

function fieldsOf(row: StoredChallenge): SignedChallengeFields {
  return {
    challengeId: row.challenge_id,
    challenge: row.challenge,
    algorithm: row.algorithm,
    difficultyBits: row.difficulty_bits,
    ipPrefixHmac: row.ip_prefix_hmac,
    expiresAtMs: row.expires_at_ms,
  };
}

/** Flips one character so the value stays well-formed base64url but no longer matches. */
function corrupt(signature: string): string {
  return (signature[0] === "A" ? "B" : "A") + signature.slice(1);
}

/** Inserts a challenge row straight into D1 (the ledger triggers still validate it), as an attacker with a row but no key would. */
async function insertChallengeRow(ip: string, difficultyBits: number): Promise<StoredChallenge> {
  const donor = await storedChallenge((await getChallenge(ip)).challenge_id);
  const now = Date.now();
  const row: StoredChallenge = {
    challenge_id: crypto.randomUUID(),
    challenge: encodeBase64url(crypto.getRandomValues(new Uint8Array(32))),
    algorithm: "sha256-hashcash-v1",
    difficulty_bits: difficultyBits,
    ip_prefix_hmac: donor.ip_prefix_hmac,
    expires_at_ms: now + 600_000,
  };
  await env.DB.prepare("INSERT INTO pow_challenges VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(row.challenge_id, row.challenge, row.algorithm, row.difficulty_bits, row.ip_prefix_hmac, now, row.expires_at_ms)
    .run();
  return row;
}

async function registeredCount(challengeId: string): Promise<number> {
  return (await env.DB.prepare("SELECT count(*) AS n FROM agent_identities WHERE challenge_id = ?").bind(challengeId).first<{ n: number }>())!.n;
}

describe("PoW challenge HMAC signatures", () => {
  it("issues a challenge_signature that is the HMAC of the stored fields under POW_CHALLENGE_HMAC_KEY", async () => {
    const challenge = await getChallenge(freshIp());
    expect(challenge.challenge_signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await storedChallenge(challenge.challenge_id);
    expect(challenge.challenge_signature).toBe(await signChallenge(env.POW_CHALLENGE_HMAC_KEY, fieldsOf(row)));
    // The signature is not derived from the other HMAC secret, and differs per challenge.
    expect(challenge.challenge_signature).not.toBe(await signChallenge(env.IP_HMAC_KEY, fieldsOf(row)));
    expect((await getChallenge(freshIp())).challenge_signature).not.toBe(challenge.challenge_signature);
  });

  it("requires challenge_signature in the register body", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    const { challenge_signature: _omitted, ...withoutSignature } = await registrationBody(agent, await getChallenge(ip));
    const response = await postRegister(withoutSignature, ip);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST", details: [{ path: "challenge_signature" }] });
  });

  it("rejects a tampered or malformed signature with 400 INVALID_CHALLENGE, before the proof of work is evaluated", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    const challenge = await getChallenge(ip);
    const good = await registrationBody(agent, challenge);

    // A nonce that fails the PoW AND a corrupt signature: the signature is judged first.
    const nonce = await failingNonce(challenge.challenge, agent.publicKey, challenge.difficulty_bits);
    const tampered = await postRegister({ ...good, nonce, challenge_signature: corrupt(challenge.challenge_signature) }, ip);
    expect(tampered.status).toBe(400);
    expect(await tampered.json()).toMatchObject({ success: false, code: "INVALID_CHALLENGE" });

    // Right shape (43 chars), wrong value: all-zero MAC.
    const zeros = await postRegister({ ...good, challenge_signature: encodeBase64url(new Uint8Array(32)) }, ip);
    expect(zeros.status).toBe(400);
    expect(await zeros.json()).toMatchObject({ code: "INVALID_CHALLENGE" });

    // Wrong length is a schema error, not a crypto one.
    const short = await postRegister({ ...good, challenge_signature: "short" }, ip);
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({ code: "INVALID_REQUEST" });

    expect(await registeredCount(challenge.challenge_id)).toBe(0);
    // The challenge was never redeemed, so the genuine request still works.
    expect((await postRegister(good, ip)).status).toBe(201);
  });

  it("rejects a signature copied from another challenge", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    const first = await getChallenge(ip);
    const second = await getChallenge(ip);
    const body = { ...(await registrationBody(agent, first)), challenge_signature: second.challenge_signature };
    const response = await postRegister(body, ip);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_CHALLENGE" });
  });

  it("refuses a forged easy challenge: a row that exists in D1 but was never signed by this Worker", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    const forged = await insertChallengeRow(ip, 16);
    const challenge = { challenge_id: forged.challenge_id, challenge: forged.challenge, difficulty_bits: 16 };
    const body = {
      public_key: agent.publicKey,
      challenge_id: forged.challenge_id,
      challenge_signature: encodeBase64url(crypto.getRandomValues(new Uint8Array(32))),
      nonce: await solvePow(challenge.challenge, agent.publicKey, 16),
      proof_signature: await sign(agent, registrationSigningString(forged.challenge, agent.publicKey)),
    };
    const response = await postRegister(body, ip);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_CHALLENGE" });
    expect(await registeredCount(forged.challenge_id)).toBe(0);
  });

  it("binds the difficulty: a genuine signature for a hard challenge does not unlock an easier stored row", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    const row = await insertChallengeRow(ip, 16);
    // The signature the Worker would have issued if this challenge were difficulty 22.
    const hardSignature = await signChallenge(env.POW_CHALLENGE_HMAC_KEY, { ...fieldsOf(row), difficultyBits: 22 });
    const body = {
      public_key: agent.publicKey,
      challenge_id: row.challenge_id,
      challenge_signature: hardSignature,
      nonce: await solvePow(row.challenge, agent.publicKey, 16),
      proof_signature: await sign(agent, registrationSigningString(row.challenge, agent.publicKey)),
    };
    expect(await (await postRegister(body, ip)).json()).toMatchObject({ code: "INVALID_CHALLENGE" });

    // Control: the same row with a signature over its real fields registers fine.
    const honest = { ...body, challenge_signature: await signChallenge(env.POW_CHALLENGE_HMAC_KEY, fieldsOf(row)) };
    expect((await postRegister(honest, ip)).status).toBe(201);
  });

  it("verifies against the stored row, so a wrong-network redemption is still reported as such", async () => {
    const agent = await newAgent();
    const challenge = await getChallenge("192.0.2.77");
    const response = await postRegister(await registrationBody(agent, challenge), "198.51.100.77");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CHALLENGE_WRONG_NETWORK" });
  });

  it("fails closed with 503 when POW_CHALLENGE_HMAC_KEY is missing or too short", async () => {
    const ip = freshIp();
    const agent = await newAgent();
    const challenge = await getChallenge(ip);
    const body = JSON.stringify(await registrationBody(agent, challenge));

    for (const key of ["", "too-short"]) {
      const worker = createWorker();
      const broken = { ...env, POW_CHALLENGE_HMAC_KEY: key } as typeof env;
      const issue = await worker.fetch(new Request(`${ORIGIN}/api/v1/agents/challenge`, { headers: { "CF-Connecting-IP": ip } }), broken, createExecutionContext());
      expect(issue.status, `challenge with key "${key}"`).toBe(503);
      expect(await issue.json()).toMatchObject({ code: "SERVICE_MISCONFIGURED" });

      const register = await worker.fetch(
        new Request(`${ORIGIN}/api/v1/agents/register`, { method: "POST", headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" }, body }),
        broken,
        createExecutionContext(),
      );
      expect(register.status, `register with key "${key}"`).toBe(503);
      expect(await register.json()).toMatchObject({ code: "SERVICE_MISCONFIGURED" });
    }
    expect(await registeredCount(challenge.challenge_id)).toBe(0);
  });
});

describe("challengeSigningString / signChallenge / verifyChallengeSignature", () => {
  const fields: SignedChallengeFields = {
    challengeId: "11111111-1111-4111-8111-111111111111",
    challenge: "A".repeat(43),
    algorithm: "sha256-hashcash-v1",
    difficultyBits: 22,
    ipPrefixHmac: "B".repeat(43),
    expiresAtMs: 1_800_000_000_000,
  };
  const key = "unit-test-hmac-key-with-at-least-32-chars";

  it("signs the documented, domain-separated string", () => {
    expect(challengeSigningString(fields)).toBe(
      ["achromat-pow-challenge-v1", fields.challengeId, fields.challenge, fields.algorithm, "22", fields.ipPrefixHmac, "1800000000000"].join("\n"),
    );
  });

  it("round-trips, and any changed field, key or signature fails", async () => {
    const signature = await signChallenge(key, fields);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyChallengeSignature(key, fields, signature)).toBe(true);

    const changed: SignedChallengeFields[] = [
      { ...fields, challengeId: "22222222-2222-4222-8222-222222222222" },
      { ...fields, challenge: "C".repeat(43) },
      { ...fields, algorithm: "argon2id-v1" },
      { ...fields, difficultyBits: 16 },
      { ...fields, ipPrefixHmac: "D".repeat(43) },
      { ...fields, expiresAtMs: fields.expiresAtMs + 1 },
    ];
    for (const variant of changed) expect(await verifyChallengeSignature(key, variant, signature)).toBe(false);
    expect(await verifyChallengeSignature(key.replace("unit", "evil"), fields, signature)).toBe(false);
    expect(await verifyChallengeSignature(key, fields, corrupt(signature))).toBe(false);
    expect(await verifyChallengeSignature(key, fields, "not base64url!")).toBe(false);
  });

  it("throws for a missing or short key", async () => {
    expect(powChallengeKeyConfigured(undefined)).toBe(false);
    expect(powChallengeKeyConfigured("x".repeat(31))).toBe(false);
    expect(powChallengeKeyConfigured("x".repeat(32))).toBe(true);
    await expect(signChallenge(undefined, fields)).rejects.toThrow("POW_CHALLENGE_HMAC_KEY");
    await expect(signChallenge("short", fields)).rejects.toThrow("POW_CHALLENGE_HMAC_KEY");
    await expect(verifyChallengeSignature("short", fields, "A".repeat(43))).rejects.toThrow("POW_CHALLENGE_HMAC_KEY");
  });
});
