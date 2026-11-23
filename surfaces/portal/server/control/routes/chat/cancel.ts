import { isConversationId, type ConversationId } from "@purin-labs/control-api";
import type { Env } from "@purin-labs/kernel/env";
import { parseRequestId, parseSessionId } from "@purin-labs/kernel/ids";
import { resolveOrganisationModelRoute } from "@purin-labs/agent/models/route";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
} from "@purin-labs/control/worker/http";
import {
  isChatId,
  conversationTimeline,
  type Conversation,
} from "@purin-labs/conversation/chat/conversation";
import {
  readConversation,
  reconcileRevokedConversationRun,
  saveConversation,
  type ConversationScope,
} from "@purin-labs/conversation/chat/store";
import {
  type CancellingConversationExecution,
  scheduleConversationExecution,
  settleCancellingConversation,
} from "../../../chat/application";
import {
  timelineEventIsCancellation,
  timelineEventHasId,
} from "../../../chat/turn/admission";
import { selectStoredConversationModel } from "@purin-labs/conversation/chat/turn/model";
import { publicConversation } from "../../../chat/public-conversation";
import { chatError, chatSaveError } from "./errors";

export async function handlePortalChatCancel(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok || !isExactCancelBody(body.value))
    return controlError("chat_cancel_request_invalid", 422);
  const requestId = parseRequestId(body.value.requestId);
  const sessionId = parseSessionId(body.value.sessionId);
  if (!requestId.ok || !sessionId.ok)
    return controlError("chat_cancel_request_invalid", 422);
  const scope: ConversationScope = {
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
  };
  const placement = authorized.executionScope;

  await reconcileRevokedConversationRun(
    placement,
    scope.userId,
    body.value.conversationId,
  );
  const stored = await readConversation(
    authorized.executionScope.database,
    scope,
    body.value.conversationId,
  );
  if (stored === null)
    return chatError("chat_not_found", "This chat no longer exists.", 404);
  const priorCancellation = conversationTimeline(stored.conversation).find(
    timelineEventHasId.bind(null, body.value.cancellationId),
  );
  if (priorCancellation !== undefined)
    return timelineEventIsCancellation(
      body.value.cancellationId,
      body.value.requestId,
      priorCancellation,
    )
      ? controlJson({
          conversation: publicConversation(
            stored.conversation,
            stored.metadata,
            stored.revision,
          ),
        })
      : chatError(
          "idempotency_key_conflict",
          "This cancellation ID was already used.",
          409,
        );
  const work = stored.conversation.work;
  if (
    (work.kind !== "running" && work.kind !== "cancelling") ||
    work.requestId !== body.value.requestId ||
    work.stream.sessionId !== sessionId.value ||
    work.stream.turnId !== body.value.turnId ||
    (work.kind === "cancelling" &&
      work.cancellationId !== body.value.cancellationId)
  )
    return chatError(
      "chat_cancel_conflict",
      "That response is no longer running.",
      409,
    );
  const cancelling: Conversation =
    work.kind === "cancelling"
      ? stored.conversation
      : {
          ...stored.conversation,
          work: {
            kind: "cancelling",
            requestId: work.requestId,
            cancellationId: body.value.cancellationId,
            lease: work.lease,
            expiresAt: work.expiresAt,
            stream: work.stream,
          },
        };
  let revision = stored.revision;
  if (work.kind === "running") {
    const saved = await saveConversation(
      placement,
      scope.userId,
      cancelling,
      stored.revision,
    );
    if (saved.kind !== "saved") return chatSaveError(saved);
    revision += 1;
  }
  const cancellationExecution = {
    placement,
    controlSessionId: authorized.authenticated.session.controlSessionId,
    env,
    scope,
    conversation: cancelling,
    revision,
  } satisfies CancellingConversationExecution;
  const settled = await settleCancellingConversation(cancellationExecution);
  if (settled === null)
    return chatError(
      "chat_cancel_unavailable",
      "The response could not be stopped. Retry in a moment.",
      409,
    );
  const workspaceModel = await resolveOrganisationModelRoute({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  if (workspaceModel.ok) {
    const selectedModel = selectStoredConversationModel(
      workspaceModel.value,
      settled.conversation,
    );
    if (selectedModel.ok) {
      await scheduleConversationExecution(env, {
        placement,
        scope,
        conversation: settled.conversation,
        controlSessionId: cancellationExecution.controlSessionId,
      });
    }
  }
  return controlJson({
    conversation: publicConversation(
      settled.conversation,
      stored.metadata,
      settled.revision,
    ),
  });
}

function isExactCancelBody(raw: Readonly<Record<string, unknown>>): raw is {
  readonly conversationId: ConversationId;
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly cancellationId: string;
} {
  return (
    Object.keys(raw).length === 5 &&
    isConversationId(raw.conversationId) &&
    isChatId(raw.requestId) &&
    typeof raw.sessionId === "string" &&
    raw.sessionId.length > 0 &&
    typeof raw.turnId === "string" &&
    raw.turnId.length > 0 &&
    isChatId(raw.cancellationId)
  );
}
