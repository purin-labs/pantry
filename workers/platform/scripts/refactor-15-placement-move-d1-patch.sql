-- Refactor 15, refactor 5: one placement move machine for restore and
-- relocation.
--   1. Table state_object_restore gains the terminal status 'abandoned' and
--      the columns abandoned_at and recovery_relocation_id. An abandoned
--      restore names the recovery relocation that gives the Organisation an
--      active placement again. Its index
--      idx_state_object_restore_open_organisation is created again.
--   2. Adds table state_object_relocation_exclusion: the operator receipt of
--      each quarantined Actor that a relocation left out.
-- Apply to the deployed GLOBAL database (and a local combined database)
-- before the release that writes them:
--   wrangler d1 execute <global database> --env production --remote --file workers/platform/scripts/refactor-15-placement-move-d1-patch.sql
-- SQLite cannot change a CHECK in place, so state_object_restore is rebuilt:
-- the new table is created, every row is copied, the old table is dropped and
-- the new one takes its name. Its child state_object_restore_item is rebuilt
-- with it, unchanged, so that no row ever refers to a dropped table; its
-- index idx_state_object_restore_item_status is created again. A remote file
-- runs as one unit. Apply it one time: a second run fails on the first
-- CREATE TABLE and changes nothing.
PRAGMA defer_foreign_keys = true;

CREATE TABLE state_object_restore_next (
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
INSERT INTO state_object_restore_next (
  restore_id, organisation_id, local_source_placement_epoch, target_placement_epoch,
  manifest_digest_b64, manifest_json, status, created_at, frozen_at, published_at,
  completed_at, quarantined_at, quarantine_reason
)
SELECT restore_id, organisation_id, local_source_placement_epoch, target_placement_epoch,
  manifest_digest_b64, manifest_json, status, created_at, frozen_at, published_at,
  completed_at, quarantined_at, quarantine_reason
FROM state_object_restore;
CREATE TABLE state_object_restore_item_next (
  restore_id TEXT NOT NULL REFERENCES state_object_restore_next (restore_id),
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
INSERT INTO state_object_restore_item_next SELECT * FROM state_object_restore_item;
-- The child first, so that the drop of the parent finds no row that refers
-- to it. Each rename rewrites the foreign key that names the renamed table.
DROP TABLE state_object_restore_item;
DROP TABLE state_object_restore;
ALTER TABLE state_object_restore_next RENAME TO state_object_restore;
ALTER TABLE state_object_restore_item_next RENAME TO state_object_restore_item;
CREATE UNIQUE INDEX idx_state_object_restore_open_organisation
  ON state_object_restore (organisation_id)
  WHERE status IN ('reserved', 'frozen', 'importing', 'published');
CREATE INDEX idx_state_object_restore_item_status
  ON state_object_restore_item (restore_id, status, object_kind);

CREATE TABLE IF NOT EXISTS state_object_relocation_exclusion (
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
