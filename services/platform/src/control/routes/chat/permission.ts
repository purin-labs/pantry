import {
  isConversationId,
  parseChatPermissionDecision,
} from "@seams/control-api";
import type { Env } from "../../../env";
import { authorizeOrganisationRequest } from "../../authorization";
import { controlError, controlJson, readJsonRecord } from "../../http";
import { isChatId } from "../../../chat/conversation";
import type { ConversationScope } from "../../../chat/store";
import { scheduleConversationExecution } from "../../../chat/application";
import { decideConversationPermission } from "../../../chat/turn/permission";
import { assertNever } from "@seams/std";
import { publicConversation } from "../../../chat/public-conversation";
import { chatError } from "./errors";

/**
 * Resumes or stops a run that paused for a permission. The caller enables the
 * capability through Access first; this route only checks that it is on.
 */
export async function handlePortalChatPermission(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  conversationId: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  if (!isConversationId(conversationId))
    return controlError("chat_permission_request_invalid", 422);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  const decision = body.ok
    ? parseChatPermissionDecision(body.value.decision)
    : null;
  if (
    !body.ok ||
    decision === null ||
    Object.keys(body.value).length !== 2 ||
    !isChatId(body.value.permissionRequestId)
  )
    return controlError("chat_permission_request_invalid", 422);
  const scope: ConversationScope = {
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
  };
  const placement = authorized.executionScope;
  const outcome = await decideConversationPermission({
    placement,
    scope,
    conversationId,
    permissionRequestId: body.value.permissionRequestId,
    decision,
  });
  switch (outcome.kind) {
    case "not_found":
      return chatError("chat_not_found", "This chat no longer exists.", 404);
    case "conflict":
      return chatError(
        "chat_permission_conflict",
        "This permission request is no longer waiting. Refresh the chat.",
        409,
      );
    case "permission_missing":
      return chatError(
        "chat_permission_missing",
        outcome.items.every((item) => item.kind === "agent_request")
          ? "An owner or admin has not allowed this request yet. Send them the request link, then select Check again."
          : `Allow ${outcome.items.map((item) => item.label).join(", ")} in Access, then continue.`,
        409,
      );
    case "decided":
      break;
    default:
      return assertNever(outcome);
  }
  await scheduleConversationExecution(env, {
    placement,
    scope,
    conversation: outcome.stored.conversation,
    controlSessionId: authorized.authenticated.session.controlSessionId,
  });
  return controlJson({
    conversation: publicConversation(
      outcome.stored.conversation,
      outcome.stored.metadata,
      outcome.stored.revision,
    ),
  });
}
