-- One-time production upgrade for the operational email tables added after
-- the squashed D1 baseline was already marked as applied.
CREATE TABLE IF NOT EXISTS email_operational_proposal_projection (
  proposal_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  target_digest TEXT NOT NULL CHECK (length(target_digest) = 64),
  subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 64),
  body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  lifecycle_kind TEXT NOT NULL CHECK (
    lifecycle_kind IN (
      'awaiting_approval', 'sent', 'send_indeterminate', 'rejected',
      'expired', 'superseded', 'revoked', 'operator_attested_present',
      'operator_attested_absent'
    )
  ),
  provider_message_id TEXT,
  provider_thread_id TEXT,
  indeterminate_rfc_message_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE INDEX IF NOT EXISTS idx_email_operational_proposal_projection_queue
  ON email_operational_proposal_projection (organisation_id, lifecycle_kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS email_operational_attestation (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  proposal_id TEXT NOT NULL REFERENCES email_operational_proposal_projection (proposal_id),
  attestation TEXT NOT NULL CHECK (attestation IN ('present', 'absent')),
  attested_by_user_id TEXT NOT NULL REFERENCES app_user (user_id),
  attested_at INTEGER NOT NULL CHECK (attested_at >= 0),
  PRIMARY KEY (organisation_id, proposal_id)
);

CREATE TABLE IF NOT EXISTS email_operational_contact (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  contact_kind TEXT NOT NULL CHECK (contact_kind IN ('customer_contact', 'supplier_contact')),
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  contact_id TEXT NOT NULL CHECK (length(contact_id) > 0),
  contact_revision INTEGER NOT NULL CHECK (contact_revision > 0),
  observed_address TEXT NOT NULL CHECK (length(observed_address) BETWEEN 3 AND 320),
  display_name TEXT,
  contact_state TEXT NOT NULL CHECK (contact_state IN ('active', 'suppressed')),
  relationship_state TEXT NOT NULL CHECK (relationship_state IN ('active', 'inactive')),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, contact_kind, entity_id, contact_id)
);

CREATE TABLE IF NOT EXISTS contact_endpoint_verification (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  verification_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  command_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('verified', 'revoked')),
  merchant_id TEXT NOT NULL,
  integration_account_id TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  endpoint_json TEXT NOT NULL CHECK (json_valid(endpoint_json)),
  evidence_ref TEXT,
  verified_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  CHECK ((state = 'verified' AND evidence_ref IS NOT NULL) OR (state = 'revoked' AND evidence_ref IS NULL)),
  PRIMARY KEY (organisation_id, verification_id, revision),
  UNIQUE (organisation_id, command_id),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE INDEX IF NOT EXISTS contact_endpoint_verification_lookup
  ON contact_endpoint_verification (organisation_id, integration_account_id, endpoint_json, verification_id, revision DESC);

CREATE TABLE IF NOT EXISTS email_sender_account (
  integration_account_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  google_subject TEXT NOT NULL CHECK (length(google_subject) > 0),
  observed_address TEXT NOT NULL CHECK (length(observed_address) BETWEEN 3 AND 320),
  address_observed_at INTEGER NOT NULL CHECK (address_observed_at >= 0),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sender_account_subject
  ON email_sender_account (environment, google_subject);

CREATE TABLE IF NOT EXISTS gmail_inference_eligibility (
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
    (key_source = 'organisation_byo' AND provider IN ('openai', 'anthropic')) OR
    (key_source = 'platform' AND provider = 'openai-compatible')
  )
);
