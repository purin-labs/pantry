import { isConversationId } from "@purin-labs/control-api";
import type { Env } from "../../../env";
import { buildControlAuthority } from "../../../request-authority";
import { readActiveOrganisationMembershipRevision } from "../../../data/control-plane";
import { authorizeOrganisationRequest } from "../../authorization";
import { controlError } from "../../http";
import { isChatId } from "../../../chat/conversation";
import {
  readConversation,
  reconcileRevokedConversationRun,
  type ConversationScope,
} from "../../../chat/store";
import { createPortalChatStreamResponse } from "../../../chat/portal-stream";
import { type PortalChatExecution, authorizeStoredFork } from "../chat";

export async function handlePortalChatStream(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  execution: PortalChatExecution,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversation");
  const requestId = url.searchParams.get("request");
  const afterRaw = url.searchParams.get("after") ?? "-1";
  const afterSequence = Number(afterRaw);
  if (
    !isConversationId(conversationId) ||
    !isChatId(requestId) ||
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < -1 ||
    afterSequence >= 8_000_000
  )
    return controlError("chat_stream_request_invalid", 422);
  const scope: ConversationScope = {
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
  };
  const placement = authorized.executionScope;
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: authorized.executionScope.database,
    organisationId: scope.organisationId,
  });
  if (membershipRevision === null)
    return controlError("chat_stream_unavailable", 409);
  const requestAuthority = buildControlAuthority({
    organisationId: scope.organisationId,
    requesterPersonId: authorized.membership.personId,
    userId: scope.userId,
    membershipRevision,
    role: authorized.membership.role,
  }).requestAuthority;
  await reconcileRevokedConversationRun(
    placement,
    scope.userId,
    conversationId,
  );
  const stored = await readConversation(
    authorized.executionScope.database,
    scope,
    conversationId,
  );
  if (
    stored === null ||
    (!stored.conversation.completedRequests.includes(requestId) &&
      (stored.conversation.work.kind === "ready" ||
        stored.conversation.work.requestId !== requestId))
  )
    return controlError("chat_stream_unavailable", 409);
  const denied = await authorizeStoredFork(
    env,
    scope,
    stored.conversation,
    authorized,
  );
  if (denied !== null) return denied;
  const response = createPortalChatStreamResponse(
    {
      env,
      placement,
      scope,
      conversationId,
      requestId,
      afterSequence,
      requestAuthority,
      controlSessionId: authorized.authenticated.session.controlSessionId,
    },
    execution,
  );
  if (url.searchParams.get("download") === "true")
    response.headers.set(
      "content-disposition",
      `attachment; filename="response-${requestId}.ndjson"`,
    );
  return response;
}
