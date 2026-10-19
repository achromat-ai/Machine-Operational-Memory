import { Fragment, useCallback, useEffect, useState } from "react";
import { buildDeltaRows, splitRows } from "../../lib/delta";
import { domainLabel } from "../../lib/domains";
import { relativeTime, type FeedLessonView } from "../../lib/feed";
import { cardAnchor, changedFieldLabels, lessonIdFromHash, rowAnchor, splitRule, splitSteering, toolSegments } from "../../lib/lessonText";
import CopyButton from "./CopyButton";
import { DeltaPanel, ValueText } from "./DeltaPanel";
import { ChevronIcon } from "./icons";

const rowDetailId = (lessonId: string) => `lesson-detail-${lessonId}`;
const cardDetailId = (lessonId: string) => `lesson-card-detail-${lessonId}`;

function DomainPill({ domain }: { domain: string }) {
  return <span className="inline-block rounded-full border border-slate-300 bg-white px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-slate-800">{domainLabel(domain)}</span>;
}

function FeaturedBadge() {
  return <span className="inline-block rounded bg-compliant/15 px-2 py-0.5 text-xs font-semibold text-compliant">Featured</span>;
}

function ToolChip({ tool }: { tool: string }) {
  return (
    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs break-words text-slate-900">
      {toolSegments(tool).map((segment, index) => (
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          {segment}
        </Fragment>
      ))}
    </code>
  );
}

function RuleCell({ lesson }: { lesson: FeedLessonView }) {
  const { statute, rule } = splitRule(lesson.violationRule);
  return (
    <div className="min-w-0">
      {lesson.displayTitle ? <p className="text-sm font-semibold text-slate-900">{lesson.displayTitle}</p> : null}
      <p className="line-clamp-2 text-sm text-slate-800">{statute}</p>
      {rule ? <span className="mt-1 inline-block rounded bg-blocked/10 px-1.5 py-0.5 text-xs font-semibold text-blocked">{rule}</span> : null}
    </div>
  );
}

function FixCell({ lesson }: { lesson: FeedLessonView }) {
  const { lead } = splitSteering(lesson.steeringDirective);
  const { shown, hidden } = changedFieldLabels(lesson.changedPaths);
  return (
    <div className="min-w-0">
      {lead ? <p className="line-clamp-2 text-sm font-medium text-slate-900">{lead}</p> : <p className="text-sm text-slate-600 italic">No directive recorded.</p>}
      {shown.length > 0 ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-1" aria-label={`Fields the fix changes: ${shown.join(", ")}${hidden > 0 ? ` and ${hidden} more` : ""}`}>
          {shown.map((label) => (
            <code key={label} className="rounded bg-compliant/10 px-1.5 py-0.5 font-mono text-xs break-all text-compliant">
              {label}
            </code>
          ))}
          {hidden > 0 ? <span className="text-xs font-medium text-slate-700">+{hidden} more</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/** Everything that would clutter the row: the whole directive, the anchor, and the exact parameter changes. */
function LessonDetail({ lesson }: { lesson: FeedLessonView }) {
  const { lead, more } = splitSteering(lesson.steeringDirective);
  const { visible, unchanged } = splitRows(buildDeltaRows(null, lesson.compliantArguments, lesson.changedPaths));
  const blueprint = JSON.stringify(lesson.compliantArguments, null, 2);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="min-w-0 space-y-4">
        {lead ? (
          <section aria-label="Steering directive" className="rounded-md border-l-4 border-compliant bg-compliant/5 px-4 py-3">
            <p className="eyebrow text-compliant">Steering directive</p>
            <p className="mt-1 text-base font-medium text-slate-900">{lead}</p>
            {more.length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-800">
                {more.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
        {lesson.displaySummary ? <p className="text-sm text-slate-800">{lesson.displaySummary}</p> : null}
        <p className="text-sm text-slate-800">
          <span className="font-semibold text-slate-900">Rule: </span>
          {lesson.violationRule}
        </p>
        {lesson.statutoryAnchor ? (
          <p className="text-sm text-slate-800">
            <span className="font-semibold text-slate-900">Statutory anchor: </span>
            {lesson.statutoryAnchor}
          </p>
        ) : null}
        <p className="text-xs text-slate-600">
          Updated <time dateTime={lesson.updatedAt}>{relativeTime(lesson.updatedAt)}</time>. The values of the call that was originally blocked are not published.
        </p>
      </div>

      <div className="min-w-0 space-y-3">
        <DeltaPanel side="right" label="The fix" rows={visible} comparing={false} />
        {unchanged.length > 0 ? (
          <details className="rounded-md border border-slate-200 text-sm">
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
        <CopyButton text={blueprint} label="Copy blueprint JSON" className="border border-slate-300 bg-white text-slate-900 hover:bg-slate-50" />
      </div>
    </div>
  );
}

function ToggleButton({ lesson, open, onToggle, controls, withText }: { lesson: FeedLessonView; open: boolean; onToggle: () => void; controls: string; withText?: boolean }) {
  const { rule } = splitRule(lesson.violationRule);
  const name = `${open ? "Hide" : "Show"} details for ${lesson.tool}${rule ? `, ${rule}` : ""}`;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={name}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white text-sm font-semibold text-slate-900 hover:bg-slate-50 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 ${withText ? "w-full px-4" : "min-w-11 px-2"}`}
    >
      {withText ? <span aria-hidden="true">{open ? "Hide details" : "Show details"}</span> : null}
      <ChevronIcon className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
    </button>
  );
}

export interface FeedTableProps {
  lessons: readonly FeedLessonView[];
  /** Id of the element that names this list. */
  labelledBy: string;
}

/**
 * The lessons as a dense, scannable list. From `md` up it is a real table (Domain, Tool, Violation, Fix) whose
 * rows open into a detail row; below `md` the same lessons are cards. Both read the same open/closed state.
 * Only the open lessons render their detail, so a long feed stays light.
 */
export default function FeedTable({ lessons, labelledBy }: FeedTableProps) {
  // A link such as /#lesson-<id> starts with that lesson open. (This list only mounts once there are lessons.)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => {
    const id = typeof window === "undefined" ? null : lessonIdFromHash(window.location.hash ?? "");
    return id !== null && lessons.some((lesson) => lesson.lessonId === id) ? new Set([id]) : new Set();
  });
  const toggle = useCallback((lessonId: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(lessonId)) next.add(lessonId);
      return next;
    });
  }, []);

  // Bring the linked lesson (whichever of its two forms is on screen) into view once, after the first paint.
  useEffect(() => {
    const id = lessonIdFromHash(window.location.hash);
    if (id === null) return;
    const frame = window.requestAnimationFrame(() => {
      const target = [rowAnchor(id), cardAnchor(id)].map((anchor) => document.getElementById(anchor)).find((element) => element !== null && element.offsetParent !== null);
      target?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm md:block">
        <table aria-labelledby={labelledBy} className="w-full table-fixed border-collapse text-left">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th scope="col" className="eyebrow w-44 px-4 py-3 font-medium">
                Domain
              </th>
              <th scope="col" className="eyebrow w-56 px-4 py-3 font-medium">
                Tool
              </th>
              <th scope="col" className="eyebrow w-[30%] px-4 py-3 font-medium">
                Violation
              </th>
              <th scope="col" className="eyebrow px-4 py-3 font-medium">
                Fix
              </th>
              <th scope="col" className="w-16 px-4 py-3">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          {lessons.map((lesson) => {
            const isOpen = open.has(lesson.lessonId);
            return (
              <tbody key={lesson.lessonId} className="border-b border-slate-100 last:border-b-0">
                <tr id={rowAnchor(lesson.lessonId)} className={`align-top hover:bg-slate-50 ${isOpen ? "bg-slate-50" : ""}`}>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-1.5">
                      <DomainPill domain={lesson.domain} />
                      {lesson.featured ? <FeaturedBadge /> : null}
                      <time dateTime={lesson.updatedAt} className="text-xs text-slate-600">
                        {relativeTime(lesson.updatedAt)}
                      </time>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <ToolChip tool={lesson.tool} />
                  </td>
                  <td className="px-4 py-3">
                    <RuleCell lesson={lesson} />
                  </td>
                  <td className="px-4 py-3">
                    <FixCell lesson={lesson} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ToggleButton lesson={lesson} open={isOpen} onToggle={() => toggle(lesson.lessonId)} controls={rowDetailId(lesson.lessonId)} />
                  </td>
                </tr>
                <tr id={rowDetailId(lesson.lessonId)} hidden={!isOpen}>
                  {isOpen ? (
                    <td colSpan={5} className="border-t border-slate-200 bg-white px-6 py-5">
                      <LessonDetail lesson={lesson} />
                    </td>
                  ) : null}
                </tr>
              </tbody>
            );
          })}
        </table>
      </div>

      <ul aria-labelledby={labelledBy} className="space-y-3 md:hidden">
        {lessons.map((lesson) => {
          const isOpen = open.has(lesson.lessonId);
          return (
            <li key={lesson.lessonId} id={cardAnchor(lesson.lessonId)} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <DomainPill domain={lesson.domain} />
                {lesson.featured ? <FeaturedBadge /> : null}
                <time dateTime={lesson.updatedAt} className="ml-auto text-xs text-slate-600">
                  {relativeTime(lesson.updatedAt)}
                </time>
              </div>
              <div className="mt-3">
                <ToolChip tool={lesson.tool} />
              </div>
              <div className="mt-3">
                <p className="eyebrow">Violation</p>
                <RuleCell lesson={lesson} />
              </div>
              <div className="mt-3">
                <p className="eyebrow">Fix</p>
                <FixCell lesson={lesson} />
              </div>
              <div className="mt-4">
                <ToggleButton lesson={lesson} open={isOpen} onToggle={() => toggle(lesson.lessonId)} controls={cardDetailId(lesson.lessonId)} withText />
              </div>
              <div id={cardDetailId(lesson.lessonId)} hidden={!isOpen} className="mt-4">
                {isOpen ? <LessonDetail lesson={lesson} /> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
