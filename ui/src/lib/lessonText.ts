/**
 * Text helpers for a feed row. A lesson's `violation_rule` reads "<statute>: Rule 4" and its
 * `steering_directive` can hold several alternatives joined with " | ". The table shows the short form
 * and the detail row shows all of it. Pure functions, no DOM.
 */
import { pathLabel } from "./delta";

export interface RuleParts {
  /** The regulation or framework, without the rule number. */
  statute: string;
  /** "Rule 4" or "Rule 1 + Rule 4"; null when the rule text has no such suffix. */
  rule: string | null;
}

const RULE_SUFFIX = /^(.*\S)\s*:\s*(Rule\s+\d+(?:\s*\+\s*Rule\s+\d+)*)\s*$/i;

export function splitRule(violationRule: string): RuleParts {
  const text = violationRule.trim();
  const match = RULE_SUFFIX.exec(text);
  return match ? { statute: match[1]!, rule: match[2]! } : { statute: text, rule: null };
}

export interface SteeringParts {
  /** The first alternative: what to show in the table. */
  lead: string | null;
  /** The others, shown in the detail row. */
  more: string[];
}

export function splitSteering(steeringDirective: string | null): SteeringParts {
  const parts = (steeringDirective ?? "")
    .split(/\s\|\s/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return { lead: parts[0] ?? null, more: parts.slice(1) };
}

/** The first few changed field names for the row, and how many more there are. */
export function changedFieldLabels(changedPaths: readonly string[], max = 3): { shown: string[]; hidden: number } {
  const labels = [...new Set(changedPaths.map(pathLabel))];
  return { shown: labels.slice(0, max), hidden: Math.max(0, labels.length - max) };
}

/** Anchor ids. A lesson is drawn twice (a table row and a small-screen card), so each form has its own. */
export const rowAnchor = (lessonId: string) => `lesson-${lessonId}`;
export const cardAnchor = (lessonId: string) => `lesson-card-${lessonId}`;

/** The lesson id named by a `#lesson-<id>` or `#lesson-card-<id>` fragment, or null. */
export function lessonIdFromHash(hash: string): string | null {
  const match = /^#lesson-(?:card-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(hash);
  return match ? match[1]!.toLowerCase() : null;
}

/** A tool name cut after each separator, so a long one wraps between words and not in the middle of one. */
export function toolSegments(tool: string): string[] {
  return tool.match(/[^_.:/-]+[_.:/-]*|[_.:/-]+/g) ?? [tool];
}
