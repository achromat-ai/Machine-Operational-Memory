-- Migration 0003: embedding text overrides
--
-- The text a lesson is embedded from is fixes.task_description, which is evidence: fixes is append-only,
-- its task_fingerprint is the SHA-256 of that text, and the fingerprint is signed into the lesson's
-- pair_attestation. A lesson whose stored description turns out to be a poor retrieval key (generic
-- boilerplate that makes unrelated lessons cluster) therefore cannot have the description edited.
--
-- lesson_embedding_text holds a replacement for the embedding step only. syncVectors embeds
-- COALESCE(lesson_embedding_text.text, fixes.task_description) and nothing else reads this table, so the
-- evidence, the fingerprints and the attestations stay exactly as they were signed.
--
-- Like every ledger table it is insert-only: one row per lesson, never updated, never deleted.
-- Setting an override does not by itself re-embed the lesson. The writer also bumps
-- lesson_state.vector_desired_version, and the 5-minute reconcile cron does the rest.

CREATE TABLE lesson_embedding_text (
  lesson_id TEXT    NOT NULL PRIMARY KEY REFERENCES lessons (lesson_id) ON DELETE RESTRICT,
  text      TEXT    NOT NULL CHECK (length(text) BETWEEN 16 AND 1000 AND text = trim(text)),
  set_at_ms INTEGER NOT NULL CHECK (set_at_ms > 0)
) STRICT;

CREATE TRIGGER lesson_embedding_text_no_update BEFORE UPDATE ON lesson_embedding_text
BEGIN SELECT RAISE(ABORT, 'lesson_embedding_text is append-only'); END;

CREATE TRIGGER lesson_embedding_text_no_delete BEFORE DELETE ON lesson_embedding_text
BEGIN SELECT RAISE(ABORT, 'lesson_embedding_text is permanent'); END;
