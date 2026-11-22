import type { applyApprovedWorkflowChange } from "../bakery/workflow-proposals";
import { definePort } from "@purin-labs/kernel/port";

export type { WorkflowChangeCommand } from "../bakery/workflow-proposals";

/**
 * The approved change of a recipe workflow (Plan 84), for a configuration
 * draft that a person confirms. The Kitchen owns the workflow, and the
 * Worker registers the implementation (`worker-ports.ts`).
 */
export type WorkflowChanges = Readonly<{
  applyApprovedWorkflowChange: typeof applyApprovedWorkflowChange;
}>;

export const workflowChanges = definePort<WorkflowChanges>("workflow_changes");
