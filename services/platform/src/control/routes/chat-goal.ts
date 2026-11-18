import type { OrganisationDatabase } from "../../database-handles";
import {
  isConversationId,
  type ChatGoalSupport,
  type ChatGoalView,
} from "@seams/control-api";
import { hasExactKeys, isRecord } from "@seams/std";
import { resolveActiveCaseActor } from "../../actors/actor-router";
import { parseGoalCommandRequest } from "../../actors/case-goals";
import {
  authorizeConversation,
  conversationCaseIdentity,
} from "../../chat/conversation-access";
import { checkConversationDisclosure } from "../../chat/conversation-disclosure";
import { selectStoredConversationModel } from "../../chat/turn/model";
import type { Conversation } from "../../chat/conversation";
import { readConversation, type ConversationScope } from "../../chat/store";
import { deriveDirectCaseIdentities } from "../../actors/case-direct-processing";
import type { OrganisationId } from "../../ids";
import { resolveOrganisationModelRoute } from "../../models/route";
import type { Env } from "../../env";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "../http";

export type ChatGoalRoute = Readonly<{
  kind: "chatGoal";
  organisationIdRaw: string;
  conversationIdRaw: string;
}>;

export function matchChatGoalRoute(pathname: string): ChatGoalRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/conversations\/([^/]+)\/goal$/u.exec(
      pathname,
    );
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return {
    kind: "chatGoal",
    organisationIdRaw: decodeURIComponent(match[1]),
    conversationIdRaw: decodeURIComponent(match[2]),
  };
}

export async function handleChatGoalRoute(
  request: Request,
  env: Env,
  route: ChatGoalRoute,
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
  const access = await authorizeConversation(
    authorized.executionScope.database,
    scope,
    route.conversationIdRaw,
  );
  if (access === null) return controlError("chat_not_found", 404);
  const canEdit = access.role !== "viewer";
  if (request.method === "POST" && !canEdit)
    return controlError("chat_goal_forbidden", 403);
  const stored = await readConversation(
    authorized.executionScope.database,
    scope,
    route.conversationIdRaw,
  );
  if (stored === null) return controlError("chat_not_found", 404);
  const disclosure = await checkConversationDisclosure(
    env,
    authorized.executionScope,
    scope,
    stored.conversation,
    [scope.userId],
    "viewing",
  );
  if (disclosure.kind === "rejected")
    return controlJson(
      disclosure,
      disclosure.code === "chat_history_forbidden" ? 403 : 409,
    );
  const identities = await deriveDirectCaseIdentities(
    await conversationCaseIdentity(
      authorized.executionScope.database,
      scope,
      route.conversationIdRaw,
    ),
  );
  if (!identities.ok) return controlError(identities.error.code, 409);
  const owner = await resolveActiveCaseActor({
    env: env,
    namespace: env.CASE,
    organisationId: scope.organisationId,
    caseId: identities.value.caseId,
    now: Date.now(),
  });
  if (!owner.ok) return controlError(owner.error.code, 409);
  const identity = {
    organisationId: scope.organisationId,
    caseId: identities.value.caseId,
  };
  const support = await goalSupport(
    env,
    scope.organisationId,
    stored.conversation,
  );
  const execution =
    stored.conversation.work.kind === "ready" ||
    stored.conversation.work.kind === "failed"
      ? "idle"
      : "busy";
  if (request.method === "GET") {
    const goal = await owner.value.readGoal(identity);
    if (!goal.ok) return controlError(goal.error.code, 409);
    const view: ChatGoalView = {
      goal: goal.value,
      support,
      canEdit,
      execution,
    };
    return controlJson(view);
  }
  const body = await readBoundedJsonRecord(request, 32768);
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ["commandId", "expectedRevision", "command"]) ||
    typeof body.commandId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(body.commandId)
  )
    return controlError("goal_request_invalid", 422);
  // The authenticated operator owns the command receipt; clients cannot select a Case.
  const command = parseGoalCommandRequest({
    ...identity,
    commandId: `${scope.userId}:${body.commandId}`,
    expectedRevision: body.expectedRevision,
    command: body.command,
  });
  if (command === null) return controlError("goal_request_invalid", 422);
  if (command.command.kind === "set" || command.command.kind === "resume") {
    if (support.kind !== "supported") return controlError(support.code, 409);
    if (execution === "busy" || stored.conversation.pendingInputs.length > 0)
      return controlError("chat_goal_execution_busy", 409);
  }
  const changed = await owner.value.applyGoalCommand(command);
  if (!changed.ok) return controlError(changed.error.code, 409);
  const view: ChatGoalView = {
    goal: changed.value,
    support,
    canEdit,
    execution,
  };
  return controlJson(view);
}

/**
 * Sets the goal of a conversation that was just admitted, before its turn is
 * scheduled. Returns an error code, or null when the goal is set.
 */
export async function setAdmittedConversationGoal(
  env: Env,
  database: OrganisationDatabase,
  scope: ConversationScope,
  conversation: Conversation,
  commandId: string,
  objective: string,
  tokenBudget: number,
): Promise<string | null> {
  const support = await goalSupport(env, scope.organisationId, conversation);
  if (support.kind !== "supported") return support.code;
  const identities = await deriveDirectCaseIdentities(
    await conversationCaseIdentity(database, scope, conversation.id),
  );
  if (!identities.ok) return identities.error.code;
  const owner = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: scope.organisationId,
    caseId: identities.value.caseId,
    now: Date.now(),
  });
  if (!owner.ok) return owner.error.code;
  const identity = {
    organisationId: scope.organisationId,
    caseId: identities.value.caseId,
  };
  const current = await owner.value.readGoal(identity);
  if (!current.ok) return current.error.code;
  if (
    current.value.kind === "present" &&
    current.value.goal.objective === objective
  )
    return null;
  const command = parseGoalCommandRequest({
    ...identity,
    commandId: `${scope.userId}:${commandId}`,
    expectedRevision: current.value.revision,
    command: { kind: "set", objective, tokenBudget },
  });
  if (command === null) return "goal_request_invalid";
  const changed = await owner.value.applyGoalCommand(command);
  return changed.ok ? null : changed.error.code;
}

async function goalSupport(
  env: Env,
  organisationId: OrganisationId,
  conversation: Conversation,
): Promise<ChatGoalSupport> {
  const live = await resolveOrganisationModelRoute({
    env,
    organisationId,
    now: Date.now(),
  });
  if (!live.ok) return { kind: "unavailable", code: live.error.code };
  const selected = selectStoredConversationModel(live.value, conversation);
  if (!selected.ok) return { kind: "unavailable", code: selected.error.code };
  return { kind: "supported", backend: "pi" };
}
