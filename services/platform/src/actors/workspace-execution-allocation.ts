import type { HarnessTurnLease } from "@purin-labs/contracts";

import type { Env } from "../env";
import { newRequestId, parseSessionId, type OrganisationId } from "../ids";
import type { Result } from "../result";
import { requireActiveOrganisationActor } from "./actor-router";
import {
  CODE_MODE_PRICE_BOOK_REVISION_V2,
  WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
  WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  type WorkspaceExecutorAllocationCancelInput,
  type WorkspaceExecutorAllocationParent,
  type WorkspaceExecutorAllocationReservation,
  type WorkspaceExecutorAllocationReserveInput,
  type WorkspaceExecutorAllocationSettleInput,
} from "./code-mode-budget";
import { codeModePlatformGovernor } from "./code-mode-platform-governor-stub";
import type { Variant } from "@purin-labs/type-utils";

const CLEANUP_MARGIN_MS = 5_000;

export type WorkspaceAllocationAuthorityError =
  | {
      readonly code: "workspace_allocation_authority_failed";
      readonly authority: "platform" | "organisation";
      readonly reason: string;
    }
  | {
      readonly code: "workspace_allocation_authority_indeterminate";
      readonly authority: "platform";
      readonly reason: string;
    };

type ReservedWorkspaceExecutorAllocation = Variant<
  WorkspaceExecutorAllocationReservation,
  "reserved"
>;

export type AttachmentPreparationWorkspaceExecutorAllocation =
  ReservedWorkspaceExecutorAllocation & {
    readonly parent: Variant<
      WorkspaceExecutorAllocationParent,
      "attachment_preparation"
    >;
  };

export async function reserveAttachmentPreparationAllocation(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly lease: HarnessTurnLease;
  readonly preparationId: string;
  readonly allocationDigest: string;
  readonly executionDeadlineAt: number;
  readonly now: number;
}): Promise<
  Result<
    WorkspaceExecutorAllocationReservation,
    WorkspaceAllocationAuthorityError
  >
> {
  if (input.organisationId !== input.lease.session.organisationId) {
    return allocationAuthorityFailureReason(
      "organisation",
      "organisation_mismatch",
    );
  }
  if (
    input.now >= input.lease.expiresAt ||
    input.executionDeadlineAt > input.lease.expiresAt
  ) {
    return allocationAuthorityFailureReason("organisation", "lease_expired");
  }
  const parent = attachmentPreparationParent(input.lease, input.preparationId);
  if (!parent.ok) return parent;
  return reserveWorkspaceAllocationWithParent({
    env: input.env,
    organisationId: input.organisationId,
    parent: parent.value,
    allocationId: attachmentPreparationAllocationId(input.preparationId),
    idempotencyKey: `workspace-allocation-${input.preparationId}`,
    allocationDigest: input.allocationDigest,
    executionDeadlineAt: input.executionDeadlineAt,
    now: input.now,
  });
}

export async function settleAttachmentPreparationAllocation(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly reservation: AttachmentPreparationWorkspaceExecutorAllocation;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly actualCostMicros: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly durationMs: number;
  readonly outcome: WorkspaceExecutorAllocationSettleInput["outcome"];
  readonly now: number;
}): Promise<
  Result<
    WorkspaceExecutorAllocationReservation,
    WorkspaceAllocationAuthorityError
  >
> {
  return settleWorkspaceAllocationWithParent(
    input.env,
    input.organisationId,
    attachmentPreparationSettlementInput(input),
  );
}

export async function cancelAttachmentPreparationAllocation(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly reservation: AttachmentPreparationWorkspaceExecutorAllocation;
  readonly reason: "admission_compensated" | "turn_cancelled";
  readonly now: number;
}): Promise<
  Result<
    WorkspaceExecutorAllocationReservation,
    WorkspaceAllocationAuthorityError
  >
> {
  return cancelWorkspaceAllocationWithParent(input.env, input.organisationId, {
    requestId: newRequestId(),
    organisationId: input.organisationId,
    parent: input.reservation.parent,
    allocationId: input.reservation.allocationId,
    reason: input.reason,
    now: input.now,
  });
}

async function reserveWorkspaceAllocationWithParent(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly parent: WorkspaceExecutorAllocationParent;
  readonly allocationId: string;
  readonly idempotencyKey: string;
  readonly allocationDigest: string;
  readonly executionDeadlineAt: number;
  readonly now: number;
}): Promise<
  Result<
    WorkspaceExecutorAllocationReservation,
    WorkspaceAllocationAuthorityError
  >
> {
  const reserve = workspaceAllocationReserveInput(input);
  const platform = codeModePlatformGovernor(input.env);
  const platformReserved = await platform.reserveWorkspaceAllocation(reserve);
  if (!platformReserved.ok) {
    return allocationAuthorityFailure("platform", platformReserved);
  }
  const organisation = await requireActiveOrganisationActor({
    env: input.env,
    organisationId: input.organisationId,
    now: input.now,
  });
  if (platformReserved.value.kind !== "reserved") {
    if (input.parent.kind !== "attachment_preparation") {
      return allocationAuthorityFailure("platform", platformReserved);
    }
    const organisationReplay =
      await organisation.reserveWorkspaceExecutorAllocation(reserve);
    if (!organisationReplay.ok) {
      return allocationAuthorityFailure("organisation", organisationReplay);
    }
    return workspaceAllocationReplay(
      platformReserved.value,
      organisationReplay.value,
    );
  }
  const organisationReserved =
    await organisation.reserveWorkspaceExecutorAllocation(reserve);
  if (
    !organisationReserved.ok ||
    organisationReserved.value.kind !== "reserved"
  ) {
    const compensated = await platform.cancelWorkspaceAllocation(
      workspaceAllocationCancelInput(input),
    );
    if (!compensated.ok || compensated.value.kind !== "cancelled") {
      return allocationAuthorityIndeterminate(compensated);
    }
    return allocationAuthorityFailure("organisation", organisationReserved);
  }
  return { ok: true, value: organisationReserved.value };
}

function workspaceAllocationReplay(
  platform: WorkspaceExecutorAllocationReservation,
  organisation: WorkspaceExecutorAllocationReservation,
): Result<
  WorkspaceExecutorAllocationReservation,
  WorkspaceAllocationAuthorityError
> {
  return platform.kind === organisation.kind
    ? { ok: true, value: organisation }
    : allocationAuthorityFailureReason(
        "organisation",
        "authority_state_conflict",
      );
}

async function settleWorkspaceAllocationWithParent(
  env: Env,
  organisationId: OrganisationId,
  settlement: WorkspaceExecutorAllocationSettleInput,
): Promise<
  Result<
    WorkspaceExecutorAllocationReservation,
    WorkspaceAllocationAuthorityError
  >
> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: settlement.now,
  });
  const organisationSettled =
    await organisation.settleWorkspaceExecutorAllocation(settlement);
  if (!organisationSettled.ok || organisationSettled.value.kind !== "settled") {
    return allocationAuthorityFailure("organisation", organisationSettled);
  }
  const platformSettled =
    await codeModePlatformGovernor(env).settleWorkspaceAllocation(settlement);
  if (!platformSettled.ok || platformSettled.value.kind !== "settled") {
    if (platformSettled.ok && platformSettled.value.kind === "expired") {
      return allocationAuthorityIndeterminate(platformSettled);
    }
    return allocationAuthorityFailure("platform", platformSettled);
  }
  return { ok: true, value: organisationSettled.value };
}

async function cancelWorkspaceAllocationWithParent(
  env: Env,
  organisationId: OrganisationId,
  cancellation: WorkspaceExecutorAllocationCancelInput,
): Promise<
  Result<
    WorkspaceExecutorAllocationReservation,
    WorkspaceAllocationAuthorityError
  >
> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: cancellation.now,
  });
  const organisationCancelled =
    await organisation.cancelWorkspaceExecutorAllocation(cancellation);
  if (
    !organisationCancelled.ok ||
    organisationCancelled.value.kind !== "cancelled"
  ) {
    return allocationAuthorityFailure("organisation", organisationCancelled);
  }
  const platformCancelled =
    await codeModePlatformGovernor(env).cancelWorkspaceAllocation(cancellation);
  if (!platformCancelled.ok || platformCancelled.value.kind !== "cancelled") {
    return allocationAuthorityFailure("platform", platformCancelled);
  }
  return { ok: true, value: organisationCancelled.value };
}

function attachmentPreparationAllocationId(preparationId: string): string {
  return `wxa-${preparationId}`;
}

function attachmentPreparationParent(
  lease: HarnessTurnLease,
  preparationId: string,
): Result<
  Variant<WorkspaceExecutorAllocationParent, "attachment_preparation">,
  WorkspaceAllocationAuthorityError
> {
  const sessionId = parseSessionId(lease.session.sessionId);
  if (!sessionId.ok) {
    return allocationAuthorityFailureReason("organisation", "invalid_session");
  }
  return {
    ok: true,
    value: {
      kind: "attachment_preparation",
      preparationId,
      leaseId: lease.leaseId,
      sessionId: sessionId.value,
      turnId: lease.turn.turnId,
      runtimeGeneration: lease.runtimeLease.generation,
    },
  };
}

function workspaceAllocationReserveInput(input: {
  readonly organisationId: OrganisationId;
  readonly parent: WorkspaceExecutorAllocationParent;
  readonly allocationId: string;
  readonly idempotencyKey: string;
  readonly allocationDigest: string;
  readonly executionDeadlineAt: number;
  readonly now: number;
}): WorkspaceExecutorAllocationReserveInput {
  return {
    requestId: newRequestId(),
    organisationId: input.organisationId,
    parent: input.parent,
    allocationId: input.allocationId,
    idempotencyKey: input.idempotencyKey,
    allocationDigest: input.allocationDigest,
    priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
    profile: WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
    reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    executionDeadlineAt: input.executionDeadlineAt,
    leaseExpiresAt: input.executionDeadlineAt + CLEANUP_MARGIN_MS,
    now: input.now,
  };
}

function workspaceAllocationCancelInput(input: {
  readonly organisationId: OrganisationId;
  readonly parent: WorkspaceExecutorAllocationParent;
  readonly allocationId: string;
  readonly now: number;
}): WorkspaceExecutorAllocationCancelInput {
  return {
    requestId: newRequestId(),
    organisationId: input.organisationId,
    parent: input.parent,
    allocationId: input.allocationId,
    reason: "admission_compensated",
    now: input.now,
  };
}

function attachmentPreparationSettlementInput(input: {
  readonly organisationId: OrganisationId;
  readonly reservation: AttachmentPreparationWorkspaceExecutorAllocation;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly actualCostMicros: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly durationMs: number;
  readonly outcome: WorkspaceExecutorAllocationSettleInput["outcome"];
  readonly now: number;
}): WorkspaceExecutorAllocationSettleInput {
  return {
    requestId: newRequestId(),
    organisationId: input.organisationId,
    parent: input.reservation.parent,
    allocationId: input.reservation.allocationId,
    receiptId: input.receiptId,
    receiptDigest: input.receiptDigest,
    actualCostMicros: input.actualCostMicros,
    inputBytes: input.inputBytes,
    outputBytes: input.outputBytes,
    durationMs: input.durationMs,
    outcome: input.outcome,
    now: input.now,
  };
}

function allocationAuthorityFailure(
  authority: WorkspaceAllocationAuthorityError["authority"],
  result:
    | { readonly ok: true; readonly value: { readonly kind: string } }
    | { readonly ok: false; readonly error: { readonly code: string } },
): Result<never, WorkspaceAllocationAuthorityError> {
  return {
    ok: false,
    error: {
      code: "workspace_allocation_authority_failed",
      authority,
      reason: result.ok ? result.value.kind : result.error.code,
    },
  };
}

function allocationAuthorityFailureReason(
  authority: WorkspaceAllocationAuthorityError["authority"],
  reason: string,
): Result<never, WorkspaceAllocationAuthorityError> {
  return {
    ok: false,
    error: {
      code: "workspace_allocation_authority_failed",
      authority,
      reason,
    },
  };
}

function allocationAuthorityIndeterminate(
  result:
    | { readonly ok: true; readonly value: { readonly kind: string } }
    | { readonly ok: false; readonly error: { readonly code: string } },
): Result<never, WorkspaceAllocationAuthorityError> {
  return {
    ok: false,
    error: {
      code: "workspace_allocation_authority_indeterminate",
      authority: "platform",
      reason: result.ok
        ? `platform_compensation_${result.value.kind}`
        : `platform_compensation_${result.error.code}`,
    },
  };
}
