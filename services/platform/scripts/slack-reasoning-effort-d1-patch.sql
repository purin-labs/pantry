-- Adds the reasoning effort that an owner or admin chooses for Slack answers.
-- Apply to each deployed regional database before the release that reads it.
-- The statement is safe to repeat.
CREATE TABLE IF NOT EXISTS organisation_slack_reasoning_effort (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high')),
  selected_by_user_id TEXT NOT NULL,
  selected_at INTEGER NOT NULL CHECK (selected_at >= 0)
);
