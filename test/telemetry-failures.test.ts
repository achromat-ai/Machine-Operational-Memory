/**
 * registration_failed telemetry: every refused challenge or register request writes exactly one point carrying the
 * response code (from a closed list), the endpoint and the ref, and nothing from the request. The response itself
 * is unchanged, and a dataset failure changes nothing.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REGISTRATIONS_PER_ASN_PER_DAY, REGISTRATIONS_PER_PREFIX_PER_DAY } from "../src/routes/agents";
import { REGISTRATION_FAILURE_CODES, registrationFieldLabel, writeTelemetry } from "../src/telemetry";
import { fakeAnalytics, freshWorld, type World } from "./fixtures/world";
import { ORIGIN, failingNonce, freshIp, newAgent, registrationBody, sign, type Challenge, type TestAgent } from "./helpers";
import { registrationSigningString } from "../src/schema";

afterEach(() => vi.useRealTimers());

interface Sent {
  status: number;
  json: any;
}

async function send(
  world: World,
  path: string,
  init: { ip: string | null; method?: string; body?: unknown; raw?: string; env?: typeof env; cf?: { asn: number } },
): Promise<Sent> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.ip !== null) headers["CF-Connecting-IP"] = init.ip;
  const request = new Request(ORIGIN + path, {
    method: init.method ?? "GET",
    headers,
    ...(init.raw !== undefined ? { body: init.raw } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.cf ? { cf: init.cf } : {}),
  } as RequestInit);
  const response = await world.worker.fetch(request, init.env ?? world.env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, json: await response.json() };
}

const challenge = async (world: World, ip: string, query = ""): Promise<Challenge> => (await send(world, `/api/v1/agents/challenge${query}`, { ip })).json as Challenge;

/** The points written for one request, with the point list cleared first. */
async function pointsFor(world: World, run: () => Promise<Sent>): Promise<{ sent: Sent; blobs: string[][]; indexes: string[][] }> {
  world.analytics.points.length = 0;
  const sent = await run();
  return {
    sent,
    blobs: world.analytics.points.map((point) => [...(point.blobs as string[])]),
    indexes: world.analytics.points.map((point) => [...(point.indexes as string[])]),
  };
}

const failed = (endpoint: string, code: string, ref = "", field = "") => ["registration_failed", "", endpoint, "anonymous", code, ref, field];

describe("registration_failed: the challenge endpoint", () => {
  it("records a request with no client address, with the ref", async () => {
    const world = await freshWorld();
    const { sent, blobs, indexes } = await pointsFor(world, () => send(world, "/api/v1/agents/challenge?ref=Launch-Post", { ip: null }));
    expect(sent.status).toBe(400);
    expect(sent.json.code).toBe("CLIENT_IP_UNAVAILABLE");
    expect(blobs).toEqual([failed("challenge", "CLIENT_IP_UNAVAILABLE", "launch-post")]);
    expect(indexes).toEqual([["registration_failed"]]);
  });

  it("records the eleventh challenge in a minute from one network as RATE_LIMITED, and no challenge_issued for it", async () => {
    const world = await freshWorld();
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await send(world, "/api/v1/agents/challenge", { ip })).status).toBe(200);
    const { sent, blobs } = await pointsFor(world, () => send(world, "/api/v1/agents/challenge", { ip }));
    expect(sent.status).toBe(429);
    expect(sent.json.code).toBe("RATE_LIMITED");
    expect(blobs).toEqual([failed("challenge", "RATE_LIMITED")]);
  });

  it("records a missing or short signing secret as SERVICE_MISCONFIGURED", async () => {
    const world = await freshWorld();
    const broken = { ...world.env, POW_CHALLENGE_HMAC_KEY: "too-short" } as typeof env;
    const { sent, blobs } = await pointsFor(world, () => send(world, "/api/v1/agents/challenge", { ip: freshIp(), env: broken }));
    expect(sent.status).toBe(503);
    expect(blobs).toEqual([failed("challenge", "SERVICE_MISCONFIGURED")]);
  });
});

describe("registration_failed: the register endpoint", () => {
  /** A challenge issued to `ip` and a valid registration body for a new key. */
  async function ready(world: World, ip = freshIp(), query = "") {
    const agent = await newAgent();
    const issued = await challenge(world, ip);
    return { ip, agent, issued, body: await registrationBody(agent, issued), query };
  }
  const register = (world: World, ip: string, body: unknown, query = "") => send(world, `/api/v1/agents/register${query}`, { ip, method: "POST", body });

  it("records each refusal once, with its code, the endpoint and the ref, and leaves the response as it was", async () => {
    const world = await freshWorld();
    const check = async (label: string, status: number, code: string, expected: string[], run: () => Promise<Sent>) => {
      const { sent, blobs, indexes } = await pointsFor(world, run);
      expect(sent.status, label).toBe(status);
      expect(sent.json.code, label).toBe(code);
      expect(blobs, label).toEqual([expected]);
      expect(indexes, label).toEqual([["registration_failed"]]);
    };

    // INVALID_REQUEST names the failing field, from the register body's own five.
    {
      const r = await ready(world);
      await check("nonce not hex", 400, "INVALID_REQUEST", failed("register", "INVALID_REQUEST", "ref1", "nonce"), () => register(world, r.ip, { ...r.body, nonce: "ZZ-not-hex" }, "?ref=ref1"));
    }
    {
      const r = await ready(world);
      await check("unknown key", 400, "INVALID_REQUEST", failed("register", "INVALID_REQUEST", "", "unknown_field"), () => register(world, r.ip, { ...r.body, "evil<script>": "x" }));
    }
    {
      const r = await ready(world);
      await check("not json", 400, "INVALID_REQUEST", failed("register", "INVALID_REQUEST", "", "unknown_field"), () => send(world, "/api/v1/agents/register", { ip: r.ip, method: "POST", raw: "{not json" }));
    }
    // A body over 4 KiB.
    await check("too large", 413, "BODY_TOO_LARGE", failed("register", "BODY_TOO_LARGE"), () => send(world, "/api/v1/agents/register", { ip: freshIp(), method: "POST", raw: "x".repeat(5000) }));
    // An unknown challenge_id.
    {
      const r = await ready(world);
      await check("unknown challenge", 400, "CHALLENGE_INVALID", failed("register", "CHALLENGE_INVALID"), () => register(world, r.ip, { ...r.body, challenge_id: crypto.randomUUID() }));
    }
    // A signature that is not the one issued.
    {
      const r = await ready(world);
      await check("bad challenge signature", 400, "INVALID_CHALLENGE", failed("register", "INVALID_CHALLENGE"), () => register(world, r.ip, { ...r.body, challenge_signature: "A".repeat(43) }));
    }
    // Redeemed from another /24.
    {
      const r = await ready(world);
      await check("wrong network", 400, "CHALLENGE_WRONG_NETWORK", failed("register", "CHALLENGE_WRONG_NETWORK"), () => register(world, freshIp(), r.body));
    }
    // Too little work.
    {
      const r = await ready(world);
      const nonce = await failingNonce(r.issued.challenge, r.agent.publicKey, r.issued.difficulty_bits);
      await check("weak proof of work", 400, "POW_INVALID", failed("register", "POW_INVALID"), () => register(world, r.ip, { ...r.body, nonce }));
    }
    // A proof signed by a different key.
    {
      const r = await ready(world);
      const other: TestAgent = await newAgent();
      const proof = await sign(other, registrationSigningString(r.issued.challenge, r.agent.publicKey));
      await check("signature by another key", 401, "PROOF_OF_POSSESSION_FAILED", failed("register", "PROOF_OF_POSSESSION_FAILED"), () => register(world, r.ip, { ...r.body, proof_signature: proof }));
    }
    // A challenge redeemed twice (the second time for a different key with valid work).
    {
      const r = await ready(world);
      expect((await register(world, r.ip, r.body)).status).toBe(201);
      const second = await newAgent();
      await check("challenge used", 409, "CHALLENGE_USED", failed("register", "CHALLENGE_USED"), async () => register(world, r.ip, await registrationBody(second, r.issued)));
    }
    // A key that is already registered, on a new challenge.
    {
      const r = await ready(world);
      expect((await register(world, r.ip, r.body)).status).toBe(201);
      const again = await challenge(world, r.ip);
      await check("key exists", 409, "AGENT_KEY_EXISTS", failed("register", "AGENT_KEY_EXISTS"), async () => register(world, r.ip, await registrationBody(r.agent, again)));
    }
    // Expired.
    {
      const r = await ready(world);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse(r.issued.expires_at) + 1);
      try {
        await check("expired", 400, "CHALLENGE_EXPIRED", failed("register", "CHALLENGE_EXPIRED"), () => register(world, r.ip, r.body));
      } finally {
        vi.useRealTimers();
      }
    }
    // The signing secret is missing.
    {
      const r = await ready(world);
      const broken = { ...world.env, POW_CHALLENGE_HMAC_KEY: "" } as typeof env;
      await check("misconfigured", 503, "SERVICE_MISCONFIGURED", failed("register", "SERVICE_MISCONFIGURED"), () => send(world, "/api/v1/agents/register", { ip: r.ip, method: "POST", body: r.body, env: broken }));
    }
    // 11th register request a minute from one network.
    {
      const ip = freshIp();
      const r = await ready(world, ip);
      for (let i = 0; i < 10; i++) await register(world, ip, { ...r.body, nonce: "ZZ" });
      await check("rate limited", 429, "RATE_LIMITED", failed("register", "RATE_LIMITED"), () => register(world, ip, r.body));
    }
    // No client address.
    await check("no ip", 400, "CLIENT_IP_UNAVAILABLE", failed("register", "CLIENT_IP_UNAVAILABLE"), () => send(world, "/api/v1/agents/register", { ip: null, method: "POST", body: {} }));
  });

  it("labels the per-network cap and the per-ASN cap differently, while the response code stays REGISTRATION_LIMIT", async () => {
    const world = await freshWorld();

    // Per network: fill the /24's cap straight through the ledger, as the cap test in agents.test.ts does.
    const ip = freshIp();
    const first = await challenge(world, ip);
    const prefixHmac = (await env.DB.prepare("SELECT ip_prefix_hmac FROM pow_challenges WHERE challenge_id = ?").bind(first.challenge_id).first<{ ip_prefix_hmac: string }>())!.ip_prefix_hmac;
    const now = Date.now();
    for (let i = 0; i < REGISTRATIONS_PER_PREFIX_PER_DAY; i++) {
      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO pow_challenges VALUES (?, ?, 'sha256-hashcash-v1', 16, ?, ?, ?)").bind(id, `fcap${i}`.padEnd(43, "A"), prefixHmac, now, now + 600000),
        env.DB.prepare("INSERT INTO agent_identities VALUES (?, 'community', ?, 'ff', ?, NULL, ?, NULL, ?)").bind(crypto.randomUUID().replace(/-/g, "").padEnd(64, "0"), id, "0".repeat(64), prefixHmac, now),
      ]);
    }
    const agent = await newAgent();
    const body = await registrationBody(agent, await challenge(world, ip));
    const prefix = await pointsFor(world, () => send(world, "/api/v1/agents/register", { ip, method: "POST", body }));
    expect(prefix.sent.status).toBe(429);
    expect(prefix.sent.json.code).toBe("REGISTRATION_LIMIT");
    expect(prefix.blobs).toEqual([failed("register", "REGISTRATION_LIMIT_PREFIX")]);

    // Per ASN: a network the caller is on has the ASN cap spent by other prefixes.
    const asn = 64_511;
    const ip2 = freshIp();
    const issued = await send(world, "/api/v1/agents/challenge", { ip: ip2, cf: { asn } });
    expect(issued.status).toBe(200);
    for (let i = 0; i < REGISTRATIONS_PER_ASN_PER_DAY; i++) {
      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO pow_challenges VALUES (?, ?, 'sha256-hashcash-v1', 16, ?, ?, ?)").bind(id, `acap${i}`.padEnd(43, "A"), `other${i}`.padEnd(43, "B"), now, now + 600000),
        env.DB.prepare("INSERT INTO agent_identities VALUES (?, 'community', ?, 'ff', ?, NULL, ?, ?, ?)").bind(crypto.randomUUID().replace(/-/g, "").padEnd(64, "0"), id, "0".repeat(64), `other${i}`.padEnd(43, "B"), asn, now),
      ]);
    }
    const agent2 = await newAgent();
    const body2 = await registrationBody(agent2, issued.json as Challenge);
    const byAsn = await pointsFor(world, () => send(world, "/api/v1/agents/register", { ip: ip2, method: "POST", body: body2, cf: { asn } }));
    expect(byAsn.sent.status).toBe(429);
    expect(byAsn.sent.json.code).toBe("REGISTRATION_LIMIT");
    expect(byAsn.blobs).toEqual([failed("register", "REGISTRATION_LIMIT_ASN")]);
  });

  it("writes no key, challenge, nonce, signature, body text, address or network hash, and nothing for a success", async () => {
    const world = await freshWorld();
    const r = await (async () => {
      const ip = freshIp();
      const agent = await newAgent();
      const issued = await challenge(world, ip);
      return { ip, agent, issued, body: await registrationBody(agent, issued) };
    })();
    world.analytics.points.length = 0;
    await send(world, "/api/v1/agents/register?ref=x", { ip: r.ip, method: "POST", body: { ...r.body, nonce: "NOT-HEX-" + r.body.proof_signature } });
    await send(world, "/api/v1/agents/register?ref=x", { ip: freshIp(), method: "POST", body: r.body }); // wrong network
    const text = JSON.stringify(world.analytics.points);
    expect(world.analytics.points).toHaveLength(2);
    for (const secret of [r.agent.publicKey, r.issued.challenge, r.issued.challenge_id, r.issued.challenge_signature, r.body.nonce, r.body.proof_signature, r.ip, "NOT-HEX"]) {
      expect(text, secret).not.toContain(secret);
    }
    const stored = (await env.DB.prepare("SELECT ip_prefix_hmac FROM pow_challenges WHERE challenge_id = ?").bind(r.issued.challenge_id).first<{ ip_prefix_hmac: string }>())!.ip_prefix_hmac;
    expect(text).not.toContain(stored);

    // A success writes agent_register and no failure.
    world.analytics.points.length = 0;
    expect((await send(world, "/api/v1/agents/register", { ip: r.ip, method: "POST", body: r.body })).status).toBe(201);
    expect(world.analytics.points.map((point) => point.blobs?.[0])).toEqual(["agent_register"]);
  });

  it("refuses and answers the same when the dataset is unavailable", async () => {
    const world = await freshWorld();
    world.analytics.fail = true;
    const sent = await send(world, "/api/v1/agents/register", { ip: freshIp(), method: "POST", raw: "x".repeat(5000) });
    expect(sent.status).toBe(413);
    expect(sent.json.code).toBe("BODY_TOO_LARGE");
    expect(world.analytics.points).toHaveLength(0);
  });
});

describe("the closed list", () => {
  it("writes OTHER for a status that is not a known code, so request text can never reach the dataset", async () => {
    const analytics = fakeAnalytics();
    const stubEnv = { ...env, ANALYTICS: analytics } as typeof env;
    await writeTelemetry(stubEnv, { action: "registration_failed", domain: "", tool: "register", agentKey: null, status: "attacker <script> text" as never, ref: "", detail: "", index: "registration_failed" });
    await writeTelemetry(stubEnv, { action: "registration_failed", domain: "", tool: "register", agentKey: null, status: "POW_INVALID", ref: "", detail: "", index: "registration_failed" });
    expect(analytics.points.map((point) => point.blobs?.[4])).toEqual(["OTHER", "POW_INVALID"]);
  });

  it("reduces a field name to the register body's own five, else unknown_field", () => {
    for (const field of ["public_key", "challenge_id", "challenge_signature", "nonce", "proof_signature"]) expect(registrationFieldLabel(field)).toBe(field);
    for (const field of [undefined, "", "ref", "evil<script>", "NONCE", "__proto__", "x".repeat(500)]) expect(registrationFieldLabel(field)).toBe("unknown_field");
  });

  it("lists exactly the codes agents.ts can answer, plus the two cap labels and OTHER", () => {
    expect([...REGISTRATION_FAILURE_CODES].sort()).toEqual(
      [
        "AGENT_KEY_EXISTS",
        "BODY_TOO_LARGE",
        "CHALLENGE_EXPIRED",
        "CHALLENGE_INVALID",
        "CHALLENGE_USED",
        "CHALLENGE_WRONG_NETWORK",
        "CLIENT_IP_UNAVAILABLE",
        "INVALID_CHALLENGE",
        "INVALID_REQUEST",
        "OTHER",
        "POW_INVALID",
        "PROOF_OF_POSSESSION_FAILED",
        "RATE_LIMITED",
        "REGISTRATION_LIMIT_ASN",
        "REGISTRATION_LIMIT_PREFIX",
        "SERVICE_MISCONFIGURED",
      ].sort(),
    );
  });
});
