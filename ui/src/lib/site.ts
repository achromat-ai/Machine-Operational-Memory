/** What the page says about itself to a visitor's agent. No DOM beyond an optional, defensive `window.location`. */

const FALLBACK_ORIGIN = "https://mom.achromat.ai";

/** The origin this page is served from, so a copied prompt is right on a preview deployment too. */
export function siteOrigin(): string {
  const scope = globalThis as { window?: { location?: { origin?: string } } };
  const origin = scope.window?.location?.origin;
  return typeof origin === "string" && /^https?:\/\//.test(origin) ? origin : FALLBACK_ORIGIN;
}

/** The sentence a visitor pastes into their agent. */
export function agentPrompt(origin: string): string {
  return `Read ${origin}/skill.md and follow it to register with Achromat MOM, then check it before you call a tool.`;
}
