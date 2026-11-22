import { resolveActiveCaseActorAtScope } from "@purin-labs/actor-runtime/actors/actor-router";
import { deliverOperationsCard } from "@purin-labs/actor-runtime/actors/operations-channel";
import {
  readOperationsDestination,
  type OperationsDestination,
} from "@purin-labs/tenancy/data/operations-destination";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId, parseCaseId, type CaseId } from "@purin-labs/kernel/ids";
import {
  markBakeProposalAnnounced,
  type BakeProposal,
} from "../kitchen/bakes/records";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { ensureCaseProject } from "../projects/case-project";
import { BAKE_PROPOSAL_CARD, bakeProposalCardText } from "./bake-proposal-card";
import { parseSlackUserId } from "./events";
import { resolveConfiguredSlackInstallationIdentity } from "./installation-identity";
import { resolveOrClaimSlackThreadRoute } from "./organisation-routing";

/**
 * Tells the shop about a bake proposal (Plan 24 S1). An open proposal gets a
 * real Case, bound to the operations channel, and one Slack card; the card's
 * message is pinned as the root of a thread that resolves to that Case, so a
 * click on the card and a reply in its thread reach the proposal. A decision
 * and the end of the bake run update the same card. A shop with no Slack
 * channel gets the Case only; its people decide on the Bakes page.
 */
export async function announceBakeProposal(
  env: Env,
  scope: OrganisationExecutionScope,
  proposal: BakeProposal,
  now: number,
): Promise<void> {
  try {
    const caseId = parseCaseId(proposal.caseId);
    if (!caseId.ok) throw new Error("A bake proposal names an invalid Case.");
    const destination = await readOperationsDestination(
      scope.database,
      scope.organisationId,
    );
    const channel = destination.ok ? destination.value : null;
    if (proposal.state === "open") {
      await openProposalCase(env, scope, caseId.value, channel, now);
      if (channel === null) {
        await markBakeProposalAnnounced(
          scope.database,
          scope.organisationId,
          proposal.proposalId,
          now,
          null,
        );
        return;
      }
      const ts = await deliverOperationsCard(
        env,
        scope,
        channel,
        {
          deliveryId: BAKE_PROPOSAL_CARD.notice(proposal.proposalId),
          bindingId: `binding_${caseId.value}`,
          caseId: caseId.value,
          caseRevision: 1,
          text: bakeProposalCardText(proposal),
          idempotencyKey: `bake_proposal:${proposal.proposalId}:notice`,
          trace: "kitchen.bake_proposal",
        },
        now,
      );
      if (ts === null) return;
      await pinCardThread(env, channel, caseId.value, ts, now);
      await markBakeProposalAnnounced(
        scope.database,
        scope.organisationId,
        proposal.proposalId,
        now,
        ts,
      );
      return;
    }
    if (channel === null || proposal.state === "waiting") return;
    await deliverOperationsCard(
      env,
      scope,
      channel,
      {
        deliveryId: BAKE_PROPOSAL_CARD.update(
          proposal.proposalId,
          proposal.state,
        ),
        bindingId: `binding_${caseId.value}`,
        caseId: caseId.value,
        caseRevision: proposal.state === "ended" ? 3 : 2,
        text: bakeProposalCardText(proposal),
        idempotencyKey: `bake_proposal:${proposal.proposalId}:${proposal.state}`,
        trace: "kitchen.bake_proposal",
      },
      now,
    );
  } catch {
    traceWarn("kitchen.bake_proposal_announce_failed", {
      requestId: newRequestId(),
      organisationId: scope.organisationId,
      proposalId: proposal.proposalId,
      state: proposal.state,
    });
  }
}

async function openProposalCase(
  env: Env,
  scope: OrganisationExecutionScope,
  caseId: CaseId,
  channel: OperationsDestination | null,
  now: number,
): Promise<void> {
  const caseActor = await resolveActiveCaseActorAtScope({
    scope,
    namespace: env.CASE,
    caseId,
    now,
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const placed = await ensureCaseProject({
    scope,
    caseId,
    origin: "direct",
    now,
  });
  if (!placed.ok) throw new Error(placed.error.code);
  const ensured = await caseActor.value.ensure({
    identity: { organisationId: scope.organisationId, caseId },
    purpose: "bake proposal",
    workspaceRevision: "kitchen:bakes",
    lifecycle: { kind: "open", openedAt: now },
  });
  if (!ensured.ok) throw new Error(ensured.error.code);
  if (channel === null) return;
  const attached = await caseActor.value.attachBinding({
    bindingId: `binding_${caseId}`,
    caseId,
    connectorId: channel.connectorId,
    address: {
      kind: "slack_channel",
      workspaceId: channel.workspaceId,
      channelId: channel.channelId,
    },
  });
  if (!attached.ok) throw new Error(attached.error.code);
}

/** Makes the card's message the root of a thread that resolves to the Case. */
async function pinCardThread(
  env: Env,
  channel: OperationsDestination,
  caseId: CaseId,
  ts: string,
  now: number,
): Promise<void> {
  const installation = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  // The channel claim reads no person; Slack's own system user stands in.
  const system = parseSlackUserId("USLACKBOT", "user");
  if (!installation.ok || !system.ok) return;
  const route = await resolveOrClaimSlackThreadRoute(env.DB, {
    kind: "root",
    environment: installation.value.environment,
    appId: installation.value.appId,
    workspaceId: channel.workspaceId,
    channelId: channel.channelId,
    rootMessageTs: ts,
    caseId,
    occurredAt: now,
    externalUserId: system.value,
  });
  if (route.kind !== "resolved" || route.value.caseId !== caseId)
    traceWarn("kitchen.bake_proposal_thread_unpinned", {
      requestId: newRequestId(),
      caseId,
      outcome: route.kind,
    });
}
