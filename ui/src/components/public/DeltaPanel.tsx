import { useId } from "react";
import { describeRow, formatValue, type DeltaRow } from "../../lib/delta";

/** One value. Long values collapse into a details element so the card stays readable. */
export function ValueText({ value }: { value: unknown }) {
  const formatted = formatValue(value);
  if (!formatted.truncated) return <code className="font-mono text-sm break-words text-slate-900">{formatted.preview}</code>;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer">
        <code className="font-mono break-words text-slate-900">{formatted.preview}</code>
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-50 p-2 font-mono text-xs whitespace-pre-wrap break-all text-slate-900">{formatted.full}</pre>
    </details>
  );
}

const TAG_BASE = "ml-2 inline-block rounded px-1.5 py-0.5 align-middle text-xs font-semibold";

function RowTag({ side, row, comparing }: { side: "left" | "right"; row: DeltaRow; comparing: boolean }) {
  const text = describeRow(row, side, comparing);
  if (text === "unchanged") return null;
  const good = side === "right" || text === "already matches";
  return (
    <span className={`${TAG_BASE} ${good ? "bg-compliant/15 text-compliant" : "bg-blocked/15 text-blocked"}`}>
      {side === "right" ? "+ " : text === "already matches" ? "= " : "− "}
      {text}
    </span>
  );
}

function rowClass(side: "left" | "right", row: DeltaRow, comparing: boolean): string {
  const base = "border-l-4 px-3 py-2";
  if (side === "right") {
    return row.highlighted ? `${base} border-compliant bg-compliant/10` : `${base} border-transparent`;
  }
  if (!comparing || !row.highlighted) return `${base} border-transparent`;
  return row.status === "same" ? `${base} border-compliant bg-compliant/5` : `${base} border-blocked bg-blocked/10`;
}

export function DeltaPanel({ side, label, rows, comparing }: { side: "left" | "right"; label: string; rows: DeltaRow[]; comparing: boolean }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-side={side} className="min-w-0 rounded-md border border-slate-200">
      <h4 id={headingId} className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900">
        {label}
      </h4>
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-sm text-slate-600">Nothing to show.</p>
      ) : (
        <dl className="divide-y divide-slate-100">
          {rows.map((row) => {
            const present = side === "left" ? row.hasLeft : row.hasRight;
            return (
              <div key={row.path} className={rowClass(side, row, comparing)} data-path={row.path} data-highlighted={row.highlighted} data-status={row.status}>
                <dt className="font-mono text-xs break-all text-slate-600">
                  {row.label}
                  <RowTag side={side} row={row} comparing={comparing} />
                </dt>
                <dd className="mt-0.5">
                  {present ? (
                    <ValueText value={side === "left" ? row.left : row.right} />
                  ) : (
                    <span className="text-sm text-slate-600 italic">{side === "left" ? "not set in your call" : "removed by the fix"}</span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}
