import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import {
  memoryService,
  type MemoryReadScope,
} from "../memory/contract/memory-service";
import { type ShownMemoryRevision } from "../memory/contract/turn-memory";
import { resolveActiveCaseActor } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  projectEmailReplyProposal,
  type EmailReplyProposalProjection,
  type EmailReplyProposalLifecycle,
} from "../data/email-mailbox";
import {
  parseCaseId,
  parseIntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Variant } from "@purin-labs/type-utils";

export async function syncEmailProposalLifecycle(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    env: Env;
    organisationId: OrganisationId;
    projection: EmailReplyProposalProjection;
    lifecycle: import("../data/email-mailbox").EmailReplyProposalLifecycle;
    now: number;
  }>,
): Promise<void> {
  if (!(await input.scope.isActive())) return;
  const caseId = parseCaseId(input.projection.caseId);
  if (caseId.ok) {
    const caseActor = await resolveActiveCaseActor({
      env: input.env,
      namespace: input.env.CASE,
      organisationId: input.organisationId,
      caseId: caseId.value,
      now: input.now,
    });
    if (caseActor.ok) {
      if (!(await input.scope.isActive())) return;
      const moved = await caseActor.value.transitionEmailProposal({
        proposalId: input.projection.proposalId,
        version: input.projection.currentVersion,
        lifecycle: input.lifecycle,
      });
      // The Case owns the lifecycle: a move that it refuses is not copied.
      if (!moved.ok && caseRefusedMove(moved.error.code)) return;
    }
  }
  const accountId = parseIntegrationAccountId(
    input.projection.integrationAccountId,
  );
  if (accountId.ok) {
    await projectEmailReplyProposal({
      scope: input.scope,
      integrationAccountId: accountId.value,
      proposalId: input.projection.proposalId,
      caseId: input.projection.caseId,
      gmailThreadId: input.projection.gmailThreadId,
      currentVersion: input.projection.currentVersion,
      lifecycleKind: input.lifecycle.kind,
      now: input.now,
    });
  }
}

/** The Case answers a move that its machine does not allow with these. */
function caseRefusedMove(code: string): boolean {
  return (
    code === "case_email_proposal_immutable" ||
    code === "case_email_proposal_transition_refused" ||
    code === "case_email_proposal_transition_stale"
  );
}

/**
 * The Memory a reply's drafting turn was shown, as far as this person may
 * inspect it. A revision hidden from them is left out, and nothing says that
 * one was. A failed read shows none.
 */
export async function replyMemoryViews(
  env: Env,
  viewer: MemoryReadScope,
  shown: readonly ShownMemoryRevision[],
): Promise<
  readonly Readonly<{
    memory_id: string;
    revision: number;
    statement: string;
  }>[]
> {
  if (shown.length === 0) return [];
  const views = await memoryService.use().readMemoryViews(env, viewer);
  if (!views.ok) return [];
  const used = [];
  for (const one of shown) {
    const revision = views.value
      .find((view) => view.memoryId === one.memoryId)
      ?.revisions.find((entry) => entry.revision === one.revision);
    if (revision !== undefined)
      used.push({
        memory_id: one.memoryId,
        revision: one.revision,
        statement: revision.statement,
      });
  }
  return used;
}

export async function recordEmailReplyRevision(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    env: Env;
    organisationId: OrganisationId;
    projection: EmailReplyProposalProjection;
    revision: Readonly<{
      version: number;
      bodyDigest: string;
      snapshotDigest: string;
    }> &
      (
        | Readonly<{ kind: "edit"; draftMessageId: string; lifecycle?: never }>
        | Readonly<{
            kind: "dispatch";
            draftMessageId?: never;
            lifecycle: Variant<
              EmailReplyProposalLifecycle,
              "sent" | "send_indeterminate"
            >;
          }>
      );
    now: number;
  }>,
): Promise<void> {
  const lifecycle: EmailReplyProposalLifecycle =
    input.revision.kind === "edit"
      ? { kind: "awaiting_approval" }
      : input.revision.lifecycle;
  if (!(await input.scope.isActive())) return;
  const caseId = parseCaseId(input.projection.caseId);
  if (caseId.ok) {
    const caseActor = await resolveActiveCaseActor({
      env: input.env,
      namespace: input.env.CASE,
      organisationId: input.organisationId,
      caseId: caseId.value,
      now: input.now,
    });
    if (caseActor.ok) {
      if (!(await input.scope.isActive())) return;
      if (input.revision.version > input.projection.currentVersion) {
        const proposals = await caseActor.value.readEmailProposals();
        const base = proposals.ok
          ? proposals.value.find(
              (proposal) =>
                proposal.proposalId === input.projection.proposalId &&
                proposal.version === input.projection.currentVersion,
            )
          : undefined;
        if (base !== undefined && !("kind" in base)) {
          if (!(await input.scope.isActive())) return;
          await caseActor.value.acceptEmailProposal({
            proposalId: base.proposalId,
            version: input.revision.version,
            caseId: base.caseId,
            threadId: base.threadId,
            providerDraftId: base.providerDraftId,
            providerDraftMessageId:
              input.revision.kind === "edit"
                ? input.revision.draftMessageId
                : base.providerDraftMessageId,
            triggeringProviderMessageId: base.triggeringProviderMessageId,
            mailboxBindingId: base.mailboxBindingId,
            bindingRevision: base.bindingRevision,
            policyVersion: base.policyVersion,
            targetDigest: base.targetDigest,
            bodyDigest: input.revision.bodyDigest,
            snapshotDigest: input.revision.snapshotDigest,
            createdAt: base.createdAt,
            expiresAt: base.expiresAt,
            lifecycle,
          });
          if (!(await input.scope.isActive())) return;
          await caseActor.value.transitionEmailProposal({
            proposalId: input.projection.proposalId,
            version: input.projection.currentVersion,
            lifecycle: {
              kind: "superseded",
              supersededByVersion: input.revision.version,
              disposal: { kind: "cleaned", deletedAt: input.now },
            },
          });
        }
      } else {
        const moved = await caseActor.value.transitionEmailProposal({
          proposalId: input.projection.proposalId,
          version: input.revision.version,
          lifecycle,
        });
        if (!moved.ok && caseRefusedMove(moved.error.code)) return;
      }
    }
  }
  const accountId = parseIntegrationAccountId(
    input.projection.integrationAccountId,
  );
  if (accountId.ok) {
    await projectEmailReplyProposal({
      scope: input.scope,
      integrationAccountId: accountId.value,
      proposalId: input.projection.proposalId,
      caseId: input.projection.caseId,
      gmailThreadId: input.projection.gmailThreadId,
      currentVersion: input.revision.version,
      lifecycleKind: lifecycle.kind,
      now: input.now,
    });
  }
}
