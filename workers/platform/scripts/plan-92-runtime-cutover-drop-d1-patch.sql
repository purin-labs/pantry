-- Plan 92: drops the Plan 13 runtime cutover record from the organisation
-- table. Every Organisation was forward-only on Cloudflare (census of
-- 18 November 2026), and no code reads these columns after the Plan 92
-- release. Apply to the global database and to each regional database after
-- that Worker release; the Worker before the release still reads them.
--
--   wrangler d1 execute <DATABASE> --env production --remote \
--     --file scripts/plan-92-runtime-cutover-drop-d1-patch.sql

DROP INDEX IF EXISTS idx_organisation_authoritative_runtime;
ALTER TABLE organisation DROP COLUMN authoritative_runtime;
ALTER TABLE organisation DROP COLUMN runtime_cutover_state;
ALTER TABLE organisation DROP COLUMN cloudflare_prepared_at;
ALTER TABLE organisation DROP COLUMN cloudflare_activated_at;
ALTER TABLE organisation DROP COLUMN runtime_rollback_expires_at;
ALTER TABLE organisation DROP COLUMN first_cloudflare_write_at;
ALTER TABLE organisation DROP COLUMN runtime_rolled_back_at;
