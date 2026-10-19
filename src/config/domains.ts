/**
 * Which ramen-ai policies evaluate a call, chosen by MOM from (domain, tool).
 *
 * A domain bundle holds every policy of the domain, so a tool in it is also judged by unrelated policies
 * (a wire transfer was blocked by the credit adverse-action policy, and its steering text came from there).
 * The evaluate API has no tool or action parameter, only `policy_ids` or `bundle_ids`, so tools that are
 * known get an explicit `policy_ids` list instead of the bundle. Any other tool keeps the domain bundle.
 *
 * Whatever is chosen here, the resolved policy UUIDs that were actually evaluated are recorded from the
 * signed receipt, never from this file.
 *
 * The UUIDs below come from ramen-ai's own policy registry (GET /api/v1/safety/bundles and
 * /api/v1/safety/policies/:id). If ramen re-seeds a policy its UUID changes and the route must be updated;
 * a stale UUID makes the upstream call fail, which surfaces as 502 UPSTREAM_UNAVAILABLE.
 */
export const DOMAIN_BUNDLES: Readonly<Record<string, string>> = Object.freeze({
  fintech: "ramen__fintech_banking_invariance",
  industrial_iot: "ramen__industrial_iot_actuation_invariance",
  robotics: "ramen__industrial_iot_actuation_invariance",
  devsecops: "ramen__shield_core_it",
});

/** "Commercial Wire & Payment Execution Invariance" (domain FINTECH-TREASURY-WIRE). */
export const POLICY_FINTECH_WIRE = "b4c18ba1-26b7-4b7f-b44b-65e8de790572";
/** "Credit Adverse Action & Model Attribution Invariance" (domain FINTECH-CREDIT-ADVERSE-ACTION). */
export const POLICY_FINTECH_CREDIT_ADVERSE_ACTION = "796b7a87-d1f5-4ecc-91f2-a506a9b0d91e";

/** "Robotics Physical Safety & Biomechanical Invariance" (domain ROBOTICS-EMBODIED-AI). */
export const POLICY_ROBOTICS_MANIPULATION = "1fc71052-eb7e-43fe-9bfa-7ee06afe5b95";

/** What MOM asks ramen-ai to evaluate. `id` is what lands in the ledger's bundle_id columns (1-128 characters). */
export type UpstreamScope =
  | { readonly kind: "bundle"; readonly id: string }
  | { readonly kind: "policies"; readonly id: string; readonly policyIds: readonly string[] };

interface ToolRoute {
  readonly id: string;
  readonly policyIds: readonly string[];
}

/** domain → tool → policies. Tools that are not listed use the domain bundle. */
const MANIPULATION_ROUTE: ToolRoute = Object.freeze({
  id: "policies:robotics_manipulation",
  policyIds: Object.freeze([POLICY_ROBOTICS_MANIPULATION]),
});

const TOOL_ROUTES: Readonly<Record<string, Readonly<Record<string, ToolRoute>>>> = Object.freeze({
  // Without a route, an IoT or robotics tool is judged by all four IoT policies (envelope/slew, SIS isolation,
  // municipal-water ML, robotics safety), three of which have nothing to do with a manipulation command.
  industrial_iot: Object.freeze({ dispatch_manipulation: MANIPULATION_ROUTE }),
  robotics: Object.freeze({ dispatch_manipulation: MANIPULATION_ROUTE }),
  fintech: Object.freeze({
    dispatch_wire: Object.freeze({ id: "policies:fintech_wire", policyIds: Object.freeze([POLICY_FINTECH_WIRE]) }),
    issue_credit_adverse_action: Object.freeze({
      id: "policies:fintech_credit_adverse_action",
      policyIds: Object.freeze([POLICY_FINTECH_CREDIT_ADVERSE_ACTION]),
    }),
  }),
});

/** The bundle slug for a domain, or null if the domain is not served. */
export function bundleForDomain(domain: string): string | null {
  return Object.hasOwn(DOMAIN_BUNDLES, domain) ? DOMAIN_BUNDLES[domain]! : null;
}

/** The evaluation scope for a call, or null if the domain is not served. */
export function upstreamScopeFor(domain: string, tool: string): UpstreamScope | null {
  const bundle = bundleForDomain(domain);
  if (bundle === null) return null;
  const routes = Object.hasOwn(TOOL_ROUTES, domain) ? TOOL_ROUTES[domain]! : undefined;
  const route = routes && Object.hasOwn(routes, tool) ? routes[tool] : undefined;
  return route ? { kind: "policies", id: route.id, policyIds: route.policyIds } : { kind: "bundle", id: bundle };
}
