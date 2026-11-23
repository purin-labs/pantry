-- Plan 40B phase 1: menu board screens wait for pairing in the GLOBAL
-- database. Apply once to the global database before the release:
--   wrangler d1 execute <global database> --remote --file workers/platform/scripts/plan-40b-screen-pairing-d1-patch.sql
-- Adds table screen_pairing and index screen_pairing_expiry. The combined
-- test schema (migrations/0001_current_schema.sql) carries the same DDL.
CREATE TABLE IF NOT EXISTS screen_pairing (
  pairing_id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (length(code) = 6),
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  organisation_id TEXT,
  screen_token TEXT,
  claimed_at INTEGER,
  CHECK ((organisation_id IS NULL) = (screen_token IS NULL)),
  CHECK ((organisation_id IS NULL) = (claimed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS screen_pairing_expiry ON screen_pairing(expires_at);
