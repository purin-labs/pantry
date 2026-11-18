CREATE TABLE IF NOT EXISTS email_self_test (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  self_test_id TEXT NOT NULL,
  integration_account_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  address TEXT NOT NULL CHECK (length(address) BETWEEN 3 AND 320),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  PRIMARY KEY (organisation_id, self_test_id),
  FOREIGN KEY (integration_account_id, organisation_id)
    REFERENCES integration_account (integration_account_id, organisation_id)
);
