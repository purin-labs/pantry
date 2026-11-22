import type { Env } from "@purin-labs/kernel/env";
import { resolveActiveCaseActor } from "../actors/actor-router";
import type { EmailReplyProposalLifecycle } from "../data/email-mailbox";
import type { EmailOperationalProposalProjection } from "../data/email-operational";
import { parseCaseId, type OrganisationId } from "@purin-labs/kernel/ids";

export async function syncOperationalCaseLifecycle(
  input: Readonly<{
    readonly env: Env;
    readonly organisationId: OrganisationId;
    readonly projection: EmailOperationalProposalProjection;
    readonly lifecycle: EmailReplyProposalLifecycle;
    readonly now: number;
  }>,
): Promise<void> {
  const caseId = parseCaseId(input.projection.caseId);
  if (!caseId.ok) return;
  const caseActor = await resolveActiveCaseActor({
    env: input.env,
    namespace: input.env.CASE,
    organisationId: input.organisationId,
    caseId: caseId.value,
    now: input.now,
  });
  if (!caseActor.ok) return;
  await caseActor.value.transitionEmailProposal({
    proposalId: input.projection.proposalId,
    version: input.projection.currentVersion,
    lifecycle: input.lifecycle,
  });
}

export async function syncOperationalCaseEdit(
  input: Readonly<{
    readonly env: Env;
    readonly organisationId: OrganisationId;
    readonly projection: EmailOperationalProposalProjection;
    readonly now: number;
  }>,
): Promise<void> {
  const caseId = parseCaseId(input.projection.caseId);
  if (!caseId.ok) return;
  const caseActor = await resolveActiveCaseActor({
    env: input.env,
    namespace: input.env.CASE,
    organisationId: input.organisationId,
    caseId: caseId.value,
    now: input.now,
  });
  if (!caseActor.ok) return;
  const proposals = await caseActor.value.readEmailProposals();
  if (!proposals.ok) return;
  const base = proposals.value.find(
    (proposal) =>
      "kind" in proposal &&
      proposal.kind === "operational_new_message" &&
      proposal.proposalId === input.projection.proposalId &&
      proposal.version === input.projection.currentVersion - 1,
  );
  if (
    base === undefined ||
    !("kind" in base) ||
    base.kind !== "operational_new_message"
  ) {
    return;
  }
  const accepted = await caseActor.value.acceptEmailProposal({
    kind: "operational_new_message",
    proposalId: input.projection.proposalId,
    version: input.projection.currentVersion,
    caseId: input.projection.caseId,
    integrationAccountId: input.projection.integrationAccountId,
    target: input.projection.target,
    targetDigest: input.projection.targetDigest,
    subjectDigest: input.projection.subjectDigest,
    bodyDigest: input.projection.bodyDigest,
    snapshotDigest: input.projection.snapshotDigest,
    policyVersion: base.policyVersion,
    credentialGeneration: base.credentialGeneration,
    createdAt: base.createdAt,
    expiresAt: base.expiresAt,
    lifecycle: { kind: "awaiting_approval" },
  });
  if (!accepted.ok) return;
  await caseActor.value.transitionEmailProposal({
    proposalId: input.projection.proposalId,
    version: base.version,
    lifecycle: {
      kind: "superseded",
      supersededByVersion: input.projection.currentVersion,
      disposal: { kind: "cleaned", deletedAt: input.now },
    },
  });
}
