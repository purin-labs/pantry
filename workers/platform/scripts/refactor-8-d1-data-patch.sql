-- Refactor 8 renamed two stored JSON values from their Tenant spelling. An
-- organisation database converted before this patch can still hold the earlier
-- spelling, which the current parsers reject: reading the Organisation in the
-- portal then fails. Apply to each organisation database. It changes only rows
-- that hold the earlier spelling, so applying it again changes nothing.
--
--   wrangler d1 execute ORGANISATION_DB_<REGION> --env production --remote \
--     --file scripts/refactor-8-d1-data-patch.sql

UPDATE integration_account
SET retention_policy = json_set(retention_policy, '$.kind', 'organisation_default')
WHERE json_extract(retention_policy, '$.kind') = 'tenant_default';

UPDATE whatsapp_ingress_policy_revision
SET notification_destination = json_set(
  notification_destination,
  '$.kind',
  'organisation_communication_destination'
)
WHERE json_extract(notification_destination, '$.kind') = 'tenant_communication_destination';
