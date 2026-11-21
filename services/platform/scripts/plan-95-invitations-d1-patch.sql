-- Plan 95 step 2: Pantry keeps its own invitations. Adds the table
-- organisation_invitation, its index organisation_invitation_pending_email
-- (one pending invitation for each email in an organisation) and its trigger
-- organisation_invitation_closed (a closed invitation does not change, and an
-- open one changes only its state). Apply once to each deployed regional
-- database before the release that writes the table. The old table
-- account_service_invitation_role stays until step 4 drops it.
CREATE TABLE organisation_invitation (
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
  PRIMARY KEY (organisation_id, invitation_id),
  CHECK ((state = 'accepted') = (accepted_user_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX organisation_invitation_pending_email
  ON organisation_invitation (organisation_id, email) WHERE state = 'pending';
CREATE TRIGGER organisation_invitation_closed BEFORE UPDATE ON organisation_invitation
WHEN OLD.state <> 'pending' OR NEW.organisation_id <> OLD.organisation_id
  OR NEW.invitation_id <> OLD.invitation_id OR NEW.email <> OLD.email OR NEW.role <> OLD.role
  OR NEW.token_hash <> OLD.token_hash OR NEW.created_at <> OLD.created_at
  OR NEW.expires_at <> OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'organisation_invitation_closed'); END;
