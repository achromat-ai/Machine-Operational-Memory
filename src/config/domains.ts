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
  devsecops: "ramen__shield_core_it",
  contractual_eligibility: "ramen__contractual_eligibility_invariance",
  compliance_provenance: "ramen__compliance_provenance_invariance",
});

/**
 * Slugs accepted in place of a served domain. Each request is rewritten to the target before anything else reads
 * the domain (fingerprint, ledger, Vectorize namespace, telemetry), so an alias never owns lessons of its own.
 * `robotics` was offered by the first package releases, but robot commands have always been judged and stored
 * under industrial_iot.
 */
export const DOMAIN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  robotics: "industrial_iot",
});

/** The served domain a slug stands for: the alias target, or the slug itself. */
export function canonicalDomain(domain: string): string {
  return Object.hasOwn(DOMAIN_ALIASES, domain) ? DOMAIN_ALIASES[domain]! : domain;
}

/** "Commercial Wire & Payment Execution Invariance" (domain FINTECH-TREASURY-WIRE). */
export const POLICY_FINTECH_WIRE = "b4c18ba1-26b7-4b7f-b44b-65e8de790572";
/** "Credit Adverse Action & Model Attribution Invariance" (domain FINTECH-CREDIT-ADVERSE-ACTION). */
export const POLICY_FINTECH_CREDIT_ADVERSE_ACTION = "796b7a87-d1f5-4ecc-91f2-a506a9b0d91e";
/** "Financial Authorization and Corporate Spend" (domain FINTECH-CORPORATE-SPEND), bundle ramen__financial_authorization_invariance. */
export const POLICY_FINANCIAL_AUTHORIZATION = "d5552e6c-4be4-45de-9ddb-9cded0f8b054";
/** "Contractual Eligibility and Exclusion" (domain INSURTECH-CONTRACTUAL-ELIGIBILITY), bundle ramen__contractual_eligibility_invariance. */
export const POLICY_CONTRACTUAL_ELIGIBILITY = "dc4a9f18-4df8-4ac9-9454-10040b527509";
/** "Compliance Provenance and Evidence Traceability" (domain COMPLIANCE-OPS-EVIDENCE-TRACEABILITY), bundle ramen__compliance_provenance_invariance. */
export const POLICY_COMPLIANCE_PROVENANCE = "aa73b31c-84ca-46b3-9cd0-fb0e3c48da1d";

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

function route(id: string, policyId: string): ToolRoute {
  return Object.freeze({ id, policyIds: Object.freeze([policyId]) });
}

/** domain → tool → policies. Tools that are not listed use the domain bundle. */
const MANIPULATION_ROUTE = route("policies:robotics_manipulation", POLICY_ROBOTICS_MANIPULATION);
const FINANCIAL_AUTHORIZATION_ROUTE = route("policies:fintech_financial_authorization", POLICY_FINANCIAL_AUTHORIZATION);
const CONTRACTUAL_ELIGIBILITY_ROUTE = route("policies:contractual_eligibility", POLICY_CONTRACTUAL_ELIGIBILITY);
const COMPLIANCE_PROVENANCE_ROUTE = route("policies:compliance_provenance", POLICY_COMPLIANCE_PROVENANCE);

const TOOL_ROUTES: Readonly<Record<string, Readonly<Record<string, ToolRoute>>>> = Object.freeze({
  // Without a route, an IoT or robotics tool is judged by all four IoT policies (envelope/slew, SIS isolation,
  // municipal-water ML, robotics safety), three of which have nothing to do with a manipulation command.
  industrial_iot: Object.freeze({ dispatch_manipulation: MANIPULATION_ROUTE }),
  fintech: Object.freeze({
    dispatch_wire: route("policies:fintech_wire", POLICY_FINTECH_WIRE),
    issue_credit_adverse_action: route("policies:fintech_credit_adverse_action", POLICY_FINTECH_CREDIT_ADVERSE_ACTION),
    // Corporate spend lives in its own ramen bundle (ramen__financial_authorization_invariance), served under fintech.
    commit_corporate_spend: FINANCIAL_AUTHORIZATION_ROUTE,
    approve_expenditure: FINANCIAL_AUTHORIZATION_ROUTE,
    release_payment: FINANCIAL_AUTHORIZATION_ROUTE,
  }),
  // Each of these bundles holds one policy. The explicit route is what lets a tool's receipts be checked against
  // an exact policy list (src/review/seed.ts) instead of a bundle whose members may change.
  contractual_eligibility: Object.freeze({
    approve_eligibility_claim: CONTRACTUAL_ELIGIBILITY_ROUTE,
    confirm_eligibility: CONTRACTUAL_ELIGIBILITY_ROUTE,
    bind_contract_terms: CONTRACTUAL_ELIGIBILITY_ROUTE,
  }),
  compliance_provenance: Object.freeze({
    submit_regulated_record: COMPLIANCE_PROVENANCE_ROUTE,
    submit_filing: COMPLIANCE_PROVENANCE_ROUTE,
    release_report: COMPLIANCE_PROVENANCE_ROUTE,
  }),
});

/** The bundle slug for a domain (an alias resolves to its target), or null if the domain is not served. */
export function bundleForDomain(domain: string): string | null {
  const served = canonicalDomain(domain);
  return Object.hasOwn(DOMAIN_BUNDLES, served) ? DOMAIN_BUNDLES[served]! : null;
}

/** The evaluation scope for a call (an alias resolves to its target), or null if the domain is not served. */
export function upstreamScopeFor(domain: string, tool: string): UpstreamScope | null {
  const served = canonicalDomain(domain);
  const bundle = bundleForDomain(served);
  if (bundle === null) return null;
  const routes = Object.hasOwn(TOOL_ROUTES, served) ? TOOL_ROUTES[served]! : undefined;
  const scoped = routes && Object.hasOwn(routes, tool) ? routes[tool] : undefined;
  return scoped ? { kind: "policies", id: scoped.id, policyIds: scoped.policyIds } : { kind: "bundle", id: bundle };
}
