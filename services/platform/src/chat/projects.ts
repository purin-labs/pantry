import type { OrganisationDatabase } from "../database-handles";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { UserId } from "../ids";
import { moveChatDirectoryEntry } from "./directory-move";
import type { Env } from "../env";
import { authorizeProject } from "../projects/access";
import { observeProjectReference } from "../projects/references";
import { VISIBLE_PROJECTS, parseProjectRecord } from "../projects/records";
import {
  parseChatPlacement,
  isProjectId,
  type ChatDirectoryCommand,
  type ChatDirectoryResult,
  type ChatPlacement,
  type Project,
  type ProjectDirectory,
} from "@seams/control-api";
import { assertNever, canonicalJson, sha256Hex } from "@seams/std";
import type { ConversationScope } from "./store";
import type { Variant } from "@seams/type-utils";

export type ConversationPlacementRow = Readonly<{
  project_id: unknown;
  manual_position: unknown;
  membership_revision: unknown;
}>;

const ACTIVE_PLACEMENT = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

const OPERATION_GUARD = `EXISTS (
  SELECT 1 FROM portal_chat_directory_operation o
  JOIN portal_chat_directory d ON d.organisation_id = o.organisation_id AND d.user_id = o.user_id
  WHERE o.organisation_id = ? AND o.user_id = ? AND o.operation_id = ?
    AND o.directory_revision = d.revision + 1
) AND ${ACTIVE_PLACEMENT}`;

export async function readProjectDirectory(
  db: OrganisationDatabase,
  scope: ConversationScope,
): Promise<ProjectDirectory> {
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        "SELECT COALESCE((SELECT revision FROM portal_chat_directory WHERE organisation_id = ? AND user_id = ?), 0) AS revision",
      )
      .bind(scope.organisationId, scope.userId),
    db
      .prepare(
        `${VISIBLE_PROJECTS} ORDER BY COALESCE((SELECT u.position FROM portal_chat_directory_project u
          WHERE u.organisation_id = p.organisation_id AND u.project_id = p.project_id AND u.user_id = tm.user_id), 2147483647), p.created_at ASC, p.project_id ASC`,
      )
      .bind(scope.userId, scope.organisationId),
    db
      .prepare(
        "SELECT project_id FROM organisation_default_project WHERE organisation_id = ?",
      )
      .bind(scope.organisationId),
  ]);
  const directory = results[0]?.results[0];
  const rows = results[1]?.results;
  const defaultProjectId = results[2]?.results[0]?.project_id;

  if (
    directory === undefined ||
    typeof directory.revision !== "number" ||
    !Number.isSafeInteger(directory.revision) ||
    directory.revision < 0
  )
    throw new Error("chat_directory_storage_invalid");
  if (!isProjectId(defaultProjectId))
    throw new Error("default_project_unavailable");
  return {
    placements: await readProjectPlacements(db, scope),
    revision: directory.revision,
    defaultProjectId,
    projects: (rows ?? []).map(parseProjectRecord),
  };
}

async function readProjectPlacements(
  db: OrganisationDatabase,
  scope: ConversationScope,
): Promise<ProjectDirectory["placements"]> {
  const rows = await db
    .prepare(
      `SELECT u.project_id, u.position, u.collapsed FROM portal_chat_directory_project u WHERE u.organisation_id = ? AND u.user_id = ?
    AND u.project_id IN (SELECT project_id FROM (${VISIBLE_PROJECTS}))`,
    )
    .bind(
      scope.organisationId,
      scope.userId,
      scope.userId,
      scope.organisationId,
    )
    .all<{ project_id: unknown; position: unknown; collapsed: unknown }>();
  const placements: ProjectDirectory["placements"][number][] = [];
  for (const row of rows.results) {
    if (
      !isProjectId(row.project_id) ||
      typeof row.position !== "number" ||
      !Number.isSafeInteger(row.position) ||
      row.position < 0 ||
      (row.collapsed !== 0 && row.collapsed !== 1)
    )
      throw new Error("project_placement_invalid");
    placements.push({
      projectId: row.project_id,
      position: row.position,
      collapsed: row.collapsed === 1,
    });
  }
  return placements;
}

export function parseConversationPlacement(
  row: ConversationPlacementRow,
): ChatPlacement {
  const placement = parseChatPlacement({
    projectId: row.project_id,
    membershipRevision: row.membership_revision,
    position: row.manual_position,
  });
  if (placement === null) throw new Error("chat_placement_storage_invalid");
  return placement;
}

// A member's own sidebar: the order of their Projects and of their chats.
// Project content, deletion and the default Project are general commands.
export async function mutateChatDirectory(
  execution: OrganisationExecutionScope,
  userId: UserId,
  command: ChatDirectoryCommand,
  now: number,
): Promise<ChatDirectoryResult> {
  const db = execution.database;
  const scope: ConversationScope = {
    organisationId: execution.organisationId,
    userId,
  };
  if (!(await execution.isActive()))
    return { kind: "rejected", code: "chat_directory_conflict" };
  const digest = await sha256Hex(canonicalJson(command));
  const replay = await readDirectoryOperation(
    db,
    scope,
    command.operationId,
    digest,
  );
  if (replay !== null) return replay;
  switch (command.kind) {
    case "move_chat": {
      const moved = await moveChatDirectoryEntry(
        execution,
        userId,
        command,
        digest,
        now,
      );
      const accepted = await readDirectoryOperation(
        db,
        scope,
        command.operationId,
        digest,
      );
      return accepted ?? moved;
    }
    case "set_project_placement": {
      const authorized = await authorizeProject(
        db,
        scope,
        command.projectId,
        "read",
      );
      if (authorized === null)
        return { kind: "rejected", code: "chat_destination_unavailable" };
      await db.batch(
        prepareProjectPlacement(execution, userId, command, digest, now),
      );
      const accepted = await readDirectoryOperation(
        db,
        scope,
        command.operationId,
        digest,
      );
      if (accepted !== null) return accepted;
      const directory = await readProjectDirectory(db, scope);
      if (directory.revision !== command.expectedDirectoryRevision)
        return { kind: "rejected", code: "chat_directory_conflict" };
      return { kind: "rejected", code: "chat_destination_unavailable" };
    }
    default:
      return assertNever(command);
  }
}

async function readDirectoryOperation(
  db: OrganisationDatabase,
  scope: ConversationScope,
  operationId: string,
  digest: string,
): Promise<ChatDirectoryResult | null> {
  const row = await db
    .prepare(
      "SELECT command_digest, directory_revision FROM portal_chat_directory_operation WHERE organisation_id = ? AND user_id = ? AND operation_id = ?",
    )
    .bind(scope.organisationId, scope.userId, operationId)
    .first<{ command_digest: string; directory_revision: number }>();
  if (row === null) return null;
  if (row.command_digest !== digest)
    return { kind: "rejected", code: "chat_operation_conflict" };
  return { kind: "accepted", directoryRevision: row.directory_revision };
}

function prepareProjectPlacement(
  execution: OrganisationExecutionScope,
  userId: UserId,
  command: Variant<ChatDirectoryCommand, "set_project_placement">,
  digest: string,
  now: number,
): D1PreparedStatement[] {
  const db = execution.database;
  const scope: ConversationScope = {
    organisationId: execution.organisationId,
    userId,
  };
  const fence = [
    execution.organisationId,
    execution.placement.placementEpoch,
    execution.placement.placementCellId,
    execution.fenceToken,
  ];
  const operation = [
    scope.organisationId,
    scope.userId,
    command.operationId,
    ...fence,
  ];
  return [
    prepareChatDirectoryInitialization(
      execution,
      scope.userId,
      command.expectedDirectoryRevision,
    ),
    db
      .prepare(
        `INSERT OR IGNORE INTO portal_chat_directory_operation (organisation_id, user_id, operation_id, command_digest, accepted_at, directory_revision, position)
        SELECT ?, ?, ?, ?, ?, d.revision + 1, 0 FROM portal_chat_directory d WHERE d.organisation_id = ? AND d.user_id = ? AND d.revision = ?
          AND EXISTS (SELECT 1 FROM (${VISIBLE_PROJECTS}) p WHERE p.project_id = ?) AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(
        scope.organisationId,
        scope.userId,
        command.operationId,
        digest,
        now,
        scope.organisationId,
        scope.userId,
        command.expectedDirectoryRevision,
        scope.userId,
        scope.organisationId,
        command.projectId,
        ...fence,
      ),
    db
      .prepare(
        `INSERT INTO portal_chat_directory_project (organisation_id, user_id, project_id, position, collapsed)
        SELECT ?, ?, ?, ?, ? WHERE ${OPERATION_GUARD}
        ON CONFLICT (organisation_id, user_id, project_id) DO UPDATE SET position = excluded.position, collapsed = excluded.collapsed`,
      )
      .bind(
        scope.organisationId,
        scope.userId,
        command.projectId,
        command.position,
        command.collapsed ? 1 : 0,
        ...operation,
      ),
    db
      .prepare(
        `UPDATE portal_chat_directory SET revision = revision + 1 WHERE organisation_id = ? AND user_id = ? AND revision = ? AND ${OPERATION_GUARD}`,
      )
      .bind(
        scope.organisationId,
        scope.userId,
        command.expectedDirectoryRevision,
        ...operation,
      ),
  ];
}

export function prepareChatDirectoryInitialization(
  execution: OrganisationExecutionScope,
  userId: UserId,
  expectedRevision: number,
): D1PreparedStatement {
  return execution.database
    .prepare(
      `INSERT OR IGNORE INTO portal_chat_directory (organisation_id, user_id, revision)
    SELECT ?, ?, 0 WHERE ? = 0 AND ${ACTIVE_PLACEMENT}`,
    )
    .bind(
      execution.organisationId,
      userId,
      expectedRevision,
      execution.organisationId,
      execution.placement.placementEpoch,
      execution.placement.placementCellId,
      execution.fenceToken,
    );
}

export async function readAuthorizedProjectDirectory(
  env: Env,
  execution: OrganisationExecutionScope,
  scope: ConversationScope,
): Promise<ProjectDirectory> {
  const directory = await readProjectDirectory(execution.database, scope);
  const projects: Project[] = [];
  for (const project of directory.projects) {
    const references: Project["references"][number][] = [];
    for (const reference of project.references) {
      const observation = await observeProjectReference(
        env,
        execution,
        scope,
        reference,
        Date.now(),
      );
      references.push(observation.reference);
    }
    projects.push({ ...project, references });
  }
  return {
    placements: directory.placements,
    revision: directory.revision,
    defaultProjectId: directory.defaultProjectId,
    projects,
  };
}
