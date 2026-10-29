import { useId, type ReactNode } from "react";
import { buildDeltaRows, splitRows, type JsonObject } from "../../lib/delta";
import { DeltaPanel, ValueText } from "./DeltaPanel";

export interface DeltaCardProps {
  /**
   * What the call ran into. The public pages pass lessonHeading() (title, else statutory anchor, else
   * "Policy violation: <tool>"); the review console passes the full rule text. When the heading already is the
   * statutory anchor, the anchor line below it is left out.
   */
  heading: string;
  /** Badges and facts shown under the heading. */
  meta?: ReactNode;
  steeringDirective: string | null;
  statutoryAnchor: string | null;
  /**
   * The call being compared: the user's own arguments on the public page, the original blocked arguments
   * in the review console. Null when there is nothing to compare, and the left panel is not drawn.
   */
  left: JsonObject | null;
  right: JsonObject;
  /** RFC 6901 pointers the lesson changed. They decide which fields are highlighted. */
  changedPaths: readonly string[];
  leftLabel?: string;
  rightLabel?: string;
  /** Small print under the panels. */
  note?: ReactNode;
  /** Extra content between the panels and the footer (task text, checks, ...). */
  children?: ReactNode;
  /** Actions. */
  footer?: ReactNode;
  headingLevel?: 2 | 3;
}

/**
 * A lesson as a split view: the call on the left, the compliant fix on the right, side by side from the
 * md breakpoint and stacked below it. The fields named by `changedPaths` are highlighted, and every
 * highlight also carries a symbol and a word, so the meaning never depends on colour.
 */
export default function DeltaCard(props: DeltaCardProps) {
  const { heading, meta, steeringDirective, statutoryAnchor, left, right, changedPaths, note, children, footer } = props;
  const headingId = useId();
  const comparing = left !== null;
  const rows = buildDeltaRows(left, right, changedPaths);
  const { visible, unchanged } = splitRows(rows);
  const Heading = props.headingLevel === 2 ? "h2" : "h3";

  return (
    <article aria-labelledby={headingId} className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <header className="border-b border-slate-200 px-5 py-4">
        <Heading id={headingId} className="text-lg font-semibold tracking-tight text-slate-900">
          {heading}
        </Heading>
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-700">{meta}</div> : null}
      </header>

      {steeringDirective ? (
        <aside aria-label="Steering directive" className="mx-5 mt-4 rounded-md border-l-4 border-compliant bg-compliant/5 px-4 py-3">
          <p className="text-xs font-semibold tracking-wide text-compliant uppercase">Steering directive</p>
          <p className="mt-1 text-base font-medium text-slate-900">{steeringDirective}</p>
        </aside>
      ) : null}
      {statutoryAnchor && statutoryAnchor !== heading ? (
        <p className="mx-5 mt-3 text-sm text-slate-700">
          <span className="font-semibold text-slate-900">Statutory anchor: </span>
          {statutoryAnchor}
        </p>
      ) : null}

      <div className={`grid grid-cols-1 gap-4 p-5 ${comparing ? "md:grid-cols-2" : ""}`} data-testid="delta-panels">
        {comparing ? <DeltaPanel side="left" label={props.leftLabel ?? "Your call"} rows={visible} comparing /> : null}
        <DeltaPanel side="right" label={props.rightLabel ?? "The fix"} rows={visible} comparing={comparing} />
      </div>

      {unchanged.length > 0 ? (
        <details className="mx-5 mb-4 rounded-md border border-slate-200 text-sm">
          <summary className="cursor-pointer px-3 py-2 font-medium text-slate-700">
            {unchanged.length} unchanged {unchanged.length === 1 ? "field" : "fields"}
          </summary>
          <dl className="divide-y divide-slate-100 border-t border-slate-200">
            {unchanged.map((row) => (
              <div key={row.path} className="px-3 py-2">
                <dt className="font-mono text-xs break-all text-slate-600">{row.label}</dt>
                <dd className="mt-0.5">
                  <ValueText value={row.hasRight ? row.right : row.left} />
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}

      {note ? <p className="mx-5 mb-4 text-xs text-slate-600">{note}</p> : null}
      {children ? <div className="border-t border-slate-200 px-5 py-4">{children}</div> : null}
      {footer ? <footer className="border-t border-slate-200 bg-slate-50 px-5 py-4">{footer}</footer> : null}
    </article>
  );
}
