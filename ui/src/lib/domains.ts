/** Display names for the domains the service serves, in the order they are listed. */
export const DOMAIN_ORDER = ["fintech", "industrial_iot", "devsecops", "contractual_eligibility", "compliance_provenance"] as const;

const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  fintech: "Fintech and banking",
  industrial_iot: "Industrial IoT",
  devsecops: "DevSecOps",
  contractual_eligibility: "Contractual eligibility",
  compliance_provenance: "Compliance provenance",
};

/** The readable name of a domain, or the slug itself for one this page does not know. */
export function domainLabel(domain: string): string {
  return Object.hasOwn(DOMAIN_LABELS, domain) ? DOMAIN_LABELS[domain]! : domain;
}
