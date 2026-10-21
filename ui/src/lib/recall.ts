/**
 * The public search: form validation, the POST /api/v1/recall call, response parsing, error messages and
 * the state machine behind the results list. No DOM, so it runs in the test suite against the real Worker.
 *
 * Recall is a structured lookup, not free-text search: the server needs a domain, an exact tool name, a
 * task description (matched exactly, then semantically) and the arguments the caller intends to send
 * (only their key names take part in matching). The form mirrors the server's rules (SKILL.md
 * section 4) so most mistakes are caught before a request is made.
 */
import { IdentityError, KeystoreError, UnsupportedBrowserError } from "./identity";
import type { JsonObject } from "./delta";

export const DOMAINS = ["fintech", "industrial_iot", "robotics", "devsecops"] as const;
export type Domain = (typeof DOMAINS)[number];

export const TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;
export const TASK_MIN_CHARACTERS = 16;
export const TASK_MIN_WORDS = 3;
export const TASK_MAX_CHARACTERS = 1000;
export const ARGUMENTS_MAX_BYTES = 16 * 1024;
export const ARGUMENTS_MAX_KEYS = 256;
export const ARGUMENTS_MAX_DEPTH = 8;

export interface SearchFormValues {
  domain: string;
  tool: string;
  taskDescription: string;
  argumentsJson: string;
}

export type FieldName = "domain" | "tool" | "taskDescription" | "arguments";
export type FieldErrors = Partial<Record<FieldName, string>>;

export interface RecallPayload {
  domain: Domain;
  tool: string;
  task_description: string;
  arguments: JsonObject;
}

/** NFC, every whitespace run collapsed to one space, trimmed: the form the server fingerprints. */
export function normaliseTaskDescription(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maxDepth(root: unknown): number {
  let deepest = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 1 }];
  let visited = 0;
  while (stack.length > 0 && visited++ < 20_000) {
    const { node, depth } = stack.pop()!;
    if (Array.isArray(node)) {
      deepest = Math.max(deepest, depth);
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
    } else if (isPlainObject(node)) {
      deepest = Math.max(deepest, depth);
      for (const child of Object.values(node)) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return deepest;
}

/** Validates the form like the server does and builds the request body. */
export function validateSearchForm(values: SearchFormValues): { ok: true; payload: RecallPayload } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};

  const domain = values.domain.trim();
  if (!(DOMAINS as readonly string[]).includes(domain)) errors.domain = "Choose one of the listed domains.";

  const tool = values.tool.trim();
  if (tool === "") errors.tool = "Enter the name of the tool.";
  else if (!TOOL_PATTERN.test(tool)) errors.tool = "Use 1 to 64 characters: letters, digits and _ . : / - , starting with a letter or digit.";

  const task = normaliseTaskDescription(values.taskDescription);
  if ([...task].length < TASK_MIN_CHARACTERS) errors.taskDescription = `Describe the task in at least ${TASK_MIN_CHARACTERS} characters.`;
  else if (task.split(" ").length < TASK_MIN_WORDS) errors.taskDescription = `Use at least ${TASK_MIN_WORDS} words.`;
  else if (task.length > TASK_MAX_CHARACTERS) errors.taskDescription = `Keep the description under ${TASK_MAX_CHARACTERS} characters.`;
  // eslint-disable-next-line no-control-regex
  else if (/[\u0000-\u001F\u007F-\u009F]/u.test(task)) errors.taskDescription = "Remove control characters from the description.";

  let args: JsonObject | undefined;
  if (values.argumentsJson.trim() === "") {
    errors.arguments = "Enter the arguments of the call as a JSON object.";
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(values.argumentsJson);
    } catch {
      errors.arguments = "This is not valid JSON.";
    }
    if (errors.arguments === undefined) {
      if (!isPlainObject(parsed)) errors.arguments = "The arguments must be a JSON object, like {\"amount\": 100}.";
      else if (Object.keys(parsed).length === 0) errors.arguments = "Add at least one argument.";
      else if (Object.keys(parsed).length > ARGUMENTS_MAX_KEYS) errors.arguments = `Use at most ${ARGUMENTS_MAX_KEYS} top-level keys.`;
      else if (maxDepth(parsed) > ARGUMENTS_MAX_DEPTH) errors.arguments = `Nest arguments at most ${ARGUMENTS_MAX_DEPTH} levels deep.`;
      else if (new TextEncoder().encode(JSON.stringify(parsed)).length > ARGUMENTS_MAX_BYTES) errors.arguments = "The arguments are over 16 KiB.";
      else args = parsed;
    }
  }

  if (Object.keys(errors).length > 0 || args === undefined) return { ok: false, errors };
  return { ok: true, payload: { domain: domain as Domain, tool, task_description: task, arguments: args } };
}

// ════════════════════════════════════════════════════════════════════════
// Response
// ════════════════════════════════════════════════════════════════════════

export interface RecallLessonView {
  lessonId: string;
  reviewStatus: "approved" | "pending";
  domain: string;
  tool: string;
  violationRule: string;
  steeringDirective: string | null;
  statutoryAnchor: string | null;
  compliantArguments: JsonObject;
  changedPaths: string[];
}

export type RecallOutcome =
  | { kind: "match"; tier: "exact" | "semantic"; score: number; lesson: RecallLessonView }
  | { kind: "miss"; budgetExhausted: boolean };

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** Reads a 200 body. Returns null if it is not the documented shape. Receipt and attestation fields are ignored. */
export function parseRecallResponse(body: unknown): RecallOutcome | null {
  if (!isPlainObject(body) || body.success !== true) return null;
  if (body.match === false) return { kind: "miss", budgetExhausted: body.budget_exhausted === true };
  if (body.match !== true || (body.tier !== "exact" && body.tier !== "semantic") || typeof body.score !== "number") return null;

  const lesson = body.lesson;
  if (!isPlainObject(lesson)) return null;
  const steering = nullableString(lesson.steering_directive);
  const anchor = nullableString(lesson.statutory_anchor);
  if (
    typeof lesson.lesson_id !== "string" ||
    (lesson.review_status !== "approved" && lesson.review_status !== "pending") ||
    typeof lesson.domain !== "string" ||
    typeof lesson.tool !== "string" ||
    typeof lesson.violation_rule !== "string" ||
    steering === undefined ||
    anchor === undefined ||
    !isPlainObject(lesson.compliant_arguments) ||
    !Array.isArray(lesson.changed_paths) ||
    !lesson.changed_paths.every((path) => typeof path === "string")
  ) {
    return null;
  }
  return {
    kind: "match",
    tier: body.tier,
    score: body.score,
    lesson: {
      lessonId: lesson.lesson_id,
      reviewStatus: lesson.review_status,
      domain: lesson.domain,
      tool: lesson.tool,
      violationRule: lesson.violation_rule,
      steeringDirective: steering,
      statutoryAnchor: anchor,
      compliantArguments: lesson.compliant_arguments,
      changedPaths: lesson.changed_paths as string[],
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// Request and errors
// ════════════════════════════════════════════════════════════════════════

export class RecallError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Array<{ path: string; message: string }>;

  constructor(code: string, status: number, message: string, details: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = "RecallError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type SignedFetcher = (path: string, options?: RequestInit) => Promise<Response>;

/** POST /api/v1/recall with a signed request. Throws RecallError for any non-success answer. */
export async function runRecall(fetcher: SignedFetcher, payload: RecallPayload): Promise<RecallOutcome> {
  const response = await fetcher("/api/v1/recall", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.status === 200) {
    const outcome = parseRecallResponse(body);
    if (outcome === null) throw new RecallError("UNEXPECTED_RESPONSE", 200, "The service sent an unexpected answer.");
    return outcome;
  }

  const record = isPlainObject(body) ? body : {};
  const code = typeof record.code === "string" ? record.code : "HTTP_ERROR";
  const details = Array.isArray(record.details)
    ? record.details.flatMap((detail) =>
        isPlainObject(detail) && typeof detail.path === "string" && typeof detail.message === "string" ? [{ path: detail.path, message: detail.message }] : [],
      )
    : [];
  throw new RecallError(code, response.status, typeof record.error === "string" ? record.error : `Request failed (${response.status})`, details);
}

const SERVER_FIELD: Readonly<Record<string, FieldName>> = {
  domain: "domain",
  tool: "tool",
  task_description: "taskDescription",
  arguments: "arguments",
};

export interface FailureView {
  message: string;
  fieldErrors?: FieldErrors;
}

/** What to tell the user about a failed search. Never includes keys, signatures or stack traces. */
export function describeRecallFailure(error: unknown): FailureView {
  if (error instanceof RecallError) {
    switch (error.code) {
      case "INVALID_REQUEST": {
        const fieldErrors: FieldErrors = {};
        for (const detail of error.details) {
          const field = SERVER_FIELD[detail.path];
          if (field && fieldErrors[field] === undefined) fieldErrors[field] = detail.message;
        }
        return { message: "The service did not accept the search. Check the highlighted fields.", fieldErrors };
      }
      case "DOMAIN_UNKNOWN":
        return { message: "That domain is not served.", fieldErrors: { domain: "Choose one of the listed domains." } };
      case "RATE_LIMITED":
        return { message: "You have searched too often. Wait a little while and try again." };
      case "SEARCH_UNAVAILABLE":
        return { message: "Search is temporarily unavailable. Try again shortly." };
      case "UNEXPECTED_RESPONSE":
        return { message: "The service sent an answer this page cannot read. Try again." };
      case "AGENT_SIGNATURE_EXPIRED":
        return { message: "Your device clock is out of sync with the service. Correct it and try again." };
      case "AGENT_KEY_UNKNOWN":
      case "AGENT_KEY_INACTIVE":
      case "AGENT_NONCE_REPLAYED":
      case "AGENT_SIGNATURE_INVALID":
      case "AGENT_SIGNATURE_REQUIRED":
        return { message: "Your session could not be verified. Reload the page and try again." };
      default:
        return error.status >= 500
          ? { message: "The service is temporarily unavailable. Try again later." }
          : { message: `The search failed (${error.code}).` };
    }
  }
  if (error instanceof IdentityError || error instanceof UnsupportedBrowserError || error instanceof KeystoreError) {
    return { message: error.message };
  }
  return { message: "Something went wrong. Try again." };
}

// ════════════════════════════════════════════════════════════════════════
// Results state
// ════════════════════════════════════════════════════════════════════════

export interface RecallEntry {
  id: number;
  query: RecallPayload;
  outcome: RecallOutcome;
}

export interface RecallState {
  phase: "idle" | "loading" | "error";
  error: FailureView | null;
  entries: RecallEntry[];
  nextId: number;
}

export type RecallAction =
  | { type: "start" }
  | { type: "success"; query: RecallPayload; outcome: RecallOutcome }
  | { type: "failure"; failure: FailureView }
  | { type: "clear" };

export const MAX_HISTORY = 20;

export const initialRecallState: RecallState = { phase: "idle", error: null, entries: [], nextId: 1 };

export function recallReducer(state: RecallState, action: RecallAction): RecallState {
  switch (action.type) {
    case "start":
      return { ...state, phase: "loading", error: null };
    case "success":
      return {
        phase: "idle",
        error: null,
        entries: [{ id: state.nextId, query: action.query, outcome: action.outcome }, ...state.entries].slice(0, MAX_HISTORY),
        nextId: state.nextId + 1,
      };
    case "failure":
      return { ...state, phase: "error", error: action.failure };
    case "clear":
      return initialRecallState;
  }
}
