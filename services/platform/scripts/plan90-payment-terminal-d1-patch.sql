-- Plan 90 Phase 4A: allow 'payment_terminal' in device_enrollment.device_kind.
-- Apply to each regional D1 database before deploying Plan 90 Phase 4A.
PRAGMA foreign_keys = OFF;

ALTER TABLE device_enrollment RENAME TO device_enrollment_plan90_old;
DROP INDEX IF EXISTS device_enrollment_organisation;

CREATE TABLE device_enrollment (
  device_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  gateway_id TEXT NOT NULL REFERENCES device_gateway (gateway_id),
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 120),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  device_kind TEXT NOT NULL CHECK (device_kind IN ('cobot', 'appliance', 'servo', 'relay', 'camera', 'payment_terminal', 'other')),
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

INSERT INTO device_enrollment SELECT * FROM device_enrollment_plan90_old;
DROP TABLE device_enrollment_plan90_old;

CREATE INDEX device_enrollment_organisation
  ON device_enrollment (organisation_id, state, gateway_id);

ALTER TABLE cafe_terminal_assignment RENAME TO cafe_terminal_assignment_plan90_old;
DROP INDEX IF EXISTS idx_cafe_terminal_assignment_active_location;

CREATE TABLE cafe_terminal_assignment (
  organisation_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL CHECK (length(assignment_id) BETWEEN 1 AND 255),
  merchant_id TEXT NOT NULL CHECK (length(merchant_id) BETWEEN 1 AND 255),
  satyr_location_id TEXT NOT NULL CHECK (length(satyr_location_id) BETWEEN 1 AND 255),
  provider_location_id TEXT NOT NULL CHECK (length(provider_location_id) BETWEEN 1 AND 255),
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 255),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('sandbox_simulated', 'paired_physical', 'lan_gateway_device')),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  assignment_json TEXT NOT NULL CHECK (json_valid(assignment_json)),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  PRIMARY KEY (organisation_id, assignment_id, revision),
  CHECK (
    (target_kind = 'sandbox_simulated' AND environment = 'development') OR
    (target_kind = 'paired_physical' AND environment = 'production') OR
    (target_kind = 'lan_gateway_device')
  )
);

INSERT INTO cafe_terminal_assignment SELECT * FROM cafe_terminal_assignment_plan90_old;
DROP TABLE cafe_terminal_assignment_plan90_old;

CREATE UNIQUE INDEX idx_cafe_terminal_assignment_active_location
  ON cafe_terminal_assignment (organisation_id, satyr_location_id)
  WHERE state = 'active';

PRAGMA foreign_keys = ON;
