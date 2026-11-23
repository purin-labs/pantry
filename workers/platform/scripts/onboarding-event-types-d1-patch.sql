-- The onboarding_event CHECK no longer allows invitation_created,
-- invitation_accepted and invitation_revoked. No code writes these types:
-- organisation_invitation keeps the state of each invitation. A database
-- that holds a row of one of these types fails the copy below, and nothing
-- changes; such a row is not expected.
-- Apply to each deployed REGIONAL database before the release:
--   wrangler d1 execute <regional database> --env production --remote --file workers/platform/scripts/onboarding-event-types-d1-patch.sql
-- SQLite cannot change a CHECK in place, so onboarding_event is rebuilt: the
-- new table is created, every row is copied, the old table is dropped and the
-- new one takes its name. No table or trigger refers to onboarding_event. Its
-- two indexes, idx_onboarding_event_organisation_time and
-- idx_onboarding_event_type_time, go with the old table and are created
-- again. A remote file runs as one unit. A second run repeats the rebuild and
-- changes nothing.
CREATE TABLE onboarding_event_next (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'onboarding_started', 'onboarding_resumed', 'onboarding_stage_viewed',
      'onboarding_stage_completed', 'organisation_created', 'organisation_archived',
      'provider_attempt_started', 'provider_attempt_connected',
      'provider_attempt_cancelled', 'provider_attempt_failed',
      'provider_attempt_expired', 'provider_reconciliation_started',
      'provider_reconciliation_completed', 'provider_reconciliation_failed',
      'default_account_changed', 'setup_saved', 'readiness_assessed',
      'readiness_invalidated', 'activation_started',
      'activation_phase_completed', 'activation_succeeded',
      'activation_failed', 'first_task_presented', 'support_reference_created'
    )
  ),
  occurred_at INTEGER NOT NULL,
  organisation_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  portal_subject_hash TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  attributes TEXT NOT NULL CHECK (json_valid(attributes))
);

INSERT INTO onboarding_event_next (
  event_id, schema_version, event_type, occurred_at, organisation_id,
  environment, portal_subject_hash, correlation_id, causation_id,
  projection_revision, attributes
)
SELECT
  event_id, schema_version, event_type, occurred_at, organisation_id,
  environment, portal_subject_hash, correlation_id, causation_id,
  projection_revision, attributes
FROM onboarding_event;

DROP TABLE onboarding_event;
ALTER TABLE onboarding_event_next RENAME TO onboarding_event;

CREATE INDEX idx_onboarding_event_organisation_time
  ON onboarding_event (organisation_id, occurred_at DESC);
CREATE INDEX idx_onboarding_event_type_time
  ON onboarding_event (event_type, occurred_at DESC);
