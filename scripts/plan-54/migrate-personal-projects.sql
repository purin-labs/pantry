-- Apply after P53's canonical identity migration, in one atomic D1 batch.
-- Duplicate project IDs within an organisation abort the transaction; never guess ownership.
PRAGMA defer_foreign_keys = ON;
CREATE UNIQUE INDEX plan54_project_identity_guard ON project (organisation_id, project_id);
CREATE TABLE project_next (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT REFERENCES app_user (user_id),
  project_id TEXT NOT NULL,
  access_kind TEXT NOT NULL DEFAULT 'personal' CHECK (access_kind IN ('personal', 'shared')),
  access_revision INTEGER NOT NULL DEFAULT 0 CHECK (access_revision >= 0),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  brief TEXT NOT NULL CHECK (length(brief) <= 4000),
  references_json TEXT NOT NULL CHECK (json_valid(references_json)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content_revision INTEGER NOT NULL CHECK (content_revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, project_id),
  CHECK ((access_kind = 'personal' AND user_id IS NOT NULL)
    OR (access_kind = 'shared' AND user_id IS NULL))
);

INSERT INTO project_next (organisation_id, user_id, project_id, name, brief, references_json, revision, content_revision, created_at, updated_at) SELECT organisation_id, user_id, project_id, name, brief, references_json, revision, content_revision, created_at, updated_at FROM project;
CREATE UNIQUE INDEX plan54_conversation_identity_guard ON portal_conversation (organisation_id, conversation_id);
CREATE TABLE portal_conversation_next (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL REFERENCES app_user (user_id),
  conversation_id TEXT NOT NULL,
  access_kind TEXT NOT NULL DEFAULT 'private' CHECK (access_kind IN ('private', 'shared')),
  active_user_id TEXT REFERENCES app_user (user_id),
  project_id TEXT,
  membership_revision INTEGER NOT NULL DEFAULT 0 CHECK (membership_revision >= 0),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  state_format INTEGER NOT NULL DEFAULT 1 CHECK (state_format >= 1),
  title_normalized TEXT NOT NULL DEFAULT '' CHECK (length(title_normalized) <= 160),
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL DEFAULT 0 CHECK (last_activity_at >= 0),
  latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
  CHECK (access_kind = 'private' OR project_id IS NOT NULL),
  PRIMARY KEY (organisation_id, conversation_id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES project_next (organisation_id, project_id)
);

INSERT INTO portal_conversation_next (organisation_id, user_id, conversation_id, project_id, membership_revision, revision,
  state_json, state_format, title_normalized, updated_at, last_activity_at, latest_sequence, active_user_id)
SELECT organisation_id, user_id, conversation_id, project_id, membership_revision, revision,
  json_remove(state_json, '$.lastReadSequence', '$.draftText', '$.draftUpdatedAt'), state_format, title_normalized, updated_at, last_activity_at, latest_sequence,
  CASE WHEN json_extract(state_json, '$.work.kind') IN ('running', 'cancelling', 'awaiting_approval') THEN user_id ELSE NULL END
FROM portal_conversation;
CREATE TABLE portal_conversation_user (
  organisation_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_user (user_id),
  conversation_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
  pinned_at INTEGER,
  archived_at INTEGER,
  manual_position INTEGER NOT NULL DEFAULT 0 CHECK (manual_position >= 0),
  last_read_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
  draft_text TEXT NOT NULL DEFAULT '' CHECK (length(draft_text) <= 8000),
  draft_updated_at INTEGER,
  CHECK ((draft_text = '' AND draft_updated_at IS NULL) OR (draft_text <> '' AND draft_updated_at IS NOT NULL AND draft_updated_at >= 0)),
  CHECK ((lifecycle = 'active' AND archived_at IS NULL) OR (lifecycle = 'archived' AND archived_at IS NOT NULL)),
  PRIMARY KEY (organisation_id, user_id, conversation_id),
  FOREIGN KEY (organisation_id, conversation_id) REFERENCES portal_conversation_next (organisation_id, conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_portal_conversation_user_active ON portal_conversation_user (organisation_id, user_id, pinned_at DESC, manual_position, conversation_id) WHERE lifecycle = 'active';
CREATE INDEX idx_portal_conversation_user_archived ON portal_conversation_user (organisation_id, user_id, archived_at DESC, conversation_id) WHERE lifecycle = 'archived';


INSERT INTO portal_conversation_user (organisation_id, user_id, conversation_id, lifecycle, pinned_at, archived_at, manual_position, last_read_sequence, draft_text, draft_updated_at)
SELECT organisation_id, user_id, conversation_id, lifecycle, pinned_at, archived_at, manual_position, last_read_sequence, draft_text, draft_updated_at FROM portal_conversation;
DROP TABLE portal_conversation;
DROP TABLE project;
ALTER TABLE project_next RENAME TO project;
ALTER TABLE portal_conversation_next RENAME TO portal_conversation;
CREATE TABLE project_member (
  organisation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (organisation_id, project_id, user_id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES project (organisation_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, user_id) REFERENCES organisation_membership (organisation_id, user_id)
);
CREATE INDEX project_member_user ON project_member (organisation_id, user_id, project_id);

CREATE TABLE project_access_operation (
  organisation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES app_user (user_id),
  operation_id TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  access_revision INTEGER NOT NULL CHECK (access_revision > 0),
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, actor_user_id, operation_id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES project (organisation_id, project_id) ON DELETE CASCADE
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

CREATE TABLE portal_chat_turn_access (
  organisation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES app_user (user_id),
  project_id TEXT,
  access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
  PRIMARY KEY (organisation_id, session_id, turn_id),
  FOREIGN KEY (organisation_id, conversation_id) REFERENCES portal_conversation (organisation_id, conversation_id) ON DELETE CASCADE
);

CREATE TABLE portal_chat_conversation_access_operation (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  conversation_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES app_user (user_id),
  operation_id TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  conversation_revision INTEGER NOT NULL CHECK (conversation_revision > 0),
  project_id TEXT NOT NULL,
  access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, actor_user_id, operation_id)
);

CREATE UNIQUE INDEX portal_chat_deletion_conversation ON portal_chat_deletion (organisation_id, conversation_id);

CREATE TABLE portal_chat_directory_project (
  organisation_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_user(user_id),
  project_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  PRIMARY KEY (organisation_id, user_id, project_id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES project(organisation_id, project_id) ON DELETE CASCADE
);
