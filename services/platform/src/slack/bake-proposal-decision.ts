import { resolveSlackLinkedMember } from "../actors/action-mutation-execution";
import { requireActiveOrganisationActor } from "../actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import type {
  ChannelId,
  RequestId,
  SlackAppId,
  WorkspaceId,
} from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { SlackUserId } from "./events";
import { resolveConfiguredSlackInstallationIdentity } from "./installation-identity";
import { tellClicker } from "./interaction-reply";
import { resolveOrClaimSlackThreadRoute } from "./organisation-routing";

/**
 * A Slack click on Approve or Reject of a bake proposal's card (Plan 24 S1),
 * or on Pause of its bake run's card in the same thread (S6). The thread
 * names the Organisation and the proposal's Case. The clicker needs a
 * verified Slack link to a member; the Organisation Actor runs the same
 * command as the Bakes page, so a viewer stays refused and a rejection keeps
 * its reason. The command updates the cards; a refusal or a repeated click
 * gets a message that only the clicker sees. No click moves a cobot.
 */
export type BakeDecisionClick = Readonly<{
  appId: SlackAppId;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  threadTs: string;
  starter: SlackUserId;
  responseUrl: string;
  proposalId: string;
  action:
    | Readonly<{
        kind: "decide";
        decision: "approve" | "reject";
        reason: string | null;
      }>
    | Readonly<{ kind: "pause" }>;
}>;

const UNLINKED =
  "Only an operator, an admin or the owner whose Slack account is linked to Purin Pantry can decide or pause this bake.";
const FAILED =
  "Purin Pantry could not do this now. Try again, or use the Bakes page.";

export async function decideBakeProposalFromSlack(
  env: Env,
  click: BakeDecisionClick,
  requestId: RequestId,
): Promise<void> {
  const answer = await decide(env, click).catch((error: unknown): string => {
    traceWarn("kitchen.bake_proposal_slack_decision_failed", {
      requestId,
      proposalId: click.proposalId,
      error: error instanceof Error ? error.message : String(error),
    });
    return FAILED;
  });
  if (answer !== null && !(await tellClicker(click.responseUrl, answer)))
    traceWarn("kitchen.bake_proposal_slack_reply_failed", {
      requestId,
      proposalId: click.proposalId,
    });
}

/** Null when the card shows the decision; otherwise the clicker's message. */
async function decide(
  env: Env,
  click: BakeDecisionClick,
): Promise<string | null> {
  const installation = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (!installation.ok || installation.value.appId !== click.appId)
    return FAILED;
  const route = await resolveOrClaimSlackThreadRoute(env.DB, {
    kind: "reply",
    environment: installation.value.environment,
    appId: installation.value.appId,
    workspaceId: click.workspaceId,
    channelId: click.channelId,
    rootMessageTs: click.threadTs,
  });
  if (route.kind !== "resolved") return FAILED;
  const scope = await OrganisationExecutionScope.resolve(
    env,
    route.value.organisationId,
  );
  if (!scope.ok) return FAILED;
  const member = await resolveSlackLinkedMember(scope.value.database, {
    organisationId: route.value.organisationId,
    integrationAccountId: route.value.integrationAccountId,
    workspaceId: click.workspaceId,
    slackUserId: click.starter,
  });
  if (member === null) return UNLINKED;
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: route.value.organisationId,
    now: Date.now(),
  });
  const { action } = click;
  const decided = await organisation.runBakeCommand({
    organisationId: route.value.organisationId,
    command:
      action.kind === "pause"
        ? {
            kind: "run_action",
            proposalId: click.proposalId,
            caseId: route.value.caseId,
            action: { kind: "pause" },
            requester: {
              userId: member.userId,
              role: member.role,
              via: "person",
            },
          }
        : {
            kind: "decide",
            proposalId: click.proposalId,
            caseId: route.value.caseId,
            decision: action.decision,
            reason: action.reason,
            decider: { userId: member.userId, role: member.role, via: "slack" },
          },
  });
  if (!decided.ok)
    return "message" in decided.error &&
      typeof decided.error.message === "string"
      ? decided.error.message
      : FAILED;
  // The run's card shows the pause.
  if (action.kind === "pause") return null;
  if (decided.value.kind !== "unchanged") return null;
  const proposal = decided.value.proposal;
  return proposal.state === "approved" || proposal.state === "ended"
    ? "This bake is already approved. Nothing changed."
    : "This bake proposal is already rejected. Nothing changed.";
}
