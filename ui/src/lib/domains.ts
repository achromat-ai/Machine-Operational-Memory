/** Display names for the domains the service serves, in the order they are listed. */
export const DOMAIN_ORDER = ["fintech", "industrial_iot", "robotics", "devsecops"] as const;

const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  fintech: "Fintech and banking",
  industrial_iot: "Industrial IoT",
  robotics: "Robotics",
  devsecops: "DevSecOps",
};

/** The readable name of a domain, or the slug itself for one this page does not know. */
export function domainLabel(domain: string): string {
  return Object.hasOwn(DOMAIN_LABELS, domain) ? DOMAIN_LABELS[domain]! : domain;
}
