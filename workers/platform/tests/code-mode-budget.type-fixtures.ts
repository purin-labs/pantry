import {
  CODE_MODE_PRICE_BOOK_REVISION_V2,
  WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
  WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  type WorkspaceExecutorAllocationParent,
  type WorkspaceExecutorAllocationReservation,
} from "@purin-labs/agent/actors/code-mode-budget";
import type { SessionId, OrganisationId } from "@purin-labs/kernel/ids";

declare const organisationId: OrganisationId;
declare const sessionId: SessionId;

const DIGEST = "a".repeat(64);
const identity = {
  organisationId,
  parent: {
    kind: "code_mode_execution" as const,
    executionId: "cmx-workspace-type",
    leaseId: "lease-workspace-type",
  },
  allocationId: "wxa-workspace-type",
  idempotencyKey: "workspace-type",
  allocationDigest: DIGEST,
} as const;

const settledWithLease: WorkspaceExecutorAllocationReservation = {
  ...identity,
  kind: "settled",
  receiptId: "receipt-workspace",
  receiptDigest: DIGEST,
  reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  actualCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  inputBytes: 1,
  outputBytes: 1,
  durationMs: 1,
  outcome: "succeeded",
  settledAt: 1,
  // @ts-expect-error settled allocations cannot retain a live lease
  leaseExpiresAt: 2,
};

const reservedWithReceipt: WorkspaceExecutorAllocationReservation = {
  ...identity,
  kind: "reserved",
  priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
  profile: WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
  reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  executionDeadlineAt: 1,
  leaseExpiresAt: 2,
  // @ts-expect-error reserved allocations cannot contain a terminal receipt
  receiptId: "receipt-workspace",
};

// @ts-expect-error A Code Mode parent cannot carry preparation identity.
const mixedParentLiteral: WorkspaceExecutorAllocationParent = {
  kind: "code_mode_execution",
  executionId: "cmx-workspace-type",
  leaseId: "lease-workspace-type",
  preparationId: "prep-workspace-type",
};

const foreignExecutionIdentity = {
  executionId: "cmx-workspace-type",
} as const;
// @ts-expect-error A preparation parent cannot gain Code Mode identity through a spread.
const mixedParentSpread: WorkspaceExecutorAllocationParent = {
  kind: "attachment_preparation",
  preparationId: "prep-workspace-type",
  leaseId: "lease-workspace-type",
  sessionId,
  turnId: "turn-workspace-type",
  runtimeGeneration: 1,
  ...foreignExecutionIdentity,
};

void [
  settledWithLease,
  reservedWithReceipt,
  mixedParentLiteral,
  mixedParentSpread,
];
