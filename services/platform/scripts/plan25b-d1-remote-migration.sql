-- Plan 25B production D1 cutover for the satyr database.
--
-- The production database already contains the squashed baseline schema, but
-- its Wrangler migration ledger is empty. Replaying 0001_current_schema.sql
-- would try to recreate organisation and destroy the cutover. This one-shot patch
-- applies only the Plan 25B delta and migrates the surviving Slack ownership
-- records. Wrangler advances the ledger separately after verification.
--
-- The production Slack app id is public installation identity, not a token.
-- This patch is scoped to the satyr production database and must not be run
-- against another database.

PRAGMA foreign_keys = ON;

-- D1 validates the schema after each DDL statement. These legacy guards
-- reference the table while it is rebuilt, so recreate them around the gap.
DROP TRIGGER external_identity_link_challenge_workspace_guard;
DROP TRIGGER external_identity_link_workspace_guard;

-- Remove the old workspace-wide uniqueness constraint while preserving rows.
CREATE TABLE surface_installation_plan25b (
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
INSERT INTO surface_installation_plan25b (
  integration_account_id, organisation_id, surface_kind, workspace_id,
  install_model, bot_token_ref, scopes, installed_at, last_event_received_at
)
SELECT integration_account_id, organisation_id, surface_kind, workspace_id,
       install_model, bot_token_ref, scopes, installed_at, last_event_received_at
FROM surface_installation;
DROP TABLE surface_installation;
ALTER TABLE surface_installation_plan25b RENAME TO surface_installation;
CREATE INDEX idx_surface_installation_workspace
  ON surface_installation (surface_kind, workspace_id);

CREATE TRIGGER external_identity_link_challenge_workspace_guard
BEFORE INSERT ON external_identity_link_challenge
WHEN NOT EXISTS (
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
)
BEGIN
  SELECT RAISE(ABORT, 'external_identity_link_workspace_mismatch');
END;

CREATE TRIGGER external_identity_link_workspace_guard
BEFORE INSERT ON external_identity_link
WHEN NOT EXISTS (
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
)
BEGIN
  SELECT RAISE(ABORT, 'external_identity_link_workspace_mismatch');
END;

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
  FOREIGN KEY (credential_organisation_id, bot_token_ref)
    REFERENCES vault_secret (organisation_id, vault_handle),
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
  UNIQUE (installation_id, organisation_id),
  UNIQUE (installation_id, connection_id),
  UNIQUE (organisation_id, integration_account_id),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id),
  CHECK (updated_at >= connected_at),
  CHECK (
    (lifecycle = 'active' AND disabled_at IS NULL AND revoked_at IS NULL) OR
    (lifecycle = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL) OR
    (lifecycle = 'revoked' AND revoked_at IS NOT NULL)
  )
) STRICT;

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
    REFERENCES slack_organisation_connection (installation_id, connection_id),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id)
) STRICT;

CREATE TRIGGER slack_installation_identity_immutable
BEFORE UPDATE OF installation_id, environment, app_id, workspace_id,
  credential_organisation_id, installed_at
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

-- Active physical installations retain their existing vault handle.
INSERT INTO slack_installation (
  installation_id, environment, app_id, workspace_id,
  credential_organisation_id, bot_token_ref, install_model, scopes_json,
  lifecycle, installed_at, updated_at, disabled_at, revoked_at
)
SELECT 'slack_installation_' || surface.workspace_id,
       account.environment,
       'A0BFVDZLFLM',
       surface.workspace_id,
       surface.organisation_id,
       surface.bot_token_ref,
       surface.install_model,
       surface.scopes,
       'active',
       surface.installed_at,
       surface.installed_at,
       NULL,
       NULL
FROM surface_installation AS surface
JOIN integration_account AS account
  ON account.integration_account_id = surface.integration_account_id
 AND account.organisation_id = surface.organisation_id
 AND account.provider = 'slack'
 AND account.lifecycle = 'active'
WHERE surface.surface_kind = 'slack';

-- Preserve a historical revoked physical installation when no current row
-- remains, so old Cases retain a disabled ownership boundary.
WITH case_workspaces AS (
  SELECT DISTINCT
    organisation_id,
    substr(
      substr(logical_object_id, 12),
      1,
      instr(substr(logical_object_id, 12), '_') - 1
    ) AS workspace_id
  FROM durable_object_registry
  WHERE object_kind = 'case'
    AND lifecycle_status <> 'reserved'
    AND logical_object_id LIKE 'case_slack_%'
)
INSERT INTO slack_installation (
  installation_id, environment, app_id, workspace_id,
  credential_organisation_id, bot_token_ref, install_model, scopes_json,
  lifecycle, installed_at, updated_at, disabled_at, revoked_at
)
SELECT 'slack_installation_' || cases.workspace_id,
       account.environment,
       'A0BFVDZLFLM',
       cases.workspace_id,
       secret.organisation_id,
       secret.vault_handle,
       'unlisted',
       '[]',
       'revoked',
       secret.created_at,
       COALESCE(account.revoked_at, secret.revoked_at, account.updated_at),
       NULL,
       COALESCE(account.revoked_at, secret.revoked_at, account.updated_at)
FROM case_workspaces AS cases
JOIN integration_account AS account
  ON account.organisation_id = cases.organisation_id
 AND account.provider = 'slack'
 AND account.lifecycle = 'revoked'
JOIN vault_secret AS secret
  ON secret.organisation_id = account.organisation_id
 AND substr(
       lower(secret.vault_handle),
       1,
       length(
         'vault:' || lower(account.organisation_id) || ':slack:' ||
         lower(cases.workspace_id) || ':'
       )
     ) =
       'vault:' || lower(account.organisation_id) || ':slack:' ||
       lower(cases.workspace_id) || ':'
 AND secret.revoked_at IS NOT NULL
WHERE NOT EXISTS (
  SELECT 1
  FROM surface_installation AS current_surface
  WHERE current_surface.surface_kind = 'slack'
    AND current_surface.workspace_id = cases.workspace_id
)
  AND NOT EXISTS (
    SELECT 1
    FROM vault_secret AS newer_secret
    WHERE newer_secret.organisation_id = secret.organisation_id
      AND substr(
            lower(newer_secret.vault_handle),
            1,
            length(
              'vault:' || lower(account.organisation_id) || ':slack:' ||
              lower(cases.workspace_id) || ':'
            )
          ) =
            'vault:' || lower(account.organisation_id) || ':slack:' ||
            lower(cases.workspace_id) || ':'
      AND newer_secret.created_at > secret.created_at
  );

-- Every current organisation connection maps to the old account identity.
INSERT INTO slack_organisation_connection (
  connection_id, installation_id, organisation_id, integration_account_id,
  lifecycle, revision, connected_at, updated_at, disabled_at, revoked_at
)
SELECT 'slack_connection_' || surface.integration_account_id,
       installation.installation_id,
       surface.organisation_id,
       surface.integration_account_id,
       'active',
       1,
       surface.installed_at,
       surface.installed_at,
       NULL,
       NULL
FROM surface_installation AS surface
JOIN integration_account AS account
  ON account.integration_account_id = surface.integration_account_id
 AND account.organisation_id = surface.organisation_id
 AND account.provider = 'slack'
 AND account.lifecycle = 'active'
JOIN slack_installation AS installation
  ON installation.workspace_id = surface.workspace_id
 AND installation.environment = account.environment
 AND installation.app_id = 'A0BFVDZLFLM';

-- Revoked accounts that still own historical Cases remain represented as
-- revoked organisation connections under their physical installation.
WITH case_workspaces AS (
  SELECT DISTINCT
    organisation_id,
    substr(
      substr(logical_object_id, 12),
      1,
      instr(substr(logical_object_id, 12), '_') - 1
    ) AS workspace_id
  FROM durable_object_registry
  WHERE object_kind = 'case'
    AND lifecycle_status <> 'reserved'
    AND logical_object_id LIKE 'case_slack_%'
)
INSERT INTO slack_organisation_connection (
  connection_id, installation_id, organisation_id, integration_account_id,
  lifecycle, revision, connected_at, updated_at, disabled_at, revoked_at
)
SELECT 'slack_connection_' || account.integration_account_id,
       installation.installation_id,
       account.organisation_id,
       account.integration_account_id,
       'revoked',
       1,
       account.created_at,
       COALESCE(account.revoked_at, account.updated_at),
       NULL,
       COALESCE(account.revoked_at, account.updated_at)
FROM integration_account AS account
JOIN case_workspaces AS cases
  ON cases.organisation_id = account.organisation_id
JOIN slack_installation AS installation
  ON installation.workspace_id = cases.workspace_id
 AND installation.environment = account.environment
 AND installation.app_id = 'A0BFVDZLFLM'
WHERE account.provider = 'slack'
  AND account.lifecycle = 'revoked';

-- Preserve the previous organisation as revision 1 when a channel changed
-- owners before this cutover. The current owner is inserted at revision 2.
WITH case_routes AS (
  SELECT DISTINCT
    organisation_id,
    substr(
      substr(logical_object_id, 12),
      1,
      instr(substr(logical_object_id, 12), '_') - 1
    ) AS workspace_id,
    substr(
      substr(logical_object_id, instr(substr(logical_object_id, 12), '_') + 12),
      1,
      instr(substr(logical_object_id, instr(substr(logical_object_id, 12), '_') + 12), '_') - 1
    ) AS channel_id
  FROM durable_object_registry
  WHERE object_kind = 'case'
    AND lifecycle_status <> 'reserved'
    AND logical_object_id LIKE 'case_slack_%'
    AND substr(
      substr(logical_object_id, instr(substr(logical_object_id, 12), '_') + 12),
      1,
      instr(substr(logical_object_id, instr(substr(logical_object_id, 12), '_') + 12), '_') - 1
    ) NOT LIKE 'D%'
)
INSERT INTO slack_channel_default_revision (
  installation_id, channel_id, revision, connection_id,
  bound_by_user_id, bound_at
)
SELECT DISTINCT
  installation.installation_id,
  cases.channel_id,
  1,
  connection.connection_id,
  selection.selected_by_user_id,
  account.created_at
FROM case_routes AS cases
JOIN organisation_slack_channel AS current_channel
  ON current_channel.workspace_id = cases.workspace_id
 AND current_channel.channel_id = cases.channel_id
 AND current_channel.organisation_id != cases.organisation_id
JOIN integration_account AS account
  ON account.integration_account_id = (
       SELECT old_account.integration_account_id
       FROM integration_account AS old_account
       WHERE old_account.organisation_id = cases.organisation_id
         AND old_account.provider = 'slack'
         AND old_account.lifecycle = 'revoked'
       ORDER BY old_account.updated_at DESC
       LIMIT 1
     )
JOIN slack_installation AS installation
  ON installation.workspace_id = cases.workspace_id
 AND installation.environment = account.environment
 AND installation.app_id = 'A0BFVDZLFLM'
JOIN slack_organisation_connection AS connection
  ON connection.installation_id = installation.installation_id
 AND connection.organisation_id = account.organisation_id
 AND connection.integration_account_id = account.integration_account_id
 AND connection.lifecycle = 'revoked'
JOIN organisation_onboarding_selection AS selection
  ON selection.organisation_id = account.organisation_id
WHERE NOT EXISTS (
  SELECT 1
  FROM slack_channel_default_revision AS existing_revision
  WHERE existing_revision.installation_id = installation.installation_id
    AND existing_revision.channel_id = cases.channel_id
    AND existing_revision.revision = 1
);

-- Carry the explicitly configured old channel defaults into the new model.
INSERT INTO slack_channel_default (
  installation_id, channel_id, connection_id, revision,
  bound_by_user_id, bound_at
)
SELECT installation.installation_id,
       current_channel.channel_id,
       connection.connection_id,
       CASE WHEN EXISTS (
         SELECT 1
         FROM slack_channel_default_revision AS previous_revision
         WHERE previous_revision.installation_id = installation.installation_id
           AND previous_revision.channel_id = current_channel.channel_id
           AND previous_revision.connection_id != connection.connection_id
       ) THEN 2 ELSE 1 END,
       selection.selected_by_user_id,
       current_channel.connected_at
FROM organisation_slack_channel AS current_channel
JOIN integration_account AS account
  ON account.integration_account_id = current_channel.integration_account_id
 AND account.organisation_id = current_channel.organisation_id
 AND account.provider = 'slack'
JOIN slack_installation AS installation
  ON installation.workspace_id = current_channel.workspace_id
 AND installation.environment = account.environment
 AND installation.app_id = 'A0BFVDZLFLM'
JOIN slack_organisation_connection AS connection
  ON connection.installation_id = installation.installation_id
 AND connection.organisation_id = current_channel.organisation_id
 AND connection.integration_account_id = current_channel.integration_account_id
 AND connection.lifecycle = 'active'
JOIN organisation_onboarding_selection AS selection
  ON selection.organisation_id = current_channel.organisation_id;

-- A historical configured channel without a surviving legacy row remains
-- pinned to its revoked connection and therefore fails closed.
WITH case_routes AS (
  SELECT DISTINCT
    organisation_id,
    substr(
      substr(logical_object_id, 12),
      1,
      instr(substr(logical_object_id, 12), '_') - 1
    ) AS workspace_id,
    substr(
      substr(logical_object_id, instr(substr(logical_object_id, 12), '_') + 12),
      1,
      instr(substr(logical_object_id, instr(substr(logical_object_id, 12), '_') + 12), '_') - 1
    ) AS channel_id
  FROM durable_object_registry
  WHERE object_kind = 'case'
    AND lifecycle_status <> 'reserved'
    AND logical_object_id LIKE 'case_slack_%'
    AND substr(
      substr(logical_object_id, instr(substr(logical_object_id, 12), '_') + 12),
      1,
      instr(substr(logical_object_id, instr(substr(logical_object_id, 12), '_') + 12), '_') - 1
    ) NOT LIKE 'D%'
)
INSERT INTO slack_channel_default (
  installation_id, channel_id, connection_id, revision,
  bound_by_user_id, bound_at
)
SELECT installation.installation_id,
       cases.channel_id,
       connection.connection_id,
       1,
       selection.selected_by_user_id,
       account.created_at
FROM case_routes AS cases
JOIN integration_account AS account
  ON account.organisation_id = cases.organisation_id
 AND account.provider = 'slack'
 AND account.lifecycle = 'revoked'
JOIN slack_installation AS installation
  ON installation.workspace_id = cases.workspace_id
 AND installation.environment = account.environment
 AND installation.app_id = 'A0BFVDZLFLM'
 AND installation.lifecycle = 'revoked'
JOIN slack_organisation_connection AS connection
  ON connection.installation_id = installation.installation_id
 AND connection.organisation_id = account.organisation_id
 AND connection.integration_account_id = account.integration_account_id
 AND connection.lifecycle = 'revoked'
JOIN organisation_onboarding_selection AS selection
  ON selection.organisation_id = account.organisation_id
WHERE NOT EXISTS (
  SELECT 1
  FROM organisation_slack_channel AS current_channel
  WHERE current_channel.workspace_id = cases.workspace_id
    AND current_channel.channel_id = cases.channel_id
)
  AND NOT EXISTS (
    SELECT 1
    FROM slack_channel_default AS existing_default
    WHERE existing_default.installation_id = installation.installation_id
      AND existing_default.channel_id = cases.channel_id
  );

INSERT INTO slack_installation_lifecycle_event (
  event_id, installation_id, reason, occurred_at, recorded_at
)
SELECT 'slack_lifecycle_migration_' || installation.installation_id,
       installation.installation_id,
       'bot_token_revoked',
       installation.revoked_at,
       installation.revoked_at
FROM slack_installation AS installation
WHERE installation.lifecycle = 'revoked';

INSERT INTO slack_routing_audit_event (
  audit_event_id, installation_id, channel_id,
  previous_connection_id, next_connection_id, revision,
  actor_user_id, idempotency_receipt_id, occurred_at
)
SELECT 'slack_routing_migration_' || current_default.installation_id || ':' ||
         current_default.channel_id,
       current_default.installation_id,
       current_default.channel_id,
       previous_revision.connection_id,
       current_default.connection_id,
       current_default.revision,
       current_default.bound_by_user_id,
       'migration:plan25b:channel:' || current_default.installation_id || ':' ||
         current_default.channel_id,
       current_default.bound_at
FROM slack_channel_default AS current_default
LEFT JOIN slack_channel_default_revision AS previous_revision
  ON previous_revision.installation_id = current_default.installation_id
 AND previous_revision.channel_id = current_default.channel_id
 AND previous_revision.revision = current_default.revision - 1;

-- Backfill every authoritative Case object whose Slack channel can be parsed.
WITH case_records AS (
  SELECT
    organisation_id,
    logical_object_id AS case_id,
    COALESCE(activated_at, reserved_at) AS pinned_at,
    substr(logical_object_id, 12) AS remainder
  FROM durable_object_registry
  WHERE object_kind = 'case'
    AND lifecycle_status <> 'reserved'
    AND logical_object_id LIKE 'case_slack_%'
), workspace_records AS (
  SELECT
    organisation_id,
    case_id,
    pinned_at,
    substr(remainder, 1, instr(remainder, '_') - 1) AS workspace_id,
    substr(remainder, instr(remainder, '_') + 1) AS channel_and_root
  FROM case_records
), parsed_cases AS (
  SELECT
    organisation_id,
    case_id,
    pinned_at,
    workspace_id,
    substr(channel_and_root, 1, instr(channel_and_root, '_') - 1) AS channel_id,
    replace(
      substr(channel_and_root, instr(channel_and_root, '_') + 1),
      '_',
      '.'
    ) AS root_message_ts
  FROM workspace_records
)
INSERT INTO slack_thread_case_pin (
  installation_id, channel_id, root_message_ts, connection_id,
  organisation_id, integration_account_id, case_id,
  routing_source_kind, routing_source_revision, pinned_at
)
SELECT installation.installation_id,
       cases.channel_id,
       cases.root_message_ts,
       connection.connection_id,
       cases.organisation_id,
       connection.integration_account_id,
       cases.case_id,
       'channel_default',
       COALESCE(
         (
           SELECT current_default.revision
           FROM slack_channel_default AS current_default
           WHERE current_default.installation_id = installation.installation_id
             AND current_default.channel_id = cases.channel_id
             AND current_default.connection_id = connection.connection_id
         ),
         (
           SELECT MAX(history.revision)
           FROM slack_channel_default_revision AS history
           WHERE history.installation_id = installation.installation_id
             AND history.channel_id = cases.channel_id
             AND history.connection_id = connection.connection_id
         ),
         1
       ),
       cases.pinned_at
FROM parsed_cases AS cases
JOIN slack_installation AS installation
  ON installation.workspace_id = cases.workspace_id
JOIN slack_organisation_connection AS connection
  ON connection.installation_id = installation.installation_id
 AND connection.organisation_id = cases.organisation_id
WHERE cases.channel_id NOT LIKE 'D%';

-- Fail the transaction if any parsed non-DM Slack Case was left without a
-- pin; accepting a partially migrated ownership map would be unsafe.
CREATE TABLE plan25b_migration_assertion (
  value INTEGER NOT NULL CHECK (value = 0)
);
INSERT INTO plan25b_migration_assertion (value)
SELECT CASE
  WHEN (
    SELECT COUNT(*)
    FROM durable_object_registry
    WHERE object_kind = 'case'
      AND lifecycle_status <> 'reserved'
      AND logical_object_id LIKE 'case_slack_%'
      AND substr(
        substr(logical_object_id, instr(substr(logical_object_id, 12), '_') + 12),
        1,
        instr(substr(logical_object_id, instr(substr(logical_object_id, 12), '_') + 12), '_') - 1
      ) NOT LIKE 'D%'
  ) = (SELECT COUNT(*) FROM slack_thread_case_pin)
  THEN 0
  ELSE 1
END;
DROP TABLE plan25b_migration_assertion;
