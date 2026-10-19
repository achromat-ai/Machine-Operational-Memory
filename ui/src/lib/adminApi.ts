/**
 * Review queue calls: GET /api/v1/admin/pending and POST /api/v1/admin/review. Parsing, request bodies and
 * the wording of every failure live here, away from the components, so they are tested against the real
 * Worker. Everything in a queue item is untrusted community text: it is only ever shown as plain text.
 */
import { decodeBase64url } from "./base64url";
import type { JsonObject } from "./delta";
import { bytesToHex } from "./sha256";

/** Reject reasons accepted by the review endpoint (ReviewReasonCode in src/schema.ts). */
export const REVIEW_REASONS = [
  { code: "pii_or_secret", label: "Contains personal data or a secret" },
  { code: "degenerate_delta", label: "The fix changes nothing meaningful" },
  { code: "incorrect_fix", label: "The fix is wrong" },
  { code: "duplicate", label: "Duplicate of an existing lesson" },
  { code: "out_of_scope", label: "Out of scope" },
  { code: "policy_conflict", label: "Conflicts with policy" },
  { code: "low_quality", label: "Low quality" },
  { code: "adversarial", label: "Looks adversarial" },
] as const;

export type ReviewReasonCode = (typeof REVIEW_REASONS)[number]["code"];
export type ReviewDecision = "approve" | "reject";
export type QueueStatus = "pending_review" | "quarantined";

export const REASONING_MAX_CHARACTERS = 1000;

export interface TriageCheckView {
  check: string;
  passed: boolean;
  score: number | null;
  details: unknown;
}

export interface PendingLesson {
  lessonId: string;
  reviewStatus: string;
  domain: string;
  tool: string;
  provenance: string;
  taskDescription: string;
  violationRule: string;
  steeringDirective: string | null;
  statutoryAnchor: string | null;
  trapArguments: JsonObject;
  fixArguments: JsonObject;
  changedPaths: string[];
  triage: TriageCheckView[];
  submitterKey: string;
  submitterApproved: number;
  submitterRejected: number;
  fixedByKey: string | null;
  corroborations: number;
  createdAt: string;
}

export interface PendingPage {
  status: QueueStatus;
  lessons: PendingLesson[];
  nextCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLesson(raw: unknown): PendingLesson | null {
  if (!isRecord(raw) || !isRecord(raw.submitter)) return null;
  const submitter = raw.submitter;
  const steering = raw.steering_directive === null || typeof raw.steering_directive === "string" ? raw.steering_directive : undefined;
  const anchor = raw.statutory_anchor === null || typeof raw.statutory_anchor === "string" ? raw.statutory_anchor : undefined;
  if (
    typeof raw.lesson_id !== "string" ||
    typeof raw.review_status !== "string" ||
    typeof raw.domain !== "string" ||
    typeof raw.tool !== "string" ||
    typeof raw.provenance !== "string" ||
    typeof raw.task_description !== "string" ||
    typeof raw.violation_rule !== "string" ||
    steering === undefined ||
    anchor === undefined ||
    !isRecord(raw.trap_arguments) ||
    !isRecord(raw.fix_arguments) ||
    !Array.isArray(raw.changed_paths) ||
    !raw.changed_paths.every((path) => typeof path === "string") ||
    !Array.isArray(raw.triage) ||
    typeof submitter.agent_key !== "string" ||
    typeof submitter.approved_count !== "number" ||
    typeof submitter.rejected_count !== "number" ||
    typeof raw.created_at !== "string"
  ) {
    return null;
  }
  const triage: TriageCheckView[] = [];
  for (const check of raw.triage) {
    if (!isRecord(check) || typeof check.check !== "string" || typeof check.passed !== "boolean") return null;
    triage.push({ check: check.check, passed: check.passed, score: typeof check.score === "number" ? check.score : null, details: check.details });
  }
  return {
    lessonId: raw.lesson_id,
    reviewStatus: raw.review_status,
    domain: raw.domain,
    tool: raw.tool,
    provenance: raw.provenance,
    taskDescription: raw.task_description,
    violationRule: raw.violation_rule,
    steeringDirective: steering,
    statutoryAnchor: anchor,
    trapArguments: raw.trap_arguments,
    fixArguments: raw.fix_arguments,
    changedPaths: raw.changed_paths as string[],
    triage,
    submitterKey: submitter.agent_key,
    submitterApproved: submitter.approved_count,
    submitterRejected: submitter.rejected_count,
    fixedByKey: typeof raw.fixed_by_key === "string" ? raw.fixed_by_key : null,
    corroborations: typeof raw.corroborations === "number" ? raw.corroborations : 0,
    createdAt: raw.created_at,
  };
}

/** Reads a GET /api/v1/admin/pending body. Null if it is not the documented shape. */
export function parsePendingPage(body: unknown): PendingPage | null {
  if (!isRecord(body) || body.success !== true || !Array.isArray(body.lessons)) return null;
  if (body.status !== "pending_review" && body.status !== "quarantined") return null;
  if (body.next_cursor !== null && typeof body.next_cursor !== "string") return null;
  const lessons: PendingLesson[] = [];
  for (const raw of body.lessons) {
    const lesson = parseLesson(raw);
    if (lesson === null) return null;
    lessons.push(lesson);
  }
  return { status: body.status, lessons, nextCursor: body.next_cursor as string | null };
}

export interface PendingQuery {
  status?: QueueStatus;
  limit?: number;
  cursor?: string | null;
}

export function pendingPath(query: PendingQuery = {}): string {
  const params = new URLSearchParams();
  params.set("status", query.status ?? "pending_review");
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  return `/api/v1/admin/pending?${params.toString()}`;
}

export class AdminApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Array<{ path: string; message: string }>;

  constructor(code: string, status: number, message: string, details: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = "AdminApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type AdminFetcher = (path: string, options?: RequestInit) => Promise<Response>;

async function failure(response: Response): Promise<AdminApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = isRecord(body) ? body : {};
  const details = Array.isArray(record.details)
    ? record.details.flatMap((d) => (isRecord(d) && typeof d.path === "string" && typeof d.message === "string" ? [{ path: d.path, message: d.message }] : []))
    : [];
  return new AdminApiError(
    typeof record.code === "string" ? record.code : "HTTP_ERROR",
    response.status,
    typeof record.error === "string" ? record.error : `Request failed (${response.status})`,
    details,
  );
}

export async function fetchPending(fetcher: AdminFetcher, query: PendingQuery = {}): Promise<PendingPage> {
  const response = await fetcher(pendingPath(query), { method: "GET" });
  if (response.status !== 200) throw await failure(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const page = parsePendingPage(body);
  if (page === null) throw new AdminApiError("UNEXPECTED_RESPONSE", 200, "The queue came back in an unexpected shape.");
  return page;
}

export interface ReviewInput {
  lessonId: string;
  decision: ReviewDecision;
  reasonCode?: ReviewReasonCode;
  reasoning?: string;
}

/** The request body for POST /api/v1/admin/review. Throws RangeError for an invalid decision. */
export function buildReviewPayload(input: ReviewInput): Record<string, string> {
  const reasoning = input.reasoning?.trim();
  if (reasoning !== undefined && reasoning.length > REASONING_MAX_CHARACTERS) {
    throw new RangeError(`The note must be at most ${REASONING_MAX_CHARACTERS} characters.`);
  }
  const base: Record<string, string> = { lesson_id: input.lessonId, decision: input.decision };
  if (input.decision === "reject") {
    if (!REVIEW_REASONS.some((reason) => reason.code === input.reasonCode)) throw new RangeError("Choose a reason for rejecting.");
    base.reason_code = input.reasonCode!;
  } else if (input.reasonCode !== undefined) {
    throw new RangeError("An approval has no reason code.");
  }
  if (reasoning) base.reasoning = reasoning;
  return base;
}

export interface ReviewResult {
  lessonId: string;
  decision: ReviewDecision;
  reviewStatus: string;
}

export async function submitReview(fetcher: AdminFetcher, input: ReviewInput): Promise<ReviewResult> {
  const response = await fetcher("/api/v1/admin/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildReviewPayload(input)),
  });
  if (response.status !== 200) throw await failure(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!isRecord(body) || body.success !== true || typeof body.review_status !== "string") {
    throw new AdminApiError("UNEXPECTED_RESPONSE", 200, "The service sent an unexpected answer.");
  }
  return { lessonId: input.lessonId, decision: input.decision, reviewStatus: body.review_status };
}

export interface ReviewFailureView {
  code: string;
  message: string;
  /** The lesson is gone or already decided: drop it from the queue. */
  stale: boolean;
  /** The key was refused: the console must lock. */
  locked: boolean;
}

/** What to show for a failed review or queue load. Calm wording, and no internals. */
export function describeReviewFailure(error: unknown): ReviewFailureView {
  if (error instanceof RangeError) return { code: "INVALID_INPUT", message: error.message, stale: false, locked: false };
  if (error instanceof AdminApiError) {
    switch (error.code) {
      case "SELF_REVIEW_FORBIDDEN":
        return { code: error.code, message: "You submitted or fixed this lesson, so a different reviewer has to decide it.", stale: false, locked: false };
      case "LESSON_NOT_REVIEWABLE":
        return { code: error.code, message: "This lesson was already decided, so it has been removed from your queue.", stale: true, locked: false };
      case "LESSON_NOT_FOUND":
        return { code: error.code, message: "This lesson no longer exists, so it has been removed from your queue.", stale: true, locked: false };
      case "RATE_LIMITED":
        return { code: error.code, message: "Too many requests. Wait a moment and try again.", stale: false, locked: false };
      case "INVALID_REQUEST":
        return {
          code: error.code,
          message: error.details.length > 0 ? error.details.map((d) => d.message).join(" ") : "The service did not accept that decision.",
          stale: false,
          locked: false,
        };
      case "AGENT_KEY_UNKNOWN":
      case "AGENT_KEY_INACTIVE":
      case "AGENT_ROLE_FORBIDDEN":
        return { code: error.code, message: "This key is no longer allowed to review, so the console has been locked.", stale: false, locked: true };
      case "AGENT_SIGNATURE_EXPIRED":
        return { code: error.code, message: "Your device clock is out of sync with the service. Correct it and try again.", stale: false, locked: false };
      default:
        return {
          code: error.code,
          message: error.status >= 500 ? "The service is temporarily unavailable. Try again later." : `That did not work (${error.code}).`,
          stale: false,
          locked: false,
        };
    }
  }
  if (error instanceof Error && error.name === "AdminLockedError") {
    return { code: "AGENT_LOCKED", message: "The console is locked. Enter the key again.", stale: false, locked: true };
  }
  return { code: "UNKNOWN", message: "Something went wrong. Try again.", stale: false, locked: false };
}

/** The server's agent key (64 hex characters) for a base64url public key. */
export function agentKeyHex(publicKeyB64u: string): string {
  return bytesToHex(decodeBase64url(publicKeyB64u));
}

/** True when the signed-in key submitted or fixed the lesson (the server refuses these with SELF_REVIEW_FORBIDDEN). */
export function isOwnLesson(lesson: Pick<PendingLesson, "submitterKey" | "fixedByKey" | "provenance">, myAgentKeyHex: string): boolean {
  if (lesson.provenance === "admin_seed") return false; // seeded lessons are exempt from the four-eyes rule
  return lesson.submitterKey === myAgentKeyHex || lesson.fixedByKey === myAgentKeyHex;
}
