import { assertNever } from "@purin-labs/std";


import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import { authorizeConversation } from "../chat/conversation-access";
import { storeSideCaseProposal } from "../chat/side-cases";
import { signalChat } from "../chat/signals";
import { readAdmittedChatInput } from "../chat/turn-access";
import { parseUserId } from "@purin-labs/control-api/ids";
import { validateLiveRequestAuthority } from "../request-authority";
import { readSessionTurnFlowBinding } from "./agent-session-information-flow";
import type {
  HarnessSideCaseProposalRequest,
  HarnessSideCaseProposalResult,
} from "../agent-tools/catalog/types";
import {
  requireSessionExecution,
} from "./session-execution-admission";
import type { SessionToolContext } from "../agent-tools/context";
import type { SlackThreadSideCase } from "./session/harness-source";

/**
 * The agent's proposal of separate work as a side Case of this chat.
 *
 * The proposal names this turn's chat and Case, and keeps this turn's flow
 * binding: the title and the brief are this turn's output, so a reader and a
 * side Case get them only under every restriction of what the turn read. The
 * chat shows the proposal as a card; nothing starts until a person starts it.
 * A refusal that the agent can explain is a result. A lookup that fails
 * throws, so the tool reports no outcome that it does not know.
 */
export async function proposeSideCaseForHarness(
  slackThread: Pick<SlackThreadSideCase, "propose">,
  input: SessionToolContext,
  request: HarnessSideCaseProposalRequest,
): Promise<HarnessSideCaseProposalResult> {
  await requireSessionExecution(input.execution, input.lease);
  const authority = input.lease.requestAuthority;
  if (authority.kind === "direct_conversation" ||
    authority.kind === "shared_conversation")
    return slackThread.propose(input, authority, request);
  if (authority.kind !== "control")
    throw new Error("side case proposal authority unavailable");
  const requester = parseUserId(authority.userId);
  if (!requester.ok) throw new Error("side case proposal requester invalid");
  const scope = input.execution.scope;
  const sessionId = String(input.lease.session.sessionId);
  const turnId = String(input.lease.turn.turnId);
  const live = await validateLiveRequestAuthority({
    db: scope.database,
    accountAccess: scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      input.lease.session.sessionId,
      input.lease.turn.turnId,
    ),
    action: "execute",
    authority,
  });
  if (!live.ok) throw new Error("side case proposal authority has changed");
  // The read also checks that the person may still open the conversation.
  const chat = await readAdmittedChatInput(scope.database, authority, turnId);
  if (chat === null || !turnId.startsWith("turn_trigger_"))
    return notProposed(
      "This turn did not start from a message in a Portal chat.",
    );
  const conversationId = chat.source.conversationId;
  const access = await authorizeConversation(
    scope.database,
    { organisationId: scope.organisationId, userId: requester.value },
    conversationId,
  );
  if (access === null || access.access.kind === "workspace_canvas")
    return notProposed(
      "A canvas chat cannot hold side Case proposals. Tell the person what you found instead.",
    );
  const informationFlow = await readSessionTurnFlowBinding(input.storage.sql, {
    organisationId: String(scope.organisationId),
    sessionId,
    turnId,
  });
  if (
    !informationFlow.ok ||
    informationFlow.value === null ||
    informationFlow.value.authorityPartitionDigest !==
      input.lease.authorityPartitionDigest
  )
    throw new Error("side case proposal information-flow binding unavailable");
  await requireSessionExecution(input.execution, input.lease);
  const stored = await storeSideCaseProposal(scope, {
    sourceCaseId: String(input.assignment.caseId),
    sourceConversationId: conversationId,
    sourceSessionId: sessionId,
    sourceTurnId: turnId,
    requestedByUserId: requester.value,
    title: request.title,
    brief: request.brief,
    flowBinding: informationFlow.value.binding,
    now: Date.now(),
  });
  switch (stored.kind) {
    case "proposed":
      // The card shows on every page that has this chat open.
      signalChat(scope, { kind: "conversation", conversationId });
      return {
        kind: "side_case_proposed",
        detail:
          "Purin Pantry shows the person a card for this side Case in the chat. Tell them in one sentence what you proposed. Do not do that work in this turn.",
      };
    case "limit_reached":
      return notProposed(
        "This chat already holds three side Case proposals that wait. Tell the person what you found instead.",
      );
    default:
      return assertNever(stored);
  }
}

function notProposed(reason: string): HarnessSideCaseProposalResult {
  return { kind: "side_case_not_proposed", reason };
}
