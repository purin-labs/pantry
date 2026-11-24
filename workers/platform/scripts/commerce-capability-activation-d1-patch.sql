-- Regional database patch: rebuilds commerce_capability_activation.
--
-- A commerce capability activation now names only the capabilities that an
-- admission asks for, `core` and `online_commerce`, at the Organisation scope.
-- `food_service`, `retail_operations`, `returns`, `automation` and the
-- `location` scope are gone from the type, the control route and the CHECK of
-- the table. SQLite cannot change a CHECK in place, so the patch deletes each
-- row with a removed value or a location scope (any number of them), copies
-- the other rows into a new table, and makes its two indexes and five triggers
-- again.
--   Table commerce_capability_activation: CHECK of capability, scope_kind and
--   location_id changed; rows of the removed values deleted.
--   Indexes commerce_capability_activation_scope and
--   commerce_capability_activation_active_lookup: made again, unchanged.
--   Triggers commerce_capability_activation_authority_insert,
--   commerce_capability_activation_actor_insert,
--   commerce_capability_activation_account_update,
--   commerce_capability_activation_authority_lifecycle_update and
--   commerce_capability_activation_actor_lifecycle_update: made again,
--   unchanged.
-- Apply to each deployed REGIONAL database BEFORE the Worker upload: the new
-- Worker refuses a row with a removed value, and the Worker before this
-- release writes only the values that stay.
--   wrangler d1 execute <regional database> --env production --remote --file workers/platform/scripts/commerce-capability-activation-d1-patch.sql
-- A second run deletes nothing and makes the same table again.
DELETE FROM commerce_capability_activation
WHERE capability NOT IN ('core', 'online_commerce')
   OR scope_kind <> 'organisation'
   OR location_id IS NOT NULL;

CREATE TABLE commerce_capability_activation_next (
  activation_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  capability TEXT NOT NULL CHECK (capability IN ('core', 'online_commerce')),
  scope_kind TEXT NOT NULL CHECK (scope_kind = 'organisation'),
  location_id TEXT CHECK (location_id IS NULL),
  authority_kind TEXT NOT NULL CHECK (
    authority_kind IN ('builtin_commerce', 'shopify')
  ),
  integration_account_id TEXT NOT NULL,
  commerce_system_revision INTEGER NOT NULL CHECK (commerce_system_revision > 0),
  contract_revision TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('configured', 'active', 'inactive')
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  configured_at INTEGER NOT NULL,
  configured_by_user_id TEXT NOT NULL,
  activated_at INTEGER,
  activated_by_user_id TEXT,
  inactivated_at INTEGER,
  inactivated_by_user_id TEXT,
  inactivation_reason TEXT,
  CHECK (
    (lifecycle = 'configured'
      AND activated_at IS NULL
      AND activated_by_user_id IS NULL
      AND inactivated_at IS NULL
      AND inactivated_by_user_id IS NULL
      AND inactivation_reason IS NULL)
    OR
    (lifecycle = 'active'
      AND activated_at IS NOT NULL
      AND activated_by_user_id IS NOT NULL
      AND inactivated_at IS NULL
      AND inactivated_by_user_id IS NULL
      AND inactivation_reason IS NULL)
    OR
    (lifecycle = 'inactive'
      AND activated_at IS NOT NULL
      AND activated_by_user_id IS NOT NULL
      AND inactivated_at IS NOT NULL
      AND inactivated_by_user_id IS NOT NULL
      AND inactivation_reason IS NOT NULL)
  )
) STRICT;

INSERT INTO commerce_capability_activation_next (
  activation_id,
  organisation_id,
  capability,
  scope_kind,
  location_id,
  authority_kind,
  integration_account_id,
  commerce_system_revision,
  contract_revision,
  lifecycle,
  revision,
  configured_at,
  configured_by_user_id,
  activated_at,
  activated_by_user_id,
  inactivated_at,
  inactivated_by_user_id,
  inactivation_reason
)
SELECT
  activation_id,
  organisation_id,
  capability,
  scope_kind,
  location_id,
  authority_kind,
  integration_account_id,
  commerce_system_revision,
  contract_revision,
  lifecycle,
  revision,
  configured_at,
  configured_by_user_id,
  activated_at,
  activated_by_user_id,
  inactivated_at,
  inactivated_by_user_id,
  inactivation_reason
FROM commerce_capability_activation;

DROP TABLE commerce_capability_activation;

ALTER TABLE commerce_capability_activation_next
  RENAME TO commerce_capability_activation;

CREATE UNIQUE INDEX commerce_capability_activation_scope
ON commerce_capability_activation (
  organisation_id,
  capability,
  scope_kind,
  COALESCE(location_id, '')
);
CREATE INDEX commerce_capability_activation_active_lookup
ON commerce_capability_activation (
  organisation_id,
  capability,
  lifecycle,
  scope_kind,
  location_id
);
CREATE TRIGGER commerce_capability_activation_authority_insert
BEFORE INSERT ON commerce_capability_activation
WHEN NOT EXISTS (SELECT 1 FROM organisation_placement import_placement WHERE import_placement.organisation_id = NEW.organisation_id AND import_placement.status = 'reserved' AND NOT EXISTS (SELECT 1 FROM organisation_placement live_placement WHERE live_placement.organisation_id = NEW.organisation_id AND live_placement.status = 'active'))
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM organisation_commerce_system AS selected
    LEFT JOIN commerce_merchant_binding AS binding
      ON binding.binding_id = selected.commerce_binding_id
     AND binding.organisation_id = selected.organisation_id
    LEFT JOIN integration_account AS shopify
      ON shopify.integration_account_id = selected.shopify_integration_account_id
     AND shopify.organisation_id = selected.organisation_id
     AND shopify.provider = 'shopify'
     AND shopify.lifecycle = 'active'
    WHERE selected.organisation_id = NEW.organisation_id
      AND selected.revision = NEW.commerce_system_revision
      AND (
        (NEW.authority_kind = 'builtin_commerce'
          AND selected.system_kind = 'builtin_commerce'
          AND binding.integration_account_id = NEW.integration_account_id)
        OR
        (NEW.authority_kind = 'shopify'
          AND selected.system_kind = 'shopify'
          AND shopify.integration_account_id = NEW.integration_account_id)
      )
  ) THEN RAISE(ABORT, 'commerce_capability_activation_authority_mismatch') END);
END;
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
CREATE TRIGGER commerce_capability_activation_account_update
BEFORE UPDATE OF organisation_id, authority_kind, integration_account_id
ON commerce_capability_activation
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM organisation_commerce_system AS selected
    LEFT JOIN commerce_merchant_binding AS binding
      ON binding.binding_id = selected.commerce_binding_id
     AND binding.organisation_id = selected.organisation_id
    LEFT JOIN integration_account AS shopify
      ON shopify.integration_account_id = selected.shopify_integration_account_id
     AND shopify.organisation_id = selected.organisation_id
     AND shopify.provider = 'shopify'
     AND shopify.lifecycle = 'active'
    WHERE selected.organisation_id = NEW.organisation_id
      AND selected.revision = NEW.commerce_system_revision
      AND (
        (NEW.authority_kind = 'builtin_commerce'
          AND selected.system_kind = 'builtin_commerce'
          AND binding.integration_account_id = NEW.integration_account_id)
        OR
        (NEW.authority_kind = 'shopify'
          AND selected.system_kind = 'shopify'
          AND shopify.integration_account_id = NEW.integration_account_id)
      )
  ) THEN RAISE(ABORT, 'commerce_capability_activation_authority_mismatch') END);
END;
CREATE TRIGGER commerce_capability_activation_authority_lifecycle_update
BEFORE UPDATE OF lifecycle, revision, activated_by_user_id,
  inactivated_by_user_id
ON commerce_capability_activation
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM organisation_commerce_system AS selected
    LEFT JOIN commerce_merchant_binding AS binding
      ON binding.binding_id = selected.commerce_binding_id
     AND binding.organisation_id = selected.organisation_id
    LEFT JOIN integration_account AS shopify
      ON shopify.integration_account_id = selected.shopify_integration_account_id
     AND shopify.organisation_id = selected.organisation_id
     AND shopify.provider = 'shopify'
     AND shopify.lifecycle = 'active'
    WHERE selected.organisation_id = NEW.organisation_id
      AND selected.revision = NEW.commerce_system_revision
      AND (
        (NEW.authority_kind = 'builtin_commerce'
          AND selected.system_kind = 'builtin_commerce'
          AND binding.integration_account_id = NEW.integration_account_id)
        OR
        (NEW.authority_kind = 'shopify'
          AND selected.system_kind = 'shopify'
          AND shopify.integration_account_id = NEW.integration_account_id)
      )
  ) THEN RAISE(ABORT, 'commerce_capability_activation_authority_mismatch') END);
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
