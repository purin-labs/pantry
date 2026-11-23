-- Plan 40B phase 1: one address may hold at most 50 open screen pairings.
-- Apply once to the GLOBAL database before the release, after
-- plan-40b-screen-pairing-d1-patch.sql:
--   wrangler d1 execute DB --env production --remote --file workers/platform/scripts/plan-40b-screen-pairing-client-d1-patch.sql
-- Alters table screen_pairing (adds column client_key, the hash of the address
-- that asked for the code) and adds index screen_pairing_client. Older rows get
-- an empty key and expire within ten minutes.
ALTER TABLE screen_pairing ADD COLUMN client_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS screen_pairing_client ON screen_pairing(client_key);
