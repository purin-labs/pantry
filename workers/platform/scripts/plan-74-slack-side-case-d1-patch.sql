-- Plan 74 Phase 2: side_case_proposal holds the side Case proposals of
-- Slack thread agents too. Apply it to each deployed regional database (and
-- a local combined database) after plan-74-side-case-d1-patch.sql and before
-- the release that offers propose_side_case on Slack thread turns. Every
-- turn reads this table, so the release fails without it.
--
-- SQLite cannot make the chat columns nullable in place, so the table is
-- rebuilt: the new table is created, every row is copied as a Portal chat
-- proposal, the old table is dropped and the new one takes its name. No
-- table refers to side_case_proposal. Apply it one time. source_kind has
-- the default 'portal_chat', so Phase 1 code, which names no kind, keeps
-- writing Portal proposals.
CREATE TABLE side_case_proposal_next (
  organisation_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL CHECK (length(proposal_id) = 32),
  source_kind TEXT NOT NULL DEFAULT 'portal_chat' CHECK (source_kind IN ('portal_chat', 'slack_thread')),
  source_case_id TEXT NOT NULL,
  source_conversation_id TEXT,
  source_connector_id TEXT,
  source_workspace_id TEXT,
  source_channel_id TEXT,
  source_thread_ts TEXT,
  source_session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  requested_by_user_id TEXT,
  requested_by_person_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  brief TEXT NOT NULL CHECK (length(brief) BETWEEN 1 AND 2000),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  flow_binding_json TEXT NOT NULL CHECK (json_valid(flow_binding_json)),
  status TEXT NOT NULL CHECK (status IN ('open', 'starting', 'started', 'dismissed')),
  destination_conversation_id TEXT,
  destination_thread_ts TEXT,
  destination_case_id TEXT,
  decided_by_user_id TEXT,
  decided_by_slack_user_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, proposal_id),
  UNIQUE (organisation_id, destination_case_id),
  CHECK ((status = 'open') = (decided_by_user_id IS NULL AND decided_at IS NULL)),
  CHECK (source_kind <> 'portal_chat' OR (
    source_conversation_id IS NOT NULL AND requested_by_user_id IS NOT NULL
    AND source_connector_id IS NULL AND source_workspace_id IS NULL
    AND source_channel_id IS NULL AND source_thread_ts IS NULL
    AND requested_by_person_id IS NULL AND destination_thread_ts IS NULL
    AND decided_by_slack_user_id IS NULL
    AND (status IN ('starting', 'started')) = (destination_conversation_id IS NOT NULL AND destination_case_id IS NOT NULL))),
  CHECK (source_kind <> 'slack_thread' OR (
    source_connector_id IS NOT NULL AND source_workspace_id IS NOT NULL
    AND source_channel_id IS NOT NULL AND source_thread_ts IS NOT NULL
    AND requested_by_person_id IS NOT NULL AND source_conversation_id IS NULL
    AND requested_by_user_id IS NULL AND destination_conversation_id IS NULL
    AND status <> 'dismissed'
    AND (decided_by_slack_user_id IS NULL) = (decided_by_user_id IS NULL)
    AND (destination_thread_ts IS NULL) = (destination_case_id IS NULL)
    AND (status <> 'started' OR destination_case_id IS NOT NULL)))
);
INSERT INTO side_case_proposal_next (organisation_id, proposal_id, source_kind,
  source_case_id, source_conversation_id, source_session_id, source_turn_id,
  requested_by_user_id, title, brief, content_digest, flow_binding_json, status,
  destination_conversation_id, destination_case_id, decided_by_user_id, created_at,
  decided_at, expires_at)
SELECT organisation_id, proposal_id, 'portal_chat', source_case_id,
  source_conversation_id, source_session_id, source_turn_id, requested_by_user_id,
  title, brief, content_digest, flow_binding_json, status,
  destination_conversation_id, destination_case_id, decided_by_user_id, created_at,
  decided_at, expires_at
FROM side_case_proposal;
DROP TABLE side_case_proposal;
ALTER TABLE side_case_proposal_next RENAME TO side_case_proposal;
CREATE INDEX side_case_proposal_source ON side_case_proposal (organisation_id, source_conversation_id, created_at);
CREATE INDEX side_case_proposal_source_case ON side_case_proposal (organisation_id, source_case_id, status);
