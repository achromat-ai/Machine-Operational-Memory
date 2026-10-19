/**
 * UsageCounter: fixed-window request counters for POST /api/v1/calibrate.
 *
 * One object per agent key (120 calls per UTC hour) and one global object
 * (1,000 upstream evaluations per UTC hour). The Workers rate-limiting binding
 * only supports 10 s and 60 s periods and counts per location, so an hourly
 * ceiling that protects the ramen-ai quota needs a single point of truth.
 *
 * consume() increments only while the count is below the limit, so rejected
 * calls never push the window further over. A Durable Object handles one event
 * at a time and storage calls hold its input gate, so read-then-write is atomic.
 */
import { DurableObject } from "cloudflare:workers";

export interface UsageDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms when the current window ends. */
  resetAtMs: number;
}

interface WindowState {
  window: number;
  windowMs: number;
  count: number;
}

const STATE_KEY = "w";

export class UsageCounter extends DurableObject {
  async consume(limit: number, windowMs: number, nowMs: number = Date.now()): Promise<UsageDecision> {
    const window = Math.floor(nowMs / windowMs);
    const resetAtMs = (window + 1) * windowMs;
    const stored = await this.ctx.storage.get<WindowState>(STATE_KEY);
    const count = stored && stored.window === window && stored.windowMs === windowMs ? stored.count : 0;
    if (count >= limit) return { allowed: false, limit, remaining: 0, resetAtMs };

    await this.ctx.storage.put<WindowState>(STATE_KEY, { window, windowMs, count: count + 1 });
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(resetAtMs);
    return { allowed: true, limit, remaining: limit - count - 1, resetAtMs };
  }

  /** Clears a finished window so idle objects hold no storage. A newer window is left alone. */
  override async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<WindowState>(STATE_KEY);
    if (!stored) return;
    const resetAtMs = (stored.window + 1) * stored.windowMs;
    if (Date.now() >= resetAtMs) await this.ctx.storage.delete(STATE_KEY);
    else await this.ctx.storage.setAlarm(resetAtMs);
  }
}
