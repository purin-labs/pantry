import type { OrganisationDatabase } from "../database-handles";
import {
  isProjectId,
  type Project,
  type ProjectCatalogue,
  type ProjectCommand,
  type ProjectCommandResult,
  type ProjectId,
} from "@seams/control-api";
import type { OnboardingControlRole } from "@seams/contracts";
import {
  assertNever,
  canonicalJson,
  isPositiveInteger,
  sha256Hex,
} from "@seams/std";
import type { Env } from "../env";
import type { OrganisationId, UserId } from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  authorizeProject,
  listProjectMembers,
  type ProjectAccessScope,
} from "./access";
import { prepareReturnPrivateChatsToDefault } from "./case-project";
import { VISIBLE_PROJECTS, parseProjectRecord, readProject } from "./records";
import { observeProjectReference } from "./references";

const ACTIVE_PLACEMENT = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

// True from the statement that accepts a command until the one that closes its
// receipt, in the same batch. A replayed command finds the receipt closed.
const RECEIPT_OPEN = `EXISTS (SELECT 1 FROM project_operation o
  WHERE o.organisation_id = ? AND o.actor_user_id = ? AND o.operation_id = ?
    AND o.command_digest = ? AND o.applied = 0) AND ${ACTIVE_PLACEMENT}`;

// A Case that keeps a Project from being deleted: anything but a private chat,
// which returns to the default Project instead.
const BLOCKING_CASE = `SELECT 1 FROM case_project cp
  WHERE cp.organisation_id = p.organisation_id AND cp.project_id = p.project_id
    AND NOT EXISTS (SELECT 1 FROM portal_conversation c
      WHERE c.organisation_id = cp.organisation_id AND c.case_id = cp.case_id
        AND c.access_kind = 'private')`;

type CommandActor = Readonly<{
  userId: UserId;
  organisationRole: OnboardingControlRole;
}>;

type Rejection = Extract<ProjectCommandResult, { kind: "rejected" }>["code"];

export async function readProjectCatalogue(
  env: Env,
  execution: OrganisationExecutionScope,
  scope: ProjectAccessScope,
): Promise<ProjectCatalogue> {
  const db = execution.database;
  const [pointer, rows] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        "SELECT project_id, revision FROM organisation_default_project WHERE organisation_id = ?",
      )
      .bind(scope.organisationId),
    db
      .prepare(
        `${VISIBLE_PROJECTS} ORDER BY p.created_at ASC, p.project_id ASC`,
      )
      .bind(scope.userId, scope.organisationId),
  ]);
  const designated = pointer?.results[0];
  if (
    designated === undefined ||
    !isProjectId(designated.project_id) ||
    !isPositiveInteger(designated.revision)
  )
    throw new Error("default_project_unavailable");
  const now = Date.now();
  const projects: Project[] = [];
  for (const row of rows?.results ?? []) {
    const project = parseProjectRecord(row);
    const references: Project["references"][number][] = [];
    for (const reference of project.references)
      references.push(
        (await observeProjectReference(env, execution, scope, reference, now))
          .reference,
      );
    projects.push({ ...project, references });
  }
  return {
    defaultProject: {
      projectId: designated.project_id,
      revision: designated.revision,
    },
    projects,
  };
}

export async function mutateProject(
  env: Env,
  execution: OrganisationExecutionScope,
  actor: CommandActor,
  command: ProjectCommand,
  now: number,
): Promise<ProjectCommandResult> {
  const db = execution.database;
  const scope: ProjectAccessScope = {
    organisationId: execution.organisationId,
    userId: actor.userId,
  };
  if (!(await execution.isActive())) return rejected("project_conflict");
  const digest = await sha256Hex(canonicalJson(command));
  const replay = await readReceipt(db, scope, command.operationId, digest);
  if (replay !== null) return replay;
  const prepared = await prepareCommand(env, execution, actor, command, now);
  if (prepared.kind === "rejected") return prepared;
  const fence = [
    execution.organisationId,
    execution.placement.placementEpoch,
    execution.placement.placementCellId,
    execution.fenceToken,
  ];
  const open = [
    scope.organisationId,
    scope.userId,
    command.operationId,
    digest,
    ...fence,
  ];
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO project_operation
           (organisation_id, actor_user_id, operation_id, command_digest, project_id, result_revision, accepted_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE (${prepared.admission.sql}) AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(
        scope.organisationId,
        scope.userId,
        command.operationId,
        digest,
        command.projectId,
        prepared.resultRevision,
        now,
        ...prepared.admission.bindings,
        ...fence,
      ),
    ...prepared.effects({ sql: RECEIPT_OPEN, bindings: open }),
    // Every member's sidebar reads the Projects it lists again, the actor's
    // included even before they have arranged anything.
    db
      .prepare(
        `INSERT OR IGNORE INTO portal_chat_directory (organisation_id, user_id, revision)
         SELECT ?, ?, 0 WHERE ${RECEIPT_OPEN}`,
      )
      .bind(scope.organisationId, scope.userId, ...open),
    db
      .prepare(
        `UPDATE portal_chat_directory SET revision = revision + 1
         WHERE organisation_id = ? AND ${RECEIPT_OPEN}`,
      )
      .bind(scope.organisationId, ...open),
    db
      .prepare(
        `UPDATE project_operation SET applied = 1
         WHERE organisation_id = ? AND actor_user_id = ? AND operation_id = ?
           AND command_digest = ? AND applied = 0 AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(
        scope.organisationId,
        scope.userId,
        command.operationId,
        digest,
        ...fence,
      ),
  ]);
  return (
    (await readReceipt(db, scope, command.operationId, digest)) ??
    rejected("project_conflict")
  );
}

type Guard = Readonly<{
  sql: string;
  bindings: readonly (string | number | null)[];
}>;

type PreparedCommand =
  | Extract<ProjectCommandResult, { kind: "rejected" }>
  | Readonly<{
      kind: "prepared";
      // The conditions under which the command is accepted, checked in the
      // same statement that writes its receipt.
      admission: Guard;
      resultRevision: number;
      effects: (open: Guard) => D1PreparedStatement[];
    }>;

async function prepareCommand(
  env: Env,
  execution: OrganisationExecutionScope,
  actor: CommandActor,
  command: ProjectCommand,
  now: number,
): Promise<PreparedCommand> {
  const db = execution.database;
  const organisationId = execution.organisationId;
  const scope: ProjectAccessScope = { organisationId, userId: actor.userId };
  switch (command.kind) {
    case "create_project":
      return {
        kind: "prepared",
        admission: {
          sql: `EXISTS (SELECT 1 FROM service_role_grant tm WHERE tm.organisation_id = ?
              AND tm.user_id = ? AND tm.status = 'active')
            AND NOT EXISTS (SELECT 1 FROM project p WHERE p.organisation_id = ? AND p.project_id = ?)`,
          bindings: [
            organisationId,
            actor.userId,
            organisationId,
            command.projectId,
          ],
        },
        resultRevision: 1,
        effects: (open) => [
          db
            .prepare(
              `INSERT INTO project (organisation_id, user_id, project_id, name, brief, references_json, revision, content_revision, created_at, updated_at)
               SELECT ?, ?, ?, ?, ?, ?, 1, 1, ?, ? WHERE ${open.sql}`,
            )
            .bind(
              organisationId,
              actor.userId,
              command.projectId,
              command.content.name,
              command.content.brief,
              JSON.stringify(command.content.references),
              now,
              now,
              ...open.bindings,
            ),
        ],
      };
    case "edit_project": {
      const project = await readProject(db, scope, command.projectId);
      if (
        project === null ||
        (project.access.kind === "shared" && project.access.role === "viewer")
      )
        return rejected("project_unavailable");
      if (project.revision !== command.expectedProjectRevision)
        return rejected("project_conflict");
      // Every reader of the Project must be able to read what it will reference.
      const members =
        project.access.kind === "personal"
          ? [{ userId: project.access.ownerUserId }]
          : await listProjectMembers(db, scope, project.id);
      if (members === null) return rejected("project_unavailable");
      for (const member of members)
        for (const reference of command.content.references) {
          const observation = await observeProjectReference(
            env,
            execution,
            { organisationId, userId: member.userId },
            reference,
            now,
          );
          if (observation.kind === "unavailable")
            return rejected("project_unavailable");
        }
      const references = JSON.stringify(command.content.references);
      return {
        kind: "prepared",
        admission: {
          sql: `EXISTS (SELECT 1 FROM project p
              JOIN service_role_grant tm ON tm.organisation_id = p.organisation_id
                AND tm.user_id = ? AND tm.status = 'active'
              WHERE p.organisation_id = ? AND p.project_id = ? AND p.revision = ? AND p.access_revision = ?
                AND (p.user_id = tm.user_id OR (p.access_kind = 'shared' AND EXISTS (
                  SELECT 1 FROM project_member pm WHERE pm.organisation_id = p.organisation_id
                    AND pm.project_id = p.project_id AND pm.user_id = tm.user_id
                    AND pm.role IN ('owner', 'editor')))))`,
          bindings: [
            actor.userId,
            organisationId,
            command.projectId,
            command.expectedProjectRevision,
            project.access.accessRevision,
          ],
        },
        resultRevision: command.expectedProjectRevision + 1,
        effects: (open) => [
          db
            .prepare(
              `UPDATE project SET name = ?,
                 content_revision = content_revision + CASE WHEN brief <> ? OR references_json <> ? THEN 1 ELSE 0 END,
                 brief = ?, references_json = ?, revision = revision + 1, updated_at = ?
               WHERE organisation_id = ? AND project_id = ? AND ${open.sql}`,
            )
            .bind(
              command.content.name,
              command.content.brief,
              references,
              command.content.brief,
              references,
              now,
              organisationId,
              command.projectId,
              ...open.bindings,
            ),
        ],
      };
    }
    case "delete_project": {
      const authorized = await authorizeProject(
        db,
        scope,
        command.projectId,
        "delete_project",
      );
      if (authorized === null) return rejected("project_unavailable");
      const blocked = await readDeletionBlock(
        db,
        organisationId,
        command.projectId,
      );
      if (blocked !== null) return rejected(blocked);
      return {
        kind: "prepared",
        admission: {
          sql: `EXISTS (SELECT 1 FROM (${VISIBLE_PROJECTS}) p
              WHERE p.project_id = ? AND p.revision = ? AND p.access_revision = ?
                AND (p.access_kind = 'personal' OR p.member_role = 'owner')
                AND NOT EXISTS (SELECT 1 FROM organisation_default_project d
                  WHERE d.organisation_id = p.organisation_id AND d.project_id = p.project_id)
                AND NOT EXISTS (${BLOCKING_CASE}))`,
          bindings: [
            actor.userId,
            organisationId,
            command.projectId,
            command.expectedProjectRevision,
            command.expectedAccessRevision,
          ],
        },
        resultRevision: Math.max(command.expectedProjectRevision, 1),
        effects: (open) => [
          ...prepareReturnPrivateChatsToDefault(db, {
            organisationId,
            sourceProjectId: command.projectId,
            ownerUserId: null,
            now,
            guard: open,
          }),
          db
            .prepare(
              `DELETE FROM project WHERE organisation_id = ? AND project_id = ? AND ${open.sql}`,
            )
            .bind(organisationId, command.projectId, ...open.bindings),
        ],
      };
    }
    case "set_default_project": {
      // The Organisation's administrators choose where unnamed work goes, and
      // only into a shared Project they own.
      if (
        actor.organisationRole !== "owner" &&
        actor.organisationRole !== "admin"
      )
        return rejected("default_project_ineligible");
      const project = await readProject(db, scope, command.projectId);
      if (project === null) return rejected("project_unavailable");
      if (project.access.kind !== "shared" || project.access.role !== "owner")
        return rejected("default_project_ineligible");
      return {
        kind: "prepared",
        admission: {
          sql: `EXISTS (SELECT 1 FROM organisation_default_project d
              JOIN project p ON p.organisation_id = d.organisation_id AND p.project_id = ?
                AND p.access_kind = 'shared'
              JOIN service_role_grant tm ON tm.organisation_id = d.organisation_id
                AND tm.user_id = ? AND tm.status = 'active' AND tm.role IN ('owner', 'admin')
              JOIN project_member pm ON pm.organisation_id = p.organisation_id
                AND pm.project_id = p.project_id AND pm.user_id = tm.user_id AND pm.role = 'owner'
              WHERE d.organisation_id = ? AND d.revision = ?)`,
          bindings: [
            command.projectId,
            actor.userId,
            organisationId,
            command.expectedDefaultRevision,
          ],
        },
        resultRevision: command.expectedDefaultRevision + 1,
        effects: (open) => [
          db
            .prepare(
              `UPDATE organisation_default_project SET project_id = ?, revision = revision + 1, updated_at = ?
               WHERE organisation_id = ? AND revision = ? AND ${open.sql}`,
            )
            .bind(
              command.projectId,
              now,
              organisationId,
              command.expectedDefaultRevision,
              ...open.bindings,
            ),
        ],
      };
    }
    default:
      return assertNever(command);
  }
}

// Why a Project cannot be deleted now, if anything keeps it.
async function readDeletionBlock(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  projectId: ProjectId,
): Promise<Rejection | null> {
  const row = await db
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM organisation_default_project d
           WHERE d.organisation_id = p.organisation_id AND d.project_id = p.project_id) AS designated,
         EXISTS (SELECT 1 FROM portal_conversation c JOIN case_project cp
           ON cp.organisation_id = c.organisation_id AND cp.case_id = c.case_id
           WHERE c.organisation_id = p.organisation_id AND cp.project_id = p.project_id
             AND c.access_kind = 'shared') AS shared_chats,
         EXISTS (${BLOCKING_CASE}) AS cases
       FROM project p WHERE p.organisation_id = ? AND p.project_id = ?`,
    )
    .bind(organisationId, projectId)
    .first<{ designated: unknown; shared_chats: unknown; cases: unknown }>();
  if (row === null) return "project_unavailable";
  // The default Project stays until another one replaces it.
  if (row.designated === 1) return "project_is_default";
  if (row.shared_chats === 1) return "project_contains_shared_chats";
  if (row.cases === 1) return "project_contains_cases";
  return null;
}

async function readReceipt(
  db: OrganisationDatabase,
  scope: ProjectAccessScope,
  operationId: string,
  digest: string,
): Promise<ProjectCommandResult | null> {
  const row = await db
    .prepare(
      `SELECT command_digest, project_id, result_revision FROM project_operation
       WHERE organisation_id = ? AND actor_user_id = ? AND operation_id = ? AND applied = 1`,
    )
    .bind(scope.organisationId, scope.userId, operationId)
    .first<{
      command_digest: unknown;
      project_id: unknown;
      result_revision: unknown;
    }>();
  if (row === null) return null;
  if (row.command_digest !== digest)
    return rejected("project_operation_conflict");
  if (!isProjectId(row.project_id) || !isPositiveInteger(row.result_revision))
    throw new Error("project_operation_storage_invalid");
  return {
    kind: "accepted",
    projectId: row.project_id,
    revision: row.result_revision,
  };
}

function rejected(
  code: Rejection,
): Extract<ProjectCommandResult, { kind: "rejected" }> {
  return { kind: "rejected", code };
}
