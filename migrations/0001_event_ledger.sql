-- Migration 0001: Achromat MOM append-only event ledger
--
-- Core tables:
--   traps            Turn 1 pairing windows
--   trap_events      every verified BLOCK receipt in a window
--   fixes            Turn 2 verified ALLOW receipts
--   agent_identities Ed25519 keys, Hashcash registration
--   domain_demand    demand radar for unmet recalls
--
-- Ground rules
--   * Every table is STRICT. Times are INTEGER epoch milliseconds.
--   * Ledger tables are insert-only. A BEFORE UPDATE trigger aborts every UPDATE.
--     DELETE aborts too, except on purgeable tables once a row is past its
--     retention floor. Evidence referenced by a lesson is protected by
--     ON DELETE RESTRICT.
--   * A BEFORE INSERT guard rejects duplicate keys, so INSERT OR REPLACE
--     can never overwrite history (REPLACE deletes do not fire DELETE triggers).
--   * agent_state and lesson_state are projections. Only the AFTER INSERT
--     triggers below write them, in the same transaction as the event, and
--     they can be rebuilt by replaying the ledger.
--   * Window and retention checks read the database clock (view db_clock).
--     App-supplied timestamps must sit within 60 seconds of it, so rows can
--     not be backdated into an expired window or an early purge.
--   * The Worker does the crypto (receipt signatures, payload_hash binding,
--     PoW digests, pair attestations) and the nightly cron re-verifies it.
--     The schema enforces shapes, bindings and the pairing state machine.

-- ════════════════════════════════════════════════════════════════════════
-- Helpers
-- ════════════════════════════════════════════════════════════════════════

-- Database clock in epoch ms. Works on every SQLite version D1 ships.
CREATE VIEW db_clock AS
  SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms;

-- Random UUID v4, used when a trigger has to append its own event row.
CREATE VIEW db_uuid_v4 AS
  SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
      || substr(lower(hex(randomblob(2))), 2) || '-'
      || substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2) || '-'
      || lower(hex(randomblob(6))) AS id;

-- ════════════════════════════════════════════════════════════════════════
-- Identity
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE pow_challenges (
  challenge_id     TEXT    NOT NULL PRIMARY KEY
                   CHECK (length(challenge_id) = 36
                          AND challenge_id GLOB '????????-????-4???-[89ab]???-????????????'
                          AND challenge_id NOT GLOB '*[^0-9a-f-]*'),
  challenge        TEXT    NOT NULL UNIQUE
                   CHECK (length(challenge) = 43 AND challenge NOT GLOB '*[^A-Za-z0-9_-]*'),
  algorithm        TEXT    NOT NULL CHECK (algorithm IN ('sha256-hashcash-v1', 'argon2id-v1')),
  difficulty_bits  INTEGER NOT NULL CHECK (difficulty_bits BETWEEN 16 AND 40),
  ip_prefix_hmac   TEXT    NOT NULL CHECK (length(ip_prefix_hmac) BETWEEN 1 AND 64),
  issued_at_ms     INTEGER NOT NULL,
  expires_at_ms    INTEGER NOT NULL,
  CHECK (expires_at_ms = issued_at_ms + 600000)
) STRICT;

CREATE INDEX pow_challenges_by_expiry ON pow_challenges (expires_at_ms);

-- Insert-only registration record. Community keys arrive through Hashcash PoW
-- (or by rotating an existing community key). Internal, admin and platform keys
-- are provisioned and never carry a challenge.
CREATE TABLE agent_identities (
  agent_key        TEXT    NOT NULL PRIMARY KEY
                   CHECK (length(agent_key) = 64 AND agent_key NOT GLOB '*[^0-9a-f]*'),
  role             TEXT    NOT NULL CHECK (role IN ('community', 'internal', 'admin', 'platform')),
  challenge_id     TEXT    UNIQUE REFERENCES pow_challenges (challenge_id) ON DELETE RESTRICT,
  pow_nonce        TEXT    CHECK (pow_nonce IS NULL
                                  OR (length(pow_nonce) BETWEEN 1 AND 32 AND pow_nonce NOT GLOB '*[^0-9a-f]*')),
  pow_hash         TEXT    CHECK (pow_hash IS NULL
                                  OR (length(pow_hash) = 64 AND pow_hash NOT GLOB '*[^0-9a-f]*')),
  rotated_from_key TEXT    UNIQUE REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  ip_prefix_hmac   TEXT    CHECK (ip_prefix_hmac IS NULL OR length(ip_prefix_hmac) BETWEEN 1 AND 64),
  asn              INTEGER CHECK (asn IS NULL OR asn BETWEEN 0 AND 4294967295),
  registered_at_ms INTEGER NOT NULL,
  -- The PoW audit columns are all set or all null.
  CHECK ((challenge_id IS NULL) = (pow_nonce IS NULL) AND (challenge_id IS NULL) = (pow_hash IS NULL)),
  -- Only community keys come from PoW.
  CHECK (role = 'community' OR challenge_id IS NULL),
  -- A community key comes from exactly one of: a solved challenge, a rotation.
  CHECK (role <> 'community' OR ((challenge_id IS NOT NULL) <> (rotated_from_key IS NOT NULL))),
  CHECK (rotated_from_key IS NULL OR rotated_from_key <> agent_key)
) STRICT;

-- Projection over agent_identities, agent_events and review outcomes.
CREATE TABLE agent_state (
  agent_key            TEXT    NOT NULL PRIMARY KEY
                       REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  role                 TEXT    NOT NULL CHECK (role IN ('community', 'internal', 'admin', 'platform')),
  status               TEXT    NOT NULL CHECK (status IN ('active', 'throttled', 'revoked', 'rotated')),
  auto_approve_enabled INTEGER NOT NULL CHECK (auto_approve_enabled IN (0, 1)),
  approved_count       INTEGER NOT NULL DEFAULT 0 CHECK (approved_count >= 0),
  rejected_count       INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  last_event_at_ms     INTEGER NOT NULL,
  CHECK (auto_approve_enabled = 0 OR role = 'internal')
) STRICT;

CREATE TABLE agent_events (
  event_id          TEXT    NOT NULL PRIMARY KEY
                    CHECK (length(event_id) = 36
                           AND event_id GLOB '????????-????-4???-[89ab]???-????????????'
                           AND event_id NOT GLOB '*[^0-9a-f-]*'),
  agent_key         TEXT    NOT NULL REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  kind              TEXT    NOT NULL CHECK (kind IN ('throttled', 'revoked', 'reactivated', 'rotated_to',
                                                     'auto_approve_paused', 'auto_approve_enabled')),
  related_agent_key TEXT    REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  actor             TEXT    NOT NULL CHECK (length(actor) BETWEEN 1 AND 128),
  reason            TEXT    CHECK (reason IS NULL OR length(reason) <= 500),
  at_ms             INTEGER NOT NULL,
  CHECK ((kind = 'rotated_to') = (related_agent_key IS NOT NULL)),
  CHECK (related_agent_key IS NULL OR related_agent_key <> agent_key)
) STRICT;

CREATE INDEX agent_events_by_agent ON agent_events (agent_key, at_ms);

-- ════════════════════════════════════════════════════════════════════════
-- Raw telemetry (purgeable after 30 days)
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE calibration_attempts (
  attempt_id       TEXT    NOT NULL PRIMARY KEY
                   CHECK (length(attempt_id) = 36
                          AND attempt_id GLOB '????????-????-4???-[89ab]???-????????????'
                          AND attempt_id NOT GLOB '*[^0-9a-f-]*'),
  agent_key        TEXT    NOT NULL REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  domain           TEXT    NOT NULL
                   CHECK (length(domain) BETWEEN 2 AND 64 AND domain GLOB '[a-z0-9]*'
                          AND domain NOT GLOB '*[^a-z0-9_-]*'),
  tool_name        TEXT    NOT NULL
                   CHECK (length(tool_name) BETWEEN 1 AND 64 AND tool_name GLOB '[A-Za-z0-9]*'
                          AND tool_name NOT GLOB '*[^A-Za-z0-9_.:/-]*'),
  task_fingerprint TEXT    NOT NULL
                   CHECK (length(task_fingerprint) = 64 AND task_fingerprint NOT GLOB '*[^0-9a-f]*'),
  task_description TEXT    NOT NULL CHECK (length(task_description) BETWEEN 16 AND 1000),
  arguments_json   TEXT    NOT NULL
                   CHECK (json_valid(arguments_json) AND json_type(arguments_json) = 'object'
                          AND length(arguments_json) <= 16384),
  evaluated_input  TEXT    CHECK (evaluated_input IS NULL OR length(evaluated_input) <= 65536),
  verdict          INTEGER CHECK (verdict IS NULL OR verdict IN (0, 1)),
  receipt_json     TEXT    CHECK (receipt_json IS NULL OR (json_valid(receipt_json) AND length(receipt_json) <= 32768)),
  receipt_verified INTEGER NOT NULL CHECK (receipt_verified IN (0, 1)),
  receipt_bound    INTEGER NOT NULL CHECK (receipt_bound IN (0, 1)),
  error            TEXT    CHECK (error IS NULL OR length(error) <= 500),
  client_ip_hmac   TEXT    CHECK (client_ip_hmac IS NULL OR length(client_ip_hmac) BETWEEN 1 AND 64),
  created_at_ms    INTEGER NOT NULL,
  CHECK (receipt_bound <= receipt_verified),
  CHECK (receipt_verified = 0 OR receipt_json IS NOT NULL)
) STRICT;

CREATE INDEX calibration_attempts_by_agent ON calibration_attempts (agent_key, created_at_ms);
CREATE INDEX calibration_attempts_by_age ON calibration_attempts (created_at_ms);

-- ════════════════════════════════════════════════════════════════════════
-- Seeding (needed before fixes, which reference seed runs)
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE seed_runs (
  run_id        TEXT    NOT NULL PRIMARY KEY
                CHECK (length(run_id) = 36
                       AND run_id GLOB '????????-????-4???-[89ab]???-????????????'
                       AND run_id NOT GLOB '*[^0-9a-f-]*'),
  scenario_hash TEXT    NOT NULL UNIQUE
                CHECK (length(scenario_hash) = 64 AND scenario_hash NOT GLOB '*[^0-9a-f]*'),
  manifest_json TEXT    NOT NULL
                CHECK (json_valid(manifest_json) AND json_type(manifest_json) = 'object'),
  created_by    TEXT    NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE seed_run_events (
  run_id      TEXT    NOT NULL REFERENCES seed_runs (run_id) ON DELETE RESTRICT,
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  state       TEXT    NOT NULL
              CHECK (length(state) BETWEEN 1 AND 32 AND state GLOB '[a-z]*' AND state NOT GLOB '*[^a-z0-9_]*'),
  detail_json TEXT    CHECK (detail_json IS NULL OR json_valid(detail_json)),
  at_ms       INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;

-- ════════════════════════════════════════════════════════════════════════
-- Turn 1: traps (BLOCK)
-- ════════════════════════════════════════════════════════════════════════

-- One row per pairing window, opened by the first verified BLOCK. Immutable.
-- Status is computed, never stored:
--   paired  if a fixes row references trap_id
--   expired if db_clock >= expires_at_ms and not paired (bounty board)
--   open    otherwise
CREATE TABLE traps (
  trap_id          TEXT    NOT NULL PRIMARY KEY
                   CHECK (length(trap_id) = 36
                          AND trap_id GLOB '????????-????-4???-[89ab]???-????????????'
                          AND trap_id NOT GLOB '*[^0-9a-f-]*'),
  agent_key        TEXT    NOT NULL REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  domain           TEXT    NOT NULL
                   CHECK (length(domain) BETWEEN 2 AND 64 AND domain GLOB '[a-z0-9]*'
                          AND domain NOT GLOB '*[^a-z0-9_-]*'),
  tool_name        TEXT    NOT NULL
                   CHECK (length(tool_name) BETWEEN 1 AND 64 AND tool_name GLOB '[A-Za-z0-9]*'
                          AND tool_name NOT GLOB '*[^A-Za-z0-9_.:/-]*'),
  task_fingerprint TEXT    NOT NULL
                   CHECK (length(task_fingerprint) = 64 AND task_fingerprint NOT GLOB '*[^0-9a-f]*'),
  opened_at_ms     INTEGER NOT NULL,
  expires_at_ms    INTEGER NOT NULL,
  -- The window is exactly 24 hours from the first BLOCK and never resets.
  CHECK (expires_at_ms = opened_at_ms + 86400000)
) STRICT;

CREATE INDEX traps_by_task ON traps (agent_key, domain, tool_name, task_fingerprint, expires_at_ms);
CREATE INDEX traps_by_domain_expiry ON traps (domain, expires_at_ms);
CREATE INDEX traps_by_age ON traps (opened_at_ms);

-- Every verified, bound BLOCK inside a window. attempt_seq = 1 is the canonical trap.
CREATE TABLE trap_events (
  block_receipt_id          TEXT    NOT NULL PRIMARY KEY
                            CHECK (length(block_receipt_id) = 36
                                   AND block_receipt_id GLOB '????????-????-????-????-????????????'
                                   AND block_receipt_id NOT GLOB '*[^0-9A-Fa-f-]*'),
  trap_id                   TEXT    NOT NULL REFERENCES traps (trap_id) ON DELETE RESTRICT,
  attempt_seq               INTEGER NOT NULL CHECK (attempt_seq >= 1),
  agent_key                 TEXT    NOT NULL REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  domain                    TEXT    NOT NULL
                            CHECK (length(domain) BETWEEN 2 AND 64 AND domain GLOB '[a-z0-9]*'
                                   AND domain NOT GLOB '*[^a-z0-9_-]*'),
  tool_name                 TEXT    NOT NULL
                            CHECK (length(tool_name) BETWEEN 1 AND 64 AND tool_name GLOB '[A-Za-z0-9]*'
                                   AND tool_name NOT GLOB '*[^A-Za-z0-9_.:/-]*'),
  task_fingerprint          TEXT    NOT NULL
                            CHECK (length(task_fingerprint) = 64 AND task_fingerprint NOT GLOB '*[^0-9a-f]*'),
  task_description          TEXT    NOT NULL CHECK (length(task_description) BETWEEN 16 AND 1000),
  trap_arguments_json       TEXT    NOT NULL
                            CHECK (json_valid(trap_arguments_json) AND json_type(trap_arguments_json) = 'object'
                                   AND length(trap_arguments_json) <= 16384),
  evaluated_input           TEXT    NOT NULL CHECK (length(evaluated_input) BETWEEN 1 AND 65536),
  receipt_signature         TEXT    NOT NULL CHECK (length(receipt_signature) BETWEEN 1 AND 512),
  receipt_canonical_payload TEXT    NOT NULL
                            CHECK (json_valid(receipt_canonical_payload)
                                   AND length(receipt_canonical_payload) <= 16384),
  payload_hash              TEXT    NOT NULL
                            CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  bundle_id                 TEXT    CHECK (bundle_id IS NULL OR length(bundle_id) BETWEEN 1 AND 128),
  policy_ids_json           TEXT    CHECK (policy_ids_json IS NULL
                                           OR (json_valid(policy_ids_json) AND json_type(policy_ids_json) = 'array')),
  violation_rule            TEXT    CHECK (violation_rule IS NULL OR length(violation_rule) BETWEEN 1 AND 256),
  rule_ids_json             TEXT    CHECK (rule_ids_json IS NULL
                                           OR (json_valid(rule_ids_json) AND json_type(rule_ids_json) = 'array')),
  steering_directive        TEXT    CHECK (steering_directive IS NULL OR length(steering_directive) <= 4000),
  statutory_anchor          TEXT    CHECK (statutory_anchor IS NULL OR length(statutory_anchor) <= 1000),
  recorded_at_ms            INTEGER NOT NULL,
  UNIQUE (trap_id, attempt_seq),
  -- Signed fields are the only source of truth: the stored columns must match them.
  CHECK (json_extract(receipt_canonical_payload, '$.verdict') = 0),
  CHECK (json_extract(receipt_canonical_payload, '$.id') = block_receipt_id),
  CHECK (json_extract(receipt_canonical_payload, '$.payload_hash') = payload_hash)
) STRICT;

CREATE INDEX trap_events_by_age ON trap_events (recorded_at_ms);

-- Bounty board leases on expired traps (30 minutes each).
CREATE TABLE bounty_claims (
  claim_id            TEXT    NOT NULL PRIMARY KEY
                      CHECK (length(claim_id) = 36
                             AND claim_id GLOB '????????-????-4???-[89ab]???-????????????'
                             AND claim_id NOT GLOB '*[^0-9a-f-]*'),
  trap_id             TEXT    NOT NULL REFERENCES traps (trap_id) ON DELETE RESTRICT,
  agent_key           TEXT    NOT NULL REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  claimed_at_ms       INTEGER NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL,
  CHECK (lease_expires_at_ms = claimed_at_ms + 1800000)
) STRICT;

CREATE INDEX bounty_claims_by_trap ON bounty_claims (trap_id, lease_expires_at_ms);
CREATE INDEX bounty_claims_by_age ON bounty_claims (claimed_at_ms);

-- ════════════════════════════════════════════════════════════════════════
-- Turn 2: fixes (ALLOW)
-- ════════════════════════════════════════════════════════════════════════

-- Every verified, bound ALLOW from /calibrate, the bounty board or seeding.
-- trap_id is NULL for an unpaired ALLOW, which is evidence only and never a lesson.
CREATE TABLE fixes (
  allow_receipt_id          TEXT    NOT NULL PRIMARY KEY
                            CHECK (length(allow_receipt_id) = 36
                                   AND allow_receipt_id GLOB '????????-????-????-????-????????????'
                                   AND allow_receipt_id NOT GLOB '*[^0-9A-Fa-f-]*'),
  trap_id                   TEXT    REFERENCES traps (trap_id) ON DELETE RESTRICT,
  fix_source                TEXT    NOT NULL CHECK (fix_source IN ('community', 'internal_bounty', 'admin_seed')),
  pairing_outcome           TEXT    NOT NULL
                            CHECK (pairing_outcome IN ('paired', 'unpaired_no_trap', 'unpaired_expired')),
  agent_key                 TEXT    NOT NULL REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  domain                    TEXT    NOT NULL
                            CHECK (length(domain) BETWEEN 2 AND 64 AND domain GLOB '[a-z0-9]*'
                                   AND domain NOT GLOB '*[^a-z0-9_-]*'),
  tool_name                 TEXT    NOT NULL
                            CHECK (length(tool_name) BETWEEN 1 AND 64 AND tool_name GLOB '[A-Za-z0-9]*'
                                   AND tool_name NOT GLOB '*[^A-Za-z0-9_.:/-]*'),
  task_fingerprint          TEXT    NOT NULL
                            CHECK (length(task_fingerprint) = 64 AND task_fingerprint NOT GLOB '*[^0-9a-f]*'),
  task_description          TEXT    NOT NULL CHECK (length(task_description) BETWEEN 16 AND 1000),
  fix_arguments_json        TEXT    NOT NULL
                            CHECK (json_valid(fix_arguments_json) AND json_type(fix_arguments_json) = 'object'
                                   AND length(fix_arguments_json) <= 16384),
  evaluated_input           TEXT    NOT NULL CHECK (length(evaluated_input) BETWEEN 1 AND 65536),
  receipt_signature         TEXT    NOT NULL CHECK (length(receipt_signature) BETWEEN 1 AND 512),
  receipt_canonical_payload TEXT    NOT NULL
                            CHECK (json_valid(receipt_canonical_payload)
                                   AND length(receipt_canonical_payload) <= 16384),
  payload_hash              TEXT    NOT NULL
                            CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  bundle_id                 TEXT    CHECK (bundle_id IS NULL OR length(bundle_id) BETWEEN 1 AND 128),
  policy_ids_json           TEXT    CHECK (policy_ids_json IS NULL
                                           OR (json_valid(policy_ids_json) AND json_type(policy_ids_json) = 'array')),
  seed_run_id               TEXT    REFERENCES seed_runs (run_id) ON DELETE RESTRICT,
  recorded_at_ms            INTEGER NOT NULL,
  CHECK ((trap_id IS NOT NULL) = (pairing_outcome = 'paired')),
  -- Bounty and seed fixes always target a trap. Only community ALLOWs can be unpaired.
  CHECK (fix_source = 'community' OR pairing_outcome = 'paired'),
  CHECK ((fix_source = 'admin_seed') = (seed_run_id IS NOT NULL)),
  CHECK (json_extract(receipt_canonical_payload, '$.verdict') = 1),
  CHECK (json_extract(receipt_canonical_payload, '$.id') = allow_receipt_id),
  CHECK (json_extract(receipt_canonical_payload, '$.payload_hash') = payload_hash)
) STRICT;

-- A trap pairs at most once.
CREATE UNIQUE INDEX fixes_one_per_trap ON fixes (trap_id) WHERE trap_id IS NOT NULL;
CREATE INDEX fixes_by_task ON fixes (agent_key, domain, tool_name, task_fingerprint);
CREATE INDEX fixes_by_age ON fixes (recorded_at_ms);

-- ════════════════════════════════════════════════════════════════════════
-- Lessons
-- ════════════════════════════════════════════════════════════════════════

-- One per bound pair. lesson_id doubles as the Vectorize vector id.
CREATE TABLE lessons (
  lesson_id            TEXT    NOT NULL PRIMARY KEY
                       CHECK (length(lesson_id) = 36
                              AND lesson_id GLOB '????????-????-4???-[89ab]???-????????????'
                              AND lesson_id NOT GLOB '*[^0-9a-f-]*'),
  trap_id              TEXT    NOT NULL UNIQUE REFERENCES traps (trap_id) ON DELETE RESTRICT,
  trap_event_id        TEXT    NOT NULL REFERENCES trap_events (block_receipt_id) ON DELETE RESTRICT,
  fix_event_id         TEXT    NOT NULL UNIQUE REFERENCES fixes (allow_receipt_id) ON DELETE RESTRICT,
  domain               TEXT    NOT NULL
                       CHECK (length(domain) BETWEEN 2 AND 64 AND domain GLOB '[a-z0-9]*'
                              AND domain NOT GLOB '*[^a-z0-9_-]*'),
  tool_name            TEXT    NOT NULL
                       CHECK (length(tool_name) BETWEEN 1 AND 64 AND tool_name GLOB '[A-Za-z0-9]*'
                              AND tool_name NOT GLOB '*[^A-Za-z0-9_.:/-]*'),
  task_fingerprint     TEXT    NOT NULL
                       CHECK (length(task_fingerprint) = 64 AND task_fingerprint NOT GLOB '*[^0-9a-f]*'),
  violation_rule       TEXT    NOT NULL CHECK (length(violation_rule) BETWEEN 1 AND 256),
  changed_paths_json   TEXT    NOT NULL
                       CHECK (json_valid(changed_paths_json) AND json_type(changed_paths_json) = 'array'
                              AND json_array_length(changed_paths_json) >= 1),
  delta_json           TEXT    NOT NULL CHECK (json_valid(delta_json) AND length(delta_json) <= 32768),
  delta_hash           TEXT    NOT NULL
                       CHECK (length(delta_hash) = 64 AND delta_hash NOT GLOB '*[^0-9a-f]*'),
  -- MOM Ed25519 attestation over (block id, allow id, domain, tool, fingerprint, delta_hash), base64url.
  pair_attestation     TEXT    NOT NULL
                       CHECK (length(pair_attestation) = 86 AND pair_attestation NOT GLOB '*[^A-Za-z0-9_-]*'),
  attestation_kid      TEXT    NOT NULL CHECK (length(attestation_kid) BETWEEN 1 AND 64),
  provenance           TEXT    NOT NULL
                       CHECK (provenance IN ('community', 'admin_seed', 'community_trap+internal_fix')),
  source_agent_key     TEXT    NOT NULL REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  fixed_by_key         TEXT    REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  -- Vectorize visibility token for the pending (submitter-only) state:
  -- 'k:' + base64url(HMAC-SHA256(VISIBILITY_KEY, agent_key)), computed by the Worker.
  submitter_visibility TEXT    NOT NULL
                       CHECK (length(submitter_visibility) = 45 AND substr(submitter_visibility, 1, 2) = 'k:'
                              AND substr(submitter_visibility, 3) NOT GLOB '*[^A-Za-z0-9_-]*'),
  embed_version        TEXT    NOT NULL CHECK (length(embed_version) BETWEEN 1 AND 64),
  created_at_ms        INTEGER NOT NULL,
  -- Dedup invariant carried over from ramen-forge.
  UNIQUE (domain, tool_name, task_fingerprint, violation_rule),
  CHECK ((provenance = 'community_trap+internal_fix') = (fixed_by_key IS NOT NULL))
) STRICT;

-- Projection over review_events and vector_sync_events.
-- visibility: 'none' (not in Vectorize), 'public' (approved) or the submitter token (pending_review).
CREATE TABLE lesson_state (
  lesson_id              TEXT    NOT NULL PRIMARY KEY REFERENCES lessons (lesson_id) ON DELETE RESTRICT,
  review_status          TEXT    NOT NULL
                         CHECK (review_status IN ('pending_triage', 'pending_review', 'quarantined',
                                                  'approved', 'rejected')),
  visibility             TEXT    NOT NULL,
  audit_status           TEXT    NOT NULL CHECK (audit_status IN ('none', 'sampled', 'passed', 'failed')),
  display_title          TEXT    CHECK (display_title IS NULL OR length(display_title) BETWEEN 1 AND 120),
  display_summary        TEXT    CHECK (display_summary IS NULL OR length(display_summary) BETWEEN 1 AND 500),
  featured               INTEGER NOT NULL CHECK (featured IN (0, 1)),
  vector_desired_version INTEGER NOT NULL CHECK (vector_desired_version >= 0),
  vector_synced_version  INTEGER NOT NULL
                         CHECK (vector_synced_version >= 0 AND vector_synced_version <= vector_desired_version),
  updated_at_ms          INTEGER NOT NULL,
  CHECK ((visibility = 'public') = (review_status = 'approved')),
  CHECK (visibility IN ('none', 'public')
         OR (review_status = 'pending_review' AND length(visibility) = 45 AND substr(visibility, 1, 2) = 'k:')),
  CHECK (featured = 0 OR review_status = 'approved')
) STRICT;

CREATE INDEX lesson_state_by_status ON lesson_state (review_status, updated_at_ms);
CREATE INDEX lesson_state_vector_drift ON lesson_state (lesson_id)
  WHERE vector_synced_version < vector_desired_version;

-- Further bound pairs for a task that already has a lesson.
CREATE TABLE lesson_corroborations (
  corroboration_id TEXT    NOT NULL PRIMARY KEY
                   CHECK (length(corroboration_id) = 36
                          AND corroboration_id GLOB '????????-????-4???-[89ab]???-????????????'
                          AND corroboration_id NOT GLOB '*[^0-9a-f-]*'),
  lesson_id        TEXT    NOT NULL REFERENCES lessons (lesson_id) ON DELETE RESTRICT,
  trap_id          TEXT    NOT NULL UNIQUE REFERENCES traps (trap_id) ON DELETE RESTRICT,
  fix_event_id     TEXT    NOT NULL UNIQUE REFERENCES fixes (allow_receipt_id) ON DELETE RESTRICT,
  agent_key        TEXT    NOT NULL REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  delta_hash       TEXT    NOT NULL
                   CHECK (length(delta_hash) = 64 AND delta_hash NOT GLOB '*[^0-9a-f]*'),
  created_at_ms    INTEGER NOT NULL
) STRICT;

CREATE INDEX lesson_corroborations_by_lesson ON lesson_corroborations (lesson_id, agent_key);

-- ════════════════════════════════════════════════════════════════════════
-- Review
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE triage_checks (
  lesson_id    TEXT    NOT NULL REFERENCES lessons (lesson_id) ON DELETE RESTRICT,
  check_name   TEXT    NOT NULL
               CHECK (check_name IN ('non_degenerate_delta', 'secret_pii_scan', 'same_tool_bundle',
                                     'near_duplicate', 'submitter_reputation', 'burst', 'internal_anomaly')),
  passed       INTEGER NOT NULL CHECK (passed IN (0, 1)),
  score        REAL,
  details_json TEXT    CHECK (details_json IS NULL OR json_valid(details_json)),
  at_ms        INTEGER NOT NULL,
  PRIMARY KEY (lesson_id, check_name)
) STRICT;

CREATE TABLE review_events (
  event_id     TEXT    NOT NULL PRIMARY KEY
               CHECK (length(event_id) = 36
                      AND event_id GLOB '????????-????-4???-[89ab]???-????????????'
                      AND event_id NOT GLOB '*[^0-9a-f-]*'),
  lesson_id    TEXT    NOT NULL REFERENCES lessons (lesson_id) ON DELETE RESTRICT,
  actor_type   TEXT    NOT NULL
               CHECK (actor_type IN ('triage', 'human', 'internal_auto', 'audit_sampler', 'cron_reverify')),
  actor_id     TEXT    NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  action       TEXT    NOT NULL
               CHECK (action IN ('triage_pass', 'triage_fail', 'approve', 'reject', 'quarantine',
                                 'sample_for_audit', 'audit_pass', 'audit_reject', 'set_editorial',
                                 'feature', 'unfeature')),
  reason_code  TEXT    CHECK (reason_code IS NULL
                              OR (length(reason_code) BETWEEN 1 AND 64 AND reason_code NOT GLOB '*[^a-z0-9_]*')),
  details_json TEXT    CHECK (details_json IS NULL OR json_valid(details_json)),
  at_ms        INTEGER NOT NULL,
  -- Which actor may take which action.
  CHECK ((action IN ('triage_pass', 'triage_fail') AND actor_type = 'triage')
      OR (action = 'approve' AND actor_type IN ('human', 'internal_auto'))
      OR (action = 'quarantine' AND actor_type IN ('human', 'cron_reverify'))
      OR (action = 'sample_for_audit' AND actor_type = 'audit_sampler')
      OR (action IN ('reject', 'audit_pass', 'audit_reject', 'set_editorial', 'feature', 'unfeature')
          AND actor_type = 'human')),
  CHECK (action NOT IN ('reject', 'quarantine', 'audit_reject') OR reason_code IS NOT NULL),
  CHECK (action <> 'set_editorial' OR (details_json IS NOT NULL AND json_type(details_json) = 'object'))
) STRICT;

CREATE INDEX review_events_by_lesson ON review_events (lesson_id, at_ms);

-- Acknowledgements of applied Vectorize operations (moves vector_synced_version).
CREATE TABLE vector_sync_events (
  lesson_id    TEXT    NOT NULL REFERENCES lessons (lesson_id) ON DELETE RESTRICT,
  version      INTEGER NOT NULL CHECK (version >= 1),
  operation    TEXT    NOT NULL CHECK (operation IN ('upsert', 'delete')),
  synced_at_ms INTEGER NOT NULL,
  PRIMARY KEY (lesson_id, version)
) STRICT;

-- ════════════════════════════════════════════════════════════════════════
-- Usage and demand telemetry
-- ════════════════════════════════════════════════════════════════════════

-- Distinct-lesson budget (30-day look-back). Written with INSERT OR IGNORE.
CREATE TABLE lesson_deliveries (
  agent_key          TEXT    NOT NULL REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  lesson_id          TEXT    NOT NULL REFERENCES lessons (lesson_id) ON DELETE RESTRICT,
  first_served_at_ms INTEGER NOT NULL,
  PRIMARY KEY (agent_key, lesson_id)
) STRICT;

CREATE INDEX lesson_deliveries_by_age ON lesson_deliveries (first_served_at_ms);

CREATE TABLE feedback_events (
  event_id              TEXT    NOT NULL PRIMARY KEY
                        CHECK (length(event_id) = 36
                               AND event_id GLOB '????????-????-4???-[89ab]???-????????????'
                               AND event_id NOT GLOB '*[^0-9a-f-]*'),
  lesson_id             TEXT    NOT NULL REFERENCES lessons (lesson_id) ON DELETE RESTRICT,
  agent_key             TEXT    NOT NULL REFERENCES agent_identities (agent_key) ON DELETE RESTRICT,
  downstream_receipt_id TEXT    NOT NULL UNIQUE
                        CHECK (length(downstream_receipt_id) = 36
                               AND downstream_receipt_id GLOB '????????-????-????-????-????????????'
                               AND downstream_receipt_id NOT GLOB '*[^0-9A-Fa-f-]*'),
  success               INTEGER NOT NULL CHECK (success IN (0, 1)),
  at_ms                 INTEGER NOT NULL
) STRICT;

CREATE INDEX feedback_events_by_lesson ON feedback_events (lesson_id, at_ms);

-- Demand radar: recalls that found nothing above the threshold. Written with INSERT OR IGNORE,
-- one row per caller, task and hour.
CREATE TABLE domain_demand (
  miss_id          TEXT    NOT NULL PRIMARY KEY
                   CHECK (length(miss_id) = 36
                          AND miss_id GLOB '????????-????-4???-[89ab]???-????????????'
                          AND miss_id NOT GLOB '*[^0-9a-f-]*'),
  hour_bucket      INTEGER NOT NULL,
  domain           TEXT    NOT NULL
                   CHECK (length(domain) BETWEEN 2 AND 64 AND domain GLOB '[a-z0-9]*'
                          AND domain NOT GLOB '*[^a-z0-9_-]*'),
  tool_name        TEXT    NOT NULL
                   CHECK (length(tool_name) BETWEEN 1 AND 64 AND tool_name GLOB '[A-Za-z0-9]*'
                          AND tool_name NOT GLOB '*[^A-Za-z0-9_.:/-]*'),
  task_fingerprint TEXT    NOT NULL
                   CHECK (length(task_fingerprint) = 64 AND task_fingerprint NOT GLOB '*[^0-9a-f]*'),
  task_description TEXT    NOT NULL CHECK (length(task_description) BETWEEN 16 AND 1000),
  agent_key_hmac   TEXT    NOT NULL CHECK (length(agent_key_hmac) BETWEEN 1 AND 64),
  nearest_score    REAL    CHECK (nearest_score IS NULL OR nearest_score BETWEEN -1.0 AND 1.0),
  created_at_ms    INTEGER NOT NULL,
  CHECK (hour_bucket = created_at_ms / 3600000),
  UNIQUE (agent_key_hmac, domain, tool_name, task_fingerprint, hour_bucket)
) STRICT;

CREATE INDEX domain_demand_by_tool ON domain_demand (domain, tool_name, hour_bucket);
CREATE INDEX domain_demand_by_age ON domain_demand (created_at_ms);

-- ════════════════════════════════════════════════════════════════════════
-- Clock guards: app timestamps must be within 60 s of the database clock
-- ════════════════════════════════════════════════════════════════════════

CREATE TRIGGER pow_challenges_clock_guard BEFORE INSERT ON pow_challenges
BEGIN
  SELECT RAISE(ABORT, 'pow_challenges: issued_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.issued_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER agent_identities_clock_guard BEFORE INSERT ON agent_identities
BEGIN
  SELECT RAISE(ABORT, 'agent_identities: registered_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.registered_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER agent_events_clock_guard BEFORE INSERT ON agent_events
BEGIN
  SELECT RAISE(ABORT, 'agent_events: at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER calibration_attempts_clock_guard BEFORE INSERT ON calibration_attempts
BEGIN
  SELECT RAISE(ABORT, 'calibration_attempts: created_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.created_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER seed_runs_clock_guard BEFORE INSERT ON seed_runs
BEGIN
  SELECT RAISE(ABORT, 'seed_runs: created_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.created_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER seed_run_events_clock_guard BEFORE INSERT ON seed_run_events
BEGIN
  SELECT RAISE(ABORT, 'seed_run_events: at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER traps_clock_guard BEFORE INSERT ON traps
BEGIN
  SELECT RAISE(ABORT, 'traps: opened_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.opened_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER trap_events_clock_guard BEFORE INSERT ON trap_events
BEGIN
  SELECT RAISE(ABORT, 'trap_events: recorded_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.recorded_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER bounty_claims_clock_guard BEFORE INSERT ON bounty_claims
BEGIN
  SELECT RAISE(ABORT, 'bounty_claims: claimed_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.claimed_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER fixes_clock_guard BEFORE INSERT ON fixes
BEGIN
  SELECT RAISE(ABORT, 'fixes: recorded_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.recorded_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER lessons_clock_guard BEFORE INSERT ON lessons
BEGIN
  SELECT RAISE(ABORT, 'lessons: created_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.created_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER lesson_corroborations_clock_guard BEFORE INSERT ON lesson_corroborations
BEGIN
  SELECT RAISE(ABORT, 'lesson_corroborations: created_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.created_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER triage_checks_clock_guard BEFORE INSERT ON triage_checks
BEGIN
  SELECT RAISE(ABORT, 'triage_checks: at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER review_events_clock_guard BEFORE INSERT ON review_events
BEGIN
  SELECT RAISE(ABORT, 'review_events: at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER vector_sync_events_clock_guard BEFORE INSERT ON vector_sync_events
BEGIN
  SELECT RAISE(ABORT, 'vector_sync_events: synced_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.synced_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER lesson_deliveries_clock_guard BEFORE INSERT ON lesson_deliveries
BEGIN
  SELECT RAISE(ABORT, 'lesson_deliveries: first_served_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.first_served_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER feedback_events_clock_guard BEFORE INSERT ON feedback_events
BEGIN
  SELECT RAISE(ABORT, 'feedback_events: at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

CREATE TRIGGER domain_demand_clock_guard BEFORE INSERT ON domain_demand
BEGIN
  SELECT RAISE(ABORT, 'domain_demand: created_at_ms must be within 60 s of the database clock')
   WHERE abs(NEW.created_at_ms - (SELECT now_ms FROM db_clock)) > 60000;
END;

-- ════════════════════════════════════════════════════════════════════════
-- Identity rules
-- ════════════════════════════════════════════════════════════════════════

CREATE TRIGGER pow_challenges_guard_insert BEFORE INSERT ON pow_challenges
BEGIN
  SELECT RAISE(ABORT, 'pow_challenges: challenge already exists')
   WHERE EXISTS (SELECT 1 FROM pow_challenges
                  WHERE challenge_id = NEW.challenge_id OR challenge = NEW.challenge);
END;

CREATE TRIGGER agent_identities_guard_insert BEFORE INSERT ON agent_identities
BEGIN
  SELECT RAISE(ABORT, 'agent_identities: key, challenge or rotation source already registered')
   WHERE EXISTS (SELECT 1 FROM agent_identities
                  WHERE agent_key = NEW.agent_key
                     OR challenge_id = NEW.challenge_id
                     OR rotated_from_key = NEW.rotated_from_key);
  -- Single-use PoW (UNIQUE challenge_id) that is redeemed before it expires ...
  SELECT RAISE(ABORT, 'agent_identities: PoW challenge has expired')
   WHERE NEW.challenge_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pow_challenges c
                      WHERE c.challenge_id = NEW.challenge_id
                        AND (SELECT now_ms FROM db_clock) < c.expires_at_ms);
  -- ... from the network prefix it was issued to ...
  SELECT RAISE(ABORT, 'agent_identities: PoW challenge was issued to a different network')
   WHERE NEW.challenge_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pow_challenges c
                      WHERE c.challenge_id = NEW.challenge_id AND c.ip_prefix_hmac = NEW.ip_prefix_hmac);
  -- ... and whose recorded digest has the required leading zero bits.
  -- The Worker recomputes the digest, this is the audit-trail cross-check.
  SELECT RAISE(ABORT, 'agent_identities: pow_hash does not meet the challenge difficulty')
   WHERE NEW.challenge_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pow_challenges c
        WHERE c.challenge_id = NEW.challenge_id
          AND substr(NEW.pow_hash, 1, c.difficulty_bits / 4) = substr('0000000000', 1, c.difficulty_bits / 4)
          AND (c.difficulty_bits % 4 = 0
               OR instr(substr('0123456789abcdef', 1, 1 << (4 - c.difficulty_bits % 4)),
                        substr(NEW.pow_hash, c.difficulty_bits / 4 + 1, 1)) > 0));
  SELECT RAISE(ABORT, 'agent_identities: rotation source must be a live key with the same role')
   WHERE NEW.rotated_from_key IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM agent_state s
                      WHERE s.agent_key = NEW.rotated_from_key
                        AND s.status IN ('active', 'throttled') AND s.role = NEW.role);
END;

CREATE TRIGGER agent_identities_project AFTER INSERT ON agent_identities
BEGIN
  INSERT INTO agent_state (agent_key, role, status, auto_approve_enabled, approved_count,
                           rejected_count, last_event_at_ms)
  VALUES (NEW.agent_key, NEW.role, 'active', iif(NEW.role = 'internal', 1, 0), 0, 0, NEW.registered_at_ms);
END;

CREATE TRIGGER agent_state_guard_insert BEFORE INSERT ON agent_state
BEGIN
  SELECT RAISE(ABORT, 'agent_state: projection row already exists')
   WHERE EXISTS (SELECT 1 FROM agent_state WHERE agent_key = NEW.agent_key);
END;

CREATE TRIGGER agent_events_guard_insert BEFORE INSERT ON agent_events
BEGIN
  SELECT RAISE(ABORT, 'agent_events: event_id already exists')
   WHERE EXISTS (SELECT 1 FROM agent_events WHERE event_id = NEW.event_id);
  SELECT RAISE(ABORT, 'agent_events: rotated keys are retired')
   WHERE EXISTS (SELECT 1 FROM agent_state WHERE agent_key = NEW.agent_key AND status = 'rotated');
  SELECT RAISE(ABORT, 'agent_events: only an active key can be throttled')
   WHERE NEW.kind = 'throttled'
     AND NOT EXISTS (SELECT 1 FROM agent_state WHERE agent_key = NEW.agent_key AND status = 'active');
  SELECT RAISE(ABORT, 'agent_events: key is already revoked')
   WHERE NEW.kind = 'revoked'
     AND NOT EXISTS (SELECT 1 FROM agent_state
                      WHERE agent_key = NEW.agent_key AND status IN ('active', 'throttled'));
  SELECT RAISE(ABORT, 'agent_events: only a throttled or revoked key can be reactivated')
   WHERE NEW.kind = 'reactivated'
     AND NOT EXISTS (SELECT 1 FROM agent_state
                      WHERE agent_key = NEW.agent_key AND status IN ('throttled', 'revoked'));
  SELECT RAISE(ABORT, 'agent_events: rotation target must be registered as rotated from this key')
   WHERE NEW.kind = 'rotated_to'
     AND NOT EXISTS (SELECT 1 FROM agent_identities
                      WHERE agent_key = NEW.related_agent_key AND rotated_from_key = NEW.agent_key);
  SELECT RAISE(ABORT, 'agent_events: auto-approval applies to internal keys only')
   WHERE NEW.kind IN ('auto_approve_paused', 'auto_approve_enabled')
     AND NOT EXISTS (SELECT 1 FROM agent_state WHERE agent_key = NEW.agent_key AND role = 'internal');
  SELECT RAISE(ABORT, 'agent_events: auto-approval is already in the requested state')
   WHERE NEW.kind IN ('auto_approve_paused', 'auto_approve_enabled')
     AND EXISTS (SELECT 1 FROM agent_state
                  WHERE agent_key = NEW.agent_key
                    AND auto_approve_enabled = iif(NEW.kind = 'auto_approve_enabled', 1, 0));
END;

CREATE TRIGGER agent_events_project AFTER INSERT ON agent_events
BEGIN
  UPDATE agent_state
     SET status = iif(NEW.kind = 'throttled', 'throttled',
                  iif(NEW.kind = 'revoked', 'revoked',
                  iif(NEW.kind = 'reactivated', 'active',
                  iif(NEW.kind = 'rotated_to', 'rotated', status)))),
         auto_approve_enabled = iif(NEW.kind = 'auto_approve_paused', 0,
                                iif(NEW.kind = 'auto_approve_enabled', 1, auto_approve_enabled)),
         last_event_at_ms = NEW.at_ms
   WHERE agent_key = NEW.agent_key;
END;

-- ════════════════════════════════════════════════════════════════════════
-- Telemetry and seeding rules
-- ════════════════════════════════════════════════════════════════════════

CREATE TRIGGER calibration_attempts_guard_insert BEFORE INSERT ON calibration_attempts
BEGIN
  SELECT RAISE(ABORT, 'calibration_attempts: attempt_id already exists')
   WHERE EXISTS (SELECT 1 FROM calibration_attempts WHERE attempt_id = NEW.attempt_id);
END;

CREATE TRIGGER seed_runs_guard_insert BEFORE INSERT ON seed_runs
BEGIN
  SELECT RAISE(ABORT, 'seed_runs: run or scenario already exists')
   WHERE EXISTS (SELECT 1 FROM seed_runs WHERE run_id = NEW.run_id OR scenario_hash = NEW.scenario_hash);
END;

CREATE TRIGGER seed_run_events_guard_insert BEFORE INSERT ON seed_run_events
BEGIN
  SELECT RAISE(ABORT, 'seed_run_events: seq must be the next number for the run')
   WHERE NEW.seq <> (SELECT coalesce(max(seq), 0) + 1 FROM seed_run_events WHERE run_id = NEW.run_id);
END;

-- Duplicates are ignored, not overwritten, so INSERT OR REPLACE cannot reset first_served_at_ms.
CREATE TRIGGER lesson_deliveries_guard_insert BEFORE INSERT ON lesson_deliveries
BEGIN
  SELECT RAISE(IGNORE)
   WHERE EXISTS (SELECT 1 FROM lesson_deliveries
                  WHERE agent_key = NEW.agent_key AND lesson_id = NEW.lesson_id);
  SELECT RAISE(ABORT, 'lesson_deliveries: lesson is not visible to any agent')
   WHERE EXISTS (SELECT 1 FROM lesson_state WHERE lesson_id = NEW.lesson_id AND visibility = 'none');
END;

CREATE TRIGGER feedback_events_guard_insert BEFORE INSERT ON feedback_events
BEGIN
  SELECT RAISE(ABORT, 'feedback_events: event or downstream receipt already recorded')
   WHERE EXISTS (SELECT 1 FROM feedback_events
                  WHERE event_id = NEW.event_id OR downstream_receipt_id = NEW.downstream_receipt_id);
END;

CREATE TRIGGER domain_demand_guard_insert BEFORE INSERT ON domain_demand
BEGIN
  SELECT RAISE(IGNORE)
   WHERE EXISTS (SELECT 1 FROM domain_demand
                  WHERE miss_id = NEW.miss_id
                     OR (agent_key_hmac = NEW.agent_key_hmac AND domain = NEW.domain
                         AND tool_name = NEW.tool_name AND task_fingerprint = NEW.task_fingerprint
                         AND hour_bucket = NEW.hour_bucket));
END;

-- ════════════════════════════════════════════════════════════════════════
-- Pairing rules (24-hour window)
-- ════════════════════════════════════════════════════════════════════════

CREATE TRIGGER traps_guard_insert BEFORE INSERT ON traps
BEGIN
  SELECT RAISE(ABORT, 'traps: trap_id already exists')
   WHERE EXISTS (SELECT 1 FROM traps WHERE trap_id = NEW.trap_id);
  SELECT RAISE(ABORT, 'traps: agent key is not active')
   WHERE NOT EXISTS (SELECT 1 FROM agent_state
                      WHERE agent_key = NEW.agent_key AND status IN ('active', 'throttled'));
  -- One open window per (agent, domain, tool, fingerprint). Retries join it, they never reset it.
  SELECT RAISE(ABORT, 'traps: an open trap already exists for this agent and task')
   WHERE EXISTS (SELECT 1 FROM traps t
                  WHERE t.agent_key = NEW.agent_key AND t.domain = NEW.domain
                    AND t.tool_name = NEW.tool_name AND t.task_fingerprint = NEW.task_fingerprint
                    AND t.expires_at_ms > (SELECT now_ms FROM db_clock)
                    AND NOT EXISTS (SELECT 1 FROM fixes f WHERE f.trap_id = t.trap_id));
END;

CREATE TRIGGER trap_events_guard_insert BEFORE INSERT ON trap_events
BEGIN
  SELECT RAISE(ABORT, 'trap_events: receipt already recorded')
   WHERE EXISTS (SELECT 1 FROM trap_events WHERE block_receipt_id = NEW.block_receipt_id);
  SELECT RAISE(ABORT, 'trap_events: BLOCK does not match the trap agent, domain, tool and task')
   WHERE NOT EXISTS (SELECT 1 FROM traps t
                      WHERE t.trap_id = NEW.trap_id AND t.agent_key = NEW.agent_key
                        AND t.domain = NEW.domain AND t.tool_name = NEW.tool_name
                        AND t.task_fingerprint = NEW.task_fingerprint);
  SELECT RAISE(ABORT, 'trap_events: pairing window has closed')
   WHERE NOT EXISTS (SELECT 1 FROM traps t
                      WHERE t.trap_id = NEW.trap_id AND (SELECT now_ms FROM db_clock) < t.expires_at_ms);
  SELECT RAISE(ABORT, 'trap_events: trap is already paired')
   WHERE EXISTS (SELECT 1 FROM fixes f WHERE f.trap_id = NEW.trap_id);
  SELECT RAISE(ABORT, 'trap_events: attempt_seq must be the next number for the trap')
   WHERE NEW.attempt_seq <> (SELECT coalesce(max(attempt_seq), 0) + 1 FROM trap_events
                              WHERE trap_id = NEW.trap_id);
END;

CREATE TRIGGER bounty_claims_guard_insert BEFORE INSERT ON bounty_claims
BEGIN
  SELECT RAISE(ABORT, 'bounty_claims: claim_id already exists')
   WHERE EXISTS (SELECT 1 FROM bounty_claims WHERE claim_id = NEW.claim_id);
  SELECT RAISE(ABORT, 'bounty_claims: claims need an active internal key')
   WHERE NOT EXISTS (SELECT 1 FROM agent_state
                      WHERE agent_key = NEW.agent_key AND role = 'internal'
                        AND status IN ('active', 'throttled'));
  SELECT RAISE(ABORT, 'bounty_claims: trap window has not closed')
   WHERE NOT EXISTS (SELECT 1 FROM traps t
                      WHERE t.trap_id = NEW.trap_id AND (SELECT now_ms FROM db_clock) >= t.expires_at_ms);
  SELECT RAISE(ABORT, 'bounty_claims: trap is already paired')
   WHERE EXISTS (SELECT 1 FROM fixes f WHERE f.trap_id = NEW.trap_id);
  SELECT RAISE(ABORT, 'bounty_claims: trap already has a live lease')
   WHERE EXISTS (SELECT 1 FROM bounty_claims c
                  WHERE c.trap_id = NEW.trap_id AND c.lease_expires_at_ms > (SELECT now_ms FROM db_clock));
END;

CREATE TRIGGER fixes_guard_insert BEFORE INSERT ON fixes
BEGIN
  SELECT RAISE(ABORT, 'fixes: receipt already recorded')
   WHERE EXISTS (SELECT 1 FROM fixes WHERE allow_receipt_id = NEW.allow_receipt_id);
  SELECT RAISE(ABORT, 'fixes: agent key is not active')
   WHERE NOT EXISTS (SELECT 1 FROM agent_state
                      WHERE agent_key = NEW.agent_key AND status IN ('active', 'throttled'));

  -- Every paired fix: same task as the trap, trap holds its first BLOCK, trap pairs once.
  SELECT RAISE(ABORT, 'fixes: ALLOW does not match the trap domain, tool and task')
   WHERE NEW.trap_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM traps t
                      WHERE t.trap_id = NEW.trap_id AND t.domain = NEW.domain
                        AND t.tool_name = NEW.tool_name AND t.task_fingerprint = NEW.task_fingerprint);
  SELECT RAISE(ABORT, 'fixes: trap has no recorded BLOCK')
   WHERE NEW.trap_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM trap_events e WHERE e.trap_id = NEW.trap_id AND e.attempt_seq = 1);
  SELECT RAISE(ABORT, 'fixes: trap is already paired')
   WHERE NEW.trap_id IS NOT NULL AND EXISTS (SELECT 1 FROM fixes f WHERE f.trap_id = NEW.trap_id);

  -- Community and seed fixes: only the trap owner, only inside the window.
  SELECT RAISE(ABORT, 'fixes: only the trap owner can pair inside the window')
   WHERE NEW.fix_source IN ('community', 'admin_seed') AND NEW.trap_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM traps t WHERE t.trap_id = NEW.trap_id AND t.agent_key = NEW.agent_key);
  SELECT RAISE(ABORT, 'fixes: pairing window has closed')
   WHERE NEW.fix_source IN ('community', 'admin_seed') AND NEW.trap_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM traps t
                      WHERE t.trap_id = NEW.trap_id AND (SELECT now_ms FROM db_clock) < t.expires_at_ms);
  SELECT RAISE(ABORT, 'fixes: seed fixes need an admin or platform key')
   WHERE NEW.fix_source = 'admin_seed'
     AND NOT EXISTS (SELECT 1 FROM agent_state
                      WHERE agent_key = NEW.agent_key AND role IN ('admin', 'platform'));

  -- Bounty fixes: internal key, only after the window closes, holding a live lease.
  SELECT RAISE(ABORT, 'fixes: bounty fixes need an internal key')
   WHERE NEW.fix_source = 'internal_bounty'
     AND NOT EXISTS (SELECT 1 FROM agent_state WHERE agent_key = NEW.agent_key AND role = 'internal');
  SELECT RAISE(ABORT, 'fixes: bounty fixes are allowed only after the window closes')
   WHERE NEW.fix_source = 'internal_bounty'
     AND NOT EXISTS (SELECT 1 FROM traps t
                      WHERE t.trap_id = NEW.trap_id AND (SELECT now_ms FROM db_clock) >= t.expires_at_ms);
  SELECT RAISE(ABORT, 'fixes: bounty fixes need a live claim lease')
   WHERE NEW.fix_source = 'internal_bounty'
     AND NOT EXISTS (SELECT 1 FROM bounty_claims c
                      WHERE c.trap_id = NEW.trap_id AND c.agent_key = NEW.agent_key
                        AND c.lease_expires_at_ms > (SELECT now_ms FROM db_clock));

  -- Unpaired ALLOWs must agree with the trap ledger.
  SELECT RAISE(ABORT, 'fixes: an open trap exists for this task, the ALLOW must pair')
   WHERE NEW.pairing_outcome = 'unpaired_no_trap'
     AND EXISTS (SELECT 1 FROM traps t
                  WHERE t.agent_key = NEW.agent_key AND t.domain = NEW.domain
                    AND t.tool_name = NEW.tool_name AND t.task_fingerprint = NEW.task_fingerprint
                    AND t.expires_at_ms > (SELECT now_ms FROM db_clock)
                    AND NOT EXISTS (SELECT 1 FROM fixes f WHERE f.trap_id = t.trap_id));
  SELECT RAISE(ABORT, 'fixes: unpaired_expired needs an expired trap for this task')
   WHERE NEW.pairing_outcome = 'unpaired_expired'
     AND NOT EXISTS (SELECT 1 FROM traps t
                      WHERE t.agent_key = NEW.agent_key AND t.domain = NEW.domain
                        AND t.tool_name = NEW.tool_name AND t.task_fingerprint = NEW.task_fingerprint
                        AND t.expires_at_ms <= (SELECT now_ms FROM db_clock));
END;

-- ════════════════════════════════════════════════════════════════════════
-- Lesson rules
-- ════════════════════════════════════════════════════════════════════════

CREATE TRIGGER lessons_guard_insert BEFORE INSERT ON lessons
BEGIN
  SELECT RAISE(ABORT, 'lessons: lesson, trap, fix or dedup key already used')
   WHERE EXISTS (SELECT 1 FROM lessons
                  WHERE lesson_id = NEW.lesson_id OR trap_id = NEW.trap_id OR fix_event_id = NEW.fix_event_id
                     OR (domain = NEW.domain AND tool_name = NEW.tool_name
                         AND task_fingerprint = NEW.task_fingerprint AND violation_rule = NEW.violation_rule));
  -- Lesson = complete pair: the fix pairs this trap and the trap event is its first BLOCK.
  SELECT RAISE(ABORT, 'lessons: fix is not paired with this trap')
   WHERE NOT EXISTS (SELECT 1 FROM fixes f WHERE f.allow_receipt_id = NEW.fix_event_id AND f.trap_id = NEW.trap_id);
  SELECT RAISE(ABORT, 'lessons: trap_event_id must be attempt 1 of this trap')
   WHERE NOT EXISTS (SELECT 1 FROM trap_events e
                      WHERE e.block_receipt_id = NEW.trap_event_id AND e.trap_id = NEW.trap_id
                        AND e.attempt_seq = 1);
  SELECT RAISE(ABORT, 'lessons: domain, tool or task fingerprint differs from the trap')
   WHERE NOT EXISTS (SELECT 1 FROM traps t
                      WHERE t.trap_id = NEW.trap_id AND t.domain = NEW.domain
                        AND t.tool_name = NEW.tool_name AND t.task_fingerprint = NEW.task_fingerprint);
  SELECT RAISE(ABORT, 'lessons: violation_rule differs from the signed BLOCK')
   WHERE NOT EXISTS (SELECT 1 FROM trap_events e
                      WHERE e.block_receipt_id = NEW.trap_event_id AND e.violation_rule = NEW.violation_rule);
  SELECT RAISE(ABORT, 'lessons: source_agent_key must own the trap')
   WHERE NOT EXISTS (SELECT 1 FROM traps t WHERE t.trap_id = NEW.trap_id AND t.agent_key = NEW.source_agent_key);
  SELECT RAISE(ABORT, 'lessons: provenance does not match the fix source')
   WHERE NOT EXISTS (
     SELECT 1 FROM fixes f
      WHERE f.allow_receipt_id = NEW.fix_event_id
        AND ((f.fix_source = 'community' AND NEW.provenance = 'community')
          OR (f.fix_source = 'admin_seed' AND NEW.provenance = 'admin_seed')
          OR (f.fix_source = 'internal_bounty' AND NEW.provenance = 'community_trap+internal_fix'
              AND NEW.fixed_by_key = f.agent_key)));
END;

CREATE TRIGGER lessons_project AFTER INSERT ON lessons
BEGIN
  INSERT INTO lesson_state (lesson_id, review_status, visibility, audit_status, display_title,
                            display_summary, featured, vector_desired_version, vector_synced_version,
                            updated_at_ms)
  VALUES (NEW.lesson_id, 'pending_triage', 'none', 'none', NULL, NULL, 0, 0, 0, NEW.created_at_ms);
END;

CREATE TRIGGER lesson_state_guard_insert BEFORE INSERT ON lesson_state
BEGIN
  SELECT RAISE(ABORT, 'lesson_state: projection row already exists')
   WHERE EXISTS (SELECT 1 FROM lesson_state WHERE lesson_id = NEW.lesson_id);
END;

-- Each visibility change needs a new Vectorize operation (upsert or delete).
CREATE TRIGGER lesson_state_vector_bump AFTER UPDATE OF visibility ON lesson_state
WHEN NEW.visibility IS NOT OLD.visibility
BEGIN
  UPDATE lesson_state SET vector_desired_version = OLD.vector_desired_version + 1
   WHERE lesson_id = NEW.lesson_id;
END;

CREATE TRIGGER lesson_corroborations_guard_insert BEFORE INSERT ON lesson_corroborations
BEGIN
  SELECT RAISE(ABORT, 'lesson_corroborations: corroboration, trap or fix already used')
   WHERE EXISTS (SELECT 1 FROM lesson_corroborations
                  WHERE corroboration_id = NEW.corroboration_id OR trap_id = NEW.trap_id
                     OR fix_event_id = NEW.fix_event_id);
  SELECT RAISE(ABORT, 'lesson_corroborations: fix is not paired with this trap')
   WHERE NOT EXISTS (SELECT 1 FROM fixes f WHERE f.allow_receipt_id = NEW.fix_event_id AND f.trap_id = NEW.trap_id);
  SELECT RAISE(ABORT, 'lesson_corroborations: agent_key must own the trap')
   WHERE NOT EXISTS (SELECT 1 FROM traps t WHERE t.trap_id = NEW.trap_id AND t.agent_key = NEW.agent_key);
  SELECT RAISE(ABORT, 'lesson_corroborations: trap describes a different task than the lesson')
   WHERE NOT EXISTS (SELECT 1 FROM traps t JOIN lessons l ON l.lesson_id = NEW.lesson_id
                      WHERE t.trap_id = NEW.trap_id AND t.domain = l.domain AND t.tool_name = l.tool_name
                        AND t.task_fingerprint = l.task_fingerprint AND t.trap_id <> l.trap_id);
END;

-- ════════════════════════════════════════════════════════════════════════
-- Review state machine
--
--   pending_triage --triage_pass--> pending_review   (submitter-only visibility)
--   pending_triage --triage_fail--> quarantined      (bounty lessons: pending_review)
--   pending_review | quarantined --approve--> approved (public)
--   pending_review | quarantined --reject--> rejected  (terminal)
--   pending_triage | pending_review | approved --quarantine--> quarantined
--   approved bounty lesson: sample_for_audit, then audit_pass or audit_reject
--   audit_reject: rejected, and the fixing key loses auto-approval
-- internal_auto may approve only a bounty lesson that passed triage while the
-- fixing key still has auto-approval enabled.
-- ════════════════════════════════════════════════════════════════════════

CREATE TRIGGER triage_checks_guard_insert BEFORE INSERT ON triage_checks
BEGIN
  SELECT RAISE(ABORT, 'triage_checks: check already recorded')
   WHERE EXISTS (SELECT 1 FROM triage_checks WHERE lesson_id = NEW.lesson_id AND check_name = NEW.check_name);
  SELECT RAISE(ABORT, 'triage_checks: lesson is no longer awaiting triage')
   WHERE NOT EXISTS (SELECT 1 FROM lesson_state
                      WHERE lesson_id = NEW.lesson_id AND review_status = 'pending_triage');
END;

CREATE TRIGGER review_events_guard_insert BEFORE INSERT ON review_events
BEGIN
  SELECT RAISE(ABORT, 'review_events: event_id already exists')
   WHERE EXISTS (SELECT 1 FROM review_events WHERE event_id = NEW.event_id);
  SELECT RAISE(ABORT, 'review_events: triage applies only to lessons awaiting triage')
   WHERE NEW.action IN ('triage_pass', 'triage_fail')
     AND NOT EXISTS (SELECT 1 FROM lesson_state
                      WHERE lesson_id = NEW.lesson_id AND review_status = 'pending_triage');
  SELECT RAISE(ABORT, 'review_events: approve and reject need a lesson in review or quarantine')
   WHERE NEW.action IN ('approve', 'reject')
     AND NOT EXISTS (SELECT 1 FROM lesson_state
                      WHERE lesson_id = NEW.lesson_id AND review_status IN ('pending_review', 'quarantined'));
  SELECT RAISE(ABORT, 'review_events: internal auto-approval is not permitted for this lesson')
   WHERE NEW.action = 'approve' AND NEW.actor_type = 'internal_auto'
     AND NOT EXISTS (
       SELECT 1 FROM lessons l
         JOIN lesson_state ls ON ls.lesson_id = l.lesson_id
         JOIN agent_state s ON s.agent_key = l.fixed_by_key
        WHERE l.lesson_id = NEW.lesson_id
          AND l.provenance = 'community_trap+internal_fix'
          AND ls.review_status = 'pending_review'
          AND s.auto_approve_enabled = 1
          AND EXISTS (SELECT 1 FROM review_events r
                       WHERE r.lesson_id = l.lesson_id AND r.action = 'triage_pass'));
  SELECT RAISE(ABORT, 'review_events: lesson cannot be quarantined from its current state')
   WHERE NEW.action = 'quarantine'
     AND NOT EXISTS (SELECT 1 FROM lesson_state
                      WHERE lesson_id = NEW.lesson_id
                        AND review_status IN ('pending_triage', 'pending_review', 'approved'));
  SELECT RAISE(ABORT, 'review_events: only approved, unaudited bounty lessons can be sampled')
   WHERE NEW.action = 'sample_for_audit'
     AND NOT EXISTS (SELECT 1 FROM lessons l JOIN lesson_state ls ON ls.lesson_id = l.lesson_id
                      WHERE l.lesson_id = NEW.lesson_id AND l.provenance = 'community_trap+internal_fix'
                        AND ls.review_status = 'approved' AND ls.audit_status = 'none');
  SELECT RAISE(ABORT, 'review_events: lesson is not sampled for audit')
   WHERE NEW.action IN ('audit_pass', 'audit_reject')
     AND NOT EXISTS (SELECT 1 FROM lesson_state
                      WHERE lesson_id = NEW.lesson_id AND audit_status = 'sampled'
                        AND review_status = 'approved');
  SELECT RAISE(ABORT, 'review_events: rejected lessons cannot be edited')
   WHERE NEW.action = 'set_editorial'
     AND EXISTS (SELECT 1 FROM lesson_state WHERE lesson_id = NEW.lesson_id AND review_status = 'rejected');
  SELECT RAISE(ABORT, 'review_events: editorial fields must be strings or null')
   WHERE NEW.action = 'set_editorial'
     AND (coalesce(json_type(NEW.details_json, '$.display_title'), 'null') NOT IN ('text', 'null')
       OR coalesce(json_type(NEW.details_json, '$.display_summary'), 'null') NOT IN ('text', 'null'));
  SELECT RAISE(ABORT, 'review_events: only approved, unfeatured lessons can be featured')
   WHERE NEW.action = 'feature'
     AND NOT EXISTS (SELECT 1 FROM lesson_state
                      WHERE lesson_id = NEW.lesson_id AND review_status = 'approved' AND featured = 0);
  SELECT RAISE(ABORT, 'review_events: lesson is not featured')
   WHERE NEW.action = 'unfeature'
     AND NOT EXISTS (SELECT 1 FROM lesson_state WHERE lesson_id = NEW.lesson_id AND featured = 1);
END;

CREATE TRIGGER review_events_project AFTER INSERT ON review_events
BEGIN
  UPDATE lesson_state
     SET review_status = 'pending_review',
         visibility = (SELECT submitter_visibility FROM lessons WHERE lesson_id = NEW.lesson_id),
         updated_at_ms = NEW.at_ms
   WHERE lesson_id = NEW.lesson_id
     AND (NEW.action = 'triage_pass'
          OR (NEW.action = 'triage_fail'
              AND EXISTS (SELECT 1 FROM lessons WHERE lesson_id = NEW.lesson_id
                                                  AND provenance = 'community_trap+internal_fix')));

  UPDATE lesson_state
     SET review_status = 'quarantined', visibility = 'none', featured = 0, updated_at_ms = NEW.at_ms
   WHERE lesson_id = NEW.lesson_id
     AND (NEW.action = 'quarantine'
          OR (NEW.action = 'triage_fail'
              AND NOT EXISTS (SELECT 1 FROM lessons WHERE lesson_id = NEW.lesson_id
                                                      AND provenance = 'community_trap+internal_fix')));

  UPDATE lesson_state
     SET review_status = 'approved', visibility = 'public', updated_at_ms = NEW.at_ms
   WHERE lesson_id = NEW.lesson_id AND NEW.action = 'approve';

  UPDATE lesson_state
     SET review_status = 'rejected', visibility = 'none', featured = 0,
         audit_status = iif(NEW.action = 'audit_reject', 'failed', audit_status),
         updated_at_ms = NEW.at_ms
   WHERE lesson_id = NEW.lesson_id AND NEW.action IN ('reject', 'audit_reject');

  UPDATE lesson_state
     SET audit_status = iif(NEW.action = 'sample_for_audit', 'sampled', 'passed'), updated_at_ms = NEW.at_ms
   WHERE lesson_id = NEW.lesson_id AND NEW.action IN ('sample_for_audit', 'audit_pass');

  UPDATE lesson_state
     SET display_title = iif(json_type(NEW.details_json, '$.display_title') IS NULL, display_title,
                             json_extract(NEW.details_json, '$.display_title')),
         display_summary = iif(json_type(NEW.details_json, '$.display_summary') IS NULL, display_summary,
                               json_extract(NEW.details_json, '$.display_summary')),
         updated_at_ms = NEW.at_ms
   WHERE lesson_id = NEW.lesson_id AND NEW.action = 'set_editorial';

  UPDATE lesson_state
     SET featured = iif(NEW.action = 'feature', 1, 0), updated_at_ms = NEW.at_ms
   WHERE lesson_id = NEW.lesson_id AND NEW.action IN ('feature', 'unfeature');

  -- Submitter reputation counters.
  UPDATE agent_state SET approved_count = approved_count + 1
   WHERE NEW.action = 'approve'
     AND agent_key = (SELECT source_agent_key FROM lessons WHERE lesson_id = NEW.lesson_id);
  UPDATE agent_state SET rejected_count = rejected_count + 1
   WHERE NEW.action IN ('reject', 'audit_reject')
     AND agent_key = (SELECT source_agent_key FROM lessons WHERE lesson_id = NEW.lesson_id);

  -- A failed audit pauses auto-approval for the key that wrote the fix.
  INSERT INTO agent_events (event_id, agent_key, kind, related_agent_key, actor, reason, at_ms)
  SELECT (SELECT id FROM db_uuid_v4), s.agent_key, 'auto_approve_paused', NULL, NEW.actor_id,
         'audit_reject on lesson ' || NEW.lesson_id, (SELECT now_ms FROM db_clock)
    FROM lessons l JOIN agent_state s ON s.agent_key = l.fixed_by_key
   WHERE NEW.action = 'audit_reject' AND l.lesson_id = NEW.lesson_id AND s.auto_approve_enabled = 1;
END;

CREATE TRIGGER vector_sync_events_guard_insert BEFORE INSERT ON vector_sync_events
BEGIN
  SELECT RAISE(ABORT, 'vector_sync_events: version already acknowledged')
   WHERE EXISTS (SELECT 1 FROM vector_sync_events WHERE lesson_id = NEW.lesson_id AND version = NEW.version);
  SELECT RAISE(ABORT, 'vector_sync_events: version must be above synced and at most desired')
   WHERE NOT EXISTS (SELECT 1 FROM lesson_state
                      WHERE lesson_id = NEW.lesson_id
                        AND NEW.version > vector_synced_version AND NEW.version <= vector_desired_version);
  SELECT RAISE(ABORT, 'vector_sync_events: operation does not match the current visibility')
   WHERE EXISTS (SELECT 1 FROM lesson_state
                  WHERE lesson_id = NEW.lesson_id AND NEW.version = vector_desired_version
                    AND NEW.operation <> iif(visibility = 'none', 'delete', 'upsert'));
END;

CREATE TRIGGER vector_sync_events_project AFTER INSERT ON vector_sync_events
BEGIN
  UPDATE lesson_state SET vector_synced_version = NEW.version WHERE lesson_id = NEW.lesson_id;
END;

-- ════════════════════════════════════════════════════════════════════════
-- Append-only: no UPDATE on any ledger table
-- ════════════════════════════════════════════════════════════════════════

CREATE TRIGGER pow_challenges_no_update BEFORE UPDATE ON pow_challenges
BEGIN SELECT RAISE(ABORT, 'pow_challenges is append-only'); END;
CREATE TRIGGER agent_identities_no_update BEFORE UPDATE ON agent_identities
BEGIN SELECT RAISE(ABORT, 'agent_identities is append-only'); END;
CREATE TRIGGER agent_events_no_update BEFORE UPDATE ON agent_events
BEGIN SELECT RAISE(ABORT, 'agent_events is append-only'); END;
CREATE TRIGGER calibration_attempts_no_update BEFORE UPDATE ON calibration_attempts
BEGIN SELECT RAISE(ABORT, 'calibration_attempts is append-only'); END;
CREATE TRIGGER seed_runs_no_update BEFORE UPDATE ON seed_runs
BEGIN SELECT RAISE(ABORT, 'seed_runs is append-only'); END;
CREATE TRIGGER seed_run_events_no_update BEFORE UPDATE ON seed_run_events
BEGIN SELECT RAISE(ABORT, 'seed_run_events is append-only'); END;
CREATE TRIGGER traps_no_update BEFORE UPDATE ON traps
BEGIN SELECT RAISE(ABORT, 'traps is append-only'); END;
CREATE TRIGGER trap_events_no_update BEFORE UPDATE ON trap_events
BEGIN SELECT RAISE(ABORT, 'trap_events is append-only'); END;
CREATE TRIGGER bounty_claims_no_update BEFORE UPDATE ON bounty_claims
BEGIN SELECT RAISE(ABORT, 'bounty_claims is append-only'); END;
CREATE TRIGGER fixes_no_update BEFORE UPDATE ON fixes
BEGIN SELECT RAISE(ABORT, 'fixes is append-only'); END;
CREATE TRIGGER lessons_no_update BEFORE UPDATE ON lessons
BEGIN SELECT RAISE(ABORT, 'lessons is append-only'); END;
CREATE TRIGGER lesson_corroborations_no_update BEFORE UPDATE ON lesson_corroborations
BEGIN SELECT RAISE(ABORT, 'lesson_corroborations is append-only'); END;
CREATE TRIGGER triage_checks_no_update BEFORE UPDATE ON triage_checks
BEGIN SELECT RAISE(ABORT, 'triage_checks is append-only'); END;
CREATE TRIGGER review_events_no_update BEFORE UPDATE ON review_events
BEGIN SELECT RAISE(ABORT, 'review_events is append-only'); END;
CREATE TRIGGER vector_sync_events_no_update BEFORE UPDATE ON vector_sync_events
BEGIN SELECT RAISE(ABORT, 'vector_sync_events is append-only'); END;
CREATE TRIGGER lesson_deliveries_no_update BEFORE UPDATE ON lesson_deliveries
BEGIN SELECT RAISE(ABORT, 'lesson_deliveries is append-only'); END;
CREATE TRIGGER feedback_events_no_update BEFORE UPDATE ON feedback_events
BEGIN SELECT RAISE(ABORT, 'feedback_events is append-only'); END;
CREATE TRIGGER domain_demand_no_update BEFORE UPDATE ON domain_demand
BEGIN SELECT RAISE(ABORT, 'domain_demand is append-only'); END;

-- ════════════════════════════════════════════════════════════════════════
-- Retention: permanent tables never delete, purgeable tables only past their floor.
-- ON DELETE RESTRICT keeps any row a lesson or corroboration still references.
-- ════════════════════════════════════════════════════════════════════════

CREATE TRIGGER agent_identities_no_delete BEFORE DELETE ON agent_identities
BEGIN SELECT RAISE(ABORT, 'agent_identities is permanent'); END;
CREATE TRIGGER agent_state_no_delete BEFORE DELETE ON agent_state
BEGIN SELECT RAISE(ABORT, 'agent_state is permanent'); END;
CREATE TRIGGER agent_events_no_delete BEFORE DELETE ON agent_events
BEGIN SELECT RAISE(ABORT, 'agent_events is permanent'); END;
CREATE TRIGGER seed_runs_no_delete BEFORE DELETE ON seed_runs
BEGIN SELECT RAISE(ABORT, 'seed_runs is permanent'); END;
CREATE TRIGGER seed_run_events_no_delete BEFORE DELETE ON seed_run_events
BEGIN SELECT RAISE(ABORT, 'seed_run_events is permanent'); END;
CREATE TRIGGER lessons_no_delete BEFORE DELETE ON lessons
BEGIN SELECT RAISE(ABORT, 'lessons is permanent'); END;
CREATE TRIGGER lesson_state_no_delete BEFORE DELETE ON lesson_state
BEGIN SELECT RAISE(ABORT, 'lesson_state is permanent'); END;
CREATE TRIGGER lesson_corroborations_no_delete BEFORE DELETE ON lesson_corroborations
BEGIN SELECT RAISE(ABORT, 'lesson_corroborations is permanent'); END;
CREATE TRIGGER triage_checks_no_delete BEFORE DELETE ON triage_checks
BEGIN SELECT RAISE(ABORT, 'triage_checks is permanent'); END;
CREATE TRIGGER review_events_no_delete BEFORE DELETE ON review_events
BEGIN SELECT RAISE(ABORT, 'review_events is permanent'); END;
CREATE TRIGGER vector_sync_events_no_delete BEFORE DELETE ON vector_sync_events
BEGIN SELECT RAISE(ABORT, 'vector_sync_events is permanent'); END;
CREATE TRIGGER feedback_events_no_delete BEFORE DELETE ON feedback_events
BEGIN SELECT RAISE(ABORT, 'feedback_events is permanent'); END;

-- 30 days
CREATE TRIGGER calibration_attempts_retention BEFORE DELETE ON calibration_attempts
BEGIN
  SELECT RAISE(ABORT, 'calibration_attempts: rows are kept for 30 days')
   WHERE OLD.created_at_ms >= (SELECT now_ms FROM db_clock) - 2592000000;
END;
CREATE TRIGGER lesson_deliveries_retention BEFORE DELETE ON lesson_deliveries
BEGIN
  SELECT RAISE(ABORT, 'lesson_deliveries: rows are kept for 30 days')
   WHERE OLD.first_served_at_ms >= (SELECT now_ms FROM db_clock) - 2592000000;
END;
CREATE TRIGGER domain_demand_retention BEFORE DELETE ON domain_demand
BEGIN
  SELECT RAISE(ABORT, 'domain_demand: rows are kept for 30 days')
   WHERE OLD.created_at_ms >= (SELECT now_ms FROM db_clock) - 2592000000;
END;

-- 90 days, and only when nothing references the row
CREATE TRIGGER traps_retention BEFORE DELETE ON traps
BEGIN
  SELECT RAISE(ABORT, 'traps: rows are kept for 90 days')
   WHERE OLD.opened_at_ms >= (SELECT now_ms FROM db_clock) - 7776000000;
END;
CREATE TRIGGER trap_events_retention BEFORE DELETE ON trap_events
BEGIN
  SELECT RAISE(ABORT, 'trap_events: rows are kept for 90 days')
   WHERE OLD.recorded_at_ms >= (SELECT now_ms FROM db_clock) - 7776000000;
END;
CREATE TRIGGER bounty_claims_retention BEFORE DELETE ON bounty_claims
BEGIN
  SELECT RAISE(ABORT, 'bounty_claims: rows are kept for 90 days')
   WHERE OLD.claimed_at_ms >= (SELECT now_ms FROM db_clock) - 7776000000;
END;
CREATE TRIGGER fixes_retention BEFORE DELETE ON fixes
BEGIN
  SELECT RAISE(ABORT, 'fixes: rows are kept for 90 days')
   WHERE OLD.recorded_at_ms >= (SELECT now_ms FROM db_clock) - 7776000000;
END;

-- 1 day after expiry. Redeemed challenges stay (agent_identities RESTRICT).
CREATE TRIGGER pow_challenges_retention BEFORE DELETE ON pow_challenges
BEGIN
  SELECT RAISE(ABORT, 'pow_challenges: rows are kept until 1 day after expiry')
   WHERE OLD.expires_at_ms >= (SELECT now_ms FROM db_clock) - 86400000;
END;
