-- Plan 27C step 3: an output that waits for a person's approval at the exit.
-- Apply to each deployed REGIONAL database before the release that reads it:
--   wrangler d1 execute <regional database> --env production --remote --file workers/platform/scripts/held-output-request-d1-patch.sql
-- Adds table held_output_request and indexes idx_held_output_request_status and
-- idx_held_output_request_effect.
-- The statements are safe to repeat.
CREATE TABLE IF NOT EXISTS held_output_request (
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
  reason TEXT NOT NULL CHECK (reason IN ('private_source', 'outside_organisation')),
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
CREATE INDEX IF NOT EXISTS idx_held_output_request_status
  ON held_output_request (organisation_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_held_output_request_effect
  ON held_output_request (organisation_id, session_id, capability_id, status);
