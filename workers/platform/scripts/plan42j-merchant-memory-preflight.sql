-- Plan 42J Brain: read-only preflight for removing the merchant_memory table.
--
-- Memory now lives in OrganisationActor storage. The D1 table was never
-- written by a released command. This file changes nothing. It reports which
-- of the table and its index a database still has.
--
-- Run the statement below from workers/platform against every production
-- database, as a command. A remote --file run reports a count of queries and
-- never the rows, so it cannot show that a database has neither.
--   pnpm exec wrangler d1 execute DB --env production --remote --json --command "<the SELECT below>"
--   pnpm exec wrangler d1 execute ORGANISATION_DB_WNAM --env production --remote --json --command "<the SELECT below>"
--   pnpm exec wrangler d1 execute ORGANISATION_DB_APAC --env production --remote --json --command "<the SELECT below>"
--
-- An empty `results` list: the database has neither, and needs no patch.
-- A row for merchant_memory: count its rows before anything else,
--   pnpm exec wrangler d1 execute <binding> --env production --remote --command "SELECT COUNT(*) AS merchant_memory_rows FROM merchant_memory"
-- Zero rows: run plan42j-merchant-memory-removal-patch.sql on that database.
-- Any row, or a command that fails: stop. Keep the rows for review.
--
-- Run it again after the patch. Its `results` list must be empty.
SELECT type, name
FROM sqlite_master
WHERE name IN ('merchant_memory', 'idx_merchant_memory_active')
ORDER BY type, name;
