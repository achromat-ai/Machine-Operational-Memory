/**
 * Fake ramen-ai for /calibrate tests.
 *
 * Signs Schema V5 receipts with a throwaway test key. Test files substitute it
 * for the pinned ramen_pk_v1 with vi.mock("../src/crypto/ramen-key"), so the
 * production trust root never changes. Not a secret.
 */
import { vi } from "vitest";
import { encodeBase64url, sha256Hex } from "../../src/schema";

export const TEST_RAMEN_PUBLIC_KEY_HEX = "eb987670f1cb0b6317e894d17a02b98dafdb8764c8bef72864ba1729e9ebbc8f";
const TEST_RAMEN_JWK: JsonWebKey = {
  kty: "OKP",
  crv: "Ed25519",
  d: "lXTfOB2RBtz8Wgie2Z1fDdNaYBuxbWQ0ZWW5LY_-axg",
  x: "65h2cPHLC2MX6JTRegK5ja_bh2TIvvcoZLoXKenrvI8",
};

/** Test-only MOM attestation public key (pairs with MOM_ATTESTATION_PRIVATE_KEY in vitest.config.ts). */
export const TEST_MOM_PUBLIC_KEY_B64URL = "9jCwW0k2pvsYfjXdRZ1uyntczCLTq0taxt_ev1tqz-Y";

export const ALLOW: FakeVerdict = { allowed: true };

export const POLICY_A = "1006492f-db62-4f46-8775-48b966c5c956";
export const POLICY_B = "2116492f-db62-4f46-8775-48b966c5c957";

let signingKey: Promise<CryptoKey> | null = null;
function ramenSigningKey(): Promise<CryptoKey> {
  signingKey ??= crypto.subtle.importKey("jwk", TEST_RAMEN_JWK, { name: "Ed25519" }, false, ["sign"]) as Promise<CryptoKey>;
  return signingKey;
}

export interface Violation {
  rule_id: string;
  rule_name: string;
  enforcement_level?: string;
  reasoning?: string;
  recovery_instruction?: string;
}

export interface FakeVerdict {
  allowed: boolean;
  policyIds?: string[];
  violations?: Violation[];
  anchors?: string[];
  /** Signed reasoning override (default: violations' reasoning joined with " | "). */
  reasoning?: string;
  /** Signed steering override (default: recovery instructions joined with " | "). */
  steering?: string;
  /** Signed timestamp (default: now). */
  timestamp?: string;
  /** Sign a payload_hash for this string instead of the real input. */
  hashOf?: string;
  /** Flip one byte of the signature. */
  tamper?: boolean;
  policiesErrored?: number;
}

export interface UpstreamRequest {
  url: string;
  authorization: string | null;
  /** What the request named as bundles; empty when MOM sent a tool-scoped policy_ids list instead. */
  bundle_ids: string[];
  /** What the request named as policies; empty when MOM sent a domain bundle. */
  policy_ids: string[];
  input: string;
  /** The top-level keys of the request body, sorted, to prove nothing else (such as both scopes) was sent. */
  raw_keys?: string[];
}

/** Builds a signed V5 evaluate response for the given request. */
export async function ramenResponse(request: UpstreamRequest, verdict: FakeVerdict): Promise<Response> {
  const violations = verdict.allowed ? [] : (verdict.violations ?? []);
  const anchors = verdict.allowed ? [] : (verdict.anchors ?? []);
  const policyIds = verdict.policyIds ?? [POLICY_A];
  const id = crypto.randomUUID();
  const timestamp = verdict.timestamp ?? new Date().toISOString();
  const payload = {
    schema_version: "5.0",
    kid: "ramen_pk_v1",
    id,
    timestamp,
    policy_ids: policyIds,
    payload_hash: await sha256Hex(verdict.hashOf ?? request.input),
    verdict: verdict.allowed ? 1 : 0,
    reasoning: verdict.reasoning ?? violations.map((v) => v.reasoning ?? "").filter((r) => r !== "").join(" | "),
    steering:
      verdict.steering ??
      violations
        .map((v) => v.recovery_instruction ?? "")
        .filter((r) => r !== "")
        .join(" | "),
    statutory_anchors: anchors,
  };
  const canonical = JSON.stringify(payload);
  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, await ramenSigningKey(), new TextEncoder().encode(canonical)),
  );
  if (verdict.tamper) signatureBytes[0] = signatureBytes[0]! ^ 0xff;
  return Response.json({
    success: true,
    data: {
      allowed: verdict.allowed,
      policy_ids: policyIds,
      policies_evaluated: policyIds.length,
      policies_passed: verdict.allowed ? policyIds.length : 0,
      policies_failed: verdict.allowed ? 0 : 1,
      policies_errored: verdict.policiesErrored ?? 0,
      total_violations: violations.map((v) => ({ rule_content: "test rule", enforcement_level: "strict", ...v })),
      results: [],
      execution_time_ms: 5,
      executed_at: timestamp,
      statutory_anchors: anchors,
      receipt: {
        id,
        schema_version: "5.0",
        kid: "ramen_pk_v1",
        signature: encodeBase64url(signatureBytes),
        canonical_payload: canonical,
        statutory_anchors: anchors,
      },
    },
  });
}

/**
 * Replaces global fetch for the ramen-ai evaluate endpoint. Each call takes the
 * next queued verdict. Returns the recorded upstream requests.
 */
export function mockRamen(...verdicts: FakeVerdict[]): { requests: UpstreamRequest[]; restore: () => void } {
  const queue = [...verdicts];
  const requests: UpstreamRequest[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://api.ramenai.dev/api/v1/paas/evaluate") {
      throw new Error(`unexpected outbound fetch to ${request.url}`);
    }
    const body = (await request.json()) as { bundle_ids?: string[]; policy_ids?: string[]; input: string };
    const recorded: UpstreamRequest = {
      url: request.url,
      authorization: request.headers.get("authorization"),
      bundle_ids: body.bundle_ids ?? [],
      policy_ids: body.policy_ids ?? [],
      input: body.input,
      raw_keys: Object.keys(body).sort(),
    };
    requests.push(recorded);
    const verdict = queue.shift();
    if (!verdict) throw new Error("no fake ramen verdict queued");
    return ramenResponse(recorded, verdict);
  });
  return { requests, restore: () => spy.mockRestore() };
}
