import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { toHex, decodeBase64url } from "../src/schema";
import { call, newAgent, registeredAgent, signatureHeaders, signedCall, type TestAgent } from "./helpers";

let agent: TestAgent;

beforeAll(async () => {
  agent = await registeredAgent();
});

describe("public endpoints", () => {
  it("leaves /health unsigned", async () => {
    const response = await call("/api/v1/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });
});

describe("Ed25519 signed requests", () => {
  it("rejects unsigned requests, including unknown paths (fails closed)", async () => {
    for (const path of ["/api/v1/agents/me", "/api/v1/does-not-exist", "/api/v1/health/"]) {
      const response = await call(path);
      expect(response.status, path).toBe(401);
      expect(await response.json()).toMatchObject({ code: "AGENT_SIGNATURE_REQUIRED" });
    }
  });

  it("accepts a valid signature and exposes the agent to the route", async () => {
    const response = await signedCall(agent, "/api/v1/agents/me");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { agent: Record<string, unknown> };
    expect(body.agent).toMatchObject({
      public_key: agent.publicKey,
      agent_key: toHex(decodeBase64url(agent.publicKey)),
      role: "community",
      status: "active",
    });
  });

  it("rejects a replayed nonce", async () => {
    const headers = await signatureHeaders(agent, "/api/v1/agents/me");
    expect((await call("/api/v1/agents/me", { headers })).status).toBe(200);
    const replay = await call("/api/v1/agents/me", { headers });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ code: "AGENT_NONCE_REPLAYED" });
  });

  it("rejects timestamps more than 60 s from server time", async () => {
    for (const offset of [-61, 61]) {
      const response = await signedCall(agent, "/api/v1/agents/me", { timestamp: Math.floor(Date.now() / 1000) + offset });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "AGENT_SIGNATURE_EXPIRED" });
    }
    const edge = await signedCall(agent, "/api/v1/agents/me", { timestamp: Math.floor(Date.now() / 1000) - 55 });
    expect(edge.status).toBe(200);
  });

  it("binds the signature to host, path and query string", async () => {
    const cases = [
      { signedHost: "staging.achromat.ai" },
      { signedPath: "/api/v1/agents/other" },
      { signedPath: "/api/v1/agents/me?x=1" },
    ];
    for (const options of cases) {
      const response = await signedCall(agent, "/api/v1/agents/me", options);
      expect(response.status, JSON.stringify(options)).toBe(401);
      expect(await response.json()).toMatchObject({ code: "AGENT_SIGNATURE_INVALID" });
    }
    // The query string is part of what is signed, not ignored.
    expect((await signedCall(agent, "/api/v1/agents/me?x=1")).status).toBe(200);
  });

  it("binds the signature to the method and the exact body", async () => {
    const body = JSON.stringify({ hello: "world" });
    const tampered = await signedCall(agent, "/api/v1/echo", { method: "POST", body, signedBody: '{"hello":"there"}' });
    expect(tampered.status).toBe(401);
    const wrongMethod = await call("/api/v1/echo", {
      method: "POST",
      body,
      headers: await signatureHeaders(agent, "/api/v1/echo", { method: "PUT", body }),
    });
    expect(wrongMethod.status).toBe(401);
    // Correctly signed: passes auth, then routing answers 404.
    expect((await signedCall(agent, "/api/v1/echo", { method: "POST", body })).status).toBe(404);
  });

  it("rejects a signed body over 64 KiB", async () => {
    const response = await signedCall(agent, "/api/v1/echo", { method: "POST", body: "x".repeat(64 * 1024 + 1) });
    expect(response.status).toBe(413);
  });

  it("rejects a valid signature from an unregistered key", async () => {
    const stranger = await newAgent();
    const response = await signedCall(stranger, "/api/v1/agents/me");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "AGENT_KEY_UNKNOWN" });
  });

  it("rejects malformed signature headers", async () => {
    const headers = await signatureHeaders(agent, "/api/v1/agents/me");
    headers.set("Achromat-Nonce", headers.get("Achromat-Nonce") + "==");
    const response = await call("/api/v1/agents/me", { headers });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "AGENT_SIGNATURE_INVALID" });
  });

  it("rejects revoked keys", async () => {
    const revoked = await registeredAgent();
    await env.DB.prepare("INSERT INTO agent_events VALUES (?, ?, 'revoked', NULL, 'test', 'test', ?)")
      .bind(crypto.randomUUID(), toHex(decodeBase64url(revoked.publicKey)), Date.now())
      .run();
    const response = await signedCall(revoked, "/api/v1/agents/me");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "AGENT_KEY_INACTIVE" });
  });
});
