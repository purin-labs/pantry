import {
  parseProjectId,
  type ProjectId,
  type ProjectRole,
} from "@purin-labs/control-api";
import type { OnboardingControlRole } from "@purin-labs/contracts";
import { assertNever, sha256Hex } from "@purin-labs/std";
import type { OrganisationQuerySource } from "../data/query-source";
import type { OrganisationId } from "../ids";
import type { UserId } from "@purin-labs/control-api/ids";

const BASE_PROJECT_NAME = "Base";

// Provisioning can repeat. One identifier per Organisation makes every attempt
// converge on the same Project instead of leaving a second one behind.
export async function baseProjectId(
  organisationId: OrganisationId,
): Promise<ProjectId> {
  const digest = await sha256Hex(`base-project:${organisationId}`);
  const parsed = parseProjectId(
    `project_${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`,
  );
  if (!parsed.ok) throw new Error("base_project_id_invalid");
  return parsed.value;
}

// Base is an ordinary shared Project with empty content. The pointer, not the
// name, makes it the default. Run after the organisation row exists, and after
// the owner's membership when an owner is given.
export function prepareBaseProject(
  database: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    projectId: ProjectId;
    ownerUserId: UserId | null;
    now: number;
  }>,
): D1PreparedStatement[] {
  const statements = [
    // A replaced default is not recreated.
    database
      .prepare(
        `INSERT OR IGNORE INTO project (
           organisation_id, user_id, project_id, access_kind, access_revision,
           name, brief, references_json, revision, content_revision, created_at, updated_at
         )
         SELECT ?, NULL, ?, 'shared', 1, ?, '', '[]', 1, 1, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM organisation_default_project WHERE organisation_id = ?
         )`,
      )
      .bind(
        input.organisationId,
        input.projectId,
        BASE_PROJECT_NAME,
        input.now,
        input.now,
        input.organisationId,
      ),
    database
      .prepare(
        `INSERT OR IGNORE INTO organisation_default_project (
           organisation_id, project_id, revision, updated_at
         ) VALUES (?, ?, 1, ?)`,
      )
      .bind(input.organisationId, input.projectId, input.now),
  ];
  if (input.ownerUserId !== null)
    statements.push(
      database
        .prepare(
          `INSERT OR IGNORE INTO project_member (organisation_id, project_id, user_id, role)
           SELECT organisation_id, project_id, ?, 'owner'
           FROM organisation_default_project
           WHERE organisation_id = ? AND project_id = ?`,
        )
        .bind(input.ownerUserId, input.organisationId, input.projectId),
    );
  return statements;
}

function baseProjectRole(role: OnboardingControlRole): ProjectRole {
  switch (role) {
    case "owner":
    case "admin":
      return "owner";
    case "operator":
      return "editor";
    case "viewer":
      return "viewer";
    default:
      return assertNever(role);
  }
}

// A member who joins the Organisation joins its default Project while that
// reveals nothing: the Project holds no shared Case and no reference. After
// that, an owner admits members through the disclosure-checked access command.
// Run after the membership row is active.
export function prepareBaseProjectMembership(
  database: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    userId: UserId;
    role: OnboardingControlRole;
    now: number;
  }>,
): D1PreparedStatement[] {
  return [
    database
      .prepare(
        `INSERT INTO project_member (organisation_id, project_id, user_id, role)
         SELECT d.organisation_id, d.project_id, ?, ?
         FROM organisation_default_project d
         JOIN project p ON p.organisation_id = d.organisation_id
           AND p.project_id = d.project_id AND p.access_kind = 'shared'
         WHERE d.organisation_id = ?
           AND EXISTS (
             SELECT 1 FROM service_role_grant g
             WHERE g.organisation_id = d.organisation_id AND g.user_id = ? AND g.status = 'active'
           )
           AND json_array_length(p.references_json) = 0
           AND NOT EXISTS (
             SELECT 1 FROM portal_conversation c
             JOIN case_project cp ON cp.organisation_id = c.organisation_id AND cp.case_id = c.case_id
             WHERE c.organisation_id = d.organisation_id
               AND cp.project_id = d.project_id AND c.access_kind = 'shared'
           )
         ON CONFLICT (organisation_id, project_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .bind(
        input.userId,
        baseProjectRole(input.role),
        input.organisationId,
        input.userId,
      ),
    ...prepareBaseProjectAccessChange(database, input),
  ];
}

// An Organisation role change carries over to a member who is in the default Project.
export function prepareBaseProjectRoleChange(
  database: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    userId: UserId;
    role: OnboardingControlRole;
    now: number;
  }>,
): D1PreparedStatement[] {
  return [
    database
      .prepare(
        `UPDATE project_member SET role = ?
         WHERE organisation_id = ? AND user_id = ? AND role <> ?
           AND project_id = (
             SELECT project_id FROM organisation_default_project WHERE organisation_id = ?
           )`,
      )
      .bind(
        baseProjectRole(input.role),
        input.organisationId,
        input.userId,
        baseProjectRole(input.role),
        input.organisationId,
      ),
    ...prepareBaseProjectAccessChange(database, input),
  ];
}

// Follows a membership statement in the same batch and applies only when it changed a row.
function prepareBaseProjectAccessChange(
  database: OrganisationQuerySource,
  input: Readonly<{ organisationId: OrganisationId; now: number }>,
): D1PreparedStatement[] {
  return [
    database
      .prepare(
        `UPDATE project SET access_revision = access_revision + 1, updated_at = ?
         WHERE changes() = 1 AND organisation_id = ?
           AND project_id = (
             SELECT project_id FROM organisation_default_project WHERE organisation_id = ?
           )`,
      )
      .bind(input.now, input.organisationId, input.organisationId),
    database
      .prepare(
        "UPDATE portal_chat_directory SET revision = revision + 1 WHERE organisation_id = ? AND changes() = 1",
      )
      .bind(input.organisationId),
  ];
}

// A member who leaves the Organisation leaves its shared Projects too, so
// returning does not restore access to history added while they were away:
// they are admitted again through the ordinary access command and its
// disclosure review. Run after the membership row is revoked.
//
// A shared Project keeps an owner: where the leaver was the only one, the
// remaining member with the highest role takes over. That member already reads
// everything in the Project, so the succession discloses nothing.
export function prepareProjectMembershipRevocation(
  database: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    userId: UserId;
    now: number;
    guard: Readonly<{
      sql: string;
      bindings: readonly (string | number | null)[];
    }> | null;
  }>,
): D1PreparedStatement[] {
  const guard = input.guard ?? { sql: "1 = 1", bindings: [] };
  return [
    database
      .prepare(
        `UPDATE project SET access_revision = access_revision + 1, updated_at = ?
         WHERE organisation_id = ? AND access_kind = 'shared' AND project_id IN (
           SELECT pm.project_id FROM project_member pm
           WHERE pm.organisation_id = project.organisation_id AND pm.user_id = ?) AND ${guard.sql}`,
      )
      .bind(input.now, input.organisationId, input.userId, ...guard.bindings),
    database
      .prepare(
        `UPDATE project_member SET role = 'owner'
         WHERE organisation_id = ?
           AND project_id IN (
             SELECT own.project_id FROM project_member own
             WHERE own.organisation_id = project_member.organisation_id AND own.user_id = ? AND own.role = 'owner'
               AND NOT EXISTS (SELECT 1 FROM project_member other
                 JOIN service_role_grant tm ON tm.organisation_id = other.organisation_id
                   AND tm.user_id = other.user_id AND tm.status = 'active'
                 WHERE other.organisation_id = own.organisation_id AND other.project_id = own.project_id
                   AND other.user_id <> own.user_id AND other.role = 'owner'))
           AND user_id = (
             SELECT successor.user_id FROM project_member successor
             JOIN service_role_grant tm ON tm.organisation_id = successor.organisation_id
               AND tm.user_id = successor.user_id AND tm.status = 'active'
             WHERE successor.organisation_id = project_member.organisation_id
               AND successor.project_id = project_member.project_id AND successor.user_id <> ?
             ORDER BY CASE successor.role WHEN 'editor' THEN 0 ELSE 1 END, successor.user_id
             LIMIT 1) AND ${guard.sql}`,
      )
      .bind(
        input.organisationId,
        input.userId,
        input.userId,
        ...guard.bindings,
      ),
    database
      .prepare(
        `DELETE FROM project_member WHERE organisation_id = ? AND user_id = ? AND ${guard.sql}`,
      )
      .bind(input.organisationId, input.userId, ...guard.bindings),
    database
      .prepare(
        `DELETE FROM portal_chat_directory_project WHERE organisation_id = ? AND user_id = ?
           AND project_id IN (SELECT p.project_id FROM project p
             WHERE p.organisation_id = portal_chat_directory_project.organisation_id AND p.access_kind = 'shared') AND ${guard.sql}`,
      )
      .bind(input.organisationId, input.userId, ...guard.bindings),
  ];
}

/**
 * The delete of an archived Organisation removes the members of each of its
 * Projects, while the guard holds.
 */
export function prepareOrganisationProjectMembersDeletion(
  database: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    guard: Readonly<{ sql: string; bindings: readonly unknown[] }>;
  }>,
): D1PreparedStatement {
  return database
    .prepare(
      `DELETE FROM project_member WHERE organisation_id = ? AND ${input.guard.sql}`,
    )
    .bind(input.organisationId, ...input.guard.bindings);
}
