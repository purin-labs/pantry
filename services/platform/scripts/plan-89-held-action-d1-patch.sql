-- Plan 89 step 4: a held step can wait because its Session read text of a
-- person outside the Organisation. The request stores the exact action.
-- Apply ONE time to each deployed REGIONAL database before the release that
-- reads it:
--   wrangler d1 execute <regional database> --env production --remote --file services/platform/scripts/plan-89-held-action-d1-patch.sql
-- Alters table held_output_request: the reason check accepts
-- 'outside_written', and the columns action_digest and action_json are new.
-- SQLite cannot change a check, so the patch copies the rows into a new table.
-- It creates indexes idx_held_output_request_status and
-- idx_held_output_request_effect again.
-- Do not apply it a second time: the copy does not read the new columns, so a
-- second run removes the stored actions of the requests that wait.
CREATE TABLE held_output_request_plan_89 (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  request_id TEXT NOT NULL CHECK (
    length(request_id) = 32 AND request_id NOT GLOB '*[^0-9a-f]*'
  ),
  -- An output waits in the Case outbox. An effect waits for its turn to ask
  -- again, and an allow gives that effect one pass.
  subject TEXT NOT NULL CHECK (subject IN ('output', 'effect')),
  -- Null for an effect of a Portal chat, which has no thread to continue.
  case_id TEXT CHECK (case_id IS NULL OR length(case_id) BETWEEN 1 AND 300),
  connector_id TEXT CHECK (
    connector_id IS NULL OR length(connector_id) BETWEEN 1 AND 300
  ),
  channel_id TEXT CHECK (channel_id IS NULL OR length(channel_id) BETWEEN 1 AND 300),
  output_id TEXT CHECK (output_id IS NULL OR length(output_id) BETWEEN 1 AND 600),
  session_id TEXT,
  authority_partition_digest TEXT,
  capability_id TEXT,
  integration_account_id TEXT,
  resource_scope TEXT,
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= 0),
  -- 'outside_written': the Session read text of a person outside the
  -- Organisation, so the person who asked confirms the step (Plan 89).
  reason TEXT NOT NULL CHECK (
    reason IN ('private_source', 'outside_organisation', 'outside_written')
  ),
  -- Null for a run that no person started.
  requester_person_id TEXT,
  request_authority_json TEXT NOT NULL CHECK (json_valid(request_authority_json)),
  flow_label_json TEXT NOT NULL CHECK (json_valid(flow_label_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'expired')),
  decided_by_user_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  decided_at INTEGER CHECK (decided_at IS NULL OR decided_at >= created_at),
  -- When the output left, or when the Case dropped it.
  released_at INTEGER CHECK (released_at IS NULL OR released_at >= 0),
  -- The turn that used an effect's pass. Later edits of that turn, which is
  -- one request of the person, use the same pass (Plan 40B phase 7).
  consumed_turn_id TEXT CHECK (
    consumed_turn_id IS NULL OR length(consumed_turn_id) BETWEEN 1 AND 600
  ),
  -- The exact action of an 'outside_written' step: the digest that a pass
  -- must match, and the values that the prompt shows (Plan 89).
  action_digest TEXT CHECK (
    action_digest IS NULL OR (
      length(action_digest) = 64 AND action_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  action_json TEXT CHECK (action_json IS NULL OR json_valid(action_json)),
  CHECK ((action_digest IS NULL) = (action_json IS NULL)),
  CHECK (action_digest IS NULL OR reason = 'outside_written'),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((subject = 'output') = (output_id IS NOT NULL)),
  CHECK (
    subject = 'output' OR (
      session_id IS NOT NULL AND authority_partition_digest IS NOT NULL
      AND capability_id IS NOT NULL AND integration_account_id IS NOT NULL
      AND resource_scope IS NOT NULL
    )
  ),
  PRIMARY KEY (organisation_id, request_id)
) STRICT;
INSERT INTO held_output_request_plan_89 (
  organisation_id, request_id, subject, case_id, connector_id, channel_id,
  output_id, session_id, authority_partition_digest, capability_id,
  integration_account_id, resource_scope, consumed_at, reason,
  requester_person_id, request_authority_json, flow_label_json, status,
  decided_by_user_id, created_at, decided_at, released_at, consumed_turn_id
) SELECT
  organisation_id, request_id, subject, case_id, connector_id, channel_id,
  output_id, session_id, authority_partition_digest, capability_id,
  integration_account_id, resource_scope, consumed_at, reason,
  requester_person_id, request_authority_json, flow_label_json, status,
  decided_by_user_id, created_at, decided_at, released_at, consumed_turn_id
FROM held_output_request;
DROP TABLE held_output_request;
ALTER TABLE held_output_request_plan_89 RENAME TO held_output_request;
CREATE INDEX idx_held_output_request_status
  ON held_output_request (organisation_id, status, created_at);
CREATE INDEX idx_held_output_request_effect
  ON held_output_request (organisation_id, session_id, capability_id, status);
