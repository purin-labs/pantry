-- The approval reminder and escalation setting of an operational area is gone:
-- no code sent a reminder or an escalation, so the Agent page form, the
-- configure_escalation_policy command and the regional table escalation_policy
-- are removed. The stored policies are dropped with the table.
--   Table escalation_policy: dropped.
-- Apply to each deployed REGIONAL database AFTER the Worker upload: the
-- Worker before this release reads and writes the table.
--   wrangler d1 execute <regional database> --env production --remote --file workers/platform/scripts/escalation-policy-d1-patch.sql
-- A second run changes nothing.
DROP TABLE IF EXISTS escalation_policy;
