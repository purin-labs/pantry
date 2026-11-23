-- Plan 85 Phase 5: adds device_camera_policy and device_snapshot, with their
-- indexes. Apply to each deployed regional database, after
-- plan-85-devices-d1-patch.sql and before the release that reads them. The
-- statements are safe to repeat.
CREATE TABLE IF NOT EXISTS device_camera_policy (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  changed_by TEXT,
  changed_at INTEGER NOT NULL CHECK (changed_at >= 0)
);
CREATE TABLE IF NOT EXISTS device_snapshot (
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
CREATE INDEX IF NOT EXISTS device_snapshot_device
  ON device_snapshot (organisation_id, device_id, state, stored_at);
CREATE INDEX IF NOT EXISTS device_snapshot_expiry
  ON device_snapshot (organisation_id, expires_at);
