-- Plan 27C step 5: a schedule no longer names a Project. All members see its runs.
-- Apply to each deployed REGIONAL database after the release that stops
-- writing the column. The Worker before that release still writes it.
--   wrangler d1 execute <regional database> --env production --remote --file services/platform/scripts/schedule-project-reader-d1-patch.sql
-- Alters table schedule_binding: drops column project_id.
-- The statement fails with "no such column" when it was applied before.
ALTER TABLE schedule_binding DROP COLUMN project_id;
