import { ExternalLinkIcon } from "./icons";

/**
 * The global header: the Achromat mark and wordmark (one home link) and the link to the agent protocol
 * document, which the Worker serves at /skill.md as plain text and which opens in a new tab. Plain anchors,
 * so both work without JavaScript. The images live in ui/public and come from the page's own origin (the CSP
 * allows no other). logo-light.png is the transparent mark made for light surfaces such as this header.
 */
export default function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-3">
        <a href="/" className="inline-flex items-center gap-3 rounded focus:outline-2 focus:outline-offset-4 focus:outline-slate-900">
          <img src="/logo-light.png" width="190" height="160" alt="" className="h-9 w-auto sm:h-10" />
          <img src="/logo-text.png" width="640" height="75" alt="" className="hidden h-6 w-auto sm:block" />
          <span className="sr-only">Achromat AI: home</span>
        </a>
        <nav aria-label="Primary">
          <a
            href="/skill.md"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Agent Protocol: /skill.md (opens in a new tab)"
            className="inline-flex min-h-10 items-center gap-2 rounded-md border border-ink px-3 py-2 font-mono text-sm font-semibold text-ink hover:bg-ink hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-slate-900"
          >
            <span aria-hidden="true">Agent Protocol: /skill.md</span>
            <ExternalLinkIcon />
          </a>
        </nav>
      </div>
    </header>
  );
}
