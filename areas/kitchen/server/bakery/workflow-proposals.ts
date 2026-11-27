import { compileDraft, draftSeed } from "@purin-labs/bakery-workflow/draft";
import {
  applyWorkflowChanges,
  parseProposalChangeSummary,
  proposalChangeSummary,
  proposalDraftMerge,
  proposalOverlap,
  type WorkflowChange,
} from "@purin-labs/bakery-workflow/changes";
import { parseRunFindings } from "@purin-labs/bakery-workflow/findings";
import { isRecord } from "@purin-labs/std";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { KitchenOrganisationActor } from "../actors/organisation-kitchen-rpc";
import type { Env } from "@purin-labs/kernel/env";
import type { ControlSessionId, OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  applyWorkflowRevision,
  readCurrentWorkflow,
  readWorkflowDocument,
  readWorkflowFindings,
  signalBakeryWorkflowApplied,
  storeWorkflowDocument,
} from "./workflow-revisions";
import type {
  ApprovedWorkflowChange,
  WorkflowChangeCommand,
  WorkflowRevisionReceipt,
} from "@purin-labs/area-kitchen-contract/server/workflow-changes";

export type { WorkflowChangeCommand } from "@purin-labs/area-kitchen-contract/server/workflow-changes";

type PreparedWorkflowProposal =
  | Readonly<{ kind: "ready"; command: WorkflowChangeCommand }>
  | Readonly<{ kind: "refused"; message: string }>;

/**
 * The checks of a proposal, and its exact content in the store. A refusal stores
 * nothing. The result must pass the engine's admission, and a step that a person
 * changed in the shared draft stays theirs.
 */
export async function prepareWorkflowProposal(
  env: Env,
  execution: OrganisationExecutionScope,
  input: Readonly<{
    workflowId: string;
    baseDigest: string;
    changes: readonly WorkflowChange[];
    reason: string;
    findingIds: readonly string[];
    sessionId: string;
    turnId: string;
    operationId: string;
  }>,
): Promise<PreparedWorkflowProposal> {
  const organisationId = execution.organisationId;
  const refused = (message: string): PreparedWorkflowProposal => ({
    kind: "refused",
    message,
  });
  const current = await readCurrentWorkflow(
    env,
    execution.database,
    organisationId,
    input.workflowId,
  );
  if (current === null)
    return refused(
      "That recipe has no applied workflow. Call recipe_workflow_read with null for the list.",
    );
  if (current.receipt.digest !== input.baseDigest)
    return refused(
      "revision_conflict: the recipe changed after your read. Call recipe_workflow_read again.",
    );
  const applied = applyWorkflowChanges(current.document, input.changes);
  if (applied.kind === "refused")
    return refused(`The changes do not fit: ${problemText(applied.problems)}`);
  const compiled = await compileDraft(current.document, applied.snapshot);
  if (compiled.kind === "refused")
    return refused(
      `The engine refuses this result: ${problemText(compiled.problems)}`,
    );
  const organisation =
    await requireActiveOrganisationActor<KitchenOrganisationActor>({
      env,
      organisationId,
      now: Date.now(),
    });
  const draft = await organisation.bakeryWorkflowDraftSnapshot({
    organisationId,
    workflowId: input.workflowId,
  });
  const baseSeed = draftSeed(current.document);
  const proposedSeed = draftSeed(compiled.document);
  const overlap =
    draft === null ? [] : proposalOverlap(baseSeed, proposedSeed, draft);
  if (overlap.length > 0)
    return refused(
      `human_intervention: a person changed ${overlap.join(", ")} in the shared draft. Tell the person, and read the workflow again after they apply or undo it.`,
    );
  const stored = await readWorkflowFindings(
    env,
    organisationId,
    input.workflowId,
    current.receipt.digest,
  );
  const findings = [];
  for (const id of input.findingIds) {
    const finding = stored?.findings.find((item) => item.id === id);
    if (finding === undefined)
      return refused(
        `The last run has no finding ${id}. Read the workflow again.`,
      );
    findings.push(finding);
  }
  return {
    kind: "ready",
    command: {
      workflowId: input.workflowId,
      title: current.document.title,
      baseDigest: current.receipt.digest,
      proposedDigest: await storeWorkflowDocument(
        env,
        organisationId,
        compiled.document,
      ),
      reason: input.reason,
      findings,
      change: proposalChangeSummary(baseSeed, proposedSeed),
      sessionId: input.sessionId,
      turnId: input.turnId,
      operationId: input.operationId,
    },
  };
}

function problemText(
  problems: readonly Readonly<{ message: string }>[],
): string {
  return problems
    .slice(0, 8)
    .map((problem) => problem.message)
    .join(" ");
}

/**
 * Applies an approved proposal. A retry after a lost process reaches the first check
 * again: the revision is already there, and only the draft and the signal repeat.
 */
export async function applyApprovedWorkflowChange(
  env: Env,
  execution: OrganisationExecutionScope,
  organisationId: OrganisationId,
  draftId: string,
  command: WorkflowChangeCommand,
  approver: Readonly<{ userId: UserId; controlSessionId: ControlSessionId }>,
): Promise<ApprovedWorkflowChange> {
  const current = await readCurrentWorkflow(
    env,
    execution.database,
    organisationId,
    command.workflowId,
  );
  const proposed = await readWorkflowDocument(
    env,
    organisationId,
    command.proposedDigest,
  );
  const base = await readWorkflowDocument(
    env,
    organisationId,
    command.baseDigest,
  );
  if (current === null || proposed === null || base === null)
    return { kind: "invalid" };
  const baseSeed = draftSeed(base);
  const proposedSeed = draftSeed(proposed);
  const organisation =
    await requireActiveOrganisationActor<KitchenOrganisationActor>({
      env,
      organisationId,
      now: Date.now(),
    });
  let receipt: WorkflowRevisionReceipt;
  if (current.receipt.digest === command.proposedDigest)
    receipt = current.receipt;
  else {
    if (current.receipt.digest !== command.baseDigest)
      return { kind: "revision_conflict" };
    const draft = await organisation.bakeryWorkflowDraftSnapshot({
      organisationId,
      workflowId: command.workflowId,
    });
    const steps =
      draft === null ? [] : proposalOverlap(baseSeed, proposedSeed, draft);
    if (steps.length > 0) return { kind: "human_intervention", steps };
    const applied = await applyWorkflowRevision(
      env,
      execution.database,
      organisationId,
      command.workflowId,
      approver.userId,
      proposed,
      command.baseDigest,
      {
        proposalId: draftId,
        sessionId: command.sessionId,
        turnId: command.turnId,
        operationId: command.operationId,
      },
    );
    if (applied.kind === "stale") return { kind: "revision_conflict" };
    if (applied.kind !== "applied") return { kind: "invalid" };
    receipt = applied.receipt;
  }
  const merged = await organisation.bakeryWorkflowMergeProposal({
    organisationId,
    workflowId: command.workflowId,
    change: proposalDraftMerge(baseSeed, proposedSeed),
    userId: approver.userId,
    controlSessionId: approver.controlSessionId,
  });
  if (!merged.ok) return { kind: "draft_unavailable" };
  await signalBakeryWorkflowApplied(env, organisationId, command.workflowId);
  return { kind: "applied", receipt };
}

/** Reads a proposed change from a request body or a stored draft row. */
export function parseWorkflowChangeCommand(
  raw: unknown,
): WorkflowChangeCommand | null {
  if (!isRecord(raw)) return null;
  const { workflowId, title, baseDigest, proposedDigest, reason } = raw;
  const { sessionId, turnId, operationId } = raw;
  const findings = parseRunFindings(raw.findings);
  const change = parseProposalChangeSummary(raw.change);
  return typeof workflowId === "string" &&
    typeof title === "string" &&
    typeof baseDigest === "string" &&
    typeof proposedDigest === "string" &&
    typeof reason === "string" &&
    typeof sessionId === "string" &&
    typeof turnId === "string" &&
    typeof operationId === "string" &&
    findings !== null &&
    change !== null
    ? {
        workflowId,
        title,
        baseDigest,
        proposedDigest,
        reason,
        findings,
        change,
        sessionId,
        turnId,
        operationId,
      }
    : null;
}
