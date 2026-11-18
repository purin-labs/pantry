import type { CaseAssignment, HarnessTurnLease } from "@seams/contracts";
import { assertNever } from "@seams/std";

import type { Variant } from "@seams/type-utils";

import { acceptedExecutionAccountAuthority } from "../account-platform/access";
import { authorizeConversation } from "../chat/conversation-access";
import { sideCaseProposalId, storeSideCaseProposal } from "../chat/side-cases";
import { signalChat } from "../chat/signals";
import { readAdmittedChatInput } from "../chat/turn-access";
import { parsePersonId } from "../data/person-authz";
import type { Env } from "../env";
import { parseConnectorId, parseUserId } from "../ids";
import { validateLiveRequestAuthority } from "../request-authority";
import { storeSlackSideCaseProposal } from "../slack/side-cases";
import { resolveActiveConnectorActorAtPlacement } from "./actor-router";
import { readSessionTurnFlowBinding } from "./agent-session-information-flow";
import { decideCaseConversationSink } from "./case-conversation-sink";
import {
  SLACK_TURN_PREFIX,
  turnMayScheduleFollowUp,
} from "./harness-follow-up";
import type {
  HarnessSideCaseProposalRequest,
  HarnessSideCaseProposalResult,
} from "../agent-tools/catalog/types";
import {
  requireSessionExecution,
  type SessionExecutionAdmission,
} from "./session-execution-admission";
import type { SessionToolContext } from "../agent-tools/context";

/**
 * Whether a turn is offered the side Case tool (Plan 74): a step of a Portal
 * chat that a person's message started, or a turn of a Slack thread.
 * `conversationSession` is true when the Session runs the steps of a Portal
 * chat. The call checks the chat or the thread again.
 */
export function turnMayProposeSideCase(
  authority: HarnessTurnLease["requestAuthority"],
  turnId: string,
  conversationSession: boolean,
): boolean {
  return (
    turnMayScheduleFollowUp(authority, turnId) ||
    (authority.kind === "control" &&
      conversationSession &&
      turnId.startsWith("turn_trigger_"))
  );
}

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
  input: SessionToolContext,
  request: HarnessSideCaseProposalRequest,
): Promise<HarnessSideCaseProposalResult> {
  await requireSessionExecution(input.execution, input.lease);
  const authority = input.lease.requestAuthority;
  if (authority.kind === "direct_conversation" ||
    authority.kind === "shared_conversation")
    return proposeSlackSideCaseForHarness(input, authority, request);
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
    userAuthority: acceptedExecutionAccountAuthority(
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
          "Seams Pantry shows the person a card for this side Case in the chat. Tell them in one sentence what you proposed. Do not do that work in this turn.",
      };
    case "limit_reached":
      return notProposed(
        "This chat already holds three side Case proposals that wait. Tell the person what you found instead.",
      );
    default:
      return assertNever(stored);
  }
}

/**
 * The agent's proposal in a Slack thread. The thread's Connector keeps this
 * turn's command, so a start can copy it for the new thread, and posts the
 * proposal with its Start button in this thread. The post shows this turn's
 * output in the channel, so the turn's binding must reach that channel.
 */
async function proposeSlackSideCaseForHarness(
  input: {
    readonly env: Env;
    readonly storage: DurableObjectStorage;
    readonly execution: SessionExecutionAdmission;
    readonly lease: HarnessTurnLease;
    readonly assignment: CaseAssignment;
  },
  authority: Variant<
    HarnessTurnLease["requestAuthority"],
    "direct_conversation" | "shared_conversation"
  >,
  request: HarnessSideCaseProposalRequest,
): Promise<HarnessSideCaseProposalResult> {
  const scope = input.execution.scope;
  const sessionId = String(input.lease.session.sessionId);
  const turnId = String(input.lease.turn.turnId);
  if (!turnMayScheduleFollowUp(authority, turnId))
    throw new Error("side case proposal authority unavailable");
  const live = await validateLiveRequestAuthority({
    db: scope.database,
    accountAccess: scope.accountAccess,
    userAuthority: acceptedExecutionAccountAuthority(
      input.lease.session.sessionId,
      input.lease.turn.turnId,
    ),
    action: "execute",
    authority,
  });
  if (!live.ok) throw new Error("side case proposal authority has changed");
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
  const binding = informationFlow.value.binding;
  const sink = await decideCaseConversationSink(
    {
      requestAuthority: authority,
      authorityPartition: { digest: input.lease.authorityPartitionDigest },
    },
    binding,
    authority.conversationId,
    input.env,
  );
  if (!sink.ok)
    return notProposed(
      "What this turn read may not be shown in this channel, so Seams Pantry did not post a proposal. Tell the person in plain words what you found instead.",
    );
  const connectorId = parseConnectorId(String(authority.connectorId));
  if (!connectorId.ok)
    throw new Error("side case proposal Connector identity invalid");
  const identity = {
    organisationId: scope.organisationId,
    connectorId: connectorId.value,
  };
  const now = Date.now();
  const connector = await resolveActiveConnectorActorAtPlacement({
    env: input.env,
    namespace: input.env.CONNECTOR,
    organisationId: scope.organisationId,
    placement: scope.placement,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok)
    throw new Error(
      `side case proposal Connector unavailable: ${connector.error.code}`,
    );
  const proposalId = await sideCaseProposalId({
    sessionId,
    turnId,
    title: request.title,
    brief: request.brief,
  });
  await requireSessionExecution(input.execution, input.lease);
  const parked = await connector.value.parkSlackSideCase({
    identity,
    sourceEventId: turnId.slice(SLACK_TURN_PREFIX.length),
    proposalId,
  });
  if (!parked.ok)
    throw new Error(`side case proposal not kept: ${parked.error.code}`);
  const requester = parsePersonId(parked.value.requesterPersonId);
  if (
    requester === null ||
    parked.value.channelId !== authority.conversationId ||
    parked.value.caseId !== String(input.assignment.caseId)
  )
    throw new Error("side case proposal thread conflict");
  await requireSessionExecution(input.execution, input.lease);
  const stored = await storeSlackSideCaseProposal(scope, {
    sourceCaseId: parked.value.caseId,
    sourceSessionId: sessionId,
    sourceTurnId: turnId,
    connectorId: connectorId.value,
    workspaceId: parked.value.workspaceId,
    channelId: parked.value.channelId,
    sourceThreadTs: parked.value.threadTs,
    requestedByPersonId: requester,
    title: request.title,
    brief: request.brief,
    flowBinding: binding,
    now,
  });
  switch (stored.kind) {
    case "proposed": {
      if (stored.proposal.proposalId !== proposalId)
        throw new Error("side case proposal identity conflict");
      const posted = await connector.value.postSlackSideCaseProposal({
        identity,
        proposalId,
        title: stored.proposal.title,
        brief: stored.proposal.brief,
      });
      return posted.ok && posted.value.posted
        ? {
            kind: "side_case_proposed",
            detail:
              "Seams Pantry posted the proposal with a Start button in this thread. A person who starts it gets a new thread for it. Tell them in one sentence what you proposed. Do not do that work in this turn.",
          }
        : notProposed(
            "Seams Pantry kept the proposal, but this thread does not show it now. Tell the person in plain words what you found instead.",
          );
    }
    case "limit_reached":
      return notProposed(
        "This thread already holds three side Case proposals that wait. Tell the person what you found instead.",
      );
    default:
      return assertNever(stored);
  }
}

function notProposed(reason: string): HarnessSideCaseProposalResult {
  return { kind: "side_case_not_proposed", reason };
}
