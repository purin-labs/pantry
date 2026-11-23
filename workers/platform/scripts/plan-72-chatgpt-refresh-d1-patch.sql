-- Plan 72: the ChatGPT subscription route runs on Pi, which refreshes the
-- organisation's ChatGPT tokens itself under a lease. Apply to each regional
-- database (migrations-regional) before the Worker release; a local combined
-- database (migrations/) needs it too. The global database (migrations-global)
-- has no such table. It keeps every connection row and adds the refresh
-- lease. The Worker before the release reads the table as it was, so it keeps
-- working. No table references organisation_codex_connection. After the
-- release, apply plan-72-codex-standby-drop-d1-patch.sql.
ALTER TABLE organisation_codex_connection RENAME TO organisation_codex_connection_previous;
CREATE TABLE organisation_codex_connection (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('connected', 'action_required')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  auth_profile_handle TEXT NOT NULL,
  auth_profile_generation INTEGER NOT NULL CHECK (auth_profile_generation > 0),
  plan_type TEXT NOT NULL,
  action_required_reason TEXT CHECK (
    action_required_reason IS NULL OR action_required_reason IN (
      'authorization_expired',
      'workspace_access_revoked',
      'device_authorization_unavailable',
      'allowance_exhausted',
      'account_unavailable'
    )
  ),
  allowance_json TEXT NOT NULL CHECK (json_valid(allowance_json)),
  connected_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  refresh_lease TEXT,
  refresh_until INTEGER,
  CHECK (
    (lifecycle = 'connected' AND action_required_reason IS NULL) OR
    (lifecycle = 'action_required' AND action_required_reason IS NOT NULL)
  ),
  CHECK ((refresh_lease IS NULL) = (refresh_until IS NULL))
);
INSERT INTO organisation_codex_connection (
  organisation_id, lifecycle, revision, auth_profile_handle,
  auth_profile_generation, plan_type, action_required_reason, allowance_json,
  connected_at, verified_at, observed_at, updated_at, refresh_lease, refresh_until
)
SELECT organisation_id, lifecycle, revision, auth_profile_handle,
  auth_profile_generation, plan_type, action_required_reason, allowance_json,
  connected_at, verified_at, observed_at, updated_at, NULL, NULL
FROM organisation_codex_connection_previous;
DROP TABLE organisation_codex_connection_previous;
