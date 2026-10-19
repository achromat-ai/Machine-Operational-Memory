import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { NONCE_RETENTION_MS, type NonceRegistry } from "../src/durable/nonce-registry";

function registry(name: string) {
  return env.NONCE_REGISTRY.get(env.NONCE_REGISTRY.idFromName(name));
}

describe("NonceRegistry", () => {
  it("accepts a nonce once per key", async () => {
    const stub = registry("key-a");
    expect(await stub.consume("n1")).toBe(true);
    expect(await stub.consume("n1")).toBe(false);
    expect(await stub.consume("n2")).toBe(true);
    // Another key has its own object and its own nonces.
    expect(await registry("key-b").consume("n1")).toBe(true);
  });

  it("forgets a nonce after the retention window", async () => {
    const stub = registry("key-c");
    const now = Date.now();
    expect(await stub.consume("n1", now)).toBe(true);
    expect(await stub.consume("n1", now + NONCE_RETENTION_MS - 1)).toBe(false);
    expect(await stub.consume("n1", now + NONCE_RETENTION_MS)).toBe(true);
  });

  it("still rejects replays after the object is evicted", async () => {
    const stub = registry("key-d");
    expect(await stub.consume("n1")).toBe(true);
    await evictDurableObject(stub);
    expect(await registry("key-d").consume("n1")).toBe(false);
  });

  it("purges expired nonces from storage on alarm", async () => {
    const stub = registry("key-e");
    const past = Date.now() - NONCE_RETENTION_MS - 1000;
    expect(await stub.consume("old", past)).toBe(true);
    expect(await stub.consume("fresh")).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const keys = await runInDurableObject(stub, async (_instance: NonceRegistry, state) =>
      [...(await state.storage.list()).keys()],
    );
    expect(keys).toEqual(["n:fresh"]);
  });
});
