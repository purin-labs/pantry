-- The regional cutover wrote the carried Organisation's runtime cutover record
-- without its rollback expiry. A forward-only record must carry one, later than
-- its activation, so every check of the Organisation's runtime authority
-- failed, the scheduled reconciliation among them. An Organisation born on
-- Cloudflare records the expiry one millisecond after activation; this gives
-- the carried record the same. Apply to each organisation database. It changes
-- only records that lack the expiry.
--
--   wrangler d1 execute ORGANISATION_DB_<REGION> --env production --remote \
--     --file scripts/regional-cutover-d1-data-patch.sql

UPDATE organisation
SET runtime_rollback_expires_at = cloudflare_activated_at + 1
WHERE runtime_cutover_state = 'cloudflare_forward_only'
  AND runtime_rollback_expires_at IS NULL
  AND cloudflare_activated_at IS NOT NULL;
