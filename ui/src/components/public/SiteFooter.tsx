/** The minimal footer: who made this and the way in for an agent. No external links. */
export default function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-6 text-sm text-slate-700">
        <p>
          <span className="font-semibold text-ink">Achromat AI</span>
          <span aria-hidden="true"> · </span>
          Verified memory of blocked agent actions and their fixes.
        </p>
        <a
          href="/skill.md"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded font-medium underline underline-offset-4 hover:text-ink focus:outline-2 focus:outline-offset-2 focus:outline-slate-900"
        >
          Agent protocol (skill.md)
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
    </footer>
  );
}
