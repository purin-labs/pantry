import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import { assertNever } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import { resolveActiveConnectorActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import type { SlackConnectorActor } from "../../actors/slack-connector-rpc";
import { readSessionTurnFlowBinding } from "@purin-labs/agent/actors/agent-session-information-flow";
import { decideCaseConversationSink } from "@purin-labs/conversation/actors/case-conversation-sink";
import {
  SLACK_TURN_PREFIX,
  turnMayScheduleFollowUp,
} from "@purin-labs/agent/actors/session/turn-tool-offers";
import {
  requireSessionExecution,
  type SessionExecutionAdmission,
} from "@purin-labs/agent/actors/session-execution-admission";
import { sideCaseProposalId } from "@purin-labs/conversation/chat/side-cases";
import { parsePersonId } from "@purin-labs/authority/data/person-authz";
import type { Env } from "@purin-labs/kernel/env";
import { parseConnectorId } from "@purin-labs/kernel/ids";
import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import { validateLiveRequestAuthority } from "@purin-labs/authority/request-authority/index";
import { storeSlackSideCaseProposal } from "../../side-cases";
import type {
  HarnessSideCaseProposalRequest,
  HarnessSideCaseProposalResult,
} from "@purin-labs/agent-tools/catalog/types";

/**
 * The agent's proposal in a Slack thread. The thread's Connector keeps this
 * turn's command, so a start can copy it for the new thread, and posts the
 * proposal with its Start button in this thread. The post shows this turn's
 * output in the channel, so the turn's binding must reach that channel.
 */
export async function proposeSlackSideCaseForHarness(
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
    userAuthority: acceptedExecutionAuthority(
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
      "What this turn read may not be shown in this channel, so Purin Pantry did not post a proposal. Tell the person in plain words what you found instead.",
    );
  const connectorId = parseConnectorId(String(authority.connectorId));
  if (!connectorId.ok)
    throw new Error("side case proposal Connector identity invalid");
  const identity = {
    organisationId: scope.organisationId,
    connectorId: connectorId.value,
  };
  const now = Date.now();
  const connector =
    await resolveActiveConnectorActorAtPlacement<SlackConnectorActor>({
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
              "Purin Pantry posted the proposal with a Start button in this thread. A person who starts it gets a new thread for it. Tell them in one sentence what you proposed. Do not do that work in this turn.",
          }
        : notProposed(
            "Purin Pantry kept the proposal, but this thread does not show it now. Tell the person in plain words what you found instead.",
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
