import type {
  SessionConversation,
  SessionSideCase,
  SessionSideCaseSource,
} from "../actors/session/conversation-port";
import { decideCaseConversationSink } from "../actors/case-conversation-sink";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  admitChatForkInformationFlow,
  authorizeForkHistoryAccess,
  readChatForkHistoryForCase,
} from "./forks";
import { decideChatFlowDelivery } from "./information-flow";
import {
  admitSideCaseInformationFlow,
  authorizeSideCaseAccess,
  parseProposalRow,
  SIDE_CASE_HARNESS_INSTRUCTION,
  type SideCaseProposal,
} from "./side-cases";

/**
 * The conversation part of a Session turn: the inherited history of a fork,
 * the side Case, and the flow checks of the conversation. Slack gives the
 * parser of the side Cases of its threads.
 */
export function sessionConversation(
  slackThread: SessionSideCaseSource,
): SessionConversation {
  return {
    readForkHistory: readChatForkHistoryForCase,
    authorizeForkHistoryAccess,
    admitForkInformationFlow: admitChatForkInformationFlow,
    readSideCase: (scope, caseId) => readSideCase(scope, caseId, slackThread),
    decideFlowDelivery: decideChatFlowDelivery,
    decideStreamSink: decideCaseConversationSink,
  };
}

/**
 * The side Case that started from this Case's proposal, in a Portal chat or
 * a Slack thread (Plan 74). Each turn of the side Case admits it before
 * inference, so each turn makes this one read for both kinds. Slack gives
 * the parser of its own proposals.
 */
async function readSideCase(
  placement: OrganisationExecutionScope,
  caseId: string,
  slackThread: SessionSideCaseSource,
): Promise<SessionSideCase | null> {
  const raw = await placement.database
    .prepare(
      "SELECT * FROM side_case_proposal WHERE organisation_id = ? AND destination_case_id = ?",
    )
    .bind(placement.organisationId, caseId)
    .first();
  if (raw === null) return null;
  switch (raw.source_kind) {
    case "portal_chat":
      return portalChatSideCase(await parseProposalRow(raw));
    case "slack_thread":
      return slackThread(raw);
    default:
      throw new Error("side_case_storage_invalid");
  }
}

/** A side Case of a Portal chat. Only the person who asked may use it. */
function portalChatSideCase(proposal: SideCaseProposal): SessionSideCase {
  return {
    instruction: SIDE_CASE_HARNESS_INSTRUCTION,
    async admit(input) {
      const authority = input.lease.requestAuthority;
      if (authority.kind !== "control") throw new Error("side_case_forbidden");
      await authorizeSideCaseAccess(input.scope, proposal, authority);
      await admitSideCaseInformationFlow(
        input.scope.database,
        input.scope.accountAccess,
        input.storage,
        input.lease,
        proposal,
        input.authorizeCommit,
      );
    },
  };
}
