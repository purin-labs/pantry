-- Plan 90 Phase 3B: allow the 'square_pos_app' target in
-- cafe_terminal_assignment.target_kind (the Square Point of Sale app on the
-- counter iPad, production only). Apply to each regional D1 database before
-- the Platform release that carries Phase 3B.
--
-- Table: cafe_terminal_assignment (rebuilt: target_kind CHECK and the
-- environment CHECK).
-- Index: idx_cafe_terminal_assignment_active_location (dropped with the old
-- table and created again).
-- No table references cafe_terminal_assignment, and it references none, so
-- the rebuild moves no foreign key.

ALTER TABLE cafe_terminal_assignment RENAME TO cafe_terminal_assignment_plan90b_old;
DROP INDEX IF EXISTS idx_cafe_terminal_assignment_active_location;

CREATE TABLE cafe_terminal_assignment (
  organisation_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL CHECK (length(assignment_id) BETWEEN 1 AND 255),
  merchant_id TEXT NOT NULL CHECK (length(merchant_id) BETWEEN 1 AND 255),
  satyr_location_id TEXT NOT NULL CHECK (length(satyr_location_id) BETWEEN 1 AND 255),
  provider_location_id TEXT NOT NULL CHECK (length(provider_location_id) BETWEEN 1 AND 255),
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 255),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('sandbox_simulated', 'paired_physical', 'lan_gateway_device', 'square_pos_app')),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  assignment_json TEXT NOT NULL CHECK (json_valid(assignment_json)),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  PRIMARY KEY (organisation_id, assignment_id, revision),
  CHECK (
    (target_kind = 'sandbox_simulated' AND environment = 'development') OR
    (target_kind IN ('paired_physical', 'square_pos_app') AND environment = 'production') OR
    (target_kind = 'lan_gateway_device')
  )
);

INSERT INTO cafe_terminal_assignment SELECT * FROM cafe_terminal_assignment_plan90b_old;
DROP TABLE cafe_terminal_assignment_plan90b_old;

CREATE UNIQUE INDEX idx_cafe_terminal_assignment_active_location
  ON cafe_terminal_assignment (organisation_id, satyr_location_id)
  WHERE state = 'active';
