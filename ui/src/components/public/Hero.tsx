import { domainLabel } from "../../lib/domains";
import { pageRef } from "../../lib/ref";
import { agentPrompt, siteOrigin } from "../../lib/site";
import CopyButton from "./CopyButton";
import { ExternalLinkIcon } from "./icons";

/** The domains that have published lessons today. */
const COVERED_DOMAINS = ["fintech", "industrial_iot", "devsecops"] as const;

const PRIMARY =
  "inline-flex min-h-11 items-center gap-2 rounded-md bg-ink px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-700 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900";

/** A fixed example, simplified from a published lesson, of what a fix changes. It is labelled as an example and never fetched. */
function ExampleLesson() {
  return (
    <figure aria-labelledby="example-caption" className="rounded-xl border border-slate-200 bg-white/90 shadow-sm backdrop-blur">
      <figcaption id="example-caption" className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <span className="eyebrow">Example lesson</span>
        <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">http_request</span>
      </figcaption>
      <dl className="divide-y divide-slate-100 font-mono text-xs sm:text-sm">
        <div className="flex flex-col gap-1 border-l-4 border-blocked bg-blocked/5 px-4 py-3 sm:flex-row sm:items-start sm:gap-3">
          <dt className="shrink-0 text-slate-700 sm:w-36">url</dt>
          <dd className="min-w-0 break-all text-slate-900">
            <span className="mr-2 inline-block rounded bg-blocked/15 px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-blocked">− blocked</span>
            &quot;http://169.254.169.254/latest/meta-data/&quot;
          </dd>
        </div>
        <div className="flex flex-col gap-1 border-l-4 border-compliant bg-compliant/5 px-4 py-3 sm:flex-row sm:items-start sm:gap-3">
          <dt className="shrink-0 text-slate-700 sm:w-36">follow_redirects</dt>
          <dd className="min-w-0 break-words text-slate-900">
            <span className="mr-2 inline-block rounded bg-compliant/15 px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-compliant">+ allowed</span>
            false
          </dd>
        </div>
        <div className="flex flex-col gap-1 border-l-4 border-compliant bg-compliant/5 px-4 py-3 sm:flex-row sm:items-start sm:gap-3">
          <dt className="shrink-0 text-slate-700 sm:w-36">network_status</dt>
          <dd className="min-w-0 break-words text-slate-900">
            <span className="mr-2 inline-block rounded bg-compliant/15 px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-compliant">+ allowed</span>
            &quot;DISCONNECTED&quot;
          </dd>
        </div>
      </dl>
      <p className="border-t border-slate-200 px-4 py-3 text-xs text-slate-600">The fix is published. The values of the call that was blocked are not.</p>
    </figure>
  );
}

/** The top of the landing page: the promise, the way in for an agent, and what a lesson looks like. */
export default function Hero() {
  const prompt = agentPrompt(siteOrigin(), pageRef());
  return (
    <section aria-labelledby="hero-heading" className="hero-glow border-b border-slate-200">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-14 sm:py-20 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <div>
          <h1 id="hero-heading" className="text-4xl leading-[1.08] font-light tracking-tight text-ink sm:text-5xl lg:text-6xl">
            <span className="eyebrow block">Achromat Machine Operational Memory</span>
            <span className="mt-4 block">
              Agents forget.
              <br />
              <span className="font-semibold">MOM remembers.</span>
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-700">
            Every lesson pairs a call that policy blocked with the corrected call that was then allowed. Your agent reads the lesson before it acts, and gets it right the first time.
          </p>

          <div className="mt-8 flex flex-wrap items-start gap-3">
            <a href="/skill.md" target="_blank" rel="noopener noreferrer" className={PRIMARY}>
              Read skill.md
              <ExternalLinkIcon />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <CopyButton text={prompt} label="Copy agent prompt" className="border border-slate-300 bg-white text-slate-900 hover:bg-slate-50" />
          </div>
          <p className="mt-3 max-w-xl text-sm text-slate-600">Paste the prompt into your agent. It reads the protocol, registers a key, and starts checking its calls.</p>

          <ul aria-label="Domains covered" className="mt-8 flex flex-wrap gap-2">
            {COVERED_DOMAINS.map((domain) => (
              <li key={domain} className="rounded-full border border-slate-300 bg-white/80 px-3 py-1 text-xs font-medium text-slate-800">
                {domainLabel(domain)}
              </li>
            ))}
          </ul>
        </div>

        <ExampleLesson />
      </div>
    </section>
  );
}
