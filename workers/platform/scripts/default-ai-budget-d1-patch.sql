-- A new Organisation gets an AI budget of 500,000 tokens for each session,
-- not 64,000. The first Portal chat turn with tool calls of a new
-- Organisation on pantry.purin.io used 71,114 tokens and stopped at the
-- 64,000 limit (Plan 93, 22 November 2026).
--   Table workspace_ai_budget: the defaults of max_tokens and of
--   previous_limits_json become 500,000 tokens. The provision trigger on
--   organisation inserts the row with these defaults. The wall time (180
--   seconds for each run) and the tool calls (20 for each session) do not
--   change.
-- Every existing row keeps its values; only a new Organisation gets the new
-- default.
-- Apply to each deployed REGIONAL database before the release:
--   wrangler d1 execute <regional database> --env production --remote --file workers/platform/scripts/default-ai-budget-d1-patch.sql
-- SQLite cannot change a default in place, so workspace_ai_budget is rebuilt:
-- the new table is created, every row is copied, the old table is dropped and
-- the new one takes its name. No table refers to workspace_ai_budget. Its
-- trigger revise_workspace_ai_budget goes with the old table, and the trigger
-- provision_workspace_ai_budget on organisation names it, so both triggers are
-- dropped first and created again, unchanged, after the rename. A remote file
-- runs as one unit. A second run repeats the rebuild and changes nothing.
PRAGMA defer_foreign_keys = true;

CREATE TABLE workspace_ai_budget_next (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation(organisation_id),
  max_tokens INTEGER NOT NULL DEFAULT 500000 CHECK (max_tokens BETWEEN 1 AND 1000000),
  max_wall_ms INTEGER NOT NULL DEFAULT 180000 CHECK (max_wall_ms BETWEEN 1000 AND 600000 AND max_wall_ms % 1000 = 0),
  max_tool_calls INTEGER NOT NULL DEFAULT 20 CHECK (max_tool_calls BETWEEN 1 AND 200),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  applied_revision INTEGER NOT NULL DEFAULT 1 CHECK (applied_revision >= 0 AND applied_revision <= revision),
  mutation_receipt_id TEXT NOT NULL DEFAULT 'initial',
  previous_limits_json TEXT NOT NULL DEFAULT '{"maxTokens":500000,"maxWallMs":180000,"maxToolCalls":20}' CHECK (json_valid(previous_limits_json)),
  updated_at INTEGER NOT NULL
);

INSERT INTO workspace_ai_budget_next (
  organisation_id, max_tokens, max_wall_ms, max_tool_calls, revision,
  applied_revision, mutation_receipt_id, previous_limits_json, updated_at
)
SELECT
  organisation_id, max_tokens, max_wall_ms, max_tool_calls, revision,
  applied_revision, mutation_receipt_id, previous_limits_json, updated_at
FROM workspace_ai_budget;

DROP TRIGGER provision_workspace_ai_budget;
DROP TRIGGER revise_workspace_ai_budget;
DROP TABLE workspace_ai_budget;
ALTER TABLE workspace_ai_budget_next RENAME TO workspace_ai_budget;

CREATE TRIGGER provision_workspace_ai_budget AFTER INSERT ON organisation
BEGIN
  INSERT INTO workspace_ai_budget (organisation_id, updated_at) VALUES (NEW.organisation_id, NEW.created_at);
END;
CREATE TRIGGER revise_workspace_ai_budget AFTER UPDATE OF revision ON workspace_ai_budget
WHEN (NEW.revision <> OLD.revision) AND NOT EXISTS (SELECT 1 FROM organisation_placement import_placement WHERE import_placement.organisation_id = NEW.organisation_id AND import_placement.status = 'reserved' AND NOT EXISTS (SELECT 1 FROM organisation_placement live_placement WHERE live_placement.organisation_id = NEW.organisation_id AND live_placement.status = 'active'))
BEGIN
  UPDATE organisation_onboarding
  SET configuration_version = configuration_version + 1,
      projection_revision = projection_revision + 1,
      updated_at = NEW.updated_at
  WHERE organisation_id = NEW.organisation_id;
END;
