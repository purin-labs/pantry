-- Organisation regional operational schema. Global identities and sessions remain in DB.
-- organisation_placement is the local execution fence; the global directory publishes epochs.
-- Current Pantry platform schema.

PRAGMA foreign_keys = ON;

CREATE TABLE organisation (
  organisation_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'beta',
  created_at INTEGER NOT NULL
, organisation_handle TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted', 'purged')));
CREATE TABLE workspace_ai_budget (
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
CREATE TABLE credential_ref (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  vault_handle TEXT NOT NULL,
  host_pattern TEXT NOT NULL,
  inject_as TEXT NOT NULL CHECK (json_valid(inject_as)),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (organisation_id, provider, name)
);
CREATE TABLE policy_snapshot (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  version INTEGER NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body)),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (organisation_id, version)
);
CREATE TABLE tool_call (
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  host TEXT NOT NULL,
  credential_ref TEXT,
  tool TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'denied', 'error')),
  started_at INTEGER NOT NULL,
  duration_ms INTEGER, integration_account_id TEXT REFERENCES integration_account (integration_account_id),
  PRIMARY KEY (session_id, call_id)
);
CREATE INDEX idx_tool_call_organisation_time ON tool_call (organisation_id, started_at);
CREATE TABLE thread_binding (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  thread_id TEXT NOT NULL,
  surface_kind TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  cursor TEXT,
  last_synced_rev TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')), integration_account_id TEXT REFERENCES integration_account (integration_account_id),
  PRIMARY KEY (organisation_id, thread_id, surface_kind, external_ref)
);
CREATE TABLE person (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  person_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  PRIMARY KEY (organisation_id, person_id)
);
CREATE TABLE cue_subscription (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  subscription_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  surface_scope TEXT NOT NULL CHECK (json_valid(surface_scope)),
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  condition TEXT CHECK (condition IS NULL OR json_valid(condition)),
  action TEXT NOT NULL CHECK (json_valid(action)),
  tier INTEGER NOT NULL DEFAULT 1,
  debounce_ms INTEGER,
  max_per_hour INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (organisation_id, subscription_id)
);
CREATE INDEX idx_cue_subscription_event ON cue_subscription (organisation_id, source, event_type);
CREATE TABLE vault_secret (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  vault_handle TEXT NOT NULL,
  key_version TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-GCM-256'),
  nonce_b64 TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (organisation_id, vault_handle)
);
CREATE INDEX idx_vault_secret_organisation_created ON vault_secret (organisation_id, created_at);
CREATE TABLE vault_item (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  vault_item_id TEXT NOT NULL CHECK (length(vault_item_id) = 32),
  kind TEXT NOT NULL CHECK (kind IN ('website_login', 'contact_profile')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  origins_json TEXT NOT NULL CHECK (json_valid(origins_json)),
  username TEXT,
  contact_json TEXT CHECK (contact_json IS NULL OR json_valid(contact_json)),
  vault_handle TEXT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, vault_item_id),
  CHECK ((kind = 'website_login') = (vault_handle IS NOT NULL AND username IS NOT NULL AND contact_json IS NULL)),
  CHECK ((kind = 'contact_profile') = (contact_json IS NOT NULL AND vault_handle IS NULL AND username IS NULL))
);
CREATE INDEX idx_vault_item_listing ON vault_item (organisation_id, kind, label);
CREATE TABLE vault_store (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  store TEXT NOT NULL CHECK (store = 'onepassword'),
  onepassword_vault_id TEXT NOT NULL CHECK (length(onepassword_vault_id) = 26),
  onepassword_vault_title TEXT NOT NULL CHECK (length(onepassword_vault_title) BETWEEN 1 AND 200),
  token_handle TEXT NOT NULL,
  connected_by_user_id TEXT NOT NULL,
  connected_at INTEGER NOT NULL
);
CREATE TABLE vault_item_event (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  event_id TEXT NOT NULL CHECK (length(event_id) = 32),
  kind TEXT NOT NULL CHECK (kind IN ('item_added', 'item_edited', 'sign_in_replaced', 'item_removed', 'item_moved', 'store_connected', 'store_disconnected')),
  item_id TEXT,
  item_label TEXT,
  store TEXT NOT NULL CHECK (store IN ('pantry', 'onepassword')),
  actor_user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, event_id)
);
CREATE INDEX idx_vault_item_event_item ON vault_item_event (organisation_id, item_id, at);
CREATE TABLE organisation_capability_policy (
  organisation_id TEXT NOT NULL REFERENCES organisation(organisation_id),
  capability_id TEXT NOT NULL CHECK (length(trim(capability_id)) > 0),
  capability_version INTEGER NOT NULL CHECK (capability_version > 0),
  mode TEXT NOT NULL CHECK (mode IN ('enabled', 'approval_required', 'disabled')),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  changed_at INTEGER NOT NULL CHECK (changed_at >= 0),
  PRIMARY KEY (organisation_id, capability_id, capability_version)
);
CREATE TABLE commerce_export_preset_publication (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation(organisation_id),
  preset_id TEXT NOT NULL CHECK (preset_id = 'export_coordination'),
  preset_version INTEGER NOT NULL CHECK (preset_version = 1),
  merchant_id TEXT NOT NULL,
  merchant_revision INTEGER NOT NULL CHECK (merchant_revision >= 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  digest TEXT NOT NULL CHECK (
    length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'
  ),
  configuration_version INTEGER NOT NULL CHECK (configuration_version > 0),
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  published_at INTEGER NOT NULL CHECK (published_at >= 0),
  UNIQUE (organisation_id, preset_id, preset_version)
) STRICT;
CREATE TABLE cue_log (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  cue_id TEXT NOT NULL,
  source TEXT NOT NULL,
  native_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (
    decision IN ('store_only', 'matched', 'proposed')
  ),
  reason TEXT,
  at INTEGER NOT NULL, parent_cue_id TEXT, surface_kind TEXT, surface_thread_id TEXT, integration_account_id TEXT REFERENCES integration_account (integration_account_id),
  PRIMARY KEY (organisation_id, cue_id)
);
CREATE INDEX idx_cue_dedup ON cue_log (organisation_id, source, native_id);
CREATE INDEX idx_binding_ext
ON thread_binding (organisation_id, surface_kind, external_ref);
CREATE TABLE thread_file_watch (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  thread_id TEXT NOT NULL,
  owner_person_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('gdrive', 'dropbox')),
  watch_id TEXT NOT NULL,
  binding_external_ref TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  external_account_id TEXT,
  cursor TEXT,
  resource_id TEXT,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'disabled')),
  created_at INTEGER NOT NULL, integration_account_id TEXT REFERENCES integration_account (integration_account_id),
  PRIMARY KEY (organisation_id, provider, watch_id)
);
CREATE UNIQUE INDEX idx_thread_file_watch_id
ON thread_file_watch (provider, watch_id);
CREATE INDEX idx_thread_file_watch_account
ON thread_file_watch (provider, external_account_id, status);
CREATE INDEX idx_thread_file_watch_thread
ON thread_file_watch (organisation_id, thread_id, provider, status);
CREATE TABLE discord_interaction_install (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  application_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  public_key_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  installed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_discord_interaction_application
  ON discord_interaction_install (application_id);
CREATE INDEX idx_cue_proposal_surface_thread
  ON cue_log (organisation_id, decision, surface_kind, surface_thread_id, at);
CREATE TABLE person_authz_audit (
  organisation_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('grant', 'revoke')),
  role TEXT NOT NULL CHECK (role IN ('approve')),
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'organisation_admin_token'),
  request_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, audit_id)
);
CREATE INDEX idx_person_authz_audit_person
ON person_authz_audit (organisation_id, person_id, recorded_at);
CREATE TABLE organisation_placement (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  placement_epoch INTEGER NOT NULL CHECK (placement_epoch > 0),
  placement_kind TEXT NOT NULL CHECK (placement_kind IN ('affinity', 'residency')),
  placement_cell_id TEXT NOT NULL,
  location_hint TEXT NOT NULL,
  residency_jurisdiction TEXT CHECK (
    (placement_kind = 'affinity' AND residency_jurisdiction IS NULL) OR
    (placement_kind = 'residency' AND residency_jurisdiction IN ('eu', 'fedramp'))
  ),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'active', 'frozen', 'retired', 'abandoned')),
  fence_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  frozen_at INTEGER,
  abandoned_at INTEGER,
  retired_at INTEGER, environment TEXT NOT NULL DEFAULT 'development'
CHECK (environment IN ('development', 'production')),
  PRIMARY KEY (organisation_id, placement_epoch),
  CHECK ((status = 'abandoned') = (abandoned_at IS NOT NULL)),
  CHECK (
    (status = 'abandoned' AND abandoned_at IS NOT NULL AND activated_at IS NULL AND frozen_at IS NULL AND retired_at IS NULL) OR
    (status = 'reserved' AND activated_at IS NULL AND frozen_at IS NULL AND retired_at IS NULL) OR
    (status = 'active' AND activated_at IS NOT NULL AND frozen_at IS NULL AND retired_at IS NULL) OR
    (status = 'frozen' AND activated_at IS NOT NULL AND frozen_at IS NOT NULL AND retired_at IS NULL) OR
    (status = 'retired' AND activated_at IS NOT NULL AND frozen_at IS NOT NULL AND retired_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_organisation_placement_active
  ON organisation_placement (organisation_id)
  WHERE status = 'active';
CREATE TABLE service_role_grant (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (organisation_id, user_id),
  FOREIGN KEY (organisation_id, person_id) REFERENCES person (organisation_id, person_id),
  CHECK (
    (status = 'active' AND revoked_at IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);
CREATE INDEX idx_service_role_grant_identity
  ON service_role_grant (user_id, status, organisation_id);
CREATE INDEX idx_service_role_grant_active_owner
  ON service_role_grant (organisation_id, status)
  WHERE role = 'owner';
CREATE TABLE organisation_onboarding_selection (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  policy_template_id TEXT NOT NULL,
  policy_template_version INTEGER NOT NULL CHECK (policy_template_version > 0),
  cue_preset_id TEXT NOT NULL CHECK (
    cue_preset_id IN ('observe_commerce', 'commerce_operator', 'proactive_triage')
  ),
  cue_preset_version INTEGER NOT NULL CHECK (cue_preset_version > 0),
  cue_workspace_id TEXT,
  cue_channel_id TEXT,
  selected_by_user_id TEXT NOT NULL,
  selected_at INTEGER NOT NULL,
  CHECK (
    (cue_preset_id = 'observe_commerce' AND cue_workspace_id IS NULL AND cue_channel_id IS NULL) OR
    (cue_preset_id IN ('commerce_operator', 'proactive_triage') AND
      cue_workspace_id IS NOT NULL AND cue_channel_id IS NOT NULL)
  )
);
CREATE TABLE provider_connection (
  provider_connection_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  source_kind TEXT NOT NULL DEFAULT 'built_in' CHECK (
    source_kind IN ('built_in', 'custom_api')
  ),
  custom_connector_id TEXT,
  provider TEXT NOT NULL,
  auth_mode TEXT NOT NULL CHECK (
    auth_mode IN ('shared_pantry_app', 'api_key', 'webhook_secret')
  ),
  authority_kind TEXT NOT NULL CHECK (
    authority_kind IN ('connection_credential', 'shared_application_asset_grant')
  ),
  credential_generation INTEGER CHECK (credential_generation > 0),
  credential_ref TEXT,
  provider_application TEXT CHECK (provider_application IN ('whatsapp')),
  application_credential_generation INTEGER CHECK (application_credential_generation > 0),
  asset_grant_revision INTEGER CHECK (asset_grant_revision > 0),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('connecting', 'active', 'reauth_required', 'disabled', 'revoked')
  ),
  granted_scopes TEXT NOT NULL CHECK (json_valid(granted_scopes)),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  revoked_at INTEGER, environment TEXT NOT NULL DEFAULT 'development'
CHECK (environment IN ('development', 'production')), provider_subject_id TEXT NOT NULL DEFAULT '',
  authorization_product TEXT NOT NULL DEFAULT 'standard' CHECK (
    authorization_product IN ('standard', 'full_mailbox_pilot', 'send_only')
  ),
  CHECK (
    (provider = 'gmail' AND authorization_product IN ('standard', 'full_mailbox_pilot', 'send_only')) OR
    (provider != 'gmail' AND authorization_product = 'standard')
  ),
  CHECK (
    (lifecycle IN ('connecting', 'active', 'reauth_required') AND disabled_at IS NULL AND revoked_at IS NULL) OR
    (lifecycle = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL) OR
    (lifecycle = 'revoked' AND revoked_at IS NOT NULL)
  ),
  CHECK (
    (authority_kind = 'connection_credential'
      AND credential_generation IS NOT NULL AND credential_ref IS NOT NULL
      AND provider_application IS NULL
      AND application_credential_generation IS NULL AND asset_grant_revision IS NULL) OR
    (authority_kind = 'shared_application_asset_grant'
      AND credential_generation IS NULL AND credential_ref IS NULL
      AND provider_application IS NOT NULL
      AND application_credential_generation IS NOT NULL AND asset_grant_revision IS NOT NULL)
  ),
  CHECK (
    (source_kind = 'built_in' AND custom_connector_id IS NULL AND provider != 'custom_api') OR
    (source_kind = 'custom_api' AND custom_connector_id IS NOT NULL AND provider = 'custom_api' AND
      authority_kind = 'connection_credential' AND auth_mode = 'api_key')
  ),
  FOREIGN KEY (custom_connector_id, organisation_id)
    REFERENCES custom_connector (connector_id, organisation_id)
);
CREATE INDEX idx_provider_connection_organisation_provider
  ON provider_connection (organisation_id, provider, lifecycle);
CREATE TABLE integration_account (
  integration_account_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  source_kind TEXT NOT NULL DEFAULT 'built_in' CHECK (
    source_kind IN ('built_in', 'custom_api')
  ),
  custom_connector_id TEXT,
  provider_connection_id TEXT NOT NULL REFERENCES provider_connection (provider_connection_id),
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  account_kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN (
      'connecting', 'pending_activation', 'active', 'degraded',
      'reauth_required', 'disabled', 'revoked'
    )
  ),
  lifecycle_reason_code TEXT,
  capability_set TEXT NOT NULL CHECK (json_valid(capability_set)),
  audience_policy TEXT NOT NULL CHECK (json_valid(audience_policy)),
  retention_policy TEXT NOT NULL CHECK (json_valid(retention_policy)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_by_user_id TEXT,
  disabled_at INTEGER,
  revoked_at INTEGER, environment TEXT NOT NULL DEFAULT 'development'
CHECK (environment IN ('development', 'production')), is_default_for_provider INTEGER NOT NULL DEFAULT 0
CHECK (is_default_for_provider IN (0, 1)),
  UNIQUE (
    integration_account_id, organisation_id, provider_account_id, account_kind, environment
  ),
  CHECK (
    (source_kind = 'built_in' AND custom_connector_id IS NULL AND provider != 'custom_api') OR
    (source_kind = 'custom_api' AND custom_connector_id IS NOT NULL AND
      provider = 'custom_api' AND is_default_for_provider = 0)
  ),
  FOREIGN KEY (custom_connector_id, organisation_id)
    REFERENCES custom_connector (connector_id, organisation_id),
  CHECK (
    (lifecycle IN ('connecting', 'pending_activation', 'active') AND
      lifecycle_reason_code IS NULL AND disabled_by_user_id IS NULL AND
      disabled_at IS NULL AND revoked_at IS NULL) OR
    (lifecycle IN ('degraded', 'reauth_required') AND lifecycle_reason_code IS NOT NULL AND
      disabled_by_user_id IS NULL AND disabled_at IS NULL AND revoked_at IS NULL) OR
    (lifecycle = 'disabled' AND lifecycle_reason_code IS NULL AND
      disabled_by_user_id IS NOT NULL AND disabled_at IS NOT NULL AND revoked_at IS NULL) OR
    (lifecycle = 'revoked' AND lifecycle_reason_code IS NULL AND
      disabled_by_user_id IS NULL AND disabled_at IS NULL AND revoked_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_integration_account_builtin_identity
  ON integration_account (organisation_id, provider, provider_account_id, account_kind)
  WHERE source_kind = 'built_in';
CREATE INDEX idx_integration_account_connection
  ON integration_account (provider_connection_id, lifecycle);
CREATE TABLE custom_connector (
  connector_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('draft', 'active', 'disabled', 'removed')
  ),
  head_revision INTEGER NOT NULL CHECK (head_revision > 0),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_by_user_id TEXT,
  disabled_at INTEGER,
  removed_by_user_id TEXT,
  removed_at INTEGER,
  UNIQUE (connector_id, organisation_id),
  CHECK (updated_at >= created_at),
  CHECK (
    (lifecycle IN ('draft', 'active') AND
      disabled_by_user_id IS NULL AND disabled_at IS NULL AND
      removed_by_user_id IS NULL AND removed_at IS NULL) OR
    (lifecycle = 'disabled' AND
      disabled_by_user_id IS NOT NULL AND disabled_at IS NOT NULL AND
      removed_by_user_id IS NULL AND removed_at IS NULL) OR
    (lifecycle = 'removed' AND
      removed_by_user_id IS NOT NULL AND removed_at IS NOT NULL AND
      ((disabled_by_user_id IS NULL AND disabled_at IS NULL) OR
       (disabled_by_user_id IS NOT NULL AND disabled_at IS NOT NULL)))
  )
);
CREATE INDEX idx_custom_connector_organisation_lifecycle
  ON custom_connector (organisation_id, lifecycle, updated_at DESC);
CREATE TABLE custom_connector_revision (
  organisation_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  authoring_document TEXT NOT NULL CHECK (
    json_valid(authoring_document) AND
    json_type(authoring_document) = 'object' AND
    length(CAST(authoring_document AS BLOB)) <= 262144
  ),
  authoring_digest TEXT NOT NULL CHECK (
    length(authoring_digest) = 64 AND
    authoring_digest NOT GLOB '*[^0-9a-f]*'
  ),
  canonical_definition TEXT CHECK (
    canonical_definition IS NULL OR
    (json_valid(canonical_definition) AND
     json_type(canonical_definition) = 'object' AND
     length(CAST(canonical_definition AS BLOB)) <= 262144)
  ),
  definition_digest TEXT CHECK (
    definition_digest IS NULL OR
    (length(definition_digest) = 64 AND
     definition_digest NOT GLOB '*[^0-9a-f]*')
  ),
  review_state TEXT NOT NULL CHECK (
    review_state IN ('draft', 'validated', 'approved', 'rejected', 'retired')
  ),
  validator_version TEXT,
  validated_at INTEGER,
  last_validation_error TEXT CHECK (
    last_validation_error IS NULL OR json_valid(last_validation_error)
  ),
  last_validation_attempted_at INTEGER,
  approved_by_user_id TEXT,
  approved_at INTEGER,
  approved_origin TEXT,
  approved_effects_json TEXT CHECK (
    approved_effects_json IS NULL OR
    (json_valid(approved_effects_json) AND json_type(approved_effects_json) = 'array')
  ),
  rejected_by_user_id TEXT,
  rejected_at INTEGER,
  rejection_reason TEXT,
  retired_by_user_id TEXT,
  retired_at INTEGER,
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, connector_id, revision),
  UNIQUE (organisation_id, connector_id, authoring_digest),
  UNIQUE (organisation_id, connector_id, revision, definition_digest),
  FOREIGN KEY (connector_id, organisation_id)
    REFERENCES custom_connector (connector_id, organisation_id),
  CHECK (
    (last_validation_error IS NULL AND last_validation_attempted_at IS NULL) OR
    (last_validation_error IS NOT NULL AND last_validation_attempted_at IS NOT NULL)
  ),
  CHECK (
    (review_state = 'draft' AND
      canonical_definition IS NULL AND definition_digest IS NULL AND
      validator_version IS NULL AND validated_at IS NULL AND
      approved_by_user_id IS NULL AND approved_at IS NULL AND
      approved_origin IS NULL AND approved_effects_json IS NULL AND
      rejected_by_user_id IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND
      retired_by_user_id IS NULL AND retired_at IS NULL) OR
    (review_state = 'validated' AND
      canonical_definition IS NOT NULL AND definition_digest IS NOT NULL AND
      validator_version IS NOT NULL AND validated_at IS NOT NULL AND
      last_validation_error IS NULL AND last_validation_attempted_at IS NULL AND
      approved_by_user_id IS NULL AND approved_at IS NULL AND
      approved_origin IS NULL AND approved_effects_json IS NULL AND
      rejected_by_user_id IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND
      retired_by_user_id IS NULL AND retired_at IS NULL) OR
    (review_state = 'approved' AND
      canonical_definition IS NOT NULL AND definition_digest IS NOT NULL AND
      validator_version IS NOT NULL AND validated_at IS NOT NULL AND
      last_validation_error IS NULL AND last_validation_attempted_at IS NULL AND
      approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND
      approved_origin IS NOT NULL AND approved_effects_json IS NOT NULL AND
      rejected_by_user_id IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND
      retired_by_user_id IS NULL AND retired_at IS NULL) OR
    (review_state = 'rejected' AND
      canonical_definition IS NOT NULL AND definition_digest IS NOT NULL AND
      validator_version IS NOT NULL AND validated_at IS NOT NULL AND
      last_validation_error IS NULL AND last_validation_attempted_at IS NULL AND
      approved_by_user_id IS NULL AND approved_at IS NULL AND
      approved_origin IS NULL AND approved_effects_json IS NULL AND
      rejected_by_user_id IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL AND
      retired_by_user_id IS NULL AND retired_at IS NULL) OR
    (review_state = 'retired' AND
      canonical_definition IS NOT NULL AND definition_digest IS NOT NULL AND
      validator_version IS NOT NULL AND validated_at IS NOT NULL AND
      last_validation_error IS NULL AND last_validation_attempted_at IS NULL AND
      approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND
      approved_origin IS NOT NULL AND approved_effects_json IS NOT NULL AND
      rejected_by_user_id IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND
      retired_by_user_id IS NOT NULL AND retired_at IS NOT NULL)
  )
);
CREATE INDEX idx_custom_connector_revision_review
  ON custom_connector_revision (organisation_id, connector_id, review_state, revision DESC);
CREATE TRIGGER custom_connector_revision_content_immutable
BEFORE UPDATE OF organisation_id, connector_id, revision, authoring_document,
  authoring_digest, created_by_user_id, created_at
ON custom_connector_revision
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_revision_content_immutable');
END;
CREATE TRIGGER custom_connector_revision_transition
BEFORE UPDATE OF review_state ON custom_connector_revision
WHEN NOT (
  (OLD.review_state = 'draft' AND NEW.review_state = 'validated') OR
  (OLD.review_state = 'validated' AND NEW.review_state IN ('approved', 'rejected')) OR
  (OLD.review_state = 'approved' AND NEW.review_state = 'retired')
)
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_revision_transition_invalid');
END;
CREATE TRIGGER custom_connector_revision_validation_immutable
BEFORE UPDATE OF canonical_definition, definition_digest, validator_version,
  validated_at
ON custom_connector_revision
WHEN OLD.review_state != 'draft' OR NEW.review_state != 'validated'
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_revision_validation_immutable');
END;
CREATE TRIGGER custom_connector_revision_approval_immutable
BEFORE UPDATE OF approved_by_user_id, approved_at, approved_origin,
  approved_effects_json
ON custom_connector_revision
WHEN OLD.review_state IN ('approved', 'retired')
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_revision_approval_immutable');
END;
CREATE TRIGGER custom_connector_revision_terminal_immutable
BEFORE UPDATE ON custom_connector_revision
WHEN OLD.review_state IN ('rejected', 'retired')
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_revision_terminal_immutable');
END;
CREATE TRIGGER custom_connector_revision_sequence
BEFORE INSERT ON custom_connector_revision
WHEN (NEW.revision != (
  SELECT head_revision FROM custom_connector
  WHERE connector_id = NEW.connector_id AND organisation_id = NEW.organisation_id
)) AND NOT EXISTS (SELECT 1 FROM organisation_placement import_placement WHERE import_placement.organisation_id = NEW.organisation_id AND import_placement.status = 'reserved' AND NOT EXISTS (SELECT 1 FROM organisation_placement live_placement WHERE live_placement.organisation_id = NEW.organisation_id AND live_placement.status = 'active'))
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_revision_head_mismatch');
END;
CREATE TRIGGER custom_connector_head_advance
BEFORE UPDATE OF head_revision ON custom_connector
WHEN NEW.head_revision != OLD.head_revision + 1 OR OLD.lifecycle = 'removed'
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_head_advance_invalid');
END;
CREATE TRIGGER custom_connector_removed_immutable
BEFORE UPDATE ON custom_connector
WHEN OLD.lifecycle = 'removed'
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_removed_immutable');
END;
CREATE TABLE custom_connector_setup_attempt (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  attempt_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  connector_revision INTEGER NOT NULL CHECK (connector_revision > 0),
  definition_digest TEXT NOT NULL CHECK (
    length(definition_digest) = 64 AND
    definition_digest NOT GLOB '*[^0-9a-f]*'
  ),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  target_kind TEXT NOT NULL CHECK (
    target_kind IN (
      'new_account', 'rotate_account', 'upgrade_account', 'resume_account'
    )
  ),
  target_integration_account_id TEXT,
  expected_binding_revision INTEGER CHECK (
    expected_binding_revision IS NULL OR expected_binding_revision > 0
  ),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN (
      'awaiting_credential', 'credential_stored', 'testing', 'verified',
      'committed', 'failed', 'cancelled', 'expired'
    )
  ),
  attempt_revision INTEGER NOT NULL CHECK (attempt_revision > 0),
  candidate_generation INTEGER NOT NULL CHECK (candidate_generation IN (0, 1)),
  candidate_credential_ref TEXT,
  tested_candidate_generation INTEGER,
  test_started_at INTEGER,
  verified_provider_account_id TEXT,
  verified_display_name TEXT,
  result_schema_digest TEXT CHECK (
    result_schema_digest IS NULL OR
    (length(result_schema_digest) = 64 AND
     result_schema_digest NOT GLOB '*[^0-9a-f]*')
  ),
  tested_at INTEGER,
  committed_integration_account_id TEXT
    REFERENCES integration_account (integration_account_id),
  cancelled_by_user_id TEXT,
  failure_code TEXT,
  failure_correlation_id TEXT,
  created_by_user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (organisation_id, attempt_id),
  UNIQUE (attempt_id),
  FOREIGN KEY (organisation_id, connector_id, connector_revision, definition_digest)
    REFERENCES custom_connector_revision (
      organisation_id, connector_id, revision, definition_digest
    ),
  FOREIGN KEY (organisation_id, candidate_credential_ref)
    REFERENCES vault_secret (organisation_id, vault_handle),
  FOREIGN KEY (organisation_id, target_integration_account_id)
    REFERENCES custom_connector_account_binding (organisation_id, integration_account_id),
  CHECK (expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (target_kind = 'new_account' AND target_integration_account_id IS NULL AND
      expected_binding_revision IS NULL) OR
    (target_kind IN ('rotate_account', 'upgrade_account', 'resume_account') AND
      target_integration_account_id IS NOT NULL AND
      expected_binding_revision IS NOT NULL)
  ),
  CHECK (
    (candidate_generation = 0 AND candidate_credential_ref IS NULL) OR
    (candidate_generation = 1 AND candidate_credential_ref IS NOT NULL)
  ),
  CHECK (
    (tested_candidate_generation IS NULL AND test_started_at IS NULL AND
      verified_provider_account_id IS NULL AND verified_display_name IS NULL AND
      result_schema_digest IS NULL AND tested_at IS NULL) OR
    (tested_candidate_generation = candidate_generation AND test_started_at IS NOT NULL AND
      verified_provider_account_id IS NULL AND verified_display_name IS NULL AND
      result_schema_digest IS NULL AND tested_at IS NULL) OR
    (tested_candidate_generation = candidate_generation AND test_started_at IS NOT NULL AND
      verified_provider_account_id IS NOT NULL AND verified_display_name IS NOT NULL AND
      result_schema_digest IS NOT NULL AND tested_at IS NOT NULL)
  ),
  CHECK (
    (lifecycle = 'awaiting_credential' AND candidate_generation = 0 AND
      tested_candidate_generation IS NULL AND committed_integration_account_id IS NULL AND
      cancelled_by_user_id IS NULL AND failure_code IS NULL AND
      failure_correlation_id IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'credential_stored' AND candidate_generation = 1 AND
      tested_candidate_generation IS NULL AND committed_integration_account_id IS NULL AND
      cancelled_by_user_id IS NULL AND failure_code IS NULL AND
      failure_correlation_id IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'testing' AND candidate_generation = 1 AND
      tested_candidate_generation = 1 AND tested_at IS NULL AND
      committed_integration_account_id IS NULL AND
      cancelled_by_user_id IS NULL AND failure_code IS NULL AND
      failure_correlation_id IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'verified' AND candidate_generation = 1 AND
      tested_candidate_generation = 1 AND tested_at IS NOT NULL AND
      committed_integration_account_id IS NULL AND
      cancelled_by_user_id IS NULL AND failure_code IS NULL AND
      failure_correlation_id IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'committed' AND candidate_generation = 1 AND
      tested_candidate_generation = 1 AND tested_at IS NOT NULL AND
      committed_integration_account_id IS NOT NULL AND
      cancelled_by_user_id IS NULL AND failure_code IS NULL AND
      failure_correlation_id IS NULL AND completed_at IS NOT NULL) OR
    (lifecycle = 'failed' AND candidate_generation = 1 AND
      committed_integration_account_id IS NULL AND
      cancelled_by_user_id IS NULL AND failure_code IS NOT NULL AND
      failure_correlation_id IS NOT NULL AND completed_at IS NOT NULL) OR
    (lifecycle = 'cancelled' AND committed_integration_account_id IS NULL AND
      cancelled_by_user_id IS NOT NULL AND failure_code IS NULL AND
      failure_correlation_id IS NULL AND completed_at IS NOT NULL) OR
    (lifecycle = 'expired' AND committed_integration_account_id IS NULL AND
      cancelled_by_user_id IS NULL AND failure_code IS NULL AND
      failure_correlation_id IS NULL AND completed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_custom_connector_setup_open_new_account
  ON custom_connector_setup_attempt (organisation_id, connector_id, environment)
  WHERE target_kind = 'new_account' AND lifecycle IN (
    'awaiting_credential', 'credential_stored', 'testing', 'verified'
  );
CREATE UNIQUE INDEX idx_custom_connector_setup_open_existing_account
  ON custom_connector_setup_attempt (organisation_id, target_integration_account_id)
  WHERE lifecycle IN (
    'awaiting_credential', 'credential_stored', 'testing', 'verified'
  ) AND target_kind IN ('rotate_account', 'upgrade_account', 'resume_account');
CREATE INDEX idx_custom_connector_setup_expiry
  ON custom_connector_setup_attempt (expires_at, lifecycle);
CREATE TRIGGER custom_connector_setup_identity_immutable
BEFORE UPDATE OF organisation_id, attempt_id, connector_id, connector_revision,
  definition_digest, environment, target_kind, target_integration_account_id,
  expected_binding_revision, created_by_user_id, expires_at, created_at
ON custom_connector_setup_attempt
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_setup_identity_immutable');
END;
CREATE TRIGGER custom_connector_setup_revision_advance
BEFORE UPDATE OF attempt_revision ON custom_connector_setup_attempt
WHEN NEW.attempt_revision != OLD.attempt_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_setup_revision_advance_invalid');
END;
CREATE TRIGGER custom_connector_setup_transition
BEFORE UPDATE OF lifecycle ON custom_connector_setup_attempt
WHEN NOT (
  (OLD.lifecycle = 'awaiting_credential' AND
    NEW.lifecycle IN ('credential_stored', 'cancelled', 'expired')) OR
  (OLD.lifecycle = 'credential_stored' AND
    NEW.lifecycle IN ('testing', 'cancelled', 'expired')) OR
  (OLD.lifecycle = 'testing' AND
    NEW.lifecycle IN ('verified', 'failed', 'cancelled', 'expired')) OR
  (OLD.lifecycle = 'verified' AND
    NEW.lifecycle IN ('testing', 'committed', 'cancelled', 'expired'))
)
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_setup_transition_invalid');
END;
CREATE TRIGGER custom_connector_setup_candidate_immutable
BEFORE UPDATE OF candidate_generation, candidate_credential_ref
ON custom_connector_setup_attempt
WHEN OLD.candidate_generation = 1
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_setup_candidate_immutable');
END;
CREATE TRIGGER custom_connector_setup_terminal_immutable
BEFORE UPDATE ON custom_connector_setup_attempt
WHEN OLD.lifecycle IN ('committed', 'failed', 'cancelled', 'expired')
BEGIN
  SELECT RAISE(ABORT, 'custom_connector_setup_terminal_immutable');
END;
CREATE TABLE custom_connector_account_binding (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  provider_account_id TEXT NOT NULL,
  account_kind TEXT NOT NULL,
  accepted_revision INTEGER NOT NULL CHECK (accepted_revision > 0),
  accepted_definition_digest TEXT NOT NULL CHECK (
    length(accepted_definition_digest) = 64 AND
    accepted_definition_digest NOT GLOB '*[^0-9a-f]*'
  ),
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  credential_generation INTEGER NOT NULL CHECK (credential_generation > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'disabled', 'revoked')),
  is_default_for_connector INTEGER NOT NULL CHECK (is_default_for_connector IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (organisation_id, integration_account_id),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id),
  FOREIGN KEY (connector_id, organisation_id)
    REFERENCES custom_connector (connector_id, organisation_id),
  FOREIGN KEY (
    organisation_id, connector_id, accepted_revision, accepted_definition_digest
  ) REFERENCES custom_connector_revision (
    organisation_id, connector_id, revision, definition_digest
  ),
  UNIQUE (organisation_id, environment, connector_id, provider_account_id, account_kind),
  CHECK (updated_at >= created_at),
  CHECK (
    (lifecycle = 'active' AND disabled_at IS NULL AND revoked_at IS NULL) OR
    (lifecycle = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL) OR
    (lifecycle = 'revoked' AND revoked_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_custom_connector_account_default
  ON custom_connector_account_binding (organisation_id, environment, connector_id)
  WHERE lifecycle = 'active' AND is_default_for_connector = 1;
CREATE INDEX idx_custom_connector_account_revision
  ON custom_connector_account_binding (
    organisation_id, connector_id, accepted_revision, lifecycle
  );
CREATE TABLE provider_webhook (
  provider_webhook_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL REFERENCES integration_account (integration_account_id),
  provider TEXT NOT NULL,
  provider_native_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('pending', 'live', 'degraded', 'disabled', 'revoked')
  ),
  lifecycle_reason_code TEXT,
  signing_secret_ref TEXT NOT NULL,
  credential_generation INTEGER NOT NULL CHECK (credential_generation > 0),
  last_verified_at INTEGER,
  updated_at INTEGER NOT NULL, environment TEXT NOT NULL DEFAULT 'development'
CHECK (environment IN ('development', 'production')),
  UNIQUE (integration_account_id, provider_native_id, event_type),
  CHECK (
    (lifecycle IN ('pending', 'live', 'disabled', 'revoked') AND lifecycle_reason_code IS NULL) OR
    (lifecycle = 'degraded' AND lifecycle_reason_code IS NOT NULL)
  )
);
CREATE TABLE surface_installation (
  integration_account_id TEXT PRIMARY KEY REFERENCES integration_account (integration_account_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  surface_kind TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  install_model TEXT NOT NULL CHECK (install_model IN ('unlisted', 'marketplace', 'custom')),
  bot_token_ref TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  installed_at INTEGER NOT NULL,
  last_event_received_at INTEGER
);
CREATE INDEX idx_surface_installation_workspace
ON surface_installation (surface_kind, workspace_id);
CREATE TABLE organisation_setup_snapshot (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('policy', 'cue')),
  snapshot_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  body TEXT NOT NULL CHECK (json_valid(body)),
  selected_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, snapshot_kind, snapshot_id)
);
CREATE INDEX idx_organisation_setup_snapshot_latest
  ON organisation_setup_snapshot (organisation_id, snapshot_kind, created_at DESC);
CREATE TABLE organisation_activation_attempt (
  activation_attempt_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  readiness_version INTEGER NOT NULL,
  readiness_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'failed', 'completed')),
  failure_code TEXT,
  retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER, environment TEXT NOT NULL DEFAULT 'development'
CHECK (environment IN ('development', 'production')), lease_owner TEXT, lease_expires_at INTEGER,
  UNIQUE (organisation_id, readiness_hash),
  CHECK (
    (status = 'running' AND failure_code IS NULL AND retryable IS NULL AND completed_at IS NULL) OR
    (status = 'failed' AND failure_code IS NOT NULL AND retryable IS NOT NULL AND completed_at IS NULL) OR
    (status = 'completed' AND failure_code IS NULL AND retryable IS NULL AND completed_at IS NOT NULL)
  )
);
CREATE TABLE organisation_activation_step (
  activation_attempt_id TEXT NOT NULL REFERENCES organisation_activation_attempt (activation_attempt_id),
  step TEXT NOT NULL CHECK (
    step IN ('readiness', 'placement', 'policy', 'cues', 'accounts', 'publish')
  ),
  status TEXT NOT NULL CHECK (status IN ('completed', 'compensated')),
  receipt TEXT NOT NULL CHECK (json_valid(receipt)),
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (activation_attempt_id, step)
);
CREATE TABLE organisation_activation_receipt (
  activation_receipt_id TEXT PRIMARY KEY,
  activation_attempt_id TEXT NOT NULL UNIQUE REFERENCES organisation_activation_attempt (activation_attempt_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  readiness_hash TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  cue_snapshot_id TEXT NOT NULL,
  capability_profile TEXT NOT NULL CHECK (
    capability_profile IN ('read_and_propose', 'approved_provider_writes')
  ),
  activated_at INTEGER NOT NULL
, environment TEXT NOT NULL DEFAULT 'development'
CHECK (environment IN ('development', 'production')));
CREATE TABLE credential_rotation (
  credential_rotation_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  provider_connection_id TEXT NOT NULL REFERENCES provider_connection (provider_connection_id),
  expected_generation INTEGER NOT NULL CHECK (expected_generation > 0),
  replacement_credential_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_verification', 'verified', 'committed', 'failed')),
  failure_code TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  committed_at INTEGER,
  CHECK (
    (status = 'pending_verification' AND failure_code IS NULL AND verified_at IS NULL AND committed_at IS NULL) OR
    (status = 'verified' AND failure_code IS NULL AND verified_at IS NOT NULL AND committed_at IS NULL) OR
    (status = 'committed' AND failure_code IS NULL AND verified_at IS NOT NULL AND committed_at IS NOT NULL) OR
    (status = 'failed' AND failure_code IS NOT NULL AND committed_at IS NULL)
  )
);
CREATE TABLE organisation_readiness_assessment (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  readiness_version INTEGER NOT NULL CHECK (readiness_version > 0),
  readiness_hash TEXT NOT NULL,
  configuration_version INTEGER NOT NULL CHECK (configuration_version > 0),
  capability_profile TEXT NOT NULL CHECK (
    capability_profile IN ('read_and_propose', 'approved_provider_writes')
  ),
  policy_snapshot_id TEXT,
  cue_snapshot_id TEXT,
  blockers TEXT NOT NULL CHECK (json_valid(blockers)),
  assessed_at INTEGER NOT NULL, environment TEXT NOT NULL DEFAULT 'development'
CHECK (environment IN ('development', 'production')), approval_authentication_json TEXT
  CHECK (
    approval_authentication_json IS NULL
    OR json_valid(approval_authentication_json)
  ),
  PRIMARY KEY (organisation_id, readiness_version),
  UNIQUE (organisation_id, readiness_hash)
);
CREATE TABLE organisation_onboarding (
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
CREATE UNIQUE INDEX idx_integration_account_default_for_provider
  ON integration_account (organisation_id, provider, environment)
  WHERE source_kind = 'built_in' AND is_default_for_provider = 1;
CREATE TABLE control_mutation_receipt (
  receipt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  organisation_scope TEXT NOT NULL,
  route TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 599),
  response_body TEXT NOT NULL CHECK (json_valid(response_body)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (user_id, organisation_scope, route, operation, idempotency_key),
  CHECK (expires_at >= created_at + 86400000)
);
CREATE INDEX idx_control_mutation_receipt_expiry
  ON control_mutation_receipt (expires_at);
CREATE TABLE onboarding_audit_event (
  audit_event_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  actor_user_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  old_lifecycle TEXT,
  new_lifecycle TEXT,
  configuration_version INTEGER NOT NULL CHECK (configuration_version > 0),
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  idempotency_receipt_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX idx_onboarding_audit_organisation_time
  ON onboarding_audit_event (organisation_id, occurred_at DESC);
CREATE TABLE onboarding_event (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'onboarding_started', 'onboarding_resumed', 'onboarding_stage_viewed',
      'onboarding_stage_completed', 'organisation_created', 'organisation_archived',
      'provider_attempt_started', 'provider_attempt_connected',
      'provider_attempt_cancelled', 'provider_attempt_failed',
      'provider_attempt_expired', 'provider_reconciliation_started',
      'provider_reconciliation_completed', 'provider_reconciliation_failed',
      'default_account_changed', 'setup_saved', 'readiness_assessed',
      'readiness_invalidated', 'activation_started',
      'activation_phase_completed', 'activation_succeeded',
      'activation_failed', 'first_task_presented', 'support_reference_created'
    )
  ),
  occurred_at INTEGER NOT NULL,
  organisation_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  portal_subject_hash TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  attributes TEXT NOT NULL CHECK (json_valid(attributes))
);
CREATE INDEX idx_onboarding_event_organisation_time
  ON onboarding_event (organisation_id, occurred_at DESC);
CREATE INDEX idx_onboarding_event_type_time
  ON onboarding_event (event_type, occurred_at DESC);
CREATE TABLE organisation_archive_cleanup (
  organisation_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  archive_receipt_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('pending_provider_cleanup', 'pending_purge', 'purged', 'failed')
  ),
  failure_code TEXT,
  archived_at INTEGER NOT NULL,
  purge_after INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (purge_after > archived_at),
  CHECK (
    (status IN ('pending_provider_cleanup', 'pending_purge', 'purged') AND failure_code IS NULL) OR
    (status = 'failed' AND failure_code IS NOT NULL)
  )
);
CREATE TABLE provider_provisioning_receipt (
  receipt_id TEXT PRIMARY KEY,
  provisioning_attempt_id TEXT NOT NULL REFERENCES provider_provisioning_attempt (provisioning_attempt_id),
  phase TEXT NOT NULL CHECK (
    phase IN (
      'discovering_identity', 'persisting_credential', 'discovering_accounts',
      'reconciling_webhooks', 'discovering_resources',
      'verifying_connection', 'finalizing'
    )
  ),
  receipt TEXT NOT NULL CHECK (json_valid(receipt)),
  completed_at INTEGER NOT NULL,
  UNIQUE (provisioning_attempt_id, phase)
);
CREATE TABLE provider_credential_generation (
  provider_connection_id TEXT NOT NULL REFERENCES provider_connection (provider_connection_id),
  credential_generation INTEGER NOT NULL CHECK (credential_generation > 0),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  credential_ref TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('staged', 'active', 'superseded', 'revoked', 'failed')
  ),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  superseded_at INTEGER,
  revoked_at INTEGER,
  failed_at INTEGER,
  failure_code TEXT,
  PRIMARY KEY (provider_connection_id, credential_generation),
  CHECK (
    (lifecycle = 'staged' AND activated_at IS NULL AND superseded_at IS NULL AND
      revoked_at IS NULL AND failed_at IS NULL AND failure_code IS NULL) OR
    (lifecycle = 'active' AND activated_at IS NOT NULL AND superseded_at IS NULL AND
      revoked_at IS NULL AND failed_at IS NULL AND failure_code IS NULL) OR
    (lifecycle = 'superseded' AND activated_at IS NOT NULL AND superseded_at IS NOT NULL AND
      revoked_at IS NULL AND failed_at IS NULL AND failure_code IS NULL) OR
    (lifecycle = 'revoked' AND activated_at IS NOT NULL AND revoked_at IS NOT NULL AND
      failed_at IS NULL AND failure_code IS NULL) OR
    (lifecycle = 'failed' AND activated_at IS NULL AND superseded_at IS NULL AND
      revoked_at IS NULL AND failed_at IS NOT NULL AND failure_code IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_provider_credential_active
  ON provider_credential_generation (provider_connection_id)
  WHERE lifecycle = 'active';
CREATE TABLE provider_manifest_observation (
  observation_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL REFERENCES integration_account (integration_account_id),
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  manifest_version INTEGER NOT NULL CHECK (manifest_version > 0),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('healthy', 'degraded', 'blocked', 'observation_unsupported')
  ),
  evidence_code TEXT CHECK (
    evidence_code IS NULL OR evidence_code IN (
      'callback_identity_verified',
      'provider_identity_verified',
      'provider_webhook_verified',
      'shared_application_subscription_verified'
    )
  ),
  reason_code TEXT,
  missing_optional_capabilities TEXT CHECK (
    missing_optional_capabilities IS NULL OR json_valid(missing_optional_capabilities)
  ),
  repair_actions TEXT CHECK (repair_actions IS NULL OR json_valid(repair_actions)),
  observed_at INTEGER NOT NULL,
  CHECK (
    (lifecycle = 'healthy' AND evidence_code IS NOT NULL AND reason_code IS NULL AND
      missing_optional_capabilities IS NULL AND repair_actions IS NULL) OR
    (lifecycle = 'degraded' AND evidence_code IS NULL AND reason_code IS NULL AND
      missing_optional_capabilities IS NOT NULL AND repair_actions IS NOT NULL) OR
    (lifecycle = 'blocked' AND evidence_code IS NULL AND reason_code IS NOT NULL AND
      repair_actions IS NOT NULL) OR
    (lifecycle = 'observation_unsupported' AND evidence_code IS NULL AND reason_code IS NULL AND
      missing_optional_capabilities IS NULL AND repair_actions IS NULL)
  )
);
CREATE INDEX idx_provider_manifest_observation_account
  ON provider_manifest_observation (integration_account_id, observed_at DESC);
CREATE TABLE provider_resource_snapshot (
  snapshot_revision TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL REFERENCES integration_account (integration_account_id),
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  query_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE provider_discovered_resource (
  snapshot_revision TEXT NOT NULL REFERENCES provider_resource_snapshot (snapshot_revision),
  canonical_resource_id TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  display_label TEXT NOT NULL,
  access_state TEXT NOT NULL CHECK (access_state IN ('accessible', 'inaccessible')),
  provider_revision TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  PRIMARY KEY (snapshot_revision, canonical_resource_id)
);
CREATE TABLE provider_default_account_history (
  default_account_change_receipt_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  previous_integration_account_id TEXT REFERENCES integration_account (integration_account_id),
  next_integration_account_id TEXT NOT NULL REFERENCES integration_account (integration_account_id),
  changed_by_user_id TEXT NOT NULL,
  configuration_version INTEGER NOT NULL CHECK (configuration_version > 0),
  changed_at INTEGER NOT NULL
);
CREATE TABLE provider_account_cleanup (
  cleanup_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL
    REFERENCES integration_account (integration_account_id),
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('pending_provider_cleanup', 'running_provider_cleanup', 'retry_scheduled',
      'manual_action_required', 'completed')
  ),
  reason_code TEXT,
  instruction_code TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= created_at),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER, provider_account_id TEXT, provider_connection_id TEXT, credential_handles TEXT CHECK (
    credential_handles IS NULL OR json_valid(credential_handles)
  ), provider_webhook_ids TEXT CHECK (
    provider_webhook_ids IS NULL OR json_valid(provider_webhook_ids)
  ), provider_context TEXT NOT NULL CHECK (
    json_valid(provider_context)
  ),
  CHECK (
    (lifecycle = 'pending_provider_cleanup' AND attempt = 0
      AND reason_code IS NULL AND instruction_code IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'running_provider_cleanup' AND attempt > 0
      AND reason_code IS NULL AND instruction_code IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'retry_scheduled' AND attempt > 0
      AND reason_code IS NOT NULL AND instruction_code IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'manual_action_required' AND attempt >= 0
      AND reason_code IS NOT NULL AND instruction_code IS NOT NULL AND completed_at IS NOT NULL) OR
    (lifecycle = 'completed' AND reason_code IS NULL
      AND instruction_code IS NULL AND completed_at IS NOT NULL)
  )
);
CREATE INDEX idx_provider_account_cleanup_due
  ON provider_account_cleanup (organisation_id, lifecycle, next_attempt_at, created_at);
CREATE TABLE provider_account_tombstone (
  integration_account_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  provider_account_hash TEXT NOT NULL,
  removed_by_user_id TEXT NOT NULL,
  removal_receipt_id TEXT NOT NULL UNIQUE,
  removed_at INTEGER NOT NULL
);
CREATE TABLE onboarding_reconciliation_run (
  reconciliation_run_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  subject_kind TEXT NOT NULL CHECK (
    subject_kind IN (
      'open_attempts', 'credentials', 'accounts', 'webhooks', 'default_accounts',
      'setup_snapshots', 'readiness', 'activation', 'archived_organisation',
      'email_watches'
    )
  ),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('running', 'completed', 'failed')
  ),
  repair_count INTEGER NOT NULL CHECK (repair_count >= 0),
  reason_code TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (
    (lifecycle = 'running' AND reason_code IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'completed' AND reason_code IS NULL AND completed_at IS NOT NULL) OR
    (lifecycle = 'failed' AND reason_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE TABLE provider_resource_cursor (
  cursor_hash TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL
    REFERENCES integration_account (integration_account_id),
  snapshot_revision TEXT NOT NULL
    REFERENCES provider_resource_snapshot (snapshot_revision),
  query_hash TEXT NOT NULL,
  next_offset INTEGER NOT NULL CHECK (next_offset >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX idx_provider_resource_cursor_expiry
  ON provider_resource_cursor (expires_at);
CREATE TABLE organisation_archive_tombstone (
  organisation_id TEXT PRIMARY KEY,
  archive_authority_subject_hash TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  archival_reason TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  purge_after INTEGER NOT NULL,
  purged_at INTEGER, archive_authority_kind TEXT NOT NULL DEFAULT 'organisation_owner'
CHECK (archive_authority_kind IN ('organisation_owner', 'support_admin')),
  CHECK (purge_after > archived_at),
  CHECK (purged_at IS NULL OR purged_at >= archived_at)
);
CREATE INDEX idx_organisation_archive_tombstone_purge
  ON organisation_archive_tombstone (purge_after, purged_at);

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
CREATE INDEX idx_organisation_activation_attempt_lease
  ON organisation_activation_attempt (organisation_id, status, lease_expires_at);
CREATE TABLE commerce_lab_organisation (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  lab_namespace TEXT NOT NULL UNIQUE CHECK (
    length(lab_namespace) BETWEEN 8 AND 128
    AND lab_namespace GLOB 'lab_*'
  ),
  scenario_catalog_version TEXT NOT NULL CHECK (
    length(scenario_catalog_version) BETWEEN 1 AND 64
  ),
  marked_at INTEGER NOT NULL CHECK (marked_at >= 0),
  UNIQUE (organisation_id, lab_namespace)
);
CREATE TABLE commerce_lab_run (
  run_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES commerce_lab_organisation (organisation_id),
  lab_namespace TEXT NOT NULL,
  scenario_id TEXT NOT NULL CHECK (
    scenario_id IN (
      'product-listing',
      'happy-order',
      'payment-failed',
      'inventory-shortage',
      'shipment-delayed',
      'cancellation-refund'
    )
  ),
  scenario_version INTEGER NOT NULL CHECK (scenario_version = 1),
  scenario_catalog_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('running', 'completed', 'failed')
  ),
  provider_event_ids TEXT NOT NULL CHECK (json_valid(provider_event_ids)),
  expected_projection TEXT NOT NULL CHECK (json_valid(expected_projection)),
  expected_slack_effect TEXT NOT NULL CHECK (json_valid(expected_slack_effect)),
  publication_proposal TEXT NOT NULL CHECK (json_valid(publication_proposal)),
  failure_stage TEXT,
  failure_code TEXT,
  failure_provider_event_id TEXT,
  failure_projection_id TEXT,
  failure_slack_effect_id TEXT,
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  completed_at INTEGER,
  UNIQUE (organisation_id, idempotency_key),
  FOREIGN KEY (organisation_id, lab_namespace)
    REFERENCES commerce_lab_organisation (organisation_id, lab_namespace),
  CHECK (
    (
      lifecycle = 'running'
      AND failure_stage IS NULL
      AND failure_code IS NULL
      AND failure_provider_event_id IS NULL
      AND failure_projection_id IS NULL
      AND failure_slack_effect_id IS NULL
      AND completed_at IS NULL
    ) OR
    (
      lifecycle = 'completed'
      AND failure_stage IS NULL
      AND failure_code IS NULL
      AND failure_provider_event_id IS NULL
      AND failure_projection_id IS NULL
      AND failure_slack_effect_id IS NULL
      AND completed_at IS NOT NULL
    ) OR
    (lifecycle = 'failed' AND failure_stage IS NOT NULL AND failure_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE INDEX idx_commerce_lab_run_organisation_time
  ON commerce_lab_run (organisation_id, started_at);
CREATE INDEX idx_vault_secret_key_version_cursor
  ON vault_secret (key_version, organisation_id, vault_handle);
CREATE TABLE credential_revocation_operation (
  revocation_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  vault_handle TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('committed', 'policy_activated')),
  credential_generation_count INTEGER NOT NULL CHECK (credential_generation_count >= 0),
  provider_connection_count INTEGER NOT NULL CHECK (provider_connection_count >= 0),
  integration_account_count INTEGER NOT NULL CHECK (integration_account_count >= 0),
  provider_webhook_count INTEGER NOT NULL CHECK (provider_webhook_count >= 0),
  credential_ref_count INTEGER NOT NULL CHECK (credential_ref_count >= 0),
  vault_secret_count INTEGER NOT NULL CHECK (vault_secret_count >= 0),
  policy_version INTEGER CHECK (policy_version IS NULL OR policy_version >= 0),
  restriction_version INTEGER CHECK (restriction_version IS NULL OR restriction_version >= 0),
  target_consumer_count INTEGER CHECK (
    target_consumer_count IS NULL OR target_consumer_count >= 0
  ),
  acknowledged_consumer_count INTEGER CHECK (
    acknowledged_consumer_count IS NULL OR acknowledged_consumer_count >= 0
  ),
  pending_consumer_count INTEGER CHECK (
    pending_consumer_count IS NULL OR pending_consumer_count >= 0
  ),
  retry_count INTEGER CHECK (retry_count IS NULL OR retry_count >= 0),
  restriction_latency_ms INTEGER CHECK (
    restriction_latency_ms IS NULL OR restriction_latency_ms >= 0
  ),
  started_at INTEGER NOT NULL,
  committed_at INTEGER NOT NULL,
  policy_activated_at INTEGER,
  CHECK (
    (state = 'committed' AND
      policy_version IS NULL AND restriction_version IS NULL AND
      target_consumer_count IS NULL AND acknowledged_consumer_count IS NULL AND
      pending_consumer_count IS NULL AND retry_count IS NULL AND
      restriction_latency_ms IS NULL AND policy_activated_at IS NULL) OR
    (state = 'policy_activated' AND
      policy_version IS NOT NULL AND restriction_version IS NOT NULL AND
      target_consumer_count IS NOT NULL AND acknowledged_consumer_count IS NOT NULL AND
      pending_consumer_count IS NOT NULL AND retry_count IS NOT NULL AND
      restriction_latency_ms IS NOT NULL AND policy_activated_at IS NOT NULL)
  ),
  UNIQUE (organisation_id, vault_handle)
);
CREATE INDEX idx_credential_revocation_organisation_state
  ON credential_revocation_operation (organisation_id, state, committed_at);
CREATE TABLE external_vault_import (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  vault_handle TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind = 'onepassword'),
  source_locator TEXT NOT NULL,
  external_revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  imported_at INTEGER NOT NULL,
  activated_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (organisation_id, vault_handle, source_kind, source_locator),
  CHECK (
    (state = 'active' AND activated_at IS NOT NULL AND revoked_at IS NULL) OR
    (state = 'revoked' AND activated_at IS NULL AND revoked_at IS NOT NULL)
  )
);
CREATE INDEX idx_external_vault_import_organisation_state
  ON external_vault_import (organisation_id, state);
CREATE TABLE workspace_revision_head (
  organisation_id TEXT NOT NULL REFERENCES organisation(organisation_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 10),
  revision_id TEXT NOT NULL CHECK (length(revision_id) > 10),
  canonical_head TEXT NOT NULL CHECK (
    length(canonical_head) = 64 AND canonical_head NOT GLOB '*[^0-9a-f]*'
  ),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, workspace_id)
);
CREATE TABLE workspace_revision (
  organisation_id TEXT NOT NULL REFERENCES organisation(organisation_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 10),
  revision_id TEXT NOT NULL CHECK (length(revision_id) > 10),
  base_revision_id TEXT,
  canonical_head TEXT NOT NULL CHECK (
    length(canonical_head) = 64 AND canonical_head NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_ref TEXT NOT NULL CHECK (length(manifest_ref) > 0),
  manifest_digest TEXT NOT NULL CHECK (
    length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'
  ),
  changeset_ref TEXT NOT NULL CHECK (length(changeset_ref) > 0),
  changeset_digest TEXT NOT NULL CHECK (
    length(changeset_digest) = 64 AND changeset_digest NOT GLOB '*[^0-9a-f]*'
  ),
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) > 0),
  causation_projection TEXT NOT NULL CHECK (json_valid(causation_projection)),
  committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
  PRIMARY KEY (organisation_id, workspace_id, revision_id),
  FOREIGN KEY (organisation_id, workspace_id, base_revision_id)
    REFERENCES workspace_revision(organisation_id, workspace_id, revision_id)
);
CREATE TRIGGER workspace_revision_requires_empty_genesis
BEFORE INSERT ON workspace_revision
WHEN (NEW.base_revision_id IS NULL
  AND EXISTS (
    SELECT 1 FROM workspace_revision_head
    WHERE organisation_id = NEW.organisation_id AND workspace_id = NEW.workspace_id
  )) AND NOT EXISTS (SELECT 1 FROM organisation_placement import_placement WHERE import_placement.organisation_id = NEW.organisation_id AND import_placement.status = 'reserved' AND NOT EXISTS (SELECT 1 FROM organisation_placement live_placement WHERE live_placement.organisation_id = NEW.organisation_id AND live_placement.status = 'active'))
BEGIN
  SELECT RAISE(ABORT, 'workspace_revision_conflict');
END;
CREATE TRIGGER workspace_revision_requires_current_base
BEFORE INSERT ON workspace_revision
WHEN (NEW.base_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM workspace_revision_head
    WHERE organisation_id = NEW.organisation_id
      AND workspace_id = NEW.workspace_id
      AND revision_id = NEW.base_revision_id
  )) AND NOT EXISTS (SELECT 1 FROM organisation_placement import_placement WHERE import_placement.organisation_id = NEW.organisation_id AND import_placement.status = 'reserved' AND NOT EXISTS (SELECT 1 FROM organisation_placement live_placement WHERE live_placement.organisation_id = NEW.organisation_id AND live_placement.status = 'active'))
BEGIN
  SELECT RAISE(ABORT, 'workspace_revision_conflict');
END;
CREATE TABLE workspace_revision_receipt (
  organisation_id TEXT NOT NULL REFERENCES organisation(organisation_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 10),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_id TEXT NOT NULL UNIQUE CHECK (length(receipt_id) > 10),
  revision_id TEXT NOT NULL CHECK (length(revision_id) > 10),
  receipt_projection TEXT NOT NULL CHECK (json_valid(receipt_projection)),
  committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
  PRIMARY KEY (organisation_id, workspace_id, idempotency_key),
  FOREIGN KEY (organisation_id, workspace_id, revision_id)
    REFERENCES workspace_revision(organisation_id, workspace_id, revision_id)
);
CREATE TABLE IF NOT EXISTS "durable_object_registry" (
  registry_id TEXT PRIMARY KEY,
  activation_token TEXT NOT NULL UNIQUE,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  object_kind TEXT NOT NULL CHECK (
    object_kind IN ('organisation', 'surface', 'session', 'thread', 'case', 'connector')
  ),
  logical_object_id TEXT NOT NULL,
  physical_object_name TEXT NOT NULL UNIQUE,
  placement_epoch INTEGER NOT NULL,
  placement_cell_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  lifecycle_status TEXT NOT NULL CHECK (
    lifecycle_status IN ('reserved', 'active', 'exporting', 'retired', 'quarantined')
  ),
  fence_token TEXT NOT NULL,
  reserved_at INTEGER NOT NULL,
  activated_at INTEGER,
  exporting_at INTEGER,
  retired_at INTEGER,
  quarantined_at INTEGER,
  quarantine_reason TEXT,
  FOREIGN KEY (organisation_id, placement_epoch)
    REFERENCES organisation_placement (organisation_id, placement_epoch),
  UNIQUE (organisation_id, object_kind, logical_object_id, placement_epoch),
  CHECK (
    (lifecycle_status = 'reserved' AND activated_at IS NULL AND exporting_at IS NULL AND
      retired_at IS NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (lifecycle_status = 'active' AND activated_at IS NOT NULL AND exporting_at IS NULL AND
      retired_at IS NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (lifecycle_status = 'exporting' AND activated_at IS NOT NULL AND exporting_at IS NOT NULL AND
      retired_at IS NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (lifecycle_status = 'retired' AND activated_at IS NOT NULL AND exporting_at IS NOT NULL AND
      retired_at IS NOT NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (lifecycle_status = 'quarantined' AND retired_at IS NULL AND quarantined_at IS NOT NULL AND
      quarantine_reason IS NOT NULL)
  )
);
CREATE INDEX idx_durable_object_registry_organisation_lifecycle
  ON durable_object_registry (organisation_id, lifecycle_status, object_kind);
CREATE TABLE organisation_harness_erasure (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  status TEXT NOT NULL CHECK (
    status IN ('inventorying', 'erasing', 'deleting', 'completed', 'failed')
  ),
  failure_code TEXT,
  session_count INTEGER NOT NULL CHECK (session_count >= 0),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  deleted_count INTEGER NOT NULL CHECK (deleted_count >= 0),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER, registry_snapshot_json TEXT, registry_fingerprint TEXT,
  CHECK (
    (status IN ('inventorying', 'erasing', 'deleting') AND completed_at IS NULL) OR
    (status = 'completed' AND failure_code IS NULL AND completed_at IS NOT NULL) OR
    (status = 'failed' AND failure_code IS NOT NULL AND completed_at IS NULL)
  )
);
CREATE TABLE organisation_harness_erasure_session (
  organisation_id TEXT NOT NULL REFERENCES organisation_harness_erasure (organisation_id),
  registry_id TEXT NOT NULL REFERENCES durable_object_registry (registry_id),
  logical_session_id TEXT NOT NULL,
  physical_object_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'inventoried', 'erased', 'failed')),
  reference_keys_json TEXT NOT NULL,
  candidate_keys_json TEXT NOT NULL,
  failure_code TEXT,
  updated_at INTEGER NOT NULL, lifecycle_status TEXT, placement_epoch INTEGER, placement_cell_id TEXT, placement_kind TEXT, location_hint TEXT, residency_jurisdiction TEXT, erasure_counts_json TEXT
  CHECK (erasure_counts_json IS NULL OR json_valid(erasure_counts_json)), erased_at INTEGER,
  PRIMARY KEY (organisation_id, registry_id),
  CHECK (
    (status IN ('pending', 'inventoried', 'erased') AND failure_code IS NULL) OR
    (status = 'failed' AND failure_code IS NOT NULL)
  )
);
CREATE TABLE organisation_harness_erasure_object (
  organisation_id TEXT NOT NULL REFERENCES organisation_harness_erasure (organisation_id),
  object_key TEXT NOT NULL CHECK (length(object_key) > 0),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'retained', 'deleted')),
  discovered_at INTEGER NOT NULL,
  retained_at INTEGER,
  deleted_at INTEGER,
  PRIMARY KEY (organisation_id, object_key),
  CHECK (
    (status = 'candidate' AND retained_at IS NULL AND deleted_at IS NULL) OR
    (status = 'retained' AND retained_at IS NOT NULL AND deleted_at IS NULL) OR
    (status = 'deleted' AND retained_at IS NULL AND deleted_at IS NOT NULL)
  )
);
CREATE INDEX idx_organisation_harness_erasure_session_status
  ON organisation_harness_erasure_session (organisation_id, status);
CREATE INDEX idx_organisation_harness_erasure_object_status
  ON organisation_harness_erasure_object (organisation_id, status);
CREATE TABLE operational_area (
  area_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived')),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (organisation_id, name)
);
CREATE INDEX operational_area_organisation_lifecycle
  ON operational_area (organisation_id, lifecycle);
CREATE TABLE agent_responsibility_scope (
  scope_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  area_id TEXT NOT NULL REFERENCES operational_area (area_id),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('entity_type', 'relationship', 'commerce_list', 'commerce_list_entry', 'saved_selector')),
  entity_type_origin TEXT,
  entity_type_id TEXT,
  commerce_list_id TEXT,
  relationship_json TEXT,
  list_entry_json TEXT,
  selector_id TEXT,
  selector_revision INTEGER,
  selector_query_json TEXT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('published', 'archived')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  published_at INTEGER NOT NULL,
  CHECK (
    (scope_kind = 'entity_type'
      AND entity_type_origin IN ('system', 'custom')
      AND entity_type_id IS NOT NULL
      AND commerce_list_id IS NULL
      AND relationship_json IS NULL
      AND list_entry_json IS NULL
      AND selector_id IS NULL
      AND selector_revision IS NULL
      AND selector_query_json IS NULL)
    OR
    (scope_kind = 'relationship'
      AND entity_type_origin IS NULL
      AND entity_type_id IS NULL
      AND commerce_list_id IS NULL
      AND relationship_json IS NOT NULL
      AND json_valid(relationship_json)
      AND list_entry_json IS NULL
      AND selector_id IS NULL
      AND selector_revision IS NULL
      AND selector_query_json IS NULL)
    OR
    (scope_kind = 'commerce_list'
      AND entity_type_origin IS NULL
      AND entity_type_id IS NULL
      AND commerce_list_id IS NOT NULL
      AND relationship_json IS NULL
      AND list_entry_json IS NULL
      AND selector_id IS NULL
      AND selector_revision IS NULL
      AND selector_query_json IS NULL)
    OR
    (scope_kind = 'commerce_list_entry'
      AND entity_type_origin IS NULL
      AND entity_type_id IS NULL
      AND commerce_list_id IS NULL
      AND relationship_json IS NULL
      AND list_entry_json IS NOT NULL
      AND json_valid(list_entry_json)
      AND selector_id IS NULL
      AND selector_revision IS NULL
      AND selector_query_json IS NULL)
    OR
    (scope_kind = 'saved_selector'
      AND entity_type_origin IS NULL
      AND entity_type_id IS NULL
      AND commerce_list_id IS NULL
      AND relationship_json IS NULL
      AND list_entry_json IS NULL
      AND selector_id IS NOT NULL
      AND selector_revision > 0
      AND selector_query_json IS NOT NULL
      AND json_valid(selector_query_json))
  ),
  UNIQUE (organisation_id, area_id, scope_id)
) STRICT;
CREATE INDEX agent_responsibility_scope_area
  ON agent_responsibility_scope (organisation_id, area_id, lifecycle, scope_id);
CREATE TABLE agent_definition (
  agent_definition_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  purpose TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived')),
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX agent_definition_organisation_lifecycle
  ON agent_definition (organisation_id, lifecycle);
CREATE TABLE agent_definition_revision (
  agent_definition_id TEXT NOT NULL REFERENCES agent_definition (agent_definition_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  instructions TEXT NOT NULL,
  requested_capabilities_json TEXT NOT NULL,
  skill_refs_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  authored_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_definition_id, revision)
);
CREATE TABLE agent_installation (
  installation_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  agent_definition_id TEXT NOT NULL,
  definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  granted_capabilities_json TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'suspended', 'archived')),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (agent_definition_id, definition_revision)
    REFERENCES agent_definition_revision (agent_definition_id, revision)
);
CREATE INDEX agent_installation_organisation_lifecycle
  ON agent_installation (organisation_id, lifecycle);
CREATE TABLE agent_area_assignment (
  installation_id TEXT NOT NULL REFERENCES agent_installation (installation_id),
  area_id TEXT NOT NULL REFERENCES operational_area (area_id),
  responsibility TEXT NOT NULL,
  scope_ids_json TEXT NOT NULL CHECK (json_valid(scope_ids_json)),
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, area_id)
);
CREATE TABLE skill (
  skill_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  title TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('ordinary', 'sensitive')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('published', 'archived')),
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE skill_revision (
  skill_id TEXT NOT NULL REFERENCES skill (skill_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  markdown_body TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  authored_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (skill_id, revision)
);
CREATE TABLE skill_binding (
  binding_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('area')),
  target_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  skill_revision INTEGER NOT NULL CHECK (skill_revision > 0),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (skill_id, skill_revision)
    REFERENCES skill_revision (skill_id, revision),
  UNIQUE (organisation_id, target_kind, target_id, skill_id)
);
CREATE INDEX skill_binding_target
  ON skill_binding (organisation_id, target_kind, target_id);
CREATE TABLE commerce_merchant_binding (
  binding_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL UNIQUE,
  merchant_id TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  delivery_signing_key_id TEXT NOT NULL,
  delivery_signing_public_key_b64 TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX commerce_one_merchant_per_organisation_environment
ON commerce_merchant_binding (organisation_id, environment);
CREATE TABLE commerce_webhook_subscription (
  binding_id TEXT PRIMARY KEY REFERENCES commerce_merchant_binding (binding_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  subscription_id TEXT NOT NULL CHECK (length(subscription_id) > 0),
  sealed_secret TEXT NOT NULL CHECK (length(sealed_secret) > 0),
  read_queued_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE organisation_commerce_system (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  system_kind TEXT NOT NULL CHECK (system_kind IN ('builtin_commerce', 'shopify')),
  commerce_binding_id TEXT REFERENCES commerce_merchant_binding (binding_id),
  shopify_integration_account_id TEXT REFERENCES integration_account (integration_account_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  selected_at INTEGER NOT NULL,
  selected_by_user_id TEXT NOT NULL,
  CHECK (
    (system_kind = 'builtin_commerce'
      AND commerce_binding_id IS NOT NULL
      AND shopify_integration_account_id IS NULL)
    OR
    (system_kind = 'shopify'
      AND commerce_binding_id IS NULL
      AND shopify_integration_account_id IS NOT NULL)
  )
) STRICT;
CREATE UNIQUE INDEX organisation_commerce_system_commerce_binding
ON organisation_commerce_system (commerce_binding_id)
WHERE commerce_binding_id IS NOT NULL;
CREATE UNIQUE INDEX organisation_commerce_system_shopify_account
ON organisation_commerce_system (shopify_integration_account_id)
WHERE shopify_integration_account_id IS NOT NULL;
CREATE TABLE organisation_communication_destination (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL
    REFERENCES integration_account (integration_account_id),
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  provider_revision TEXT NOT NULL,
  selected_at INTEGER NOT NULL
) STRICT;
-- The Slack receipt of one paid online order (Refactor 15). The feed records
-- it and moves on; `PAID_RECEIPT_MACHINE` owns the state.
CREATE TABLE paid_receipt (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  receipt_id TEXT NOT NULL CHECK (length(receipt_id) > 0),
  order_id TEXT NOT NULL CHECK (length(order_id) > 0),
  connector_id TEXT NOT NULL CHECK (length(connector_id) > 0),
  delivery_json TEXT NOT NULL CHECK (json_valid(delivery_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'abandoned')),
  failure_reason TEXT,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (organisation_id, receipt_id),
  CHECK ((state IN ('pending', 'failed')) = (next_attempt_at IS NOT NULL)),
  CHECK ((state IN ('failed', 'abandoned')) = (failure_reason IS NOT NULL)),
  CHECK ((state = 'sent') = (sent_at IS NOT NULL))
) STRICT;
CREATE INDEX paid_receipt_due
ON paid_receipt (next_attempt_at, organisation_id)
WHERE state IN ('pending', 'failed');
CREATE TABLE slack_conversation_fact (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  channel_id TEXT NOT NULL,
  is_private INTEGER NOT NULL CHECK (is_private IN (0, 1)),
  reaches_outside INTEGER NOT NULL CHECK (reaches_outside IN (0, 1)),
  member_ids_json TEXT,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, channel_id)
) STRICT;
CREATE TABLE organisation_slack_channel (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL
    REFERENCES integration_account (integration_account_id),
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  provider_revision TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, workspace_id, channel_id)
) STRICT;




CREATE TABLE IF NOT EXISTS "organisation_first_operational_task" (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  activation_receipt_id TEXT NOT NULL UNIQUE
    REFERENCES organisation_activation_receipt (activation_receipt_id),
  task_kind TEXT NOT NULL CHECK (task_kind = 'observe_recent_commerce'),
  commerce_system_revision INTEGER NOT NULL CHECK (commerce_system_revision > 0),
  destination_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE external_identity_link_challenge (
  challenge_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  workspace_connection_id TEXT NOT NULL REFERENCES provider_connection (provider_connection_id),
  workspace_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consuming_user_id TEXT, source_event_id TEXT,
  CHECK (expires_at > created_at),
  CHECK (length(workspace_id) > 0 AND length(external_user_id) > 0),
  CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at)),
  CHECK (
    (consumed_at IS NULL AND consuming_user_id IS NULL) OR
    (consumed_at IS NOT NULL AND consuming_user_id IS NOT NULL)
  )
);
CREATE INDEX idx_external_identity_link_challenge_expiry
ON external_identity_link_challenge (expires_at)
WHERE consumed_at IS NULL;
CREATE TABLE external_identity_link (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  workspace_connection_id TEXT NOT NULL REFERENCES provider_connection (provider_connection_id),
  workspace_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  verified_by TEXT NOT NULL CHECK (verified_by IN ('google', 'passkey', 'seams')),
  CHECK (length(workspace_id) > 0 AND length(external_user_id) > 0),
  CHECK (verified_at >= 0),
  PRIMARY KEY (workspace_connection_id, external_user_id),
  UNIQUE (organisation_id, workspace_id, external_user_id)
);
CREATE INDEX idx_external_identity_link_app_user
ON external_identity_link (organisation_id, user_id);
CREATE TRIGGER external_identity_link_challenge_workspace_guard
BEFORE INSERT ON external_identity_link_challenge
WHEN (NOT EXISTS (
  SELECT 1
  FROM provider_connection AS connection
  JOIN integration_account AS account
    ON account.provider_connection_id = connection.provider_connection_id
   AND account.organisation_id = connection.organisation_id
   AND account.provider = 'slack'
   AND account.account_kind = 'workspace'
  JOIN surface_installation AS installation
    ON installation.integration_account_id = account.integration_account_id
   AND installation.organisation_id = account.organisation_id
   AND installation.surface_kind = 'slack'
  WHERE connection.provider_connection_id = NEW.workspace_connection_id
    AND connection.organisation_id = NEW.organisation_id
    AND connection.provider = 'slack'
    AND installation.workspace_id = NEW.workspace_id
)) AND NOT EXISTS (SELECT 1 FROM organisation_placement import_placement WHERE import_placement.organisation_id = NEW.organisation_id AND import_placement.status = 'reserved' AND NOT EXISTS (SELECT 1 FROM organisation_placement live_placement WHERE live_placement.organisation_id = NEW.organisation_id AND live_placement.status = 'active'))
BEGIN
  SELECT RAISE(ABORT, 'external_identity_link_workspace_mismatch');
END;
CREATE TRIGGER external_identity_link_workspace_guard
BEFORE INSERT ON external_identity_link
WHEN (NOT EXISTS (
  SELECT 1
  FROM provider_connection AS connection
  JOIN integration_account AS account
    ON account.provider_connection_id = connection.provider_connection_id
   AND account.organisation_id = connection.organisation_id
   AND account.provider = 'slack'
   AND account.account_kind = 'workspace'
  JOIN surface_installation AS installation
    ON installation.integration_account_id = account.integration_account_id
   AND installation.organisation_id = account.organisation_id
   AND installation.surface_kind = 'slack'
  WHERE connection.provider_connection_id = NEW.workspace_connection_id
    AND connection.organisation_id = NEW.organisation_id
    AND connection.provider = 'slack'
    AND installation.workspace_id = NEW.workspace_id
)) AND NOT EXISTS (SELECT 1 FROM organisation_placement import_placement WHERE import_placement.organisation_id = NEW.organisation_id AND import_placement.status = 'reserved' AND NOT EXISTS (SELECT 1 FROM organisation_placement live_placement WHERE live_placement.organisation_id = NEW.organisation_id AND live_placement.status = 'active'))
BEGIN
  SELECT RAISE(ABORT, 'external_identity_link_workspace_mismatch');
END;
CREATE UNIQUE INDEX idx_external_identity_link_challenge_source_event
ON external_identity_link_challenge (source_event_id)
WHERE source_event_id IS NOT NULL;
CREATE TABLE commerce_capability_activation (
  activation_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  capability TEXT NOT NULL CHECK (
    capability IN (
      'core',
      'food_service',
      'retail_operations',
      'online_commerce',
      'returns',
      'automation'
    )
  ),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('organisation', 'location')),
  location_id TEXT,
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
    (scope_kind = 'organisation' AND location_id IS NULL)
    OR (scope_kind = 'location' AND location_id IS NOT NULL)
  ),
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
CREATE TABLE IF NOT EXISTS "person_authz_role" (
  organisation_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('approve')),
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, person_id, role),
  FOREIGN KEY (organisation_id, person_id) REFERENCES person (organisation_id, person_id)
);
CREATE TABLE credential_access_denial (
  denial_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (
    purpose IN (
      'harness', 'provider_action', 'webhook', 'provider_connection',
      'surface_installation', 'account_removal', 'model', 'control'
    )
  ),
  reason_code TEXT NOT NULL,
  vault_handle TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX idx_credential_access_denial_organisation_time
  ON credential_access_denial (organisation_id, occurred_at DESC);
CREATE INDEX idx_credential_access_denial_time
  ON credential_access_denial (occurred_at DESC);
CREATE TABLE cue_binding (
  binding_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  area_id TEXT NOT NULL REFERENCES operational_area (area_id),
  scope_ids_json TEXT NOT NULL CHECK (json_valid(scope_ids_json)),
  installation_id TEXT NOT NULL REFERENCES agent_installation (installation_id),
  cue_source TEXT NOT NULL,
  cue_event_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  instruction_body TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (organisation_id, cue_source, cue_event_type)
);
CREATE INDEX idx_cue_binding_organisation_enabled
  ON cue_binding (organisation_id, enabled, cue_source, cue_event_type);
CREATE TABLE schedule_binding (
  binding_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  area_id TEXT NOT NULL REFERENCES operational_area (area_id),
  scope_ids_json TEXT NOT NULL CHECK (json_valid(scope_ids_json)),
  installation_id TEXT NOT NULL REFERENCES agent_installation (installation_id),
  cadence TEXT NOT NULL CHECK (cadence IN ('hourly', 'daily', 'weekly')),
  minute_of_hour INTEGER,
  time_of_day TEXT,
  weekday TEXT,
  timezone TEXT,
  schedule_time_key TEXT NOT NULL,
  instruction_body TEXT,
  last_dispatched_window TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (cadence = 'hourly' AND minute_of_hour IS NOT NULL
      AND minute_of_hour BETWEEN 0 AND 59
      AND time_of_day IS NULL AND weekday IS NULL AND timezone IS NULL)
    OR (cadence = 'daily' AND minute_of_hour IS NULL
      AND time_of_day IS NOT NULL AND weekday IS NULL AND timezone IS NOT NULL)
    OR (cadence = 'weekly' AND minute_of_hour IS NULL
      AND time_of_day IS NOT NULL AND weekday IS NOT NULL AND timezone IS NOT NULL)
  ),
  CHECK (weekday IS NULL OR weekday IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
  UNIQUE (organisation_id, installation_id, cadence, schedule_time_key)
);
CREATE INDEX idx_schedule_binding_enabled
  ON schedule_binding (enabled, organisation_id, installation_id);
CREATE TABLE schedule_dispatch_receipt (
  binding_id TEXT NOT NULL REFERENCES schedule_binding (binding_id),
  window_key TEXT NOT NULL,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  case_id TEXT NOT NULL,
  dispatched_at INTEGER NOT NULL,
  PRIMARY KEY (binding_id, window_key)
);
CREATE INDEX idx_schedule_dispatch_receipt_time
  ON schedule_dispatch_receipt (organisation_id, dispatched_at);
CREATE TABLE agent_installation_governance (
  installation_id TEXT PRIMARY KEY
    REFERENCES agent_installation (installation_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  max_session_budget_tokens INTEGER NOT NULL
    CHECK (max_session_budget_tokens > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_user_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE agent_configuration_proposal (
  proposal_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  installation_id TEXT NOT NULL REFERENCES agent_installation (installation_id),
  target_kind TEXT NOT NULL
    CHECK (target_kind IN ('agent_instructions', 'skill_markdown')),
  target_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  proposed_body TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'accepted', 'dismissed')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by_user_id TEXT,
  published_revision INTEGER CHECK (published_revision IS NULL OR published_revision > 0),
  CHECK (
    (status = 'open' AND decided_at IS NULL
      AND decided_by_user_id IS NULL AND published_revision IS NULL)
    OR (status = 'dismissed' AND decided_at IS NOT NULL
      AND decided_by_user_id IS NOT NULL AND published_revision IS NULL)
    OR (status = 'accepted' AND decided_at IS NOT NULL
      AND decided_by_user_id IS NOT NULL AND published_revision IS NOT NULL)
  )
);
CREATE INDEX idx_agent_configuration_proposal_organisation_status
  ON agent_configuration_proposal (organisation_id, status, created_at);
CREATE TABLE campaign_brief (
  brief_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  merchant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  objective TEXT NOT NULL CHECK (length(objective) > 0),
  targets_json TEXT NOT NULL CHECK (json_valid(targets_json)),
  channel TEXT NOT NULL CHECK (length(channel) > 0),
  audience_description TEXT NOT NULL CHECK (length(audience_description) > 0),
  message_variants_json TEXT NOT NULL CHECK (json_valid(message_variants_json)),
  requested_budget_minor INTEGER NOT NULL CHECK (requested_budget_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  disclosures_json TEXT NOT NULL CHECK (json_valid(disclosures_json)),
  supporting_evidence TEXT NOT NULL CHECK (length(supporting_evidence) > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'accepted', 'dismissed', 'expired')),
  proposed_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by_person_id TEXT,
  expires_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK ((lifecycle = 'draft') = (decided_at IS NULL)),
  CHECK ((decided_at IS NULL) = (decided_by_person_id IS NULL))
);
CREATE INDEX idx_campaign_brief_case
  ON campaign_brief (organisation_id, case_id, proposed_at);
CREATE TABLE operator_configuration_draft (
  draft_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  case_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_person_id TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
  -- One stable mutation identity, so a retry reads the recorded outcome
  -- instead of applying the change a second time.
  mutation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'confirmed', 'settled', 'cancelled', 'expired')
  ),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  receipt_code TEXT,
  UNIQUE (organisation_id, mutation_id),
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK ((state = 'settled') = (receipt_code IS NOT NULL))
);
-- At most one draft awaits confirmation per Case, so a bare confirmation is
-- never ambiguous about which change it accepts.
CREATE UNIQUE INDEX idx_operator_draft_pending
  ON operator_configuration_draft (organisation_id, case_id)
  WHERE state = 'pending';
CREATE TABLE case_assignment_pin (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  assignment_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES agent_installation (installation_id),
  agent_definition_id TEXT NOT NULL,
  definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  skill_refs_json TEXT NOT NULL CHECK (json_valid(skill_refs_json)),
  granted_capabilities_json TEXT NOT NULL
    CHECK (json_valid(granted_capabilities_json)),
  max_session_budget_tokens INTEGER
    CHECK (max_session_budget_tokens IS NULL OR max_session_budget_tokens > 0),
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, assignment_id)
);
CREATE INDEX idx_case_assignment_pin_installation
  ON case_assignment_pin (organisation_id, installation_id, pinned_at);
CREATE TABLE access_grant (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  grant_id TEXT NOT NULL,
  subject_json TEXT NOT NULL CHECK (json_valid(subject_json)),
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'revoked')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  reason TEXT,
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, grant_id),
  CHECK (COALESCE((
    json_type(target_json, '$.capabilityId') = 'text' AND
    length(trim(json_extract(target_json, '$.capabilityId'))) > 0 AND
    json_type(target_json, '$.capabilityVersion') = 'integer' AND
    json_extract(target_json, '$.capabilityVersion') > 0 AND
    (
      (
        json_extract(target_json, '$.kind') = 'platform_capability' AND
        json_type(target_json, '$.scope') IS NULL AND
        json_type(target_json, '$.target') IS NULL AND
        json_type(target_json, '$.integrationAccountId') IS NULL AND
        json_type(target_json, '$.resourceScope') IS NULL
      ) OR
      (
        json_extract(target_json, '$.kind') = 'provider_resource' AND
        json_type(target_json, '$.integrationAccountId') = 'text' AND
        length(trim(json_extract(target_json, '$.integrationAccountId'))) > 0 AND
        json_type(target_json, '$.resourceScope') = 'text' AND
        length(trim(json_extract(target_json, '$.resourceScope'))) > 0 AND
        json_type(target_json, '$.scope') IS NULL AND
        json_type(target_json, '$.target') IS NULL
      ) OR
      (
        json_extract(target_json, '$.kind') = 'file_resource' AND
        json_extract(target_json, '$.capabilityId') = 'file.read' AND
        json_type(target_json, '$.integrationAccountId') = 'text' AND
        length(trim(json_extract(target_json, '$.integrationAccountId'))) > 0 AND
        json_type(target_json, '$.scope') = 'object' AND
        json_extract(target_json, '$.scope.kind') IN (
          'dropbox_folder', 'dropbox_file', 'gdrive_file'
        ) AND
        json_type(target_json, '$.resourceScope') IS NULL AND
        json_type(target_json, '$.target') IS NULL AND
        (
          (
            json_extract(target_json, '$.scope.kind') = 'dropbox_folder' AND
            json_type(target_json, '$.scope.providerFolderId') = 'text' AND
            length(trim(json_extract(target_json, '$.scope.providerFolderId'))) > 0 AND
            json_type(target_json, '$.scope.pathDisplay') = 'text' AND
            length(trim(json_extract(target_json, '$.scope.pathDisplay'))) > 0 AND
            json_type(target_json, '$.scope.providerFileId') IS NULL AND
            json_type(target_json, '$.scope.name') IS NULL
          ) OR
          (
            json_extract(target_json, '$.scope.kind') = 'dropbox_file' AND
            json_type(target_json, '$.scope.providerFileId') = 'text' AND
            length(trim(json_extract(target_json, '$.scope.providerFileId'))) > 0 AND
            json_type(target_json, '$.scope.pathDisplay') = 'text' AND
            length(trim(json_extract(target_json, '$.scope.pathDisplay'))) > 0 AND
            json_type(target_json, '$.scope.providerFolderId') IS NULL AND
            json_type(target_json, '$.scope.name') IS NULL
          ) OR
          (
            json_extract(target_json, '$.scope.kind') = 'gdrive_file' AND
            json_type(target_json, '$.scope.providerFileId') = 'text' AND
            length(trim(json_extract(target_json, '$.scope.providerFileId'))) > 0 AND
            json_type(target_json, '$.scope.name') = 'text' AND
            length(trim(json_extract(target_json, '$.scope.name'))) > 0 AND
            json_type(target_json, '$.scope.providerFolderId') IS NULL AND
            json_type(target_json, '$.scope.pathDisplay') IS NULL
          )
        )
      ) OR
      (
        json_extract(target_json, '$.kind') = 'custom_connector_operation' AND
        json_extract(target_json, '$.capabilityId') IN ('custom_connector.read', 'custom_connector.write') AND
        json_extract(target_json, '$.capabilityVersion') = 1 AND
        json_type(target_json, '$.integrationAccountId') = 'text' AND
        length(trim(json_extract(target_json, '$.integrationAccountId'))) > 0 AND
        json_type(target_json, '$.connectorId') = 'text' AND
        length(trim(json_extract(target_json, '$.connectorId'))) > 0 AND
        json_type(target_json, '$.definitionRevision') = 'integer' AND
        json_extract(target_json, '$.definitionRevision') > 0 AND
        json_type(target_json, '$.definitionDigest') = 'text' AND
        length(json_extract(target_json, '$.definitionDigest')) = 64 AND
        json_extract(target_json, '$.definitionDigest') NOT GLOB '*[^0-9a-f]*' AND
        json_type(target_json, '$.operationId') = 'text' AND
        length(json_extract(target_json, '$.operationId')) BETWEEN 1 AND 48 AND
        json_type(target_json, '$.scope') IS NULL AND
        json_type(target_json, '$.target') IS NULL AND
        json_type(target_json, '$.resourceScope') IS NULL
      ) OR
      (
        json_extract(target_json, '$.kind') = 'commerce_read' AND
        json_type(target_json, '$.scope') = 'object' AND
        json_extract(target_json, '$.scope.kind') IN ('entity_type', 'commerce_list', 'saved_selector') AND
        json_type(target_json, '$.target') IS NULL AND
        (
          (json_extract(target_json, '$.scope.kind') = 'entity_type' AND json_type(target_json, '$.scope.entityTypeId') = 'object') OR
          (json_extract(target_json, '$.scope.kind') = 'commerce_list' AND json_type(target_json, '$.scope.listId') = 'text') OR
          (json_extract(target_json, '$.scope.kind') = 'saved_selector' AND json_type(target_json, '$.scope.selector') = 'object')
        )
      ) OR
      (
        json_extract(target_json, '$.kind') = 'commerce_command' AND
        json_type(target_json, '$.scope') = 'object' AND
        json_extract(target_json, '$.scope.kind') IN (
          'entity_type', 'entity', 'relationship_definition', 'relationship',
          'commerce_list', 'commerce_list_entry', 'saved_selector', 'saved_view'
        ) AND
        json_type(target_json, '$.target') = 'object' AND
        json_extract(target_json, '$.target.kind') IN (
          'custom_entity', 'custom_relationship', 'commerce_list', 'commerce_list_entry',
          'saved_commerce_view', 'custom_entity_type', 'custom_relationship_definition',
          'system_entity_extension_schema'
        )
      )
    )
  ), 0) = 1),
  CHECK (
    (lifecycle = 'active' AND reason IS NULL) OR
    (lifecycle = 'revoked' AND reason IS NOT NULL)
  )
);
CREATE INDEX idx_access_grant_organisation_lifecycle
  ON access_grant (organisation_id, lifecycle, revision);
CREATE INDEX idx_access_grant_organisation_changed
  ON access_grant (organisation_id, changed_at, grant_id);
CREATE TABLE file_resource_source (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL REFERENCES integration_account (integration_account_id),
  provider TEXT NOT NULL CHECK (provider IN ('dropbox', 'google_drive')),
  provider_file_id TEXT NOT NULL CHECK (length(trim(provider_file_id)) > 0),
  source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
  provider_revision_json TEXT NOT NULL CHECK (json_valid(provider_revision_json)),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  display_path TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (length(trim(media_type)) > 0),
  deep_link TEXT NOT NULL CHECK (length(trim(deep_link)) > 0),
  content_state TEXT NOT NULL CHECK (content_state IN ('pending', 'content', 'metadata_only')),
  content_digest TEXT,
  metadata_only_reason TEXT,
  segment_count INTEGER CHECK (segment_count IS NULL OR segment_count >= 0),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= observed_at),
  PRIMARY KEY (organisation_id, integration_account_id, provider_file_id),
  CHECK (
    (content_state = 'pending' AND content_digest IS NULL AND metadata_only_reason IS NULL AND
      segment_count IS NULL) OR
    (content_state = 'content' AND content_digest IS NOT NULL AND metadata_only_reason IS NULL AND
      segment_count > 0) OR
    (content_state = 'metadata_only' AND content_digest IS NULL AND
      metadata_only_reason IS NOT NULL AND segment_count = 1)
  )
);
CREATE TABLE file_grant_sync (
  organisation_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_revision INTEGER NOT NULL CHECK (grant_revision > 0),
  integration_account_id TEXT NOT NULL REFERENCES integration_account (integration_account_id),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'reconciling', 'ready', 'retry_wait', 'capped')
  ),
  lease_id TEXT,
  lease_expires_at INTEGER,
  started_at INTEGER,
  reconciled_at INTEGER,
  attempt INTEGER,
  reason TEXT,
  next_run_at INTEGER,
  observed_file_count INTEGER,
  max_file_count INTEGER,
  capped_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, grant_id),
  FOREIGN KEY (organisation_id, grant_id) REFERENCES access_grant (organisation_id, grant_id),
  CHECK (
    (state = 'pending' AND next_run_at IS NOT NULL AND lease_id IS NULL AND
      lease_expires_at IS NULL AND started_at IS NULL AND reconciled_at IS NULL AND
      attempt IS NULL AND reason IS NULL AND observed_file_count IS NULL AND
      max_file_count IS NULL AND capped_at IS NULL) OR
    (state = 'reconciling' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND
      started_at IS NOT NULL AND reconciled_at IS NULL AND attempt IS NULL AND
      reason IS NULL AND next_run_at IS NULL AND observed_file_count IS NULL AND
      max_file_count IS NULL AND capped_at IS NULL) OR
    (state = 'ready' AND reconciled_at IS NOT NULL AND next_run_at IS NOT NULL AND
      lease_id IS NULL AND lease_expires_at IS NULL AND started_at IS NULL AND
      attempt IS NULL AND reason IS NULL AND observed_file_count IS NULL AND
      max_file_count IS NULL AND capped_at IS NULL) OR
    (state = 'retry_wait' AND attempt > 0 AND reason IS NOT NULL AND next_run_at IS NOT NULL AND
      lease_id IS NULL AND lease_expires_at IS NULL AND started_at IS NULL AND
      reconciled_at IS NULL AND observed_file_count IS NULL AND max_file_count IS NULL AND
      capped_at IS NULL) OR
    (state = 'capped' AND observed_file_count > max_file_count AND max_file_count > 0 AND
      capped_at IS NOT NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND
      started_at IS NULL AND reconciled_at IS NULL AND attempt IS NULL AND
      reason IS NULL AND next_run_at IS NULL)
  )
);
CREATE INDEX idx_file_grant_sync_due
  ON file_grant_sync (organisation_id, state, next_run_at);
CREATE TABLE file_grant_admission (
  organisation_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_revision INTEGER NOT NULL CHECK (grant_revision > 0),
  integration_account_id TEXT NOT NULL REFERENCES integration_account (integration_account_id),
  provider TEXT NOT NULL CHECK (provider IN ('dropbox', 'google_drive')),
  provider_file_id TEXT NOT NULL CHECK (length(trim(provider_file_id)) > 0),
  containing_scope_key TEXT NOT NULL CHECK (length(trim(containing_scope_key)) > 0),
  provider_revision_json TEXT NOT NULL CHECK (json_valid(provider_revision_json)),
  admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
  PRIMARY KEY (
    organisation_id, grant_id, grant_revision, integration_account_id, provider_file_id
  ),
  FOREIGN KEY (organisation_id, grant_id) REFERENCES access_grant (organisation_id, grant_id)
);
CREATE INDEX idx_file_grant_admission_resource
  ON file_grant_admission (
    organisation_id, integration_account_id, provider_file_id, grant_id, grant_revision
  );
CREATE TABLE file_provider_cursor (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL REFERENCES integration_account (integration_account_id),
  scope_key TEXT NOT NULL CHECK (length(trim(scope_key)) > 0),
  cursor_json TEXT NOT NULL CHECK (json_valid(cursor_json)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, integration_account_id, scope_key)
);
CREATE TABLE file_projection_outbox (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  outbox_id TEXT NOT NULL,
  integration_account_id TEXT NOT NULL REFERENCES integration_account (integration_account_id),
  grant_id TEXT NOT NULL,
  grant_revision INTEGER NOT NULL CHECK (grant_revision > 0),
  provider_file_id TEXT NOT NULL CHECK (length(trim(provider_file_id)) > 0),
  source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  delivered_at INTEGER CHECK (delivered_at IS NULL OR delivered_at >= created_at),
  PRIMARY KEY (organisation_id, outbox_id),
  FOREIGN KEY (organisation_id, grant_id) REFERENCES access_grant (organisation_id, grant_id)
);
CREATE INDEX idx_file_projection_outbox_pending
  ON file_projection_outbox (organisation_id, delivered_at, created_at, outbox_id);
CREATE TABLE file_extraction_budget (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL REFERENCES integration_account (integration_account_id),
  utc_day TEXT NOT NULL CHECK (utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  admitted_source_bytes INTEGER NOT NULL CHECK (admitted_source_bytes >= 0),
  maximum_source_bytes INTEGER NOT NULL CHECK (maximum_source_bytes > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, integration_account_id, utc_day),
  CHECK (admitted_source_bytes <= maximum_source_bytes)
);
CREATE TABLE context_projection (
  organisation_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('case_entry', 'file_segment')),
  source_key TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  source_revision_json TEXT NOT NULL CHECK (json_valid(source_revision_json)),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('pending', 'ready', 'failed', 'superseded')
  ),
  content_digest TEXT,
  visibility_json TEXT NOT NULL CHECK (json_valid(visibility_json)),
  visibility_key TEXT NOT NULL,
  flow_label_json TEXT NOT NULL CHECK (json_valid(flow_label_json)),
  indexed_at INTEGER CHECK (indexed_at IS NULL OR indexed_at >= 0),
  bounded_text TEXT,
  -- The model-visible rendering of the same entry. bounded_text feeds
  -- retrieval and stays authored-text-only so a filename cannot dominate a
  -- search; this carries the whole canonical message, including links and
  -- attachment manifests, so replayed history does not lose a file.
  model_text TEXT,
  title TEXT,
  display_path TEXT,
  provenance_json TEXT CHECK (provenance_json IS NULL OR json_valid(provenance_json)),
  grant_id TEXT,
  grant_revision INTEGER CHECK (grant_revision IS NULL OR grant_revision > 0),
  provider_file_id TEXT,
  enqueued_at INTEGER CHECK (enqueued_at IS NULL OR enqueued_at >= 0),
  failed_at INTEGER CHECK (failed_at IS NULL OR failed_at >= 0),
  failure_reason TEXT,
  retry_at INTEGER CHECK (retry_at IS NULL OR retry_at >= 0),
  superseded_at INTEGER CHECK (superseded_at IS NULL OR superseded_at >= 0),
  superseded_reason TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, source_kind, source_key, visibility_key),
  CHECK (
    (lifecycle = 'pending' AND content_digest IS NULL AND indexed_at IS NULL AND
      bounded_text IS NULL AND enqueued_at IS NOT NULL AND failed_at IS NULL AND
      failure_reason IS NULL AND retry_at IS NULL AND superseded_at IS NULL AND
      superseded_reason IS NULL) OR
    (lifecycle = 'ready' AND content_digest IS NOT NULL AND indexed_at IS NOT NULL AND
      bounded_text IS NOT NULL AND enqueued_at IS NULL AND failed_at IS NULL AND
      failure_reason IS NULL AND retry_at IS NULL AND superseded_at IS NULL AND
      superseded_reason IS NULL) OR
    (lifecycle = 'failed' AND content_digest IS NULL AND indexed_at IS NULL AND
      bounded_text IS NULL AND enqueued_at IS NULL AND failed_at IS NOT NULL AND
      failure_reason IS NOT NULL AND retry_at IS NOT NULL AND superseded_at IS NULL AND
      superseded_reason IS NULL) OR
    (lifecycle = 'superseded' AND content_digest IS NULL AND indexed_at IS NULL AND
      bounded_text IS NULL AND enqueued_at IS NULL AND failed_at IS NULL AND
      failure_reason IS NULL AND retry_at IS NULL AND superseded_at IS NOT NULL AND
      superseded_reason IS NOT NULL)
  ),
  CHECK (
    (source_kind = 'case_entry' AND grant_id IS NULL AND grant_revision IS NULL AND
      provider_file_id IS NULL) OR
    (source_kind = 'file_segment' AND grant_id IS NOT NULL AND grant_revision IS NOT NULL AND
      provider_file_id IS NOT NULL)
  )
);
CREATE INDEX idx_context_projection_visibility_search
  ON context_projection (
    organisation_id,
    visibility_key,
    lifecycle,
    indexed_at DESC,
    source_kind,
    source_key
  );
CREATE VIRTUAL TABLE context_projection_fts USING fts5(
  organisation_id UNINDEXED,
  source_kind UNINDEXED,
  source_key UNINDEXED,
  visibility_key UNINDEXED,
  title,
  display_path,
  bounded_text,
  tokenize = 'unicode61'
);
CREATE TRIGGER context_projection_fts_insert AFTER INSERT ON context_projection
WHEN new.lifecycle = 'ready'
BEGIN
  INSERT INTO context_projection_fts (
    rowid, organisation_id, source_kind, source_key, visibility_key, title, display_path, bounded_text
  ) VALUES (
    new.rowid, new.organisation_id, new.source_kind, new.source_key, new.visibility_key,
    COALESCE(new.title, ''), COALESCE(new.display_path, ''), new.bounded_text
  );
END;
CREATE TRIGGER context_projection_fts_delete AFTER DELETE ON context_projection
WHEN old.lifecycle = 'ready'
BEGIN
  DELETE FROM context_projection_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER context_projection_fts_update AFTER UPDATE ON context_projection
BEGIN
  DELETE FROM context_projection_fts WHERE rowid = old.rowid;
  INSERT INTO context_projection_fts (
    rowid, organisation_id, source_kind, source_key, visibility_key, title, display_path, bounded_text
  )
  SELECT new.rowid, new.organisation_id, new.source_kind, new.source_key, new.visibility_key,
         COALESCE(new.title, ''), COALESCE(new.display_path, ''), new.bounded_text
   WHERE new.lifecycle = 'ready';
END;
CREATE TABLE IF NOT EXISTS "onboarding_support_reference" (
  support_reference TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  actor_user_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  route TEXT NOT NULL,
  operation TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  retry_classification TEXT NOT NULL CHECK (
    retry_classification IN ('retryable', 'terminal')
  ),
  first_occurred_at INTEGER NOT NULL,
  latest_occurred_at INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
  resolved_at INTEGER, provider TEXT CHECK (
    provider IS NULL OR provider IN ('airtable', 'notion', 'slack', 'shopify', 'stripe', 'gmail', 'whatsapp', 'dropbox', 'google_drive', 'square')
  ), adapter_operation TEXT, lifecycle_before TEXT, lifecycle_after TEXT, redacted_provider_status TEXT, redacted_provider_request_id TEXT, durable_receipts TEXT CHECK (
    durable_receipts IS NULL OR json_valid(durable_receipts)
  ), last_successful_phase TEXT,
  CHECK (latest_occurred_at >= first_occurred_at),
  CHECK (resolved_at IS NULL OR resolved_at >= first_occurred_at)
);
CREATE TABLE IF NOT EXISTS "provider_connection_attempt" (
  attempt_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  provider TEXT NOT NULL CHECK (provider IN ('airtable', 'notion', 'slack', 'shopify', 'stripe', 'gmail', 'whatsapp', 'dropbox', 'google_drive', 'square')),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  user_id TEXT NOT NULL,
  existing_integration_account_id TEXT REFERENCES integration_account (integration_account_id),
  purpose TEXT NOT NULL CHECK (purpose IN ('connect', 'reconnect', 'rotate')),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN (
      'created', 'authorizing', 'callback_received', 'provisioning',
      'connected', 'cancelled', 'failed', 'expired'
    )
  ),
  provider_state_id TEXT,
  authorization_started_at INTEGER,
  callback_receipt_id TEXT,
  callback_received_at INTEGER,
  provisioning_attempt_id TEXT,
  provisioning_phase TEXT,
  provisioning_started_at INTEGER,
  connection_id TEXT,
  integration_account_ids TEXT CHECK (
    integration_account_ids IS NULL OR json_valid(integration_account_ids)
  ),
  cancelled_by_user_id TEXT,
  cancelled_at INTEGER,
  failure_reason_code TEXT,
  failure_retryable INTEGER CHECK (
    failure_retryable IS NULL OR failure_retryable IN (0, 1)
  ),
  failure_correlation_id TEXT,
  failed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (
    (lifecycle = 'created' AND provider_state_id IS NULL AND
      authorization_started_at IS NULL AND callback_receipt_id IS NULL AND
      callback_received_at IS NULL AND provisioning_attempt_id IS NULL AND
      provisioning_phase IS NULL AND provisioning_started_at IS NULL AND
      connection_id IS NULL AND integration_account_ids IS NULL AND
      cancelled_by_user_id IS NULL AND cancelled_at IS NULL AND
      failure_reason_code IS NULL AND failure_retryable IS NULL AND
      failure_correlation_id IS NULL AND failed_at IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'authorizing' AND provider_state_id IS NOT NULL AND
      authorization_started_at IS NOT NULL AND callback_receipt_id IS NULL AND
      callback_received_at IS NULL AND provisioning_attempt_id IS NULL AND
      provisioning_phase IS NULL AND provisioning_started_at IS NULL AND
      connection_id IS NULL AND integration_account_ids IS NULL AND
      cancelled_by_user_id IS NULL AND cancelled_at IS NULL AND
      failure_reason_code IS NULL AND failure_retryable IS NULL AND
      failure_correlation_id IS NULL AND failed_at IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'callback_received' AND provider_state_id IS NOT NULL AND
      authorization_started_at IS NOT NULL AND callback_receipt_id IS NOT NULL AND
      callback_received_at IS NOT NULL AND provisioning_attempt_id IS NULL AND
      provisioning_phase IS NULL AND provisioning_started_at IS NULL AND
      connection_id IS NULL AND integration_account_ids IS NULL AND
      cancelled_by_user_id IS NULL AND cancelled_at IS NULL AND
      failure_reason_code IS NULL AND failure_retryable IS NULL AND
      failure_correlation_id IS NULL AND failed_at IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'provisioning' AND provider_state_id IS NOT NULL AND
      authorization_started_at IS NOT NULL AND callback_receipt_id IS NOT NULL AND
      callback_received_at IS NOT NULL AND provisioning_attempt_id IS NOT NULL AND
      provisioning_phase IS NOT NULL AND provisioning_started_at IS NOT NULL AND
      connection_id IS NULL AND integration_account_ids IS NULL AND
      cancelled_by_user_id IS NULL AND cancelled_at IS NULL AND
      failure_reason_code IS NULL AND failure_retryable IS NULL AND
      failure_correlation_id IS NULL AND failed_at IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'connected' AND provider_state_id IS NOT NULL AND
      authorization_started_at IS NOT NULL AND callback_receipt_id IS NOT NULL AND
      callback_received_at IS NOT NULL AND provisioning_attempt_id IS NOT NULL AND
      provisioning_phase IS NOT NULL AND provisioning_started_at IS NOT NULL AND
      connection_id IS NOT NULL AND integration_account_ids IS NOT NULL AND
      cancelled_by_user_id IS NULL AND cancelled_at IS NULL AND
      failure_reason_code IS NULL AND failure_retryable IS NULL AND
      failure_correlation_id IS NULL AND failed_at IS NULL AND completed_at IS NOT NULL) OR
    (lifecycle = 'cancelled' AND connection_id IS NULL AND
      integration_account_ids IS NULL AND cancelled_by_user_id IS NOT NULL AND
      cancelled_at IS NOT NULL AND failure_reason_code IS NULL AND
      failure_retryable IS NULL AND failure_correlation_id IS NULL AND
      failed_at IS NULL AND completed_at IS NOT NULL) OR
    (lifecycle = 'failed' AND connection_id IS NULL AND
      integration_account_ids IS NULL AND cancelled_by_user_id IS NULL AND
      cancelled_at IS NULL AND failure_reason_code IS NOT NULL AND
      failure_retryable IS NOT NULL AND failure_correlation_id IS NOT NULL AND
      failed_at IS NOT NULL AND completed_at IS NOT NULL) OR
    (lifecycle = 'expired' AND connection_id IS NULL AND
      integration_account_ids IS NULL AND cancelled_by_user_id IS NULL AND
      cancelled_at IS NULL AND failure_reason_code IS NULL AND
      failure_retryable IS NULL AND failure_correlation_id IS NULL AND
      failed_at IS NULL AND completed_at IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS "provider_authorization_state" (
  provider_state_id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES provider_connection_attempt (attempt_id),
  organisation_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('airtable', 'notion', 'slack', 'shopify', 'stripe', 'gmail', 'whatsapp', 'dropbox', 'google_drive', 'square')),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  user_id TEXT NOT NULL,
  portal_subject_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  pkce_verifier TEXT,
  provider_context TEXT NOT NULL CHECK (json_valid(provider_context)),
  return_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  callback_code_hash TEXT,
  callback_receipt_id TEXT,
  invalidated_at INTEGER,
  invalidation_reason TEXT,
  CHECK (expires_at > created_at),
  CHECK (
    (consumed_at IS NULL AND callback_code_hash IS NULL AND callback_receipt_id IS NULL) OR
    (consumed_at IS NOT NULL AND callback_code_hash IS NOT NULL AND callback_receipt_id IS NOT NULL)
  ),
  CHECK (
    (invalidated_at IS NULL AND invalidation_reason IS NULL) OR
    (invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL)
  ),
  FOREIGN KEY (organisation_id) REFERENCES organisation (organisation_id)
);
CREATE TABLE IF NOT EXISTS "provider_provisioning_attempt" (
  provisioning_attempt_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES provider_connection_attempt (attempt_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  provider TEXT NOT NULL CHECK (provider IN ('airtable', 'notion', 'slack', 'shopify', 'stripe', 'gmail', 'whatsapp', 'dropbox', 'google_drive', 'square')),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('running', 'succeeded', 'failed_retryable', 'failed_terminal')
  ),
  phase TEXT NOT NULL CHECK (
    phase IN (
      'discovering_identity', 'persisting_credential', 'discovering_accounts',
      'reconciling_webhooks', 'discovering_resources',
      'verifying_connection', 'finalizing'
    )
  ),
  reason_code TEXT,
  correlation_id TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (
    (lifecycle = 'running' AND reason_code IS NULL AND correlation_id IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'succeeded' AND reason_code IS NULL AND correlation_id IS NULL AND completed_at IS NOT NULL) OR
    (lifecycle IN ('failed_retryable', 'failed_terminal') AND
      reason_code IS NOT NULL AND correlation_id IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE INDEX idx_onboarding_support_organisation_time
  ON onboarding_support_reference (organisation_id, latest_occurred_at DESC);
CREATE INDEX idx_provider_attempt_organisation_time
  ON provider_connection_attempt (organisation_id, created_at DESC);
CREATE UNIQUE INDEX idx_provider_attempt_open
  ON provider_connection_attempt (
    organisation_id,
    provider,
    COALESCE(existing_integration_account_id, '')
  )
  WHERE lifecycle IN ('created', 'authorizing', 'callback_received', 'provisioning');
CREATE INDEX idx_provider_authorization_state_expiry
  ON provider_authorization_state (expires_at, consumed_at);
CREATE TABLE organisation_codex_connection (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('connected', 'action_required')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  auth_profile_handle TEXT NOT NULL,
  auth_profile_generation INTEGER NOT NULL CHECK (auth_profile_generation > 0),
  plan_type TEXT NOT NULL,
  action_required_reason TEXT CHECK (
    action_required_reason IS NULL OR action_required_reason IN (
      'authorization_expired',
      'workspace_access_revoked',
      'device_authorization_unavailable',
      'account_unavailable'
    )
  ),
  allowance_json TEXT NOT NULL CHECK (json_valid(allowance_json)),
  connected_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  refresh_lease TEXT,
  refresh_until INTEGER,
  CHECK (
    (lifecycle = 'connected' AND action_required_reason IS NULL) OR
    (lifecycle = 'action_required' AND action_required_reason IS NOT NULL)
  ),
  CHECK ((refresh_lease IS NULL) = (refresh_until IS NULL))
);
CREATE TABLE organisation_codex_authorization_attempt (
  attempt_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('awaiting_user', 'connected', 'cancelled', 'failed', 'expired')
  ),
  attempt_secret_handle TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  connection_revision INTEGER,
  failure_reason_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (
    (lifecycle = 'awaiting_user' AND connection_revision IS NULL AND
      failure_reason_code IS NULL AND completed_at IS NULL) OR
    (lifecycle = 'connected' AND connection_revision IS NOT NULL AND
      failure_reason_code IS NULL AND completed_at IS NOT NULL) OR
    (lifecycle IN ('cancelled', 'expired') AND connection_revision IS NULL AND
      failure_reason_code IS NULL AND completed_at IS NOT NULL) OR
    (lifecycle = 'failed' AND connection_revision IS NULL AND
      failure_reason_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_organisation_codex_authorization_open
  ON organisation_codex_authorization_attempt (organisation_id)
  WHERE lifecycle = 'awaiting_user';
CREATE INDEX idx_organisation_codex_authorization_expiry
  ON organisation_codex_authorization_attempt (expires_at)
  WHERE lifecycle = 'awaiting_user';
CREATE UNIQUE INDEX idx_organisation_organisation_handle
ON organisation (organisation_handle COLLATE NOCASE);
CREATE TABLE organisation_workspace (
  workspace_id TEXT PRIMARY KEY CHECK (
    workspace_id GLOB 'workspace_*' AND length(workspace_id) > 10
  ),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id) ON DELETE CASCADE,
  workspace_handle TEXT NOT NULL COLLATE NOCASE CHECK (
    length(workspace_handle) BETWEEN 1 AND 63
  ),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  archived_at INTEGER,
  UNIQUE (organisation_id, workspace_handle),
  UNIQUE (organisation_id, workspace_id),
  CHECK (
    (status = 'active' AND archived_at IS NULL) OR
    (status = 'archived' AND archived_at IS NOT NULL)
  )
);
CREATE TABLE organisation_default_workspace (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (organisation_id, workspace_id)
    REFERENCES organisation_workspace (organisation_id, workspace_id)
);
-- An approved amount owed to a supplier, and how much of it is committed.
--
-- `in_flight` is money Pantry has sent but the provider has not settled. It is
-- deliberately not derivable from payout rows: a payout whose outcome is
-- unknown must keep holding its share, and reconstructing that from payout
-- state would release it the moment a row looked terminal.
CREATE TABLE supplier_payable (
  organisation_id TEXT NOT NULL,
  payable_id TEXT NOT NULL CHECK (length(payable_id) BETWEEN 1 AND 255),
  merchant_id TEXT NOT NULL CHECK (length(merchant_id) BETWEEN 1 AND 255),
  supplier_id TEXT NOT NULL CHECK (length(supplier_id) BETWEEN 1 AND 255),
  purchase_request_id TEXT NOT NULL CHECK (length(purchase_request_id) BETWEEN 1 AND 255),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  gross_amount_minor INTEGER NOT NULL CHECK (gross_amount_minor > 0),
  in_flight_minor INTEGER NOT NULL CHECK (in_flight_minor >= 0),
  settled_minor INTEGER NOT NULL CHECK (settled_minor >= 0),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('draft', 'approved', 'partially_paid', 'paid', 'void')
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  payable_json TEXT NOT NULL CHECK (json_valid(payable_json)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, payable_id),
  -- Committed money can never exceed what is owed.
  CHECK (in_flight_minor + settled_minor <= gross_amount_minor)
);
CREATE INDEX idx_supplier_payable_supplier
  ON supplier_payable (organisation_id, supplier_id, lifecycle);

-- One immutable revision of where a supplier is paid.
--
-- Revisions are never edited: changing bank details creates a new one, so a
-- payout bound to a revision can never silently move to a different account.
CREATE TABLE supplier_destination_revision (
  organisation_id TEXT NOT NULL,
  revision_id TEXT NOT NULL CHECK (length(revision_id) BETWEEN 1 AND 255),
  destination_id TEXT NOT NULL CHECK (length(destination_id) BETWEEN 1 AND 255),
  supplier_id TEXT NOT NULL CHECK (length(supplier_id) BETWEEN 1 AND 255),
  rail TEXT NOT NULL CHECK (rail IN ('gmo_aozora_domestic', 'wise_recipient')),
  masked_summary TEXT NOT NULL CHECK (length(masked_summary) BETWEEN 1 AND 255),
  configuration_ref TEXT NOT NULL CHECK (length(configuration_ref) BETWEEN 1 AND 255),
  state TEXT NOT NULL CHECK (state IN ('draft', 'verified', 'active', 'retired')),
  proposed_by TEXT,
  activated_by TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  destination_json TEXT NOT NULL CHECK (json_valid(destination_json)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, revision_id),
  -- Maker-checker: whoever wrote the account cannot be the one who activates it.
  CHECK (activated_by IS NULL OR proposed_by IS NULL OR activated_by <> proposed_by),
  CHECK (state <> 'active' OR activated_by IS NOT NULL)
);
-- A supplier is paid to one account at a time.
CREATE UNIQUE INDEX idx_supplier_destination_active
  ON supplier_destination_revision (organisation_id, destination_id)
  WHERE state = 'active';

-- One Pantry location's binding to a terminal target.
--
-- Retired revisions are kept, not deleted: an attempt dispatched under an
-- earlier revision still needs its binding to recover, and replacing a terminal
-- must never orphan a collection that is still unresolved.
CREATE TABLE cafe_terminal_assignment (
  organisation_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL CHECK (length(assignment_id) BETWEEN 1 AND 255),
  merchant_id TEXT NOT NULL CHECK (length(merchant_id) BETWEEN 1 AND 255),
  pantry_location_id TEXT NOT NULL CHECK (length(pantry_location_id) BETWEEN 1 AND 255),
  provider_location_id TEXT NOT NULL CHECK (length(provider_location_id) BETWEEN 1 AND 255),
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 255),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('sandbox_simulated', 'paired_physical', 'lan_gateway_device', 'square_pos_app')),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  assignment_json TEXT NOT NULL CHECK (json_valid(assignment_json)),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  PRIMARY KEY (organisation_id, assignment_id, revision),
  -- A simulated target belongs to development; a paired device and the Square
  -- Point of Sale app (Square's Sandbox has no Point of Sale API) to
  -- production; a LAN gateway device to either.
  CHECK (
    (target_kind = 'sandbox_simulated' AND environment = 'development') OR
    (target_kind IN ('paired_physical', 'square_pos_app') AND environment = 'production') OR
    (target_kind = 'lan_gateway_device')
  )
);
-- One counter sells through one terminal at a time.
CREATE UNIQUE INDEX idx_cafe_terminal_assignment_active_location
  ON cafe_terminal_assignment (organisation_id, pantry_location_id)
  WHERE state = 'active';
-- What a café counter's printed receipt shows besides the sale (Plan 90
-- Phase 5): the Qualified Invoice registration number (T and 13 digits).
CREATE TABLE cafe_counter_receipt_setting (
  organisation_id TEXT NOT NULL,
  pantry_location_id TEXT NOT NULL CHECK (length(pantry_location_id) BETWEEN 1 AND 255),
  invoice_registration_number TEXT CHECK (
    invoice_registration_number IS NULL OR (
      length(invoice_registration_number) = 14 AND
      substr(invoice_registration_number, 1, 1) = 'T' AND
      substr(invoice_registration_number, 2) NOT GLOB '*[^0-9]*'
    )
  ),
  updated_by_user_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, pantry_location_id)
);

-- What Pantry sent to a payout provider, written before the request leaves.
--
-- `provider_transfer_id` is nullable on purpose: between dispatch and the
-- provider's answer there is genuinely no transfer identity, and that absence
-- is the durable record of an indeterminate submission. Recovery reads it to
-- decide which question to ask the provider — never to decide whether to send
-- again.
CREATE TABLE supplier_payout_attempt (
  organisation_id TEXT NOT NULL,
  payout_id TEXT NOT NULL CHECK (length(payout_id) BETWEEN 1 AND 255),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 255),
  approval_digest TEXT NOT NULL CHECK (
    length(approval_digest) = 64 AND approval_digest NOT GLOB '*[^0-9a-f]*'
  ),
  request_identity TEXT NOT NULL CHECK (length(request_identity) BETWEEN 1 AND 255),
  provider_transfer_id TEXT,
  funding_operation_id TEXT,
  dispatched_at INTEGER NOT NULL CHECK (dispatched_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= dispatched_at),
  PRIMARY KEY (organisation_id, attempt_id),
  -- One request identity per payout, so a replay cannot mint a second request.
  UNIQUE (organisation_id, payout_id, request_identity),
  -- Funding belongs to a transfer; it cannot exist without one.
  CHECK (funding_operation_id IS NULL OR provider_transfer_id IS NOT NULL)
);
CREATE INDEX idx_supplier_payout_attempt_payout
  ON supplier_payout_attempt (organisation_id, payout_id, dispatched_at);

-- The canonical payout. Its lifecycle lives in the contract, not here: the
-- thirteen states and their legal transitions are proven in Rust, and this row
-- carries the current one plus the fields an operator must be able to see and
-- an index must be able to find.
--
-- Money fields are duplicated out of the state JSON deliberately. An operator
-- asking "what is outstanding to this supplier" must not need to parse thirteen
-- state shapes to answer it, and a CHECK cannot reach inside JSON.
CREATE TABLE supplier_payout (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id) ON DELETE CASCADE,
  payout_id TEXT NOT NULL CHECK (length(payout_id) BETWEEN 1 AND 255),
  payable_id TEXT NOT NULL CHECK (length(payable_id) BETWEEN 1 AND 255),
  supplier_id TEXT NOT NULL CHECK (length(supplier_id) BETWEEN 1 AND 255),
  purchase_request_id TEXT NOT NULL CHECK (length(purchase_request_id) BETWEEN 1 AND 255),
  rail TEXT NOT NULL CHECK (rail IN ('gmo_aozora_private', 'wise_enterprise_payouts')),
  integration_account_id TEXT NOT NULL,
  destination_revision_id TEXT NOT NULL CHECK (length(destination_revision_id) BETWEEN 1 AND 255),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  recipient_amount_minor INTEGER NOT NULL CHECK (recipient_amount_minor > 0),
  fee_ceiling_minor INTEGER NOT NULL CHECK (fee_ceiling_minor >= 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN (
      'approval_pending', 'approved', 'submitting', 'provider_action_required',
      'provider_pending', 'settled', 'return_pending', 'returned',
      'reversal_pending', 'reversed', 'failed', 'indeterminate', 'cancelled'
    )
  ),
  -- Null until an approval exists. Once set it is the digest of exactly the
  -- economics that were approved; a plan whose economics moved no longer
  -- matches it.
  approval_digest TEXT CHECK (
    approval_digest IS NULL OR
    (length(approval_digest) = 64 AND approval_digest NOT GLOB '*[^0-9a-f]*')
  ),
  payout_json TEXT NOT NULL CHECK (json_valid(payout_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  next_inquiry_at INTEGER NOT NULL DEFAULT 0 CHECK (next_inquiry_at >= 0),
  PRIMARY KEY (organisation_id, payout_id),
  -- One payout per idempotency key. This is what stops a retried proposal from
  -- becoming a second payout against the same payable.
  UNIQUE (organisation_id, idempotency_key),
  -- A payout past approval must carry the digest it was approved against.
  -- Without it, nothing downstream can tell whether the economics moved.
  CHECK (
    state_kind IN ('approval_pending', 'cancelled') OR approval_digest IS NOT NULL
  ),
  FOREIGN KEY (organisation_id, payable_id)
    REFERENCES supplier_payable (organisation_id, payable_id)
);
-- Provider events about payouts, admitted once and kept.
--
-- A webhook is a claim, not an instruction: nothing here advances a payout by
-- itself. The inbox exists so that claims can be deduplicated, ordered by when
-- the provider says they happened rather than when they arrived, and noticed
-- when they are incomplete — a gap in the sequence is the signal to go and ask
-- rather than to assume.
CREATE TABLE supplier_payout_event (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id) ON DELETE CASCADE,
  provider_event_id TEXT NOT NULL,
  rail TEXT NOT NULL CHECK (rail IN ('gmo_aozora_private', 'wise_enterprise_payouts')),
  integration_account_id TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('transfer', 'request')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 255),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  evidence_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'conflict')),
  CHECK (target_kind <> 'request' OR json_extract(observation_json, '$.kind') IS 'failed'),
  PRIMARY KEY (organisation_id, rail, integration_account_id, environment, provider_event_id)
);
CREATE INDEX idx_supplier_payout_event_unapplied
  ON supplier_payout_event (organisation_id, status, occurred_at);

-- Learning a transfer identity contradicts any claim that its request created
-- no transfer. Preserve that exception in the same write as the new identity.
CREATE TRIGGER supplier_payout_request_failure_contradicted
AFTER UPDATE OF provider_transfer_id ON supplier_payout_attempt
WHEN NEW.provider_transfer_id IS NOT NULL
BEGIN
  UPDATE supplier_payout_event SET status = 'conflict'
  WHERE organisation_id = NEW.organisation_id AND target_kind = 'request' AND target_id = NEW.request_identity
    AND EXISTS (SELECT 1 FROM supplier_payout p WHERE p.organisation_id = NEW.organisation_id
      AND p.payout_id = NEW.payout_id AND p.rail = supplier_payout_event.rail
      AND p.integration_account_id = supplier_payout_event.integration_account_id);
END;

-- Evidence that one payout rail works, for one exact account.
--
-- It certifies sending money to a third party, so no packet for taking money
-- from a customer can answer for it.
CREATE TABLE supplier_payout_certification (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id) ON DELETE CASCADE,
  test_run_id TEXT NOT NULL CHECK (length(test_run_id) BETWEEN 1 AND 255),
  rail TEXT NOT NULL CHECK (rail IN ('gmo_aozora_private', 'wise_enterprise_payouts')),
  integration_account_id TEXT NOT NULL,
  -- The exact source of funds. A Wise profile and a GMO source account are
  -- different things certified separately; a packet for one says nothing about
  -- the other.
  source_reference TEXT NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 255),
  -- Only 'balance' is certified today; the column exists so a future mode
  -- cannot inherit this evidence.
  funding_mode TEXT NOT NULL CHECK (funding_mode IN ('balance')),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 120),
  evidence_source TEXT NOT NULL CHECK (
    evidence_source IN ('deterministic_fixture', 'provider_sandbox', 'controlled_live')
  ),
  matrix_version INTEGER NOT NULL CHECK (matrix_version = 1),
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  -- The currencies and ceiling this run actually proved. A payout above what
  -- was tested is not covered by this packet.
  certified_currency TEXT NOT NULL CHECK (length(certified_currency) = 3),
  certified_maximum_minor INTEGER NOT NULL CHECK (certified_maximum_minor > 0),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  certified_at INTEGER NOT NULL CHECK (certified_at >= 0),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= certified_at),
  certified_by TEXT NOT NULL CHECK (length(certified_by) BETWEEN 1 AND 120),
  -- Production moves real money to a third party. Only evidence from a
  -- controlled live run against the actual account proves that path; a fixture
  -- or sandbox packet cannot activate it.
  CHECK (
    (environment = 'production' AND evidence_source = 'controlled_live') OR
    (environment = 'development' AND evidence_source <> 'controlled_live')
  ),
  PRIMARY KEY (organisation_id, test_run_id),
  UNIQUE (organisation_id, rail, source_reference, funding_mode, environment, evidence_digest),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE INDEX idx_supplier_payout_certification_rail
  ON supplier_payout_certification (
    organisation_id, rail, source_reference, funding_mode, environment
  );
-- A packet is evidence of what happened; it is never edited afterwards.
CREATE TRIGGER supplier_payout_certification_no_update
BEFORE UPDATE ON supplier_payout_certification
BEGIN
  SELECT RAISE(ABORT, 'supplier payout certification is immutable');
END;

-- Operators read by supplier and by what still needs attention, not by id.
CREATE INDEX idx_supplier_payout_supplier
  ON supplier_payout (organisation_id, supplier_id, updated_at);
CREATE INDEX idx_supplier_payout_state
  ON supplier_payout (organisation_id, state_kind, updated_at);

CREATE TABLE organisation_claude_authorization (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  attempt_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  verifier_handle TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'exchanging'))
);
CREATE TABLE organisation_claude_connection (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  connection_id TEXT NOT NULL UNIQUE,
  credential_handle TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('connected', 'refreshing', 'action_required')),
  refresh_lease TEXT,
  refresh_until INTEGER,
  CHECK ((state IN ('connected', 'action_required') AND refresh_lease IS NULL AND refresh_until IS NULL) OR
    (state = 'refreshing' AND refresh_lease IS NOT NULL AND refresh_until IS NOT NULL))
);
CREATE TABLE organisation_inference_selection (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  selection_kind TEXT NOT NULL CHECK (
    selection_kind IN (
      'codex_subscription',
      'organisation_openai_api_key',
      'organisation_anthropic_api_key',
      'organisation_google_api_key',
      'claude_oauth',
      'pantry_platform'
    )
  ),
  selected_by_user_id TEXT NOT NULL,
  selected_at INTEGER NOT NULL CHECK (selected_at >= 0)
);
CREATE TABLE organisation_slack_reasoning_effort (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high')),
  selected_by_user_id TEXT NOT NULL,
  selected_at INTEGER NOT NULL CHECK (selected_at >= 0)
);
CREATE UNIQUE INDEX idx_integration_account_organisation
  ON integration_account (integration_account_id, organisation_id);
CREATE UNIQUE INDEX idx_agent_installation_organisation
  ON agent_installation (installation_id, organisation_id);
CREATE TABLE email_mailbox_account (
  integration_account_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  google_subject TEXT NOT NULL CHECK (length(google_subject) > 0),
  observed_address TEXT NOT NULL CHECK (length(observed_address) > 0),
  address_observed_at INTEGER NOT NULL CHECK (address_observed_at >= 0),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE UNIQUE INDEX idx_email_mailbox_account_subject
  ON email_mailbox_account (environment, google_subject);
CREATE UNIQUE INDEX idx_email_mailbox_account_organisation
  ON email_mailbox_account (integration_account_id, organisation_id);
CREATE TABLE agent_mailbox_binding (
  mailbox_binding_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL UNIQUE,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES email_mailbox_account (integration_account_id, organisation_id)
);
CREATE UNIQUE INDEX idx_agent_mailbox_binding_organisation
  ON agent_mailbox_binding (mailbox_binding_id, organisation_id);
CREATE TABLE agent_mailbox_binding_revision (
  mailbox_binding_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  installation_id TEXT NOT NULL,
  response_policy TEXT NOT NULL CHECK (response_policy = 'cue_routed'),
  grants_digest TEXT NOT NULL CHECK (length(grants_digest) = 64),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (mailbox_binding_id, revision),
  FOREIGN KEY (mailbox_binding_id, organisation_id)
    REFERENCES agent_mailbox_binding (mailbox_binding_id, organisation_id),
  FOREIGN KEY (installation_id, organisation_id)
    REFERENCES agent_installation (installation_id, organisation_id)
);
CREATE TABLE mailbox_ingress_policy (
  integration_account_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES email_mailbox_account (integration_account_id, organisation_id)
);
CREATE TABLE mailbox_ingress_policy_revision (
  integration_account_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  kind TEXT NOT NULL CHECK (kind IN ('disabled_by_operator', 'enabled')),
  max_active_cases INTEGER CHECK (max_active_cases > 0),
  max_messages_per_hour INTEGER CHECK (max_messages_per_hour > 0),
  daily_token_budget INTEGER CHECK (daily_token_budget > 0),
  max_message_bytes INTEGER CHECK (max_message_bytes > 0),
  max_attachment_bytes INTEGER CHECK (max_attachment_bytes > 0),
  published_by_user_id TEXT NOT NULL,
  published_at INTEGER NOT NULL CHECK (published_at >= 0),
  PRIMARY KEY (integration_account_id, policy_version),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES email_mailbox_account (integration_account_id, organisation_id),
  CHECK (
    (kind = 'enabled'
      AND max_active_cases IS NOT NULL
      AND max_messages_per_hour IS NOT NULL
      AND daily_token_budget IS NOT NULL
      AND max_message_bytes IS NOT NULL
      AND max_attachment_bytes IS NOT NULL)
    OR (kind = 'disabled_by_operator'
      AND max_active_cases IS NULL
      AND max_messages_per_hour IS NULL
      AND daily_token_budget IS NULL
      AND max_message_bytes IS NULL
      AND max_attachment_bytes IS NULL)
  )
);
CREATE TABLE email_thread_case (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL CHECK (length(gmail_thread_id) > 0),
  case_id TEXT NOT NULL UNIQUE,
  mailbox_binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (integration_account_id, gmail_thread_id),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES email_mailbox_account (integration_account_id, organisation_id),
  FOREIGN KEY (mailbox_binding_id, binding_revision)
    REFERENCES agent_mailbox_binding_revision (mailbox_binding_id, revision)
);
CREATE TABLE email_reply_proposal (
  proposal_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  lifecycle_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES email_mailbox_account (integration_account_id, organisation_id)
);
CREATE INDEX idx_email_reply_proposal_account
  ON email_reply_proposal (organisation_id, integration_account_id, lifecycle_kind);
CREATE TABLE gmail_inference_eligibility (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  key_source TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) > 0),
  evidence_owner TEXT NOT NULL CHECK (length(trim(evidence_owner)) > 0),
  disclosed_recipients TEXT NOT NULL CHECK (length(trim(disclosed_recipients)) > 0),
  permitted_purpose TEXT NOT NULL CHECK (length(trim(permitted_purpose)) > 0),
  consent_reference TEXT NOT NULL CHECK (length(trim(consent_reference)) > 0),
  reviewed_at INTEGER NOT NULL CHECK (reviewed_at >= 0),
  review_expires_at INTEGER NOT NULL CHECK (review_expires_at > reviewed_at),
  consented_at INTEGER NOT NULL CHECK (consented_at >= 0),
  revoked_at INTEGER CHECK (revoked_at >= reviewed_at),
  consented_by_user_id TEXT CHECK (length(trim(consented_by_user_id)) > 0),
  PRIMARY KEY (organisation_id, key_source, provider, model),
  CHECK (
    (key_source = 'organisation_subscription' AND provider = 'openai') OR
    (key_source = 'organisation_byo' AND provider IN ('openai', 'anthropic', 'google')) OR
    (key_source = 'platform' AND provider = 'openai-compatible')
  )
);
CREATE TABLE email_operational_proposal_projection (
  proposal_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  target_digest TEXT NOT NULL CHECK (length(target_digest) = 64),
  subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 64),
  body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  lifecycle_kind TEXT NOT NULL CHECK (
    lifecycle_kind IN (
      'awaiting_approval', 'sent', 'send_indeterminate', 'rejected',
      'expired', 'superseded', 'revoked', 'operator_attested_present',
      'operator_attested_absent'
    )
  ),
  provider_message_id TEXT,
  provider_thread_id TEXT,
  indeterminate_rfc_message_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE INDEX idx_email_operational_proposal_projection_queue
  ON email_operational_proposal_projection (organisation_id, lifecycle_kind, updated_at DESC);
CREATE TABLE slack_message_proposal (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  proposal_id TEXT NOT NULL CHECK (length(proposal_id) BETWEEN 1 AND 200),
  case_id TEXT NOT NULL,
  integration_account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  channel_hint TEXT CHECK (channel_hint IS NULL OR length(channel_hint) BETWEEN 1 AND 200),
  channel_id TEXT CHECK (channel_id IS NULL OR length(channel_id) BETWEEN 1 AND 64),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0),
  lifecycle_kind TEXT NOT NULL CHECK (
    lifecycle_kind IN ('awaiting_approval', 'sending', 'sent', 'send_failed', 'rejected', 'expired')
  ),
  sent_channel_id TEXT,
  sent_message_ts TEXT,
  failure_code TEXT,
  decided_by_user_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  CHECK ((lifecycle_kind = 'sent') = (sent_channel_id IS NOT NULL AND sent_message_ts IS NOT NULL)),
  CHECK ((lifecycle_kind = 'send_failed') = (failure_code IS NOT NULL)),
  PRIMARY KEY (organisation_id, proposal_id),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id)
) STRICT;
CREATE INDEX idx_slack_message_proposal_case
  ON slack_message_proposal (organisation_id, case_id, created_at);
CREATE TABLE agent_permission_request (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  request_id TEXT NOT NULL CHECK (
    length(request_id) = 32 AND request_id NOT GLOB '*[^0-9a-f]*'
  ),
  origin TEXT NOT NULL CHECK (origin IN ('slack_thread', 'portal_chat')),
  case_id TEXT NOT NULL CHECK (length(case_id) BETWEEN 1 AND 300),
  connector_id TEXT CHECK (
    connector_id IS NULL OR length(connector_id) BETWEEN 1 AND 300
  ),
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  requester_person_id TEXT NOT NULL,
  requester_user_id TEXT,
  requester_role TEXT NOT NULL CHECK (
    requester_role IN ('owner', 'admin', 'operator', 'viewer')
  ),
  request_authority_json TEXT NOT NULL CHECK (json_valid(request_authority_json)),
  capability_ids_json TEXT NOT NULL CHECK (
    json_valid(capability_ids_json) AND json_type(capability_ids_json) = 'array'
  ),
  entity_type_reads_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(entity_type_reads_json)
    AND json_type(entity_type_reads_json) = 'array'
  ),
  slack_workspace_id TEXT,
  slack_channel_id TEXT,
  slack_thread_ts TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied')),
  decided_by_user_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  decided_at INTEGER CHECK (decided_at IS NULL OR decided_at >= created_at),
  -- When the decision reached the asking turn; null while a Slack request
  -- waits for its Connector.
  released_at INTEGER CHECK (released_at IS NULL OR released_at >= 0),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'pending') = (decided_by_user_id IS NULL)),
  CHECK (
    (origin = 'slack_thread') = (
      connector_id IS NOT NULL AND slack_workspace_id IS NOT NULL
      AND slack_channel_id IS NOT NULL AND slack_thread_ts IS NOT NULL
    )
  ),
  CHECK (
    (origin = 'portal_chat') = (
      connector_id IS NULL AND slack_workspace_id IS NULL
      AND slack_channel_id IS NULL AND slack_thread_ts IS NULL
    )
  ),
  PRIMARY KEY (organisation_id, request_id)
) STRICT;
CREATE INDEX idx_agent_permission_request_case
  ON agent_permission_request (organisation_id, case_id, status);
CREATE INDEX idx_agent_permission_request_session
  ON agent_permission_request (organisation_id, session_id, status);
CREATE TABLE held_output_request (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  request_id TEXT NOT NULL CHECK (
    length(request_id) = 32 AND request_id NOT GLOB '*[^0-9a-f]*'
  ),
  -- An output waits in the Case outbox. An effect waits for its turn to ask
  -- again, and an allow gives that effect one pass.
  subject TEXT NOT NULL CHECK (subject IN ('output', 'effect')),
  -- Null for an effect of a Portal chat, which has no thread to continue.
  case_id TEXT CHECK (case_id IS NULL OR length(case_id) BETWEEN 1 AND 300),
  connector_id TEXT CHECK (
    connector_id IS NULL OR length(connector_id) BETWEEN 1 AND 300
  ),
  channel_id TEXT CHECK (channel_id IS NULL OR length(channel_id) BETWEEN 1 AND 300),
  output_id TEXT CHECK (output_id IS NULL OR length(output_id) BETWEEN 1 AND 600),
  session_id TEXT,
  authority_partition_digest TEXT,
  capability_id TEXT,
  integration_account_id TEXT,
  resource_scope TEXT,
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= 0),
  -- 'outside_written': the Session read text of a person outside the
  -- Organisation, so the person who asked confirms the step (Plan 89).
  reason TEXT NOT NULL CHECK (
    reason IN ('private_source', 'outside_organisation', 'outside_written')
  ),
  -- Null for a run that no person started.
  requester_person_id TEXT,
  request_authority_json TEXT NOT NULL CHECK (json_valid(request_authority_json)),
  flow_label_json TEXT NOT NULL CHECK (json_valid(flow_label_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'expired')),
  decided_by_user_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  decided_at INTEGER CHECK (decided_at IS NULL OR decided_at >= created_at),
  -- When the output left, or when the Case dropped it.
  released_at INTEGER CHECK (released_at IS NULL OR released_at >= 0),
  -- The turn that used an effect's pass. Later edits of that turn, which is
  -- one request of the person, use the same pass (Plan 40B phase 7).
  consumed_turn_id TEXT CHECK (
    consumed_turn_id IS NULL OR length(consumed_turn_id) BETWEEN 1 AND 600
  ),
  -- The exact action of an 'outside_written' step: the digest that a pass
  -- must match, and the values that the prompt shows (Plan 89).
  action_digest TEXT CHECK (
    action_digest IS NULL OR (
      length(action_digest) = 64 AND action_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  action_json TEXT CHECK (action_json IS NULL OR json_valid(action_json)),
  CHECK ((action_digest IS NULL) = (action_json IS NULL)),
  CHECK (action_digest IS NULL OR reason = 'outside_written'),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((subject = 'output') = (output_id IS NOT NULL)),
  CHECK (
    subject = 'output' OR (
      session_id IS NOT NULL AND authority_partition_digest IS NOT NULL
      AND capability_id IS NOT NULL AND integration_account_id IS NOT NULL
      AND resource_scope IS NOT NULL
    )
  ),
  PRIMARY KEY (organisation_id, request_id)
) STRICT;
CREATE INDEX idx_held_output_request_status
  ON held_output_request (organisation_id, status, created_at);
CREATE INDEX idx_held_output_request_effect
  ON held_output_request (organisation_id, session_id, capability_id, status);
CREATE TABLE email_operational_attestation (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  proposal_id TEXT NOT NULL REFERENCES email_operational_proposal_projection (proposal_id),
  attestation TEXT NOT NULL CHECK (attestation IN ('present', 'absent')),
  attested_by_user_id TEXT NOT NULL,
  attested_at INTEGER NOT NULL CHECK (attested_at >= 0),
  PRIMARY KEY (organisation_id, proposal_id)
);
CREATE TABLE email_self_test (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  self_test_id TEXT NOT NULL,
  integration_account_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  address TEXT NOT NULL CHECK (length(address) BETWEEN 3 AND 320),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  PRIMARY KEY (organisation_id, self_test_id),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE TABLE email_operational_contact (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  contact_kind TEXT NOT NULL CHECK (contact_kind IN ('customer_contact', 'supplier_contact')),
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  contact_id TEXT NOT NULL CHECK (length(contact_id) > 0),
  contact_revision INTEGER NOT NULL CHECK (contact_revision > 0),
  observed_address TEXT NOT NULL CHECK (length(observed_address) BETWEEN 3 AND 320),
  display_name TEXT,
  contact_state TEXT NOT NULL CHECK (contact_state IN ('active', 'suppressed')),
  relationship_state TEXT NOT NULL CHECK (relationship_state IN ('active', 'inactive')),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, contact_kind, entity_id, contact_id)
);
CREATE TABLE contact_endpoint_verification (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  verification_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  command_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('verified', 'revoked')),
  merchant_id TEXT NOT NULL,
  integration_account_id TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  endpoint_json TEXT NOT NULL CHECK (json_valid(endpoint_json)),
  evidence_ref TEXT,
  verified_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  CHECK ((state = 'verified' AND evidence_ref IS NOT NULL) OR (state = 'revoked' AND evidence_ref IS NULL)),
  PRIMARY KEY (organisation_id, verification_id, revision),
  UNIQUE (organisation_id, command_id),
  FOREIGN KEY (integration_account_id, organisation_id) REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE INDEX contact_endpoint_verification_lookup
  ON contact_endpoint_verification (organisation_id, integration_account_id, endpoint_json, verification_id, revision DESC);

CREATE TABLE email_sender_account (
  integration_account_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  google_subject TEXT NOT NULL CHECK (length(google_subject) > 0),
  observed_address TEXT NOT NULL CHECK (length(observed_address) BETWEEN 3 AND 320),
  address_observed_at INTEGER NOT NULL CHECK (address_observed_at >= 0),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE UNIQUE INDEX idx_email_sender_account_subject
  ON email_sender_account (environment, google_subject);
CREATE TABLE email_message_receipt (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL CHECK (length(provider_message_id) > 0),
  gmail_thread_id TEXT NOT NULL CHECK (length(gmail_thread_id) > 0),
  case_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
  contact_verification_id TEXT,
  contact_verification_revision INTEGER CHECK (contact_verification_revision > 0),
  PRIMARY KEY (integration_account_id, provider_message_id),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES email_mailbox_account (integration_account_id, organisation_id),
  CHECK (
    (contact_verification_id IS NULL AND contact_verification_revision IS NULL) OR
    (contact_verification_id IS NOT NULL AND contact_verification_revision IS NOT NULL)
  )
);

CREATE TABLE whatsapp_phone_number_account (
  integration_account_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  provider_connection_id TEXT NOT NULL REFERENCES provider_connection (provider_connection_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  business_portfolio_id TEXT NOT NULL CHECK (length(business_portfolio_id) > 0),
  waba_id TEXT NOT NULL CHECK (length(waba_id) > 0),
  phone_number_id TEXT NOT NULL CHECK (length(phone_number_id) > 0),
  display_phone_number TEXT NOT NULL CHECK (length(display_phone_number) > 0),
  verified_name TEXT NOT NULL,
  provider_health TEXT NOT NULL CHECK (
    provider_health IN ('pending', 'healthy', 'degraded', 'unsubscribed', 'revoked')
  ),
  provider_health_reason TEXT,
  webhook_verified_at INTEGER,
  -- A discovered number is a candidate until its owner selects it. Only a
  -- selected number claims the global phone-number id and routes webhooks.
  selected_at INTEGER CHECK (selected_at IS NULL OR selected_at >= created_at),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id),
  CHECK (
    (provider_health = 'degraded' AND provider_health_reason IS NOT NULL) OR
    (provider_health <> 'degraded' AND provider_health_reason IS NULL)
  )
);
CREATE UNIQUE INDEX idx_whatsapp_phone_number_claim
  ON whatsapp_phone_number_account (phone_number_id) WHERE selected_at IS NOT NULL;
CREATE UNIQUE INDEX idx_whatsapp_phone_number_organisation
  ON whatsapp_phone_number_account (integration_account_id, organisation_id);
CREATE INDEX idx_whatsapp_phone_number_waba
  ON whatsapp_phone_number_account (waba_id);
CREATE TABLE whatsapp_support_binding (
  support_binding_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL UNIQUE,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES whatsapp_phone_number_account (integration_account_id, organisation_id)
);
CREATE UNIQUE INDEX idx_whatsapp_support_binding_organisation
  ON whatsapp_support_binding (support_binding_id, organisation_id);
CREATE TABLE whatsapp_support_binding_revision (
  support_binding_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  installation_id TEXT NOT NULL,
  response_policy TEXT NOT NULL CHECK (response_policy = 'approval_required'),
  grants_digest TEXT NOT NULL CHECK (length(grants_digest) = 64),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (support_binding_id, revision),
  FOREIGN KEY (support_binding_id, organisation_id)
    REFERENCES whatsapp_support_binding (support_binding_id, organisation_id),
  FOREIGN KEY (installation_id, organisation_id)
    REFERENCES agent_installation (installation_id, organisation_id)
);
CREATE TABLE whatsapp_ingress_policy (
  integration_account_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES whatsapp_phone_number_account (integration_account_id, organisation_id)
);
CREATE TABLE whatsapp_ingress_policy_revision (
  integration_account_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  processing TEXT NOT NULL CHECK (processing IN ('enabled', 'disabled')),
  max_active_cases INTEGER CHECK (max_active_cases > 0),
  max_messages_per_hour INTEGER CHECK (max_messages_per_hour > 0),
  daily_agent_token_budget INTEGER CHECK (daily_agent_token_budget > 0),
  max_message_bytes INTEGER CHECK (max_message_bytes > 0),
  max_active_case_messages INTEGER CHECK (max_active_case_messages > 0),
  max_active_case_bytes INTEGER CHECK (max_active_case_bytes > 0),
  debounce_seconds INTEGER CHECK (debounce_seconds BETWEEN 10 AND 30),
  relevant_message_topics TEXT CHECK (
    relevant_message_topics IS NULL OR
    length(trim(relevant_message_topics)) BETWEEN 1 AND 2000
  ),
  automatic_acknowledgement_text TEXT CHECK (
    automatic_acknowledgement_text IS NULL OR
    length(trim(automatic_acknowledgement_text)) BETWEEN 1 AND 1000
  ),
  overflow TEXT CHECK (overflow = 'pause_and_notify'),
  notification_destination TEXT CHECK (json_valid(notification_destination)),
  published_by_user_id TEXT NOT NULL,
  published_at INTEGER NOT NULL CHECK (published_at >= 0),
  agent_mode TEXT NOT NULL DEFAULT 'answer' CHECK (agent_mode IN ('off', 'draft', 'answer')),
  always_wait_topics TEXT CHECK (always_wait_topics IS NULL OR length(always_wait_topics) <= 2000),
  PRIMARY KEY (integration_account_id, policy_version),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES whatsapp_phone_number_account (integration_account_id, organisation_id),
  CHECK (
    (processing = 'enabled'
      AND max_active_cases IS NOT NULL
      AND max_messages_per_hour IS NOT NULL
      AND daily_agent_token_budget IS NOT NULL
      AND max_message_bytes IS NOT NULL
      AND max_active_case_messages IS NOT NULL
      AND max_active_case_bytes IS NOT NULL
      AND debounce_seconds IS NOT NULL
      AND relevant_message_topics IS NOT NULL
      AND automatic_acknowledgement_text IS NOT NULL
      AND overflow IS NOT NULL
      AND notification_destination IS NOT NULL)
    OR (processing = 'disabled'
      AND max_active_cases IS NULL
      AND max_messages_per_hour IS NULL
      AND daily_agent_token_budget IS NULL
      AND max_message_bytes IS NULL
      AND max_active_case_messages IS NULL
      AND max_active_case_bytes IS NULL
      AND debounce_seconds IS NULL
      AND relevant_message_topics IS NULL
      AND automatic_acknowledgement_text IS NULL
      AND overflow IS NULL
      AND notification_destination IS NULL)
  )
);
CREATE TABLE whatsapp_case_conversation_window (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  customer_wa_id TEXT NOT NULL CHECK (length(customer_wa_id) > 0),
  conversation_window_sequence INTEGER NOT NULL CHECK (conversation_window_sequence > 0),
  case_id TEXT NOT NULL UNIQUE,
  support_binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('agent_active', 'human_owned')),
  ownership_user_id TEXT,
  ownership_reason TEXT CHECK (ownership_reason IN ('operator_takeover', 'agent_handoff')),
  ownership_started_at INTEGER,
  handoff_requested_at INTEGER,
  handoff_reason TEXT,
  service_window_expires_at INTEGER NOT NULL CHECK (service_window_expires_at > 0),
  opened_at INTEGER NOT NULL CHECK (opened_at >= 0),
  closed_at INTEGER,
  PRIMARY KEY (integration_account_id, customer_wa_id, conversation_window_sequence),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES whatsapp_phone_number_account (integration_account_id, organisation_id),
  FOREIGN KEY (support_binding_id, binding_revision)
    REFERENCES whatsapp_support_binding_revision (support_binding_id, revision),
  CHECK (
    (ownership_kind = 'agent_active'
      AND ownership_user_id IS NULL
      AND ownership_reason IS NULL AND ownership_started_at IS NULL) OR
    (ownership_kind = 'human_owned'
      AND ownership_user_id IS NOT NULL
      AND ownership_reason IS NOT NULL AND ownership_started_at IS NOT NULL)
  ),
  CHECK ((handoff_requested_at IS NULL) = (handoff_reason IS NULL))
);
CREATE INDEX idx_whatsapp_case_conversation_window_open
  ON whatsapp_case_conversation_window (organisation_id, integration_account_id, closed_at);
CREATE TABLE whatsapp_message_receipt (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL CHECK (length(provider_message_id) > 0),
  customer_wa_id TEXT NOT NULL CHECK (length(customer_wa_id) > 0),
  case_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
  body_size_bucket TEXT NOT NULL CHECK (body_size_bucket IN ('tiny', 'small', 'medium', 'large')),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  provider_timestamp INTEGER NOT NULL CHECK (provider_timestamp >= 0),
  admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
  PRIMARY KEY (integration_account_id, provider_message_id),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES whatsapp_phone_number_account (integration_account_id, organisation_id)
);
CREATE TABLE whatsapp_reply_proposal (
  proposal_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  customer_wa_id TEXT NOT NULL CHECK (length(customer_wa_id) > 0),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  lifecycle_kind TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('agent', 'human')),
  service_window_expires_at INTEGER NOT NULL CHECK (service_window_expires_at > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES whatsapp_phone_number_account (integration_account_id, organisation_id)
);
CREATE INDEX idx_whatsapp_reply_proposal_account
  ON whatsapp_reply_proposal (organisation_id, integration_account_id, lifecycle_kind);
CREATE TABLE whatsapp_delivery_status (
  integration_account_id TEXT NOT NULL,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  whatsapp_message_id TEXT NOT NULL CHECK (length(whatsapp_message_id) > 0),
  status TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  status_at INTEGER NOT NULL CHECK (status_at >= 0),
  failure_code TEXT,
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  PRIMARY KEY (integration_account_id, whatsapp_message_id, status),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES whatsapp_phone_number_account (integration_account_id, organisation_id),
  CHECK ((status = 'failed') OR failure_code IS NULL)
);


CREATE INDEX idx_supplier_payout_inquiry ON supplier_payout (next_inquiry_at, organisation_id, state_kind);

CREATE TABLE portal_chat_directory (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (organisation_id, user_id)
);

CREATE TABLE project (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT,
  project_id TEXT NOT NULL,
  access_kind TEXT NOT NULL DEFAULT 'personal' CHECK (access_kind IN ('personal', 'shared')),
  access_revision INTEGER NOT NULL DEFAULT 0 CHECK (access_revision >= 0),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  brief TEXT NOT NULL CHECK (length(brief) <= 4000),
  references_json TEXT NOT NULL CHECK (json_valid(references_json)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content_revision INTEGER NOT NULL CHECK (content_revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, project_id),
  CHECK ((access_kind = 'personal' AND user_id IS NOT NULL)
    OR (access_kind = 'shared' AND user_id IS NULL))
);

CREATE TABLE portal_chat_directory_project (
  organisation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  PRIMARY KEY (organisation_id, user_id, project_id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES project(organisation_id, project_id) ON DELETE CASCADE
);

CREATE TABLE project_member (
  organisation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (organisation_id, project_id, user_id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES project (organisation_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, user_id) REFERENCES service_role_grant (organisation_id, user_id)
);
CREATE INDEX project_member_user ON project_member (organisation_id, user_id, project_id);

CREATE TABLE project_access_operation (
  organisation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  access_revision INTEGER NOT NULL CHECK (access_revision > 0),
  accepted_at INTEGER NOT NULL,
  disclosure_proof_json TEXT NOT NULL CHECK (json_valid(disclosure_proof_json)),
  PRIMARY KEY (organisation_id, actor_user_id, operation_id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES project (organisation_id, project_id) ON DELETE CASCADE
);

CREATE TABLE organisation_default_project (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (organisation_id, project_id) REFERENCES project (organisation_id, project_id)
);

CREATE TABLE case_project (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  case_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  -- Where the Case was admitted. It decides who may move it and never changes.
  origin_kind TEXT NOT NULL DEFAULT 'direct' CHECK (origin_kind IN ('portal_chat', 'canvas_chat', 'direct', 'slack', 'email', 'whatsapp', 'inbox_assistant', 'commerce_approval')),
  PRIMARY KEY (organisation_id, case_id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES project (organisation_id, project_id)
);
CREATE INDEX idx_case_project_project ON case_project (organisation_id, project_id, case_id);

-- Accepted general Project commands and Case moves. A retry with the same
-- operation and command reads its recorded outcome.
CREATE TABLE project_operation (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 160),
  command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
  project_id TEXT NOT NULL,
  case_id TEXT,
  -- The revision the command produced: of the Project, the default pointer or the Case association.
  result_revision INTEGER NOT NULL CHECK (result_revision >= 1),
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
  PRIMARY KEY (organisation_id, actor_user_id, operation_id)
);

CREATE TABLE portal_chat_conversation_access_operation (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  conversation_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  conversation_revision INTEGER NOT NULL CHECK (conversation_revision > 0),
  project_id TEXT NOT NULL,
  access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
  accepted_at INTEGER NOT NULL,
  disclosure_proof_json TEXT NOT NULL CHECK (json_valid(disclosure_proof_json)),
  PRIMARY KEY (organisation_id, actor_user_id, operation_id)
);

CREATE TABLE portal_chat_directory_operation (
  organisation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
  directory_revision INTEGER NOT NULL CHECK (directory_revision >= 0),
  position INTEGER NOT NULL CHECK (position >= 0),
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, user_id, operation_id),
  FOREIGN KEY (organisation_id, user_id) REFERENCES portal_chat_directory (organisation_id, user_id)
);

CREATE TABLE portal_chat_deletion (
  organisation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('cleaning', 'failed', 'deleted')),
  cleanup_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cleanup_json)),
  error TEXT,
  PRIMARY KEY (organisation_id, user_id, conversation_id),
  UNIQUE (organisation_id, conversation_id),
  UNIQUE (organisation_id, user_id, operation_id)
);

CREATE TABLE portal_conversation (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  -- The Case this chat presents. Its Project is the Case's, in case_project.
  case_id TEXT NOT NULL,
  access_kind TEXT NOT NULL DEFAULT 'private' CHECK (access_kind IN ('private', 'shared', 'workspace_canvas')),
  canvas_document_id TEXT,
  canvas_generation INTEGER,
  active_user_id TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  state_format INTEGER NOT NULL DEFAULT 1 CHECK (state_format >= 1),
  title_normalized TEXT NOT NULL DEFAULT '' CHECK (length(title_normalized) <= 160),
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL DEFAULT 0 CHECK (last_activity_at >= 0),
  latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
  CHECK ((access_kind = 'workspace_canvas' AND canvas_document_id IS NOT NULL AND canvas_generation >= 1 AND canvas_generation IS NOT NULL) OR (access_kind <> 'workspace_canvas' AND canvas_document_id IS NULL AND canvas_generation IS NULL)),
  UNIQUE (organisation_id, canvas_document_id, canvas_generation),
  UNIQUE (organisation_id, case_id),
  PRIMARY KEY (organisation_id, conversation_id),
  FOREIGN KEY (organisation_id, case_id) REFERENCES case_project (organisation_id, case_id)
);
CREATE TRIGGER portal_conversation_shared_insert BEFORE INSERT ON portal_conversation
WHEN NEW.access_kind = 'shared' AND NOT EXISTS (
  SELECT 1 FROM case_project cp JOIN project p ON p.organisation_id = cp.organisation_id AND p.project_id = cp.project_id
  WHERE cp.organisation_id = NEW.organisation_id AND cp.case_id = NEW.case_id AND p.access_kind = 'shared'
) BEGIN SELECT RAISE(ABORT, 'shared_chat_requires_shared_project'); END;
CREATE TRIGGER portal_conversation_shared_update BEFORE UPDATE OF access_kind ON portal_conversation
WHEN NEW.access_kind = 'shared' AND NOT EXISTS (
  SELECT 1 FROM case_project cp JOIN project p ON p.organisation_id = cp.organisation_id AND p.project_id = cp.project_id
  WHERE cp.organisation_id = NEW.organisation_id AND cp.case_id = NEW.case_id AND p.access_kind = 'shared'
) BEGIN SELECT RAISE(ABORT, 'shared_chat_requires_shared_project'); END;
-- The Case of a shared chat stays in a shared Project when it moves.
CREATE TRIGGER case_project_shared_chat_move BEFORE UPDATE OF project_id ON case_project
WHEN EXISTS (
  SELECT 1 FROM portal_conversation c
  WHERE c.organisation_id = NEW.organisation_id AND c.case_id = NEW.case_id AND c.access_kind = 'shared'
) AND NOT EXISTS (
  SELECT 1 FROM project p WHERE p.organisation_id = NEW.organisation_id AND p.project_id = NEW.project_id AND p.access_kind = 'shared'
) BEGIN SELECT RAISE(ABORT, 'shared_chat_requires_shared_project'); END;

CREATE TABLE portal_conversation_user (
  organisation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
  pinned_at INTEGER,
  archived_at INTEGER,
  manual_position INTEGER NOT NULL DEFAULT 0 CHECK (manual_position >= 0),
  last_read_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
  draft_text TEXT NOT NULL DEFAULT '' CHECK (length(draft_text) <= 8000),
  draft_updated_at INTEGER,
  CHECK ((draft_text = '' AND draft_updated_at IS NULL) OR (draft_text <> '' AND draft_updated_at IS NOT NULL AND draft_updated_at >= 0)),
  CHECK ((lifecycle = 'active' AND archived_at IS NULL) OR (lifecycle = 'archived' AND archived_at IS NOT NULL)),
  PRIMARY KEY (organisation_id, user_id, conversation_id),
  FOREIGN KEY (organisation_id, conversation_id) REFERENCES portal_conversation (organisation_id, conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_portal_conversation_user_active ON portal_conversation_user (organisation_id, user_id, pinned_at DESC, manual_position, conversation_id) WHERE lifecycle = 'active';
CREATE INDEX idx_portal_conversation_user_archived ON portal_conversation_user (organisation_id, user_id, archived_at DESC, conversation_id) WHERE lifecycle = 'archived';

CREATE TABLE session_turn_access (
  organisation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('conversation_session', 'operator_session', 'slack_operator')),
  conversation_id TEXT,
  actor_user_id TEXT NOT NULL,
  control_session_id TEXT CHECK (control_session_id IS NULL OR length(control_session_id) > 0),
  project_id TEXT,
  access_revision INTEGER CHECK (access_revision IS NULL OR access_revision >= 0),
  audience_json TEXT CHECK (audience_json IS NULL OR json_valid(audience_json)),
  CHECK (
    (origin_kind = 'conversation_session' AND control_session_id IS NOT NULL
      AND conversation_id IS NOT NULL AND access_revision IS NOT NULL AND audience_json IS NOT NULL)
    OR (origin_kind = 'operator_session' AND control_session_id IS NOT NULL
      AND conversation_id IS NULL AND project_id IS NULL AND access_revision IS NULL AND audience_json IS NULL)
    OR (origin_kind = 'slack_operator' AND control_session_id IS NULL
      AND conversation_id IS NULL AND project_id IS NULL AND access_revision IS NULL AND audience_json IS NULL)
  ),
  PRIMARY KEY (organisation_id, session_id, turn_id),
  FOREIGN KEY (organisation_id, conversation_id) REFERENCES portal_conversation (organisation_id, conversation_id) ON DELETE CASCADE
);

CREATE TABLE bakery_surface_effect_delivery (
  effect_id TEXT PRIMARY KEY CHECK (length(effect_id) > 0),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL CHECK (length(session_id) > 0),
  turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) > 0),
  surface_session_id TEXT NOT NULL CHECK (length(surface_session_id) > 0),
  surface_epoch INTEGER NOT NULL CHECK (surface_epoch >= 0),
  command_digest TEXT NOT NULL CHECK (
    length(command_digest) = 64
    AND command_digest NOT GLOB '*[^0-9a-f]*'
  ),
  effect_json TEXT NOT NULL CHECK (json_valid(effect_json)),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('dispatching', 'settled', 'indeterminate')
  ),
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  deadline_at INTEGER NOT NULL CHECK (deadline_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (state_kind = 'settled' AND receipt_json IS NOT NULL)
    OR (state_kind <> 'settled' AND receipt_json IS NULL)
  )
);
CREATE INDEX idx_bakery_surface_effect_delivery_pending
  ON bakery_surface_effect_delivery (
    organisation_id, user_id, surface_session_id, state_kind, created_at
  );
CREATE INDEX idx_bakery_surface_effect_delivery_age
  ON bakery_surface_effect_delivery (organisation_id, updated_at);

CREATE TABLE bakery_agent_run_save (
  effect_id TEXT PRIMARY KEY REFERENCES bakery_surface_effect_delivery (effect_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  content_id TEXT NOT NULL CHECK (
    length(content_id) = 64 AND content_id NOT GLOB '*[^0-9a-f]*'
  ),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  state_kind TEXT NOT NULL CHECK (state_kind IN ('approved', 'saved')),
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  approved_at INTEGER NOT NULL CHECK (approved_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= approved_at),
  CHECK (
    (state_kind = 'approved' AND summary_json IS NULL)
    OR (state_kind = 'saved' AND summary_json IS NOT NULL)
  )
);

CREATE TABLE bakery_agent_scenario_save (
  effect_id TEXT PRIMARY KEY REFERENCES bakery_surface_effect_delivery (effect_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  scenario_kind TEXT NOT NULL CHECK (scenario_kind IN ('scenario', 'production-scenario')),
  scenario_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (
    length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  state_kind TEXT NOT NULL CHECK (state_kind IN ('approved', 'saved')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  approved_at INTEGER NOT NULL CHECK (approved_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= approved_at),
  CHECK (
    (state_kind = 'approved' AND result_json IS NULL)
    OR (state_kind = 'saved' AND result_json IS NOT NULL)
  )
);

CREATE TABLE bakery_surface_timeline_event (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL CHECK (length(session_id) > 0),
  turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) > 0),
  effect_id TEXT NOT NULL REFERENCES bakery_surface_effect_delivery (effect_id),
  event_kind TEXT NOT NULL CHECK (
    event_kind IN ('started', 'settled', 'indeterminate')
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (effect_id, event_kind)
);
CREATE INDEX idx_bakery_surface_timeline_cursor
  ON bakery_surface_timeline_event (
    organisation_id, user_id, sequence
  );

-- Exact-purpose evidence for TypeSafe processing of one Gmail source connection.
CREATE TABLE mail_classification_eligibility (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  source_pin TEXT NOT NULL,
  -- Plan 88: who funds the calls. Pantry's key pins revision 0; the
  -- Organisation's own key pins its connection revision.
  funding TEXT NOT NULL DEFAULT 'organisation_byo' CHECK (funding IN ('pantry_platform', 'organisation_byo')),
  connection_revision INTEGER NOT NULL CHECK (connection_revision >= 0),
  model TEXT NOT NULL CHECK (model = 'jev-1.13.0'),
  purpose TEXT NOT NULL CHECK (purpose = 'mail_classification'),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) > 0),
  evidence_owner TEXT NOT NULL CHECK (length(trim(evidence_owner)) > 0),
  disclosed_recipient TEXT NOT NULL CHECK (disclosed_recipient = 'typesafe'),
  reviewed_at INTEGER NOT NULL,
  review_expires_at INTEGER NOT NULL CHECK (review_expires_at > reviewed_at),
  revoked_at INTEGER,
  CHECK ((funding = 'pantry_platform') = (connection_revision = 0)),
  PRIMARY KEY (organisation_id, integration_account_id, source_pin, funding, connection_revision),
  FOREIGN KEY (integration_account_id, organisation_id) REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE TABLE mail_classification (
  organisation_id TEXT NOT NULL,
  integration_account_id TEXT NOT NULL,
  rule_revision INTEGER NOT NULL CHECK (rule_revision > 0),
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('matched', 'not_matched', 'needs_review')),
  source TEXT NOT NULL CHECK (source IN ('jev', 'operator')),
  evaluated_at INTEGER NOT NULL,
  evaluation_id TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  PRIMARY KEY (organisation_id, integration_account_id, rule_revision, message_id, rule_id),
  FOREIGN KEY (integration_account_id, organisation_id) REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE INDEX mail_classification_matches ON mail_classification
  (organisation_id, integration_account_id, rule_revision, outcome, rule_id, message_id DESC);

-- Separate operator-reviewed consent for transient Inbox assistance.
CREATE TABLE mail_assistant_eligibility (
  organisation_id TEXT NOT NULL REFERENCES organisation(organisation_id),
  integration_account_id TEXT NOT NULL REFERENCES integration_account(integration_account_id),
  source_pin TEXT NOT NULL CHECK(length(source_pin) = 64),
  model_route_digest TEXT NOT NULL CHECK(length(model_route_digest) = 64),
  purpose TEXT NOT NULL CHECK(purpose = 'mail_inbox_assistance'),
  disclosed_recipient TEXT NOT NULL CHECK(disclosed_recipient IN ('openrouter', 'openai', 'anthropic', 'google')),
  evidence_reference TEXT NOT NULL CHECK(length(trim(evidence_reference)) > 0),
  owner TEXT NOT NULL CHECK(length(trim(owner)) > 0),
  consent_reference TEXT NOT NULL CHECK(length(trim(consent_reference)) > 0),
  reviewed_at INTEGER NOT NULL,
  review_expires_at INTEGER NOT NULL CHECK(review_expires_at > reviewed_at),
  revoked_at INTEGER,
  PRIMARY KEY (organisation_id, integration_account_id, source_pin, model_route_digest)
);

-- Accepted inherited context is independent of the source Actor and its checkpoints.
CREATE TABLE portal_chat_fork (
  organisation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  source_conversation_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  destination_conversation_id TEXT NOT NULL,
  destination_case_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'prepared', 'ready', 'failed', 'erased')),
  history_json TEXT CHECK (history_json IS NULL OR json_valid(history_json)),
  conversation_json TEXT CHECK (conversation_json IS NULL OR json_valid(conversation_json)),
  digest TEXT,
  failure_code TEXT,
  PRIMARY KEY (organisation_id, user_id, operation_id),
  UNIQUE (organisation_id, user_id, destination_conversation_id),
  UNIQUE (organisation_id, destination_case_id),
  CHECK (status NOT IN ('prepared', 'ready') OR (history_json IS NOT NULL AND digest IS NOT NULL)),
  CHECK (status <> 'prepared' OR conversation_json IS NOT NULL),
  CHECK (status <> 'failed' OR failure_code IS NOT NULL)
);
CREATE INDEX portal_chat_fork_source ON portal_chat_fork (organisation_id, user_id, source_conversation_id);

-- A side Case that an agent proposed (Plan 74): in a Portal chat or in a
-- Slack thread. A started proposal is the evidence of its side Case: its
-- flow binding carries the restrictions of the turn that proposed it, and it
-- outlives the source chat. A Portal proposal names its chats; a Slack
-- proposal names its Connector, its channel and its threads.
CREATE TABLE side_case_proposal (
  organisation_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL CHECK (length(proposal_id) = 32),
  source_kind TEXT NOT NULL DEFAULT 'portal_chat' CHECK (source_kind IN ('portal_chat', 'slack_thread')),
  source_case_id TEXT NOT NULL,
  source_conversation_id TEXT,
  source_connector_id TEXT,
  source_workspace_id TEXT,
  source_channel_id TEXT,
  source_thread_ts TEXT,
  source_session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  requested_by_user_id TEXT,
  requested_by_person_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  brief TEXT NOT NULL CHECK (length(brief) BETWEEN 1 AND 2000),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  flow_binding_json TEXT NOT NULL CHECK (json_valid(flow_binding_json)),
  status TEXT NOT NULL CHECK (status IN ('open', 'starting', 'started', 'dismissed')),
  destination_conversation_id TEXT,
  destination_thread_ts TEXT,
  destination_case_id TEXT,
  decided_by_user_id TEXT,
  decided_by_slack_user_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, proposal_id),
  UNIQUE (organisation_id, destination_case_id),
  CHECK ((status = 'open') = (decided_by_user_id IS NULL AND decided_at IS NULL)),
  CHECK (source_kind <> 'portal_chat' OR (
    source_conversation_id IS NOT NULL AND requested_by_user_id IS NOT NULL
    AND source_connector_id IS NULL AND source_workspace_id IS NULL
    AND source_channel_id IS NULL AND source_thread_ts IS NULL
    AND requested_by_person_id IS NULL AND destination_thread_ts IS NULL
    AND decided_by_slack_user_id IS NULL
    AND (status IN ('starting', 'started')) = (destination_conversation_id IS NOT NULL AND destination_case_id IS NOT NULL))),
  CHECK (source_kind <> 'slack_thread' OR (
    source_connector_id IS NOT NULL AND source_workspace_id IS NOT NULL
    AND source_channel_id IS NOT NULL AND source_thread_ts IS NOT NULL
    AND requested_by_person_id IS NOT NULL AND source_conversation_id IS NULL
    AND requested_by_user_id IS NULL AND destination_conversation_id IS NULL
    AND status <> 'dismissed'
    AND (decided_by_slack_user_id IS NULL) = (decided_by_user_id IS NULL)
    AND (destination_thread_ts IS NULL) = (destination_case_id IS NULL)
    AND (status <> 'started' OR destination_case_id IS NOT NULL)))
);
CREATE INDEX side_case_proposal_source ON side_case_proposal (organisation_id, source_conversation_id, created_at);
CREATE INDEX side_case_proposal_source_case ON side_case_proposal (organisation_id, source_case_id, status);


CREATE TABLE organisation_invitation (
  organisation_id TEXT NOT NULL REFERENCES organisation(organisation_id),
  invitation_id TEXT NOT NULL CHECK (length(invitation_id) > 0),
  email TEXT NOT NULL CHECK (length(email) > 0 AND email = lower(email)),
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  invited_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'revoked')),
  accepted_user_id TEXT,
  accepted_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (organisation_id, invitation_id),
  CHECK ((state = 'accepted') = (accepted_user_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX organisation_invitation_pending_email
  ON organisation_invitation (organisation_id, email) WHERE state = 'pending';
CREATE TRIGGER organisation_invitation_closed BEFORE UPDATE ON organisation_invitation
WHEN OLD.state <> 'pending' OR NEW.organisation_id <> OLD.organisation_id
  OR NEW.invitation_id <> OLD.invitation_id OR NEW.email <> OLD.email OR NEW.role <> OLD.role
  OR NEW.token_hash <> OLD.token_hash OR NEW.created_at <> OLD.created_at
  OR NEW.expires_at <> OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'organisation_invitation_closed'); END;

CREATE TABLE device_gateway (
  gateway_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  location_id TEXT NOT NULL CHECK (length(location_id) BETWEEN 1 AND 255),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  code_sha256 TEXT,
  code_expires_at INTEGER,
  credential_sha256 TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  enrolled_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  service_version TEXT,
  last_heard_at INTEGER,
  CHECK ((state = 'pending') = (code_sha256 IS NOT NULL)),
  CHECK ((state = 'active') = (credential_sha256 IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX device_gateway_organisation
  ON device_gateway (organisation_id, state, location_id);
CREATE TABLE device_enrollment (
  device_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  gateway_id TEXT NOT NULL REFERENCES device_gateway (gateway_id),
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 120),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  device_kind TEXT NOT NULL CHECK (device_kind IN ('cobot', 'appliance', 'servo', 'relay', 'camera', 'payment_terminal', 'receipt_printer', 'other')),
  model TEXT NOT NULL,
  serial TEXT,
  firmware_version TEXT,
  station_id TEXT,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'restricted', 'revoked')),
  verified_at INTEGER,
  restrict_reason TEXT,
  restricted_at INTEGER,
  revoked_at INTEGER,
  health TEXT NOT NULL CHECK (health IN ('ok', 'warning', 'fault', 'not_reported')),
  fault_code TEXT,
  fault_text TEXT,
  health_at INTEGER,
  paused_at INTEGER,
  pause_acknowledged_at INTEGER,
  work_state TEXT NOT NULL CHECK (work_state IN ('idle', 'reserved', 'running', 'result_unknown')),
  work_task_ref TEXT,
  work_run_ref TEXT,
  work_label TEXT,
  work_at INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (gateway_id, source_key),
  CHECK ((state = 'restricted') = (restrict_reason IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((state IN ('active', 'restricted')) = (verified_at IS NOT NULL) OR state = 'revoked'),
  CHECK ((work_state = 'idle') = (work_task_ref IS NULL))
);
CREATE INDEX device_enrollment_organisation
  ON device_enrollment (organisation_id, state, gateway_id);
CREATE TABLE device_event (
  event_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('person', 'agent', 'gateway', 'platform')),
  actor_id TEXT,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  idempotency_key TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);
CREATE INDEX device_event_subject
  ON device_event (organisation_id, subject_id, created_at);
CREATE UNIQUE INDEX device_event_idempotency
  ON device_event (organisation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE device_alert (
  alert_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('gateway_offline', 'task_connection_lost', 'task_device_fault', 'task_result_unknown')),
  text TEXT NOT NULL,
  closed_text TEXT,
  opened_at INTEGER NOT NULL CHECK (opened_at >= 0),
  closed_at INTEGER,
  notice_delivered_at INTEGER,
  update_delivered_at INTEGER
);
CREATE UNIQUE INDEX device_alert_one_open
  ON device_alert (organisation_id, subject_id, kind)
  WHERE closed_at IS NULL;
CREATE INDEX device_alert_undelivered
  ON device_alert (organisation_id, notice_delivered_at, update_delivered_at);
CREATE TABLE device_alert_setting (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  time_zone TEXT NOT NULL,
  opens_at_minute INTEGER NOT NULL CHECK (opens_at_minute BETWEEN 0 AND 1439),
  closes_at_minute INTEGER NOT NULL CHECK (closes_at_minute BETWEEN 0 AND 1439),
  offline_delay_minutes INTEGER NOT NULL CHECK (offline_delay_minutes BETWEEN 1 AND 120),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);
CREATE TABLE device_camera_policy (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  changed_by TEXT,
  changed_at INTEGER NOT NULL CHECK (changed_at >= 0)
);
CREATE TABLE device_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  device_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('fault', 'request')),
  requested_by TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'stored')),
  object_key TEXT NOT NULL,
  content_bytes INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  stored_at INTEGER,
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0)
);
CREATE INDEX device_snapshot_device
  ON device_snapshot (organisation_id, device_id, state, stored_at);
CREATE INDEX device_snapshot_expiry
  ON device_snapshot (organisation_id, expires_at);
CREATE TABLE voice_mac (
  mac_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  name_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'enrolled', 'revoked')),
  code_sha256 TEXT,
  code_expires_at INTEGER,
  credential_sha256 TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  enrolled_at INTEGER,
  revoked_at INTEGER,
  revoked_by_user_id TEXT,
  last_heartbeat_at INTEGER,
  private_address TEXT,
  service_version TEXT,
  model_state TEXT CHECK (model_state IN ('none', 'downloading', 'unloaded', 'loading', 'loaded')),
  engine TEXT,
  engines TEXT,
  engine_choice TEXT
);
CREATE INDEX voice_mac_organisation
  ON voice_mac (organisation_id, state, last_heartbeat_at);
CREATE TABLE voice_transcription_use (
  use_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at INTEGER,
  audio_milliseconds INTEGER CHECK (audio_milliseconds >= 0)
);
CREATE INDEX voice_transcription_use_member
  ON voice_transcription_use (organisation_id, user_id, started_at);
CREATE TABLE voice_confirmation (
  confirmation_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('configuration_draft', 'slack_draft', 'email_draft')),
  target_id TEXT NOT NULL,
  phrase TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'matched', 'spent')),
  refused_attempts INTEGER NOT NULL DEFAULT 0 CHECK (refused_attempts >= 0),
  transcription_path TEXT CHECK (transcription_path IN ('shop_mac', 'workers_ai')),
  transcription_engine TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  matched_at INTEGER,
  CHECK ((state = 'matched') = (matched_at IS NOT NULL)),
  CHECK ((state = 'matched') = (transcription_path IS NOT NULL))
);
CREATE INDEX voice_confirmation_member
  ON voice_confirmation (organisation_id, user_id, conversation_id, state);

CREATE TABLE bakery_workflow (
  organisation_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 128),
  recipe TEXT NOT NULL CHECK (length(recipe) BETWEEN 1 AND 100),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, workflow_id)
);

CREATE TABLE bakery_workflow_revision (
  organisation_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  base_digest TEXT CHECK (base_digest IS NULL OR length(base_digest) = 64),
  scenario_digest TEXT NOT NULL CHECK (length(scenario_digest) = 64),
  applied_by TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  -- An approved proposal: its draft and the agent turn that wrote it.
  proposal_id TEXT,
  session_id TEXT,
  turn_id TEXT,
  operation_id TEXT,
  PRIMARY KEY (organisation_id, workflow_id, revision)
);

CREATE INDEX idx_bakery_workflow_revision_digest
  ON bakery_workflow_revision (organisation_id, workflow_id, digest);

CREATE TABLE bakery_cost_plan (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  daily_labor_minor INTEGER NOT NULL CHECK (daily_labor_minor >= 0),
  daily_rent_minor INTEGER NOT NULL CHECK (daily_rent_minor >= 0),
  forecast_json TEXT,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE TABLE bakery_cost_product_plan (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  product_id TEXT NOT NULL CHECK (length(product_id) BETWEEN 1 AND 160),
  mon_units INTEGER NOT NULL CHECK (mon_units >= 0),
  tue_units INTEGER NOT NULL CHECK (tue_units >= 0),
  wed_units INTEGER NOT NULL CHECK (wed_units >= 0),
  thu_units INTEGER NOT NULL CHECK (thu_units >= 0),
  fri_units INTEGER NOT NULL CHECK (fri_units >= 0),
  sat_units INTEGER NOT NULL CHECK (sat_units >= 0),
  sun_units INTEGER NOT NULL CHECK (sun_units >= 0),
  spoil_bps INTEGER CHECK (spoil_bps IS NULL OR (spoil_bps >= 0 AND spoil_bps <= 9500)),
  cogs_override_minor INTEGER CHECK (cogs_override_minor IS NULL OR cogs_override_minor >= 0),
  waste_override_minor INTEGER CHECK (waste_override_minor IS NULL OR waste_override_minor >= 0),
  formulas_json TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, product_id)
);

CREATE TABLE bakery_lot_invoice_cost (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  lot_id TEXT NOT NULL CHECK (length(lot_id) BETWEEN 1 AND 160),
  inventory_item_id TEXT NOT NULL CHECK (length(inventory_item_id) BETWEEN 1 AND 160),
  revision INTEGER NOT NULL CHECK (revision > 0),
  invoice_reference TEXT NOT NULL CHECK (length(invoice_reference) BETWEEN 1 AND 120),
  supplier_id TEXT CHECK (supplier_id IS NULL OR length(supplier_id) <= 128),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  invoiced_quantity REAL NOT NULL CHECK (invoiced_quantity > 0),
  invoiced_unit TEXT NOT NULL CHECK (invoiced_unit IN ('each', 'gram', 'kilogram', 'milliliter', 'liter')),
  invoice_total_minor INTEGER NOT NULL CHECK (invoice_total_minor >= 0),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, lot_id)
);
CREATE INDEX idx_bakery_lot_invoice_cost_item
  ON bakery_lot_invoice_cost (organisation_id, inventory_item_id);

-- Plan 24 S1: the counter stock level of each fresh product, for the whole
-- day. An admin sets it. A fall of the counter stock below it opens a bake
-- proposal. The level names the recipe workflow of the bake and the Devices
-- location of the kitchen that bakes it.
CREATE TABLE bake_stock_level (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  inventory_item_id TEXT NOT NULL CHECK (length(inventory_item_id) BETWEEN 1 AND 255),
  product_name TEXT NOT NULL CHECK (length(product_name) BETWEEN 1 AND 120),
  level_pieces INTEGER NOT NULL CHECK (level_pieces BETWEEN 1 AND 10000),
  pieces_per_group INTEGER NOT NULL CHECK (pieces_per_group BETWEEN 1 AND 1000),
  workflow_id TEXT NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 128),
  kitchen_location TEXT NOT NULL CHECK (length(kitchen_location) BETWEEN 1 AND 64),
  revision INTEGER NOT NULL CHECK (revision > 0),
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL CHECK (set_at >= 0),
  PRIMARY KEY (organisation_id, inventory_item_id)
);

-- Plan 24 S5: the authority of the bake runs at one kitchen location. A
-- location with no row is in shadow mode: an approved proposal starts a run
-- that only watches the cobots and sends nothing. An admin sets approval mode
-- on the Bakes page; then an approval dispatches the run's tasks.
CREATE TABLE bake_authority (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  kitchen_location TEXT NOT NULL CHECK (length(kitchen_location) BETWEEN 1 AND 64),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'approval')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL CHECK (set_at >= 0),
  PRIMARY KEY (organisation_id, kitchen_location)
);

-- Plan 24 S1: one proposed bake run of one product. A product has at most one
-- active proposal (open or approved) and at most one that waits for it; the
-- two partial unique indexes hold that rule. An approved proposal ends when
-- its bake run ends (Plan 24 S4).
CREATE TABLE bake_proposal (
  proposal_id TEXT PRIMARY KEY CHECK (length(proposal_id) BETWEEN 1 AND 64),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  inventory_item_id TEXT NOT NULL CHECK (length(inventory_item_id) BETWEEN 1 AND 255),
  product_name TEXT NOT NULL CHECK (length(product_name) BETWEEN 1 AND 120),
  state TEXT NOT NULL CHECK (state IN ('waiting', 'open', 'approved', 'rejected', 'ended')),
  origin TEXT NOT NULL CHECK (origin IN ('stock', 'agent')),
  case_id TEXT NOT NULL CHECK (length(case_id) BETWEEN 1 AND 128),
  workflow_id TEXT NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 128),
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision > 0),
  workflow_digest TEXT NOT NULL CHECK (length(workflow_digest) = 64),
  quantity_pieces INTEGER NOT NULL CHECK (quantity_pieces > 0),
  mould_groups INTEGER NOT NULL CHECK (mould_groups > 0),
  pieces_per_group INTEGER NOT NULL CHECK (pieces_per_group > 0),
  kitchen_location TEXT NOT NULL CHECK (length(kitchen_location) BETWEEN 1 AND 64),
  oven_device_id TEXT,
  oven_name TEXT,
  stock_location_id TEXT,
  stock_available INTEGER NOT NULL CHECK (stock_available >= 0),
  stock_level INTEGER NOT NULL CHECK (stock_level > 0),
  proposed_by TEXT NOT NULL CHECK (length(proposed_by) BETWEEN 1 AND 128),
  proposed_at INTEGER NOT NULL CHECK (proposed_at >= 0),
  opened_at INTEGER,
  announced_at INTEGER,
  card_ts TEXT CHECK (card_ts IS NULL OR length(card_ts) BETWEEN 1 AND 32),
  decided_by TEXT,
  decided_role TEXT CHECK (decided_role IS NULL OR decided_role IN ('owner', 'admin', 'operator')),
  decided_via TEXT CHECK (decided_via IS NULL OR decided_via IN ('portal', 'slack')),
  decided_at INTEGER,
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  ended_at INTEGER,
  end_reason TEXT CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 200),
  CHECK ((oven_device_id IS NULL) = (oven_name IS NULL)),
  CHECK ((state = 'waiting') = (opened_at IS NULL)),
  CHECK ((state IN ('approved', 'rejected', 'ended')) = (decided_at IS NOT NULL)),
  CHECK ((state = 'rejected') = (reason IS NOT NULL)),
  CHECK ((state = 'ended') = (ended_at IS NOT NULL)),
  CHECK (decided_at IS NULL OR (decided_by IS NOT NULL AND decided_role IS NOT NULL AND decided_via IS NOT NULL))
);
CREATE UNIQUE INDEX bake_proposal_one_active
  ON bake_proposal (organisation_id, inventory_item_id)
  WHERE state IN ('open', 'approved');
CREATE UNIQUE INDEX bake_proposal_one_waiting
  ON bake_proposal (organisation_id, inventory_item_id)
  WHERE state = 'waiting';
CREATE INDEX bake_proposal_recent
  ON bake_proposal (organisation_id, proposed_at DESC);
-- Plan 24 S4: the one bake run of an approved proposal. The run's Durable
-- Object (actor_id) holds its engine state and its dispatch records; this row
-- is the summary that the Bakes page lists, the reason that a run did not
-- start, and the person's check of the released pieces that raised the
-- counter stock through Commerce.
CREATE TABLE bake_run (
  run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 64),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  proposal_id TEXT NOT NULL REFERENCES bake_proposal (proposal_id),
  actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 128),
  mode TEXT NOT NULL DEFAULT 'approval' CHECK (mode IN ('shadow', 'approval')),
  state TEXT NOT NULL CHECK (state IN ('not_started', 'running', 'paused', 'held', 'completed', 'stopped', 'checked')),
  problem_code TEXT CHECK (problem_code IS NULL OR length(problem_code) BETWEEN 1 AND 64),
  problem_text TEXT CHECK (problem_text IS NULL OR length(problem_text) BETWEEN 1 AND 500),
  hold_code TEXT CHECK (hold_code IS NULL OR length(hold_code) BETWEEN 1 AND 64),
  started_at INTEGER,
  ended_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  checked_by TEXT,
  checked_role TEXT CHECK (checked_role IS NULL OR checked_role IN ('owner', 'admin', 'operator')),
  checked_at INTEGER,
  good_pieces INTEGER CHECK (good_pieces IS NULL OR good_pieces BETWEEN 0 AND 10000),
  stock_receipt_id TEXT,
  CHECK ((state = 'not_started') = (problem_code IS NOT NULL)),
  CHECK ((state = 'checked') = (checked_at IS NOT NULL)),
  CHECK (checked_at IS NULL OR (checked_by IS NOT NULL AND checked_role IS NOT NULL AND good_pieces IS NOT NULL AND stock_receipt_id IS NOT NULL))
);
CREATE UNIQUE INDEX bake_run_one_per_proposal
  ON bake_run (organisation_id, proposal_id);
