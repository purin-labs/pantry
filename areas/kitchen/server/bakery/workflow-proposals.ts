import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { compileDraft, draftSeed } from "@purin-labs/bakery-workflow/draft";
import {
  applyWorkflowChanges,
  proposalChangeSummary,
  proposalDraftMerge,
  proposalOverlap,
  type ProposalChangeSummary,
  type WorkflowChange,
} from "@purin-labs/bakery-workflow/changes";
import type { RunFinding } from "@purin-labs/bakery-workflow/findings";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
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
  type WorkflowRevisionReceipt,
} from "./workflow-revisions";

/**
 * Plan 84: an agent's proposed change to a recipe. It lives as a configuration draft
 * with the exact digests, in a layer apart from the shared draft. Only the approval
 * of the person who asked writes a revision.
 */
export type WorkflowChangeCommand = Readonly<{
  workflowId: string;
  title: string;
  baseDigest: string;
  proposedDigest: string;
  /** Model text from a private chat, which only the person who asked reads. */
  reason: string;
  /** Copied from the run, so a later run does not change what the person reads. */
  findings: readonly RunFinding[];
  change: ProposalChangeSummary;
  sessionId: string;
  turnId: string;
  operationId: string;
}>;

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
  const organisation = await requireActiveOrganisationActor({
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

type ApprovedWorkflowChange =
  | Readonly<{ kind: "applied"; receipt: WorkflowRevisionReceipt }>
  | Readonly<{ kind: "revision_conflict" }>
  | Readonly<{ kind: "human_intervention"; steps: readonly string[] }>
  | Readonly<{ kind: "invalid" }>
  /** The revision is applied and the draft is not updated. A retry finishes it. */
  | Readonly<{ kind: "draft_unavailable" }>;

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
  const organisation = await requireActiveOrganisationActor({
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

type OpenWorkflowProposal = Readonly<{
  draftId: string;
  command: WorkflowChangeCommand;
  createdAt: number;
  expiresAt: number;
}>;

/** Proposals that wait for this person, for one recipe. */
export async function listOpenWorkflowProposals(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  workflowId: string,
  actorUserId: string,
  now: number,
): Promise<readonly OpenWorkflowProposal[]> {
  const rows = await db
    .prepare(
      `SELECT draft_id AS draftId,
              json_extract(command_json, '$.change') AS command,
              created_at AS createdAt, expires_at AS expiresAt
         FROM operator_configuration_draft
        WHERE organisation_id = ? AND actor_user_id = ?
          AND state = 'pending' AND expires_at > ?
          AND json_extract(command_json, '$.family') = 'workflow_change'
          AND json_extract(command_json, '$.change.workflowId') = ?
        ORDER BY created_at DESC LIMIT 5`,
    )
    .bind(organisationId, actorUserId, now, workflowId)
    .all<
      Readonly<{
        draftId: string;
        command: string;
        createdAt: number;
        expiresAt: number;
      }>
    >();
  return (rows.results ?? []).map((row) => ({
    draftId: row.draftId,
    command: JSON.parse(row.command) as WorkflowChangeCommand,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }));
}
