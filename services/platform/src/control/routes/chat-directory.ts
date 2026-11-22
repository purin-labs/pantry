import { signalChat } from "../../chat/signals";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { isConversationId, isProjectId } from "@purin-labs/control-api";
import { parseChatDirectoryCommand } from "@purin-labs/control-api";
import {
  mutateChatDirectory,
  readAuthorizedProjectDirectory,
} from "../../chat/projects";
import {
  readConversation,
  saveConversation,
  type ConversationScope,
} from "../../chat/store";
import { resolveOrganisationModelRoute } from "../../models/route";
import { readProject } from "../../projects/records";
import type { Env } from "@purin-labs/kernel/env";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readBoundedJsonRecord,
} from "@purin-labs/control/worker/http";

// A member's sidebar: their ordering of Projects and chats, and a chat started
// inside a Project. Project content and Case moves are general routes.
export type ChatDirectoryRoute = Readonly<{
  kind: "chatDirectory";
  organisationIdRaw: string;
  target: "directory" | "chats";
}>;

export function matchChatDirectoryRoute(
  pathname: string,
): ChatDirectoryRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/projects(?:\/(chats))?$/u.exec(
      pathname,
    );
  if (match?.[1] === undefined) return null;
  return {
    kind: "chatDirectory",
    organisationIdRaw: decodeURIComponent(match[1]),
    target: match[2] === "chats" ? "chats" : "directory",
  };
}

export async function handleChatDirectoryRoute(
  request: Request,
  env: Env,
  route: ChatDirectoryRoute,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    request.method === "POST",
  );
  if (!authorized.ok) return authorized.response;
  const scope: ConversationScope = {
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
  };
  if (route.target === "chats") {
    if (request.method !== "POST")
      return controlError("method_not_allowed", 405);
    const body = await readBoundedJsonRecord(request, 1024);
    if (
      body === null ||
      Object.keys(body).length !== 2 ||
      !isConversationId(body.conversationId) ||
      !isProjectId(body.projectId)
    )
      return controlError("project_request_invalid", 422);
    const execution = await OrganisationExecutionScope.resolve(
      env,
      scope.organisationId,
    );
    if (!execution.ok) return controlError(execution.error.code, 409);
    const project = await readProject(
      authorized.executionScope.database,
      scope,
      body.projectId,
    );
    if (project === null)
      return controlError("chat_destination_unavailable", 409);
    const stored = await readConversation(
      authorized.executionScope.database,
      scope,
      body.conversationId,
    );
    if (stored !== null)
      return stored.placement.projectId === project.id
        ? controlJson({ conversationId: stored.conversation.id })
        : controlError("chat_operation_conflict", 409);
    const model = await resolveOrganisationModelRoute({
      env,
      organisationId: scope.organisationId,
      now: Date.now(),
    });
    if (!model.ok) return controlError(model.error.code, 409);
    const saved = await saveConversation(
      execution.value,
      scope.userId,
      {
        lineage: { kind: "original" },
        historyBindings: [],
        id: body.conversationId,
        title: "New chat",
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
      },
      0,
      { projectId: project.id },
    );
    return saved.kind === "saved"
      ? controlJson({ conversationId: body.conversationId })
      : controlError("chat_operation_conflict", 409);
  }
  if (request.method === "GET")
    return controlJson(
      await readAuthorizedProjectDirectory(
        env,
        authorized.executionScope,
        scope,
      ),
    );
  const body = await readBoundedJsonRecord(request, 16 * 1024);
  if (body === null) return controlError("project_request_invalid", 422);
  const command = parseChatDirectoryCommand(body);
  if (command === null) return controlError("project_request_invalid", 422);
  const execution = await OrganisationExecutionScope.resolve(
    env,
    scope.organisationId,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const result = await mutateChatDirectory(
    execution.value,
    scope.userId,
    command,
    Date.now(),
  );
  // A move between Projects changes who sees the conversation; a Project's
  // place in the sidebar is the member's own.
  if (result.kind === "accepted")
    signalChat(
      execution.value,
      command.kind === "move_chat"
        ? { kind: "organisation" }
        : { kind: "user", userId: scope.userId },
    );
  return controlJson(result, result.kind === "accepted" ? 200 : 409);
}
