-- Plan 72: drops the standby time of the removed Codex container. Apply to
-- each regional database (and a local combined database) after the Worker
-- release; the Worker before the release still reads this table.
DROP TABLE IF EXISTS organisation_codex_standby;
