-- An invitation keeps the person who revoked it. Adds the column
-- revoked_by_user_id to organisation_invitation, with the CHECK that only a
-- revoked invitation has it. An invitation that was revoked before this patch
-- keeps NULL.
-- Apply to each deployed REGIONAL database BEFORE the upload of the Worker
-- that writes the column:
--   wrangler d1 execute <regional database> --env production --remote --file workers/platform/scripts/invitation-revoked-by-d1-patch.sql
-- SQLite cannot add a CHECK that names two columns in place, so
-- organisation_invitation is rebuilt: the new table is created, every row is
-- copied, the old table is dropped and the new one takes its name. No table
-- refers to it. Its index organisation_invitation_pending_email and its
-- trigger organisation_invitation_closed go with the old table and are
-- created again after the rename. A remote file runs as one unit, so a failed
-- copy leaves the database as it was.
CREATE TABLE organisation_invitation_next (
  organisation_id TEXT NOT NULL REFERENCES organisation(organisation_id),
  invitation_id TEXT NOT NULL CHECK (length(invitation_id) > 0),
  email TEXT NOT NULL CHECK (length(email) > 0 AND email = lower(email)),
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  invited_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'revoked')),
  accepted_user_id TEXT,
  accepted_at INTEGER,
  revoked_at INTEGER,
  revoked_by_user_id TEXT,
  PRIMARY KEY (organisation_id, invitation_id),
  CHECK ((state = 'accepted') = (accepted_user_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (revoked_by_user_id IS NULL OR state = 'revoked')
);

INSERT INTO organisation_invitation_next (
  organisation_id, invitation_id, email, role, token_hash, invited_by_user_id,
  created_at, expires_at, state, accepted_user_id, accepted_at, revoked_at
)
SELECT
  organisation_id, invitation_id, email, role, token_hash, invited_by_user_id,
  created_at, expires_at, state, accepted_user_id, accepted_at, revoked_at
FROM organisation_invitation;

DROP TABLE organisation_invitation;
ALTER TABLE organisation_invitation_next RENAME TO organisation_invitation;

CREATE UNIQUE INDEX organisation_invitation_pending_email
  ON organisation_invitation (organisation_id, email) WHERE state = 'pending';
CREATE TRIGGER organisation_invitation_closed BEFORE UPDATE ON organisation_invitation
WHEN OLD.state <> 'pending' OR NEW.organisation_id <> OLD.organisation_id
  OR NEW.invitation_id <> OLD.invitation_id OR NEW.email <> OLD.email OR NEW.role <> OLD.role
  OR NEW.token_hash <> OLD.token_hash OR NEW.created_at <> OLD.created_at
  OR NEW.expires_at <> OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'organisation_invitation_closed'); END;
