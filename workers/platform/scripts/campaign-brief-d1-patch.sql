-- Campaign briefs are gone: no Portal screen read or decided a brief, so the
-- agent tool commerce_propose_campaign_brief, the campaign brief routes and
-- the regional table campaign_brief are removed. Stored briefs are dropped
-- with the table.
--   Table campaign_brief, with its index idx_campaign_brief_case: dropped.
-- Apply to each deployed REGIONAL database AFTER the Worker upload: the
-- Worker before this release reads and writes the table.
--   wrangler d1 execute <regional database> --env production --remote --file workers/platform/scripts/campaign-brief-d1-patch.sql
-- A second run changes nothing.
DROP INDEX IF EXISTS idx_campaign_brief_case;
DROP TABLE IF EXISTS campaign_brief;
