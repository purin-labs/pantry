-- Plan 37 message capability policy materialization.
--
-- Add only absent catalogue rows for existing organisations. These rows start
-- disabled so the audited access-control mutation remains the only enablement
-- path. No grant, organisation revision, or existing policy row is changed.

INSERT INTO organisation_capability_policy (
  organisation_id,
  capability_id,
  capability_version,
  mode,
  provenance_json,
  revision,
  changed_at
)
SELECT
  organisation.organisation_id,
  'message.attachment.inspect',
  1,
  'disabled',
  json_object(
    'kind', 'cutover_disabled',
    'migrationId', 'plan37-message-policy-materialization-20260907'
  ),
  1,
  unixepoch() * 1000
FROM organisation
WHERE organisation.organisation_id IS NOT NULL
ON CONFLICT (organisation_id, capability_id, capability_version) DO NOTHING;

INSERT INTO organisation_capability_policy (
  organisation_id,
  capability_id,
  capability_version,
  mode,
  provenance_json,
  revision,
  changed_at
)
SELECT
  organisation.organisation_id,
  'email.mailbox.read',
  1,
  'disabled',
  json_object(
    'kind', 'cutover_disabled',
    'migrationId', 'plan37-message-policy-materialization-20260907'
  ),
  1,
  unixepoch() * 1000
FROM organisation
WHERE organisation.organisation_id IS NOT NULL
ON CONFLICT (organisation_id, capability_id, capability_version) DO NOTHING;

INSERT INTO organisation_capability_policy (
  organisation_id,
  capability_id,
  capability_version,
  mode,
  provenance_json,
  revision,
  changed_at
)
SELECT
  organisation.organisation_id,
  'email.reply.propose',
  1,
  'disabled',
  json_object(
    'kind', 'cutover_disabled',
    'migrationId', 'plan37-message-policy-materialization-20260907'
  ),
  1,
  unixepoch() * 1000
FROM organisation
WHERE organisation.organisation_id IS NOT NULL
ON CONFLICT (organisation_id, capability_id, capability_version) DO NOTHING;

INSERT INTO organisation_capability_policy (
  organisation_id,
  capability_id,
  capability_version,
  mode,
  provenance_json,
  revision,
  changed_at
)
SELECT
  organisation.organisation_id,
  'message.link.read',
  1,
  'disabled',
  json_object(
    'kind', 'cutover_disabled',
    'migrationId', 'plan37-message-policy-materialization-20260907'
  ),
  1,
  unixepoch() * 1000
FROM organisation
WHERE organisation.organisation_id IS NOT NULL
ON CONFLICT (organisation_id, capability_id, capability_version) DO NOTHING;
