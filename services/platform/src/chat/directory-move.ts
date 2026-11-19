import {
  isConversationId,
  type ChatDirectoryCommand,
  type ChatDirectoryResult,
  type ConversationId,
} from "@purin-labs/control-api";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { UserId } from "../ids";
import { prepareChatDirectoryInitialization } from "./projects";
import type { ConversationScope } from "./store";
import { readConversation, reconcileRevokedConversationRun } from "./store";
import { holdsAdmittedWork } from "./conversation";
import {
  authorizeConversation,
  VISIBLE_CONVERSATIONS_SQL,
} from "./conversation-access";
import { authorizeProject } from "../projects/access";
import { readDefaultProjectId } from "../projects/case-project";
import type { Variant } from "@purin-labs/type-utils";

type MoveCommand = Variant<ChatDirectoryCommand, "move_chat">;

export async function moveChatDirectoryEntry(
  execution: OrganisationExecutionScope,
  userId: UserId,
  command: MoveCommand,
  digest: string,
  now: number,
): Promise<ChatDirectoryResult> {
  const db = execution.database;
  const scope: ConversationScope = {
    organisationId: execution.organisationId,
    userId,
  };
  await reconcileRevokedConversationRun(
    execution,
    userId,
    command.conversationId,
  );
  const source = await readConversation(db, scope, command.conversationId);
  const access = await authorizeConversation(db, scope, command.conversationId);
  if (
    source === null ||
    access === null ||
    source.metadata.lifecycle !== "active"
  )
    return { kind: "rejected", code: "chat_not_found" };
  if (
    source.placement.membershipRevision !== command.expectedMembershipRevision
  )
    return { kind: "rejected", code: "chat_directory_conflict" };
  const destination = command.destination.projectId;
  const changesProject = destination !== source.placement.projectId;
  if (changesProject && access.execution.kind === "active")
    return { kind: "rejected", code: "chat_running" };
  // The admission below is fenced on the revision this state was read at.
  if (
    changesProject &&
    holdsAdmittedWork(
      source.conversation.work,
      source.conversation.pendingInputs.length,
    )
  )
    return { kind: "rejected", code: "chat_work_unfinished" };
  if (changesProject && access.access.kind !== "private")
    return { kind: "rejected", code: "chat_destination_unavailable" };
  // A member may always return their own chat to the default Project. Any
  // other destination needs their access to it.
  const project = await authorizeProject(db, scope, destination, "read");
  if (
    project === null &&
    (await readDefaultProjectId(db, scope.organisationId)) !== destination
  )
    return { kind: "rejected", code: "chat_destination_unavailable" };
  const rows = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    SELECT conversation_id FROM visible_conversation WHERE lifecycle = 'active' AND project_id = ?
    ORDER BY manual_position, conversation_id`,
    )
    .bind(scope.organisationId, scope.userId, destination)
    .all<{ conversation_id: unknown }>();
  const original = rows.results.map(conversationRowId);
  const order = original.filter(
    otherConversation.bind(null, command.conversationId),
  );
  const index =
    command.insertion.kind === "end"
      ? order.length
      : order.indexOf(command.insertion.conversationId);
  if (index < 0)
    return { kind: "rejected", code: "chat_destination_unavailable" };
  order.splice(index, 0, command.conversationId);
  const unchanged = !changesProject && original.join("\n") === order.join("\n");
  const nextRevision = command.expectedDirectoryRevision + (unchanged ? 0 : 1);
  const placementGuard = `EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
    AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`;
  const fence = [
    execution.organisationId,
    execution.placement.placementEpoch,
    execution.placement.placementCellId,
    execution.fenceToken,
  ];
  const guard = `EXISTS (SELECT 1 FROM portal_chat_directory_operation o JOIN portal_chat_directory d
    ON d.organisation_id = o.organisation_id AND d.user_id = o.user_id
    WHERE o.organisation_id = ? AND o.user_id = ? AND o.operation_id = ? AND o.command_digest = ?
      AND d.revision = ? AND o.directory_revision = ?) AND ${placementGuard}`;
  const receipt = [
    scope.organisationId,
    scope.userId,
    command.operationId,
    digest,
    command.expectedDirectoryRevision,
    nextRevision,
    ...fence,
  ];
  const statements = [
    prepareChatDirectoryInitialization(
      execution,
      userId,
      command.expectedDirectoryRevision,
    ),
    db
      .prepare(
        `${VISIBLE_CONVERSATIONS_SQL}
    INSERT OR IGNORE INTO portal_chat_directory_operation
      (organisation_id, user_id, operation_id, command_digest, accepted_at, directory_revision, position)
    SELECT ?, ?, ?, ?, ?, ?, ? FROM portal_chat_directory d
    JOIN visible_conversation c ON c.organisation_id = d.organisation_id AND c.conversation_id = ?
    WHERE d.organisation_id = ? AND d.user_id = ? AND d.revision = ?
      AND c.revision = ? AND c.membership_revision = ? AND c.lifecycle = 'active'
      AND (? = 0 OR c.active_user_id IS NULL)
      AND EXISTS (SELECT 1 FROM project p WHERE p.organisation_id = d.organisation_id AND p.project_id = ?
        AND ((p.access_revision = ? AND (p.user_id = d.user_id OR EXISTS (
            SELECT 1 FROM project_member pm WHERE pm.organisation_id = p.organisation_id AND pm.project_id = p.project_id AND pm.user_id = d.user_id)))
          OR EXISTS (SELECT 1 FROM organisation_default_project dp
            WHERE dp.organisation_id = p.organisation_id AND dp.project_id = p.project_id))) AND ${placementGuard}`,
      )
      .bind(
        scope.organisationId,
        scope.userId,
        scope.organisationId,
        scope.userId,
        command.operationId,
        digest,
        now,
        nextRevision,
        index,
        command.conversationId,
        scope.organisationId,
        scope.userId,
        command.expectedDirectoryRevision,
        source.revision,
        command.expectedMembershipRevision,
        changesProject ? 1 : 0,
        destination,
        project?.access.accessRevision ?? 0,
        ...fence,
      ),
  ];
  if (!unchanged) {
    statements.push(
      db
        .prepare(
          `${VISIBLE_CONVERSATIONS_SQL}
      INSERT OR IGNORE INTO portal_conversation_user (organisation_id, user_id, conversation_id)
      SELECT organisation_id, ?, conversation_id FROM visible_conversation WHERE ${guard}`,
        )
        .bind(scope.organisationId, scope.userId, scope.userId, ...receipt),
    );
    statements.push(
      db
        .prepare(
          `UPDATE portal_conversation_user SET manual_position = (
      SELECT CAST(key AS INTEGER) FROM json_each(?) WHERE value = portal_conversation_user.conversation_id)
      WHERE organisation_id = ? AND user_id = ? AND conversation_id IN (SELECT value FROM json_each(?)) AND ${guard}`,
        )
        .bind(
          JSON.stringify(order),
          scope.organisationId,
          scope.userId,
          JSON.stringify(order),
          ...receipt,
        ),
    );
    if (changesProject)
      statements.push(
        db
          .prepare(
            `UPDATE case_project SET project_id = ?, revision = revision + 1, updated_at = ?
      WHERE organisation_id = ? AND case_id = (SELECT c.case_id FROM portal_conversation c
        WHERE c.organisation_id = ? AND c.conversation_id = ?) AND ${guard}`,
          )
          .bind(
            destination,
            now,
            scope.organisationId,
            scope.organisationId,
            command.conversationId,
            ...receipt,
          ),
        db
          .prepare(
            `UPDATE portal_conversation SET revision = revision + 1
      WHERE organisation_id = ? AND conversation_id = ? AND ${guard}`,
          )
          .bind(scope.organisationId, command.conversationId, ...receipt),
      );
    statements.push(
      db
        .prepare(
          `UPDATE portal_chat_directory SET revision = ? WHERE organisation_id = ? AND user_id = ? AND ${guard}`,
        )
        .bind(nextRevision, scope.organisationId, scope.userId, ...receipt),
    );
  }
  const [, admission] = await db.batch(statements);
  return admission?.meta.changes === 1
    ? { kind: "accepted", directoryRevision: nextRevision }
    : { kind: "rejected", code: "chat_directory_conflict" };
}

function conversationRowId(row: { conversation_id: unknown }): ConversationId {
  if (!isConversationId(row.conversation_id))
    throw new Error("chat_directory_storage_invalid");
  return row.conversation_id;
}
function otherConversation(
  id: ConversationId,
  candidate: ConversationId,
): boolean {
  return id !== candidate;
}
