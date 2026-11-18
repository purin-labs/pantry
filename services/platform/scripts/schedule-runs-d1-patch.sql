-- Schedule runs on the Agents page: the runs of a day by their dispatch time,
-- and the Project that receives a schedule's results (Plan 42J).
-- Apply to each deployed REGIONAL database before the release that reads it:
--   wrangler d1 execute <regional database> --env production --remote --file services/platform/scripts/schedule-runs-d1-patch.sql
-- Adds index idx_schedule_dispatch_receipt_time on table
-- schedule_dispatch_receipt. Alters table schedule_binding: adds column
-- project_id and fills it for each schedule revision written before it, with
-- the Organisation's default Project, as a new revision gets it. Each later
-- run of such a schedule releases its records to that Project. A run that
-- started before keeps its labels and stays hidden from the Project.
-- The index statement is safe to repeat. The column statement fails with
-- "duplicate column name" when it was applied before. Then run the UPDATE
-- statement alone with --command; it changes only revisions with no Project.
CREATE INDEX IF NOT EXISTS idx_schedule_dispatch_receipt_time
  ON schedule_dispatch_receipt (organisation_id, dispatched_at);
ALTER TABLE schedule_binding ADD COLUMN project_id TEXT;
UPDATE schedule_binding
SET project_id = (
  SELECT project_id FROM organisation_default_project
  WHERE organisation_default_project.organisation_id = schedule_binding.organisation_id
)
WHERE project_id IS NULL;
