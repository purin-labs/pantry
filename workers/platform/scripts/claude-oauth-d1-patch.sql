-- Apply to each regional database before the Worker release.
ALTER TABLE organisation_inference_selection RENAME TO organisation_inference_selection_previous;
CREATE TABLE organisation_inference_selection (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  selection_kind TEXT NOT NULL CHECK (selection_kind IN ('codex_subscription', 'organisation_openai_api_key', 'organisation_anthropic_api_key', 'claude_oauth', 'satyr_platform')),
  selected_by_user_id TEXT NOT NULL,
  selected_at INTEGER NOT NULL CHECK (selected_at >= 0)
);
INSERT INTO organisation_inference_selection SELECT * FROM organisation_inference_selection_previous;
DROP TABLE organisation_inference_selection_previous;
CREATE TABLE organisation_claude_authorization (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  attempt_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  verifier_handle TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'exchanging'))
);
CREATE TABLE organisation_claude_connection (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  connection_id TEXT NOT NULL UNIQUE,
  credential_handle TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('connected', 'refreshing', 'action_required')),
  refresh_lease TEXT,
  refresh_until INTEGER,
  CHECK ((state IN ('connected', 'action_required') AND refresh_lease IS NULL AND refresh_until IS NULL) OR
    (state = 'refreshing' AND refresh_lease IS NOT NULL AND refresh_until IS NOT NULL))
);
