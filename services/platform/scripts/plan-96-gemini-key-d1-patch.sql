-- Plan 96 part B: an Organisation's own Gemini API key.
-- Apply to each regional database before the Worker release.
-- Rebuilds three tables, because SQLite cannot change a CHECK in place:
-- organisation_inference_selection (selection_kind adds 'organisation_google_api_key'),
-- gmail_inference_eligibility (organisation_byo adds the provider 'google'),
-- mail_assistant_eligibility (disclosed_recipient adds 'google').
-- No index or trigger is on these tables.
ALTER TABLE organisation_inference_selection RENAME TO organisation_inference_selection_previous;
CREATE TABLE organisation_inference_selection (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  selection_kind TEXT NOT NULL CHECK (
    selection_kind IN (
      'codex_subscription',
      'organisation_openai_api_key',
      'organisation_anthropic_api_key',
      'organisation_google_api_key',
      'claude_oauth',
      'satyr_platform'
    )
  ),
  selected_by_user_id TEXT NOT NULL,
  selected_at INTEGER NOT NULL CHECK (selected_at >= 0)
);
INSERT INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at)
  SELECT organisation_id, selection_kind, selected_by_user_id, selected_at FROM organisation_inference_selection_previous;
DROP TABLE organisation_inference_selection_previous;

ALTER TABLE gmail_inference_eligibility RENAME TO gmail_inference_eligibility_previous;
CREATE TABLE gmail_inference_eligibility (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  key_source TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) > 0),
  evidence_owner TEXT NOT NULL CHECK (length(trim(evidence_owner)) > 0),
  disclosed_recipients TEXT NOT NULL CHECK (length(trim(disclosed_recipients)) > 0),
  permitted_purpose TEXT NOT NULL CHECK (length(trim(permitted_purpose)) > 0),
  consent_reference TEXT NOT NULL CHECK (length(trim(consent_reference)) > 0),
  reviewed_at INTEGER NOT NULL CHECK (reviewed_at >= 0),
  review_expires_at INTEGER NOT NULL CHECK (review_expires_at > reviewed_at),
  consented_at INTEGER NOT NULL CHECK (consented_at >= 0),
  revoked_at INTEGER CHECK (revoked_at >= reviewed_at),
  PRIMARY KEY (organisation_id, key_source, provider, model),
  CHECK (
    (key_source = 'organisation_subscription' AND provider = 'openai') OR
    (key_source = 'organisation_byo' AND provider IN ('openai', 'anthropic', 'google')) OR
    (key_source = 'platform' AND provider = 'openai-compatible')
  )
);
INSERT INTO gmail_inference_eligibility (
  organisation_id, key_source, provider, model, evidence_reference, evidence_owner,
  disclosed_recipients, permitted_purpose, consent_reference, reviewed_at,
  review_expires_at, consented_at, revoked_at
)
  SELECT organisation_id, key_source, provider, model, evidence_reference, evidence_owner,
    disclosed_recipients, permitted_purpose, consent_reference, reviewed_at,
    review_expires_at, consented_at, revoked_at
  FROM gmail_inference_eligibility_previous;
DROP TABLE gmail_inference_eligibility_previous;

ALTER TABLE mail_assistant_eligibility RENAME TO mail_assistant_eligibility_previous;
CREATE TABLE mail_assistant_eligibility (
  organisation_id TEXT NOT NULL REFERENCES organisation(organisation_id),
  integration_account_id TEXT NOT NULL REFERENCES integration_account(integration_account_id),
  source_pin TEXT NOT NULL CHECK(length(source_pin) = 64),
  model_route_digest TEXT NOT NULL CHECK(length(model_route_digest) = 64),
  purpose TEXT NOT NULL CHECK(purpose = 'mail_inbox_assistance'),
  disclosed_recipient TEXT NOT NULL CHECK(disclosed_recipient IN ('openrouter', 'openai', 'anthropic', 'google')),
  evidence_reference TEXT NOT NULL CHECK(length(trim(evidence_reference)) > 0),
  owner TEXT NOT NULL CHECK(length(trim(owner)) > 0),
  consent_reference TEXT NOT NULL CHECK(length(trim(consent_reference)) > 0),
  reviewed_at INTEGER NOT NULL,
  review_expires_at INTEGER NOT NULL CHECK(review_expires_at > reviewed_at),
  revoked_at INTEGER,
  PRIMARY KEY (organisation_id, integration_account_id, source_pin, model_route_digest)
);
INSERT INTO mail_assistant_eligibility (
  organisation_id, integration_account_id, source_pin, model_route_digest, purpose,
  disclosed_recipient, evidence_reference, owner, consent_reference, reviewed_at,
  review_expires_at, revoked_at
)
  SELECT organisation_id, integration_account_id, source_pin, model_route_digest, purpose,
    disclosed_recipient, evidence_reference, owner, consent_reference, reviewed_at,
    review_expires_at, revoked_at
  FROM mail_assistant_eligibility_previous;
DROP TABLE mail_assistant_eligibility_previous;
