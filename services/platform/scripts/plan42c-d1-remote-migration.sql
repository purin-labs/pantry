-- Additive Plan 42C production cutover. The current baseline remains authoritative.
-- Apply to the existing satyr production database; never replay the baseline.
-- Reapplication preserves existing effect, approval, save and timeline records.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bakery_surface_effect_delivery (
  effect_id TEXT PRIMARY KEY CHECK (length(effect_id) > 0),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL REFERENCES app_user (user_id),
  session_id TEXT NOT NULL CHECK (length(session_id) > 0),
  turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) > 0),
  surface_session_id TEXT NOT NULL CHECK (length(surface_session_id) > 0),
  surface_epoch INTEGER NOT NULL CHECK (surface_epoch >= 0),
  command_digest TEXT NOT NULL CHECK (
    length(command_digest) = 64
    AND command_digest NOT GLOB '*[^0-9a-f]*'
  ),
  effect_json TEXT NOT NULL CHECK (json_valid(effect_json)),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('dispatching', 'settled', 'indeterminate')
  ),
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  deadline_at INTEGER NOT NULL CHECK (deadline_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (state_kind = 'settled' AND receipt_json IS NOT NULL)
    OR (state_kind <> 'settled' AND receipt_json IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_bakery_surface_effect_delivery_pending
  ON bakery_surface_effect_delivery (
    organisation_id, user_id, surface_session_id, state_kind, created_at
  );

CREATE TABLE IF NOT EXISTS bakery_agent_run_save (
  effect_id TEXT PRIMARY KEY REFERENCES bakery_surface_effect_delivery (effect_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL REFERENCES app_user (user_id),
  content_id TEXT NOT NULL CHECK (
    length(content_id) = 64 AND content_id NOT GLOB '*[^0-9a-f]*'
  ),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  state_kind TEXT NOT NULL CHECK (state_kind IN ('approved', 'saved')),
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  approved_at INTEGER NOT NULL CHECK (approved_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= approved_at),
  CHECK (
    (state_kind = 'approved' AND summary_json IS NULL)
    OR (state_kind = 'saved' AND summary_json IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS bakery_agent_scenario_save (
  effect_id TEXT PRIMARY KEY REFERENCES bakery_surface_effect_delivery (effect_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL REFERENCES app_user (user_id),
  scenario_kind TEXT NOT NULL CHECK (scenario_kind IN ('scenario', 'production-scenario')),
  scenario_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (
    length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  state_kind TEXT NOT NULL CHECK (state_kind IN ('approved', 'saved')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  approved_at INTEGER NOT NULL CHECK (approved_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= approved_at),
  CHECK (
    (state_kind = 'approved' AND result_json IS NULL)
    OR (state_kind = 'saved' AND result_json IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS bakery_surface_timeline_event (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  user_id TEXT NOT NULL REFERENCES app_user (user_id),
  session_id TEXT NOT NULL CHECK (length(session_id) > 0),
  turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) > 0),
  effect_id TEXT NOT NULL REFERENCES bakery_surface_effect_delivery (effect_id),
  event_kind TEXT NOT NULL CHECK (
    event_kind IN ('started', 'settled', 'indeterminate')
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (effect_id, event_kind)
);
CREATE INDEX IF NOT EXISTS idx_bakery_surface_timeline_cursor
  ON bakery_surface_timeline_event (
    organisation_id, user_id, sequence
  );
