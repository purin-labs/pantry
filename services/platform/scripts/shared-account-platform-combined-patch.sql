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

PRAGMA foreign_keys = ON;
-- The account platform owns tenant membership and account enablement.
CREATE TABLE account_service_binding (
  instance_id TEXT PRIMARY KEY,
  native_organisation_id TEXT NOT NULL UNIQUE REFERENCES organisation(organisation_id),
  deployment_id TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  account_state TEXT NOT NULL CHECK (account_state IN ('active', 'disabled', 'archived')),
  desired_revision INTEGER NOT NULL CHECK (desired_revision > 0),
  operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER account_service_binding_immutable
BEFORE UPDATE ON account_service_binding
WHEN NEW.instance_id <> OLD.instance_id OR NEW.native_organisation_id <> OLD.native_organisation_id
  OR NEW.deployment_id <> OLD.deployment_id OR NEW.scope_json <> OLD.scope_json OR NEW.created_at <> OLD.created_at
  OR NEW.desired_revision < OLD.desired_revision
  OR (NEW.desired_revision = OLD.desired_revision AND (NEW.operation_id <> OLD.operation_id OR NEW.account_state <> OLD.account_state))
  OR (OLD.account_state = 'archived' AND NEW.account_state <> 'archived')
BEGIN SELECT RAISE(ABORT, 'account_service_binding_conflict'); END;
CREATE TRIGGER account_service_binding_retained BEFORE DELETE ON account_service_binding
BEGIN SELECT RAISE(ABORT, 'account_service_binding_retained'); END;
CREATE TABLE account_provision_receipt (
  operation_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES account_service_binding(instance_id),
  desired_revision INTEGER NOT NULL CHECK (desired_revision > 0),
  payload_digest TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at INTEGER NOT NULL,
  UNIQUE (instance_id, desired_revision)
);
CREATE TRIGGER account_provision_receipt_immutable BEFORE UPDATE ON account_provision_receipt
BEGIN SELECT RAISE(ABORT, 'account_provision_receipt_immutable'); END;
CREATE TRIGGER account_provision_receipt_retained BEFORE DELETE ON account_provision_receipt
BEGIN SELECT RAISE(ABORT, 'account_provision_receipt_retained'); END;
CREATE TABLE account_identity_link (
  native_user_id TEXT PRIMARY KEY REFERENCES app_user(user_id),
  platform_user_id TEXT NOT NULL UNIQUE,
  provider_issuer TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  verification_receipt_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (provider_issuer, provider_subject)
);
CREATE TRIGGER account_identity_link_immutable BEFORE UPDATE ON account_identity_link
BEGIN SELECT RAISE(ABORT, 'account_identity_link_immutable'); END;
CREATE TRIGGER account_identity_link_retained BEFORE DELETE ON account_identity_link
BEGIN SELECT RAISE(ABORT, 'account_identity_link_retained'); END;
CREATE TABLE account_automation_link (
  native_organisation_id TEXT NOT NULL REFERENCES organisation(organisation_id),
  native_kind TEXT NOT NULL CHECK (native_kind IN ('workflow', 'agent_mailbox', 'whatsapp_support')),
  native_id TEXT NOT NULL,
  native_revision INTEGER NOT NULL CHECK (native_revision > 0),
  native_principal_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  authority_revision INTEGER NOT NULL CHECK (authority_revision > 0),
  expected_access_revision INTEGER NOT NULL CHECK (expected_access_revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (native_organisation_id, native_kind, native_id, native_revision),
  UNIQUE (automation_id, grant_id)
);
CREATE TRIGGER account_automation_link_immutable BEFORE UPDATE ON account_automation_link
WHEN NEW.native_organisation_id <> OLD.native_organisation_id OR NEW.native_kind <> OLD.native_kind OR NEW.native_id <> OLD.native_id
 OR NEW.native_revision <> OLD.native_revision OR NEW.native_principal_id <> OLD.native_principal_id
 OR NEW.automation_id <> OLD.automation_id OR NEW.grant_id <> OLD.grant_id OR NEW.created_at <> OLD.created_at
 OR NEW.expected_access_revision <> OLD.expected_access_revision
 OR NEW.authority_revision < OLD.authority_revision OR (OLD.state = 'revoked' AND NEW.state <> 'revoked')
BEGIN SELECT RAISE(ABORT, 'account_automation_link_conflict'); END;

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
