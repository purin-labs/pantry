-- Plan 90 Phase 5: allow 'receipt_printer' in device_enrollment.device_kind,
-- and add cafe_counter_receipt_setting.
-- Apply to each regional D1 database before deploying Plan 90 Phase 5.
PRAGMA foreign_keys = OFF;

ALTER TABLE device_enrollment RENAME TO device_enrollment_plan90_printer_old;
DROP INDEX IF EXISTS device_enrollment_organisation;

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

INSERT INTO device_enrollment SELECT * FROM device_enrollment_plan90_printer_old;
DROP TABLE device_enrollment_plan90_printer_old;

CREATE INDEX device_enrollment_organisation
  ON device_enrollment (organisation_id, state, gateway_id);

CREATE TABLE IF NOT EXISTS cafe_counter_receipt_setting (
  organisation_id TEXT NOT NULL,
  satyr_location_id TEXT NOT NULL CHECK (length(satyr_location_id) BETWEEN 1 AND 255),
  invoice_registration_number TEXT CHECK (
    invoice_registration_number IS NULL OR (
      length(invoice_registration_number) = 14 AND
      substr(invoice_registration_number, 1, 1) = 'T' AND
      substr(invoice_registration_number, 2) NOT GLOB '*[^0-9]*'
    )
  ),
  updated_by_user_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, satyr_location_id)
);

PRAGMA foreign_keys = ON;
