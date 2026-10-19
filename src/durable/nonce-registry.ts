/**
 * NonceRegistry: single-use request nonces, one Durable Object per agent key.
 *
 * The auth middleware calls consume() after the Ed25519 signature verifies.
 * A nonce is accepted once per key within its retention window (120 s, twice
 * the timestamp skew), so a captured request cannot be replayed.
 *
 * Nonces live in memory for the fast path and are written through to the
 * object's own SQLite-backed storage. Memory alone is not enough: an idle
 * object is evicted after about a minute, and a deploy restarts it, and either
 * would forget nonces that are still inside the replay window. D1 is never
 * touched per request.
 *
 * A Durable Object processes one event at a time and storage calls hold its
 * input gate, so check-then-record is atomic without explicit locking.
 */
import { DurableObject } from "cloudflare:workers";

/** Nonces stay recorded this long after they were first seen. */
export const NONCE_RETENTION_MS = 120_000;
const KEY_PREFIX = "n:";

export class NonceRegistry extends DurableObject {
  /** nonce → expiry (epoch ms). Rebuilt from storage after an eviction. */
  private readonly seen = new Map<string, number>();
  private loaded = false;

  /** Returns true if the nonce was unused and is now recorded, false if it is a replay. */
  async consume(nonce: string, nowMs: number = Date.now()): Promise<boolean> {
    await this.load(nowMs);
    const expiry = this.seen.get(nonce);
    if (expiry !== undefined && expiry > nowMs) return false;

    const expiresAt = nowMs + NONCE_RETENTION_MS;
    this.seen.set(nonce, expiresAt);
    await this.ctx.storage.put(KEY_PREFIX + nonce, expiresAt);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
    return true;
  }

  /** Drops expired nonces and re-arms for the next expiry, if any remain. */
  override async alarm(): Promise<void> {
    const nowMs = Date.now();
    await this.load(nowMs);
    const expired: string[] = [];
    let next = Number.POSITIVE_INFINITY;
    for (const [nonce, expiry] of this.seen) {
      if (expiry <= nowMs) expired.push(nonce);
      else next = Math.min(next, expiry);
    }
    for (const nonce of expired) this.seen.delete(nonce);
    // storage.delete accepts at most 128 keys per call.
    for (let i = 0; i < expired.length; i += 128) {
      await this.ctx.storage.delete(expired.slice(i, i + 128).map((nonce) => KEY_PREFIX + nonce));
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }

  private async load(nowMs: number): Promise<void> {
    if (this.loaded) return;
    const stored = await this.ctx.storage.list<number>({ prefix: KEY_PREFIX });
    for (const [key, expiry] of stored) {
      if (expiry > nowMs) this.seen.set(key.slice(KEY_PREFIX.length), expiry);
    }
    this.loaded = true;
  }
}
