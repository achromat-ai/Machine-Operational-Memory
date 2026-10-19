/** Hourly fixed-window usage counters (the UsageCounter Durable Object), shared by /calibrate and /recall. */
import type { Env } from "./env";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function consumeUsage(env: Env, key: string, limit: number, windowMs: number = HOUR_MS) {
  return env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName(key)).consume(limit, windowMs);
}

/** Retry-After seconds (at least 1) until a window resets. */
export function secondsUntil(resetAtMs: number, nowMs: number = Date.now()): string {
  return String(Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)));
}
