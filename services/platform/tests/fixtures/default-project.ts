import type { OrganisationDatabase } from "../../src/database-handles";
import type { ProjectId } from "@seams/control-api";
import type { OrganisationId } from "../../src/ids";
import { readDefaultProjectId } from "../../src/projects/case-project";
import {
  baseProjectId,
  prepareBaseProject,
} from "../../src/projects/default-project";

// An Organisation the product provisions has a default Project. A fixture that
// inserts the organisation row itself adds one here before admitting a Case.
export async function insertDefaultProject(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<void> {
  await db.batch(
    prepareBaseProject(db, {
      organisationId,
      projectId: await baseProjectId(organisationId),
      ownerUserId: null,
      now: 0,
    }),
  );
}

// The Project an Organisation files work in when none is named.
export async function requireDefaultProjectId(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<ProjectId> {
  const projectId = await readDefaultProjectId(db, organisationId);
  if (projectId === null) throw new Error("Missing default Project");
  return projectId;
}

// The same default Project as statements, for a fixture that seeds SQLite
// directly. It has no member: the fixture's users read nothing from it.
export function defaultProjectSql(organisationId: string): string {
  const projectId = "project_00000000-0000-4000-8000-00000000ba5e";
  return `
    INSERT INTO project (organisation_id, user_id, project_id, access_kind, access_revision, name, brief, references_json, revision, content_revision, created_at, updated_at)
      VALUES ('${organisationId}', NULL, '${projectId}', 'shared', 1, 'Base', '', '[]', 1, 1, 1, 1);
    INSERT INTO organisation_default_project (organisation_id, project_id, revision, updated_at)
      VALUES ('${organisationId}', '${projectId}', 1, 1);
  `;
}
