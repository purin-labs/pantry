-- Regional database patch (Plan 84). Adds tables bakery_workflow and
-- bakery_workflow_revision, and index idx_bakery_workflow_revision_digest.
--
-- A recipe's applied workflow: the index of its immutable revisions in R2, and
-- the receipt of each apply. An approved agent proposal adds its draft, Session,
-- turn and operation to the receipt.
--
-- Apply it once to each bound regional database, before the release.
CREATE TABLE IF NOT EXISTS bakery_workflow (
  organisation_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 128),
  recipe TEXT NOT NULL CHECK (length(recipe) BETWEEN 1 AND 100),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, workflow_id)
);

CREATE TABLE IF NOT EXISTS bakery_workflow_revision (
  organisation_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  base_digest TEXT CHECK (base_digest IS NULL OR length(base_digest) = 64),
  scenario_digest TEXT NOT NULL CHECK (length(scenario_digest) = 64),
  applied_by TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  -- An approved proposal: its draft and the agent turn that wrote it.
  proposal_id TEXT,
  session_id TEXT,
  turn_id TEXT,
  operation_id TEXT,
  PRIMARY KEY (organisation_id, workflow_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_bakery_workflow_revision_digest
  ON bakery_workflow_revision (organisation_id, workflow_id, digest);
