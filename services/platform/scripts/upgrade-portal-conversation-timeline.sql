-- One-time upgrade from the deployed conversation-directory schema to the
-- canonical timeline projection. The current baseline already contains these
-- columns; this script preserves conversations in an existing D1 database.
ALTER TABLE portal_conversation
  ADD COLUMN state_format INTEGER NOT NULL DEFAULT 1 CHECK (state_format >= 1);
ALTER TABLE portal_conversation
  ADD COLUMN title_normalized TEXT NOT NULL DEFAULT '' CHECK (length(title_normalized) <= 160);
ALTER TABLE portal_conversation
  ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0 CHECK (last_activity_at >= 0);
ALTER TABLE portal_conversation
  ADD COLUMN latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0);
ALTER TABLE portal_conversation
  ADD COLUMN last_read_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0 AND last_read_sequence <= latest_sequence);
ALTER TABLE portal_conversation
  ADD COLUMN draft_text TEXT NOT NULL DEFAULT '' CHECK (length(draft_text) <= 8000);
ALTER TABLE portal_conversation
  ADD COLUMN draft_updated_at INTEGER;

UPDATE portal_conversation
SET title_normalized = lower(trim(json_extract(state_json, '$.title'))),
    last_activity_at = updated_at;

DROP INDEX idx_portal_conversation_active;
DROP INDEX idx_portal_conversation_archived;

CREATE INDEX idx_portal_conversation_active
  ON portal_conversation (
    organisation_id,
    user_id,
    pinned_at DESC,
    last_activity_at DESC,
    title_normalized ASC,
    conversation_id ASC
  )
  WHERE lifecycle = 'active';
CREATE INDEX idx_portal_conversation_archived
  ON portal_conversation (
    organisation_id,
    user_id,
    archived_at DESC,
    title_normalized ASC,
    conversation_id ASC
  )
  WHERE lifecycle = 'archived';
