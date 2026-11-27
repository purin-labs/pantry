import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import { resolveAccountCapability } from "@purin-labs/authority/authorization/access-grants/account-capability";
import {
  insertSlackMessageProposal,
  matchSlackChannel,
  readSlackChannelOptions,
  slackMessageBodyDigest,
} from "../../data/slack-message-proposal";
import { requireSessionExecution } from "@purin-labs/agent/actors/session-execution-admission";
import {
  SlackDraftRequestError,
  type HarnessSlackMessagePropose,
  type HarnessSlackMessageProposalReceipt,
} from "./slack";
import { authorizeCapabilityUse } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import {
  CAPABILITY_KEYS,
  SLACK_MESSAGE_RESOURCE_SCOPE,
} from "@purin-labs/authority/authorization/capability-catalogue";
import {
  proposalFlowEffect,
  type ToolEffect,
  requireCurrentEmailToolLease,
} from "@purin-labs/tool-handlers/agent-tools/session-support";
import type { SessionToolContext } from "@purin-labs/agent/agent-tools/context";

/**
 * Saves a Slack message draft for a person to send from the conversation's
 * card. The draft goes only to a channel that the organisation connected,
 * and nothing is posted here: Send on the card posts it.
 */
export async function proposeSlackMessageForEmbeddedHarness(
  context: SessionToolContext,
  request: HarnessSlackMessagePropose,
): Promise<ToolEffect<HarnessSlackMessageProposalReceipt>> {
  const { env, storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const caseId = requireCurrentEmailToolLease(storage, lease, assignment);
  const capability = await resolveAccountCapability(
    organisationId,
    assignment.authorityPartition.capabilityKeys,
    request.accountRef,
    CAPABILITY_KEYS.slackMessagePropose,
    SLACK_MESSAGE_RESOURCE_SCOPE,
  );
  if (capability === null) {
    throw new Error("Slack drafting is outside the granted scope");
  }
  const authorized = await authorizeCapabilityUse({
    db: execution.scope.database,
    accountAccess: execution.scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    action: "execute",
    organisationId,
    authority: lease.requestAuthority,
    authorityPartition: assignment.authorityPartition,
    request: { capabilities: [capability] },
  });
  if (!authorized.ok) {
    throw new Error(
      `Slack drafting authority rejected: ${authorized.error.code}`,
    );
  }
  return proposalFlowEffect(
    lease,
    {
      capabilityId: CAPABILITY_KEYS.slackMessagePropose,
      integrationAccountId: capability.integrationAccountId,
      resourceScope: SLACK_MESSAGE_RESOURCE_SCOPE,
    },
    async () => {
      const options = await readSlackChannelOptions({
        globalDatabase: env.DB,
        db: execution.scope.database,
        organisationId,
        integrationAccountId: capability.integrationAccountId,
      });
      if (options === null || options.channels.length === 0) {
        throw new SlackDraftRequestError(
          "No Slack channel is connected to Purin Pantry in this workspace. Ask an owner or admin to connect a channel in Integrations.",
        );
      }
      // An unknown channel is refused without naming the connected ones: their
      // names have not entered this turn.
      const matched =
        request.channel === null
          ? null
          : matchSlackChannel(options, request.channel);
      if (request.channel !== null && matched === null) {
        throw new SlackDraftRequestError(
          "That channel is not connected to Purin Pantry. Set channel to null so the person chooses on the card.",
        );
      }
      const bodyDigest = await slackMessageBodyDigest(request.text);
      const proposalId = `proposal_slack_message_${lease.turn.turnId}_${bodyDigest.slice(0, 16)}`;
      await requireSessionExecution(execution, lease);
      const saved = await insertSlackMessageProposal({
        scope: execution.scope,
        proposalId,
        caseId,
        integrationAccountId: capability.integrationAccountId,
        sessionId: lease.session.sessionId,
        turnId: lease.turn.turnId,
        channelHint: request.channel,
        channelId: matched?.channelId ?? null,
        body: request.text,
        now: Date.now(),
      });
      if (!saved.ok) {
        throw new Error(`Slack draft failed: ${saved.error.code}`);
      }
      await requireSessionExecution(execution, lease);
      requireCurrentEmailToolLease(storage, lease, assignment);
      return {
        kind: "proposed",
        proposalId: saved.value.proposalId,
        version: saved.value.version,
        channel: matched === null ? null : request.channel,
      };
    },
  );
}
