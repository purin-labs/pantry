-- Regional database patch (Plan 24 S4). Adds table bake_run and index
-- bake_run_one_per_proposal.
--
-- The one bake run of an approved proposal: its state, the reason that it did
-- not start, and the check of the released pieces that raised the counter
-- stock. Apply it once to each bound regional database, after
-- plan-24-bake-proposal-d1-patch.sql and before the release.
-- Plan 24 S4: the one bake run of an approved proposal. The run's Durable
-- Object (actor_id) holds its engine state and its dispatch records; this row
-- is the summary that the Bakes page lists, the reason that a run did not
-- start, and the person's check of the released pieces that raised the
-- counter stock through Commerce.
CREATE TABLE IF NOT EXISTS bake_run (
  run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 64),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  proposal_id TEXT NOT NULL REFERENCES bake_proposal (proposal_id),
  actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('not_started', 'running', 'paused', 'held', 'completed', 'stopped', 'checked')),
  problem_code TEXT CHECK (problem_code IS NULL OR length(problem_code) BETWEEN 1 AND 64),
  problem_text TEXT CHECK (problem_text IS NULL OR length(problem_text) BETWEEN 1 AND 500),
  hold_code TEXT CHECK (hold_code IS NULL OR length(hold_code) BETWEEN 1 AND 64),
  started_at INTEGER,
  ended_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  checked_by TEXT,
  checked_role TEXT CHECK (checked_role IS NULL OR checked_role IN ('owner', 'admin', 'operator')),
  checked_at INTEGER,
  good_pieces INTEGER CHECK (good_pieces IS NULL OR good_pieces BETWEEN 0 AND 10000),
  stock_receipt_id TEXT,
  CHECK ((state = 'not_started') = (problem_code IS NOT NULL)),
  CHECK ((state = 'checked') = (checked_at IS NOT NULL)),
  CHECK (checked_at IS NULL OR (checked_by IS NOT NULL AND checked_role IS NOT NULL AND good_pieces IS NOT NULL AND stock_receipt_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS bake_run_one_per_proposal
  ON bake_run (organisation_id, proposal_id);
