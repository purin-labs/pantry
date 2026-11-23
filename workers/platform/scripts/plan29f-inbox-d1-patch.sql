-- One-time additive Inbox upgrade for a database with an applied squashed
-- baseline. Creates empty tables; existing accounts and consent stay unchanged.
-- Exact-purpose evidence for TypeSafe processing of one Gmail source connection.
CREATE TABLE IF NOT EXISTS mail_classification_eligibility (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  source_pin TEXT NOT NULL,
  connection_revision INTEGER NOT NULL CHECK (connection_revision > 0),
  model TEXT NOT NULL CHECK (model = 'jev-1.13.0'),
  purpose TEXT NOT NULL CHECK (purpose = 'mail_classification'),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) > 0),
  evidence_owner TEXT NOT NULL CHECK (length(trim(evidence_owner)) > 0),
  disclosed_recipient TEXT NOT NULL CHECK (disclosed_recipient = 'typesafe'),
  reviewed_at INTEGER NOT NULL,
  review_expires_at INTEGER NOT NULL CHECK (review_expires_at > reviewed_at),
  revoked_at INTEGER,
  PRIMARY KEY (organisation_id, integration_account_id, source_pin, connection_revision),
  FOREIGN KEY (integration_account_id, organisation_id) REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE TABLE IF NOT EXISTS mail_classification (
  organisation_id TEXT NOT NULL,
  integration_account_id TEXT NOT NULL,
  rule_revision INTEGER NOT NULL CHECK (rule_revision > 0),
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('matched', 'not_matched', 'needs_review')),
  source TEXT NOT NULL CHECK (source IN ('jev', 'operator')),
  evaluated_at INTEGER NOT NULL,
  evaluation_id TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  PRIMARY KEY (organisation_id, integration_account_id, rule_revision, message_id, rule_id),
  FOREIGN KEY (integration_account_id, organisation_id) REFERENCES integration_account (integration_account_id, organisation_id)
);
CREATE INDEX IF NOT EXISTS mail_classification_matches ON mail_classification
  (organisation_id, integration_account_id, rule_revision, outcome, rule_id, message_id DESC);

-- Separate operator-reviewed consent for transient Inbox assistance.
CREATE TABLE IF NOT EXISTS mail_assistant_eligibility (
  organisation_id TEXT NOT NULL REFERENCES organisation(organisation_id),
  integration_account_id TEXT NOT NULL REFERENCES integration_account(integration_account_id),
  source_pin TEXT NOT NULL CHECK(length(source_pin) = 64),
  model_route_digest TEXT NOT NULL CHECK(length(model_route_digest) = 64),
  purpose TEXT NOT NULL CHECK(purpose = 'mail_inbox_assistance'),
  disclosed_recipient TEXT NOT NULL CHECK(disclosed_recipient IN ('openrouter', 'openai', 'anthropic')),
  evidence_reference TEXT NOT NULL CHECK(length(trim(evidence_reference)) > 0),
  owner TEXT NOT NULL CHECK(length(trim(owner)) > 0),
  consent_reference TEXT NOT NULL CHECK(length(trim(consent_reference)) > 0),
  reviewed_at INTEGER NOT NULL,
  review_expires_at INTEGER NOT NULL CHECK(review_expires_at > reviewed_at),
  revoked_at INTEGER,
  PRIMARY KEY (organisation_id, integration_account_id, source_pin, model_route_digest)
);
