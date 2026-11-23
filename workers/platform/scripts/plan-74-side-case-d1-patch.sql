-- Plan 74: adds the side Case proposals of Portal chat agents. Apply to each
-- deployed regional database (and a local combined database) before the
-- release that offers the propose_side_case tool. The statements are safe to
-- repeat.
CREATE TABLE IF NOT EXISTS side_case_proposal (
  organisation_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL CHECK (length(proposal_id) = 32),
  source_case_id TEXT NOT NULL,
  source_conversation_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  brief TEXT NOT NULL CHECK (length(brief) BETWEEN 1 AND 2000),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  flow_binding_json TEXT NOT NULL CHECK (json_valid(flow_binding_json)),
  status TEXT NOT NULL CHECK (status IN ('open', 'starting', 'started', 'dismissed')),
  destination_conversation_id TEXT,
  destination_case_id TEXT,
  decided_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, proposal_id),
  UNIQUE (organisation_id, destination_case_id),
  CHECK ((status = 'open') = (decided_by_user_id IS NULL AND decided_at IS NULL)),
  CHECK ((status IN ('starting', 'started')) = (destination_conversation_id IS NOT NULL AND destination_case_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS side_case_proposal_source ON side_case_proposal (organisation_id, source_conversation_id, created_at);
