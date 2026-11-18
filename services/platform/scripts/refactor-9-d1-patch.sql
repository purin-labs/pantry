-- Refactor 9 organisation D1 patch: the default Project and the Case association.
--
-- The baseline migration is replaced in place while D1 databases are treated
-- as disposable; a deployed database is not recreated from it. These are the
-- deltas Refactor 9 made to the regional baseline, written to be safe to run
-- more than once, so the schema check in `deploy` passes and Case admission
-- finds a default Project.
--
-- A database created before Refactor 9 takes refactor-9-d1-schema-patch.sql and
-- then refactor-9-d1-chat-placement-patch.sql first: this file expects the
-- renamed Project tables and a chat table that names its Case.
--
-- Run from services/platform against each organisation database:
--   pnpm exec wrangler d1 execute ORGANISATION_DB_WNAM --env production --remote --file scripts/refactor-9-d1-patch.sql
--   pnpm exec wrangler d1 execute ORGANISATION_DB_APAC --env production --remote --file scripts/refactor-9-d1-patch.sql
--
-- Run it again after the release if an Organisation was created in between:
-- the earlier Worker creates none of these rows.
CREATE TABLE IF NOT EXISTS organisation_default_project (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (organisation_id, project_id) REFERENCES project (organisation_id, project_id)
);

CREATE TABLE IF NOT EXISTS case_project (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  case_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, case_id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES project (organisation_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_case_project_project ON case_project (organisation_id, project_id, case_id);

-- An Organisation created before the default Project existed gets its Base
-- here. The identifier is unique within one Organisation, which is all the
-- Project key requires.
INSERT INTO project (
  organisation_id, user_id, project_id, access_kind, access_revision,
  name, brief, references_json, revision, content_revision, created_at, updated_at
)
SELECT o.organisation_id, NULL, 'project_00000000-0000-4000-8000-00000000ba5e', 'shared', 1,
       'Base', '', '[]', 1, 1, unixepoch() * 1000, unixepoch() * 1000
FROM organisation o
WHERE NOT EXISTS (
    SELECT 1 FROM organisation_default_project d WHERE d.organisation_id = o.organisation_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM project p
    WHERE p.organisation_id = o.organisation_id
      AND p.project_id = 'project_00000000-0000-4000-8000-00000000ba5e'
  );

INSERT INTO organisation_default_project (organisation_id, project_id, revision, updated_at)
SELECT p.organisation_id, p.project_id, 1, unixepoch() * 1000
FROM project p
WHERE p.project_id = 'project_00000000-0000-4000-8000-00000000ba5e'
  AND p.access_kind = 'shared'
  AND NOT EXISTS (
    SELECT 1 FROM organisation_default_project d WHERE d.organisation_id = p.organisation_id
  );

-- Active members join that Base with the role provisioning would have given
-- them. Nothing is shared into it yet, so joining reveals nothing.
INSERT OR IGNORE INTO project_member (organisation_id, project_id, user_id, role)
SELECT m.organisation_id, d.project_id, m.user_id,
       CASE m.role WHEN 'owner' THEN 'owner' WHEN 'admin' THEN 'owner' WHEN 'operator' THEN 'editor' ELSE 'viewer' END
FROM organisation_membership m
JOIN organisation_default_project d ON d.organisation_id = m.organisation_id
JOIN project p ON p.organisation_id = d.organisation_id AND p.project_id = d.project_id
WHERE m.status = 'active'
  AND p.project_id = 'project_00000000-0000-4000-8000-00000000ba5e'
  AND json_array_length(p.references_json) = 0
  AND NOT EXISTS (
    SELECT 1 FROM portal_conversation c
    JOIN case_project cp ON cp.organisation_id = c.organisation_id AND cp.case_id = c.case_id
    WHERE c.organisation_id = d.organisation_id AND cp.project_id = d.project_id
      AND c.access_kind = 'shared'
  );
