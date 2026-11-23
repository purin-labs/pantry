-- User identities live in the global database. Preserve the regional
-- authorization records without a foreign key into that separate database.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE organisation_claude_authorization_replacement (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  attempt_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  verifier_handle TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'exchanging'))
);

INSERT INTO organisation_claude_authorization_replacement
  (organisation_id, attempt_id, user_id, verifier_handle, expires_at, state)
SELECT organisation_id, attempt_id, user_id, verifier_handle, expires_at, state
FROM organisation_claude_authorization;

DROP TABLE organisation_claude_authorization;
ALTER TABLE organisation_claude_authorization_replacement
  RENAME TO organisation_claude_authorization;

PRAGMA defer_foreign_keys = OFF;
