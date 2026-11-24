-- Portal chat links: the owner and the admin roles of each Organisation get
-- the baseline grant of `message.link.read`, so a Portal chat reads a link
-- that the person pasted, as a Slack channel does. A new Organisation gets
-- the two grants with its baseline (`prepareReadAndProposeCapabilityPolicies`);
-- this patch gives them to each Organisation that has the baseline already.
-- It copies the provenance of the Organisation's baseline grant of Case
-- context, writes nothing where a grant exists, and is safe to run again.
-- Apply it to each regional database after the Worker upload.
--
--   wrangler d1 execute <ORGANISATION DATABASE> --env production --remote \
--     --file scripts/portal-chat-link-read-grant-d1-data-patch.sql

INSERT INTO access_grant (
  organisation_id, grant_id, subject_json, target_json, lifecycle,
  revision, reason, provenance_json, changed_at
)
SELECT
  organisation_id,
  'grant_baseline_owner_message_link_read',
  subject_json,
  '{"kind":"platform_capability","capabilityId":"message.link.read","capabilityVersion":1}',
  'active', 1, NULL, provenance_json,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM access_grant
WHERE grant_id = 'grant_baseline_owner_context_case_read'
  AND lifecycle = 'active'
ON CONFLICT (organisation_id, grant_id) DO NOTHING;

INSERT INTO access_grant (
  organisation_id, grant_id, subject_json, target_json, lifecycle,
  revision, reason, provenance_json, changed_at
)
SELECT
  organisation_id,
  'grant_baseline_admin_message_link_read',
  subject_json,
  '{"kind":"platform_capability","capabilityId":"message.link.read","capabilityVersion":1}',
  'active', 1, NULL, provenance_json,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM access_grant
WHERE grant_id = 'grant_baseline_admin_context_case_read'
  AND lifecycle = 'active'
ON CONFLICT (organisation_id, grant_id) DO NOTHING;
