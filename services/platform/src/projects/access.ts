import type { OrganisationDatabase } from "../database-handles";
import {
  projectRoleAllows,
  isUserId,
  isProjectRole,
  type ProjectMember,
  parseProjectAccess,
  type ProjectAccess,
  type ProjectPermission,
  type ProjectRole,
} from "@seams/control-api";
import type { ProjectId, UserId } from "@seams/control-api";
import type { OrganisationId } from "../ids";

export type ProjectAccessScope = Readonly<{
  organisationId: OrganisationId;
  userId: UserId;
}>;

export type AuthorizedProject = Readonly<{
  projectId: ProjectId;
  access: ProjectAccess;
}>;

export async function authorizeProject(
  db: OrganisationDatabase,
  scope: ProjectAccessScope,
  projectId: ProjectId,
  permission: ProjectPermission,
): Promise<AuthorizedProject | null> {
  const row = await db
    .prepare(
      `
    SELECT p.access_kind, p.user_id, p.access_revision, pm.role
    FROM project p
    JOIN organisation t ON t.organisation_id = p.organisation_id AND t.status = 'active'
    JOIN service_role_grant tm ON tm.organisation_id = p.organisation_id
      AND tm.user_id = ? AND tm.status = 'active'
    LEFT JOIN project_member pm ON pm.organisation_id = p.organisation_id
      AND pm.project_id = p.project_id AND pm.user_id = tm.user_id
    WHERE p.organisation_id = ? AND p.project_id = ?
      AND ((p.access_kind = 'personal' AND p.user_id = tm.user_id)
        OR (p.access_kind = 'shared' AND pm.user_id IS NOT NULL))
  `,
    )
    .bind(scope.userId, scope.organisationId, projectId)
    .first<{
      access_kind: unknown;
      user_id: unknown;
      access_revision: unknown;
      role: unknown;
    }>();
  if (row === null) return null;
  const access =
    row.access_kind === "personal"
      ? parseProjectAccess({
          kind: "personal",
          ownerUserId: row.user_id,
          accessRevision: row.access_revision,
        })
      : parseProjectAccess({
          kind: row.access_kind,
          role: row.role,
          accessRevision: row.access_revision,
        });
  if (access === null) throw new Error("project_access_storage_invalid");
  const role: ProjectRole = access.kind === "personal" ? "owner" : access.role;
  if (!projectRoleAllows(role, permission)) return null;
  return { projectId, access };
}

export async function listProjectMembers(
  db: OrganisationDatabase,
  scope: ProjectAccessScope,
  projectId: ProjectId,
): Promise<readonly ProjectMember[] | null> {
  const access = await authorizeProject(db, scope, projectId, "read");
  if (access === null) return null;
  // A member's name comes from the Organisation's own person record. The
  // sign-in identity is in the global database, which this one cannot join.
  const rows = await db
    .prepare(
      `
    SELECT m.user_id, p.display_name, m.role
    FROM project_member m
    JOIN service_role_grant tm ON tm.organisation_id = m.organisation_id
      AND tm.user_id = m.user_id AND tm.status = 'active'
    JOIN person p ON p.organisation_id = tm.organisation_id
      AND p.person_id = tm.person_id
    WHERE m.organisation_id = ? AND m.project_id = ?
    ORDER BY p.display_name, m.user_id
  `,
    )
    .bind(scope.organisationId, projectId)
    .all<{
      user_id: unknown;
      display_name: unknown;
      role: unknown;
    }>();
  const members: ProjectMember[] = [];
  for (const row of rows.results) {
    const member = parseProjectMemberRow(row);
    members.push(member);
  }
  // Recheck after the query so a concurrent revocation cannot return the roster.
  const current = await authorizeProject(db, scope, projectId, "read");
  if (
    current === null ||
    current.access.accessRevision !== access.access.accessRevision
  )
    return null;
  return members;
}

function parseProjectMemberRow(row: {
  user_id: unknown;
  display_name: unknown;
  role: unknown;
}): ProjectMember {
  if (
    !isUserId(row.user_id) ||
    typeof row.display_name !== "string" ||
    !isProjectRole(row.role)
  ) {
    throw new Error("project_member_storage_invalid");
  }
  return { userId: row.user_id, displayName: row.display_name, role: row.role };
}

// Parameters are organisation ID, requesting user ID, and destination project ID.
export const PROJECT_DESTINATION_SQL = `SELECT 1 FROM project p
  JOIN (SELECT ? AS organisation_id, ? AS user_id, ? AS project_id) target
    ON target.organisation_id = p.organisation_id AND target.project_id = p.project_id
  JOIN service_role_grant tm ON tm.organisation_id = target.organisation_id
    AND tm.user_id = target.user_id AND tm.status = 'active'
  WHERE (p.access_kind = 'personal' AND p.user_id = tm.user_id)
    OR (p.access_kind = 'shared' AND EXISTS (
      SELECT 1 FROM project_member member WHERE member.organisation_id = p.organisation_id
        AND member.project_id = p.project_id AND member.user_id = tm.user_id))`;

export async function listProjectCandidates(
  db: OrganisationDatabase,
  scope: ProjectAccessScope,
  projectId: ProjectId,
): Promise<readonly import("@seams/control-api").ProjectCandidate[]> {
  const authorized = await authorizeProject(
    db,
    scope,
    projectId,
    "manage_members",
  );
  if (authorized === null) return [];
  const rows = await db
    .prepare(
      `SELECT tm.user_id, p.display_name FROM service_role_grant tm
    JOIN person p ON p.organisation_id = tm.organisation_id
      AND p.person_id = tm.person_id
    WHERE tm.organisation_id = ? AND tm.status = 'active' AND tm.user_id <> ?
      AND NOT EXISTS (SELECT 1 FROM project_member pm
        WHERE pm.organisation_id = tm.organisation_id AND pm.project_id = ? AND pm.user_id = tm.user_id)
    ORDER BY p.display_name, tm.user_id LIMIT 100`,
    )
    .bind(scope.organisationId, scope.userId, projectId)
    .all<{ user_id: unknown; display_name: unknown }>();
  const candidates: import("@seams/control-api").ProjectCandidate[] = [];
  for (const row of rows.results) {
    if (!isUserId(row.user_id) || typeof row.display_name !== "string")
      throw new Error("project_candidate_invalid");
    candidates.push({ userId: row.user_id, displayName: row.display_name });
  }
  return candidates;
}
