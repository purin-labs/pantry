-- Preserve native operational roles and person identities at account cutover.
PRAGMA legacy_alter_table = OFF;
ALTER TABLE organisation_membership RENAME TO service_role_grant;
ALTER TABLE service_role_grant ADD COLUMN platform_membership_id TEXT;
ALTER TABLE service_role_grant ADD COLUMN account_access_revision INTEGER NOT NULL DEFAULT 1 CHECK (account_access_revision >= 1);
ALTER TABLE service_role_grant ADD COLUMN account_acceptance_receipt_id TEXT;
DROP INDEX idx_organisation_membership_identity;
DROP INDEX idx_organisation_active_owner;
CREATE INDEX idx_service_role_grant_identity ON service_role_grant(user_id, status, organisation_id);
CREATE INDEX idx_service_role_grant_active_owner ON service_role_grant(organisation_id, status) WHERE role = 'owner';
DROP TRIGGER organisation_membership_preserve_final_owner_on_update;
DROP TRIGGER organisation_membership_preserve_final_owner_on_delete;
CREATE TRIGGER service_role_grant_preserve_final_owner_on_update
BEFORE UPDATE OF role, status ON service_role_grant
WHEN OLD.status = 'active'
  AND OLD.role = 'owner'
  AND (NEW.status != 'active' OR NEW.role != 'owner')
  AND NOT EXISTS (
    SELECT 1
    FROM service_role_grant AS replacement
    WHERE replacement.organisation_id = OLD.organisation_id
      AND replacement.user_id != OLD.user_id
      AND replacement.status = 'active'
      AND replacement.role = 'owner'
  )
BEGIN
  SELECT RAISE(ABORT, 'organisation_final_owner_required');
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
      AND lifecycle = 'archived'
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

-- Native invitations grant no access after the account-platform cutover.
-- Retain their original data for audit. Pending invitations require a new account invitation.
CREATE TABLE retired_organisation_invitation AS SELECT *,
  CASE WHEN state = 'pending' THEN 'requires_account_reissue' ELSE 'historical' END AS migration_disposition
FROM organisation_invitation;
DROP TABLE organisation_invitation;

CREATE TABLE account_service_invitation_role (
  native_organisation_id TEXT NOT NULL REFERENCES organisation(organisation_id),
  platform_invitation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  invited_by_native_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_native_user_id TEXT,
  PRIMARY KEY (native_organisation_id, platform_invitation_id),
  CHECK ((accepted_at IS NULL) = (accepted_native_user_id IS NULL))
);
CREATE TRIGGER account_service_invitation_role_immutable BEFORE UPDATE ON account_service_invitation_role
WHEN NEW.native_organisation_id <> OLD.native_organisation_id OR NEW.platform_invitation_id <> OLD.platform_invitation_id
 OR NEW.role <> OLD.role OR NEW.invited_by_native_user_id <> OLD.invited_by_native_user_id OR NEW.created_at <> OLD.created_at
 OR (OLD.accepted_at IS NOT NULL AND (NEW.accepted_at IS NOT OLD.accepted_at OR NEW.accepted_native_user_id IS NOT OLD.accepted_native_user_id))
BEGIN SELECT RAISE(ABORT, 'account_service_invitation_role_conflict'); END;

CREATE TABLE account_service_access_revision (
  native_organisation_id TEXT NOT NULL REFERENCES organisation(organisation_id),
  native_user_id TEXT NOT NULL,
  access_revision INTEGER NOT NULL CHECK (access_revision >= 1),
  cleanup_pending INTEGER NOT NULL CHECK (cleanup_pending IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (native_organisation_id, native_user_id)
);
CREATE TRIGGER account_service_access_revision_monotonic BEFORE UPDATE ON account_service_access_revision
WHEN NEW.native_organisation_id <> OLD.native_organisation_id OR NEW.native_user_id <> OLD.native_user_id
 OR NEW.access_revision < OLD.access_revision OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'account_service_access_revision_conflict'); END;
