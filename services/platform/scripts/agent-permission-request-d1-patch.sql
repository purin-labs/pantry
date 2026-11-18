-- Adds the permission requests that agent turns in Slack threads and Portal
-- chats make when they lack a capability or a record read. Apply to each
-- deployed regional database that has no agent_permission_request table,
-- before the release that offers the request_permission tool. The statements
-- are safe to repeat. A database with the first version of the table takes
-- agent-permission-request-origin-d1-patch.sql instead.
CREATE TABLE IF NOT EXISTS agent_permission_request (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  request_id TEXT NOT NULL CHECK (
    length(request_id) = 32 AND request_id NOT GLOB '*[^0-9a-f]*'
  ),
  origin TEXT NOT NULL CHECK (origin IN ('slack_thread', 'portal_chat')),
  case_id TEXT NOT NULL CHECK (length(case_id) BETWEEN 1 AND 300),
  connector_id TEXT CHECK (
    connector_id IS NULL OR length(connector_id) BETWEEN 1 AND 300
  ),
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  requester_person_id TEXT NOT NULL,
  requester_user_id TEXT,
  requester_role TEXT NOT NULL CHECK (
    requester_role IN ('owner', 'admin', 'operator', 'viewer')
  ),
  request_authority_json TEXT NOT NULL CHECK (json_valid(request_authority_json)),
  capability_ids_json TEXT NOT NULL CHECK (
    json_valid(capability_ids_json) AND json_type(capability_ids_json) = 'array'
  ),
  entity_type_reads_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(entity_type_reads_json)
    AND json_type(entity_type_reads_json) = 'array'
  ),
  slack_workspace_id TEXT,
  slack_channel_id TEXT,
  slack_thread_ts TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied')),
  decided_by_user_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  decided_at INTEGER CHECK (decided_at IS NULL OR decided_at >= created_at),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'pending') = (decided_by_user_id IS NULL)),
  CHECK (
    (origin = 'slack_thread') = (
      connector_id IS NOT NULL AND slack_workspace_id IS NOT NULL
      AND slack_channel_id IS NOT NULL AND slack_thread_ts IS NOT NULL
    )
  ),
  CHECK (
    (origin = 'portal_chat') = (
      connector_id IS NULL AND slack_workspace_id IS NULL
      AND slack_channel_id IS NULL AND slack_thread_ts IS NULL
    )
  ),
  PRIMARY KEY (organisation_id, request_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_agent_permission_request_case
  ON agent_permission_request (organisation_id, case_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_permission_request_session
  ON agent_permission_request (organisation_id, session_id, status);
