-- The audit of a person's role accepts only the role 'approve', as
-- person_authz_role does. The retired role 'command' left the audit CHECK.
--   Table person_authz_audit: role CHECK (role IN ('approve')).
-- Apply to each deployed REGIONAL database before the release:
--   wrangler d1 execute <regional database> --env production --remote --file workers/platform/scripts/person-authz-audit-role-d1-patch.sql
-- SQLite cannot change a CHECK in place, so person_authz_audit is rebuilt:
-- the new table is created, every row is copied, the old table is dropped and
-- the new one takes its name. No table refers to it, and no trigger names it.
-- Its index idx_person_authz_audit_person goes with the old table and is
-- created again after the rename. A row with the role 'command' fails the
-- copy; a remote file runs as one unit, so the database then stays as it was.
-- A second run repeats the rebuild and changes nothing.
CREATE TABLE person_authz_audit_next (
  organisation_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('grant', 'revoke')),
  role TEXT NOT NULL CHECK (role IN ('approve')),
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'organisation_admin_token'),
  request_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, audit_id)
);

INSERT INTO person_authz_audit_next (
  organisation_id, audit_id, person_id, operation, role, actor_kind,
  request_id, recorded_at
)
SELECT
  organisation_id, audit_id, person_id, operation, role, actor_kind,
  request_id, recorded_at
FROM person_authz_audit;

DROP TABLE person_authz_audit;
ALTER TABLE person_authz_audit_next RENAME TO person_authz_audit;

CREATE INDEX idx_person_authz_audit_person
ON person_authz_audit (organisation_id, person_id, recorded_at);
