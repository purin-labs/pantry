import type { ProposalChangeSummary } from "@purin-labs/bakery-workflow/changes";
import type { RunFinding } from "@purin-labs/bakery-workflow/findings";
import type { Env } from "@purin-labs/kernel/env";
import type { ControlSessionId, OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { UserId } from "@purin-labs/control-api/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

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

export type WorkflowRevisionReceipt = Readonly<{
  workflowId: string;
  revision: number;
  digest: string;
  baseDigest: string | null;
  scenarioDigest: string;
  appliedBy: string;
  appliedAt: number;
  /** Set when a person approved an agent's proposal. A person's own apply has none. */
  proposalId: string | null;
  sessionId: string | null;
  turnId: string | null;
  operationId: string | null;
}>;

export type ApprovedWorkflowChange =
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
type ApplyApprovedWorkflowChange = (
  env: Env,
  execution: OrganisationExecutionScope,
  organisationId: OrganisationId,
  draftId: string,
  command: WorkflowChangeCommand,
  approver: Readonly<{ userId: UserId; controlSessionId: ControlSessionId }>,
) => Promise<ApprovedWorkflowChange>;

/**
 * The proposed and the approved change of a recipe workflow (Plan 84), for a
 * configuration draft that a person confirms. The Kitchen owns the workflow, and the
 * Worker registers the implementation (`worker-ports.ts`).
 */
export type WorkflowChanges = Readonly<{
  applyApprovedWorkflowChange: ApplyApprovedWorkflowChange;
  /** Reads a proposed change from a request body or a stored draft row. */
  parseWorkflowChangeCommand: (raw: unknown) => WorkflowChangeCommand | null;
}>;

export const workflowChanges = definePort<WorkflowChanges>("workflow_changes");
