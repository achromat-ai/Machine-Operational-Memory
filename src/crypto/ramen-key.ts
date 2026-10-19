/**
 * Pinned ramen-ai receipt signing keys, by kid (raw 32-byte Ed25519, hex).
 *
 * ramen_pk_v1 is the raw key inside the SPKI published in ramen-ai
 * EVALUATION_API_CONTRACT.md and @ramen-ai/node-core AUDIT_PUBLIC_KEYS:
 *   MCowBQYDK2VwAyEA8iTL9lJGYn2alGn1yMWVAIqLImTpADb9CqaLhisTuto=
 * test/receipt-key.test.ts derives it from that SPKI. Pinned in source so a
 * dependency or configuration change can never move the trust root.
 *
 * This module holds only constants so route tests can substitute a test key
 * with vi.mock. Production code has no other way to change it.
 */
export const RAMEN_RECEIPT_KEYS: Readonly<Record<string, string>> = Object.freeze({
  ramen_pk_v1: "f224cbf65246627d9a9469f5c8c595008a8b2264e90036fd0aa68b862b13bada",
});
