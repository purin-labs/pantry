-- Regional database patch (Plan 24 S5). Adds table bake_authority and alters
-- table bake_run (new column mode).
--
-- The authority mode of each kitchen location (shadow or approval), and the
-- mode of each bake run. Apply it once to each bound regional database, after
-- plan-24-bake-run-d1-patch.sql and before the release.
CREATE TABLE IF NOT EXISTS bake_authority (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  kitchen_location TEXT NOT NULL CHECK (length(kitchen_location) BETWEEN 1 AND 64),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'approval')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL CHECK (set_at >= 0),
  PRIMARY KEY (organisation_id, kitchen_location)
);
ALTER TABLE bake_run ADD COLUMN mode TEXT NOT NULL DEFAULT 'approval'
  CHECK (mode IN ('shadow', 'approval'));
