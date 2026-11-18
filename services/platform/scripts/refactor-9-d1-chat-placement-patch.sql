-- One-time organisation D1 schema patch for Refactor 9 step 4: a chat reads its
-- Project from its Case's association and keeps no placement of its own.
--
-- Run it once per organisation database, immediately before the deploy that
-- needs it, after refactor-9-d1-schema-patch.sql and refactor-9-d1-patch.sql:
--   pnpm exec wrangler d1 execute ORGANISATION_DB_WNAM --env production --remote --file scripts/refactor-9-d1-chat-placement-patch.sql
--   pnpm exec wrangler d1 execute ORGANISATION_DB_APAC --env production --remote --file scripts/refactor-9-d1-chat-placement-patch.sql
--
-- The chat table is replaced, not converted: existing chats are test data and
-- the reset rule covers them. Dropping the table also removes the rows that
-- cascade from it, so the patch refuses to start while any chat exists: the
-- insert below fails its CHECK before anything is changed. A remote file runs
-- as one unit, so a failure leaves the database as it was.
CREATE TABLE IF NOT EXISTS refactor_9_patch_guard (
  portal_conversation_rows INTEGER NOT NULL,
  CONSTRAINT portal_conversation_must_be_empty CHECK (portal_conversation_rows = 0)
);
INSERT INTO refactor_9_patch_guard SELECT COUNT(*) FROM portal_conversation;
DROP TABLE refactor_9_patch_guard;

DROP TABLE portal_conversation;
CREATE TABLE portal_conversation (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  -- The Case this chat presents. Its Project is the Case's, in case_project.
  case_id TEXT NOT NULL,
  access_kind TEXT NOT NULL DEFAULT 'private' CHECK (access_kind IN ('private', 'shared', 'workspace_canvas')),
  canvas_document_id TEXT,
  canvas_generation INTEGER,
  active_user_id TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  state_format INTEGER NOT NULL DEFAULT 1 CHECK (state_format >= 1),
  title_normalized TEXT NOT NULL DEFAULT '' CHECK (length(title_normalized) <= 160),
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL DEFAULT 0 CHECK (last_activity_at >= 0),
  latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
  CHECK ((access_kind = 'workspace_canvas' AND canvas_document_id IS NOT NULL AND canvas_generation >= 1 AND canvas_generation IS NOT NULL) OR (access_kind <> 'workspace_canvas' AND canvas_document_id IS NULL AND canvas_generation IS NULL)),
  UNIQUE (organisation_id, canvas_document_id, canvas_generation),
  UNIQUE (organisation_id, case_id),
  PRIMARY KEY (organisation_id, conversation_id),
  FOREIGN KEY (organisation_id, case_id) REFERENCES case_project (organisation_id, case_id)
);
CREATE TRIGGER portal_conversation_shared_insert BEFORE INSERT ON portal_conversation
WHEN NEW.access_kind = 'shared' AND NOT EXISTS (
  SELECT 1 FROM case_project cp JOIN project p ON p.organisation_id = cp.organisation_id AND p.project_id = cp.project_id
  WHERE cp.organisation_id = NEW.organisation_id AND cp.case_id = NEW.case_id AND p.access_kind = 'shared'
) BEGIN SELECT RAISE(ABORT, 'shared_chat_requires_shared_project'); END;
CREATE TRIGGER portal_conversation_shared_update BEFORE UPDATE OF access_kind ON portal_conversation
WHEN NEW.access_kind = 'shared' AND NOT EXISTS (
  SELECT 1 FROM case_project cp JOIN project p ON p.organisation_id = cp.organisation_id AND p.project_id = cp.project_id
  WHERE cp.organisation_id = NEW.organisation_id AND cp.case_id = NEW.case_id AND p.access_kind = 'shared'
) BEGIN SELECT RAISE(ABORT, 'shared_chat_requires_shared_project'); END;
-- The Case of a shared chat stays in a shared Project when it moves.
CREATE TRIGGER case_project_shared_chat_move BEFORE UPDATE OF project_id ON case_project
WHEN EXISTS (
  SELECT 1 FROM portal_conversation c
  WHERE c.organisation_id = NEW.organisation_id AND c.case_id = NEW.case_id AND c.access_kind = 'shared'
) AND NOT EXISTS (
  SELECT 1 FROM project p WHERE p.organisation_id = NEW.organisation_id AND p.project_id = NEW.project_id AND p.access_kind = 'shared'
) BEGIN SELECT RAISE(ABORT, 'shared_chat_requires_shared_project'); END;
