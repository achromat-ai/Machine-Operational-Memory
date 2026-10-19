import { describe, expect, it } from "vitest";
import { RAMEN_RECEIPT_KEYS } from "../src/crypto/ramen-key";
import { verifyRamenReceipt } from "../src/crypto/receipt";
import { GENERIC_STEERING, buildPairDelta, deriveSteeringDirective, deriveViolationRule, diffArguments } from "../src/pairing";
import { UpstreamEvaluation, type SignedPayloadV5 } from "../src/schema";
import { ramenResponse } from "./fixtures/ramen";

function signed(overrides: Partial<SignedPayloadV5> = {}): SignedPayloadV5 {
  return {
    schema_version: "5.0",
    kid: "ramen_pk_v1",
    id: "2fef12ff-923a-4192-ba5c-b31b354314b4",
    timestamp: "2026-10-09T10:00:00.000Z",
    policy_ids: ["b-policy", "a-policy"],
    payload_hash: "0".repeat(64),
    verdict: 0,
    reasoning: "Commission-led recommendation violates FCA suitability duty.",
    steering: "Reassess product suitability.",
    statutory_anchors: ["FCA PRIN 2A.2.8"],
    ...overrides,
  };
}

function evaluation(violations: unknown[]) {
  return UpstreamEvaluation.parse({ allowed: false, total_violations: violations });
}

const SUITABILITY = {
  rule_id: "0eadfb7d",
  rule_name: "Suitability check",
  enforcement_level: "strict",
  reasoning: "Commission-led recommendation violates FCA suitability duty.",
};

describe("violation rule fallback chain", () => {
  it("uses the rule name when the violation list matches the signed reasoning", () => {
    expect(deriveViolationRule(evaluation([SUITABILITY]), signed())).toBe("Suitability check");
  });

  it("prefers strict rules, deduplicates and orders by rule_id", () => {
    const rules = [
      { ...SUITABILITY, rule_id: "b", rule_name: "Beta", reasoning: "two" },
      { ...SUITABILITY, rule_id: "a", rule_name: "Alpha", reasoning: "one" },
      { ...SUITABILITY, rule_id: "c", rule_name: "Advisory", enforcement_level: "suggested", reasoning: "three" },
    ];
    expect(deriveViolationRule(evaluation(rules), signed({ reasoning: "two | one | three" }))).toBe("Alpha + Beta");
  });

  it("prefixes generic rule names with the statutory anchor", () => {
    const generic = { ...SUITABILITY, rule_name: "Rule 1" };
    expect(deriveViolationRule(evaluation([generic]), signed())).toBe("FCA PRIN 2A.2.8: Rule 1");
  });

  it("falls back to the anchor when the unsigned list does not match the signed reasoning", () => {
    expect(deriveViolationRule(evaluation([SUITABILITY]), signed({ reasoning: "something else" }))).toBe("FCA PRIN 2A.2.8");
  });

  it("falls back to the first reasoning segment, then the first policy id", () => {
    const noNames = evaluation([]);
    expect(deriveViolationRule(noNames, signed({ statutory_anchors: [], reasoning: "First cause | second cause" }))).toBe(
      "First cause",
    );
    expect(deriveViolationRule(noNames, signed({ statutory_anchors: [], reasoning: "" }))).toBe("policy:a-policy");
  });

  it("caps the rule at 256 code points and strips control characters", () => {
    const long = { ...SUITABILITY, rule_name: `Rule\u0007 ${"x".repeat(400)}` };
    const rule = deriveViolationRule(evaluation([long]), signed());
    expect([...rule].length).toBe(256);
    expect(rule.startsWith("Rule x")).toBe(true);
  });
});

describe("steering directive", () => {
  it("uses signed steering, then signed reasoning, then the generic fallback", () => {
    const empty = evaluation([]);
    expect(deriveSteeringDirective(signed(), empty)).toBe("Reassess product suitability.");
    expect(deriveSteeringDirective(signed({ steering: " " }), empty)).toBe(signed().reasoning);
    expect(deriveSteeringDirective(signed({ steering: "", reasoning: "" }), empty)).toBe(GENERIC_STEERING);
  });
});

describe("pair delta", () => {
  it("lists leaf changes as JSON Pointer paths", () => {
    const changes = diffArguments({ a: 1, b: { c: "x", "d/e": 1 }, gone: true }, { a: 1, b: { c: "y", "d/e": 1 }, added: [1] });
    expect(changes.map((change) => [change.path, change.kind])).toEqual([
      ["/added", "added"],
      ["/b/c", "changed"],
      ["/gone", "removed"],
    ]);
  });

  it("returns null for a degenerate (unchanged) fix, ignoring key order", async () => {
    expect(await buildPairDelta({ a: 1, b: 2 }, { b: 2, a: 1 })).toBeNull();
    const delta = await buildPairDelta({ a: 1 }, { a: 2 });
    expect(delta?.changedPaths).toEqual(["/a"]);
    expect(delta?.deltaHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("pinned ramen_pk_v1", () => {
  it("equals the raw key inside the published SPKI", () => {
    const spki = Uint8Array.from(atob("MCowBQYDK2VwAyEA8iTL9lJGYn2alGn1yMWVAIqLImTpADb9CqaLhisTuto="), (ch) => ch.charCodeAt(0));
    const raw = [...spki.slice(-32)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(RAMEN_RECEIPT_KEYS.ramen_pk_v1).toBe(raw);
    expect(raw).toBe("f224cbf65246627d9a9469f5c8c595008a8b2264e90036fd0aa68b862b13bada");
  });

  it("rejects a receipt signed by any other key", async () => {
    const input = '{"arguments":{"a":1},"tool":"t"}';
    const response = await ramenResponse({ url: "", authorization: null, bundle_ids: [], policy_ids: [], input }, { allowed: true });
    const { data } = (await response.json()) as { data: { receipt: unknown } };
    const check = await verifyRamenReceipt(data.receipt, input, 1);
    expect(check).toMatchObject({ verified: false, ok: false, reason: "receipt signature does not verify against the pinned key" });
  });
});
