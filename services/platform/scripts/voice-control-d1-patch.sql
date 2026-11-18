-- Plan 82 Phase 1: adds voice_mac, voice_transcription_use and their indexes.
-- Apply to each deployed regional database before the release that reads them.
-- The statements are safe to repeat.
CREATE TABLE IF NOT EXISTS voice_mac (
  mac_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  name_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'enrolled', 'revoked')),
  code_sha256 TEXT,
  code_expires_at INTEGER,
  credential_sha256 TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  enrolled_at INTEGER,
  revoked_at INTEGER,
  revoked_by_user_id TEXT,
  last_heartbeat_at INTEGER,
  private_address TEXT,
  service_version TEXT,
  model_state TEXT CHECK (model_state IN ('none', 'downloading', 'unloaded', 'loading', 'loaded'))
);
CREATE INDEX IF NOT EXISTS voice_mac_organisation
  ON voice_mac (organisation_id, state, last_heartbeat_at);
CREATE TABLE IF NOT EXISTS voice_transcription_use (
  use_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at INTEGER,
  audio_milliseconds INTEGER CHECK (audio_milliseconds >= 0)
);
CREATE INDEX IF NOT EXISTS voice_transcription_use_member
  ON voice_transcription_use (organisation_id, user_id, started_at);
