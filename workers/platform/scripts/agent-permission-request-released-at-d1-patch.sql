-- Adds released_at to agent_permission_request: when a decision reached the
-- asking turn. An allow while Slack is unavailable is kept with released_at
-- null, and the scheduled reconciliation releases it once Slack works.
-- Existing decided rows were released when they were decided, so they take
-- their decision time. Apply once to each deployed regional database before
-- the release that reads the column.
ALTER TABLE agent_permission_request
  ADD COLUMN released_at INTEGER CHECK (released_at IS NULL OR released_at >= 0);
UPDATE agent_permission_request SET released_at = decided_at
  WHERE status != 'pending' AND released_at IS NULL;
