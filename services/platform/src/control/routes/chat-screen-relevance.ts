/**
 * The Jev relevance suggestion of the Portal composer (Plan 87 section 3A).
 * `POST …/chat/conversations/:id/screen-relevance` checks a draft against
 * the page on screen; `POST …/screen-relevance/:checkId/choice` records what
 * the person did with a hint or a question. Only a person who may write in
 * the chat asks.
 */
import {
  isConversationId,
  isScreenRelevanceCheckId,
  isScreenRelevanceChoice,
  parseScreenRelevanceRequest,
  screenRelevanceObservation,
} from "@purin-labs/control-api";
import { hasExactKeys } from "@purin-labs/std";
import { authorizeConversation } from "../../chat/conversation-access";
import {
  checkScreenRelevance,
  recordScreenRelevanceChoice,
} from "../../chat/screen-relevance";
import { readConversation, type ConversationScope } from "../../chat/store";
import { readActiveOrganisationMembershipRevision } from "@purin-labs/tenancy/data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import { buildControlAuthority } from "@purin-labs/authority/request-authority/index";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readBoundedJsonRecord,
} from "@purin-labs/control/worker/http";

const MAX_BODY_BYTES = 32_768;

export async function handlePortalChatScreenRelevance(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  conversationIdRaw: string,
  checkIdRaw: string | null,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  if (!isConversationId(conversationIdRaw))
    return controlError("chat_not_found", 404);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const placement = authorized.executionScope;
  const scope: ConversationScope = {
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
  };
  const body = await readBoundedJsonRecord(request, MAX_BODY_BYTES);
  if (checkIdRaw !== null) {
    if (
      !isScreenRelevanceCheckId(checkIdRaw) ||
      body === null ||
      !hasExactKeys(body, ["choice"]) ||
      !isScreenRelevanceChoice(body.choice)
    )
      return controlError("screen_relevance_request_invalid", 422);
    const recorded = await recordScreenRelevanceChoice(env, {
      placement,
      scope,
      checkId: checkIdRaw,
      choice: body.choice,
    });
    if (!recorded.ok) return controlError(recorded.error.code, 404);
    return controlJson({ ok: true });
  }
  const parsed = parseScreenRelevanceRequest(body);
  if (parsed === null)
    return controlError("screen_relevance_request_invalid", 422);
  const [stored, access, membershipRevision] = await Promise.all([
    readConversation(placement.database, scope, conversationIdRaw),
    authorizeConversation(placement.database, scope, conversationIdRaw),
    readActiveOrganisationMembershipRevision({
      db: placement.database,
      organisationId: scope.organisationId,
    }),
  ]);
  if (stored === null || access === null || membershipRevision === null)
    return controlError("chat_not_found", 404);
  // A reader of a shared chat cannot send in it, so it asks for nothing.
  if (access.access.kind !== "private" && access.role === "viewer")
    return controlJson({ kind: "refused", reason: "chat_read_only" });
  const checked = await checkScreenRelevance(env, {
    placement,
    scope,
    authority: buildControlAuthority({
      organisationId: scope.organisationId,
      requesterPersonId: authorized.membership.personId,
      userId: scope.userId,
      membershipRevision,
      role: authorized.membership.role,
    }).requestAuthority,
    access,
    stored,
    // Jev never reads a fact value or a table row, whatever the tab sent.
    request: {
      draft: parsed.draft,
      observation: screenRelevanceObservation(parsed.observation),
    },
  });
  if (!checked.ok) return controlError(checked.error.code, 409);
  return controlJson(checked.value);
}
