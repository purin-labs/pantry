-- The regional tables install and connector have no reader or writer: the
-- Slack installs are in surface_installation, and the provider connections
-- in provider_connection. No table refers to either, and the purge catalogue
-- no longer names them.
--   Table install, with its index idx_install_workspace: dropped.
--   Table connector: dropped.
-- Apply to each deployed REGIONAL database with the release, before or after
-- the deploy (no Worker version reads either table):
--   wrangler d1 execute <regional database> --env production --remote --file workers/platform/scripts/unused-install-connector-d1-patch.sql
-- A second run changes nothing.
DROP INDEX IF EXISTS idx_install_workspace;
DROP TABLE IF EXISTS install;
DROP TABLE IF EXISTS connector;
