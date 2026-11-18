import {
  authorizeSessionTurnExecution,
  sessionTurnExecution,
} from "../chat/turn-access";
import type {
  HarnessTurnLease,
  IdempotencyKey,
  ProductFieldV1,
  ValidatedProductFolderChangesetV1,
  WorkspaceRevisionReceipt,
} from "@seams/contracts";

import type { Env } from "../env";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { newRequestId, parseOrganisationId, type OrganisationId } from "../ids";
import type { Result } from "../result";
import {
  commitWorkspaceRevision,
  parseWorkspaceReceipt,
  prepareWorkspaceRevisionMutation,
  readWorkspaceRevision,
  verifyWorkspaceRevisionReceipt,
  type WorkspaceRevisionFileCandidate,
  type WorkspaceRevisionMaterialization,
  type WorkspaceRevisionProposal,
} from "../workspace-revision-store";
import {
  parseWorkspaceExecutorResponse,
  parseWorkspaceInvocation,
  parseWorkspaceExecutorPlacement,
  type WorkspaceExecutorPlacement,
  type WorkspaceExecutorInvocation,
  type WorkspaceExecutorProductFiles,
  type WorkspaceExecutorRequest,
  type WorkspaceExecutorResponse,
  type WorkspaceExecutorOperationResult,
} from "../workspace-executor-container";
import { readCanonicalSessionProjection } from "./agent-session-canonical";
import { codeModeExecutionReceiptId } from "./agent-session-code-mode-settlement";
import {
  parsePersistedHarnessTurnLease,
  preflightHarnessTurnLease,
} from "./agent-session-harness-authority";
import type { HarnessCodeModeExecutionLease } from "../agent-tools/catalog/types";
import {
  CODE_MODE_PRICE_BOOK_REVISION_V2,
  WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
  WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  type WorkspaceExecutorAllocationParent,
  type WorkspaceExecutorAllocationReservation,
  type WorkspaceExecutorAllocationSettleInput,
} from "./code-mode-budget";
import {
  cancelWorkspaceExecutorAllocation,
  reserveWorkspaceExecutorAllocation,
  settleWorkspaceExecutorAllocation,
} from "./workspace-execution-allocation";
import type { Variant } from "@seams/type-utils";
import {
  hasExactKeys,
  canonicalJson,
  isNonNegativeInteger,
  isRecord,
  isString,
  sha256Hex,
} from "@seams/std";
import { armAlarmBy } from "./lifecycle/actor-alarm";

const WORKSPACE_COMMIT_INITIAL_RETRY_DELAY_MS = 1_000;
const WORKSPACE_COMMIT_MAX_RETRY_DELAY_MS = 300_000;
const MAX_PENDING_WORKSPACE_COMMITS = 8;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PRODUCT_ROOT_PATTERN = /^products\/[A-Za-z0-9._-]+$/;
const WORKSPACE_OPERATION_IDENTITY_KEYS = [
  "productRoot",
  "candidate",
  "claimedChangeset",
  "committedAt",
] as const;

export type CodeModeExecutionCounter = {
  readonly capabilityCalls: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
};

export type CodeModeExecutionProjection =
  | ({
      readonly kind: "workspace_allocation_cancelled";
      readonly allocationReceipt?: never;
      readonly workspaceRevisionReceipt?: never;
      readonly intent?: never;
      readonly allocationId: string;
      readonly operationIdentity: WorkspaceOperationIdentity;
    } & CodeModeExecutionCounter)
  | ({ readonly kind: "pending" | "dispatching" } & CodeModeExecutionCounter)
  | ({
      readonly kind: "workspace_allocation_pending";
      readonly intent: WorkspaceAllocationIntent;
    } & CodeModeExecutionCounter)
  | ({
      readonly kind: "workspace_allocation_settlement_pending";
      readonly intent: WorkspaceAllocationSettlementIntent;
    } & CodeModeExecutionCounter)
  | ({
      readonly kind: "workspace_execution_failed";
      readonly operationIdentity: WorkspaceOperationIdentity;
      readonly allocationReceipt: FailedWorkspaceAllocationReceipt;
    } & CodeModeExecutionCounter)
  | ({
      readonly kind: "workspace_commit_failed";
      readonly operationIdentity: WorkspaceOperationIdentity;
      readonly allocationReceipt: SucceededWorkspaceAllocationReceipt;
      readonly reason: string;
    } & CodeModeExecutionCounter)
  | ({
      readonly kind: "workspace_commit_pending";
      readonly allocationReceipt: SucceededWorkspaceAllocationReceipt;
      readonly intent: WorkspaceCommitIntent;
    } & CodeModeExecutionCounter)
  | ({
      /** Decoded only for persisted pre-preparation execution projections. */
      readonly kind: "workspace_inspection_settled";
      readonly inspection: WorkspaceInspectionIdentity;
      readonly allocationReceipt: WorkspaceAllocationReceipt;
    } & CodeModeExecutionCounter)
  | ({
      readonly kind: "workspace_committed";
      readonly operationIdentity: WorkspaceOperationIdentity;
      readonly allocationReceipt: SucceededWorkspaceAllocationReceipt;
      readonly workspaceRevisionReceipt: WorkspaceRevisionReceipt;
    } & CodeModeExecutionCounter);

type RecoverableWorkspaceProjection = Variant<
  CodeModeExecutionProjection,
  | "workspace_allocation_pending"
  | "workspace_allocation_settlement_pending"
  | "workspace_commit_pending"
>;

export type WorkspaceProductFolderOperation = {
  readonly harnessLease: HarnessTurnLease;
  readonly executionLease: HarnessCodeModeExecutionLease;
  readonly productRoot: string;
  readonly candidate: WorkspaceExecutorProductFiles;
  readonly claimedChangeset: ValidatedProductFolderChangesetV1;
  readonly deadlineAtUnixMs: number;
  readonly committedAt: number;
};

export type WorkspaceExecutionCoordinatorError =
  | { readonly code: "workspace_execution_invalid"; readonly field: string }
  | { readonly code: "workspace_execution_lease_rejected" }
  | { readonly code: "workspace_execution_state_conflict" }
  | {
      readonly code: "workspace_execution_base_unavailable";
      readonly reason: string;
    }
  | {
      readonly code: "workspace_execution_container_failed";
      readonly reason: string;
    }
  | {
      readonly code: "workspace_execution_allocation_failed";
      readonly reason: string;
    }
  | {
      readonly code: "workspace_execution_prepare_failed";
      readonly reason: string;
    }
  | {
      readonly code: "workspace_execution_commit_failed";
      readonly reason: string;
    }
  | { readonly code: "workspace_execution_recovery_corrupt" };

type WorkspaceAllocationIntent = {
  readonly placement: WorkspaceExecutorPlacement;
  readonly schemaVersion: "workspace_allocation_intent.v1";
  readonly harnessLease: HarnessTurnLease;
  readonly request: WorkspaceExecutorRequest;
  readonly reservation: Variant<
    WorkspaceExecutorAllocationReservation,
    "reserved"
  >;
  readonly committedAt: number;
};

type WorkspaceAllocationSettlementIntent = {
  readonly schemaVersion: "workspace_allocation_settlement_intent.v1";
  readonly allocation: WorkspaceAllocationIntent;
  readonly invocation: WorkspaceExecutorInvocation;
  readonly receipt: WorkspaceAllocationReceipt;
};

type WorkspaceAllocationReceiptCommon = {
  readonly schemaVersion: "workspace_allocation_receipt.v1";
  readonly allocationId: string;
  readonly allocationDigest: string;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly reservedCostMicros: typeof WORKSPACE_EXECUTOR_RESERVED_COST_MICROS;
  readonly actualCostMicros: typeof WORKSPACE_EXECUTOR_RESERVED_COST_MICROS;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly durationMs: number;
  readonly settledAt: number;
};

/** Names what an inspection read, and the digest of what it returned. */
export type WorkspaceInspectionIdentity = {
  readonly attachmentId: string;
  readonly sha256: string;
  readonly resultDigest: string;
};

export type SucceededWorkspaceAllocationReceipt =
  WorkspaceAllocationReceiptCommon & {
    readonly kind: "succeeded";
    readonly outcome: "succeeded";
    readonly executorReport: WorkspaceExecutorReport;
  };

export type FailedWorkspaceAllocationReceipt =
  WorkspaceAllocationReceiptCommon & {
    readonly kind: "failed";
    readonly outcome: "organisation_failed" | "platform_failed";
    readonly reason: string;
    readonly executorReport: WorkspaceExecutorReport | null;
  };

export type WorkspaceAllocationReceipt =
  SucceededWorkspaceAllocationReceipt | FailedWorkspaceAllocationReceipt;

type WorkspaceExecutorReport = {
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly durationMs: number;
};

type WorkspaceCommitIntent = {
  readonly placement: WorkspaceExecutorPlacement;
  readonly harnessLease: HarnessTurnLease;
  readonly schemaVersion: "workspace_commit_intent.v1";
  readonly request: WorkspaceExecutorRequest;
  readonly response: WorkspaceExecutorResponse;
  readonly expectedReceipt: WorkspaceRevisionReceipt;
  readonly idempotencyKey: IdempotencyKey;
  readonly committedAt: number;
};

type WorkspaceOperationIdentity = {
  readonly productRoot: string;
  readonly candidate: WorkspaceExecutorProductFiles;
  readonly claimedChangeset: ValidatedProductFolderChangesetV1;
  readonly committedAt: number;
};

type ExecutionOutboxRow = Record<string, SqlStorageValue> & {
  readonly effect_id: string;
  readonly request_envelope: string;
  readonly state_projection: string;
};

export type ExecutionRequestIdentity = {
  readonly executionId: string;
  readonly leaseId: string;
  readonly organisationId: OrganisationId;
};

export async function executeWorkspaceProductFolderOperation(input: {
  readonly scope: OrganisationExecutionScope;
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly operation: WorkspaceProductFolderOperation;
}): Promise<
  Result<WorkspaceRevisionReceipt, WorkspaceExecutionCoordinatorError>
> {
  const organisationId = parseOrganisationId(
    input.operation.harnessLease.session.organisationId,
  );
  if (!organisationId.ok) return invalid("organisationId");
  if (
    organisationId.value !== input.scope.organisationId ||
    !(await input.scope.isActive())
  )
    return { ok: false, error: { code: "workspace_execution_lease_rejected" } };
  if (
    !(await authorizeWorkspaceTurn(
      input.env,
      input.scope,
      input.storage,
      input.operation.harnessLease,
      input.scope,
    ))
  )
    return { ok: false, error: { code: "workspace_execution_lease_rejected" } };

  const existing = readCodeModeExecutionProjection(
    input.storage.sql,
    input.operation.executionLease.executionId,
  );
  if (existing?.kind === "workspace_committed") {
    return existing.workspaceRevisionReceipt.correlationId ===
      input.operation.executionLease.executionId &&
      workspaceOperationMatches(existing.operationIdentity, input.operation)
      ? { ok: true, value: existing.workspaceRevisionReceipt }
      : { ok: false, error: { code: "workspace_execution_state_conflict" } };
  }
  if (existing?.kind === "workspace_allocation_cancelled") {
    return workspaceOperationMatches(
      existing.operationIdentity,
      input.operation,
    )
      ? { ok: false, error: { code: "workspace_execution_lease_rejected" } }
      : conflict();
  }
  if (existing?.kind === "workspace_execution_failed") {
    if (
      !workspaceOperationMatches(existing.operationIdentity, input.operation)
    ) {
      return {
        ok: false,
        error: { code: "workspace_execution_state_conflict" },
      };
    }
    return {
      ok: false,
      error: {
        code: "workspace_execution_container_failed",
        reason: existing.allocationReceipt.reason,
      },
    };
  }
  if (existing?.kind === "workspace_commit_failed") {
    return workspaceOperationMatches(
      existing.operationIdentity,
      input.operation,
    )
      ? {
          ok: false,
          error: {
            code: "workspace_execution_commit_failed",
            reason: existing.reason,
          },
        }
      : { ok: false, error: { code: "workspace_execution_state_conflict" } };
  }
  if (
    existing?.kind === "workspace_allocation_pending" ||
    existing?.kind === "workspace_allocation_settlement_pending" ||
    existing?.kind === "workspace_commit_pending"
  ) {
    return { ok: false, error: { code: "workspace_execution_state_conflict" } };
  }

  const baseReceipt = currentWorkspaceReceipt(
    input.storage.sql,
    input.operation,
  );
  if (!baseReceipt.ok) return baseReceipt;
  const materialized = await readWorkspaceRevision(
    input.scope.database,
    input.env.ARCHIVE,
    {
      organisationId: organisationId.value,
      workspaceId: baseReceipt.value.workspaceId,
      revision: baseReceipt.value.revision,
    },
  );
  if (!materialized.ok) {
    return {
      ok: false,
      error: {
        code: "workspace_execution_base_unavailable",
        reason: materialized.error.code,
      },
    };
  }
  const request = buildWorkspaceExecutorRequest({
    operation: input.operation,
    baseReceipt: baseReceipt.value,
    materialized: materialized.value,
  });
  if (!request.ok) return request;

  const allocationDigest = await sha256Hex(JSON.stringify(request.value));
  if (
    !(await authorizeWorkspaceTurn(
      input.env,
      input.scope,
      input.storage,
      input.operation.harnessLease,
      input.scope,
    ))
  )
    return { ok: false, error: { code: "workspace_execution_lease_rejected" } };
  const reserved = await reserveWorkspaceExecutorAllocation({
    env: input.env,
    organisationId: organisationId.value,
    executionLease: input.operation.executionLease,
    allocationDigest,
    executionDeadlineAt: input.operation.deadlineAtUnixMs,
    now: Date.now(),
  });
  if (!reserved.ok || reserved.value.kind !== "reserved") {
    if (
      !reserved.ok &&
      reserved.error.code === "workspace_allocation_authority_indeterminate"
    ) {
      markWorkspaceCommitIndeterminate(
        input.storage.sql,
        executionEffectId(input.operation.executionLease.executionId),
        reserved.error.reason,
        Date.now(),
      );
    }
    return {
      ok: false,
      error: {
        code: "workspace_execution_allocation_failed",
        reason: reserved.ok ? reserved.value.kind : reserved.error.reason,
      },
    };
  }
  const allocationIntent: WorkspaceAllocationIntent = {
    schemaVersion: "workspace_allocation_intent.v1",
    placement: {
      organisationId: input.scope.organisationId,
      placement: input.scope.placement,
      fenceToken: input.scope.fenceToken,
    },
    harnessLease: input.operation.harnessLease,
    request: request.value,
    reservation: reserved.value,
    committedAt: input.operation.committedAt,
  };
  await scheduleWorkspaceCommitRetry(
    input.storage,
    Date.now(),
    WORKSPACE_COMMIT_INITIAL_RETRY_DELAY_MS,
  );
  const allocationRecorded = input.storage.transactionSync(
    recordWorkspaceAllocationIntent.bind(
      null,
      input.storage.sql,
      input.operation.executionLease,
      allocationIntent,
      Date.now(),
    ),
  );
  if (!allocationRecorded.ok) {
    await cancelWorkspaceExecutorAllocation({
      env: input.env,
      organisationId: organisationId.value,
      executionLease: input.operation.executionLease,
      reason: "admission_compensated",
      now: Date.now(),
    });
    return allocationRecorded;
  }

  return dispatchWorkspaceAllocation({
    scope: input.scope,
    env: input.env,
    storage: input.storage,
    identity: {
      executionId: input.operation.executionLease.executionId,
      leaseId: input.operation.executionLease.leaseId,
      organisationId: organisationId.value,
    },
    projection: {
      kind: "workspace_allocation_pending",
      ...existingCounter(existing),
      intent: allocationIntent,
    },
  });
}

async function dispatchWorkspaceAllocation(input: {
  readonly scope: OrganisationExecutionScope;
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly identity: ExecutionRequestIdentity;
  readonly projection: Variant<
    CodeModeExecutionProjection,
    "workspace_allocation_pending"
  >;
}): Promise<
  Result<WorkspaceRevisionReceipt, WorkspaceExecutionCoordinatorError>
> {
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "workspace_execution_lease_rejected" } };
  const executor = input.env.WORKSPACE_EXECUTOR.getByName(
    input.projection.intent.reservation.allocationId,
  );
  const request = input.projection.intent.request;
  const lease = input.projection.intent.harnessLease;
  let outcome: WorkspaceExecutorOperationResult;
  try {
    if (
      await authorizeWorkspaceTurn(
        input.env,
        input.scope,
        input.storage,
        lease,
        input.projection.intent.placement,
      )
    ) {
      outcome = await executor.executeWorkspaceOperation(request, {
        placement: input.projection.intent.placement,
        execution: sessionTurnExecution(lease),
        expiresAt: lease.expiresAt,
      });
      if (
        !outcome.ok &&
        outcome.error.code === "workspace_operation_authority_inactive"
      )
        outcome = await executor.recoverWorkspaceOperation(request);
    } else {
      outcome = await executor.recoverWorkspaceOperation(request);
    }
  } catch {
    // The durable allocation intent remains pending. Recovery asks the same executor.
    return {
      ok: false,
      error: {
        code: "workspace_execution_allocation_failed",
        reason: "executor_response_unavailable",
      },
    };
  }
  if (!outcome.ok) {
    if (outcome.error.code === "workspace_operation_released") {
      const current = readCodeModeExecutionProjection(
        input.storage.sql,
        input.identity.executionId,
      );
      // A concurrent continuation can already own the durable result and release its copy.
      if (current !== null && current.kind !== "workspace_allocation_pending")
        return conflict();
    }
    if (outcome.error.code === "workspace_operation_pending")
      return {
        ok: false,
        error: {
          code: "workspace_execution_allocation_failed",
          reason: outcome.error.code,
        },
      };
    return {
      ok: false,
      error: { code: "workspace_execution_recovery_corrupt" },
    };
  }
  if (outcome.value.kind === "cancelled") {
    const cancelled = await cancelWorkspaceExecutorAllocation({
      env: input.env,
      organisationId: input.identity.organisationId,
      executionLease: {
        executionId: input.identity.executionId,
        leaseId: input.identity.leaseId,
      },
      reason: "turn_cancelled",
      now: Date.now(),
    });
    if (!cancelled.ok || cancelled.value.kind !== "cancelled")
      return {
        ok: false,
        error: {
          code: "workspace_execution_allocation_failed",
          reason: "allocation_cancellation_unconfirmed",
        },
      };
    input.storage.transactionSync(
      recordWorkspaceAllocationCancelled.bind(
        null,
        input.storage.sql,
        input.identity,
        input.projection,
        Date.now(),
      ),
    );
    return { ok: false, error: { code: "workspace_execution_lease_rejected" } };
  }
  const invocation = outcome.value.invocation;
  const receipt = await buildWorkspaceAllocationReceipt({
    intent: input.projection.intent,
    invocation,
    settledAt: Date.now(),
  });
  const settlementIntent: WorkspaceAllocationSettlementIntent = {
    schemaVersion: "workspace_allocation_settlement_intent.v1",
    allocation: input.projection.intent,
    invocation,
    receipt,
  };
  await scheduleWorkspaceCommitRetry(
    input.storage,
    Date.now(),
    WORKSPACE_COMMIT_INITIAL_RETRY_DELAY_MS,
  );
  const recorded = input.storage.transactionSync(
    recordWorkspaceAllocationSettlementIntent.bind(
      null,
      input.storage.sql,
      {
        executionId: input.identity.executionId,
        leaseId: input.identity.leaseId,
      },
      settlementIntent,
      Date.now(),
    ),
  );
  if (!recorded.ok) return recorded;
  return settleWorkspaceAllocationAndContinue({
    scope: input.scope,
    env: input.env,
    storage: input.storage,
    identity: input.identity,
    projection: {
      kind: "workspace_allocation_settlement_pending",
      capabilityCalls: input.projection.capabilityCalls,
      inputBytes: input.projection.inputBytes,
      outputBytes: input.projection.outputBytes,
      intent: settlementIntent,
    },
  });
}

async function settleWorkspaceAllocationAndContinue(input: {
  readonly scope: OrganisationExecutionScope;
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly identity: ExecutionRequestIdentity;
  readonly projection: Variant<
    CodeModeExecutionProjection,
    "workspace_allocation_settlement_pending"
  >;
}): Promise<
  Result<WorkspaceRevisionReceipt, WorkspaceExecutionCoordinatorError>
> {
  const receipt = input.projection.intent.receipt;
  if (!(await validWorkspaceAllocationReceiptDigest(receipt))) {
    return {
      ok: false,
      error: { code: "workspace_execution_recovery_corrupt" },
    };
  }
  await input.env.WORKSPACE_EXECUTOR.getByName(
    input.projection.intent.allocation.reservation.allocationId,
  ).releaseWorkspaceOperation(input.projection.intent.allocation.request);
  const settled = await settleWorkspaceExecutorAllocation({
    env: input.env,
    organisationId: input.identity.organisationId,
    settlement: workspaceAllocationSettleInput(input.identity, receipt),
  });
  if (!settled.ok || settled.value.kind !== "settled") {
    if (
      !settled.ok &&
      settled.error.code === "workspace_allocation_authority_indeterminate"
    ) {
      markWorkspaceCommitIndeterminate(
        input.storage.sql,
        executionEffectId(input.identity.executionId),
        settled.error.reason,
        Date.now(),
      );
    }
    return {
      ok: false,
      error: {
        code: "workspace_execution_allocation_failed",
        reason: settled.ok ? settled.value.kind : settled.error.reason,
      },
    };
  }
  if (receipt.kind === "failed") {
    const failed = input.storage.transactionSync(
      recordWorkspaceExecutionFailed.bind(
        null,
        input.storage.sql,
        {
          executionId: input.identity.executionId,
          leaseId: input.identity.leaseId,
        },
        workspaceOperationIdentityFromAllocation(
          input.projection.intent.allocation,
        ),
        receipt,
        Date.now(),
      ),
    );
    return failed.ok
      ? {
          ok: false,
          error: {
            code: "workspace_execution_container_failed",
            reason: receipt.reason,
          },
        }
      : failed;
  }
  if (
    !(await authorizeWorkspaceTurn(
      input.env,
      input.scope,
      input.storage,
      input.projection.intent.allocation.harnessLease,
      input.projection.intent.allocation.placement,
    ))
  ) {
    return recordTerminalWorkspaceCommitFailure({
      storage: input.storage,
      identity: input.identity,
      projection: input.projection,
      reason: "harness_lease_rejected",
    });
  }
  if (input.projection.intent.invocation.kind !== "succeeded") {
    return {
      ok: false,
      error: { code: "workspace_execution_recovery_corrupt" },
    };
  }
  const request = input.projection.intent.allocation.request;
  const base = await readWorkspaceRevision(
    input.scope.database,
    input.env.ARCHIVE,
    {
      organisationId: input.identity.organisationId,
      workspaceId: request.operation.claimedChangeset.workspaceId,
      revision: request.baseRevision,
    },
  );
  if (!base.ok) {
    return recordTerminalWorkspaceCommitFailure({
      storage: input.storage,
      identity: input.identity,
      projection: input.projection,
      reason: base.error.code,
    });
  }
  const proposal = buildProposalFromPersistedAllocation(
    base.value,
    input.projection.intent,
  );
  const prepared = await prepareWorkspaceRevisionMutation(
    input.scope,
    {
      kind: "execution",
      authorizeCommit: authorizeWorkspaceTurn.bind(
        null,
        input.env,
        input.scope,
        input.storage,
        input.projection.intent.allocation.harnessLease,
        input.projection.intent.allocation.placement,
      ),
    },
    input.env.ARCHIVE,
    proposal,
  );
  if (!prepared.ok) {
    return {
      ok: false,
      error: {
        code: "workspace_execution_prepare_failed",
        reason: prepared.error.code,
      },
    };
  }
  const intent: WorkspaceCommitIntent = {
    schemaVersion: "workspace_commit_intent.v1",
    placement: input.projection.intent.allocation.placement,
    harnessLease: input.projection.intent.allocation.harnessLease,
    request,
    response: input.projection.intent.invocation.response,
    expectedReceipt: prepared.value.receipt,
    idempotencyKey: proposal.idempotencyKey,
    committedAt: input.projection.intent.allocation.committedAt,
  };
  await scheduleWorkspaceCommitRetry(
    input.storage,
    Date.now(),
    WORKSPACE_COMMIT_INITIAL_RETRY_DELAY_MS,
  );
  const commitIntentRecorded = input.storage.transactionSync(
    recordWorkspaceCommitIntent.bind(
      null,
      input.storage.sql,
      {
        executionId: input.identity.executionId,
        leaseId: input.identity.leaseId,
      },
      receipt,
      intent,
      Date.now(),
    ),
  );
  if (!commitIntentRecorded.ok) return commitIntentRecorded;

  const committed = await commitWorkspaceRevision(
    input.env.ARCHIVE,
    prepared.value,
  );
  if (!committed.ok) {
    if (isTerminalWorkspaceCommitFailure(committed.error.code)) {
      input.storage.transactionSync(
        markWorkspaceCommitIndeterminate.bind(
          null,
          input.storage.sql,
          executionEffectId(input.identity.executionId),
          committed.error.code,
          Date.now(),
        ),
      );
    }
    return {
      ok: false,
      error: {
        code: "workspace_execution_commit_failed",
        reason: committed.error.code,
      },
    };
  }
  const verified = await verifyWorkspaceRevisionReceipt(
    input.scope,
    input.identity.organisationId,
    prepared.value.receipt,
  );
  if (!verified.ok) {
    return {
      ok: false,
      error: {
        code: "workspace_execution_commit_failed",
        reason: verified.error.code,
      },
    };
  }
  const accepted = input.storage.transactionSync(
    recordWorkspaceCommitAccepted.bind(
      null,
      input.storage.sql,
      {
        executionId: input.identity.executionId,
        leaseId: input.identity.leaseId,
      },
      verified.value,
      Date.now(),
    ),
  );
  if (!accepted.ok) return accepted;
  if (
    !(await authorizeWorkspaceTurn(
      input.env,
      input.scope,
      input.storage,
      input.projection.intent.allocation.harnessLease,
      input.projection.intent.allocation.placement,
    ))
  )
    return { ok: false, error: { code: "workspace_execution_lease_rejected" } };
  return { ok: true, value: verified.value };
}

function recordTerminalWorkspaceCommitFailure(input: {
  readonly storage: DurableObjectStorage;
  readonly identity: ExecutionRequestIdentity;
  readonly projection: Variant<
    CodeModeExecutionProjection,
    "workspace_allocation_settlement_pending"
  >;
  readonly reason: string;
}): Result<WorkspaceRevisionReceipt, WorkspaceExecutionCoordinatorError> {
  const receipt = input.projection.intent.receipt;
  if (receipt.kind !== "succeeded") {
    return {
      ok: false,
      error: { code: "workspace_execution_recovery_corrupt" },
    };
  }
  const recorded = input.storage.transactionSync(
    recordWorkspaceCommitFailed.bind(
      null,
      input.storage.sql,
      {
        executionId: input.identity.executionId,
        leaseId: input.identity.leaseId,
      },
      workspaceOperationIdentityFromAllocation(
        input.projection.intent.allocation,
      ),
      receipt,
      input.reason,
      Date.now(),
    ),
  );
  return recorded.ok
    ? {
        ok: false,
        error: {
          code: "workspace_execution_commit_failed",
          reason: input.reason,
        },
      }
    : recorded;
}

export async function reconcileWorkspaceCommitIntents(input: {
  readonly scope: OrganisationExecutionScope;
  readonly env: Env;
  readonly storage: DurableObjectStorage;
}): Promise<void> {
  if (!(await input.scope.isActive())) return;
  const rows = input.storage.sql
    .exec<ExecutionOutboxRow>(
      `SELECT effect_id, request_envelope, state_projection
     FROM actor_outbox
     WHERE state_kind IN ('pending', 'dispatching')
       AND json_extract(request_envelope, '$.kind') = 'code_mode_execution.v1'
       AND json_extract(state_projection, '$.kind') IN (
         'workspace_allocation_pending',
         'workspace_allocation_settlement_pending',
         'workspace_commit_pending'
       )
     ORDER BY updated_at ASC
     LIMIT ?`,
      MAX_PENDING_WORKSPACE_COMMITS,
    )
    .toArray();

  for (const row of rows) {
    const identity = parseExecutionRequestIdentity(row.request_envelope);
    const projection = parseCodeModeExecutionProjection(row.state_projection);
    if (
      identity === null ||
      identity.organisationId !== input.scope.organisationId ||
      !isRecoverableWorkspaceProjection(projection)
    ) {
      markWorkspaceCommitIndeterminate(
        input.storage.sql,
        row.effect_id,
        "invalid_persisted_intent",
        Date.now(),
      );
      continue;
    }
    const recovered = await recoverWorkspaceExecution({
      scope: input.scope,
      env: input.env,
      storage: input.storage,
      identity,
      projection,
    });
    if (!recovered.ok) {
      if (recovered.error.code === "workspace_execution_recovery_corrupt") {
        markWorkspaceCommitIndeterminate(
          input.storage.sql,
          row.effect_id,
          "workspace_commit_recovery_corrupt",
          Date.now(),
        );
      } else {
        const persisted = readCodeModeExecutionProjection(
          input.storage.sql,
          identity.executionId,
        );
        if (isRecoverableWorkspaceProjection(persisted)) {
          const now = Date.now();
          await scheduleWorkspaceCommitRetry(
            input.storage,
            now,
            workspaceCommitRetryDelay(persisted, now),
          );
        }
      }
    }
  }
}

async function recoverWorkspaceExecution(input: {
  readonly scope: OrganisationExecutionScope;
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly identity: ExecutionRequestIdentity;
  readonly projection: Variant<
    CodeModeExecutionProjection,
    | "workspace_allocation_pending"
    | "workspace_allocation_settlement_pending"
    | "workspace_commit_pending"
  >;
}): Promise<Result<null, WorkspaceExecutionCoordinatorError>> {
  switch (input.projection.kind) {
    case "workspace_allocation_pending": {
      const recovered = await dispatchWorkspaceAllocation({
        scope: input.scope,
        env: input.env,
        storage: input.storage,
        identity: input.identity,
        projection: input.projection,
      });
      return recovered.ok ? { ok: true, value: null } : recovered;
    }
    case "workspace_allocation_settlement_pending": {
      const recovered = await settleWorkspaceAllocationAndContinue({
        scope: input.scope,
        env: input.env,
        storage: input.storage,
        identity: input.identity,
        projection: input.projection,
      });
      return recovered.ok ? { ok: true, value: null } : recovered;
    }
    case "workspace_commit_pending":
      return recoverWorkspaceCommit({
        scope: input.scope,
        env: input.env,
        storage: input.storage,
        identity: input.identity,
        projection: input.projection,
      });
  }
}

export function readCodeModeExecutionProjection(
  sql: SqlStorage,
  executionId: string,
): CodeModeExecutionProjection | null {
  const row = sql
    .exec<ExecutionOutboxRow>(
      `SELECT effect_id, request_envelope, state_projection
     FROM actor_outbox WHERE effect_id = ? LIMIT 1`,
      executionEffectId(executionId),
    )
    .toArray()[0];
  return row === undefined
    ? null
    : parseCodeModeExecutionProjection(row.state_projection);
}

export function writeCodeModeExecutionCounter(
  storage: DurableObjectStorage,
  executionLease: HarnessCodeModeExecutionLease,
  counter: CodeModeExecutionCounter,
  now: number,
): Result<null, WorkspaceExecutionCoordinatorError> {
  return storage.transactionSync(
    updateExecutionCounter.bind(
      null,
      storage.sql,
      executionLease,
      counter,
      now,
    ),
  );
}

export function parseCodeModeExecutionProjection(
  raw: string,
): CodeModeExecutionProjection | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const counter = parseCounter(value);
  if (counter === null) return null;
  switch (value.kind) {
    case "pending":
    case "dispatching":
      return { kind: value.kind, ...counter };
    case "workspace_allocation_pending": {
      const intent = parseWorkspaceAllocationIntent(value.intent);
      return intent === null
        ? null
        : { kind: "workspace_allocation_pending", ...counter, intent };
    }
    case "workspace_allocation_settlement_pending": {
      const intent = parseWorkspaceAllocationSettlementIntent(value.intent);
      return intent === null
        ? null
        : {
            kind: "workspace_allocation_settlement_pending",
            ...counter,
            intent,
          };
    }
    case "workspace_allocation_cancelled": {
      const operationIdentity = parseWorkspaceOperationIdentity(
        value.operationIdentity,
      );
      return typeof value.allocationId === "string" &&
        value.allocationId.length > 0 &&
        operationIdentity !== null
        ? {
            kind: "workspace_allocation_cancelled",
            ...counter,
            allocationId: value.allocationId,
            operationIdentity,
          }
        : null;
    }
    case "workspace_execution_failed": {
      const allocationReceipt = parseWorkspaceAllocationReceipt(
        value.allocationReceipt,
      );
      const operationIdentity = parseWorkspaceOperationIdentity(
        value.operationIdentity,
      );
      return allocationReceipt?.kind === "failed" && operationIdentity !== null
        ? {
            kind: "workspace_execution_failed",
            ...counter,
            operationIdentity,
            allocationReceipt,
          }
        : null;
    }
    case "workspace_commit_failed": {
      const allocationReceipt = parseWorkspaceAllocationReceipt(
        value.allocationReceipt,
      );
      const operationIdentity = parseWorkspaceOperationIdentity(
        value.operationIdentity,
      );
      return allocationReceipt?.kind === "succeeded" &&
        operationIdentity !== null &&
        typeof value.reason === "string"
        ? {
            kind: "workspace_commit_failed",
            ...counter,
            operationIdentity,
            allocationReceipt,
            reason: value.reason,
          }
        : null;
    }
    case "workspace_commit_pending": {
      const intent = parseWorkspaceCommitIntent(value.intent);
      const allocationReceipt = parseWorkspaceAllocationReceipt(
        value.allocationReceipt,
      );
      return intent === null || allocationReceipt?.kind !== "succeeded"
        ? null
        : {
            kind: "workspace_commit_pending",
            ...counter,
            allocationReceipt,
            intent,
          };
    }
    case "workspace_inspection_settled": {
      const allocationReceipt = parseWorkspaceAllocationReceipt(
        value.allocationReceipt,
      );
      const inspection = parseWorkspaceInspectionIdentity(value.inspection);
      return allocationReceipt === null || inspection === null
        ? null
        : {
            kind: "workspace_inspection_settled",
            ...counter,
            inspection,
            allocationReceipt,
          };
    }
    case "workspace_committed": {
      const workspaceRevisionReceipt = parseWorkspaceReceipt(
        value.workspaceRevisionReceipt,
      );
      const allocationReceipt = parseWorkspaceAllocationReceipt(
        value.allocationReceipt,
      );
      const operationIdentity = parseWorkspaceOperationIdentity(
        value.operationIdentity,
      );
      return workspaceRevisionReceipt === null ||
        allocationReceipt?.kind !== "succeeded" ||
        operationIdentity === null
        ? null
        : {
            kind: "workspace_committed",
            ...counter,
            operationIdentity,
            allocationReceipt,
            workspaceRevisionReceipt,
          };
    }
    default:
      return null;
  }
}

function currentWorkspaceReceipt(
  sql: SqlStorage,
  operation: WorkspaceProductFolderOperation,
): Result<WorkspaceRevisionReceipt, WorkspaceExecutionCoordinatorError> {
  const identity = readExecutionRequestIdentity(
    sql,
    operation.executionLease.executionId,
  );
  if (
    identity === null ||
    identity.executionId !== operation.executionLease.executionId ||
    identity.leaseId !== operation.executionLease.leaseId ||
    identity.organisationId !== operation.harnessLease.session.organisationId
  ) {
    return { ok: false, error: { code: "workspace_execution_state_conflict" } };
  }
  const projection = readCodeModeExecutionProjection(
    sql,
    operation.executionLease.executionId,
  );
  if (projection?.kind === "workspace_committed") {
    return { ok: true, value: projection.workspaceRevisionReceipt };
  }
  if (projection === null || projection.kind === "workspace_commit_pending") {
    return { ok: false, error: { code: "workspace_execution_state_conflict" } };
  }
  const current = readCanonicalSessionProjection(
    sql,
    operation.harnessLease.session.organisationId,
    operation.harnessLease.session.sessionId,
  );
  if (
    current === null ||
    current.kind !== "processing" ||
    current.state.activeTurn.kind !== "awaiting_execution" ||
    current.state.activeTurn.state.executionId !==
      operation.executionLease.executionId
  ) {
    return { ok: false, error: { code: "workspace_execution_state_conflict" } };
  }
  switch (current.state.resumePoint.kind) {
    case "new":
      return {
        ok: true,
        value: current.state.resumePoint.workspaceRevisionReceipt,
      };
    case "checkpoint":
      return {
        ok: true,
        value: current.state.resumePoint.checkpoint.workspaceRevisionReceipt,
      };
  }
}

function buildWorkspaceExecutorRequest(input: {
  readonly operation: WorkspaceProductFolderOperation;
  readonly baseReceipt: WorkspaceRevisionReceipt;
  readonly materialized: WorkspaceRevisionMaterialization;
}): Result<WorkspaceExecutorRequest, WorkspaceExecutionCoordinatorError> {
  const operation = input.operation;
  if (!PRODUCT_ROOT_PATTERN.test(operation.productRoot))
    return invalid("productRoot");
  if (
    !Number.isSafeInteger(operation.deadlineAtUnixMs) ||
    operation.deadlineAtUnixMs <= Date.now() ||
    operation.deadlineAtUnixMs > operation.harnessLease.expiresAt
  )
    return invalid("deadlineAtUnixMs");
  if (
    operation.claimedChangeset.organisationId !==
      operation.harnessLease.session.organisationId ||
    operation.claimedChangeset.workspaceId !== input.baseReceipt.workspaceId ||
    operation.claimedChangeset.baseRevision !== input.baseReceipt.revision
  )
    return invalid("claimedChangeset");
  const workspaceYaml = manifestFile(input.materialized, "workspace.yaml");
  const productMarkdown = manifestFile(
    input.materialized,
    `${operation.productRoot}/product.md`,
  );
  const variantsYaml = manifestFile(
    input.materialized,
    `${operation.productRoot}/variants.yaml`,
  );
  if (
    workspaceYaml === null ||
    productMarkdown === null ||
    variantsYaml === null
  ) {
    return invalid("baseFiles");
  }
  return {
    ok: true,
    value: {
      schemaVersion: "workspace_executor_request.v1",
      executionId: operation.executionLease.executionId,
      executionReceiptId: codeModeExecutionReceiptId(
        operation.executionLease.executionId,
      ),
      deadlineAtUnixMs: operation.deadlineAtUnixMs,
      baseRevision: input.baseReceipt.revision,
      baseCanonicalHead: input.materialized.canonicalHead,
      baseManifestDigest: input.materialized.manifestDigest,
      operation: {
        kind: "product_folder_candidate",
        productRoot: operation.productRoot,
        workspaceYaml,
        base: { productMarkdown, variantsYaml },
        candidate: operation.candidate,
        claimedChangeset: operation.claimedChangeset,
      },
    },
  };
}

function buildProposalFromPersistedAllocation(
  base: WorkspaceRevisionMaterialization,
  intent: WorkspaceAllocationSettlementIntent,
): WorkspaceRevisionProposal {
  if (intent.invocation.kind !== "succeeded") {
    throw new Error("Workspace allocation response is unavailable");
  }
  const request = intent.allocation.request;
  const files = base.manifest.files.map(
    replaceManifestFile.bind(
      null,
      intent.invocation.response.operation.replacementOverlay,
    ),
  );
  return {
    kind: "product_folder_changeset",
    organisationId: intent.allocation.reservation.organisationId,
    workspaceId: request.operation.claimedChangeset.workspaceId,
    idempotencyKey: workspaceCommitIdempotencyKey(request.executionId),
    files,
    correlationId: request.executionId,
    causation: {
      kind: "effect_receipt",
      receiptId: request.executionReceiptId,
    },
    committedAt: intent.allocation.committedAt,
    changeset: intent.invocation.response.operation.validatedChangeset,
  };
}

async function buildWorkspaceAllocationReceipt(input: {
  readonly intent: WorkspaceAllocationIntent;
  readonly invocation: WorkspaceExecutorInvocation;
  readonly settledAt: number;
}): Promise<WorkspaceAllocationReceipt> {
  const common: Omit<WorkspaceAllocationReceiptCommon, "receiptDigest"> = {
    schemaVersion: "workspace_allocation_receipt.v1" as const,
    allocationId: input.intent.reservation.allocationId,
    allocationDigest: input.intent.reservation.allocationDigest,
    receiptId: `workspace-allocation-receipt-${input.intent.reservation.allocationId}`,
    reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    actualCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    inputBytes: input.invocation.usage.requestBytes,
    outputBytes: input.invocation.usage.responseBytes,
    durationMs: input.invocation.usage.gatewayDurationMs,
    settledAt: input.settledAt,
  };
  if (input.invocation.kind === "succeeded") {
    const material = {
      ...common,
      kind: "succeeded" as const,
      outcome: "succeeded" as const,
      executorReport: executorReport(input.invocation.response),
    };
    return {
      ...material,
      receiptDigest: await sha256Hex(JSON.stringify(material)),
    };
  }
  const material = {
    ...common,
    kind: "failed" as const,
    outcome: workspaceAllocationOutcome(input.invocation),
    reason: workspaceInvocationReason(input.invocation),
    executorReport: null,
  };
  return {
    ...material,
    receiptDigest: await sha256Hex(JSON.stringify(material)),
  };
}

function workspaceAllocationOutcome(
  invocation: Variant<WorkspaceExecutorInvocation, "failed">,
): "organisation_failed" | "platform_failed" {
  return invocation.error.kind === "executor_rejected" &&
    invocation.error.status >= 400 &&
    invocation.error.status < 500
    ? "organisation_failed"
    : "platform_failed";
}

function workspaceInvocationReason(
  invocation: Variant<WorkspaceExecutorInvocation, "failed">,
): string {
  return invocation.error.kind === "executor_rejected"
    ? `executor_rejected:${invocation.error.status}`
    : invocation.error.kind;
}

function executorReport(
  response: WorkspaceExecutorResponse,
): WorkspaceExecutorReport {
  return {
    inputBytes: response.inputBytes,
    outputBytes: response.outputBytes,
    durationMs: response.durationMs,
  };
}

function workspaceAllocationSettleInput(
  identity: ExecutionRequestIdentity,
  receipt: WorkspaceAllocationReceipt,
): WorkspaceExecutorAllocationSettleInput {
  return {
    requestId: newRequestId(),
    organisationId: identity.organisationId,
    parent: {
      kind: "code_mode_execution",
      executionId: identity.executionId,
      leaseId: identity.leaseId,
    },
    allocationId: receipt.allocationId,
    receiptId: receipt.receiptId,
    receiptDigest: receipt.receiptDigest,
    actualCostMicros: receipt.actualCostMicros,
    inputBytes: receipt.inputBytes,
    outputBytes: receipt.outputBytes,
    durationMs: receipt.durationMs,
    outcome: receipt.outcome,
    now: receipt.settledAt,
  };
}

async function validWorkspaceAllocationReceiptDigest(
  receipt: WorkspaceAllocationReceipt,
): Promise<boolean> {
  const { receiptDigest, ...material } = receipt;
  return (await sha256Hex(JSON.stringify(material))) === receiptDigest;
}

function existingCounter(
  projection: CodeModeExecutionProjection | null,
): CodeModeExecutionCounter {
  return projection === null
    ? { capabilityCalls: 0, inputBytes: 0, outputBytes: 0 }
    : {
        capabilityCalls: projection.capabilityCalls,
        inputBytes: projection.inputBytes,
        outputBytes: projection.outputBytes,
      };
}

function replaceManifestFile(
  overlay: WorkspaceExecutorResponse["operation"]["replacementOverlay"],
  file: WorkspaceRevisionMaterialization["manifest"]["files"][number],
): WorkspaceRevisionFileCandidate {
  if (file.path === overlay.productMarkdown.path) {
    return {
      path: file.path,
      mediaType: file.mediaType,
      content: overlay.productMarkdown.utf8,
    };
  }
  if (file.path === overlay.variantsYaml.path) {
    return {
      path: file.path,
      mediaType: file.mediaType,
      content: overlay.variantsYaml.utf8,
    };
  }
  return { path: file.path, mediaType: file.mediaType, content: file.content };
}

async function recoverWorkspaceCommit(input: {
  readonly scope: OrganisationExecutionScope;
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly identity: ExecutionRequestIdentity;
  readonly projection: Variant<
    CodeModeExecutionProjection,
    "workspace_commit_pending"
  >;
}): Promise<Result<null, WorkspaceExecutionCoordinatorError>> {
  const intent = input.projection.intent;
  if (
    intent.request.executionId !== input.identity.executionId ||
    intent.request.executionReceiptId !==
      codeModeExecutionReceiptId(input.identity.executionId)
  )
    return {
      ok: false,
      error: { code: "workspace_execution_recovery_corrupt" },
    };
  const existingReceipt = await verifyWorkspaceRevisionReceipt(
    input.scope,
    input.identity.organisationId,
    intent.expectedReceipt,
  );
  if (existingReceipt.ok) {
    return input.storage.transactionSync(
      recordWorkspaceCommitAccepted.bind(
        null,
        input.storage.sql,
        {
          executionId: input.identity.executionId,
          leaseId: input.identity.leaseId,
        },
        existingReceipt.value,
        Date.now(),
      ),
    );
  }
  if (existingReceipt.error.code !== "workspace_revision_receipt_missing")
    return {
      ok: false,
      error: { code: "workspace_execution_recovery_corrupt" },
    };
  if (
    !(await authorizeWorkspaceTurn(
      input.env,
      input.scope,
      input.storage,
      intent.harnessLease,
      intent.placement,
    ))
  ) {
    return input.storage.transactionSync(
      recordWorkspaceCommitFailed.bind(
        null,
        input.storage.sql,
        {
          executionId: input.identity.executionId,
          leaseId: input.identity.leaseId,
        },
        workspaceOperationIdentityFromCommit(intent),
        input.projection.allocationReceipt,
        "harness_lease_rejected",
        Date.now(),
      ),
    );
  }
  const parsedResponse = parseWorkspaceExecutorResponse(
    JSON.stringify(intent.response),
    intent.request,
  );
  if (!parsedResponse.ok) {
    return {
      ok: false,
      error: { code: "workspace_execution_recovery_corrupt" },
    };
  }
  const base = await readWorkspaceRevision(
    input.scope.database,
    input.env.ARCHIVE,
    {
      organisationId: input.identity.organisationId,
      workspaceId: intent.request.operation.claimedChangeset.workspaceId,
      revision: intent.request.baseRevision,
    },
  );
  if (!base.ok) {
    return {
      ok: false,
      error: {
        code: "workspace_execution_base_unavailable",
        reason: base.error.code,
      },
    };
  }
  const proposal = buildRecoveryProposal(
    base.value,
    intent,
    input.identity.organisationId,
  );
  const prepared = await prepareWorkspaceRevisionMutation(
    input.scope,
    {
      kind: "execution",
      authorizeCommit: authorizeWorkspaceTurn.bind(
        null,
        input.env,
        input.scope,
        input.storage,
        intent.harnessLease,
        intent.placement,
      ),
    },
    input.env.ARCHIVE,
    proposal,
  );
  if (!prepared.ok) {
    return {
      ok: false,
      error: { code: "workspace_execution_recovery_corrupt" },
    };
  }
  if (
    JSON.stringify(prepared.value.receipt) !==
    JSON.stringify(intent.expectedReceipt)
  ) {
    return {
      ok: false,
      error: { code: "workspace_execution_recovery_corrupt" },
    };
  }
  const committed = await commitWorkspaceRevision(
    input.env.ARCHIVE,
    prepared.value,
  );
  if (!committed.ok) {
    if (isTerminalWorkspaceCommitFailure(committed.error.code)) {
      input.storage.transactionSync(
        markWorkspaceCommitIndeterminate.bind(
          null,
          input.storage.sql,
          executionEffectId(input.identity.executionId),
          committed.error.code,
          Date.now(),
        ),
      );
      return {
        ok: false,
        error: { code: "workspace_execution_recovery_corrupt" },
      };
    }
    return {
      ok: false,
      error: {
        code: "workspace_execution_commit_failed",
        reason: committed.error.code,
      },
    };
  }
  const verified = await verifyWorkspaceRevisionReceipt(
    input.scope,
    input.identity.organisationId,
    prepared.value.receipt,
  );
  if (!verified.ok) {
    return {
      ok: false,
      error: { code: "workspace_execution_recovery_corrupt" },
    };
  }
  return input.storage.transactionSync(
    recordWorkspaceCommitAccepted.bind(
      null,
      input.storage.sql,
      {
        executionId: input.identity.executionId,
        leaseId: input.identity.leaseId,
      },
      verified.value,
      Date.now(),
    ),
  );
}

function buildRecoveryProposal(
  base: WorkspaceRevisionMaterialization,
  intent: WorkspaceCommitIntent,
  organisationId: string,
): WorkspaceRevisionProposal {
  const files = base.manifest.files.map(
    replaceManifestFile.bind(
      null,
      intent.response.operation.replacementOverlay,
    ),
  );
  return {
    kind: "product_folder_changeset",
    organisationId,
    workspaceId: intent.request.operation.claimedChangeset.workspaceId,
    idempotencyKey: intent.idempotencyKey,
    files,
    correlationId: intent.request.executionId,
    causation: {
      kind: "effect_receipt",
      receiptId: intent.request.executionReceiptId,
    },
    committedAt: intent.committedAt,
    changeset: intent.response.operation.validatedChangeset,
  };
}

function recordWorkspaceAllocationIntent(
  sql: SqlStorage,
  executionLease: HarnessCodeModeExecutionLease,
  intent: WorkspaceAllocationIntent,
  now: number,
): Result<null, WorkspaceExecutionCoordinatorError> {
  const projection = readCodeModeExecutionProjection(
    sql,
    executionLease.executionId,
  );
  if (projection === null) return conflict();
  if (projection.kind === "workspace_allocation_pending") {
    return canonicalJson(projection.intent) === canonicalJson(intent)
      ? { ok: true, value: null }
      : conflict();
  }
  if (projection.kind !== "pending" && projection.kind !== "dispatching") {
    return conflict();
  }
  const identity = readExecutionRequestIdentity(
    sql,
    executionLease.executionId,
  );
  if (identity === null || identity.leaseId !== executionLease.leaseId)
    return conflict();
  writeExecutionProjection(
    sql,
    executionLease.executionId,
    {
      kind: "workspace_allocation_pending",
      ...existingCounter(projection),
      intent,
    },
    now,
  );
  return { ok: true, value: null };
}

function recordWorkspaceAllocationSettlementIntent(
  sql: SqlStorage,
  executionLease: HarnessCodeModeExecutionLease,
  intent: WorkspaceAllocationSettlementIntent,
  now: number,
): Result<null, WorkspaceExecutionCoordinatorError> {
  const projection = readCodeModeExecutionProjection(
    sql,
    executionLease.executionId,
  );
  if (projection === null) return conflict();
  if (projection.kind === "workspace_allocation_settlement_pending") {
    return canonicalJson(projection.intent) === canonicalJson(intent)
      ? { ok: true, value: null }
      : conflict();
  }
  if (
    projection.kind !== "workspace_allocation_pending" ||
    canonicalJson(projection.intent) !== canonicalJson(intent.allocation)
  )
    return conflict();
  writeExecutionProjection(
    sql,
    executionLease.executionId,
    {
      kind: "workspace_allocation_settlement_pending",
      ...existingCounter(projection),
      intent,
    },
    now,
  );
  return { ok: true, value: null };
}

function recordWorkspaceExecutionFailed(
  sql: SqlStorage,
  executionLease: HarnessCodeModeExecutionLease,
  operationIdentity: WorkspaceOperationIdentity,
  receipt: FailedWorkspaceAllocationReceipt,
  now: number,
): Result<null, WorkspaceExecutionCoordinatorError> {
  const projection = readCodeModeExecutionProjection(
    sql,
    executionLease.executionId,
  );
  if (projection === null) return conflict();
  if (projection.kind === "workspace_execution_failed") {
    return projection.allocationReceipt.receiptDigest ===
      receipt.receiptDigest &&
      JSON.stringify(projection.operationIdentity) ===
        JSON.stringify(operationIdentity)
      ? { ok: true, value: null }
      : conflict();
  }
  if (
    projection.kind !== "workspace_allocation_settlement_pending" ||
    projection.intent.receipt.receiptDigest !== receipt.receiptDigest
  )
    return conflict();
  writeExecutionProjection(
    sql,
    executionLease.executionId,
    {
      kind: "workspace_execution_failed",
      ...existingCounter(projection),
      operationIdentity,
      allocationReceipt: receipt,
    },
    now,
  );
  return { ok: true, value: null };
}

function recordWorkspaceCommitFailed(
  sql: SqlStorage,
  executionLease: HarnessCodeModeExecutionLease,
  operationIdentity: WorkspaceOperationIdentity,
  receipt: SucceededWorkspaceAllocationReceipt,
  reason: string,
  now: number,
): Result<null, WorkspaceExecutionCoordinatorError> {
  const projection = readCodeModeExecutionProjection(
    sql,
    executionLease.executionId,
  );
  if (projection === null) return conflict();
  if (projection.kind === "workspace_commit_failed") {
    return projection.allocationReceipt.receiptDigest ===
      receipt.receiptDigest &&
      JSON.stringify(projection.operationIdentity) ===
        JSON.stringify(operationIdentity) &&
      projection.reason === reason
      ? { ok: true, value: null }
      : conflict();
  }
  let settledReceipt: WorkspaceAllocationReceipt;
  if (projection.kind === "workspace_allocation_settlement_pending") {
    settledReceipt = projection.intent.receipt;
  } else if (projection.kind === "workspace_commit_pending") {
    settledReceipt = projection.allocationReceipt;
  } else {
    return conflict();
  }
  if (
    settledReceipt.kind !== "succeeded" ||
    settledReceipt.receiptDigest !== receipt.receiptDigest
  )
    return conflict();
  writeExecutionProjection(
    sql,
    executionLease.executionId,
    {
      kind: "workspace_commit_failed",
      ...existingCounter(projection),
      operationIdentity,
      allocationReceipt: receipt,
      reason,
    },
    now,
  );
  return { ok: true, value: null };
}

function recordWorkspaceCommitIntent(
  sql: SqlStorage,
  executionLease: HarnessCodeModeExecutionLease,
  allocationReceipt: SucceededWorkspaceAllocationReceipt,
  intent: WorkspaceCommitIntent,
  now: number,
): Result<null, WorkspaceExecutionCoordinatorError> {
  const projection = readCodeModeExecutionProjection(
    sql,
    executionLease.executionId,
  );
  if (projection === null) return conflict();
  if (projection.kind === "workspace_committed") {
    return JSON.stringify(projection.workspaceRevisionReceipt) ===
      JSON.stringify(intent.expectedReceipt) &&
      projection.allocationReceipt.receiptDigest ===
        allocationReceipt.receiptDigest
      ? { ok: true, value: null }
      : conflict();
  }
  if (projection.kind === "workspace_commit_pending") {
    return JSON.stringify(projection.intent) === JSON.stringify(intent) &&
      projection.allocationReceipt.receiptDigest ===
        allocationReceipt.receiptDigest
      ? { ok: true, value: null }
      : conflict();
  }
  if (
    projection.kind !== "workspace_allocation_settlement_pending" ||
    projection.intent.receipt.kind !== "succeeded" ||
    projection.intent.receipt.receiptDigest !== allocationReceipt.receiptDigest
  )
    return conflict();
  const identity = readExecutionRequestIdentity(
    sql,
    executionLease.executionId,
  );
  if (identity === null || identity.leaseId !== executionLease.leaseId)
    return conflict();
  writeExecutionProjection(
    sql,
    executionLease.executionId,
    {
      kind: "workspace_commit_pending",
      ...existingCounter(projection),
      allocationReceipt,
      intent,
    },
    now,
  );
  return { ok: true, value: null };
}

function recordWorkspaceCommitAccepted(
  sql: SqlStorage,
  executionLease: HarnessCodeModeExecutionLease,
  receipt: WorkspaceRevisionReceipt,
  now: number,
): Result<null, WorkspaceExecutionCoordinatorError> {
  const projection = readCodeModeExecutionProjection(
    sql,
    executionLease.executionId,
  );
  if (projection === null) return conflict();
  if (projection.kind === "workspace_committed") {
    return JSON.stringify(projection.workspaceRevisionReceipt) ===
      JSON.stringify(receipt)
      ? { ok: true, value: null }
      : conflict();
  }
  if (projection.kind !== "workspace_commit_pending") return conflict();
  if (
    JSON.stringify(projection.intent.expectedReceipt) !==
    JSON.stringify(receipt)
  )
    return conflict();
  sql.exec(
    `UPDATE actor_outbox
     SET state_projection = ?, updated_at = ?
     WHERE effect_id = ? AND state_kind IN ('pending', 'dispatching')`,
    JSON.stringify({
      kind: "workspace_committed",
      capabilityCalls: projection.capabilityCalls,
      inputBytes: projection.inputBytes,
      outputBytes: projection.outputBytes,
      operationIdentity: workspaceOperationIdentityFromCommit(
        projection.intent,
      ),
      allocationReceipt: projection.allocationReceipt,
      workspaceRevisionReceipt: receipt,
    }),
    now,
    executionEffectId(executionLease.executionId),
  );
  return { ok: true, value: null };
}

function writeExecutionProjection(
  sql: SqlStorage,
  executionId: string,
  projection: CodeModeExecutionProjection,
  now: number,
): void {
  sql.exec(
    `UPDATE actor_outbox
     SET state_kind = 'dispatching', state_projection = ?, updated_at = ?
     WHERE effect_id = ? AND state_kind IN ('pending', 'dispatching')`,
    JSON.stringify(projection),
    now,
    executionEffectId(executionId),
  );
}

function updateExecutionCounter(
  sql: SqlStorage,
  executionLease: HarnessCodeModeExecutionLease,
  counter: CodeModeExecutionCounter,
  now: number,
): Result<null, WorkspaceExecutionCoordinatorError> {
  const identity = readExecutionRequestIdentity(
    sql,
    executionLease.executionId,
  );
  const projection = readCodeModeExecutionProjection(
    sql,
    executionLease.executionId,
  );
  if (
    identity === null ||
    identity.leaseId !== executionLease.leaseId ||
    projection === null
  ) {
    return conflict();
  }
  writeExecutionProjection(
    sql,
    executionLease.executionId,
    projectionWithCounter(projection, counter),
    now,
  );
  return { ok: true, value: null };
}

function projectionWithCounter(
  projection: CodeModeExecutionProjection,
  counter: CodeModeExecutionCounter,
): CodeModeExecutionProjection {
  switch (projection.kind) {
    case "pending":
    case "dispatching":
      return { kind: "dispatching", ...counter };
    case "workspace_allocation_pending":
      return { kind: projection.kind, ...counter, intent: projection.intent };
    case "workspace_allocation_settlement_pending":
      return { kind: projection.kind, ...counter, intent: projection.intent };
    case "workspace_allocation_cancelled":
      return {
        kind: projection.kind,
        ...counter,
        allocationId: projection.allocationId,
        operationIdentity: projection.operationIdentity,
      };
    case "workspace_execution_failed":
      return {
        kind: projection.kind,
        ...counter,
        operationIdentity: projection.operationIdentity,
        allocationReceipt: projection.allocationReceipt,
      };
    case "workspace_commit_failed":
      return {
        kind: projection.kind,
        ...counter,
        operationIdentity: projection.operationIdentity,
        allocationReceipt: projection.allocationReceipt,
        reason: projection.reason,
      };
    case "workspace_commit_pending":
      return {
        kind: projection.kind,
        ...counter,
        allocationReceipt: projection.allocationReceipt,
        intent: projection.intent,
      };
    case "workspace_inspection_settled":
      return {
        kind: projection.kind,
        ...counter,
        inspection: projection.inspection,
        allocationReceipt: projection.allocationReceipt,
      };
    case "workspace_committed":
      return {
        kind: projection.kind,
        ...counter,
        operationIdentity: projection.operationIdentity,
        allocationReceipt: projection.allocationReceipt,
        workspaceRevisionReceipt: projection.workspaceRevisionReceipt,
      };
  }
}

function parseWorkspaceInspectionIdentity(
  raw: unknown,
): WorkspaceInspectionIdentity | null {
  return isRecord(raw) &&
    typeof raw.attachmentId === "string" &&
    raw.attachmentId.length > 0 &&
    SHA256_PATTERN.test(stringOrEmpty(raw.sha256)) &&
    SHA256_PATTERN.test(stringOrEmpty(raw.resultDigest))
    ? {
        attachmentId: raw.attachmentId,
        sha256: stringOrEmpty(raw.sha256),
        resultDigest: stringOrEmpty(raw.resultDigest),
      }
    : null;
}

function parseWorkspaceCommitIntent(
  raw: unknown,
): WorkspaceCommitIntent | null {
  if (!isRecord(raw) || raw.schemaVersion !== "workspace_commit_intent.v1")
    return null;
  const harnessLease = parsePersistedHarnessTurnLease(raw.harnessLease);
  const placement = parseWorkspaceExecutorPlacement(raw.placement);
  const request = parsePersistedWorkspaceExecutorRequest(raw.request);
  const expectedReceipt = parseWorkspaceReceipt(raw.expectedReceipt);
  if (
    harnessLease === null ||
    placement === null ||
    request === null ||
    expectedReceipt === null ||
    typeof raw.idempotencyKey !== "string" ||
    raw.idempotencyKey.length === 0 ||
    !isNonNegativeInteger(raw.committedAt)
  )
    return null;
  const response = parseWorkspaceExecutorResponse(
    JSON.stringify(raw.response),
    request,
  );
  if (!response.ok) return null;
  return {
    schemaVersion: "workspace_commit_intent.v1",
    harnessLease,
    placement,
    request,
    response: response.value,
    expectedReceipt,
    idempotencyKey: raw.idempotencyKey,
    committedAt: raw.committedAt,
  };
}

function parseWorkspaceOperationIdentity(
  raw: unknown,
): WorkspaceOperationIdentity | null {
  if (!isRecord(raw) || !hasExactKeys(raw, WORKSPACE_OPERATION_IDENTITY_KEYS))
    return null;
  if (
    typeof raw.productRoot !== "string" ||
    !PRODUCT_ROOT_PATTERN.test(raw.productRoot) ||
    !isNonNegativeInteger(raw.committedAt)
  )
    return null;
  const candidate = parseProductFiles(raw.candidate);
  const claimedChangeset = parseChangeset(raw.claimedChangeset);
  return candidate === null || claimedChangeset === null
    ? null
    : {
        productRoot: raw.productRoot,
        candidate,
        claimedChangeset,
        committedAt: raw.committedAt,
      };
}

function workspaceOperationIdentityFromAllocation(
  intent: WorkspaceAllocationIntent,
): WorkspaceOperationIdentity {
  return {
    productRoot: intent.request.operation.productRoot,
    candidate: intent.request.operation.candidate,
    claimedChangeset: intent.request.operation.claimedChangeset,
    committedAt: intent.committedAt,
  };
}

function workspaceOperationIdentityFromCommit(
  intent: WorkspaceCommitIntent,
): WorkspaceOperationIdentity {
  return {
    productRoot: intent.request.operation.productRoot,
    candidate: intent.request.operation.candidate,
    claimedChangeset: intent.request.operation.claimedChangeset,
    committedAt: intent.committedAt,
  };
}

function workspaceOperationMatches(
  identity: WorkspaceOperationIdentity,
  operation: WorkspaceProductFolderOperation,
): boolean {
  return (
    JSON.stringify(identity) ===
    JSON.stringify({
      productRoot: operation.productRoot,
      candidate: operation.candidate,
      claimedChangeset: operation.claimedChangeset,
      committedAt: operation.committedAt,
    })
  );
}

function parseWorkspaceAllocationIntent(
  raw: unknown,
): WorkspaceAllocationIntent | null {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== "workspace_allocation_intent.v1"
  ) {
    return null;
  }
  const placement = parseWorkspaceExecutorPlacement(raw.placement);
  const request = parsePersistedWorkspaceExecutorRequest(raw.request);
  const reservation = parseWorkspaceAllocationReservation(raw.reservation);
  const harnessLease = parsePersistedHarnessTurnLease(raw.harnessLease);
  if (
    placement === null ||
    request === null ||
    reservation === null ||
    harnessLease === null ||
    !isNonNegativeInteger(raw.committedAt)
  ) {
    return null;
  }
  if (
    reservation.parent.kind !== "code_mode_execution" ||
    reservation.parent.executionId !== request.executionId ||
    reservation.allocationDigest.length !== 64
  )
    return null;
  return {
    schemaVersion: "workspace_allocation_intent.v1",
    harnessLease,
    placement,
    request,
    reservation,
    committedAt: raw.committedAt,
  };
}

function parseWorkspaceAllocationSettlementIntent(
  raw: unknown,
): WorkspaceAllocationSettlementIntent | null {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== "workspace_allocation_settlement_intent.v1"
  )
    return null;
  const allocation = parseWorkspaceAllocationIntent(raw.allocation);
  const receipt = parseWorkspaceAllocationReceipt(raw.receipt);
  if (allocation === null || receipt === null) return null;
  const invocation = parseWorkspaceInvocation(
    raw.invocation,
    allocation.request,
  );
  if (
    invocation === null ||
    receipt.allocationId !== allocation.reservation.allocationId ||
    receipt.allocationDigest !== allocation.reservation.allocationDigest ||
    (receipt.kind === "succeeded") !== (invocation.kind === "succeeded")
  )
    return null;
  return {
    schemaVersion: "workspace_allocation_settlement_intent.v1",
    allocation,
    invocation,
    receipt,
  };
}

function parseWorkspaceAllocationReservation(
  raw: unknown,
): Variant<WorkspaceExecutorAllocationReservation, "reserved"> | null {
  if (!isRecord(raw) || raw.kind !== "reserved") return null;
  const organisationId =
    typeof raw.organisationId === "string"
      ? parseOrganisationId(raw.organisationId)
      : null;
  const parent = parsePersistedWorkspaceAllocationParent(raw);
  if (
    organisationId === null ||
    !organisationId.ok ||
    parent === null ||
    typeof raw.allocationId !== "string" ||
    typeof raw.idempotencyKey !== "string" ||
    !SHA256_PATTERN.test(stringOrEmpty(raw.allocationDigest)) ||
    raw.priceBookRevision !== CODE_MODE_PRICE_BOOK_REVISION_V2 ||
    !sameWorkspaceAllocationProfile(raw.profile) ||
    raw.reservedCostMicros !== WORKSPACE_EXECUTOR_RESERVED_COST_MICROS ||
    !isNonNegativeInteger(raw.executionDeadlineAt) ||
    !isNonNegativeInteger(raw.leaseExpiresAt)
  )
    return null;
  return {
    kind: "reserved",
    organisationId: organisationId.value,
    parent,
    allocationId: raw.allocationId,
    idempotencyKey: raw.idempotencyKey,
    allocationDigest: stringOrEmpty(raw.allocationDigest),
    priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
    profile: WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
    reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    executionDeadlineAt: raw.executionDeadlineAt,
    leaseExpiresAt: raw.leaseExpiresAt,
  };
}

function parsePersistedWorkspaceAllocationParent(
  raw: Record<string, unknown>,
): WorkspaceExecutorAllocationParent | null {
  if (isRecord(raw.parent)) {
    return raw.parent.kind === "code_mode_execution" &&
      typeof raw.parent.executionId === "string" &&
      typeof raw.parent.leaseId === "string"
      ? {
          kind: "code_mode_execution",
          executionId: raw.parent.executionId,
          leaseId: raw.parent.leaseId,
        }
      : null;
  }
  // Normalize pre-parent-union R2 state only at this persistence boundary.
  return typeof raw.parentExecutionId === "string" &&
    typeof raw.parentLeaseId === "string"
    ? {
        kind: "code_mode_execution",
        executionId: raw.parentExecutionId,
        leaseId: raw.parentLeaseId,
      }
    : null;
}

function parseWorkspaceAllocationReceipt(
  raw: unknown,
): WorkspaceAllocationReceipt | null {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== "workspace_allocation_receipt.v1"
  ) {
    return null;
  }
  if (
    typeof raw.allocationId !== "string" ||
    !SHA256_PATTERN.test(stringOrEmpty(raw.allocationDigest)) ||
    typeof raw.receiptId !== "string" ||
    !SHA256_PATTERN.test(stringOrEmpty(raw.receiptDigest)) ||
    raw.reservedCostMicros !== WORKSPACE_EXECUTOR_RESERVED_COST_MICROS ||
    raw.actualCostMicros !== WORKSPACE_EXECUTOR_RESERVED_COST_MICROS ||
    !isNonNegativeInteger(raw.inputBytes) ||
    !isNonNegativeInteger(raw.outputBytes) ||
    !isNonNegativeInteger(raw.durationMs) ||
    !isNonNegativeInteger(raw.settledAt)
  )
    return null;
  const common: WorkspaceAllocationReceiptCommon = {
    schemaVersion: "workspace_allocation_receipt.v1" as const,
    allocationId: raw.allocationId,
    allocationDigest: stringOrEmpty(raw.allocationDigest),
    receiptId: raw.receiptId,
    receiptDigest: stringOrEmpty(raw.receiptDigest),
    reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    actualCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    inputBytes: raw.inputBytes,
    outputBytes: raw.outputBytes,
    durationMs: raw.durationMs,
    settledAt: raw.settledAt,
  };
  const report = parseWorkspaceExecutorReport(raw.executorReport);
  if (
    raw.kind === "succeeded" &&
    raw.outcome === "succeeded" &&
    report !== null
  ) {
    return {
      ...common,
      kind: "succeeded",
      outcome: "succeeded",
      executorReport: report,
    };
  }
  if (
    raw.kind === "failed" &&
    (raw.outcome === "organisation_failed" ||
      raw.outcome === "platform_failed") &&
    typeof raw.reason === "string" &&
    (raw.executorReport === null || report !== null)
  ) {
    return {
      ...common,
      kind: "failed",
      outcome: raw.outcome,
      reason: raw.reason,
      executorReport: raw.executorReport === null ? null : report,
    };
  }
  return null;
}

function parseWorkspaceExecutorReport(
  raw: unknown,
): WorkspaceExecutorReport | null {
  return isRecord(raw) &&
    isNonNegativeInteger(raw.inputBytes) &&
    isNonNegativeInteger(raw.outputBytes) &&
    isNonNegativeInteger(raw.durationMs)
    ? {
        inputBytes: raw.inputBytes,
        outputBytes: raw.outputBytes,
        durationMs: raw.durationMs,
      }
    : null;
}

function sameWorkspaceAllocationProfile(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    raw.kind === WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.kind &&
    raw.instanceType === WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.instanceType &&
    raw.network === WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.network &&
    raw.maxDurationMs === WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxDurationMs &&
    raw.maxInputBytes === WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxInputBytes &&
    raw.maxOutputBytes ===
      WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxOutputBytes &&
    raw.maxAllocations === WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxAllocations
  );
}

function parsePersistedWorkspaceExecutorRequest(
  raw: unknown,
): WorkspaceExecutorRequest | null {
  if (!isRecord(raw) || !isRecord(raw.operation)) return null;
  if (
    raw.schemaVersion !== "workspace_executor_request.v1" ||
    typeof raw.executionId !== "string" ||
    typeof raw.executionReceiptId !== "string" ||
    !isNonNegativeInteger(raw.deadlineAtUnixMs) ||
    typeof raw.baseRevision !== "string" ||
    !SHA256_PATTERN.test(stringOrEmpty(raw.baseCanonicalHead)) ||
    !SHA256_PATTERN.test(stringOrEmpty(raw.baseManifestDigest)) ||
    raw.operation.kind !== "product_folder_candidate" ||
    !PRODUCT_ROOT_PATTERN.test(stringOrEmpty(raw.operation.productRoot)) ||
    typeof raw.operation.workspaceYaml !== "string"
  )
    return null;
  const base = parseProductFiles(raw.operation.base);
  const candidate = parseProductFiles(raw.operation.candidate);
  const changeset = parseChangeset(raw.operation.claimedChangeset);
  if (base === null || candidate === null || changeset === null) return null;
  return {
    schemaVersion: "workspace_executor_request.v1",
    executionId: raw.executionId,
    executionReceiptId: raw.executionReceiptId,
    deadlineAtUnixMs: raw.deadlineAtUnixMs,
    baseRevision: raw.baseRevision,
    baseCanonicalHead: stringOrEmpty(raw.baseCanonicalHead),
    baseManifestDigest: stringOrEmpty(raw.baseManifestDigest),
    operation: {
      kind: "product_folder_candidate",
      productRoot: stringOrEmpty(raw.operation.productRoot),
      workspaceYaml: raw.operation.workspaceYaml,
      base,
      candidate,
      claimedChangeset: changeset,
    },
  };
}

function parseProductFiles(raw: unknown): WorkspaceExecutorProductFiles | null {
  return isRecord(raw) &&
    typeof raw.productMarkdown === "string" &&
    typeof raw.variantsYaml === "string"
    ? { productMarkdown: raw.productMarkdown, variantsYaml: raw.variantsYaml }
    : null;
}

function parseChangeset(
  raw: unknown,
): ValidatedProductFolderChangesetV1 | null {
  if (!isRecord(raw) || !isRecord(raw.diff)) return null;
  if (
    raw.schemaVersion !== "satyr.product-folder-changeset.v1" ||
    typeof raw.organisationId !== "string" ||
    typeof raw.workspaceId !== "string" ||
    typeof raw.baseRevision !== "string" ||
    !SHA256_PATTERN.test(stringOrEmpty(raw.resultingSemanticHash)) ||
    !SHA256_PATTERN.test(stringOrEmpty(raw.changesetDigest)) ||
    typeof raw.diff.productId !== "string" ||
    !Array.isArray(raw.diff.fields) ||
    !raw.diff.fields.every(isProductField) ||
    !Array.isArray(raw.diff.variantIds) ||
    !raw.diff.variantIds.every(isString)
  )
    return null;
  return {
    schemaVersion: "satyr.product-folder-changeset.v1",
    organisationId: raw.organisationId,
    workspaceId: raw.workspaceId,
    baseRevision: raw.baseRevision,
    resultingSemanticHash: stringOrEmpty(raw.resultingSemanticHash),
    diff: {
      productId: raw.diff.productId,
      fields: raw.diff.fields,
      variantIds: raw.diff.variantIds,
    },
    changesetDigest: stringOrEmpty(raw.changesetDigest),
  };
}

function parseCounter(
  value: Record<string, unknown>,
): CodeModeExecutionCounter | null {
  return isNonNegativeInteger(value.capabilityCalls) &&
    isNonNegativeInteger(value.inputBytes) &&
    isNonNegativeInteger(value.outputBytes)
    ? {
        capabilityCalls: value.capabilityCalls,
        inputBytes: value.inputBytes,
        outputBytes: value.outputBytes,
      }
    : null;
}

function readExecutionRequestIdentity(
  sql: SqlStorage,
  executionId: string,
): ExecutionRequestIdentity | null {
  const row = sql
    .exec<{ request_envelope: string }>(
      `SELECT request_envelope FROM actor_outbox WHERE effect_id = ? LIMIT 1`,
      executionEffectId(executionId),
    )
    .toArray()[0];
  return row === undefined
    ? null
    : parseExecutionRequestIdentity(row.request_envelope);
}

function parseExecutionRequestIdentity(
  raw: string,
): ExecutionRequestIdentity | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.kind !== "code_mode_execution.v1" ||
    typeof value.executionId !== "string" ||
    typeof value.leaseId !== "string" ||
    typeof value.organisationId !== "string"
  )
    return null;
  const organisationId = parseOrganisationId(value.organisationId);
  if (!organisationId.ok) return null;
  return {
    executionId: value.executionId,
    leaseId: value.leaseId,
    organisationId: organisationId.value,
  };
}

function manifestFile(
  materialized: WorkspaceRevisionMaterialization,
  path: string,
): string | null {
  return (
    materialized.manifest.files.find(matchesManifestPath.bind(null, path))
      ?.content ?? null
  );
}

function matchesManifestPath(
  path: string,
  file: { readonly path: string },
): boolean {
  return file.path === path;
}

function workspaceCommitIdempotencyKey(executionId: string): IdempotencyKey {
  return `workspace-${executionId}`;
}

function executionEffectId(executionId: string): string {
  return `execution-${executionId}`;
}

async function scheduleWorkspaceCommitRetry(
  storage: DurableObjectStorage,
  now: number,
  delayMs: number,
): Promise<void> {
  await armAlarmBy(storage, now + delayMs);
}

function workspaceCommitRetryDelay(
  projection: RecoverableWorkspaceProjection,
  now: number,
): number {
  const elapsed = Math.max(0, now - workspaceCommitStartedAt(projection));
  const elapsedWindows =
    Math.floor(elapsed / WORKSPACE_COMMIT_INITIAL_RETRY_DELAY_MS) + 1;
  const exponent = Math.floor(Math.log2(elapsedWindows));
  return Math.min(
    WORKSPACE_COMMIT_MAX_RETRY_DELAY_MS,
    WORKSPACE_COMMIT_INITIAL_RETRY_DELAY_MS * 2 ** exponent,
  );
}

function workspaceCommitStartedAt(
  projection: RecoverableWorkspaceProjection,
): number {
  switch (projection.kind) {
    case "workspace_allocation_pending":
      return projection.intent.committedAt;
    case "workspace_allocation_settlement_pending":
      return projection.intent.allocation.committedAt;
    case "workspace_commit_pending":
      return projection.intent.committedAt;
  }
}

function isRecoverableWorkspaceProjection(
  projection: CodeModeExecutionProjection | null,
): projection is RecoverableWorkspaceProjection {
  return (
    projection?.kind === "workspace_allocation_pending" ||
    projection?.kind === "workspace_allocation_settlement_pending" ||
    projection?.kind === "workspace_commit_pending"
  );
}

function markWorkspaceCommitIndeterminate(
  sql: SqlStorage,
  effectId: string,
  reason: string,
  now: number,
): void {
  sql.exec(
    `UPDATE actor_outbox
     SET state_kind = 'indeterminate', state_projection = ?, updated_at = ?
     WHERE effect_id = ?`,
    JSON.stringify({ kind: "workspace_commit_indeterminate", reason }),
    now,
    effectId,
  );
}

function isTerminalWorkspaceCommitFailure(code: string): boolean {
  return (
    code === "workspace_revision_input_invalid" ||
    code === "workspace_revision_idempotency_conflict" ||
    code === "workspace_revision_base_conflict" ||
    code === "workspace_revision_receipt_conflict"
  );
}

function invalid<TValue>(
  field: string,
): Result<TValue, WorkspaceExecutionCoordinatorError> {
  return { ok: false, error: { code: "workspace_execution_invalid", field } };
}

function conflict<TValue>(): Result<
  TValue,
  WorkspaceExecutionCoordinatorError
> {
  return { ok: false, error: { code: "workspace_execution_state_conflict" } };
}

function isProductField(value: unknown): value is ProductFieldV1 {
  return (
    value === "slug" ||
    value === "title" ||
    value === "description" ||
    value === "currency"
  );
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function authorizeWorkspaceTurn(
  env: Env,
  scope: OrganisationExecutionScope,
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  placement: WorkspaceExecutorPlacement,
): Promise<boolean> {
  if (
    scope.organisationId !== placement.organisationId ||
    scope.fenceToken !== placement.fenceToken ||
    scope.placement.placementEpoch !== placement.placement.placementEpoch ||
    scope.placement.placementCellId !== placement.placement.placementCellId ||
    scope.organisationId !== lease.session.organisationId ||
    !preflightHarnessTurnLease(storage, lease, Date.now()).ok
  )
    return false;
  if (
    !(await authorizeSessionTurnExecution(
      env.DB,
      scope.database,
      scope.organisationId,
      sessionTurnExecution(lease),
      scope.accountAccess,
    ))
  )
    return false;
  return (
    (await scope.isActive()) &&
    preflightHarnessTurnLease(storage, lease, Date.now()).ok
  );
}

function recordWorkspaceAllocationCancelled(
  sql: SqlStorage,
  identity: ExecutionRequestIdentity,
  projection: Variant<
    CodeModeExecutionProjection,
    "workspace_allocation_pending"
  >,
  now: number,
): void {
  const current = readCodeModeExecutionProjection(sql, identity.executionId);
  if (current?.kind === "workspace_allocation_cancelled") return;
  if (
    current?.kind !== "workspace_allocation_pending" ||
    canonicalJson(current.intent) !== canonicalJson(projection.intent)
  )
    throw new Error("workspace_execution_state_conflict");
  writeExecutionProjection(
    sql,
    identity.executionId,
    {
      kind: "workspace_allocation_cancelled",
      ...existingCounter(current),
      allocationId: projection.intent.reservation.allocationId,
      operationIdentity: workspaceOperationIdentityFromAllocation(
        projection.intent,
      ),
    },
    now,
  );
}
