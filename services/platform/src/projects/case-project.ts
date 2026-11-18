import { isProjectId, type ProjectId } from "@seams/control-api";
import { isPositiveInteger } from "@seams/std";
import type { OrganisationQuerySource } from "../data/query-source";
import type { CaseId, OrganisationId, UserId } from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "../result";

export type CaseProjectPlacement = Readonly<{
  organisationId: OrganisationId;
  caseId: CaseId;
  projectId: ProjectId;
  revision: number;
}>;

// Where a Case was admitted. A chat's Case is its member's to move; every
// other Case stays bound to the source that admitted it.
export type CaseOrigin =
  | "portal_chat"
  | "canvas_chat"
  | "direct"
  | "slack"
  | "email"
  | "whatsapp"
  | "inbox_assistant"
  | "commerce_approval";

export type CaseProjectError = Readonly<{
  code: "default_project_unavailable" | "organisation_placement_conflict";
}>;

const ACTIVE_PLACEMENT = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

// A Case admitted without a destination joins the Organisation's default
// Project. The first accepted admission decides: a retry reads the same
// association, even after the default has been replaced.
export async function ensureCaseProject(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    caseId: CaseId;
    origin: Exclude<CaseOrigin, "portal_chat" | "canvas_chat">;
    now: number;
  }>,
): Promise<Result<CaseProjectPlacement, CaseProjectError>> {
  const scope = input.scope;
  const db = scope.database;
  // One round trip: place the Case if it has no Project yet, then read where it is.
  const [, read] = await db.batch<{ projectId: unknown; revision: unknown }>([
    db
      .prepare(
        `INSERT OR IGNORE INTO case_project (organisation_id, case_id, project_id, revision, updated_at, origin_kind)
         SELECT d.organisation_id, ?, d.project_id, 1, ?, ?
         FROM organisation_default_project d
         JOIN project p ON p.organisation_id = d.organisation_id
           AND p.project_id = d.project_id AND p.access_kind = 'shared'
         WHERE d.organisation_id = ? AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(
        input.caseId,
        input.now,
        input.origin,
        scope.organisationId,
        scope.organisationId,
        scope.placement.placementEpoch,
        scope.placement.placementCellId,
        scope.fenceToken,
      ),
    db
      .prepare(
        "SELECT project_id AS projectId, revision FROM case_project WHERE organisation_id = ? AND case_id = ?",
      )
      .bind(scope.organisationId, input.caseId),
  ]);
  const row = read?.results[0] ?? null;
  if (row === null) {
    return {
      ok: false,
      error: {
        code: (await scope.isActive())
          ? "default_project_unavailable"
          : "organisation_placement_conflict",
      },
    };
  }
  if (!isProjectId(row.projectId) || !isPositiveInteger(row.revision))
    throw new Error("case_project_storage_invalid");
  return {
    ok: true,
    value: {
      organisationId: scope.organisationId,
      caseId: input.caseId,
      projectId: row.projectId,
      revision: row.revision,
    },
  };
}

export async function readDefaultProjectId(
  database: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<ProjectId | null> {
  const row = await database
    .prepare(
      "SELECT project_id AS projectId FROM organisation_default_project WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ projectId: unknown }>();
  if (row === null) return null;
  if (!isProjectId(row.projectId))
    throw new Error("case_project_storage_invalid");
  return row.projectId;
}

// Parameters are the Organisation ID and the Project ID.
export const DEFAULT_PROJECT_IS_SQL = `EXISTS (SELECT 1 FROM organisation_default_project d
  WHERE d.organisation_id = ? AND d.project_id = ?)`;

// Places the Case a member is about to create. Any active member may file
// their own work in the default Project; another Project needs their access.
// A null Project means the default. The caller's condition is the creation
// predicate of the record written next in the same batch, so a Case that is
// not created leaves no association behind.
export function prepareMemberCaseProject(
  execution: OrganisationExecutionScope,
  input: Readonly<{
    userId: UserId;
    caseId: CaseId;
    origin: Extract<CaseOrigin, "portal_chat" | "canvas_chat">;
    projectId: ProjectId | null;
    now: number;
    condition: Readonly<{
      sql: string;
      bindings: readonly (string | number | null)[];
    }>;
  }>,
): D1PreparedStatement {
  return execution.database
    .prepare(
      `INSERT OR IGNORE INTO case_project (organisation_id, case_id, project_id, revision, updated_at, origin_kind)
       SELECT p.organisation_id, ?, p.project_id, 1, ?, ?
       FROM project p
       JOIN service_role_grant tm ON tm.organisation_id = p.organisation_id
         AND tm.user_id = ? AND tm.status = 'active'
       WHERE p.organisation_id = ?
         AND p.project_id = COALESCE(?, (SELECT d.project_id FROM organisation_default_project d
           WHERE d.organisation_id = p.organisation_id))
         AND (EXISTS (SELECT 1 FROM organisation_default_project d
             WHERE d.organisation_id = p.organisation_id AND d.project_id = p.project_id)
           OR (p.access_kind = 'personal' AND p.user_id = tm.user_id)
           OR (p.access_kind = 'shared' AND EXISTS (SELECT 1 FROM project_member member
             WHERE member.organisation_id = p.organisation_id AND member.project_id = p.project_id
               AND member.user_id = tm.user_id)))
         AND (${input.condition.sql}) AND ${ACTIVE_PLACEMENT}`,
    )
    .bind(
      input.caseId,
      input.now,
      input.origin,
      input.userId,
      execution.organisationId,
      input.projectId,
      ...input.condition.bindings,
      execution.organisationId,
      execution.placement.placementEpoch,
      execution.placement.placementCellId,
      execution.fenceToken,
    );
}

const DEFAULT_PROJECT_OF = (alias: string): string =>
  `(SELECT d.project_id FROM organisation_default_project d WHERE d.organisation_id = ${alias}.organisation_id)`;

// Returns private chats to the Organisation's default Project: those in one
// Project or in any, of one member or of all. The owner keeps the chat and it
// stays private; later turns stop inheriting from the Project it left. The
// guard is the caller's operation predicate, or null inside its own transaction.
export function prepareReturnPrivateChatsToDefault(
  database: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    sourceProjectId: ProjectId | null;
    ownerUserId: UserId | null;
    now: number;
    guard: Readonly<{
      sql: string;
      bindings: readonly (string | number | null)[];
    }> | null;
  }>,
): D1PreparedStatement[] {
  const guard = input.guard ?? { sql: "1 = 1", bindings: [] };
  return [
    // Readers refetch a chat whose placement changed.
    database
      .prepare(
        `UPDATE portal_conversation SET revision = revision + 1
         WHERE organisation_id = ? AND access_kind = 'private' AND (? IS NULL OR user_id = ?)
           AND case_id IN (SELECT cp.case_id FROM case_project cp
             WHERE cp.organisation_id = portal_conversation.organisation_id
               AND (? IS NULL OR cp.project_id = ?)
               AND cp.project_id <> ${DEFAULT_PROJECT_OF("cp")})
           AND ${guard.sql}`,
      )
      .bind(
        input.organisationId,
        input.ownerUserId,
        input.ownerUserId,
        input.sourceProjectId,
        input.sourceProjectId,
        ...guard.bindings,
      ),
    database
      .prepare(
        `UPDATE case_project SET project_id = ${DEFAULT_PROJECT_OF("case_project")},
           revision = revision + 1, updated_at = ?
         WHERE organisation_id = ? AND (? IS NULL OR project_id = ?)
           AND project_id <> ${DEFAULT_PROJECT_OF("case_project")}
           AND case_id IN (SELECT c.case_id FROM portal_conversation c
             WHERE c.organisation_id = case_project.organisation_id AND c.access_kind = 'private'
               AND (? IS NULL OR c.user_id = ?))
           AND ${guard.sql}`,
      )
      .bind(
        input.now,
        input.organisationId,
        input.sourceProjectId,
        input.sourceProjectId,
        input.ownerUserId,
        input.ownerUserId,
        ...guard.bindings,
      ),
  ];
}
