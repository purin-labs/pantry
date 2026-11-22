import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { UserId } from "@purin-labs/control-api/ids";
import { verifyStoredDisclosureProof } from "./disclosure-evidence";
import {
  DISCLOSURE_STATE_FENCE_SQL,
  disclosureStateFenceBindings,
  type DisclosureProof,
} from "./disclosure-evidence";
import type { ChatDisclosureFailure } from "@purin-labs/control-api";
import {
  isConversationId,
  type ProjectId,
  type ConversationId,
} from "@purin-labs/control-api";
import { canonicalJson, isNonNegativeInteger, sha256Hex } from "@purin-labs/std";
import type { Env } from "@purin-labs/kernel/env";
import type { ConversationScope } from "./store";
import { readConversation } from "./store";
import { holdsAdmittedWork } from "./conversation";
import {
  authorizeConversation,
  VISIBLE_CONVERSATIONS_SQL,
} from "./conversation-access";
import { authorizeProject, listProjectMembers } from "../projects/access";
import { checkConversationDisclosure } from "./conversation-disclosure";
import { ConversationAudienceProposal } from "./disclosure-evidence";

export type ConversationSharingCommand = Readonly<{
  kind: "share_conversation" | "move_shared_conversation";
  operationId: string;
  projectId: ProjectId;
  expectedRevision: number;
  expectedProjectAccessRevision: number;
}>;
type ConversationSharingResult =
  | ChatDisclosureFailure
  | Readonly<{ kind: "accepted"; revision: number }>
  | Readonly<{
      kind: "rejected";
      code:
        | "chat_not_found"
        | "chat_share_conflict"
        | "chat_destination_unavailable"
        | "chat_work_unfinished"
        | "idempotency_key_conflict";
    }>;

export async function shareConversation(
  env: Env,
  execution: OrganisationExecutionScope,
  userId: UserId,
  conversationId: ConversationId,
  command: ConversationSharingCommand,
): Promise<ConversationSharingResult> {
  const db = execution.database;
  const scope: ConversationScope = {
    organisationId: execution.organisationId,
    userId,
  };
  if (!(await execution.isActive()))
    return { kind: "rejected", code: "chat_share_conflict" };
  const fence = [
    execution.organisationId,
    execution.placement.placementEpoch,
    execution.placement.placementCellId,
    execution.fenceToken,
  ];
  const access = await authorizeConversation(db, scope, conversationId);
  if (access === null) return { kind: "rejected", code: "chat_not_found" };
  if (access.access.kind === "workspace_canvas")
    return { kind: "rejected", code: "chat_destination_unavailable" };
  const digest = await sha256Hex(canonicalJson({ conversationId, command }));
  const replay = await readSharingOperation(
    db,
    scope,
    command.operationId,
    digest,
  );
  if (replay !== null) return replay;
  if (
    (command.kind === "share_conversation") !==
      (access.access.kind === "private") ||
    access.role !== "owner"
  )
    return { kind: "rejected", code: "chat_destination_unavailable" };
  const destination = await authorizeProject(
    db,
    scope,
    command.projectId,
    command.kind === "share_conversation" ? "contribute" : "move_shared_chat",
  );
  if (destination === null || destination.access.kind !== "shared")
    return { kind: "rejected", code: "chat_destination_unavailable" };
  let source: Awaited<ReturnType<typeof readConversation>>;
  try {
    source = await readConversation(db, scope, conversationId);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "project_evidence_unavailable"
    )
      return {
        kind: "rejected",
        code: "chat_history_unavailable",
        reason: "evidence_unavailable",
      };
    throw error;
  }
  if (source === null) return { kind: "rejected", code: "chat_not_found" };
  if (
    source.revision !== command.expectedRevision ||
    destination.access.accessRevision !== command.expectedProjectAccessRevision
  )
    return (
      (await readSharingOperation(db, scope, command.operationId, digest)) ?? {
        kind: "rejected",
        code: "chat_share_conflict",
      }
    );
  // Sharing into another Project moves the chat there. The admission below is
  // fenced on the revision this state was read at.
  if (
    source.placement.projectId !== command.projectId &&
    holdsAdmittedWork(
      source.conversation.work,
      source.conversation.pendingInputs.length,
    )
  )
    return { kind: "rejected", code: "chat_work_unfinished" };
  const members = await listProjectMembers(db, scope, command.projectId);
  if (members === null)
    return { kind: "rejected", code: "chat_destination_unavailable" };
  const proposal = await ConversationAudienceProposal.prepare(
    db,
    scope,
    conversationId,
    command,
  );
  if (proposal === null)
    return { kind: "rejected", code: "chat_share_conflict" };
  const disclosure = await checkConversationDisclosure(
    env,
    execution,
    scope,
    source.conversation,
    members.map(memberUserId),
    "sharing",
    { kind: "conversation_admission", proposal },
  );
  if (disclosure.kind === "rejected") return disclosure;
  const nextRevision = source.revision + 1;
  const guard = `EXISTS (SELECT 1 FROM portal_chat_conversation_access_operation o WHERE o.organisation_id = ?
    AND o.actor_user_id = ? AND o.operation_id = ? AND o.command_digest = ? AND o.conversation_revision = portal_conversation.revision + 1) AND ${ACTIVE_PLACEMENT}`;
  await db.batch([
    db
      .prepare(
        `${VISIBLE_CONVERSATIONS_SQL}
      INSERT OR IGNORE INTO portal_chat_conversation_access_operation
        (organisation_id, conversation_id, actor_user_id, operation_id, command_digest, conversation_revision, project_id, access_revision, accepted_at, disclosure_proof_json)
      SELECT c.organisation_id, c.conversation_id, ?, ?, ?, ?, p.project_id, p.access_revision, ?, ? FROM visible_conversation c
      JOIN project p ON p.organisation_id = c.organisation_id AND p.project_id = ? AND p.access_kind = 'shared'
      JOIN project_member pm ON pm.organisation_id = p.organisation_id AND pm.project_id = p.project_id AND pm.user_id = ?
      WHERE c.conversation_id = ? AND c.revision = ? AND c.active_user_id IS NULL
        AND c.access_revision = ? AND p.access_revision = ? AND c.lifecycle = 'active'
        AND json_array_length(json_extract(c.state_json, '$.pendingInputs')) = 0
        AND (c.access_kind = 'private' OR c.member_role = 'owner')
        AND pm.role IN (${command.kind === "share_conversation" ? "'owner', 'editor'" : "'owner'"})
        AND ${DISCLOSURE_STATE_FENCE_SQL} AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(
        scope.organisationId,
        scope.userId,
        scope.userId,
        command.operationId,
        digest,
        nextRevision,
        Date.now(),
        canonicalJson(disclosure.proof),
        command.projectId,
        scope.userId,
        conversationId,
        source.revision,
        access.accessRevision,
        destination.access.accessRevision,
        ...disclosureStateFenceBindings(disclosure.proof.state, scope),
        ...fence,
      ),
    // The Case moves first: a chat may only become shared inside a shared Project.
    db
      .prepare(
        `UPDATE case_project SET project_id = ?, revision = revision + 1, updated_at = ?
      WHERE organisation_id = ? AND case_id = (SELECT portal_conversation.case_id FROM portal_conversation
        WHERE organisation_id = ? AND conversation_id = ? AND ${guard})`,
      )
      .bind(
        command.projectId,
        Date.now(),
        scope.organisationId,
        scope.organisationId,
        conversationId,
        scope.organisationId,
        scope.userId,
        command.operationId,
        digest,
        ...fence,
      ),
    db
      .prepare(
        `UPDATE portal_conversation SET access_kind = 'shared', revision = revision + 1
      WHERE organisation_id = ? AND conversation_id = ? AND ${guard}`,
      )
      .bind(
        scope.organisationId,
        conversationId,
        scope.organisationId,
        scope.userId,
        command.operationId,
        digest,
        ...fence,
      ),
    db
      .prepare(
        `UPDATE portal_chat_directory SET revision = revision + 1 WHERE organisation_id = ? AND changes() = 1`,
      )
      .bind(scope.organisationId),
  ]);
  return (
    (await readSharingOperation(db, scope, command.operationId, digest)) ?? {
      kind: "rejected",
      code: "chat_share_conflict",
    }
  );
}

async function readSharingOperation(
  db: OrganisationDatabase,
  scope: ConversationScope,
  operationId: string,
  digest: string,
): Promise<ConversationSharingResult | null> {
  const row = await db
    .prepare(
      `SELECT command_digest, conversation_revision, disclosure_proof_json FROM portal_chat_conversation_access_operation
    WHERE organisation_id = ? AND actor_user_id = ? AND operation_id = ?`,
    )
    .bind(scope.organisationId, scope.userId, operationId)
    .first<{
      command_digest: unknown;
      conversation_revision: unknown;
      disclosure_proof_json: unknown;
    }>();
  if (row === null) return null;
  if (row.command_digest !== digest)
    return { kind: "rejected", code: "idempotency_key_conflict" };
  if (!isNonNegativeInteger(row.conversation_revision))
    throw new Error("chat_share_receipt_invalid");
  if (
    typeof row.disclosure_proof_json !== "string" ||
    !(await verifyStoredDisclosureProof(JSON.parse(row.disclosure_proof_json)))
  ) {
    return {
      kind: "rejected",
      code: "chat_history_unavailable",
      reason: "evidence_unavailable",
    };
  }
  return { kind: "accepted", revision: row.conversation_revision };
}

export async function checkProjectHistoryDisclosure(
  env: Env,
  execution: OrganisationExecutionScope,
  scope: ConversationScope,
  projectId: ProjectId,
  audience: readonly import("@purin-labs/control-api").UserId[],
  destination: import("./disclosure-evidence").DisclosureDestination,
): Promise<
  | Readonly<{
      kind: "allowed";
      revisions: readonly Readonly<{ id: ConversationId; revision: number }>[];
      proofs: readonly DisclosureProof[];
    }>
  | Exclude<
      Awaited<ReturnType<typeof checkConversationDisclosure>>,
      { kind: "allowed" }
    >
> {
  const rows = await execution.database
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    SELECT conversation_id FROM visible_conversation WHERE access_kind = 'shared' AND project_id = ?`,
    )
    .bind(scope.organisationId, scope.userId, projectId)
    .all<{ conversation_id: unknown }>();
  const revisions: { id: ConversationId; revision: number }[] = [];
  const proofs: DisclosureProof[] = [];
  for (const row of rows.results) {
    if (!isConversationId(row.conversation_id))
      throw new Error("chat_storage_invalid");
    let stored: Awaited<ReturnType<typeof readConversation>>;
    try {
      stored = await readConversation(
        execution.database,
        scope,
        row.conversation_id,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "project_evidence_unavailable"
      )
        return {
          kind: "rejected",
          code: "chat_history_unavailable",
          reason: "evidence_unavailable",
        };
      throw error;
    }
    if (stored === null)
      return {
        kind: "rejected",
        code: "chat_history_unavailable",
        reason: "evidence_unavailable",
      };
    const disclosure = await checkConversationDisclosure(
      env,
      execution,
      scope,
      stored.conversation,
      audience,
      "sharing",
      destination,
    );
    if (disclosure.kind === "rejected") return disclosure;
    revisions.push({ id: row.conversation_id, revision: stored.revision });
    proofs.push(disclosure.proof);
  }
  return { kind: "allowed", revisions, proofs };
}

function memberUserId(member: {
  userId: import("@purin-labs/control-api").UserId;
}): import("@purin-labs/control-api").UserId {
  return member.userId;
}

const ACTIVE_PLACEMENT = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;
