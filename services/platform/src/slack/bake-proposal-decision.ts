import { resolveSlackLinkedMember } from "../actors/action-mutation-execution";
import { requireActiveOrganisationActor } from "../actors/actor-router";
import type { Env } from "../env";
import type { ChannelId, RequestId, SlackAppId, WorkspaceId } from "../ids";
import { traceWarn } from "../observability";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { SlackUserId } from "./events";
import { resolveConfiguredSlackInstallationIdentity } from "./installation-identity";
import { tellClicker } from "./interaction-reply";
import { resolveOrClaimSlackThreadRoute } from "./organisation-routing";

/**
 * A Slack click on Approve or Reject of a bake proposal's card (Plan 24 S1).
 * The card's thread names the Organisation and the proposal's Case. The
 * clicker needs a verified Slack link to a member; the Organisation Actor runs
 * the same decision as the Bakes page, so a viewer stays refused and a
 * rejection keeps its reason. The decision updates the card; a refusal or a
 * repeated click gets a message that only the clicker sees.
 */
export type BakeDecisionClick = Readonly<{
  appId: SlackAppId;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  threadTs: string;
  starter: SlackUserId;
  responseUrl: string;
  decision: "approve" | "reject";
  proposalId: string;
  reason: string | null;
}>;

const UNLINKED =
  "Only an operator, an admin or the owner whose Slack account is linked to Seams Pantry can decide this bake.";
const FAILED =
  "Seams Pantry could not decide this bake now. Try again, or decide it on the Bakes page.";

export async function decideBakeProposalFromSlack(
  env: Env,
  click: BakeDecisionClick,
  requestId: RequestId,
): Promise<void> {
  const answer = await decide(env, click).catch((): string => {
    traceWarn("kitchen.bake_proposal_slack_decision_failed", {
      requestId,
      proposalId: click.proposalId,
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
  const decided = await organisation.runBakeCommand({
    organisationId: route.value.organisationId,
    command: {
      kind: "decide",
      proposalId: click.proposalId,
      caseId: route.value.caseId,
      decision: click.decision,
      reason: click.reason,
      decider: { userId: member.userId, role: member.role, via: "slack" },
    },
  });
  if (!decided.ok)
    return "message" in decided.error &&
      typeof decided.error.message === "string"
      ? decided.error.message
      : FAILED;
  if (decided.value.kind !== "unchanged") return null;
  const proposal = decided.value.proposal;
  return proposal.state === "approved" || proposal.state === "ended"
    ? "This bake is already approved. Nothing changed."
    : "This bake proposal is already rejected. Nothing changed.";
}
