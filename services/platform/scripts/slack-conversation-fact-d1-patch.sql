-- Plan 27C step 2: what Slack says about each connected conversation.
-- Apply to each deployed REGIONAL database before the release that reads it:
--   wrangler d1 execute <regional database> --env production --remote --file services/platform/scripts/slack-conversation-fact-d1-patch.sql
-- Adds table slack_conversation_fact. The statement is safe to repeat.
CREATE TABLE IF NOT EXISTS slack_conversation_fact (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  channel_id TEXT NOT NULL,
  is_private INTEGER NOT NULL CHECK (is_private IN (0, 1)),
  reaches_outside INTEGER NOT NULL CHECK (reaches_outside IN (0, 1)),
  member_ids_json TEXT,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, channel_id)
) STRICT;
