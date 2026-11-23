-- Refactor 15, refactor 5: the Organisation lifecycle and the purge.
-- Alters table organisation: the status column takes 'purged', so that
-- 'deleted' means archived (or a blank row in a retired cell) and 'purged'
-- means that the purge ran. SQLite cannot change a CHECK in place, and 150
-- tables refer to organisation, so the column is swapped: a new column with
-- the new CHECK, a copy, a drop of the old column, a rename. The column moves
-- to the end of the table, as in the baseline.
-- Alters table organisation_onboarding: the lifecycle takes 'purging' (the
-- purge started; no restore) and 'purged'. No table refers to it, so it is
-- rebuilt.
-- Alters trigger service_role_grant_preserve_final_owner_on_delete: the
-- purge may delete the last owner of a purging or purged Organisation, as it
-- may for an archived one.
-- Apply to each deployed REGIONAL database (and a local combined
-- database) before the release that writes 'purged':
--   wrangler d1 execute <regional database> --env production --remote --file workers/platform/scripts/refactor-15-organisation-lifecycle-regional-d1-patch.sql
-- The script is safe to repeat: a second run swaps the column again with the
-- same values and rebuilds the same objects.
-- Four triggers read organisation.status or organisation_onboarding, so they
-- are dropped first and created again at the end, as the baseline has them.
DROP TRIGGER IF EXISTS commerce_capability_activation_actor_insert;
DROP TRIGGER IF EXISTS commerce_capability_activation_actor_lifecycle_update;
DROP TRIGGER IF EXISTS revise_workspace_ai_budget;
DROP TRIGGER IF EXISTS service_role_grant_preserve_final_owner_on_delete;

ALTER TABLE organisation ADD COLUMN status_next TEXT NOT NULL DEFAULT 'active'
  CHECK (status_next IN ('active', 'suspended', 'deleted', 'purged'));
UPDATE organisation SET status_next = status;
ALTER TABLE organisation DROP COLUMN status;
ALTER TABLE organisation RENAME COLUMN status_next TO status;

-- An Organisation whose purge already ran keeps no handle and says 'purged'.
UPDATE organisation SET status = 'purged', organisation_handle = NULL
WHERE organisation_id IN (
  SELECT organisation_id FROM organisation_archive_cleanup WHERE status = 'purged'
);

PRAGMA defer_foreign_keys = ON;

CREATE TABLE organisation_onboarding_replacement (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('configuring', 'activating', 'active', 'archived', 'purging', 'purged')
  ),
  capability_profile TEXT NOT NULL CHECK (
    capability_profile IN ('read_and_propose', 'approved_provider_writes')
  ),
  configuration_version INTEGER NOT NULL CHECK (configuration_version > 0),
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  activation_attempt_id TEXT,
  readiness_version INTEGER,
  activation_receipt_id TEXT,
  activated_at INTEGER,
  suspension_reason_code TEXT,
  suspended_at INTEGER,
  archived_at INTEGER,
  purge_after INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (
    (lifecycle = 'configuring' AND
      activation_attempt_id IS NULL AND readiness_version IS NULL AND
      activation_receipt_id IS NULL AND activated_at IS NULL AND
      suspension_reason_code IS NULL AND suspended_at IS NULL AND
      archived_at IS NULL AND purge_after IS NULL) OR
    (lifecycle = 'activating' AND
      activation_attempt_id IS NOT NULL AND readiness_version IS NOT NULL AND
      activation_receipt_id IS NULL AND activated_at IS NULL AND
      suspension_reason_code IS NULL AND suspended_at IS NULL AND
      archived_at IS NULL AND purge_after IS NULL) OR
    (lifecycle = 'active' AND
      activation_attempt_id IS NULL AND readiness_version IS NULL AND
      activation_receipt_id IS NOT NULL AND activated_at IS NOT NULL AND
      suspension_reason_code IS NULL AND suspended_at IS NULL AND
      archived_at IS NULL AND purge_after IS NULL) OR
    (lifecycle IN ('archived', 'purging', 'purged') AND
      activation_attempt_id IS NULL AND readiness_version IS NULL AND
      activation_receipt_id IS NULL AND activated_at IS NULL AND
      suspension_reason_code IS NULL AND suspended_at IS NULL AND
      archived_at IS NOT NULL AND purge_after IS NOT NULL AND
      purge_after > archived_at)
  )
);

INSERT INTO organisation_onboarding_replacement (
  organisation_id, environment, lifecycle, capability_profile,
  configuration_version, projection_revision, activation_attempt_id,
  readiness_version, activation_receipt_id, activated_at,
  suspension_reason_code, suspended_at, archived_at, purge_after, updated_at
)
SELECT onboarding.organisation_id, onboarding.environment,
  CASE WHEN cleanup.status = 'purged' THEN 'purged' ELSE onboarding.lifecycle END,
  onboarding.capability_profile, onboarding.configuration_version,
  onboarding.projection_revision, onboarding.activation_attempt_id,
  onboarding.readiness_version, onboarding.activation_receipt_id,
  onboarding.activated_at, onboarding.suspension_reason_code,
  onboarding.suspended_at, onboarding.archived_at, onboarding.purge_after,
  onboarding.updated_at
FROM organisation_onboarding AS onboarding
LEFT JOIN organisation_archive_cleanup AS cleanup
  ON cleanup.organisation_id = onboarding.organisation_id;

DROP TABLE organisation_onboarding;
ALTER TABLE organisation_onboarding_replacement
  RENAME TO organisation_onboarding;

PRAGMA defer_foreign_keys = OFF;

CREATE TRIGGER commerce_capability_activation_actor_insert
BEFORE INSERT ON commerce_capability_activation
WHEN NOT EXISTS (SELECT 1 FROM organisation_placement import_placement WHERE import_placement.organisation_id = NEW.organisation_id AND import_placement.status = 'reserved' AND NOT EXISTS (SELECT 1 FROM organisation_placement live_placement WHERE live_placement.organisation_id = NEW.organisation_id AND live_placement.status = 'active'))
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM organisation
    JOIN organisation_onboarding AS onboarding
      ON onboarding.organisation_id = organisation.organisation_id
     AND onboarding.lifecycle = 'active'
    JOIN service_role_grant AS membership
      ON membership.organisation_id = organisation.organisation_id
     AND membership.user_id = NEW.configured_by_user_id
     AND membership.status = 'active'
    WHERE organisation.organisation_id = NEW.organisation_id
      AND organisation.status = 'active'
  ) THEN RAISE(ABORT, 'commerce_capability_activation_actor_mismatch') END);
END;
CREATE TRIGGER commerce_capability_activation_actor_lifecycle_update
BEFORE UPDATE OF lifecycle, revision, activated_by_user_id,
  inactivated_by_user_id
ON commerce_capability_activation
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM organisation
    JOIN organisation_onboarding AS onboarding
      ON onboarding.organisation_id = organisation.organisation_id
     AND onboarding.lifecycle = 'active'
    JOIN service_role_grant AS membership
      ON membership.organisation_id = organisation.organisation_id
     AND membership.user_id = CASE NEW.lifecycle
       WHEN 'active' THEN NEW.activated_by_user_id
       WHEN 'inactive' THEN NEW.inactivated_by_user_id
       ELSE NEW.configured_by_user_id
     END
     AND membership.status = 'active'
    WHERE organisation.organisation_id = NEW.organisation_id
      AND organisation.status = 'active'
  ) THEN RAISE(ABORT, 'commerce_capability_activation_actor_mismatch') END);
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
CREATE TRIGGER service_role_grant_preserve_final_owner_on_delete
BEFORE DELETE ON service_role_grant
WHEN OLD.status = 'active'
  AND OLD.role = 'owner'
  AND NOT EXISTS (
    SELECT 1
    FROM service_role_grant AS replacement
    WHERE replacement.organisation_id = OLD.organisation_id
      AND replacement.user_id != OLD.user_id
      AND replacement.status = 'active'
      AND replacement.role = 'owner'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM organisation_onboarding
    WHERE organisation_id = OLD.organisation_id
      AND lifecycle IN ('archived', 'purging', 'purged')
  )
  AND NOT EXISTS (
    SELECT 1 FROM organisation_placement retired
    WHERE retired.organisation_id = OLD.organisation_id AND retired.status IN ('retired', 'abandoned')
      AND NOT EXISTS (SELECT 1 FROM organisation_placement live
        WHERE live.organisation_id = OLD.organisation_id AND live.status NOT IN ('retired', 'abandoned'))
  )
BEGIN
  SELECT RAISE(ABORT, 'organisation_final_owner_required');
END;
