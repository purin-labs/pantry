-- Adds the Slack message drafts that Portal chat agents prepare for a person
-- to send. Apply to each deployed regional database before the release that
-- offers the slack_message_propose tool. The statements are safe to repeat.
CREATE TABLE IF NOT EXISTS slack_message_proposal (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  proposal_id TEXT NOT NULL CHECK (length(proposal_id) BETWEEN 1 AND 200),
  case_id TEXT NOT NULL,
  integration_account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  channel_hint TEXT CHECK (channel_hint IS NULL OR length(channel_hint) BETWEEN 1 AND 200),
  channel_id TEXT CHECK (channel_id IS NULL OR length(channel_id) BETWEEN 1 AND 64),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0),
  lifecycle_kind TEXT NOT NULL CHECK (
    lifecycle_kind IN ('awaiting_approval', 'sending', 'sent', 'send_failed', 'rejected', 'expired')
  ),
  sent_channel_id TEXT,
  sent_message_ts TEXT,
  failure_code TEXT,
  decided_by_user_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  CHECK ((lifecycle_kind = 'sent') = (sent_channel_id IS NOT NULL AND sent_message_ts IS NOT NULL)),
  CHECK ((lifecycle_kind = 'send_failed') = (failure_code IS NOT NULL)),
  PRIMARY KEY (organisation_id, proposal_id),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_slack_message_proposal_case
  ON slack_message_proposal (organisation_id, case_id, created_at);

-- Existing organisations need a policy row before Access can show the catalogue.
-- Keep the capability disabled until an operator enables it through Access.
INSERT INTO organisation_capability_policy (
  organisation_id, capability_id, capability_version, mode,
  provenance_json, revision, changed_at
)
SELECT organisation_id, 'slack.message.propose', 1, 'disabled',
  json_object(
    'kind', 'cutover_disabled',
    'migrationId', 'slack-message-proposal-policy-materialization'
  ),
  1, unixepoch() * 1000
FROM organisation
WHERE organisation_id IS NOT NULL
ON CONFLICT (organisation_id, capability_id, capability_version) DO NOTHING;
