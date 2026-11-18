import type { OrganisationDatabase } from "../database-handles";
import { parseProject, type Project, type ProjectId } from "@seams/control-api";
import type { ProjectAccessScope } from "./access";

type ProjectRow = Readonly<{
  project_id: unknown;
  name: unknown;
  brief: unknown;
  references_json: unknown;
  revision: unknown;
  content_revision: unknown;
  created_at: unknown;
  updated_at: unknown;
  access_kind: unknown;
  user_id: unknown;
  access_revision: unknown;
  member_role: unknown;
}>;

// Projects the bound user may see: their personal ones and shared ones they belong to.
export const VISIBLE_PROJECTS = `SELECT p.*, (SELECT pm.role FROM project_member pm WHERE pm.organisation_id = p.organisation_id AND pm.project_id = p.project_id AND pm.user_id = tm.user_id) AS member_role FROM project p
  JOIN organisation t ON t.organisation_id = p.organisation_id AND t.status = 'active'
  JOIN service_role_grant tm ON tm.organisation_id = p.organisation_id AND tm.user_id = ? AND tm.status = 'active'
  WHERE p.organisation_id = ? AND (
    (p.access_kind = 'personal' AND p.user_id = tm.user_id) OR
    (p.access_kind = 'shared' AND EXISTS (SELECT 1 FROM project_member pm
      WHERE pm.organisation_id = p.organisation_id AND pm.project_id = p.project_id AND pm.user_id = tm.user_id))
  )`;

export async function readProject(
  db: OrganisationDatabase,
  scope: ProjectAccessScope,
  projectId: ProjectId,
): Promise<Project | null> {
  const row = await db
    .prepare(`${VISIBLE_PROJECTS} AND p.project_id = ?`)
    .bind(scope.userId, scope.organisationId, projectId)
    .first<ProjectRow>();
  return row === null ? null : parseProjectRow(row);
}

export function parseProjectRecord(row: Record<string, unknown>): Project {
  return parseProjectRow({
    project_id: row.project_id,
    name: row.name,
    brief: row.brief,
    references_json: row.references_json,
    revision: row.revision,
    content_revision: row.content_revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
    access_kind: row.access_kind,
    user_id: row.user_id,
    access_revision: row.access_revision,
    member_role: row.member_role,
  });
}

function parseProjectRow(row: ProjectRow): Project {
  if (typeof row.references_json !== "string")
    throw new Error("project_storage_invalid");
  const project = parseProject({
    id: row.project_id,
    access:
      row.access_kind === "personal"
        ? {
            kind: "personal",
            ownerUserId: row.user_id,
            accessRevision: row.access_revision,
          }
        : {
            kind: row.access_kind,
            role: row.member_role,
            accessRevision: row.access_revision,
          },
    name: row.name,
    brief: row.brief,
    references: JSON.parse(row.references_json),
    revision: row.revision,
    contentRevision: row.content_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (project === null) throw new Error("project_storage_invalid");
  return project;
}
