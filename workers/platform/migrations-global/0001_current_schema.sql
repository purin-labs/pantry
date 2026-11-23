-- Global identity, ingress directory, placement authority and move journals.
-- Organisation operational data belongs to migrations-regional.
PRAGMA foreign_keys = ON;

CREATE TABLE organisation (
  organisation_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'beta',
  created_at INTEGER NOT NULL
, organisation_handle TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted', 'purged')));
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
CREATE TABLE state_object_relocation (
  relocation_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  source_placement_epoch INTEGER NOT NULL CHECK (source_placement_epoch > 0),
  target_placement_epoch INTEGER NOT NULL CHECK (target_placement_epoch > source_placement_epoch),
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'frozen', 'copying', 'published', 'retained', 'cleaning', 'complete', 'quarantined', 'abandoned')
  ),
  created_at INTEGER NOT NULL,
  frozen_at INTEGER,
  published_at INTEGER,
  resumed_at INTEGER,
  retain_until INTEGER,
  retention_waived_at INTEGER CHECK (retention_waived_at IS NULL OR (retention_waived_at >= resumed_at AND status IN ('retained', 'cleaning', 'complete'))),
  completed_at INTEGER,
  abandoned_at INTEGER,
  recovery_relocation_id TEXT REFERENCES state_object_relocation(relocation_id) DEFERRABLE INITIALLY DEFERRED,
  quarantined_at INTEGER,
  quarantine_reason TEXT,
  UNIQUE (organisation_id, source_placement_epoch, target_placement_epoch),
  FOREIGN KEY (organisation_id, source_placement_epoch)
    REFERENCES organisation_placement (organisation_id, placement_epoch),
  FOREIGN KEY (organisation_id, target_placement_epoch)
    REFERENCES organisation_placement (organisation_id, placement_epoch),
  CHECK ((status = 'abandoned') = (abandoned_at IS NOT NULL AND recovery_relocation_id IS NOT NULL)),
  CHECK (status = 'abandoned' OR (abandoned_at IS NULL AND recovery_relocation_id IS NULL)),
  CHECK (
    (status = 'abandoned' AND frozen_at IS NOT NULL AND published_at IS NULL AND resumed_at IS NULL AND retain_until IS NULL AND completed_at IS NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (status = 'reserved' AND resumed_at IS NULL AND retain_until IS NULL AND frozen_at IS NULL AND published_at IS NULL AND
      completed_at IS NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (status IN ('frozen', 'copying') AND resumed_at IS NULL AND retain_until IS NULL AND frozen_at IS NOT NULL AND published_at IS NULL AND
      completed_at IS NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (status = 'published' AND resumed_at IS NULL AND retain_until IS NULL AND frozen_at IS NOT NULL AND published_at IS NOT NULL AND
      completed_at IS NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (status IN ('retained', 'cleaning') AND frozen_at IS NOT NULL AND published_at IS NOT NULL AND
      resumed_at IS NOT NULL AND retain_until >= resumed_at + 604800000 AND completed_at IS NULL AND
      quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (status = 'complete' AND resumed_at IS NOT NULL AND retain_until >= resumed_at + 604800000 AND frozen_at IS NOT NULL AND published_at IS NOT NULL AND
      completed_at IS NOT NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (status = 'quarantined' AND resumed_at IS NULL AND retain_until IS NULL AND completed_at IS NULL AND quarantined_at IS NOT NULL AND
      quarantine_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_state_object_relocation_open_organisation
  ON state_object_relocation (organisation_id)
  WHERE status IN ('reserved', 'frozen', 'copying', 'published');
CREATE TABLE state_object_restore (
  restore_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  local_source_placement_epoch INTEGER NOT NULL CHECK (local_source_placement_epoch > 0),
  target_placement_epoch INTEGER NOT NULL CHECK (
    target_placement_epoch > local_source_placement_epoch
  ),
  manifest_digest_b64 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'frozen', 'importing', 'published', 'complete', 'quarantined', 'abandoned')
  ),
  created_at INTEGER NOT NULL,
  frozen_at INTEGER,
  published_at INTEGER,
  completed_at INTEGER,
  quarantined_at INTEGER,
  quarantine_reason TEXT,
  abandoned_at INTEGER,
  recovery_relocation_id TEXT REFERENCES state_object_relocation(relocation_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (organisation_id, local_source_placement_epoch, target_placement_epoch),
  FOREIGN KEY (organisation_id, local_source_placement_epoch)
    REFERENCES organisation_placement (organisation_id, placement_epoch),
  FOREIGN KEY (organisation_id, target_placement_epoch)
    REFERENCES organisation_placement (organisation_id, placement_epoch),
  CHECK ((status = 'abandoned') = (abandoned_at IS NOT NULL AND recovery_relocation_id IS NOT NULL)),
  CHECK (status = 'abandoned' OR (abandoned_at IS NULL AND recovery_relocation_id IS NULL)),
  CHECK (
    (status = 'abandoned' AND frozen_at IS NOT NULL AND published_at IS NULL AND
      completed_at IS NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (status = 'reserved' AND frozen_at IS NULL AND published_at IS NULL AND
      completed_at IS NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (status IN ('frozen', 'importing') AND frozen_at IS NOT NULL AND published_at IS NULL AND
      completed_at IS NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (status = 'published' AND frozen_at IS NOT NULL AND published_at IS NOT NULL AND
      completed_at IS NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (status = 'complete' AND frozen_at IS NOT NULL AND published_at IS NOT NULL AND
      completed_at IS NOT NULL AND quarantined_at IS NULL AND quarantine_reason IS NULL) OR
    (status = 'quarantined' AND completed_at IS NULL AND quarantined_at IS NOT NULL AND
      quarantine_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_state_object_restore_open_organisation
  ON state_object_restore (organisation_id)
  WHERE status IN ('reserved', 'frozen', 'importing', 'published');
CREATE TABLE state_object_restore_item (
  restore_id TEXT NOT NULL REFERENCES state_object_restore (restore_id),
  object_kind TEXT NOT NULL,
  logical_object_id TEXT NOT NULL,
  source_schema_version INTEGER NOT NULL CHECK (source_schema_version > 0),
  source_state_version INTEGER NOT NULL CHECK (source_state_version > 0),
  export_id TEXT NOT NULL,
  export_key TEXT NOT NULL,
  export_organisation_id TEXT NOT NULL,
  export_payload_digest_b64 TEXT NOT NULL,
  export_created_at INTEGER NOT NULL,
  table_count INTEGER NOT NULL CHECK (table_count >= 0),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  kv_entry_count INTEGER NOT NULL CHECK (kv_entry_count >= 0),
  r2_object_count INTEGER NOT NULL CHECK (r2_object_count >= 0),
  r2_bytes INTEGER NOT NULL CHECK (r2_bytes >= 0),
  target_registry_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'imported')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (restore_id, object_kind, logical_object_id),
  UNIQUE (restore_id, export_id),
  CHECK (
    (status = 'pending' AND target_registry_id IS NULL) OR
    (status = 'imported' AND target_registry_id IS NOT NULL)
  )
);
CREATE INDEX idx_state_object_restore_item_status
  ON state_object_restore_item (restore_id, status, object_kind);
CREATE TABLE app_user (
  user_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
  created_at INTEGER NOT NULL,
  last_authenticated_at INTEGER NOT NULL,
  UNIQUE (issuer, subject)
);
CREATE UNIQUE INDEX idx_app_user_verified_email
  ON app_user (email)
  WHERE email_verified = 1;
CREATE TABLE control_session (
  control_session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_user (user_id),
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  rotation_generation INTEGER NOT NULL CHECK (rotation_generation > 0),
  created_at INTEGER NOT NULL,
  rotated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX idx_control_session_identity
  ON control_session (user_id, expires_at);
CREATE TABLE control_oidc_state (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'google'),
  pkce_verifier TEXT NOT NULL,
  oidc_nonce_hash TEXT NOT NULL,
  redirect_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE TABLE slack_installation (
  installation_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  app_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  credential_organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  bot_token_ref TEXT NOT NULL,
  install_model TEXT NOT NULL CHECK (install_model IN ('unlisted', 'marketplace', 'custom')),
  scopes_json TEXT NOT NULL CHECK (
    json_valid(scopes_json) AND json_type(scopes_json) = 'array'
  ),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'disabled', 'revoked')),
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  revoked_at INTEGER,
  UNIQUE (environment, app_id, workspace_id),
  CHECK (updated_at >= installed_at),
  CHECK (
    (lifecycle = 'active' AND disabled_at IS NULL AND revoked_at IS NULL) OR
    (lifecycle = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL) OR
    (lifecycle = 'revoked' AND revoked_at IS NOT NULL)
  )
) STRICT;
CREATE TABLE slack_organisation_connection (
  connection_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installation (installation_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'disabled', 'revoked')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  revoked_at INTEGER,
  UNIQUE (installation_id, connection_id),
  UNIQUE (organisation_id, integration_account_id),
  CHECK (updated_at >= connected_at),
  CHECK (
    (lifecycle = 'active' AND disabled_at IS NULL AND revoked_at IS NULL) OR
    (lifecycle = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL) OR
    (lifecycle = 'revoked' AND revoked_at IS NOT NULL)
  )
) STRICT;
CREATE UNIQUE INDEX idx_slack_organisation_connection_current
  ON slack_organisation_connection (installation_id, organisation_id)
  WHERE lifecycle != 'revoked';
CREATE TABLE slack_channel_default (
  installation_id TEXT NOT NULL REFERENCES slack_installation (installation_id),
  channel_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  bound_by_user_id TEXT NOT NULL
    REFERENCES app_user (user_id),
  bound_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, channel_id),
  FOREIGN KEY (installation_id, connection_id)
    REFERENCES slack_organisation_connection (installation_id, connection_id)
) STRICT;
CREATE TABLE slack_channel_default_revision (
  installation_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  connection_id TEXT NOT NULL,
  bound_by_user_id TEXT NOT NULL
    REFERENCES app_user (user_id),
  bound_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, channel_id, revision),
  FOREIGN KEY (installation_id, connection_id)
    REFERENCES slack_organisation_connection (installation_id, connection_id)
) STRICT;
CREATE TABLE slack_routing_audit_event (
  audit_event_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installation (installation_id),
  channel_id TEXT NOT NULL,
  previous_connection_id TEXT,
  next_connection_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  actor_user_id TEXT NOT NULL
    REFERENCES app_user (user_id),
  idempotency_receipt_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (installation_id, next_connection_id)
    REFERENCES slack_organisation_connection (installation_id, connection_id)
) STRICT;
CREATE TABLE slack_installation_audit_event (
  audit_event_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installation (installation_id),
  operation TEXT NOT NULL CHECK (operation = 'installation_wide_disconnect'),
  actor_user_id TEXT NOT NULL
    REFERENCES app_user (user_id),
  idempotency_receipt_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
) STRICT;
CREATE TABLE slack_installation_lifecycle_event (
  event_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installation (installation_id),
  reason TEXT NOT NULL CHECK (reason IN ('app_uninstalled', 'bot_token_revoked')),
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER slack_channel_default_revision_insert
AFTER INSERT ON slack_channel_default
BEGIN
  INSERT INTO slack_channel_default_revision (
    installation_id, channel_id, revision, connection_id,
    bound_by_user_id, bound_at
  ) VALUES (
    NEW.installation_id, NEW.channel_id, NEW.revision, NEW.connection_id,
    NEW.bound_by_user_id, NEW.bound_at
  );
END;
CREATE TRIGGER slack_channel_default_revision_update
AFTER UPDATE ON slack_channel_default
BEGIN
  INSERT INTO slack_channel_default_revision (
    installation_id, channel_id, revision, connection_id,
    bound_by_user_id, bound_at
  ) VALUES (
    NEW.installation_id, NEW.channel_id, NEW.revision, NEW.connection_id,
    NEW.bound_by_user_id, NEW.bound_at
  );
END;
CREATE TABLE slack_dm_organisation_selection (
  installation_id TEXT NOT NULL REFERENCES slack_installation (installation_id),
  external_user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  selected_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, external_user_id),
  FOREIGN KEY (installation_id, connection_id)
    REFERENCES slack_organisation_connection (installation_id, connection_id)
) STRICT;
CREATE TABLE slack_dm_organisation_selection_audit_event (
  audit_event_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installation (installation_id),
  external_user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  actor_user_id TEXT NOT NULL
    REFERENCES app_user (user_id),
  idempotency_receipt_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (installation_id, connection_id)
    REFERENCES slack_organisation_connection (installation_id, connection_id)
) STRICT;
CREATE TABLE slack_thread_case_pin (
  installation_id TEXT NOT NULL REFERENCES slack_installation (installation_id),
  channel_id TEXT NOT NULL,
  root_message_ts TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  routing_source_kind TEXT NOT NULL CHECK (
    routing_source_kind IN ('channel_default', 'dm_selection')
  ),
  routing_source_revision INTEGER NOT NULL CHECK (routing_source_revision > 0),
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, channel_id, root_message_ts),
  FOREIGN KEY (installation_id, connection_id)
    REFERENCES slack_organisation_connection (installation_id, connection_id)
) STRICT;
CREATE TRIGGER slack_installation_identity_immutable
BEFORE UPDATE OF installation_id, environment, app_id, workspace_id,
  installed_at
ON slack_installation
BEGIN
  SELECT RAISE(ABORT, 'slack_installation_identity_immutable');
END;
CREATE TRIGGER slack_organisation_connection_identity_immutable
BEFORE UPDATE OF connection_id, installation_id, organisation_id,
  integration_account_id, connected_at
ON slack_organisation_connection
BEGIN
  SELECT RAISE(ABORT, 'slack_organisation_connection_identity_immutable');
END;
CREATE TRIGGER slack_organisation_connection_revision_advance
BEFORE UPDATE ON slack_organisation_connection
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'slack_organisation_connection_revision_invalid');
END;
CREATE TRIGGER slack_channel_default_revision_advance
BEFORE UPDATE ON slack_channel_default
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'slack_channel_default_revision_invalid');
END;
CREATE TRIGGER slack_thread_case_pin_immutable
BEFORE UPDATE ON slack_thread_case_pin
BEGIN
  SELECT RAISE(ABORT, 'slack_thread_case_pin_immutable');
END;
CREATE TRIGGER slack_dm_organisation_selection_revision_advance
BEFORE UPDATE ON slack_dm_organisation_selection
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'slack_dm_organisation_selection_revision_invalid');
END;
CREATE TABLE control_mutation_receipt (
  receipt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_user (user_id),
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
CREATE TABLE provider_manifest (
  provider TEXT NOT NULL CHECK (
    provider IN (
      'slack', 'shopify', 'stripe', 'airtable', 'notion', 'gmail', 'whatsapp',
      'dropbox', 'google_drive', 'square'
    )
  ),
  manifest_version INTEGER NOT NULL CHECK (manifest_version > 0),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  required_scopes TEXT NOT NULL CHECK (json_valid(required_scopes)),
  optional_scopes TEXT NOT NULL CHECK (json_valid(optional_scopes)),
  webhook_registrations TEXT NOT NULL CHECK (json_valid(webhook_registrations)),
  discovery_capabilities TEXT NOT NULL CHECK (json_valid(discovery_capabilities)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, manifest_version, environment)
);
CREATE TABLE control_support_role (
  user_id TEXT PRIMARY KEY
    REFERENCES app_user (user_id),
  role TEXT NOT NULL CHECK (role IN ('support_agent', 'support_admin')),
  granted_by_user_id TEXT
    REFERENCES app_user (user_id),
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE TABLE vault_root_rotation_job (
  rotation_id TEXT PRIMARY KEY,
  source_key_version TEXT NOT NULL CHECK (source_key_version IN ('v1', 'v2')),
  target_key_version TEXT NOT NULL CHECK (target_key_version IN ('v1', 'v2')),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('pending', 'running', 'paused', 'completed', 'failed')
  ),
  cursor_organisation_id TEXT,
  cursor_vault_handle TEXT,
  source_row_count INTEGER NOT NULL CHECK (source_row_count >= 0),
  processed_count INTEGER NOT NULL CHECK (processed_count >= 0),
  rewrapped_count INTEGER NOT NULL CHECK (rewrapped_count >= 0),
  skipped_count INTEGER NOT NULL CHECK (skipped_count >= 0),
  failure_code TEXT CHECK (
    failure_code IS NULL OR failure_code IN (
      'active_key_version_changed',
      'source_root_unavailable',
      'target_root_unavailable',
      'ciphertext_invalid',
      'verification_failed',
      'persistence_conflict'
    )
  ),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  paused_at INTEGER,
  completed_at INTEGER,
  failed_at INTEGER,
  CHECK (source_key_version != target_key_version),
  CHECK (
    (cursor_organisation_id IS NULL AND cursor_vault_handle IS NULL) OR
    (cursor_organisation_id IS NOT NULL AND cursor_vault_handle IS NOT NULL)
  ),
  CHECK (
    (lifecycle = 'pending' AND started_at IS NULL AND paused_at IS NULL AND
      completed_at IS NULL AND failed_at IS NULL AND failure_code IS NULL) OR
    (lifecycle = 'running' AND started_at IS NOT NULL AND paused_at IS NULL AND
      completed_at IS NULL AND failed_at IS NULL AND failure_code IS NULL) OR
    (lifecycle = 'paused' AND started_at IS NOT NULL AND paused_at IS NOT NULL AND
      completed_at IS NULL AND failed_at IS NULL AND failure_code IS NULL) OR
    (lifecycle = 'completed' AND started_at IS NOT NULL AND paused_at IS NULL AND
      completed_at IS NOT NULL AND failed_at IS NULL AND failure_code IS NULL) OR
    (lifecycle = 'failed' AND started_at IS NOT NULL AND completed_at IS NULL AND
      failed_at IS NOT NULL AND failure_code IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_vault_root_rotation_single_active
  ON vault_root_rotation_job ((1))
  WHERE lifecycle IN ('pending', 'running', 'paused');
CREATE TABLE IF NOT EXISTS "state_object_relocation_item" (
  relocation_id TEXT NOT NULL REFERENCES state_object_relocation (relocation_id),
  object_kind TEXT NOT NULL CHECK (
    object_kind IN ('organisation', 'surface', 'session', 'thread', 'case', 'connector')
  ),
  logical_object_id TEXT NOT NULL,
  source_registry_id TEXT NOT NULL,
  target_registry_id TEXT,
  export_id TEXT NOT NULL,
  export_key TEXT,
  export_organisation_id TEXT,
  export_payload_digest_b64 TEXT,
  export_created_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'exported', 'imported', 'retired')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (relocation_id, object_kind, logical_object_id),
  UNIQUE (relocation_id, source_registry_id),
  CHECK (
    (status = 'pending' AND target_registry_id IS NULL AND export_key IS NULL AND
      export_organisation_id IS NULL AND export_payload_digest_b64 IS NULL AND export_created_at IS NULL) OR
    (status = 'exported' AND target_registry_id IS NULL AND export_key IS NOT NULL AND
      export_organisation_id IS NOT NULL AND export_payload_digest_b64 IS NOT NULL AND
      export_created_at IS NOT NULL) OR
    (status IN ('imported', 'retired') AND target_registry_id IS NOT NULL AND
      export_key IS NOT NULL AND export_organisation_id IS NOT NULL AND
      export_payload_digest_b64 IS NOT NULL AND export_created_at IS NOT NULL)
  )
);
CREATE INDEX idx_state_object_relocation_item_status
  ON state_object_relocation_item (relocation_id, status, object_kind);
-- An operator receipt for each quarantined Actor that a relocation left out.
CREATE TABLE state_object_relocation_exclusion (
  relocation_id TEXT NOT NULL REFERENCES state_object_relocation (relocation_id),
  source_registry_id TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (
    object_kind IN ('organisation', 'surface', 'session', 'thread', 'case', 'connector')
  ),
  logical_object_id TEXT NOT NULL,
  quarantined_at INTEGER NOT NULL,
  quarantine_reason TEXT NOT NULL CHECK (length(quarantine_reason) > 0),
  excluded_at INTEGER NOT NULL,
  PRIMARY KEY (relocation_id, source_registry_id)
);
CREATE UNIQUE INDEX idx_organisation_organisation_handle
ON organisation (organisation_handle COLLATE NOCASE);

CREATE TABLE user_preferences (
  user_id TEXT NOT NULL REFERENCES app_user(user_id),
  area TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  values_json TEXT NOT NULL CHECK (json_valid(values_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, area)
);

-- Shared provider definitions used by regional observations.
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('shopify', 1, 'development', '["read_inventory","read_orders","read_products","read_publications","write_inventory","write_orders"]', '[]', '[{"topic":"orders/create","required":false},{"topic":"orders/updated","required":false},{"topic":"inventory_levels/update","required":true},{"topic":"products/create","required":true},{"topic":"products/update","required":true},{"topic":"products/delete","required":true}]', '["shop_summary"]', 1784390000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('shopify', 1, 'production', '["read_inventory","read_orders","read_products","read_publications","write_inventory","write_orders"]', '[]', '[{"topic":"orders/create","required":false},{"topic":"orders/updated","required":false},{"topic":"inventory_levels/update","required":true},{"topic":"products/create","required":true},{"topic":"products/update","required":true},{"topic":"products/delete","required":true}]', '["shop_summary"]', 1784390000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('slack', 3, 'development', '["app_mentions:read","channels:history","channels:read","chat:write","files:read","groups:history","groups:read","im:history"]', '[]', '[{"kind":"shared_application_event_subscription","required":true}]', '["channels"]', 1788220800000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('slack', 3, 'production', '["app_mentions:read","channels:history","channels:read","chat:write","files:read","groups:history","groups:read","im:history"]', '[]', '[{"kind":"shared_application_event_subscription","required":true}]', '["channels"]', 1788220800000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('stripe', 1, 'development', '["read_write"]', '[]', '[{"kind":"connect_platform_endpoint","mode":"test","required":true}]', '["account_summary"]', 1784390000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('stripe', 1, 'production', '["read_write"]', '[]', '[{"kind":"connect_platform_endpoint","mode":"live","required":true}]', '["account_summary"]', 1784390000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('airtable', 1, 'development', '["data.records:read","schema.bases:read"]', '[]', '[]', '["bases","tables"]', 1784390000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('airtable', 1, 'production', '["data.records:read","schema.bases:read"]', '[]', '[]', '["bases","tables"]', 1784390000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('notion', 1, 'development', '["content.read"]', '[]', '[]', '["pages","databases"]', 1784390000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('notion', 1, 'production', '["content.read"]', '[]', '[]', '["pages","databases"]', 1784390000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('gmail', 1, 'development', '["openid","email","https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.compose"]', '[]', '[]', '["mailbox"]', 1784390000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('gmail', 1, 'production', '["openid","email","https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.compose"]', '[]', '[]', '["mailbox"]', 1784390000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('whatsapp', 1, 'development', '["whatsapp_business_management","whatsapp_business_messaging","business_management"]', '[]', '[{"kind":"shared_application_subscription","required":true}]', '["phone_numbers"]', 1784390000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('whatsapp', 1, 'production', '["whatsapp_business_management","whatsapp_business_messaging","business_management"]', '[]', '[{"kind":"shared_application_subscription","required":true}]', '["phone_numbers"]', 1784390000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('dropbox', 1, 'development', '["account_info.read","files.metadata.read","files.content.read"]', '[]', '[{"kind":"shared_application_webhook","required":true}]', '["folders","files"]', 1788102000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('dropbox', 1, 'production', '["account_info.read","files.metadata.read","files.content.read"]', '[]', '[{"kind":"shared_application_webhook","required":true}]', '["folders","files"]', 1788102000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('google_drive', 1, 'development', '["https://www.googleapis.com/auth/drive.file"]', '[]', '[]', '["picker_files"]', 1788102000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('google_drive', 1, 'production', '["https://www.googleapis.com/auth/drive.file"]', '[]', '[]', '["picker_files"]', 1788102000000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('square', 1, 'development', '["DEVICE_CREDENTIAL_MANAGEMENT","DEVICES_READ","MERCHANT_PROFILE_READ","PAYMENTS_READ","PAYMENTS_WRITE","PAYOUTS_READ"]', '[]', '[{"kind":"account_terminal_events","required":true}]', '["payment_locations","terminal_devices"]', 1788796800000);
INSERT INTO provider_manifest (provider, manifest_version, environment, required_scopes, optional_scopes, webhook_registrations, discovery_capabilities, created_at) VALUES ('square', 1, 'production', '["DEVICE_CREDENTIAL_MANAGEMENT","DEVICES_READ","MERCHANT_PROFILE_READ","PAYMENTS_READ","PAYMENTS_WRITE","PAYOUTS_READ"]', '[]', '[{"kind":"account_terminal_events","required":true}]', '["payment_locations","terminal_devices"]', 1788796800000);

CREATE TABLE onboarding_support_access_audit (
  support_access_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  support_role TEXT NOT NULL CHECK (
    support_role IN ('support_agent', 'support_admin')
  ),
  lookup_kind TEXT NOT NULL CHECK (
    lookup_kind IN (
      'support_reference', 'organisation_id', 'provider_account', 'correlation_id'
    )
  ),
  lookup_value_hash TEXT NOT NULL,
  organisation_id TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX idx_onboarding_support_access_actor_time
  ON onboarding_support_access_audit (user_id, occurred_at DESC);

CREATE TABLE state_object_relocation_copy (
  relocation_id TEXT NOT NULL REFERENCES state_object_relocation(relocation_id),
  table_name TEXT NOT NULL,
  cursor_json TEXT NOT NULL CHECK (json_valid(cursor_json)),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  content_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('copying', 'verified')),
  verified_at INTEGER,
  PRIMARY KEY (relocation_id, table_name),
  CHECK ((status = 'copying' AND verified_at IS NULL) OR (status = 'verified' AND verified_at IS NOT NULL))
);

ALTER TABLE state_object_relocation ADD COLUMN source_quiesced_at INTEGER;
ALTER TABLE state_object_relocation ADD COLUMN data_verified_at INTEGER;
ALTER TABLE state_object_relocation ADD COLUMN data_table_count INTEGER CHECK (data_table_count >= 0);

ALTER TABLE state_object_relocation_item ADD COLUMN source_cleaned_at INTEGER;

ALTER TABLE state_object_relocation ADD COLUMN preflight_at INTEGER;
ALTER TABLE state_object_relocation ADD COLUMN preflight_row_count INTEGER;
ALTER TABLE state_object_relocation ADD COLUMN preflight_table_count INTEGER;
ALTER TABLE state_object_relocation ADD COLUMN preflight_actor_bytes INTEGER;
ALTER TABLE state_object_relocation ADD COLUMN preflight_actor_count INTEGER;

-- A screen that waits to be paired (Plan 40B). The screen shows the code; a
-- member enters it in the Portal, which pairs the screen with a board of the
-- member's Organisation and leaves the screen's token here until the screen
-- collects it with its secret. Rows live at most ten minutes.
CREATE TABLE screen_pairing (
  pairing_id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (length(code) = 6),
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  organisation_id TEXT,
  screen_token TEXT,
  claimed_at INTEGER,
  client_key TEXT NOT NULL DEFAULT '',
  CHECK ((organisation_id IS NULL) = (screen_token IS NULL)),
  CHECK ((organisation_id IS NULL) = (claimed_at IS NULL))
);
CREATE INDEX screen_pairing_expiry ON screen_pairing(expires_at);
CREATE INDEX screen_pairing_client ON screen_pairing(client_key);
