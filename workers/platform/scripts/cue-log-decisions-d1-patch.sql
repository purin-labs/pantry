-- The cue log keeps only what the cue delivery writes: the decision check
-- accepts 'store_only', 'matched' and 'proposed', and the columns
-- session_id, actor_person_id and response_text, which were always NULL,
-- are gone.
-- Apply ONE time to each deployed REGIONAL database after the release whose
-- Worker no longer names the three columns:
--   wrangler d1 execute <regional database> --env production --remote --file workers/platform/scripts/cue-log-decisions-d1-patch.sql
-- Alters table cue_log. SQLite cannot change a check, so the patch copies the
-- rows into a new table. It creates the indexes idx_cue_dedup and
-- idx_cue_proposal_surface_thread again, and drops idx_cue_response_native,
-- which held only 'respond' rows.
-- Before you apply it, check that no row holds another decision:
--   SELECT decision, COUNT(*) FROM cue_log GROUP BY decision;
-- A row with 'ignore', 'triage' or 'respond' fails the copy.
PRAGMA foreign_keys = OFF;

ALTER TABLE cue_log RENAME TO cue_log_decisions_old;
DROP INDEX IF EXISTS idx_cue_dedup;
DROP INDEX IF EXISTS idx_cue_proposal_surface_thread;
DROP INDEX IF EXISTS idx_cue_response_native;

CREATE TABLE cue_log (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  cue_id TEXT NOT NULL,
  source TEXT NOT NULL,
  native_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (
    decision IN ('store_only', 'matched', 'proposed')
  ),
  reason TEXT,
  at INTEGER NOT NULL, parent_cue_id TEXT, surface_kind TEXT, surface_thread_id TEXT, integration_account_id TEXT REFERENCES integration_account (integration_account_id),
  PRIMARY KEY (organisation_id, cue_id)
);

INSERT INTO cue_log (
  organisation_id, cue_id, source, native_id, decision, reason, at,
  parent_cue_id, surface_kind, surface_thread_id, integration_account_id
)
SELECT
  organisation_id, cue_id, source, native_id, decision, reason, at,
  parent_cue_id, surface_kind, surface_thread_id, integration_account_id
FROM cue_log_decisions_old;
DROP TABLE cue_log_decisions_old;

CREATE INDEX idx_cue_dedup ON cue_log (organisation_id, source, native_id);
CREATE INDEX idx_cue_proposal_surface_thread
  ON cue_log (organisation_id, decision, surface_kind, surface_thread_id, at);

PRAGMA foreign_keys = ON;
