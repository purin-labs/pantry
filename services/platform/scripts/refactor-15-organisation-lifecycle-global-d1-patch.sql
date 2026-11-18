-- Refactor 15, refactor 5: the Organisation lifecycle and the purge.
-- Alters table organisation: the directory copy of the status takes
-- 'purged', as the regional row does. The column is swapped (a new column
-- with the new CHECK, a copy, a drop, a rename) because SQLite cannot change
-- a CHECK in place and other tables refer to organisation.
-- Alters trigger slack_installation_identity_immutable: the installation's
-- credential owner may move. A purge moves the bot token to an Organisation
-- that still uses the workspace, and a new Organisation that connects a
-- workspace with no live owner becomes its owner.
-- Apply to the deployed GLOBAL database (and a local combined database)
-- before the release:
--   wrangler d1 execute <global database> --env production --remote --file services/platform/scripts/refactor-15-organisation-lifecycle-global-d1-patch.sql
-- Apply the regional patch first. The script is safe to repeat: a second run
-- swaps the column again with the same values.
ALTER TABLE organisation ADD COLUMN status_next TEXT NOT NULL DEFAULT 'active'
  CHECK (status_next IN ('active', 'suspended', 'deleted', 'purged'));
UPDATE organisation SET status_next = status;
ALTER TABLE organisation DROP COLUMN status;
ALTER TABLE organisation RENAME COLUMN status_next TO status;

-- The purge named the row 'Archived organisation'; an owner's deletion names
-- it 'Deleted organisation' and keeps it archived until its purge.
UPDATE organisation SET status = 'purged', organisation_handle = NULL
WHERE status = 'deleted' AND name = 'Archived organisation';

DROP TRIGGER IF EXISTS slack_installation_identity_immutable;
CREATE TRIGGER slack_installation_identity_immutable
BEFORE UPDATE OF installation_id, environment, app_id, workspace_id,
  installed_at
ON slack_installation
BEGIN
  SELECT RAISE(ABORT, 'slack_installation_identity_immutable');
END;
