-- Plan 79 phase 1: adds the Vault items of the Settings -> Vault page. Apply
-- to each deployed regional database (and a local combined database) before
-- the release that serves the vault item routes. The statements are safe to
-- repeat.
CREATE TABLE IF NOT EXISTS vault_item (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  vault_item_id TEXT NOT NULL CHECK (length(vault_item_id) = 32),
  kind TEXT NOT NULL CHECK (kind IN ('website_login', 'contact_profile')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  origins_json TEXT NOT NULL CHECK (json_valid(origins_json)),
  username TEXT,
  contact_json TEXT CHECK (contact_json IS NULL OR json_valid(contact_json)),
  vault_handle TEXT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, vault_item_id),
  CHECK ((kind = 'website_login') = (vault_handle IS NOT NULL AND username IS NOT NULL AND contact_json IS NULL)),
  CHECK ((kind = 'contact_profile') = (contact_json IS NOT NULL AND vault_handle IS NULL AND username IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_vault_item_listing ON vault_item (organisation_id, kind, label);
