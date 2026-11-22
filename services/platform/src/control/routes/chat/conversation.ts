import { signalChat } from "../../../chat/signals";
import { OrganisationExecutionScope } from "../../../organisation-execution-scope";
import { isConversationId, isProjectIdentifier } from "@purin-labs/control-api";
import { forkChat } from "../../../chat/forks";
import {
  parseResponseFeedback,
  saveResponseFeedback,
} from "../../../chat/feedback";
import type { Env } from "@purin-labs/kernel/env";
import { buildControlAuthority } from "../../../request-authority";
import { readActiveOrganisationMembershipRevision } from "../../../data/control-plane";
import { authorizeOrganisationRequest } from "../../authorization";
import { controlError, controlJson, readJsonRecord } from "../../http";
import { isChatId } from "../../../chat/conversation";
import {
  updateConversationMetadata,
  updateConversationDraft,
  advanceConversationRead,
  renameConversation,
  type ConversationMetadataAction,
  type ConversationScope,
} from "../../../chat/store";
import { deleteArchivedChat } from "../../../chat/deletion";
import { chatError } from "./errors";

export async function handlePortalChatConversation(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  conversationId: string,
): Promise<Response> {
  if (request.method !== "PATCH")
    return controlError("method_not_allowed", 405);
  if (!isConversationId(conversationId))
    return controlError("chat_request_invalid", 422);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("chat_request_invalid", 422);
  if (body.value.action === "fork") {
    if (
      Object.keys(body.value).length !== 3 ||
      !isChatId(body.value.operationId) ||
      !isChatId(body.value.messageId)
    )
      return controlError("chat_request_invalid", 422);
    const scope: ConversationScope = {
      organisationId: authorized.organisationId,
      userId: authorized.authenticated.session.userId,
    };
    const execution = await OrganisationExecutionScope.resolve(
      env,
      scope.organisationId,
    );
    if (!execution.ok) return controlError("chat_fork_conflict", 409);
    const membershipRevision = await readActiveOrganisationMembershipRevision({
      db: execution.value.database,
      organisationId: scope.organisationId,
    });
    if (membershipRevision === null)
      return controlError("chat_fork_history_forbidden", 403);
    const authority = buildControlAuthority({
      organisationId: scope.organisationId,
      requesterPersonId: authorized.membership.personId,
      userId: scope.userId,
      membershipRevision,
      role: authorized.membership.role,
    }).requestAuthority;
    const result = await forkChat(
      env,
      execution.value,
      scope.userId,
      authority,
      conversationId,
      { operationId: body.value.operationId, messageId: body.value.messageId },
    );
    // The source conversation now lists its new fork.
    if (result.kind === "ready")
      signalChat(execution.value, {
        kind: "conversation",
        conversationId,
      });
    return controlJson(
      result,
      result.kind === "ready" ? 200 : result.kind === "preparing" ? 202 : 409,
    );
  }
  if (body.value.action === "delete") {
    if (
      Object.keys(body.value).length !== 3 ||
      !isProjectIdentifier(body.value.operationId) ||
      typeof body.value.expectedRevision !== "number" ||
      !Number.isSafeInteger(body.value.expectedRevision) ||
      body.value.expectedRevision < 1
    )
      return controlError("chat_request_invalid", 422);
    const execution = await OrganisationExecutionScope.resolve(
      env,
      authorized.organisationId,
    );
    if (!execution.ok) return controlError(execution.error.code, 409);
    const result = await deleteArchivedChat(
      env,
      execution.value,
      authorized.authenticated.session.userId,
      conversationId,
      {
        operationId: body.value.operationId,
        expectedRevision: body.value.expectedRevision,
      },
    );
    // A deletion also erases forks that other users see.
    if (result.kind === "deleted")
      signalChat(execution.value, { kind: "organisation" });
    return controlJson(
      result,
      result.kind === "deleted" ? 200 : result.kind === "failed" ? 503 : 409,
    );
  }
  if (body.value.action === "rate_response") {
    const feedback = parseResponseFeedback(body.value);
    if (feedback === null) return controlError("chat_request_invalid", 422);
    const result = await saveResponseFeedback(
      env,
      {
        organisationId: authorized.organisationId,
        userId: authorized.authenticated.session.userId,
      },
      conversationId,
      feedback,
    );
    if (!result.ok)
      return controlError(
        result.code,
        result.code === "chat_not_found" ? 404 : 409,
      );
    return controlJson({ rating: feedback.rating });
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    authorized.organisationId,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const rename = parseConversationRename(body.value);
  if (rename !== null) {
    const result = await renameConversation(
      execution.value,
      authorized.authenticated.session.userId,
      conversationId,
      rename.title,
      rename.expectedRevision,
      Date.now(),
    );
    if (!result.ok) return conversationRenameError(result.code);
    return controlJson({ conversation: result.summary });
  }
  const action = parseConversationMetadataAction(body.value);
  if (action === null) return controlError("chat_request_invalid", 422);
  const result = await updateConversationMetadata(
    execution.value,
    authorized.authenticated.session.userId,
    conversationId,
    action,
    Date.now(),
  );
  if (!result.ok) return conversationMetadataError(result.code);
  return controlJson({ conversation: result.summary });
}

export async function handlePortalChatDraft(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  conversationId: string,
): Promise<Response> {
  if (request.method !== "PUT") return controlError("method_not_allowed", 405);
  if (!isConversationId(conversationId))
    return controlError("chat_request_invalid", 422);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (
    !body.ok ||
    typeof body.value.draft !== "string" ||
    (body.value.expectedUpdatedAt !== null &&
      (typeof body.value.expectedUpdatedAt !== "number" ||
        !Number.isSafeInteger(body.value.expectedUpdatedAt) ||
        body.value.expectedUpdatedAt < 0)) ||
    Object.keys(body.value).some(isUnexpectedDraftField)
  )
    return controlError("chat_request_invalid", 422);
  const execution = await OrganisationExecutionScope.resolve(
    env,
    authorized.organisationId,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const result = await updateConversationDraft(
    execution.value,
    authorized.authenticated.session.userId,
    conversationId,
    body.value.draft,
    body.value.expectedUpdatedAt,
    Date.now(),
  );
  if (!result.ok) return conversationDraftError(result);
  return controlJson({ draft: result });
}

export async function handlePortalChatRead(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  conversationId: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  if (!isConversationId(conversationId))
    return controlError("chat_request_invalid", 422);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (
    !body.ok ||
    typeof body.value.sequence !== "number" ||
    !Number.isSafeInteger(body.value.sequence) ||
    body.value.sequence < 0 ||
    Object.keys(body.value).some(isUnexpectedReadField)
  )
    return controlError("chat_request_invalid", 422);
  const execution = await OrganisationExecutionScope.resolve(
    env,
    authorized.organisationId,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const result = await advanceConversationRead(
    execution.value,
    authorized.authenticated.session.userId,
    conversationId,
    body.value.sequence,
  );
  if (!result.ok)
    return chatError(
      result.code,
      "The conversation read state changed. Refresh and try again.",
      409,
    );
  return controlJson({ read: result });
}

function parseConversationMetadataAction(
  raw: Readonly<Record<string, unknown>>,
): ConversationMetadataAction | null {
  if (
    (raw.action === "archive" || raw.action === "restore") &&
    Object.keys(raw).length === 2 &&
    typeof raw.expectedRevision === "number" &&
    Number.isSafeInteger(raw.expectedRevision) &&
    raw.expectedRevision >= 1
  )
    return { kind: raw.action, expectedRevision: raw.expectedRevision };
  if (
    Object.keys(raw).length === 1 &&
    (raw.action === "pin" || raw.action === "unpin")
  )
    return { kind: raw.action };
  return null;
}

function parseConversationRename(
  raw: Readonly<Record<string, unknown>>,
): { readonly title: string; readonly expectedRevision: number } | null {
  if (
    Object.keys(raw).length !== 3 ||
    raw.action !== "rename" ||
    typeof raw.title !== "string" ||
    typeof raw.expectedRevision !== "number" ||
    !Number.isSafeInteger(raw.expectedRevision) ||
    raw.expectedRevision < 1
  )
    return null;
  return { title: raw.title, expectedRevision: raw.expectedRevision };
}

function isUnexpectedDraftField(key: string): boolean {
  return key !== "draft" && key !== "expectedUpdatedAt";
}

function isUnexpectedReadField(key: string): boolean {
  return key !== "sequence";
}

function conversationDraftError(
  result: Exclude<
    Awaited<ReturnType<typeof updateConversationDraft>>,
    { readonly ok: true }
  >,
): Response {
  switch (result.code) {
    case "chat_capacity_reached":
      return chatError(
        result.code,
        "This chat has reached its storage limit. Start a new chat to continue.",
        413,
      );
    case "chat_not_found":
      return chatError(result.code, "This chat no longer exists.", 404);
    case "chat_archived":
      return chatError(
        result.code,
        "Restore this chat before saving a draft.",
        409,
      );
    case "chat_draft_invalid":
      return chatError(
        result.code,
        "Drafts are limited to 8,000 characters.",
        422,
      );
    case "chat_revision_conflict":
      return controlJson(
        {
          ok: false,
          error: result.code,
          draft: result.serverDraft ?? "",
          revision: result.serverRevision ?? 0,
          updatedAt: result.serverUpdatedAt ?? null,
        },
        409,
      );
  }
}

function conversationRenameError(
  code:
    | "chat_not_found"
    | "chat_title_invalid"
    | "chat_revision_conflict"
    | "chat_capacity_reached",
): Response {
  switch (code) {
    case "chat_capacity_reached":
      return chatError(
        code,
        "This chat has reached its storage limit. Start a new chat to continue.",
        413,
      );
    case "chat_not_found":
      return chatError(code, "This chat no longer exists.", 404);
    case "chat_title_invalid":
      return chatError(
        code,
        "Choose a title between 1 and 120 characters.",
        422,
      );
    case "chat_revision_conflict":
      return chatError(
        code,
        "This chat changed. Refresh and rename it again.",
        409,
      );
  }
}

function conversationMetadataError(
  code:
    | "chat_not_found"
    | "chat_archived"
    | "chat_running"
    | "chat_metadata_conflict",
): Response {
  switch (code) {
    case "chat_not_found":
      return chatError(code, "This chat no longer exists.", 404);
    case "chat_archived":
      return chatError(code, "Restore this chat before pinning it.", 409);
    case "chat_running":
      return chatError(
        code,
        "Wait for the current response to finish before archiving this chat.",
        409,
      );
    case "chat_metadata_conflict":
      return chatError(
        code,
        "This chat changed. Refresh the list and try again.",
        409,
      );
  }
}
