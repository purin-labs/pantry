/**
 * The one writer of `organisation_onboarding.lifecycle` (Refactor 15,
 * refactor 5). Each move is a statement that the caller puts in its batch.
 * The statement changes the row only while the lifecycle is still the state
 * that the move leaves, and, when the caller holds the Organisation's
 * placement, only while that placement is active with its fence token.
 * Every move holds the placement, the readiness refresh included. A
 * move that `ORGANISATION_LIFECYCLE_MACHINE` does not allow is a programmer
 * error, so it throws.
 */
import type { MachineEvent, MachineState } from "@purin-labs/std/state-machine";
import type { OrganisationId } from "../ids";
import type { OrganisationQuerySource } from "./query-source";
import type { RowGuard } from "./shared-rows/organisation-row";
import { ORGANISATION_LIFECYCLE_MACHINE } from "./organisation-lifecycle.machine";

export type OrganisationLifecycleState = MachineState<
  typeof ORGANISATION_LIFECYCLE_MACHINE
>;
type OrganisationLifecycleEvent = MachineEvent<
  typeof ORGANISATION_LIFECYCLE_MACHINE
>;

/** The states in which the Organisation is in use and takes provider changes. */
const LIVE_ORGANISATION_LIFECYCLES = [
  "configuring",
  "activating",
  "active",
] as const satisfies readonly OrganisationLifecycleState[];

/**
 * The placement states that a lifecycle move accepts. A move holds an active
 * placement, but the archive cleanup that an Organisation Actor admitted
 * before a relocation's freeze ends while the relocation drains the Actor,
 * on the frozen placement, before the copy.
 */
export type LifecyclePlacementStatus = "active" | "frozen";

/** The placement states of an admitted archive cleanup and of its moves. */
export const ARCHIVE_CLEANUP_PLACEMENT_STATUSES = [
  "active",
  "frozen",
] as const satisfies readonly LifecyclePlacementStatus[];

/** The placement that a move holds: its epoch, its cell and its fence token. */
export type LifecycleFence = Readonly<{
  organisationId: OrganisationId;
  placement: Readonly<{ placementEpoch: number; placementCellId: string }>;
  fenceToken: string;
  /** The placement states that the move accepts; only `active` when absent. */
  placementStatuses?: readonly LifecyclePlacementStatus[];
}>;

/** The fence of the placement that a request's execution scope holds. */
export function lifecycleFenceOf(
  scope: Readonly<{
    organisationId: OrganisationId;
    placement: LifecycleFence["placement"];
    fenceToken: string;
  }>,
): LifecycleFence {
  return {
    organisationId: scope.organisationId,
    placement: scope.placement,
    fenceToken: scope.fenceToken,
  };
}

/**
 * True while the placement has the fence token and one of the fence's
 * placement states: `active`, unless the fence names others.
 */
function placementFenceGuard(fence: LifecycleFence): RowGuard {
  const statuses = fence.placementStatuses ?? ["active"];
  if (statuses.length === 0) throw new Error("placement fence has no state");
  return {
    sql: `EXISTS (SELECT 1 FROM organisation_placement
      WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
        AND fence_token = ? AND status IN (${statuses.map(() => "?").join(", ")}))`,
    bindings: [
      fence.organisationId,
      fence.placement.placementEpoch,
      fence.placement.placementCellId,
      fence.fenceToken,
      ...statuses,
    ],
  };
}

/**
 * True while the Organisation is in use (not archived, purging or purged)
 * and its placement is active with the fence token. A write that is not a
 * lifecycle move, such as an install that reactivates a provider connection,
 * carries it so that it cannot bring back an Organisation that has ended.
 */
export function liveOrganisationGuard(fence: LifecycleFence): RowGuard {
  const placement = placementFenceGuard({
    ...fence,
    placementStatuses: undefined,
  });
  return {
    sql: `EXISTS (SELECT 1 FROM organisation_onboarding
      WHERE organisation_id = ? AND lifecycle IN (${LIVE_ORGANISATION_LIFECYCLES.map(() => "?").join(", ")}))
      AND ${placement.sql}`,
    bindings: [
      fence.organisationId,
      ...LIVE_ORGANISATION_LIFECYCLES,
      ...placement.bindings,
    ],
  };
}

/**
 * One move of the lifecycle. `from` lists the states that the caller read
 * and that the move may leave; `set` holds the other columns of the move,
 * and `guard` the caller's own conditions, such as its configuration
 * version.
 */
export function prepareOrganisationLifecycleMove<
  Event extends OrganisationLifecycleEvent,
>(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    event: Event;
    from: readonly OrganisationLifecycleState[];
    fence: LifecycleFence;
    set?: RowGuard;
    guard?: RowGuard;
    now: number;
  }>,
): D1PreparedStatement {
  if (input.from.length === 0) throw new Error("lifecycle move has no state");
  // The guards of a move are SQL conditions in `guard`; the check here is
  // that the machine has the move from each state that the caller read.
  const transition = ORGANISATION_LIFECYCLE_MACHINE.transitions.find(
    (candidate) => candidate.event === input.event,
  );
  for (const state of input.from)
    if (
      transition === undefined ||
      !(transition.from as readonly OrganisationLifecycleState[]).includes(
        state,
      )
    )
      throw new Error(
        `organisation lifecycle cannot ${input.event} from ${state}`,
      );
  if (transition === undefined) throw new Error("lifecycle move is unknown");
  const to: OrganisationLifecycleState = transition.to;
  const fence = placementFenceGuard(input.fence);
  const assignments = [
    "lifecycle = ?",
    ...(input.set === undefined ? [] : [input.set.sql]),
    "updated_at = ?",
  ];
  const conditions = [
    "organisation_id = ?",
    `lifecycle IN (${input.from.map(() => "?").join(", ")})`,
    fence.sql,
    ...(input.guard === undefined ? [] : [input.guard.sql]),
  ];
  return db
    .prepare(
      `UPDATE organisation_onboarding SET ${assignments.join(", ")} WHERE ${conditions.join(" AND ")}`,
    )
    .bind(
      to,
      ...(input.set?.bindings ?? []),
      input.now,
      input.organisationId,
      ...input.from,
      ...fence.bindings,
      ...(input.guard?.bindings ?? []),
    );
}

/** The first row of an Organisation that onboarding creates: `configuring`. */
export function prepareConfiguringOnboardingRow(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    environment: "development" | "production";
    capabilityProfile: string;
    now: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO organisation_onboarding (
       organisation_id, environment, lifecycle, capability_profile,
       configuration_version, projection_revision, activation_attempt_id,
       readiness_version, activation_receipt_id, activated_at,
       suspension_reason_code, suspended_at, archived_at, purge_after, updated_at
     ) VALUES (?, ?, 'configuring', ?, 1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
    )
    .bind(
      input.organisationId,
      input.environment,
      input.capabilityProfile,
      input.now,
    );
}

/**
 * The first row of an Organisation that a workspace install creates before
 * onboarding: `active`, with the install as its activation receipt.
 */
export function prepareInstalledOnboardingRow(
  db: OrganisationQuerySource,
  input: Readonly<{ organisationId: OrganisationId; installedAt: number }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO organisation_onboarding (
       organisation_id, environment, lifecycle, capability_profile,
       configuration_version, projection_revision, activation_attempt_id,
       readiness_version, activation_receipt_id, activated_at,
       suspension_reason_code, suspended_at, archived_at, purge_after, updated_at
     ) VALUES (
       ?, 'development', 'active', 'read_and_propose', 1, 1,
       NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, ?
     )`,
    )
    .bind(
      input.organisationId,
      `system-install:${input.organisationId}`,
      input.installedAt,
      input.installedAt,
    );
}
