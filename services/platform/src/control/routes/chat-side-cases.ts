/**
 * Side Case cards in a Portal chat (Plan 74). The agent proposes a side Case
 * with the `propose_side_case` tool; a person starts it as a new chat or
 * dismisses it here. Each route reads the proposal through the chat that
 * holds it, so a person who cannot open the chat cannot act on its cards,
 * and a person who may not receive the proposing turn's output gets the
 * answer of a missing card.
 */
import {
  isConversationId,
  isSideCaseProposalId,
  sideCaseHereRequestId,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";
import { authorizeConversation } from "../../chat/conversation-access";
import { decideChatFlowDelivery } from "../../chat/information-flow";
import {
  startSideCase,
  type SideCaseStartRefusal,
} from "../../chat/side-case-start";
import {
  dismissSideCaseProposal,
  readSideCaseProposal,
  sideCaseView,
  type SideCaseProposal,
} from "../../chat/side-cases";
import type { ChatTimelineEvent } from "../../chat/timeline";
import { signalChat } from "../../chat/signals";
import { readConversation, type ConversationScope } from "../../chat/store";
import { readActiveOrganisationMembershipRevision } from "@purin-labs/tenancy/data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import { buildControlAuthority } from "@purin-labs/authority/request-authority/index";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";

export type SideCaseAction = "start" | "dismiss";

export async function handlePortalChatSideCase(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  conversationIdRaw: string,
  proposalIdRaw: string,
  action: SideCaseAction,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  if (
    !isConversationId(conversationIdRaw) ||
    !isSideCaseProposalId(proposalIdRaw)
  )
    return controlError("side_case_request_invalid", 422);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0)
    return controlError("side_case_request_invalid", 422);
  const placement = authorized.executionScope;
  const scope: ConversationScope = {
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
  };
  const [source, access, proposal, membershipRevision] = await Promise.all([
    readConversation(placement.database, scope, conversationIdRaw),
    authorizeConversation(placement.database, scope, conversationIdRaw),
    readSideCaseProposal(
      placement.database,
      scope.organisationId,
      proposalIdRaw,
    ),
    readActiveOrganisationMembershipRevision({
      db: placement.database,
      organisationId: scope.organisationId,
    }),
  ]);
  if (source === null || access === null)
    return controlError("chat_not_found", 404);
  // A card of another chat answers as a missing one.
  if (
    proposal === null ||
    proposal.sourceConversationId !== conversationIdRaw ||
    access.access.kind === "workspace_canvas"
  )
    return controlError("side_case_not_found", 404);
  if (access.access.kind !== "private" && access.role === "viewer")
    return controlError("side_case_read_only", 403);
  if (membershipRevision === null)
    return controlError("side_case_not_found", 404);
  const authority = buildControlAuthority({
    organisationId: scope.organisationId,
    requesterPersonId: authorized.membership.personId,
    userId: scope.userId,
    membershipRevision,
    role: authorized.membership.role,
  }).requestAuthority;
  const delivery = await decideChatFlowDelivery(
    placement.database,
    placement.accountAccess,
    proposal.flowBinding,
    authority,
  );
  if (delivery.kind !== "allow")
    return controlError("side_case_not_found", 404);
  const now = Date.now();
  const reader = {
    userId: scope.userId,
    mayDecide: true,
    destinationDeleted: false,
    now,
  };
  switch (action) {
    case "dismiss": {
      const dismissed = await dismissSideCaseProposal(
        placement,
        proposal,
        scope.userId,
        now,
      );
      if (!dismissed.ok) return controlError(dismissed.code, 409);
      signalChat(placement, {
        kind: "conversation",
        conversationId: conversationIdRaw,
      });
      return controlJson({
        ok: true,
        sideCase: sideCaseView(dismissed.proposal, reader),
      });
    }
    case "start": {
      // A lost dismissal response must not offer a second execution in a
      // subthread. The accepted source message survives browser replacement.
      if (
        source.conversation.timeline.some(isAcceptedHere.bind(null, proposal))
      )
        return controlError("side_case_closed", 409);
      const started = await startSideCase(env, {
        placement,
        scope,
        authority,
        controlSessionId: authorized.authenticated.session.controlSessionId,
        source,
        proposal,
        now,
      });
      if (started.kind === "rejected")
        return controlError(started.code, refusalStatus(started.code));
      return controlJson({
        ok: true,
        conversationId: started.conversationId,
        sideCase: sideCaseView(started.proposal, reader),
      });
    }
    default:
      return assertNever(action);
  }
}

function isAcceptedHere(
  proposal: SideCaseProposal,
  event: ChatTimelineEvent,
): boolean {
  return (
    event.kind === "user" &&
    event.requestId === sideCaseHereRequestId(proposal.proposalId) &&
    event.text === proposal.brief
  );
}

function refusalStatus(code: SideCaseStartRefusal): number {
  switch (code) {
    case "side_case_not_found":
      return 404;
    case "side_case_closed":
    case "side_case_expired":
    case "side_case_model_unavailable":
    case "side_case_capacity":
    case "side_case_conflict":
      return 409;
    default:
      return assertNever(code);
  }
}
