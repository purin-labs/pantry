-- Plan 85 Phases 2 and 3: adds device_gateway, device_enrollment, device_event,
-- device_alert and device_alert_setting, with their indexes. Apply to each
-- deployed regional database before the release that reads them. The statements
-- are safe to repeat.
CREATE TABLE IF NOT EXISTS device_gateway (
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
CREATE INDEX IF NOT EXISTS device_gateway_organisation
  ON device_gateway (organisation_id, state, location_id);
CREATE TABLE IF NOT EXISTS device_enrollment (
  device_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  gateway_id TEXT NOT NULL REFERENCES device_gateway (gateway_id),
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 120),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  device_kind TEXT NOT NULL CHECK (device_kind IN ('cobot', 'appliance', 'servo', 'relay', 'camera', 'other')),
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
CREATE INDEX IF NOT EXISTS device_enrollment_organisation
  ON device_enrollment (organisation_id, state, gateway_id);
CREATE TABLE IF NOT EXISTS device_event (
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
CREATE INDEX IF NOT EXISTS device_event_subject
  ON device_event (organisation_id, subject_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS device_event_idempotency
  ON device_event (organisation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS device_alert (
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
CREATE UNIQUE INDEX IF NOT EXISTS device_alert_one_open
  ON device_alert (organisation_id, subject_id, kind)
  WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS device_alert_undelivered
  ON device_alert (organisation_id, notice_delivered_at, update_delivered_at);
CREATE TABLE IF NOT EXISTS device_alert_setting (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  time_zone TEXT NOT NULL,
  opens_at_minute INTEGER NOT NULL CHECK (opens_at_minute BETWEEN 0 AND 1439),
  closes_at_minute INTEGER NOT NULL CHECK (closes_at_minute BETWEEN 0 AND 1439),
  offline_delay_minutes INTEGER NOT NULL CHECK (offline_delay_minutes BETWEEN 1 AND 120),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);
