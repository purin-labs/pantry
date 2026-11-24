-- Sign-in retention: the 15-minute onboarding run deletes control sessions 30
-- days after they end or are revoked, and Google sign-in states one day after
-- they end. These indexes keep each delete a range scan that writes nothing
-- when no row is old enough.
--
-- Global database only (pantry-global-apac). Apply before the Worker upload
-- that carries the deletes:
--   wrangler d1 execute pantry-global-apac --env production --remote --file workers/platform/scripts/sign-in-retention-d1-patch.sql
-- Indexes: idx_control_session_expiry, idx_control_session_revoked and
-- idx_control_oidc_state_expiry. No table or trigger changes. A second run
-- changes nothing.

CREATE INDEX IF NOT EXISTS idx_control_session_expiry
  ON control_session (expires_at);
CREATE INDEX IF NOT EXISTS idx_control_session_revoked
  ON control_session (revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_control_oidc_state_expiry
  ON control_oidc_state (expires_at);
