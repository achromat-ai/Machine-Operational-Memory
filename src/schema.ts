/**
 * Zod API contracts for achromat-mom.
 *
 * Every limit here mirrors a CHECK in migrations/0001_event_ledger.sql, so a
 * payload that passes these schemas also passes the database. Request bodies are
 * strict objects: unknown keys are rejected, never stripped.
 *
 * Order of operations for a signed route: read the raw body once, parse
 * the signature headers, verify the Ed25519 proof of possession over the raw
 * bytes, and only then JSON.parse and apply a body schema. Unauthenticated
 * callers never reach the JSON parser.
 */
import { z } from "zod";

// ════════════════════════════════════════════════════════════════════════
// Limits
// ════════════════════════════════════════════════════════════════════════

export const LIMITS = {
  /** Vectorize string metadata indexes cover only the first 64 bytes (V1). */
  toolNameMax: 64,
  domainMax: 64,
  /** bge-base-en-v1.5 accepts 512 input tokens (V7). */
  taskDescriptionMax: 1000,
  taskDescriptionMin: 16,
  taskDescriptionMinWords: 3,
  /** Raw cap applied before normalisation, so whitespace padding cannot cost CPU. */
  taskDescriptionRawMax: 4000,
  argumentKeysMin: 1,
  argumentKeysMax: 256,
  argumentKeyLengthMax: 128,
  argumentDepthMax: 8,
  argumentBytesMax: 16 * 1024,
  /** Upper bound on nodes visited while inspecting arguments. */
  argumentNodesMax: 20_000,
  /** Allowed drift between Achromat-Timestamp and the Worker clock. */
  clockSkewSeconds: 60,
  maxReportedIssues: 10,
} as const;

// ════════════════════════════════════════════════════════════════════════
// Byte helpers (Workers and Node both provide atob/btoa and Web Crypto)
// ════════════════════════════════════════════════════════════════════════

const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Decodes unpadded base64url. Callers validate the alphabet first. */
export function decodeBase64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** Decodes an even-length hex string. Callers pass trusted constants or validated digests. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Deterministic compact JSON: object keys sorted (UTF-16 order) at every level,
 * arrays kept in order. Used for the evaluated input MOM sends upstream, for
 * argument equality and for delta hashes. Callers pass values already bounded
 * by ToolArguments (depth ≤ 8), so the recursion is shallow.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

// ════════════════════════════════════════════════════════════════════════
// Content scanners
// ════════════════════════════════════════════════════════════════════════

/** C0 and C1 control characters, except tab, LF and CR (allowed inside argument strings). */
const CONTROL_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
/** Any C0 or C1 control character. */
const CONTROL_ANY = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * Credential shapes that must never enter the ledger or an embedding.
 * The first seven are ported unchanged from ramen-forge src/validation.ts.
 * Labels name the credential type only, never the matched text.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  // ramen-forge
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key id", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["API secret key", /\bsk-(live|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}\b/],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["bearer credential", /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  // achromat-mom additions
  ["PGP private key block", /-----BEGIN PGP PRIVATE KEY BLOCK-----/],
  ["Stripe secret key", /\b[rs]k_live_[A-Za-z0-9]{16,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
];

/** Returns the label of the first credential shape found in `value`, or null. */
export function findSecret(value: string): string | null {
  for (const [label, pattern] of SECRET_PATTERNS) if (pattern.test(value)) return label;
  return null;
}

export function containsSecret(value: string): boolean {
  return findSecret(value) !== null;
}

// ════════════════════════════════════════════════════════════════════════
// Primitives
// ════════════════════════════════════════════════════════════════════════

/** Domain slug. Also the Vectorize namespace (≤ 64 bytes). Routes refine it against the configured domain map. */
export const DomainSlug = z
  .string()
  .max(LIMITS.domainMax, "domain must be at most 64 characters")
  .regex(/^[a-z0-9][a-z0-9_-]{1,63}$/, "domain must be a lowercase slug of 2-64 characters");

/** Tool name: 1-64 ASCII characters, matching the Vectorize tool_name metadata index. */
export const ToolName = z
  .string()
  .max(LIMITS.toolNameMax, "tool must be at most 64 characters")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/,
    "tool must start with a letter or digit and use only A-Z a-z 0-9 _ . : / -",
  );

/** NFC, collapse every whitespace run to one space, trim. The fingerprint is taken over this form. */
export function normaliseTaskDescription(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** SHA-256 hex of the normalised task description: the pairing key shared by Turn 1 and Turn 2. */
export function taskFingerprint(normalisedTaskDescription: string): Promise<string> {
  return sha256Hex(normalisedTaskDescription);
}

/**
 * Required task description. Output is the normalised text.
 * The 1,000 limit counts UTF-16 code units, which is never fewer than the code
 * points SQLite counts, so the database CHECK always agrees.
 */
export const TaskDescription = z
  .string()
  .max(LIMITS.taskDescriptionRawMax, "task_description is too long")
  .transform(normaliseTaskDescription)
  .pipe(
    z
      .string()
      .max(LIMITS.taskDescriptionMax, "task_description must be at most 1000 characters")
      .refine(
        (value) => [...value].length >= LIMITS.taskDescriptionMin,
        "task_description must be at least 16 characters",
      )
      .refine(
        (value) => value.split(" ").length >= LIMITS.taskDescriptionMinWords,
        "task_description must contain at least 3 words",
      )
      .refine((value) => !CONTROL_ANY.test(value), "task_description must not contain control characters")
      .superRefine((value, ctx) => {
        const secret = findSecret(value);
        if (secret) ctx.addIssue({ code: "custom", message: `task_description appears to contain a credential (${secret})` });
      }),
  );

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Iterative structural checks, run before any recursive parsing so hostile
 * nesting cannot exhaust the stack. Returns human-readable problems that never
 * quote the input.
 */
function inspectArguments(value: unknown): string[] {
  if (!isPlainObject(value)) return ["arguments must be a JSON object"];
  const topLevelKeys = Object.keys(value).length;
  if (topLevelKeys < LIMITS.argumentKeysMin || topLevelKeys > LIMITS.argumentKeysMax) {
    return ["arguments must have between 1 and 256 top-level keys"];
  }

  const problems = new Set<string>();
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];
  let visited = 0;

  while (stack.length > 0 && problems.size < LIMITS.maxReportedIssues) {
    const { node, depth } = stack.pop()!;
    if (++visited > LIMITS.argumentNodesMax) {
      problems.add("arguments contain too many values");
      break;
    }
    if (typeof node === "string") {
      if (CONTROL_EXCEPT_WHITESPACE.test(node)) problems.add("arguments must not contain control characters");
      const secret = findSecret(node);
      if (secret) problems.add(`arguments appear to contain a credential (${secret})`);
    } else if (typeof node === "number") {
      if (!Number.isFinite(node)) problems.add("arguments must not contain non-finite numbers");
    } else if (typeof node === "boolean" || node === null) {
      // valid JSON scalar
    } else if (Array.isArray(node) || isPlainObject(node)) {
      if (depth > LIMITS.argumentDepthMax) {
        problems.add("arguments must not nest deeper than 8 levels");
        continue;
      }
      if (Array.isArray(node)) {
        for (const child of node) stack.push({ node: child, depth: depth + 1 });
      } else {
        for (const [key, child] of Object.entries(node)) {
          // JSON.parse keeps "__proto__" as an own key, and copying it would set a prototype.
          if (key === "__proto__") problems.add("arguments must not use the key __proto__");
          if (key.length > LIMITS.argumentKeyLengthMax) problems.add("argument keys must be at most 128 characters");
          if (CONTROL_ANY.test(key)) problems.add("argument keys must not contain control characters");
          const secret = findSecret(key);
          if (secret) problems.add(`argument keys appear to contain a credential (${secret})`);
          stack.push({ node: child, depth: depth + 1 });
        }
      }
    } else {
      problems.add("arguments must contain only JSON values");
    }
  }

  if (problems.size === 0 && utf8Length(JSON.stringify(value)) > LIMITS.argumentBytesMax) {
    problems.add("arguments must serialise to at most 16 KiB");
  }
  return [...problems];
}

/**
 * Tool-call arguments: a non-empty JSON object, ≤ 8 levels deep, ≤ 16 KiB, free
 * of control characters and credentials (keys and values are both scanned).
 * This is the `arguments` field of TrapSubmission (stored as trap_arguments,
 * ramen-forge failed_arguments) and FixSubmission (stored as fix_arguments,
 * ramen-forge compliant_arguments).
 */
export const ToolArguments = z
  .unknown()
  .superRefine((value, ctx) => {
    for (const message of inspectArguments(value)) ctx.addIssue({ code: "custom", message });
  })
  .pipe(z.record(z.string().max(LIMITS.argumentKeyLengthMax), z.json()));

/** Unpadded, canonically encoded base64url of exactly `byteLength` bytes. */
export function base64urlBytes(byteLength: number, label: string) {
  const length = Math.ceil((byteLength * 4) / 3);
  return z
    .string()
    .length(length, `${label} must be ${length} base64url characters (${byteLength} bytes)`)
    .regex(/^[A-Za-z0-9_-]+$/, `${label} must be unpadded base64url`)
    .refine((value) => {
      // Zod runs every check even after .length() failed, and atob() throws on an impossible length.
      try {
        return encodeBase64url(decodeBase64url(value)) === value;
      } catch {
        return false;
      }
    }, `${label} must be canonical base64url`);
}

/** UUID v4 generated by MOM (trap_id, lesson_id, …). Lowercase, as stored in D1. */
export const MomUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "must be a lowercase UUID v4");

/** Upstream ramen receipt id: any 8-4-4-4-12 hex GUID, either case (mirrors the D1 CHECK). */
export const ReceiptId = z.guid();

/** Lowercase SHA-256 hex digest. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 hex digest");

// ════════════════════════════════════════════════════════════════════════
// Signed-request contract (Ed25519 proof of possession)
// ════════════════════════════════════════════════════════════════════════

export const SIGNATURE_HEADER_NAMES = [
  "achromat-agent-key",
  "achromat-timestamp",
  "achromat-nonce",
  "achromat-signature",
] as const;

/** Domain-separation prefix for request signatures. */
export const REQUEST_SIGNING_CONTEXT = "achromat-mom-v1";

/**
 * The four signature headers, validated as a strict object.
 * Output keeps the raw strings that were signed and adds the decoded forms the
 * route needs (hex agent key for D1, integer timestamp for the skew check).
 */
export const SignedRequestHeaders = z
  .strictObject({
    "achromat-agent-key": base64urlBytes(32, "Achromat-Agent-Key"),
    "achromat-timestamp": z.string().regex(/^\d{10}$/, "Achromat-Timestamp must be 10-digit Unix seconds"),
    "achromat-nonce": base64urlBytes(16, "Achromat-Nonce"),
    "achromat-signature": base64urlBytes(64, "Achromat-Signature"),
  })
  .transform((headers) => ({
    agentKey: headers["achromat-agent-key"],
    agentKeyHex: toHex(decodeBase64url(headers["achromat-agent-key"])),
    timestamp: headers["achromat-timestamp"],
    timestampSeconds: Number(headers["achromat-timestamp"]),
    nonce: headers["achromat-nonce"],
    signature: headers["achromat-signature"],
  }));

export type SignedRequestHeaders = z.output<typeof SignedRequestHeaders>;

export type SignatureHeaderResult =
  | { ok: true; value: SignedRequestHeaders }
  | { ok: false; code: "AGENT_SIGNATURE_REQUIRED" | "AGENT_SIGNATURE_INVALID"; failure: ValidationFailure };

/**
 * Picks the four signature headers off a request and validates them.
 * Any missing header is AGENT_SIGNATURE_REQUIRED, a malformed one is
 * AGENT_SIGNATURE_INVALID. Both map to HTTP 401.
 */
export function readSignatureHeaders(headers: Headers): SignatureHeaderResult {
  const picked: Record<string, string> = {};
  let missing = false;
  for (const name of SIGNATURE_HEADER_NAMES) {
    const value = headers.get(name);
    if (value === null) missing = true;
    else picked[name] = value;
  }
  const parsed = SignedRequestHeaders.safeParse(picked);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    code: missing ? "AGENT_SIGNATURE_REQUIRED" : "AGENT_SIGNATURE_INVALID",
    failure: toValidationFailure(parsed.error),
  };
}

export function timestampWithinSkew(timestampSeconds: number, nowMs: number = Date.now()): boolean {
  return Math.abs(nowMs / 1000 - timestampSeconds) <= LIMITS.clockSkewSeconds;
}

export interface SigningInput {
  /** Request host, lowercased by this function. Binds the signature to one environment. */
  host: string;
  /** HTTP method, uppercased by this function. */
  method: string;
  /** Path plus query string exactly as sent (`/api/v1/recall?x=1`). */
  pathAndQuery: string;
  /** sha256Hex of the raw request body bytes (empty body hashes the empty string). */
  bodySha256Hex: string;
  /** Raw Achromat-Timestamp header value. */
  timestamp: string;
  /** Raw Achromat-Nonce header value. */
  nonce: string;
}

/** `achromat-mom-v1\n{HOST}\n{METHOD}\n{PATH+QUERY}\n{sha256hex(body)}\n{ts}\n{nonce}` */
export function requestSigningString(input: SigningInput): string {
  return [
    REQUEST_SIGNING_CONTEXT,
    input.host.toLowerCase(),
    input.method.toUpperCase(),
    input.pathAndQuery,
    input.bodySha256Hex,
    input.timestamp,
    input.nonce,
  ].join("\n");
}

/** Ed25519 verification over a UTF-8 message, with base64url key and signature. Never throws. */
export async function verifyEd25519(publicKey: string, signature: string, message: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", decodeBase64url(publicKey), { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, decodeBase64url(signature), encoder.encode(message));
  } catch {
    // Invalid point encodings make importKey throw. Treat them as a failed proof.
    return false;
  }
}

/**
 * Ed25519 proof of possession: true only if the caller holds the private key
 * for Achromat-Agent-Key and signed exactly this request. Run the agent status,
 * skew and nonce-replay checks alongside it.
 */
export function verifyProofOfPossession(headers: SignedRequestHeaders, signingString: string): Promise<boolean> {
  return verifyEd25519(headers.agentKey, headers.signature, signingString);
}

// ════════════════════════════════════════════════════════════════════════
// Agent registration: Hashcash PoW plus proof of possession
// ════════════════════════════════════════════════════════════════════════

export const POW_ALGORITHM = "sha256-hashcash-v1";

/** Domain-separation prefix for the registration proof of possession. */
export const REGISTRATION_SIGNING_CONTEXT = "achromat-register-v1";

/** `achromat-register-v1\n{challenge}\n{public_key}`, signed with the key being registered. */
export function registrationSigningString(challenge: string, publicKey: string): string {
  return `${REGISTRATION_SIGNING_CONTEXT}\n${challenge}\n${publicKey}`;
}

/** Hashcash preimage: the UTF-8 bytes of challenge + public_key + nonce, concatenated with no separator. */
export function powPreimage(challenge: string, publicKey: string, nonce: string): string {
  return challenge + publicKey + nonce;
}

/** Number of leading zero bits in a lowercase hex digest. */
export function leadingZeroBits(hexDigest: string): number {
  let bits = 0;
  for (const char of hexDigest) {
    const nibble = Number.parseInt(char, 16);
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    return bits + Math.clz32(nibble) - 28;
  }
  return bits;
}

/** Body of POST /api/v1/agents/register (unsigned: the body itself carries the proofs). */
export const AgentRegistration = z.strictObject({
  public_key: base64urlBytes(32, "public_key"),
  challenge_id: MomUuid,
  /** HMAC the Worker issued with the challenge (src/crypto/pow-challenge.ts). Verified before the PoW is evaluated. */
  challenge_signature: base64urlBytes(32, "challenge_signature"),
  nonce: z.string().regex(/^[0-9a-f]{1,32}$/, "nonce must be 1-32 lowercase hex characters"),
  proof_signature: base64urlBytes(64, "proof_signature"),
});
export type AgentRegistration = z.output<typeof AgentRegistration>;

// ════════════════════════════════════════════════════════════════════════
// Request bodies (all strict: unknown keys are rejected)
// ════════════════════════════════════════════════════════════════════════

const taskFields = {
  domain: DomainSlug,
  tool: ToolName,
  arguments: ToolArguments,
  task_description: TaskDescription,
};

/**
 * Turn 1 body for POST /api/v1/calibrate: a tool call the agent expects may be
 * blocked. A BLOCK verdict opens (or joins) a 24-hour trap.
 */
export const TrapSubmission = z.strictObject(taskFields);
export type TrapSubmission = z.output<typeof TrapSubmission>;

/**
 * Turn 2 body for POST /api/v1/calibrate: the corrected call, carrying the
 * trap_id handle returned by Turn 1. An ALLOW verdict pairs it with that trap.
 */
export const FixSubmission = z.strictObject({ ...taskFields, trap_id: MomUuid });
export type FixSubmission = z.output<typeof FixSubmission>;

export type CalibrateRequest =
  | { kind: "trap"; body: TrapSubmission }
  | { kind: "fix"; body: FixSubmission };

/**
 * /calibrate accepts both shapes. The presence of `trap_id` selects the schema,
 * so errors stay specific instead of becoming a union mismatch. A Turn 2 call
 * that dropped its handle parses as a TrapSubmission and pairs through the
 * key-based fallback once the ALLOW verdict is known.
 */
export function parseCalibrateRequest(
  input: unknown,
): { success: true; data: CalibrateRequest } | { success: false; failure: ValidationFailure } {
  const isFix = isPlainObject(input) && Object.hasOwn(input, "trap_id");
  const parsed = (isFix ? FixSubmission : TrapSubmission).safeParse(input);
  if (!parsed.success) return { success: false, failure: toValidationFailure(parsed.error) };
  return {
    success: true,
    data: isFix
      ? { kind: "fix", body: parsed.data as FixSubmission }
      : { kind: "trap", body: parsed.data as TrapSubmission },
  };
}

/** Body for POST /api/v1/recall. */
export const QueryRequest = z.strictObject(taskFields);
export type QueryRequest = z.output<typeof QueryRequest>;

// ════════════════════════════════════════════════════════════════════════
// POST /api/v1/recall response (strict: a field added to a lesson fails here before it can leak)
// ════════════════════════════════════════════════════════════════════════

const RecallReceiptRef = z.strictObject({ id: z.string(), signature: z.string() });

/**
 * One recalled lesson. `changed_paths` lists WHERE the fix differs from the blocked call (JSON
 * Pointers). The values of the blocked call are never served, so there is no delta_json, no
 * trap_arguments and no evaluated_input here. The upstream rule name or number (lessons.violation_rule)
 * is not served either: it would fingerprint the upstream policy. The statutory anchor stands in for it.
 */
export const RecallLesson = z.strictObject({
  lesson_id: z.string(),
  review_status: z.enum(["approved", "pending"]),
  domain: z.string(),
  tool: z.string(),
  steering_directive: z.string().nullable(),
  statutory_anchor: z.string().nullable(),
  compliant_arguments: z.record(z.string(), z.json()),
  changed_paths: z.array(z.string()),
  block_receipt: RecallReceiptRef,
  allow_receipt: RecallReceiptRef,
  pair_attestation: z.string(),
  attestation_kid: z.string(),
});
export type RecallLesson = z.output<typeof RecallLesson>;

export const RecallResponse = z.union([
  z.strictObject({
    success: z.literal(true),
    match: z.literal(true),
    tier: z.enum(["exact", "semantic"]),
    score: z.number(),
    lesson: RecallLesson,
  }),
  z.strictObject({ success: z.literal(true), match: z.literal(false), budget_exhausted: z.boolean().optional() }),
]);
export type RecallResponse = z.output<typeof RecallResponse>;

// ════════════════════════════════════════════════════════════════════════
// GET /api/v1/feed response (public, unsigned; strict for the same reason as RecallLesson)
// ════════════════════════════════════════════════════════════════════════

/** The most lessons one feed response carries. There is no pagination. */
export const FEED_LIMIT = 20;

/**
 * One approved lesson in the public feed: the recall lesson without its receipts and attestation, plus the
 * editorial fields. Like RecallLesson it never carries the blocked call's values (no trap_arguments, no
 * delta_json, no evaluated_input) or who submitted it.
 */
export const FeedLesson = z.strictObject({
  lesson_id: z.string(),
  domain: z.string(),
  tool: z.string(),
  steering_directive: z.string().nullable(),
  statutory_anchor: z.string().nullable(),
  compliant_arguments: z.record(z.string(), z.json()),
  changed_paths: z.array(z.string()),
  display_title: z.string().nullable(),
  display_summary: z.string().nullable(),
  featured: z.boolean(),
  /** ISO 8601 time of the lesson's last state change (approval, editorial edit, audit), newest first. */
  updated_at: z.string(),
});
export type FeedLesson = z.output<typeof FeedLesson>;

// ════════════════════════════════════════════════════════════════════════
// GET /api/v1/search response (public, unsigned; each result is a FeedLesson, so it is strict for the same reason)
// ════════════════════════════════════════════════════════════════════════

/** The most lessons one search response carries. */
export const SEARCH_LIMIT = 5;

export const SearchResponse = z.strictObject({
  success: z.literal(true),
  results: z.array(z.strictObject({ score: z.number(), lesson: FeedLesson })).max(SEARCH_LIMIT),
});
export type SearchResponse = z.output<typeof SearchResponse>;

export const FeedResponse = z.strictObject({
  success: z.literal(true),
  lessons: z.array(FeedLesson).max(FEED_LIMIT),
});
export type FeedResponse = z.output<typeof FeedResponse>;

// ════════════════════════════════════════════════════════════════════════
// Upstream ramen-ai evaluation (EVALUATION_API_CONTRACT.md, Schema V5)
// ════════════════════════════════════════════════════════════════════════

/** One flattened violation. Unsigned: MOM observed it on its own TLS call, and it is cross-checked against signed reasoning. */
export const UpstreamViolation = z.looseObject({
  rule_id: z.string().max(128),
  rule_name: z.string().max(1000),
  enforcement_level: z.string().max(32).optional(),
  reasoning: z.string().max(4000).nullish(),
  recovery_instruction: z.string().max(4000).nullish(),
});
export type UpstreamViolation = z.output<typeof UpstreamViolation>;

/** `data` of the ramen-ai evaluate response. Extra fields are allowed; only these are read. */
export const UpstreamEvaluation = z.looseObject({
  allowed: z.boolean(),
  policy_ids: z.array(z.string().max(128)).max(100).optional(),
  policies_errored: z.number().int().nonnegative().optional(),
  total_violations: z.array(UpstreamViolation).max(500).default([]),
  results: z
    .array(z.looseObject({ instruction: z.string().max(4000).nullish() }))
    .max(100)
    .optional(),
  statutory_anchors: z.array(z.string().max(1000)).max(100).optional(),
  receipt: z.unknown().optional(),
  receipt_alert: z.string().max(1000).optional(),
});
export type UpstreamEvaluation = z.output<typeof UpstreamEvaluation>;

/** The unsigned receipt envelope. Nothing here is trusted until the signature over canonical_payload verifies. */
export const RamenReceipt = z.looseObject({
  id: ReceiptId,
  schema_version: z.literal("5.0"),
  kid: z.string().min(1).max(64),
  signature: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, "receipt.signature must be base64url"),
  canonical_payload: z.string().min(2),
  verdict: z.union([z.literal(0), z.literal(1)]).optional(),
  statutory_anchors: z.array(z.string()).optional(),
});
export type RamenReceipt = z.output<typeof RamenReceipt>;

/** The ten signed Schema V5 keys. Applied only after the signature verifies; unknown keys are rejected. */
export const SignedPayloadV5 = z.strictObject({
  schema_version: z.literal("5.0"),
  kid: z.string().min(1).max(64),
  id: ReceiptId,
  timestamp: z.iso.datetime({ offset: true }),
  policy_ids: z.array(z.string().min(1).max(128)).min(1).max(100),
  payload_hash: Sha256Hex,
  verdict: z.union([z.literal(0), z.literal(1)]),
  reasoning: z.string(),
  steering: z.string(),
  statutory_anchors: z.array(z.string()),
});
export type SignedPayloadV5 = z.output<typeof SignedPayloadV5>;

// ════════════════════════════════════════════════════════════════════════
// Error mapping
// ════════════════════════════════════════════════════════════════════════

export interface ValidationFailure {
  code: "INVALID_REQUEST";
  details: Array<{ path: string; message: string }>;
}

/**
 * Maps Zod issues to the public error shape, capped at 10 issues. Paths keep
 * only the top-level field (a schema name, never an input key) and messages
 * never quote input values.
 */
export function toValidationFailure(error: z.ZodError): ValidationFailure {
  return {
    code: "INVALID_REQUEST",
    details: error.issues.slice(0, LIMITS.maxReportedIssues).map((issue) => ({
      path: issue.path.length > 0 ? String(issue.path[0]) : "",
      message: issue.code === "unrecognized_keys" ? "unknown field" : issue.message,
    })),
  };
}

// ════════════════════════════════════════════════════════════════════════
// Admin review queue and bounty board (signed, admin / internal roles)
// ════════════════════════════════════════════════════════════════════════

/** Reasons an admin can give for rejecting a lesson. Stored as review_events.reason_code (CHECK: [a-z0-9_]{1,64}). */
export const ReviewReasonCode = z.enum([
  "pii_or_secret",
  "degenerate_delta",
  "incorrect_fix",
  "duplicate",
  "out_of_scope",
  "policy_conflict",
  "low_quality",
  "adversarial",
]);
export type ReviewReasonCode = z.output<typeof ReviewReasonCode>;

/** Free-text note kept in review_events.details_json, which is permanent: no credentials. */
const ReviewReasoning = z
  .string()
  .trim()
  .min(1, "reasoning must not be empty")
  .max(1000, "reasoning must be at most 1000 characters")
  .refine((value) => !containsSecret(value), "reasoning must not contain credentials");

/**
 * Body of POST /api/v1/admin/review. reason_code is required to reject or quarantine (the ledger CHECK demands
 * it). `quarantine` is the retraction: it takes a lesson out of public view and out of recall, from either the
 * review queue or the approved state. A retracted lesson can then be approved again or rejected for good.
 */
export const AdminReviewRequest = z.discriminatedUnion("decision", [
  z.strictObject({ lesson_id: MomUuid, decision: z.literal("approve"), reasoning: ReviewReasoning.optional() }),
  z.strictObject({
    lesson_id: MomUuid,
    decision: z.literal("quarantine"),
    reason_code: ReviewReasonCode,
    reasoning: ReviewReasoning.optional(),
  }),
  z.strictObject({
    lesson_id: MomUuid,
    decision: z.literal("reject"),
    reason_code: ReviewReasonCode,
    reasoning: ReviewReasoning.optional(),
  }),
]);
export type AdminReviewRequest = z.output<typeof AdminReviewRequest>;

// ════════════════════════════════════════════════════════════════════════
// POST /api/v1/admin/seed (admin only)
// ════════════════════════════════════════════════════════════════════════

/**
 * Most pairs one seed request may carry. Each pair holds two ramen receipts (about 1.5 KB each) and both
 * argument sets, and the signed-request body limit is 64 KiB, so ten leaves a wide margin.
 */
export const SEED_MAX_PAIRS = 10;

/**
 * One verified pair. The two receipts are the unmodified `data.receipt` objects ramen-ai returned for
 * `canonicalJson({tool: tool_name, arguments: failed_arguments})` (verdict 0) and for the same with
 * `compliant_arguments` (verdict 1). MOM never trusts the fields next to them: it rebuilds the evaluated
 * inputs itself, verifies both receipts against the pinned key, and takes everything signed from the receipts.
 */
export const SeedPair = z.strictObject({
  domain: DomainSlug,
  tool_name: ToolName,
  task_description: TaskDescription,
  failed_arguments: ToolArguments,
  compliant_arguments: ToolArguments,
  block_receipt: RamenReceipt,
  allow_receipt: RamenReceipt,
  /** Must be the rule the BLOCK was judged on, 1-256 characters after cleaning. */
  violation_rule: z.string().min(1).max(1000),
  /** Must equal the steering the BLOCK receipt signed. */
  steering_directive: z.string().min(1).max(8000),
});
export type SeedPair = z.output<typeof SeedPair>;

export const SeedRequest = z.array(SeedPair).min(1, "send at least one pair").max(SEED_MAX_PAIRS, `send at most ${SEED_MAX_PAIRS} pairs per request`);
export type SeedRequest = z.output<typeof SeedRequest>;

export const PENDING_DEFAULT_LIMIT = 20;
export const PENDING_MAX_LIMIT = 50;
export const BOUNTY_DEFAULT_LIMIT = 25;
export const BOUNTY_MAX_LIMIT = 50;

const PageLimit = (fallback: number, max: number) =>
  z.coerce.number().int().min(1, "limit must be at least 1").max(max, `limit must be at most ${max}`).default(fallback);

/** Query of GET /api/v1/admin/pending. Defaults to the pending_review queue. */
export const PendingQuery = z.strictObject({
  status: z.enum(["pending_review", "quarantined"]).default("pending_review"),
  domain: DomainSlug.optional(),
  limit: PageLimit(PENDING_DEFAULT_LIMIT, PENDING_MAX_LIMIT),
  cursor: z.string().max(200).optional(),
});
export type PendingQuery = z.output<typeof PendingQuery>;

/** Query of GET /api/v1/bounties. */
export const BountyQuery = z.strictObject({
  domain: DomainSlug.optional(),
  tool: ToolName.optional(),
  limit: PageLimit(BOUNTY_DEFAULT_LIMIT, BOUNTY_MAX_LIMIT),
  cursor: z.string().max(200).optional(),
});
export type BountyQuery = z.output<typeof BountyQuery>;

const CursorPayload = z.strictObject({ t: z.number().int().nonnegative(), id: MomUuid });

/** Keyset cursor: the last row's (timestamp, id). Opaque to callers; it only narrows a query the caller may already run. */
export function encodeCursor(timestampMs: number, id: string): string {
  return encodeBase64url(encoder.encode(JSON.stringify({ t: timestampMs, id })));
}

export function decodeCursor(cursor: string): { timestampMs: number; id: string } | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
    const parsed = CursorPayload.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decodeBase64url(cursor))));
    return parsed.success ? { timestampMs: parsed.data.t, id: parsed.data.id } : null;
  } catch {
    return null;
  }
}
