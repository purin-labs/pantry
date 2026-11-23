-- Plan 82 Phase 3: adds voice_confirmation and its index.
-- Apply to each deployed regional database before the release that reads them.
-- The statements are safe to repeat.
CREATE TABLE IF NOT EXISTS voice_confirmation (
  confirmation_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('configuration_draft', 'slack_draft', 'email_draft')),
  target_id TEXT NOT NULL,
  phrase TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'matched', 'spent')),
  refused_attempts INTEGER NOT NULL DEFAULT 0 CHECK (refused_attempts >= 0),
  transcription_path TEXT CHECK (transcription_path IN ('shop_mac', 'workers_ai')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  matched_at INTEGER,
  CHECK ((state = 'matched') = (matched_at IS NOT NULL)),
  CHECK ((state = 'matched') = (transcription_path IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS voice_confirmation_member
  ON voice_confirmation (organisation_id, user_id, conversation_id, state);
