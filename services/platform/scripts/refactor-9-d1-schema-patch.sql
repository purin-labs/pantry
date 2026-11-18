-- One-time organisation D1 schema patch: from the schema applied at the
-- 2026-10-07 regional cutover to the current regional baseline.
--
-- The baseline migration is replaced in place while D1 databases are treated
-- as disposable; a deployed database is not recreated from it. This carries
-- the two deltas the baseline gained since the cutover:
--   1. Refactor 9: the Project tables lose their portal-chat names.
--   2. Shared appliance workspaces: portal_conversation gains the
--      workspace_canvas access kind and its two columns.
--
-- Run it once per organisation database, immediately before the deploy: the
-- earlier Worker reads the old table names. A remote file runs as one unit, so
-- a failure leaves the database as it was. A second run fails on the first
-- rename and changes nothing.
--
-- Run from services/platform, then run refactor-9-d1-patch.sql:
--   pnpm exec wrangler d1 execute ORGANISATION_DB_WNAM --env production --remote --file scripts/refactor-9-d1-schema-patch.sql
--   pnpm exec wrangler d1 execute ORGANISATION_DB_APAC --env production --remote --file scripts/refactor-9-d1-schema-patch.sql

-- Step 2 replaces portal_conversation, and dropping that table also removes the
-- rows that cascade from it (portal_conversation_user, session_turn_access).
-- The patch therefore refuses to start while any conversation exists: the
-- insert below fails its CHECK before anything is changed.
CREATE TABLE IF NOT EXISTS refactor_9_patch_guard (
  portal_conversation_rows INTEGER NOT NULL,
  CONSTRAINT portal_conversation_must_be_empty CHECK (portal_conversation_rows = 0)
);
INSERT INTO refactor_9_patch_guard SELECT COUNT(*) FROM portal_conversation;
DROP TABLE refactor_9_patch_guard;

-- 1. Project tables. A rename keeps every row and rewrites the foreign keys
-- and trigger bodies that name the table.
ALTER TABLE portal_chat_project RENAME TO project;
ALTER TABLE portal_chat_project_user RENAME TO portal_chat_directory_project;
ALTER TABLE portal_chat_project_member RENAME TO project_member;
ALTER TABLE portal_chat_project_access_operation RENAME TO project_access_operation;

DROP INDEX portal_chat_project_member_user;
CREATE INDEX project_member_user ON project_member (organisation_id, user_id, project_id);

-- 2. portal_conversation. SQLite cannot change a CHECK in place, so the empty
-- table is replaced by the current definition.
DROP TABLE portal_conversation;
CREATE TABLE portal_conversation (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  access_kind TEXT NOT NULL DEFAULT 'private' CHECK (access_kind IN ('private', 'shared', 'workspace_canvas')),
  canvas_document_id TEXT,
  canvas_generation INTEGER,
  active_user_id TEXT,
  project_id TEXT,
  membership_revision INTEGER NOT NULL DEFAULT 0 CHECK (membership_revision >= 0),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  state_format INTEGER NOT NULL DEFAULT 1 CHECK (state_format >= 1),
  title_normalized TEXT NOT NULL DEFAULT '' CHECK (length(title_normalized) <= 160),
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL DEFAULT 0 CHECK (last_activity_at >= 0),
  latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
  CHECK (access_kind <> 'shared' OR project_id IS NOT NULL),
  CHECK ((access_kind = 'workspace_canvas' AND canvas_document_id IS NOT NULL AND canvas_generation >= 1 AND canvas_generation IS NOT NULL AND project_id IS NULL) OR (access_kind <> 'workspace_canvas' AND canvas_document_id IS NULL AND canvas_generation IS NULL)),
  UNIQUE (organisation_id, canvas_document_id, canvas_generation),
  PRIMARY KEY (organisation_id, conversation_id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES project (organisation_id, project_id)
);
CREATE INDEX idx_portal_conversation_project ON portal_conversation (organisation_id, project_id, conversation_id);
CREATE TRIGGER portal_conversation_shared_insert BEFORE INSERT ON portal_conversation
WHEN NEW.access_kind = 'shared' AND NOT EXISTS (
  SELECT 1 FROM project p WHERE p.organisation_id = NEW.organisation_id AND p.project_id = NEW.project_id AND p.access_kind = 'shared'
) BEGIN SELECT RAISE(ABORT, 'shared_chat_requires_shared_project'); END;
CREATE TRIGGER portal_conversation_shared_update BEFORE UPDATE OF access_kind, project_id ON portal_conversation
WHEN NEW.access_kind = 'shared' AND NOT EXISTS (
  SELECT 1 FROM project p WHERE p.organisation_id = NEW.organisation_id AND p.project_id = NEW.project_id AND p.access_kind = 'shared'
) BEGIN SELECT RAISE(ABORT, 'shared_chat_requires_shared_project'); END;
