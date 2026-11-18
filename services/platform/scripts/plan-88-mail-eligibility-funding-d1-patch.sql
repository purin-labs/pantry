-- Plan 88: Jev from Satyr. Table mail_classification_eligibility gains the
-- column funding ('satyr_platform' or 'organisation_byo'). A row for Satyr's
-- key pins connection_revision 0; a row for the Organisation's own key pins its
-- connection revision, as before. funding joins the primary key.
-- Apply to each deployed REGIONAL database (and a local combined database)
-- before the release that writes it:
--   wrangler d1 execute <regional database> --env production --remote --file services/platform/scripts/plan-88-mail-eligibility-funding-d1-patch.sql
-- SQLite cannot change a CHECK or a primary key in place, so the table is
-- rebuilt: the new table is created, every row is copied as funding
-- 'organisation_byo', the old table is dropped and the new one takes its
-- name. No table refers to it and it has no index. A remote file runs as one
-- unit. Apply it one time: a second run fails on the first CREATE TABLE and
-- changes nothing.
PRAGMA defer_foreign_keys = true;

CREATE TABLE mail_classification_eligibility_next (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  integration_account_id TEXT NOT NULL,
  source_pin TEXT NOT NULL,
  funding TEXT NOT NULL DEFAULT 'organisation_byo' CHECK (funding IN ('satyr_platform', 'organisation_byo')),
  connection_revision INTEGER NOT NULL CHECK (connection_revision >= 0),
  model TEXT NOT NULL CHECK (model = 'jev-1.13.0'),
  purpose TEXT NOT NULL CHECK (purpose = 'mail_classification'),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) > 0),
  evidence_owner TEXT NOT NULL CHECK (length(trim(evidence_owner)) > 0),
  disclosed_recipient TEXT NOT NULL CHECK (disclosed_recipient = 'typesafe'),
  reviewed_at INTEGER NOT NULL,
  review_expires_at INTEGER NOT NULL CHECK (review_expires_at > reviewed_at),
  revoked_at INTEGER,
  CHECK ((funding = 'satyr_platform') = (connection_revision = 0)),
  PRIMARY KEY (organisation_id, integration_account_id, source_pin, funding, connection_revision),
  FOREIGN KEY (integration_account_id, organisation_id) REFERENCES integration_account (integration_account_id, organisation_id)
);
INSERT INTO mail_classification_eligibility_next (
  organisation_id, integration_account_id, source_pin, funding, connection_revision,
  model, purpose, evidence_reference, evidence_owner, disclosed_recipient,
  reviewed_at, review_expires_at, revoked_at
)
SELECT organisation_id, integration_account_id, source_pin, 'organisation_byo', connection_revision,
  model, purpose, evidence_reference, evidence_owner, disclosed_recipient,
  reviewed_at, review_expires_at, revoked_at
FROM mail_classification_eligibility;
DROP TABLE mail_classification_eligibility;
ALTER TABLE mail_classification_eligibility_next RENAME TO mail_classification_eligibility;
