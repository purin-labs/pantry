-- One-time organisation D1 schema patch for Refactor 9 steps 2 and 5: the origin
-- of each Case and the receipts of general Project commands and Case moves.
--
-- Additive: it keeps every row. Run it once per organisation database, before
-- the deploy that needs it and after refactor-9-d1-chat-placement-patch.sql:
--   pnpm exec wrangler d1 execute ORGANISATION_DB_WNAM --env production --remote --file scripts/refactor-9-d1-commands-patch.sql
--   pnpm exec wrangler d1 execute ORGANISATION_DB_APAC --env production --remote --file scripts/refactor-9-d1-commands-patch.sql
--
-- A second run fails on the first statement and changes nothing.
ALTER TABLE case_project ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'direct' CHECK (origin_kind IN ('portal_chat', 'canvas_chat', 'direct', 'slack', 'email', 'whatsapp', 'inbox_assistant', 'commerce_approval'));

-- A Case that a chat presents was admitted by that chat.
UPDATE case_project SET origin_kind = (
  SELECT CASE c.access_kind WHEN 'workspace_canvas' THEN 'canvas_chat' ELSE 'portal_chat' END
  FROM portal_conversation c
  WHERE c.organisation_id = case_project.organisation_id AND c.case_id = case_project.case_id
)
WHERE EXISTS (
  SELECT 1 FROM portal_conversation c
  WHERE c.organisation_id = case_project.organisation_id AND c.case_id = case_project.case_id
);

CREATE TABLE project_operation (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 160),
  command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
  project_id TEXT NOT NULL,
  case_id TEXT,
  -- The revision the command produced: of the Project, the default pointer or the Case association.
  result_revision INTEGER NOT NULL CHECK (result_revision >= 1),
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
  PRIMARY KEY (organisation_id, actor_user_id, operation_id)
);
