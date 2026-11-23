-- Plan 37 production D1 patch.
--
-- The baseline migration is replaced in place while D1 databases are treated
-- as disposable; production is not recreated from it. These are the two
-- deltas Plan 37 made to the baseline, written to be safe to run more than
-- once, so the schema check in `deploy` passes and the Worker does not fail at
-- runtime on an INSERT into a column that is not there.
--
-- Run against the account that owns database b97fca3b-5335-4888-a0bf-8a5df5ed194c:
--   npx wrangler d1 execute satyr --remote --file scripts/plan37-d1-remote-patch.sql
--
-- SQLite has no ADD COLUMN IF NOT EXISTS. If model_text already exists this
-- statement fails with "duplicate column name" and nothing else is affected;
-- delete this one statement and run the file again.
ALTER TABLE context_projection ADD COLUMN model_text TEXT;

-- The Slack manifest gains files:read at version 3. Readiness compares the
-- version, not the scope list, so the new rows are what make connected
-- accounts re-observe. Existing v2 rows are left in place; MAX(version) wins.
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at)
SELECT 'slack', 3, 'development', '["app_mentions:read","channels:history","channels:read","chat:write","files:read","groups:history","groups:read","im:history"]', '[]', '[{"kind":"shared_application_event_subscription","required":true}]', '["channels"]', 1788220800000
WHERE NOT EXISTS (SELECT 1 FROM provider_manifest WHERE provider = 'slack' AND manifest_version = 3 AND environment = 'development');

INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at)
SELECT 'slack', 3, 'production', '["app_mentions:read","channels:history","channels:read","chat:write","files:read","groups:history","groups:read","im:history"]', '[]', '[{"kind":"shared_application_event_subscription","required":true}]', '["channels"]', 1788220800000
WHERE NOT EXISTS (SELECT 1 FROM provider_manifest WHERE provider = 'slack' AND manifest_version = 3 AND environment = 'production');
