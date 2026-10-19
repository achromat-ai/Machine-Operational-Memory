/** Which ramen-ai policies evaluate a call: tool-scoped policy_ids where the tool is known, else the domain bundle. */
import { describe, expect, it } from "vitest";
import {
  DOMAIN_BUNDLES,
  POLICY_FINTECH_CREDIT_ADVERSE_ACTION,
  POLICY_FINTECH_WIRE,
  POLICY_ROBOTICS_MANIPULATION,
  bundleForDomain,
  upstreamScopeFor,
} from "../src/config/domains";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("upstreamScopeFor", () => {
  it("scopes fintech wires to the wire policy only", () => {
    expect(upstreamScopeFor("fintech", "dispatch_wire")).toEqual({ kind: "policies", id: "policies:fintech_wire", policyIds: [POLICY_FINTECH_WIRE] });
  });

  it("scopes fintech credit adverse action to the credit policy only", () => {
    expect(upstreamScopeFor("fintech", "issue_credit_adverse_action")).toEqual({
      kind: "policies",
      id: "policies:fintech_credit_adverse_action",
      policyIds: [POLICY_FINTECH_CREDIT_ADVERSE_ACTION],
    });
  });

  it("scopes dispatch_manipulation to the robotics policy alone, in industrial_iot and robotics", () => {
    for (const domain of ["industrial_iot", "robotics"]) {
      expect(upstreamScopeFor(domain, "dispatch_manipulation")).toEqual({
        kind: "policies",
        id: "policies:robotics_manipulation",
        policyIds: [POLICY_ROBOTICS_MANIPULATION],
      });
    }
    // Other tools in those domains still use the shared bundle, and the tool is not routed in other domains.
    expect(upstreamScopeFor("industrial_iot", "set_valve_position")).toEqual({ kind: "bundle", id: "ramen__industrial_iot_actuation_invariance" });
    expect(upstreamScopeFor("devsecops", "dispatch_manipulation")).toEqual({ kind: "bundle", id: "ramen__shield_core_it" });
    expect(upstreamScopeFor("fintech", "dispatch_manipulation")).toEqual({ kind: "bundle", id: "ramen__fintech_banking_invariance" });
  });

  it("never mixes the wire and credit policies", () => {
    expect(POLICY_FINTECH_WIRE).not.toBe(POLICY_FINTECH_CREDIT_ADVERSE_ACTION);
    const wire = upstreamScopeFor("fintech", "dispatch_wire");
    const credit = upstreamScopeFor("fintech", "issue_credit_adverse_action");
    expect(wire?.kind === "policies" && credit?.kind === "policies" && wire.policyIds.some((id) => credit.policyIds.includes(id))).toBe(false);
  });

  it("keeps the domain bundle for tools without a route and for every other domain", () => {
    expect(upstreamScopeFor("fintech", "transfer_funds")).toEqual({ kind: "bundle", id: "ramen__fintech_banking_invariance" });
    expect(upstreamScopeFor("industrial_iot", "dispatch_wire")).toEqual({ kind: "bundle", id: "ramen__industrial_iot_actuation_invariance" });
    expect(upstreamScopeFor("robotics", "move_arm")).toEqual({ kind: "bundle", id: "ramen__industrial_iot_actuation_invariance" });
    expect(upstreamScopeFor("devsecops", "monitor_logs")).toEqual({ kind: "bundle", id: "ramen__shield_core_it" });
  });

  it("serves no domain it does not know, whatever the tool", () => {
    expect(upstreamScopeFor("healthcare", "dispatch_wire")).toBeNull();
    expect(upstreamScopeFor("", "dispatch_wire")).toBeNull();
    expect(bundleForDomain("healthcare")).toBeNull();
  });

  it("is not fooled by inherited object keys", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(upstreamScopeFor("fintech", name)).toEqual({ kind: "bundle", id: DOMAIN_BUNDLES.fintech });
      expect(upstreamScopeFor(name, "dispatch_wire")).toBeNull();
    }
  });

  it("keeps every ledger label within the 1-128 characters the bundle_id columns allow", () => {
    for (const [domain, tool] of [["fintech", "dispatch_wire"], ["fintech", "issue_credit_adverse_action"], ["fintech", "other"], ["robotics", "dispatch_manipulation"]] as const) {
      const scope = upstreamScopeFor(domain, tool)!;
      expect(scope.id.length).toBeGreaterThanOrEqual(1);
      expect(scope.id.length).toBeLessThanOrEqual(128);
      if (scope.kind === "policies") {
        expect(scope.policyIds.length).toBeGreaterThanOrEqual(1);
        expect(scope.policyIds.length).toBeLessThanOrEqual(20); // the evaluate contract accepts 1-20
        expect(new Set(scope.policyIds).size).toBe(scope.policyIds.length);
        for (const id of scope.policyIds) expect(id).toMatch(UUID);
      }
    }
  });
});
