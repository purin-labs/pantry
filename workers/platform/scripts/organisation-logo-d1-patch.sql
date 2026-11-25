-- Regional database patch (Portal round 9). Adds organisation_logo and alters
-- organisation_workspace.
--
-- An owner uploads a logo for the organisation and for each workspace. The
-- bytes are in R2 (ARCHIVE) under organisation-logos/<organisation>/..., and
-- these rows keep only the SHA-256. An organisation or a workspace without a
-- logo shows the gradient tile. The organisation's logo has its own table,
-- because the organisation row is in both databases and a move between cells
-- does not copy it.
--
-- Apply it once to each bound regional database, before the release.
CREATE TABLE organisation_logo (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id) ON DELETE CASCADE,
  logo_sha256 TEXT NOT NULL CHECK (length(logo_sha256) = 64 AND logo_sha256 NOT GLOB '*[^0-9a-f]*'),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

ALTER TABLE organisation_workspace
  ADD COLUMN logo_sha256 TEXT
  CHECK (logo_sha256 IS NULL OR (length(logo_sha256) = 64 AND logo_sha256 NOT GLOB '*[^0-9a-f]*'));
