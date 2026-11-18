-- Additive local/existing-database rollout. Apply once; never reset configured limits.
CREATE TABLE workspace_ai_budget (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation(organisation_id),
  max_tokens INTEGER NOT NULL DEFAULT 64000 CHECK (max_tokens BETWEEN 1 AND 1000000),
  max_wall_ms INTEGER NOT NULL DEFAULT 180000 CHECK (max_wall_ms BETWEEN 1000 AND 600000 AND max_wall_ms % 1000 = 0),
  max_tool_calls INTEGER NOT NULL DEFAULT 20 CHECK (max_tool_calls BETWEEN 1 AND 200),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  applied_revision INTEGER NOT NULL DEFAULT 1 CHECK (applied_revision >= 0 AND applied_revision <= revision),
  mutation_receipt_id TEXT NOT NULL DEFAULT 'initial',
  previous_limits_json TEXT NOT NULL DEFAULT '{"maxTokens":64000,"maxWallMs":180000,"maxToolCalls":20}' CHECK (json_valid(previous_limits_json)),
  updated_at INTEGER NOT NULL
);
CREATE TRIGGER provision_workspace_ai_budget AFTER INSERT ON organisation
BEGIN
  INSERT INTO workspace_ai_budget (organisation_id, updated_at) VALUES (NEW.organisation_id, NEW.created_at);
END;
CREATE TRIGGER revise_workspace_ai_budget AFTER UPDATE OF revision ON workspace_ai_budget
WHEN NEW.revision <> OLD.revision
BEGIN
  UPDATE organisation_onboarding
  SET configuration_version = configuration_version + 1,
      projection_revision = projection_revision + 1,
      updated_at = NEW.updated_at
  WHERE organisation_id = NEW.organisation_id;
END;
INSERT INTO workspace_ai_budget (organisation_id, updated_at)
SELECT organisation_id, created_at FROM organisation
WHERE organisation_id NOT IN (SELECT organisation_id FROM workspace_ai_budget);

-- Older databases predate these catalogue entries. Missing policies stay denied.
INSERT INTO organisation_capability_policy
  (organisation_id, capability_id, capability_version, mode, provenance_json, revision, changed_at)
SELECT organisation.organisation_id, capability.id, 1, 'disabled',
  '{"kind":"cutover_disabled","migrationId":"plan35b-missing-policy-backfill"}', 1, organisation.created_at
FROM organisation CROSS JOIN (
  SELECT 'context.case_context_collection_metadata.read' AS id UNION ALL SELECT 'email.operational.propose'
) AS capability
WHERE NOT EXISTS (
  SELECT 1 FROM organisation_capability_policy AS policy
  WHERE policy.organisation_id = organisation.organisation_id AND policy.capability_id = capability.id
);
