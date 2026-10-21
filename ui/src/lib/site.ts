/** What the page says about itself to a visitor's agent. No DOM beyond an optional, defensive `window.location`. */
import { withRef } from "./ref";

const FALLBACK_ORIGIN = "https://mom.achromat.ai";

/** The product name. Titles and headings use it in full; body text may shorten it to "MOM" after the first mention. */
export const BRAND = "Achromat Machine Operational Memory";

/** The origin this page is served from, so a copied prompt is right on a preview deployment too. */
export function siteOrigin(): string {
  const scope = globalThis as { window?: { location?: { origin?: string } } };
  const origin = scope.window?.location?.origin;
  return typeof origin === "string" && /^https?:\/\//.test(origin) ? origin : FALLBACK_ORIGIN;
}

/**
 * The sentence a visitor pastes into their agent. When the visitor arrived through a tagged link, the same tag rides
 * on the skill.md URL, so the agent's first request is attributed to it. Organic visitors get the plain URL.
 */
export function agentPrompt(origin: string, ref = ""): string {
  return `Read ${origin}${withRef("/skill.md", ref)} and follow it to register with ${BRAND} (MOM), then check it before you call a tool.`;
}
