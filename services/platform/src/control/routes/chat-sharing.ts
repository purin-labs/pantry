import { signalChat } from "../../chat/signals";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  readConversationStatus,
  reconcileRevokedConversationRun,
} from "../../chat/store";
import { isProjectId, isConversationId } from "@purin-labs/control-api";
import { hasExactKeys, isNonNegativeInteger, isRecord } from "@purin-labs/std";
import type { Env } from "@purin-labs/kernel/env";
import { authorizeConversation } from "../../chat/conversation-access";
import {
  authorizeProject,
  listProjectMembers,
} from "../../projects/access";
import {
  shareConversation,
  type ConversationSharingCommand,
} from "../../chat/conversation-sharing";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import { controlJson, controlError, readBoundedJsonRecord } from "@purin-labs/control/worker/http";

export type ChatSharingRoute = Readonly<{
  kind: "chatSharing";
  organisationIdRaw: string;
  conversationIdRaw: string;
}>;

export function matchChatSharingRoute(
  pathname: string,
): ChatSharingRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/conversations\/([^/]+)\/access$/u.exec(
      pathname,
    );
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return {
    kind: "chatSharing",
    organisationIdRaw: decodeURIComponent(match[1]),
    conversationIdRaw: decodeURIComponent(match[2]),
  };
}

export async function handleChatSharingRoute(
  request: Request,
  env: Env,
  route: ChatSharingRoute,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  if (!isConversationId(route.conversationIdRaw))
    return controlError("chat_not_found", 404);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    request.method === "POST",
  );
  if (!authorized.ok) return authorized.response;
  const scope = {
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
  };
  const placement = await OrganisationExecutionScope.resolve(env, scope.organisationId);
  if (!placement.ok) return controlError(placement.error.code, 409);
  if (request.method === "GET")
    await reconcileRevokedConversationRun(
      placement.value,
      scope.userId,
      route.conversationIdRaw,
    );
  const access = await authorizeConversation(
    authorized.executionScope.database,
    scope,
    route.conversationIdRaw,
  );
  if (access === null) return controlError("chat_not_found", 404);
  if (request.method === "GET") {
    const stored = await readConversationStatus(
      authorized.executionScope.database,
      scope,
      route.conversationIdRaw,
    );
    if (stored === null) return controlError("chat_not_found", 404);
    const rawProject = new URL(request.url).searchParams.get("project");
    if (rawProject === null)
      return controlJson({ ...access, revision: stored.revision });
    if (!isProjectId(rawProject))
      return controlError("chat_destination_unavailable", 404);
    const project = await authorizeProject(
      authorized.executionScope.database,
      scope,
      rawProject,
      "read",
    );
    if (project === null)
      return controlError("chat_destination_unavailable", 404);
    const members = await listProjectMembers(authorized.executionScope.database, scope, rawProject);
    if (members === null)
      return controlError("chat_destination_unavailable", 404);
    return controlJson({
      ...access,
      revision: stored.revision,
      project: { id: rawProject, access: project.access },
      members,
    });
  }
  const body = await readBoundedJsonRecord(request, 4096);
  if (
    !isRecord(body) ||
    !hasExactKeys(body, [
      "kind",
      "operationId",
      "projectId",
      "expectedRevision",
      "expectedProjectAccessRevision",
    ]) ||
    (body.kind !== "share_conversation" &&
      body.kind !== "move_shared_conversation") ||
    typeof body.operationId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(body.operationId) ||
    !isProjectId(body.projectId) ||
    !isNonNegativeInteger(body.expectedRevision) ||
    !isNonNegativeInteger(body.expectedProjectAccessRevision)
  )
    return controlError("chat_share_invalid", 422);
  const command: ConversationSharingCommand = {
    kind: body.kind,
    operationId: body.operationId,
    projectId: body.projectId,
    expectedRevision: body.expectedRevision,
    expectedProjectAccessRevision: body.expectedProjectAccessRevision,
  };
  await reconcileRevokedConversationRun(
    placement.value,
    scope.userId,
    route.conversationIdRaw,
  );
  const result = await shareConversation(
    env,
    placement.value,
    scope.userId,
    route.conversationIdRaw,
    command,
  );
  // Sharing or moving a conversation changes who sees it.
  if (result.kind === "accepted")
    signalChat(placement.value, { kind: "organisation" });
  return controlJson(result, result.kind === "accepted" ? 200 : 409);
}
