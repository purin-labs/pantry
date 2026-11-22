import type { StrictUnion } from "@purin-labs/type-utils";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import { requireActiveOrganisationActorAtPlacement } from "./actor-router";
import type {
  CodeModeLeaseBinding,
  CodeModeLeaseRebindInput,
} from "./code-mode-budget";
import { codeModePlatformGovernor } from "./code-mode-platform-governor-stub";
import {
  readCodeModeExecution,
  writeCodeModeExecutionAuthority,
} from "./code-mode-execution-record";
import { SessionExecutionAdmission } from "./session-execution-admission";

const CONFIRMED = Symbol("code_mode_lease_rebind_confirmed");

/** A rebind whose intended lease the Session Actor has stored. */
export type PreparedCodeModeLeaseRebind = {
  readonly executionId: string;
  readonly organisationId: OrganisationId;
  readonly admissionDigest: string;
  readonly previous: CodeModeLeaseBinding;
  readonly next: CodeModeLeaseBinding;
};

/**
 * A rebind that the platform governor and the Organisation Actor both hold.
 * Only `confirmCodeModeLeaseRebind` creates one, so the Session Actor cannot
 * adopt a lease that an owner did not confirm.
 */
export type ConfirmedCodeModeLeaseRebind = {
  readonly executionId: string;
  readonly binding: CodeModeLeaseBinding;
  readonly [CONFIRMED]: true;
};

type CodeModeLeaseRebindPreparation = StrictUnion<
  | { readonly kind: "prepared"; readonly rebind: PreparedCodeModeLeaseRebind }
  /** The intended lease already holds the execution. */
  | { readonly kind: "bound" }
  | { readonly kind: "refused"; readonly reason: string }
>;

type CodeModeLeaseRebindConfirmation = StrictUnion<
  | {
      readonly kind: "confirmed";
      readonly rebind: ConfirmedCodeModeLeaseRebind;
    }
  /** An owner cannot confirm now. Repeat the same rebind later. */
  | { readonly kind: "deferred"; readonly reason: string }
  /** An owner will not confirm this rebind. The execution cannot continue. */
  | { readonly kind: "refused"; readonly reason: string }
>;

/**
 * Stores the intended lease before any owner is asked. From this point the
 * execution is not executable under either lease until the intended one is
 * adopted. Repeating the call with the same lease changes nothing.
 */
export function prepareCodeModeLeaseRebind(
  sql: SqlStorage,
  input: {
    readonly executionId: string;
    readonly intended: CodeModeLeaseBinding;
    readonly now: number;
  },
): CodeModeLeaseRebindPreparation {
  const execution = readCodeModeExecution(sql, input.executionId);
  if (execution.kind !== "found")
    return { kind: "refused", reason: `execution_record_${execution.kind}` };
  const { record, stateKind } = execution.stored;
  if (stateKind !== "pending" && stateKind !== "dispatching")
    return { kind: "refused", reason: "execution_not_live" };
  const authority = record.authority;
  switch (authority.kind) {
    case "generation_unrecorded":
      return { kind: "refused", reason: "runtime_generation_unrecorded" };
    case "bound":
      if (sameBinding(authority.binding, input.intended))
        return { kind: "bound" };
      if (
        input.intended.runtimeGeneration <=
          authority.binding.runtimeGeneration ||
        input.intended.leaseId === authority.binding.leaseId
      )
        return { kind: "refused", reason: "runtime_generation_not_newer" };
      writeCodeModeExecutionAuthority(
        sql,
        record,
        {
          kind: "rebinding",
          binding: authority.binding,
          intended: input.intended,
          executionDeadlineAt: authority.executionDeadlineAt,
        },
        input.now,
      );
      break;
    case "rebinding":
      if (!sameBinding(authority.intended, input.intended))
        return { kind: "refused", reason: "rebind_intent_conflict" };
      break;
    default:
      return authority satisfies never;
  }
  return {
    kind: "prepared",
    rebind: {
      executionId: record.executionId,
      organisationId: record.organisationId,
      admissionDigest: record.admissionDigest,
      previous: authority.binding,
      next: input.intended,
    },
  };
}

/**
 * Asks each owner of the reservation to hold the intended lease. Each owner
 * answers the same request the same way, so a repeat after a partial handoff
 * completes it. The platform governor comes first: it refuses during an
 * admission freeze, before any owner has changed.
 */
export async function confirmCodeModeLeaseRebind(input: {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly rebind: PreparedCodeModeLeaseRebind;
  readonly now: number;
}): Promise<CodeModeLeaseRebindConfirmation> {
  const request: CodeModeLeaseRebindInput = {
    requestId: newRequestId(),
    organisationId: input.rebind.organisationId,
    executionId: input.rebind.executionId,
    admissionDigest: input.rebind.admissionDigest,
    previous: input.rebind.previous,
    next: input.rebind.next,
    now: input.now,
  };
  let platform;
  try {
    platform = await codeModePlatformGovernor(input.env).rebindLease(request);
  } catch {
    return { kind: "deferred", reason: "platform_governor_unreachable" };
  }
  if (!platform.ok) return ownerRefusal("platform", platform.error.code);
  if (!holds(platform.value, input.rebind.next))
    return { kind: "refused", reason: "platform_binding_mismatch" };
  let organisation;
  try {
    const execution = await SessionExecutionAdmission.resolve(
      input.env,
      input.storage,
      input.rebind.organisationId,
    );
    if (execution === null || !(await execution.isActive()))
      return { kind: "deferred", reason: "organisation_placement_unavailable" };
    const actor = await requireActiveOrganisationActorAtPlacement({
      env: input.env,
      organisationId: input.rebind.organisationId,
      placement: execution.scope.placement,
      now: input.now,
    });
    organisation = await actor.rebindCodeModeLease(request);
  } catch {
    return { kind: "deferred", reason: "organisation_unreachable" };
  }
  if (!organisation.ok)
    return ownerRefusal("organisation", organisation.error.code);
  if (!holds(organisation.value, input.rebind.next))
    return { kind: "refused", reason: "organisation_binding_mismatch" };
  return {
    kind: "confirmed",
    rebind: {
      executionId: input.rebind.executionId,
      binding: input.rebind.next,
      [CONFIRMED]: true,
    },
  };
}

/**
 * Makes the confirmed lease the one that the Session Actor accepts. Call it
 * in the transaction that commits the runtime generation of that lease.
 */
export function adoptCodeModeLeaseRebind(
  sql: SqlStorage,
  input: {
    readonly rebind: ConfirmedCodeModeLeaseRebind;
    readonly runtimeGeneration: number;
    readonly now: number;
  },
): void {
  const execution = readCodeModeExecution(sql, input.rebind.executionId);
  if (
    execution.kind !== "found" ||
    execution.stored.record.authority.kind !== "rebinding" ||
    !sameBinding(
      execution.stored.record.authority.intended,
      input.rebind.binding,
    ) ||
    input.rebind.binding.runtimeGeneration !== input.runtimeGeneration
  )
    throw new Error("Code Mode lease adoption conflicts with durable state");
  writeCodeModeExecutionAuthority(
    sql,
    execution.stored.record,
    {
      kind: "bound",
      binding: input.rebind.binding,
      executionDeadlineAt:
        execution.stored.record.authority.executionDeadlineAt,
    },
    input.now,
  );
}

function ownerRefusal(
  owner: "platform" | "organisation",
  code: string,
): CodeModeLeaseRebindConfirmation {
  // An operator's hold on admission ends. Every other answer of an owner is
  // final for this execution: its reservation is gone, or another lease
  // holds it.
  return code === "code_mode_platform_disabled" ||
    code === "code_mode_remote_placement_disabled"
    ? { kind: "deferred", reason: `${owner}:${code}` }
    : { kind: "refused", reason: `${owner}:${code}` };
}

function holds(
  reservation: {
    readonly kind: string;
    readonly leaseId: string;
    readonly runtimeGeneration: number;
  },
  binding: CodeModeLeaseBinding,
): boolean {
  return (
    reservation.kind === "reserved" &&
    reservation.leaseId === binding.leaseId &&
    reservation.runtimeGeneration === binding.runtimeGeneration
  );
}

function sameBinding(
  left: CodeModeLeaseBinding,
  right: CodeModeLeaseBinding,
): boolean {
  return (
    left.leaseId === right.leaseId &&
    left.runtimeGeneration === right.runtimeGeneration
  );
}
