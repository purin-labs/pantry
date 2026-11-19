import type {
  CodeModeExecutionOutcome,
  HarnessTurnLease,
  MessageAttachmentPreparationIdentity,
  MessageAttachmentPreparationLimits,
  StoredMessageAttachment,
} from "@purin-labs/contracts";

import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import type { Result } from "../result";
import type {
  WorkspaceExecutorInspectionInvocation,
  WorkspaceExecutorInspectionOperation,
  WorkspaceExecutorInspectionRequest,
} from "../workspace-executor-container";
import { preflightHarnessTurnLease } from "./agent-session-harness-authority";
import {
  WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
  type WorkspaceExecutorAllocationReservation,
} from "./code-mode-budget";
import {
  cancelAttachmentPreparationAllocation,
  reserveAttachmentPreparationAllocation,
  settleAttachmentPreparationAllocation,
  type AttachmentPreparationWorkspaceExecutorAllocation,
} from "./workspace-execution-allocation";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, sha256Hex } from "@purin-labs/std";

/**
 * The executor branch is a pre-model operation. Its lease and allocation are
 * owned by the turn, while its request identity remains separate from the
 * model's Code Mode execution.
 */

export type AttachmentPreparationLimit =
  | "platform_capacity"
  | "budget_not_admitted"
  | "container_unavailable"
  | "settlement_failed"
  | "source_too_large"
  | "preparation_deadline_exceeded";

type AttachmentPreparationOutcome =
  | {
      readonly kind: "inspected";
      readonly operation: WorkspaceExecutorInspectionOperation;
    }
  | {
      readonly kind: "limited";
      readonly limit: AttachmentPreparationLimit;
      readonly detail: string;
    };

type AttachmentPreparationError = {
  readonly code: "attachment_preparation_state_conflict";
};

export type AttachmentPreparationExecutionControl = {
  readonly begin: (allocationId: string) => Promise<boolean>;
  readonly finish: (allocationId: string) => void;
};

export type AttachmentPreparationExecutionInspection =
  | { readonly kind: "none" }
  | {
      readonly kind: "preparing";
      readonly executorActive: boolean;
      readonly cancellationRequested: boolean;
    };

export class ActiveAttachmentPreparationControl implements AttachmentPreparationExecutionControl {
  private readonly settlement = Promise.withResolvers<void>();
  private allocationId: string | null = null;
  private cancelled = false;

  constructor(
    readonly leaseId: HarnessTurnLease["leaseId"],
    private readonly destroyExecutor: (allocationId: string) => Promise<void>,
  ) {}

  async begin(allocationId: string): Promise<boolean> {
    if (this.cancelled) {
      await this.destroyExecutor(allocationId);
      return false;
    }
    if (this.allocationId !== null) {
      return false;
    }
    this.allocationId = allocationId;
    return true;
  }

  finish(allocationId: string): void {
    if (this.allocationId === allocationId) {
      this.allocationId = null;
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    const allocationId = this.allocationId;
    if (allocationId !== null) {
      await this.destroyExecutor(allocationId);
    }
    await this.settlement.promise;
  }

  settle(): void {
    this.settlement.resolve();
  }

  inspect(): AttachmentPreparationExecutionInspection {
    return {
      kind: "preparing",
      executorActive: this.allocationId !== null,
      cancellationRequested: this.cancelled,
    };
  }
}

const MAX_TEXT_CHARS = 32_768;

export async function prepareAttachmentInExecutor(input: {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly lease: HarnessTurnLease;
  readonly preparationId: string;
  readonly identity: MessageAttachmentPreparationIdentity;
  readonly limits: MessageAttachmentPreparationLimits;
  readonly deadlineAt: number;
  readonly attachment: StoredMessageAttachment;
  readonly bytes: Uint8Array;
  readonly executionControl: AttachmentPreparationExecutionControl;
}): Promise<Result<AttachmentPreparationOutcome, AttachmentPreparationError>> {
  if (!preparationIdentityMatchesInput(input)) {
    return stateConflict();
  }

  const mediaClass = executorMediaClass(input.attachment);
  if (mediaClass === null) {
    return limited(
      "container_unavailable",
      "images do not require executor preparation",
    );
  }

  const now = Date.now();
  const deadline = validateDeadline(input, now);
  if (deadline !== null) {
    return deadline;
  }

  const request: WorkspaceExecutorInspectionRequest = {
    schemaVersion: "workspace_executor_preparation.v1",
    preparationId: input.preparationId,
    identity: input.identity,
    limits: input.limits,
    deadlineAtUnixMs: input.deadlineAt,
    operation: {
      kind: "prepare_message_attachment",
      mediaClass,
      mediaType: String(input.attachment.descriptor.media.mediaType),
      byteLength: input.attachment.byteLength,
      maxTextChars: MAX_TEXT_CHARS,
    },
  };

  const envelopeBytes = envelopeByteLength(request, input.bytes);
  if (
    input.attachment.byteLength > input.limits.maxInputBytes ||
    envelopeBytes > input.limits.maxInputBytes ||
    envelopeBytes > WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxInputBytes
  ) {
    return limited(
      "source_too_large",
      `envelope ${envelopeBytes} bytes exceeds the preparation input limit`,
    );
  }

  const allocationDigest = await sha256Hex(
    JSON.stringify({
      preparationId: input.preparationId,
      request,
      sourceSha256: input.identity.sourceSha256,
      bytesLength: input.bytes.byteLength,
    }),
  );
  const reserved = await reserveAttachmentPreparationAllocation({
    env: input.env,
    organisationId: input.organisationId,
    lease: input.lease,
    preparationId: input.preparationId,
    allocationDigest,
    executionDeadlineAt: input.deadlineAt,
    now,
  });

  if (!reserved.ok || reserved.value.kind !== "reserved") {
    return limited(...refusalLimit(reserved));
  }

  const reservation = preparationReservation(reserved.value);
  if (!reservation.ok) {
    return reservation;
  }

  const dispatchAllowed = await input.executionControl.begin(
    reservation.value.allocationId,
  );
  if (!dispatchAllowed) {
    await cancelPreparationAllocation(
      input,
      reservation.value,
      "turn_cancelled",
    );
    return limited("preparation_deadline_exceeded", "turn_cancelled");
  }

  const admissionFailure = preparationDispatchFailure(input, Date.now());
  if (admissionFailure !== null) {
    input.executionControl.finish(reservation.value.allocationId);
    await cancelPreparationAllocation(
      input,
      reservation.value,
      "admission_compensated",
    );
    return limited("preparation_deadline_exceeded", admissionFailure);
  }

  let invocation: WorkspaceExecutorInspectionInvocation;
  try {
    invocation = await input.env.WORKSPACE_EXECUTOR.getByName(
      reservation.value.allocationId,
    ).inspectAttachment(request, input.bytes);
  } catch (error) {
    await cancelPreparationAllocation(
      input,
      reservation.value,
      "turn_cancelled",
    );
    return limited("container_unavailable", describeThrownError(error));
  } finally {
    input.executionControl.finish(reservation.value.allocationId);
  }

  const settledAt = Date.now();
  let settled: Awaited<
    ReturnType<typeof settleAttachmentPreparationAllocation>
  >;
  try {
    const receipt = await preparationSettlement(
      reservation.value,
      invocation,
      settledAt,
    );
    settled = await settleAttachmentPreparationAllocation({
      env: input.env,
      organisationId: input.organisationId,
      reservation: reservation.value,
      receiptId: receipt.receiptId,
      receiptDigest: receipt.receiptDigest,
      actualCostMicros: receipt.actualCostMicros,
      inputBytes: receipt.inputBytes,
      outputBytes: receipt.outputBytes,
      durationMs: receipt.durationMs,
      outcome: receipt.outcome,
      now: settledAt,
    });
  } catch (error) {
    await cancelPreparationAllocation(
      input,
      reservation.value,
      "turn_cancelled",
    );
    return limited("settlement_failed", describeThrownError(error));
  }

  if (!settled.ok || settled.value.kind !== "settled") {
    await cancelPreparationAllocation(
      input,
      reservation.value,
      "turn_cancelled",
    );
    return limited(
      "settlement_failed",
      settled.ok ? settled.value.kind : settled.error.reason,
    );
  }

  if (invocation.kind === "failed") {
    return limited(
      "container_unavailable",
      describeInvocationError(invocation.error),
    );
  }

  return {
    ok: true,
    value: { kind: "inspected", operation: invocation.response.operation },
  };
}

function preparationDispatchFailure(
  input: {
    readonly storage: DurableObjectStorage;
    readonly lease: HarnessTurnLease;
    readonly deadlineAt: number;
  },
  now: number,
): string | null {
  if (now >= input.deadlineAt || now >= input.lease.expiresAt) {
    return "preparation deadline elapsed before dispatch";
  }
  try {
    const authorized = preflightHarnessTurnLease(
      input.storage,
      input.lease,
      now,
    );
    return authorized.ok ? null : authorized.error.code;
  } catch (error) {
    return describeThrownError(error);
  }
}

function preparationIdentityMatchesInput(input: {
  readonly organisationId: OrganisationId;
  readonly lease: HarnessTurnLease;
  readonly identity: MessageAttachmentPreparationIdentity;
  readonly attachment: StoredMessageAttachment;
}): boolean {
  return (
    input.organisationId === input.lease.session.organisationId &&
    input.identity.organisationId === input.organisationId &&
    input.identity.sessionId === input.lease.session.sessionId &&
    input.identity.turnId === input.lease.turn.turnId &&
    input.identity.attachmentId === input.attachment.id &&
    input.identity.sourceSha256 === input.attachment.sha256
  );
}

function executorMediaClass(
  attachment: StoredMessageAttachment,
): WorkspaceExecutorInspectionRequest["operation"]["mediaClass"] | null {
  switch (attachment.descriptor.kind) {
    case "document":
    case "audio":
    case "video":
    case "opaque":
      return attachment.descriptor.kind;
    case "image":
      return null;
    default:
      return assertNever(attachment.descriptor);
  }
}

function validateDeadline(
  input: {
    readonly lease: HarnessTurnLease;
    readonly limits: MessageAttachmentPreparationLimits;
    readonly deadlineAt: number;
  },
  now: number,
): Result<AttachmentPreparationOutcome, AttachmentPreparationError> | null {
  if (
    !Number.isSafeInteger(input.deadlineAt) ||
    input.deadlineAt <= now ||
    input.deadlineAt > input.lease.expiresAt ||
    input.deadlineAt - now > input.limits.maxDurationMs
  ) {
    return limited(
      "preparation_deadline_exceeded",
      "preparation deadline is unavailable",
    );
  }
  return null;
}

function preparationReservation(
  reservation: WorkspaceExecutorAllocationReservation,
): Result<
  AttachmentPreparationWorkspaceExecutorAllocation,
  AttachmentPreparationError
> {
  if (reservation.kind !== "reserved") {
    return stateConflict();
  }
  const parent = reservation.parent;
  if (parent.kind !== "attachment_preparation") {
    return stateConflict();
  }
  return {
    ok: true,
    value: {
      kind: "reserved",
      organisationId: reservation.organisationId,
      parent: {
        kind: "attachment_preparation",
        preparationId: parent.preparationId,
        leaseId: parent.leaseId,
        sessionId: parent.sessionId,
        turnId: parent.turnId,
        runtimeGeneration: parent.runtimeGeneration,
      },
      allocationId: reservation.allocationId,
      idempotencyKey: reservation.idempotencyKey,
      allocationDigest: reservation.allocationDigest,
      priceBookRevision: reservation.priceBookRevision,
      profile: reservation.profile,
      reservedCostMicros: reservation.reservedCostMicros,
      executionDeadlineAt: reservation.executionDeadlineAt,
      leaseExpiresAt: reservation.leaseExpiresAt,
    },
  };
}

type PreparationSettlement = {
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly actualCostMicros: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly durationMs: number;
  readonly outcome: CodeModeExecutionOutcome;
};

async function preparationSettlement(
  reservation: AttachmentPreparationWorkspaceExecutorAllocation,
  invocation: WorkspaceExecutorInspectionInvocation,
  settledAt: number,
): Promise<PreparationSettlement> {
  const common = {
    schemaVersion: "workspace_allocation_receipt.v1" as const,
    allocationId: reservation.allocationId,
    allocationDigest: reservation.allocationDigest,
    receiptId: `workspace-allocation-receipt-${reservation.allocationId}`,
    reservedCostMicros: reservation.reservedCostMicros,
    actualCostMicros: reservation.reservedCostMicros,
    inputBytes: invocation.usage.requestBytes,
    outputBytes: invocation.usage.responseBytes,
    durationMs: invocation.usage.gatewayDurationMs,
    settledAt,
  };

  const material =
    invocation.kind === "succeeded"
      ? {
          ...common,
          kind: "succeeded" as const,
          outcome: "succeeded" as const,
          executorReport: {
            inputBytes: invocation.response.inputBytes,
            outputBytes: invocation.response.outputBytes,
            durationMs: invocation.response.durationMs,
          },
        }
      : {
          ...common,
          kind: "failed" as const,
          outcome: invocationOutcome(invocation),
          reason: describeInvocationError(invocation.error),
          executorReport: null,
        };

  return {
    receiptId: material.receiptId,
    receiptDigest: await sha256Hex(JSON.stringify(material)),
    actualCostMicros: material.actualCostMicros,
    inputBytes: material.inputBytes,
    outputBytes: material.outputBytes,
    durationMs: material.durationMs,
    outcome: material.outcome,
  };
}

async function cancelPreparationAllocation(
  input: { readonly env: Env; readonly organisationId: OrganisationId },
  reservation: AttachmentPreparationWorkspaceExecutorAllocation,
  reason: "admission_compensated" | "turn_cancelled",
): Promise<void> {
  try {
    await cancelAttachmentPreparationAllocation({
      env: input.env,
      organisationId: input.organisationId,
      reservation,
      reason,
      now: Date.now(),
    });
  } catch {
    // The original failure remains the useful result. Lease expiry is the
    // authority's recovery path if compensation itself is unavailable.
  }
}

function invocationOutcome(
  invocation: Variant<WorkspaceExecutorInspectionInvocation, "failed">,
): "platform_failed" | "organisation_failed" {
  return invocation.error.kind === "executor_rejected" &&
    invocation.error.status >= 400 &&
    invocation.error.status < 500
    ? "organisation_failed"
    : "platform_failed";
}

function refusalLimit(
  reserved: Awaited<ReturnType<typeof reserveAttachmentPreparationAllocation>>,
): [AttachmentPreparationLimit, string] {
  const reason = reserved.ok ? reserved.value.kind : reserved.error.reason;
  if (reason === "code_mode_workspace_platform_concurrency_exceeded") {
    return ["platform_capacity", reason];
  }
  if (
    reason === "code_mode_execution_deadline_elapsed" ||
    reason === "lease_expired"
  ) {
    return ["preparation_deadline_exceeded", reason];
  }
  return ["budget_not_admitted", reason];
}

function describeInvocationError(
  error: Variant<WorkspaceExecutorInspectionInvocation, "failed">["error"],
): string {
  switch (error.kind) {
    case "deadline_exceeded":
      return "deadline_exceeded";
    case "executor_rejected":
      return `executor_rejected:${error.status}`;
    case "container_unavailable":
      return `container_unavailable:${error.reason}`;
    case "response_too_large":
      return "response_too_large";
    case "invalid_response":
      return `invalid_response:${error.field}`;
    default:
      return assertNever(error);
  }
}

function describeThrownError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "preparation_failed";
}

function limited(
  limit: AttachmentPreparationLimit,
  detail: string,
): Result<AttachmentPreparationOutcome, AttachmentPreparationError> {
  return { ok: true, value: { kind: "limited", limit, detail } };
}

function stateConflict(): Result<never, AttachmentPreparationError> {
  return {
    ok: false,
    error: { code: "attachment_preparation_state_conflict" },
  };
}

function envelopeByteLength(
  request: WorkspaceExecutorInspectionRequest,
  bytes: Uint8Array,
): number {
  const ENVELOPE_HEADER_BYTES = 8;
  return (
    ENVELOPE_HEADER_BYTES +
    new TextEncoder().encode(JSON.stringify(request)).byteLength +
    bytes.byteLength
  );
}
