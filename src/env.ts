import type { NonceRegistry } from "./durable/nonce-registry";
import type { UsageCounter } from "./durable/usage-counter";

/** Worker bindings declared in wrangler.toml. Secrets are added here as each phase introduces them. */
export interface Env {
  /** achromat-mom-db: lessons, attempts, traps, review state. */
  DB: D1Database;
  /** achromat-mom-vector-index: 768-d cosine, one namespace per domain. */
  VECTORIZE_INDEX: Vectorize;
  /** Workers AI, for @cf/baai/bge-base-en-v1.5 embeddings. */
  AI: Ai;
  /** Workers Static Assets: the React/Vite SPA in ui/dist. */
  ASSETS: Fetcher;
  /** Single-use request nonces, one object per agent key. */
  NONCE_REGISTRY: DurableObjectNamespace<NonceRegistry>;
  /** Fixed-window hourly counters for /calibrate (one object per agent key, plus one global). */
  USAGE_COUNTER: DurableObjectNamespace<UsageCounter>;
  /** Per-IP limit on the unauthenticated onboarding endpoints (challenge, register). */
  ONBOARDING_LIMITER: RateLimit;
  /** Per-network limit on the public GET /api/v1/feed. */
  FEED_LIMITER: RateLimit;
  /** Per-network limit on the public MCP sandbox, POST /mcp (src/routes/mcp.ts). */
  MCP_LIMITER: RateLimit;
  /** Per-network limit (30/min) on the public GET /api/v1/search (src/routes/search.ts). */
  SEARCH_LIMITER: RateLimit;
  /** achromat_mom_telemetry: anonymised /recall and /calibrate usage data points (src/telemetry.ts). */
  ANALYTICS: AnalyticsEngineDataset;
  /**
   * Cloudflare account ID (32 hex characters) that owns the achromat_mom_telemetry dataset. A plain var: wrangler.toml
   * holds the placeholder and scripts/deploy-config.mjs fills it from the local .env at deploy time.
   */
  CLOUDFLARE_ACCOUNT_ID: string;
  /**
   * Secret: a READ-ONLY Cloudflare API token (Account | Account Analytics | Read) for the Analytics Engine SQL API
   * behind GET /api/v1/admin/telemetry (src/analytics-query.ts). Deliberately not named CLOUDFLARE_API_TOKEN: wrangler
   * reads that name as the deploy credential, and the two must never be the same token.
   */
  ANALYTICS_API_TOKEN: string;
  /** Secret: HMAC key for caller IP prefixes. Raw IPs are never stored. */
  IP_HMAC_KEY: string;
  /** Hashcash difficulty for new challenges (16-40). Production: 22. */
  POW_DIFFICULTY_BITS: string;
  /** Secret: at least 32 characters. HMAC key that signs Hashcash challenges (src/crypto/pow-challenge.ts). */
  POW_CHALLENGE_HMAC_KEY: string;
  /** Secret: Enterprise ramen-ai API key for the passive /calibrate proxy. */
  RAMEN_API_KEY: string;
  /** Secret: MOM Ed25519 pair-attestation key (PKCS#8, PEM or base64 DER), kid mom_pk_v1. */
  MOM_ATTESTATION_PRIVATE_KEY: string;
  /** Secret: base64 of 32 random bytes. HMAC key for submitter visibility tokens. Permanent (no rotation). */
  VISIBILITY_KEY: string;
}
