import {
  readConversation,
  readConversationStatus,
  reconcileRevokedConversationRun,
} from "./store";
import { reconcileFailedConversationTurn } from "./turn/failure";
import { checkConversationDisclosure } from "./conversation-disclosure";
import { readDisclosureState } from "./disclosure-evidence";
import { publicConversation } from "./public-conversation";
import { isConversationId, type ConversationId } from "@purin-labs/control-api";
import { canonicalJson, sha256Hex, isPositiveInteger } from "@purin-labs/std";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { UserId } from "../ids";
import type { Env } from "../env";
import { resolveOrganisationModelRoute } from "../models/route";
import type { Conversation } from "./conversation";
import {
  conversationCaseId,
  initialConversationCaseIdentity,
} from "./conversation-actor-identity";
import { prepareMemberCaseProject } from "../projects/case-project";
import { signalChat } from "./signals";
import {
  authorizeConversation,
  currentCanvasConversation,
  VISIBLE_CONVERSATIONS_SQL,
} from "./conversation-access";

export type CanvasChatSelection =
  | Readonly<{ kind: "current"; conversationId?: never }>
  | Readonly<{ kind: "history"; conversationId: ConversationId }>;

type CanvasConversation = Readonly<{ id: ConversationId; generation: number }>;

async function listCanvasConversations(
  execution: OrganisationExecutionScope,
  userId: UserId,
  documentId: string,
): Promise<readonly CanvasConversation[]> {
  const rows = await execution.database
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    SELECT conversation_id, canvas_generation FROM visible_conversation
    WHERE access_kind = 'workspace_canvas' AND canvas_document_id = ? ORDER BY canvas_generation DESC`,
    )
    .bind(execution.organisationId, userId, documentId)
    .all<{ conversation_id: unknown; canvas_generation: unknown }>();
  const conversations: CanvasConversation[] = [];
  for (const row of rows.results) {
    if (
      !isConversationId(row.conversation_id) ||
      !isPositiveInteger(row.canvas_generation)
    )
      throw new Error("canvas_chat_storage_invalid");
    conversations.push({
      id: row.conversation_id,
      generation: row.canvas_generation,
    });
  }
  return conversations;
}

/** The caller validates the source before creating a conversation. */
export async function ensureWorkspaceCanvasChat(
  env: Env,
  execution: OrganisationExecutionScope,
  userId: UserId,
  documentId: string,
): Promise<ConversationId> {
  const current = await currentCanvasConversation(
    execution.database,
    { organisationId: execution.organisationId, userId },
    documentId,
  );
  if (current !== null) return current;
  return createCanvasConversation(env, execution, userId, documentId, 1, null);
}

export async function continueWorkspaceCanvasChat(
  env: Env,
  execution: OrganisationExecutionScope,
  userId: UserId,
  documentId: string,
  previousId: ConversationId,
): Promise<ConversationId> {
  const conversations = await listCanvasConversations(
    execution,
    userId,
    documentId,
  );
  const previous = conversations.find(
    canvasConversationMatches.bind(null, previousId),
  );
  if (previous === undefined) throw new Error("canvas_chat_unavailable");
  const next = conversations.find(
    canvasGenerationMatches.bind(null, previous.generation + 1),
  );
  if (next !== undefined) return next.id;
  const access = await authorizeConversation(
    execution.database,
    { organisationId: execution.organisationId, userId },
    previousId,
  );
  if (access === null || access.role === "viewer")
    throw new Error("canvas_chat_read_only");
  const stored = await readConversation(
    execution.database,
    { organisationId: execution.organisationId, userId },
    previousId,
  );
  if (
    stored === null ||
    (stored.conversation.work.kind !== "ready" &&
      stored.conversation.work.kind !== "failed")
  )
    throw new Error("canvas_chat_running");
  return createCanvasConversation(
    env,
    execution,
    userId,
    documentId,
    previous.generation + 1,
    { id: previousId, revision: stored.revision },
  );
}
function canvasConversationMatches(
  id: ConversationId,
  conversation: CanvasConversation,
): boolean {
  return conversation.id === id;
}
function canvasGenerationMatches(
  generation: number,
  conversation: CanvasConversation,
): boolean {
  return conversation.generation === generation;
}

async function createCanvasConversation(
  env: Env,
  execution: OrganisationExecutionScope,
  userId: UserId,
  documentId: string,
  generation: number,
  previous: Readonly<{ id: ConversationId; revision: number }> | null,
): Promise<ConversationId> {
  const digest = await sha256Hex(
    `${execution.organisationId}:canvas:${documentId}:${generation}`,
  );
  const id = `conv_${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  if (!isConversationId(id)) throw new Error("canvas_chat_identity_invalid");
  const model = await resolveOrganisationModelRoute({
    env,
    organisationId: execution.organisationId,
    now: Date.now(),
  });
  if (!model.ok) throw new Error("canvas_chat_model_unavailable");
  const conversation: Conversation = {
    id,
    title: "Shared canvas chat",
    lineage: { kind: "original" },
    historyBindings: [],
    modelRoute: model.value,
    documents: [],
    work: { kind: "ready" },
    completedRequests: [],
    timeline: [],
    pendingInputs: [],
    latestSequence: 0,
    lastReadSequence: 0,
    surfaceEventCursor: 0,
    draftText: "",
    draftUpdatedAt: null,
    effort: null,
  };
  const scope = { organisationId: execution.organisationId, userId };
  const actorIdentity = initialConversationCaseIdentity(scope, id);
  const caseId = await conversationCaseId(actorIdentity);
  const now = Date.now();
  const successor = {
    sql: `(? IS NULL OR EXISTS (SELECT 1 FROM portal_conversation c WHERE c.organisation_id = ? AND c.conversation_id = ?
        AND c.revision = ? AND c.active_user_id IS NULL AND json_extract(c.state_json,'$.work.kind') IN ('ready','failed')))`,
    bindings: [
      previous?.id ?? null,
      execution.organisationId,
      previous?.id ?? null,
      previous?.revision ?? null,
    ],
  };
  await execution.database.batch([
    // A canvas chat's Case is filed in the default Project and inherits nothing from it.
    prepareMemberCaseProject(execution, {
      userId,
      caseId,
      origin: "canvas_chat",
      projectId: null,
      now,
      condition: successor,
    }),
    execution.database
      .prepare(
        `INSERT OR IGNORE INTO portal_conversation
    (organisation_id,user_id,conversation_id,case_id,access_kind,canvas_document_id,canvas_generation,revision,state_json,state_format,title_normalized,updated_at,last_activity_at)
    SELECT ?,?,?,?,'workspace_canvas',?,?,1,json_set(?,'$.actorIdentity',?),3,'shared canvas chat',?,?
    FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active'
      AND EXISTS (SELECT 1 FROM service_role_grant WHERE organisation_id = ? AND user_id = ? AND status = 'active')
      AND EXISTS (SELECT 1 FROM case_project cp WHERE cp.organisation_id = ? AND cp.case_id = ?)
      AND ${successor.sql}`,
      )
      .bind(
        execution.organisationId,
        userId,
        id,
        caseId,
        documentId,
        generation,
        JSON.stringify(conversation),
        actorIdentity,
        now,
        now,
        execution.organisationId,
        execution.placement.placementEpoch,
        execution.placement.placementCellId,
        execution.fenceToken,
        execution.organisationId,
        userId,
        execution.organisationId,
        caseId,
        ...successor.bindings,
      ),
  ]);
  const created = await authorizeConversation(execution.database, scope, id);
  if (
    !(await execution.isActive()) ||
    created?.access.kind !== "workspace_canvas" ||
    created.access.documentId !== documentId
  )
    throw new Error("canvas_chat_changed");
  // The canvas's open pages read the new current conversation.
  signalChat(execution, { kind: "conversation", conversationId: id });
  return id;
}

export async function readWorkspaceCanvasChat(
  env: Env,
  execution: OrganisationExecutionScope,
  userId: UserId,
  documentId: string,
  selection: CanvasChatSelection,
  after: string | null,
): Promise<
  | Readonly<{ kind: "pending" | "restricted" | "unchanged" }>
  | Readonly<{
      kind: "ready";
      conversation: Record<string, unknown>;
      model: string;
      cursor: string;
      currentConversationId: ConversationId;
      conversations: readonly CanvasConversation[];
    }>
> {
  const conversations = await listCanvasConversations(
    execution,
    userId,
    documentId,
  );
  const current = conversations[0];
  if (current === undefined) throw new Error("canvas_chat_unavailable");
  const id =
    selection.kind === "current" ? current.id : selection.conversationId;
  if (!conversations.some(canvasConversationMatches.bind(null, id)))
    throw new Error("canvas_chat_unavailable");
  const scope = { organisationId: execution.organisationId, userId };
  await reconcileRevokedConversationRun(execution, userId, id);
  const status = await readConversationStatus(execution.database, scope, id);
  const disclosureState = await readDisclosureState(execution.database, scope);
  if (status === null || disclosureState === null)
    return { kind: "restricted" };
  const cursor = await sha256Hex(
    canonicalJson({
      id,
      revision: status.revision,
      disclosureState,
      conversations,
      userId,
    }),
  );
  // Only settled, unchanged projections skip history reads. Membership and all
  // policy/grant/account/project revisions are still checked on every request.
  if (status.work.kind === "ready" && after === cursor) {
    if (
      !(await execution.isActive()) ||
      (await authorizeConversation(execution.database, scope, id)) === null
    )
      return { kind: "restricted" };
    return { kind: "unchanged" };
  }
  let stored = await readConversation(execution.database, scope, id);
  if (stored === null) throw new Error("canvas_chat_unavailable");
  stored = await reconcileFailedConversationTurn(
    env,
    execution,
    userId,
    stored,
  );
  if (stored === null) throw new Error("canvas_chat_unavailable");
  const disclosure = await checkConversationDisclosure(
    env,
    execution,
    scope,
    stored.conversation,
    [userId],
    "viewing",
  );
  if (disclosure.kind !== "allowed")
    return {
      kind:
        disclosure.code === "chat_history_unavailable"
          ? "pending"
          : "restricted",
    };
  if (
    !(await execution.isActive()) ||
    (await authorizeConversation(execution.database, scope, id)) === null
  )
    return { kind: "restricted" };
  return {
    kind: "ready",
    conversation: publicConversation(
      stored.conversation,
      stored.metadata,
      stored.revision,
    ),
    model: stored.conversation.modelRoute.model,
    cursor,
    currentConversationId: current.id,
    conversations,
  };
}
