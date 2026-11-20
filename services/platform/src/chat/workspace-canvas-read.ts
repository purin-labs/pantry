import type { ConversationId } from "@purin-labs/control-api";
import { canonicalJson, sha256Hex } from "@purin-labs/std";
import type { Env } from "../env";
import type { UserId } from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { authorizeConversation } from "./conversation-access";
import { checkConversationDisclosure } from "./conversation-disclosure";
import { readDisclosureState } from "./disclosure-evidence";
import { publicConversation } from "./public-conversation";
import {
  readConversation,
  readConversationStatus,
  reconcileRevokedConversationRun,
} from "./store";
import { reconcileFailedConversationTurn } from "./turn/failure";
import {
  canvasConversationMatches,
  listCanvasConversations,
  type CanvasChatSelection,
  type CanvasConversation,
} from "./workspace-canvas";

/**
 * The chat panel of a workflow canvas page: the Portal shape of the chat
 * that the page selected. The canvas chat records stay in
 * `./workspace-canvas.ts`.
 */
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
