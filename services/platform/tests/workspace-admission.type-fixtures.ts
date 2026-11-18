import type { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import {
  prepareWorkspaceRevisionMutation,
  commitWorkspaceRevision,
  type WorkspaceRevisionAuthority,
  type WorkspaceRevisionProposal,
} from "../src/workspace-revision-store";
import { ensureOrganisationDefaultWorkspace } from "../src/data/organisation-workspace";
import {
  recordEmailThreadCase,
  recordEmailMessageReceipt,
} from "../src/data/email-mailbox";

declare const scope: OrganisationExecutionScope;
declare const archive: R2Bucket;
declare const proposal: WorkspaceRevisionProposal;
// @ts-expect-error Preparation must capture execution authority before asynchronous work.
void prepareWorkspaceRevisionMutation(archive, proposal);
// @ts-expect-error A copied scope cannot retain private execution authority.
const copiedScope: OrganisationExecutionScope = { ...scope };
void copiedScope;
declare const prepared: Parameters<typeof commitWorkspaceRevision>[1];
// @ts-expect-error A commit uses the prepared scope's database.
void commitWorkspaceRevision(scope.database, archive, prepared);
declare const workspace: Parameters<
  typeof ensureOrganisationDefaultWorkspace
>[0];
const { scope: workspaceScope, ...unscopedWorkspace } = workspace;
void workspaceScope;
// @ts-expect-error Default workspace writes require captured authority.
void ensureOrganisationDefaultWorkspace(unscopedWorkspace);
declare const thread: Parameters<typeof recordEmailThreadCase>[0];
const { scope: threadScope, ...unscopedThread } = thread;
void threadScope;
// @ts-expect-error Thread projections cannot use an unscoped database.
void recordEmailThreadCase(unscopedThread);
declare const receipt: Parameters<typeof recordEmailMessageReceipt>[0];
const { scope: receiptScope, ...unscopedReceipt } = receipt;
void receiptScope;
// @ts-expect-error Receipt projections require the originating fence.
void recordEmailMessageReceipt(unscopedReceipt);

// @ts-expect-error Preparation requires an explicit authority.
void prepareWorkspaceRevisionMutation(scope, archive, proposal);
declare const authorizeCommit: () => Promise<boolean>;
// @ts-expect-error Execution authority must carry its live authorization check.
const missingExecutionAuthority: WorkspaceRevisionAuthority = {
  kind: "execution",
};
void missingExecutionAuthority;
// @ts-expect-error Placement-only authority cannot carry an execution check.
const conflictingAuthority: WorkspaceRevisionAuthority = {
  kind: "placement",
  authorizeCommit,
};
void conflictingAuthority;
declare const executionAuthority: Extract<
  WorkspaceRevisionAuthority,
  { kind: "execution" }
>;
// @ts-expect-error A broad spread cannot turn execution authority into placement-only authority.
const spreadAuthority: WorkspaceRevisionAuthority = {
  ...executionAuthority,
  kind: "placement",
};
void spreadAuthority;
declare const changeset: Extract<
  WorkspaceRevisionProposal,
  { kind: "product_folder_changeset" }
>;
void prepareWorkspaceRevisionMutation(
  scope,
  // @ts-expect-error Placement-only authority can initialize a workspace, but cannot edit one.
  { kind: "placement" },
  archive,
  changeset,
);
declare const pendingCommit: Extract<
  import("../src/actors/workspace-execution-coordinator").CodeModeExecutionProjection,
  { kind: "workspace_commit_pending" }
>;
const { harnessLease, ...originlessIntent } = pendingCommit.intent;
void harnessLease;
// @ts-expect-error Durable recovery must retain the originating harness lease.
const invalidIntent: typeof pendingCommit.intent = originlessIntent;
void invalidIntent;

const { placement: originalPlacement, ...unplacedCommitIntent } =
  pendingCommit.intent;
void originalPlacement;
// @ts-expect-error Commit recovery cannot reacquire a new epoch for old work.
const invalidUnplacedCommit: typeof pendingCommit.intent = unplacedCommitIntent;
void invalidUnplacedCommit;
declare const committedExecution: Extract<
  import("../src/actors/workspace-execution-coordinator").CodeModeExecutionProjection,
  { kind: "workspace_committed" }
>;
// @ts-expect-error An unused allocation cannot carry a charged execution receipt.
const invalidCancellation: import("../src/actors/workspace-execution-coordinator").CodeModeExecutionProjection =
  {
    ...committedExecution,
    kind: "workspace_allocation_cancelled",
    allocationId: "allocation_fixture",
  };
void invalidCancellation;
declare const executor: import("../src/workspace-executor-container").WorkspaceExecutorContainer;
declare const executorRequest: import("../src/workspace-executor-container").WorkspaceExecutorRequest;
// @ts-expect-error Executor dispatch requires captured placement, origin and deadline.
void executor.executeWorkspaceOperation(executorRequest);

declare const campaignDraft: import("../src/data/campaign-brief").ProposeCampaignBriefInput;
const { authorizeCommit: campaignAuthority, ...unboundCampaign } =
  campaignDraft;
void campaignAuthority;
// @ts-expect-error A campaign draft cannot omit origin authorization through a spread.
const invalidCampaign: typeof campaignDraft = unboundCampaign;
void invalidCampaign;
declare const configurationDraft: import("../src/data/operator-configuration-draft").CreateOperatorDraftInput;
const { scope: configurationScope, ...unplacedConfiguration } =
  configurationDraft;
void configurationScope;
// @ts-expect-error Configuration creation requires its captured placement, not raw database identity.
const invalidConfiguration: typeof configurationDraft = unplacedConfiguration;
void invalidConfiguration;
