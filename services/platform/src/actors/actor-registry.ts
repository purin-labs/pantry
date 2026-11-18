import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";
import { samePlacement } from "../data/organisation-placement";
import {
  parseCaseId,
  parseChannelId,
  parseConnectorId,
  parseSessionId,
  parseOrganisationId,
  parseThreadId,
  type ChannelId,
  type CaseId,
  type ConnectorId,
  type SessionId,
  type OrganisationId,
  type ThreadId,
} from "../ids";
import {
  parseOrganisationPlacement,
  type OrganisationPlacement,
} from "../placement";
import type { Result } from "../result";
import type { VariantBy } from "@seams/type-utils";
import {
  actorPlacementAdmissionPredicate,
  actorPlacementAdmissionMatchesIdentity,
  type ActorPlacementAdmission,
  type ActorPlacementAdmissionError,
} from "./actor-placement-admission";
import {
  assertNever,
  isNonNegativeInteger,
  isPositiveInteger,
} from "@seams/std";

type RegistryTokenParseError = {
  readonly code: "invalid_registry_token";
};

declare const actorRegistryIdBrand: unique symbol;
declare const actorActivationTokenBrand: unique symbol;
declare const actorFenceTokenBrand: unique symbol;

export type ActorRegistryId = string & {
  readonly [actorRegistryIdBrand]: "ActorRegistryId";
};

export type ActorActivationToken = string & {
  readonly [actorActivationTokenBrand]: "ActorActivationToken";
};

export type ActorFenceToken = string & {
  readonly [actorFenceTokenBrand]: "ActorFenceToken";
};

export type ActorIdentity =
  | {
      readonly objectKind: "organisation";
      readonly organisationId: OrganisationId;
      readonly logicalObjectId: OrganisationId;
    }
  | {
      readonly objectKind: "surface";
      readonly organisationId: OrganisationId;
      readonly logicalObjectId: ChannelId;
    }
  | {
      readonly objectKind: "session";
      readonly organisationId: OrganisationId;
      readonly logicalObjectId: SessionId;
    }
  | {
      readonly objectKind: "thread";
      readonly organisationId: OrganisationId;
      readonly logicalObjectId: ThreadId;
    }
  | {
      readonly objectKind: "case";
      readonly organisationId: OrganisationId;
      readonly logicalObjectId: CaseId;
    }
  | {
      readonly objectKind: "connector";
      readonly organisationId: OrganisationId;
      readonly logicalObjectId: ConnectorId;
    };

type RegistryEntryIdentity = {
  readonly registryId: ActorRegistryId;
  readonly activationToken: ActorActivationToken;
  readonly identity: ActorIdentity;
  readonly physicalObjectName: string;
  readonly placement: OrganisationPlacement;
  readonly schemaVersion: number;
  readonly stateVersion: number;
  readonly fenceToken: ActorFenceToken;
  readonly reservedAt: number;
};

export type ActorRegistryEntry =
  | (RegistryEntryIdentity & {
      readonly lifecycleStatus: "reserved";
      readonly activatedAt?: never;
      readonly exportingAt?: never;
      readonly retiredAt?: never;
      readonly quarantinedAt?: never;
      readonly quarantineReason?: never;
    })
  | (RegistryEntryIdentity & {
      readonly lifecycleStatus: "active";
      readonly activatedAt: number;
      readonly exportingAt?: never;
      readonly retiredAt?: never;
      readonly quarantinedAt?: never;
      readonly quarantineReason?: never;
    })
  | (RegistryEntryIdentity & {
      readonly lifecycleStatus: "exporting";
      readonly activatedAt: number;
      readonly exportingAt: number;
      readonly retiredAt?: never;
      readonly quarantinedAt?: never;
      readonly quarantineReason?: never;
    })
  | (RegistryEntryIdentity & {
      readonly lifecycleStatus: "retired";
      readonly activatedAt: number;
      readonly exportingAt: number;
      readonly retiredAt: number;
      readonly quarantinedAt?: never;
      readonly quarantineReason?: never;
    })
  | (RegistryEntryIdentity & {
      readonly lifecycleStatus: "quarantined";
      readonly activatedAt: number | null;
      readonly exportingAt: number | null;
      readonly retiredAt?: never;
      readonly quarantinedAt: number;
      readonly quarantineReason: string;
    });

export type ActorRegistryError =
  | ActorPlacementAdmissionError
  | { readonly code: "registry_entry_missing" }
  | { readonly code: "registry_entry_corrupt" }
  | { readonly code: "registry_entry_conflict" }
  | { readonly code: "registry_entry_not_activatable" }
  | { readonly code: "registry_activation_conflict" }
  | { readonly code: "registry_export_conflict" }
  | { readonly code: "registry_retirement_conflict" }
  | { readonly code: "registry_quarantine_conflict" }
  | { readonly code: "invalid_quarantine_reason" };

export type ActorRegistrySchemaAdvanceError =
  | { readonly code: "registry_entry_missing" }
  | { readonly code: "registry_entry_corrupt" }
  | { readonly code: "registry_schema_advance_conflict" }
  | { readonly code: "invalid_registry_schema_transition" };

export type ActiveActorRegistryEntry = VariantBy<
  ActorRegistryEntry,
  "lifecycleStatus",
  "active"
>;

export type ExactActiveActorRegistryError =
  | { readonly code: "registry_entry_missing" }
  | { readonly code: "registry_entry_corrupt" }
  | { readonly code: "registry_entry_not_active" }
  | {
      readonly code: "registry_schema_mismatch";
      readonly expected: number;
      readonly received: number;
    };

export type ActorActivationIdentity = {
  readonly registryId: ActorRegistryId;
  readonly activationToken: ActorActivationToken;
  readonly identity: ActorIdentity;
  readonly physicalObjectName: string;
  readonly placement: OrganisationPlacement;
  readonly schemaVersion: number;
  readonly fenceToken: ActorFenceToken;
  readonly requestedAt: number;
};

export type ActorActivationRequest = ActorActivationIdentity & {
  readonly admission: ActorPlacementAdmission;
};

export type ActorActivationResult = Result<
  {
    readonly kind: "activated";
    readonly registryId: ActorRegistryId;
    readonly stateVersion: number;
  },
  | { readonly code: "activation_conflict" }
  | { readonly code: "activation_placement_conflict" }
>;

export type ActorReservation = {
  readonly identity: ActorIdentity;
  readonly admission: ActorPlacementAdmission;
  readonly schemaVersion: number;
  readonly now: number;
  /**
   * A warm slot for a new row. A row that exists keeps its own name, so a
   * retry of the same identity reaches the same object.
   */
  readonly warmSlotName?: string;
};

export type ActorRegistryActivation = {
  readonly entry: VariantBy<ActorRegistryEntry, "lifecycleStatus", "reserved">;
  readonly stateVersion: number;
};

type RegistryRow = {
  registryId: unknown;
  activationToken: unknown;
  organisationId: unknown;
  objectKind: unknown;
  logicalObjectId: unknown;
  physicalObjectName: unknown;
  placementEpoch: unknown;
  placementCellId: unknown;
  placementKind: unknown;
  locationHint: unknown;
  residencyJurisdiction: unknown;
  schemaVersion: unknown;
  stateVersion: unknown;
  lifecycleStatus: unknown;
  fenceToken: unknown;
  reservedAt: unknown;
  activatedAt: unknown;
  exportingAt: unknown;
  retiredAt: unknown;
  quarantinedAt: unknown;
  quarantineReason: unknown;
};

type ReservationRow = Omit<
  RegistryRow,
  "placementKind" | "locationHint" | "residencyJurisdiction"
>;

type ActorReservationPlan = ActorReservation & {
  readonly placement: OrganisationPlacement;
  readonly registryId: ActorRegistryId;
  readonly activationToken: ActorActivationToken;
  readonly physicalObjectName: string;
  readonly fenceToken: ActorFenceToken;
};

export async function reserveActor(input: {
  readonly db: OrganisationDatabase;
  readonly identity: ActorIdentity;
  readonly admission: ActorPlacementAdmission;
  readonly schemaVersion: number;
  readonly now: number;
}): Promise<Result<ActorRegistryEntry, ActorRegistryError>> {
  if (!actorPlacementAdmissionMatchesIdentity(input.admission, input.identity))
    return { ok: false, error: { code: "registry_placement_conflict" } };
  const plan = actorReservationPlan(input);
  const guard = actorPlacementAdmissionPredicate(input.admission);
  const session = input.db.withSession("first-primary");
  const reservation = session
    .prepare(
      `INSERT OR IGNORE INTO durable_object_registry (
      registry_id, activation_token, organisation_id, object_kind, logical_object_id,
      physical_object_name, placement_epoch, placement_cell_id, schema_version,
      state_version, lifecycle_status, fence_token, reserved_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'reserved', ?, ? WHERE ${guard.sql}`,
    )
    .bind(...reservationBindings(plan), ...guard.bindings);
  const [admitted, , readback] = await session.batch<
    RegistryRow & { admitted: number }
  >([
    session.prepare(`SELECT ${guard.sql} AS admitted`).bind(...guard.bindings),
    reservation,
    registryEntryQuery(session, {
      organisationId: input.identity.organisationId,
      objectKind: input.identity.objectKind,
      logicalObjectId: input.identity.logicalObjectId,
      placementEpoch: plan.placement.placementEpoch,
    }),
  ]);
  if (admitted?.results[0]?.admitted !== 1)
    return { ok: false, error: { code: "registry_placement_conflict" } };
  const current = parseRegistryRow(readback?.results[0] ?? null);
  if (!current.ok) return current;
  return registryReservationMatches(current.value, plan)
    ? current
    : { ok: false, error: { code: "registry_entry_conflict" } };
}

export type RetiredActorRecord = Pick<
  VariantBy<ActorRegistryEntry, "lifecycleStatus", "retired">,
  | "identity"
  | "lifecycleStatus"
  | "schemaVersion"
  | "stateVersion"
  | "reservedAt"
  | "activatedAt"
  | "exportingAt"
  | "retiredAt"
>;

export function retiredActorRecord(
  entry: VariantBy<ActorRegistryEntry, "lifecycleStatus", "retired">,
): RetiredActorRecord {
  return {
    identity: entry.identity,
    lifecycleStatus: "retired",
    schemaVersion: entry.schemaVersion,
    stateVersion: entry.stateVersion,
    reservedAt: entry.reservedAt,
    activatedAt: entry.activatedAt,
    exportingAt: entry.exportingAt,
    retiredAt: entry.retiredAt,
  };
}

export function matchesRetiredActorRecord(
  entry: ActorRegistryEntry,
  record: RetiredActorRecord,
): boolean {
  return (
    entry.lifecycleStatus === "retired" &&
    entry.identity.organisationId === record.identity.organisationId &&
    entry.identity.objectKind === record.identity.objectKind &&
    entry.identity.logicalObjectId === record.identity.logicalObjectId &&
    entry.schemaVersion === record.schemaVersion &&
    entry.stateVersion === record.stateVersion &&
    entry.reservedAt === record.reservedAt &&
    entry.activatedAt === record.activatedAt &&
    entry.exportingAt === record.exportingAt &&
    entry.retiredAt === record.retiredAt
  );
}

/** Copy a terminal registry record without creating or activating an Actor. */
export async function copyRetiredActorRegistryEntry(input: {
  readonly db: OrganisationDatabase;
  readonly source: RetiredActorRecord;
  readonly admission: VariantBy<
    ActorPlacementAdmission,
    "kind",
    "relocation" | "restore"
  >;
}): Promise<
  Result<
    VariantBy<ActorRegistryEntry, "lifecycleStatus", "retired">,
    ActorRegistryError
  >
> {
  if (
    !actorPlacementAdmissionMatchesIdentity(
      input.admission,
      input.source.identity,
    )
  ) {
    return { ok: false, error: { code: "registry_placement_conflict" } };
  }
  const source = input.source;
  const plan = actorReservationPlan({
    identity: source.identity,
    admission: input.admission,
    schemaVersion: source.schemaVersion,
    now: source.reservedAt,
  });
  const guard = actorPlacementAdmissionPredicate(input.admission);
  const session = input.db.withSession("first-primary");
  const [admitted, , readback] = await session.batch<
    RegistryRow & { admitted: number }
  >([
    session.prepare(`SELECT ${guard.sql} AS admitted`).bind(...guard.bindings),
    session
      .prepare(
        `INSERT OR IGNORE INTO durable_object_registry (
      registry_id, activation_token, organisation_id, object_kind, logical_object_id,
      physical_object_name, placement_epoch, placement_cell_id, schema_version,
      state_version, lifecycle_status, fence_token, reserved_at,
      activated_at, exporting_at, retired_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'retired', ?, ?, ?, ?, ? WHERE ${guard.sql}`,
      )
      .bind(
        plan.registryId,
        plan.activationToken,
        source.identity.organisationId,
        source.identity.objectKind,
        source.identity.logicalObjectId,
        plan.physicalObjectName,
        plan.placement.placementEpoch,
        plan.placement.placementCellId,
        source.schemaVersion,
        source.stateVersion,
        plan.fenceToken,
        source.reservedAt,
        source.activatedAt,
        source.exportingAt,
        source.retiredAt,
        ...guard.bindings,
      ),
    registryEntryQuery(session, {
      organisationId: source.identity.organisationId,
      objectKind: source.identity.objectKind,
      logicalObjectId: source.identity.logicalObjectId,
      placementEpoch: plan.placement.placementEpoch,
    }),
  ]);
  if (admitted?.results[0]?.admitted !== 1) {
    return { ok: false, error: { code: "registry_placement_conflict" } };
  }
  const target = parseRegistryRow(readback?.results[0] ?? null);
  if (!target.ok) return target;
  if (
    target.value.lifecycleStatus !== "retired" ||
    !matchesRetiredActorRecord(target.value, source) ||
    target.value.physicalObjectName !== plan.physicalObjectName ||
    !samePlacement(target.value.placement, plan.placement)
  ) {
    return { ok: false, error: { code: "registry_entry_conflict" } };
  }
  return { ok: true, value: target.value };
}

export async function reserveActorPair(input: {
  readonly db: OrganisationDatabase;
  readonly reservations: readonly [ActorReservation, ActorReservation];
}): Promise<
  Result<readonly [ActorRegistryEntry, ActorRegistryEntry], ActorRegistryError>
> {
  const [first, second] = input.reservations;
  if (sameActorRoute(first, second)) {
    return { ok: false, error: { code: "registry_entry_conflict" } };
  }
  for (const reservation of input.reservations)
    if (
      reservation.warmSlotName !== undefined &&
      !isWarmActorSlotName(reservation.warmSlotName, reservation.identity)
    )
      return { ok: false, error: { code: "registry_entry_conflict" } };
  if (
    !actorPlacementAdmissionMatchesIdentity(first.admission, first.identity) ||
    !actorPlacementAdmissionMatchesIdentity(second.admission, second.identity)
  )
    return { ok: false, error: { code: "registry_placement_conflict" } };
  const firstPlan = actorReservationPlan(first);
  const secondPlan = actorReservationPlan(second);
  const firstGuard = actorPlacementAdmissionPredicate(first.admission);
  const secondGuard = actorPlacementAdmissionPredicate(second.admission);
  const session = input.db.withSession("first-primary");
  const rows = await session
    .prepare(
      `INSERT INTO durable_object_registry (
       registry_id, activation_token, organisation_id, object_kind, logical_object_id,
       physical_object_name, placement_epoch, placement_cell_id, schema_version,
       state_version, lifecycle_status, fence_token, reserved_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'reserved', ?, ?
       WHERE ${firstGuard.sql} AND ${secondGuard.sql}
       UNION ALL SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'reserved', ?, ?
       WHERE ${firstGuard.sql} AND ${secondGuard.sql}
     ON CONFLICT (organisation_id, object_kind, logical_object_id, placement_epoch)
     DO UPDATE SET registry_id = durable_object_registry.registry_id
     RETURNING
       registry_id AS registryId,
       activation_token AS activationToken,
       organisation_id AS organisationId,
       object_kind AS objectKind,
       logical_object_id AS logicalObjectId,
       physical_object_name AS physicalObjectName,
       placement_epoch AS placementEpoch,
       placement_cell_id AS placementCellId,
       schema_version AS schemaVersion,
       state_version AS stateVersion,
       lifecycle_status AS lifecycleStatus,
       fence_token AS fenceToken,
       reserved_at AS reservedAt,
       activated_at AS activatedAt,
       exporting_at AS exportingAt,
       retired_at AS retiredAt,
       quarantined_at AS quarantinedAt,
       quarantine_reason AS quarantineReason`,
    )
    .bind(
      ...reservationBindings(firstPlan),
      ...firstGuard.bindings,
      ...secondGuard.bindings,
      ...reservationBindings(secondPlan),
      ...firstGuard.bindings,
      ...secondGuard.bindings,
    )
    .all<ReservationRow>();
  if (rows.results.length !== 2) {
    return { ok: false, error: { code: "registry_placement_conflict" } };
  }
  let firstEntry: ActorRegistryEntry | null = null;
  let secondEntry: ActorRegistryEntry | null = null;
  for (const row of rows.results) {
    const plan = reservationPlanForRow(row, firstPlan, secondPlan);
    if (plan === null)
      return { ok: false, error: { code: "registry_entry_conflict" } };
    const parsed = parseRegistryRow(
      registryRowFromReservation(row, plan.placement),
    );
    if (!parsed.ok) return parsed;
    if (!registryReservationMatches(parsed.value, plan)) {
      return { ok: false, error: { code: "registry_entry_conflict" } };
    }
    if (plan === firstPlan) firstEntry = parsed.value;
    if (plan === secondPlan) secondEntry = parsed.value;
  }
  return firstEntry !== null && secondEntry !== null
    ? { ok: true, value: [firstEntry, secondEntry] }
    : { ok: false, error: { code: "registry_entry_missing" } };
}

export async function activateActorRegistryEntries(input: {
  readonly db: OrganisationDatabase;
  readonly admission: ActorPlacementAdmission;
  readonly activations: readonly ActorRegistryActivation[];
  readonly now: number;
}): Promise<Result<readonly ActiveActorRegistryEntry[], ActorRegistryError>> {
  const session = input.db.withSession("first-primary");
  const guard = actorPlacementAdmissionPredicate(input.admission);
  const statements = [
    session.prepare(`SELECT ${guard.sql} AS admitted`).bind(...guard.bindings),
  ];
  for (const activation of input.activations) {
    if (
      !actorPlacementAdmissionMatchesIdentity(
        input.admission,
        activation.entry.identity,
      )
    )
      return { ok: false, error: { code: "registry_placement_conflict" } };
    statements.push(
      actorRegistryActivationStatement(
        session,
        input.admission,
        activation.entry.registryId,
        activation.entry.activationToken,
        activation.stateVersion,
        input.now,
      ),
    );
  }
  for (const activation of input.activations) {
    statements.push(
      session
        .prepare(`${registrySelect()} WHERE registry_id = ?`)
        .bind(activation.entry.registryId),
    );
  }
  const results = await session.batch<RegistryRow & { admitted: number }>(
    statements,
  );
  if (results[0]?.results[0]?.admitted !== 1)
    return { ok: false, error: { code: "registry_placement_conflict" } };
  const entries: ActiveActorRegistryEntry[] = [];
  let readIndex = input.activations.length + 1;
  for (const activation of input.activations) {
    const current = parseRegistryRow(results[readIndex]?.results[0] ?? null);
    readIndex += 1;
    if (!current.ok) return current;
    if (
      !actorPlacementAdmissionMatchesIdentity(
        input.admission,
        current.value.identity,
      )
    )
      return { ok: false, error: { code: "registry_placement_conflict" } };
    if (
      current.value.lifecycleStatus !== "active" ||
      current.value.activationToken !== activation.entry.activationToken ||
      current.value.stateVersion !== activation.stateVersion ||
      current.value.placement.placementEpoch !==
        input.admission.placement.placementEpoch ||
      current.value.placement.placementCellId !==
        input.admission.placement.placementCellId
    )
      return { ok: false, error: { code: "registry_activation_conflict" } };
    entries.push(current.value);
  }
  return { ok: true, value: entries };
}

export async function listPlacementActorRegistryEntries(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly placementEpoch: number;
}): Promise<Result<readonly ActorRegistryEntry[], ActorRegistryError>> {
  const rows = await input.db
    .prepare(
      `${registrySelect()}
       WHERE durable_object_registry.organisation_id = ?
         AND durable_object_registry.placement_epoch = ?
       ORDER BY object_kind, logical_object_id`,
    )
    .bind(input.organisationId, input.placementEpoch)
    .all<RegistryRow>();
  const entries: ActorRegistryEntry[] = [];

  for (const row of rows.results) {
    const parsed = parseRegistryRow(row);

    if (!parsed.ok) {
      return parsed;
    }

    entries.push(parsed.value);
  }

  return { ok: true, value: entries };
}

export async function listOrganisationActorRegistryEntries(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
}): Promise<Result<readonly ActorRegistryEntry[], ActorRegistryError>> {
  const rows = await input.db
    .prepare(
      `${registrySelect()}
       WHERE durable_object_registry.organisation_id = ?
       ORDER BY durable_object_registry.placement_epoch, object_kind, logical_object_id`,
    )
    .bind(input.organisationId)
    .all<RegistryRow>();
  const entries: ActorRegistryEntry[] = [];

  for (const row of rows.results) {
    const parsed = parseRegistryRow(row);

    if (!parsed.ok) {
      return parsed;
    }

    entries.push(parsed.value);
  }

  return { ok: true, value: entries };
}

export async function listRecentActiveCaseRegistryEntries(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly limit: number;
}): Promise<Result<readonly ActiveActorRegistryEntry[], ActorRegistryError>> {
  const rows = await input.db
    .prepare(
      `${registrySelect()}
       WHERE durable_object_registry.organisation_id = ?
         AND durable_object_registry.object_kind = 'case'
         AND durable_object_registry.lifecycle_status = 'active'
       ORDER BY durable_object_registry.activated_at DESC
       LIMIT ?`,
    )
    .bind(input.organisationId, input.limit)
    .all<RegistryRow>();
  const entries: ActiveActorRegistryEntry[] = [];

  for (const row of rows.results) {
    const parsed = parseRegistryRow(row);
    if (!parsed.ok) return parsed;
    if (
      parsed.value.lifecycleStatus !== "active" ||
      parsed.value.identity.objectKind !== "case"
    ) {
      return { ok: false, error: { code: "registry_entry_corrupt" } };
    }
    entries.push(parsed.value);
  }

  return { ok: true, value: entries };
}

export async function readExactActiveActorRegistryEntry(input: {
  readonly db: OrganisationDatabase;
  readonly identity: ActorIdentity;
  readonly placement: OrganisationPlacement;
  readonly schemaVersion: number;
}): Promise<Result<ActiveActorRegistryEntry, ExactActiveActorRegistryError>> {
  const current = await readRegistryEntry(
    input.db.withSession("first-primary"),
    {
      organisationId: input.identity.organisationId,
      objectKind: input.identity.objectKind,
      logicalObjectId: input.identity.logicalObjectId,
      placementEpoch: input.placement.placementEpoch,
    },
  );
  if (!current.ok) return exactActiveReadFailure(current.error);
  if (current.value.lifecycleStatus !== "active") {
    return { ok: false, error: { code: "registry_entry_not_active" } };
  }
  if (
    !exactActiveEntryMatches(current.value, input.identity, input.placement)
  ) {
    return { ok: false, error: { code: "registry_entry_corrupt" } };
  }
  if (current.value.schemaVersion !== input.schemaVersion) {
    return {
      ok: false,
      error: {
        code: "registry_schema_mismatch",
        expected: input.schemaVersion,
        received: current.value.schemaVersion,
      },
    };
  }
  return { ok: true, value: current.value };
}

function exactActiveEntryMatches(
  entry: ActiveActorRegistryEntry,
  identity: ActorIdentity,
  placement: OrganisationPlacement,
): boolean {
  return (
    entry.identity.objectKind === identity.objectKind &&
    entry.identity.organisationId === identity.organisationId &&
    entry.identity.logicalObjectId === identity.logicalObjectId &&
    isRegisteredActorName(entry.physicalObjectName, identity, placement) &&
    samePlacement(entry.placement, placement)
  );
}

function exactActiveReadFailure(
  error: ActorRegistryError,
): Result<never, ExactActiveActorRegistryError> {
  switch (error.code) {
    case "registry_entry_missing":
    case "registry_entry_corrupt":
      return { ok: false, error };
    case "registry_placement_conflict":
    case "registry_entry_conflict":
    case "registry_entry_not_activatable":
    case "registry_activation_conflict":
    case "registry_export_conflict":
    case "registry_retirement_conflict":
    case "registry_quarantine_conflict":
    case "invalid_quarantine_reason":
      return { ok: false, error: { code: "registry_entry_corrupt" } };
    default:
      return assertNever(error);
  }
}

export async function activateActorRegistryEntry(input: {
  readonly db: OrganisationDatabase;
  readonly admission: ActorPlacementAdmission;
  readonly registryId: ActorRegistryId;
  readonly activationToken: ActorActivationToken;
  readonly stateVersion: number;
  readonly now: number;
}): Promise<Result<ActorRegistryEntry, ActorRegistryError>> {
  const session = input.db.withSession("first-primary");
  const guard = actorPlacementAdmissionPredicate(input.admission);
  const [admitted, , readback] = await session.batch<
    RegistryRow & { admitted: number }
  >([
    session.prepare(`SELECT ${guard.sql} AS admitted`).bind(...guard.bindings),
    actorRegistryActivationStatement(
      session,
      input.admission,
      input.registryId,
      input.activationToken,
      input.stateVersion,
      input.now,
    ),
    session
      .prepare(`${registrySelect()} WHERE registry_id = ?`)
      .bind(input.registryId),
  ]);
  if (admitted?.results[0]?.admitted !== 1)
    return { ok: false, error: { code: "registry_placement_conflict" } };
  const current = parseRegistryRow(readback?.results[0] ?? null);
  if (!current.ok) return current;
  if (
    !actorPlacementAdmissionMatchesIdentity(
      input.admission,
      current.value.identity,
    )
  )
    return { ok: false, error: { code: "registry_placement_conflict" } };
  if (
    current.value.activationToken !== input.activationToken ||
    current.value.lifecycleStatus !== "active" ||
    current.value.stateVersion !== input.stateVersion ||
    current.value.placement.placementEpoch !==
      input.admission.placement.placementEpoch ||
    current.value.placement.placementCellId !==
      input.admission.placement.placementCellId
  )
    return { ok: false, error: { code: "registry_activation_conflict" } };
  return current;
}

function actorRegistryActivationStatement(
  session: OrganisationDatabaseSession,
  admission: ActorPlacementAdmission,
  registryId: ActorRegistryId,
  activationToken: ActorActivationToken,
  stateVersion: number,
  now: number,
): D1PreparedStatement {
  const guard = actorPlacementAdmissionPredicate(admission);
  const objectSql =
    admission.kind === "execution"
      ? ""
      : "AND object_kind = ? AND logical_object_id = ?";
  const objectBindings =
    admission.kind === "execution"
      ? []
      : [admission.identity.objectKind, admission.identity.logicalObjectId];
  return session
    .prepare(
      `UPDATE durable_object_registry SET lifecycle_status = 'active', state_version = ?, activated_at = ?
     WHERE registry_id = ? AND activation_token = ? AND lifecycle_status = 'reserved'
       AND organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ? AND ${guard.sql} ${objectSql}`,
    )
    .bind(
      stateVersion,
      now,
      registryId,
      activationToken,
      admission.organisationId,
      admission.placement.placementEpoch,
      admission.placement.placementCellId,
      ...guard.bindings,
      ...objectBindings,
    );
}

export async function advanceActiveActorRegistrySchema(input: {
  readonly db: OrganisationDatabase;
  readonly registryId: ActorRegistryId;
  readonly expectedFenceToken: ActorFenceToken;
  readonly sourceSchemaVersion: number;
  readonly targetSchemaVersion: number;
  readonly expectedStateVersion: number;
}): Promise<Result<ActorRegistryEntry, ActorRegistrySchemaAdvanceError>> {
  if (
    !Number.isSafeInteger(input.sourceSchemaVersion) ||
    input.sourceSchemaVersion < 1 ||
    input.targetSchemaVersion !== input.sourceSchemaVersion + 1 ||
    !Number.isSafeInteger(input.expectedStateVersion) ||
    input.expectedStateVersion < 1
  ) {
    return { ok: false, error: { code: "invalid_registry_schema_transition" } };
  }

  const targetStateVersion = input.expectedStateVersion + 1;
  const session = input.db.withSession("first-primary");
  await session
    .prepare(
      `UPDATE durable_object_registry
       SET schema_version = ?, state_version = ?
       WHERE registry_id = ?
         AND fence_token = ?
         AND lifecycle_status = 'active'
         AND schema_version = ?
         AND state_version = ?`,
    )
    .bind(
      input.targetSchemaVersion,
      targetStateVersion,
      input.registryId,
      input.expectedFenceToken,
      input.sourceSchemaVersion,
      input.expectedStateVersion,
    )
    .run();

  const current = await readRegistryEntryById(session, input.registryId);
  if (!current.ok) return registrySchemaReadFailure(current.error);
  return current.value.lifecycleStatus === "active" &&
    current.value.fenceToken === input.expectedFenceToken &&
    current.value.schemaVersion === input.targetSchemaVersion &&
    current.value.stateVersion === targetStateVersion
    ? current
    : { ok: false, error: { code: "registry_schema_advance_conflict" } };
}

function registrySchemaReadFailure(
  error: ActorRegistryError,
): Result<never, ActorRegistrySchemaAdvanceError> {
  switch (error.code) {
    case "registry_entry_missing":
    case "registry_entry_corrupt":
      return { ok: false, error };
    case "registry_placement_conflict":
    case "registry_entry_conflict":
    case "registry_entry_not_activatable":
    case "registry_activation_conflict":
    case "registry_export_conflict":
    case "registry_retirement_conflict":
    case "registry_quarantine_conflict":
    case "invalid_quarantine_reason":
      return { ok: false, error: { code: "registry_schema_advance_conflict" } };
    default:
      return assertNever(error);
  }
}

export async function beginActorExport(input: {
  readonly db: OrganisationDatabase;
  readonly registryId: ActorRegistryId;
  readonly expectedFenceToken: ActorFenceToken;
  readonly now: number;
}): Promise<Result<ActorRegistryEntry, ActorRegistryError>> {
  const session = input.db.withSession("first-primary");

  await session
    .prepare(
      `UPDATE durable_object_registry
       SET lifecycle_status = 'exporting',
           exporting_at = ?
       WHERE registry_id = ?
         AND fence_token = ?
         AND lifecycle_status = 'active'`,
    )
    .bind(input.now, input.registryId, input.expectedFenceToken)
    .run();

  const current = await readRegistryEntryById(session, input.registryId);

  if (!current.ok) {
    return current;
  }

  if (
    current.value.lifecycleStatus === "exporting" &&
    current.value.fenceToken === input.expectedFenceToken
  ) {
    return current;
  }

  return current.value.lifecycleStatus === "exporting" &&
    current.value.fenceToken === input.expectedFenceToken &&
    current.value.exportingAt === input.now
    ? current
    : { ok: false, error: { code: "registry_export_conflict" } };
}

export async function retireActorRegistryEntry(input: {
  readonly db: OrganisationDatabase;
  readonly registryId: ActorRegistryId;
  readonly expectedFenceToken: ActorFenceToken;
  readonly now: number;
}): Promise<Result<ActorRegistryEntry, ActorRegistryError>> {
  const session = input.db.withSession("first-primary");

  await session
    .prepare(
      `UPDATE durable_object_registry
       SET lifecycle_status = 'retired',
           retired_at = ?
       WHERE registry_id = ?
         AND fence_token = ?
         AND lifecycle_status = 'exporting'`,
    )
    .bind(input.now, input.registryId, input.expectedFenceToken)
    .run();

  const current = await readRegistryEntryById(session, input.registryId);

  if (!current.ok) {
    return current;
  }

  if (
    current.value.lifecycleStatus === "retired" &&
    current.value.fenceToken === input.expectedFenceToken
  ) {
    return current;
  }

  return current.value.lifecycleStatus === "retired" &&
    current.value.fenceToken === input.expectedFenceToken &&
    current.value.retiredAt === input.now
    ? current
    : { ok: false, error: { code: "registry_retirement_conflict" } };
}

export async function discardQuarantinedActorRegistryEntry(input: {
  readonly db: OrganisationDatabase;
  readonly registryId: ActorRegistryId;
  readonly expectedFenceToken: ActorFenceToken;
  readonly expectedQuarantinedAt: number;
  readonly expectedQuarantineReason: string;
}): Promise<
  Result<
    { readonly kind: "discarded"; readonly registryId: ActorRegistryId },
    ActorRegistryError
  >
> {
  if (input.expectedQuarantineReason.length === 0) {
    return { ok: false, error: { code: "invalid_quarantine_reason" } };
  }
  const session = input.db.withSession("first-primary");
  const deleted = await session
    .prepare(
      `DELETE FROM durable_object_registry
       WHERE registry_id = ?
         AND fence_token = ?
         AND lifecycle_status = 'quarantined'
         AND quarantined_at = ?
         AND quarantine_reason = ?
       RETURNING registry_id AS registryId`,
    )
    .bind(
      input.registryId,
      input.expectedFenceToken,
      input.expectedQuarantinedAt,
      input.expectedQuarantineReason,
    )
    .first<{ readonly registryId: unknown }>();
  const registryId = parseActorRegistryId(deleted?.registryId);
  return registryId.ok && registryId.value === input.registryId
    ? { ok: true, value: { kind: "discarded", registryId: registryId.value } }
    : { ok: false, error: { code: "registry_quarantine_conflict" } };
}

export async function quarantineActorRegistryEntry(input: {
  readonly db: OrganisationDatabase;
  readonly registryId: ActorRegistryId;
  readonly expectedFenceToken: ActorFenceToken;
  readonly reason: string;
  readonly now: number;
}): Promise<Result<ActorRegistryEntry, ActorRegistryError>> {
  if (input.reason.length === 0) {
    return { ok: false, error: { code: "invalid_quarantine_reason" } };
  }

  const session = input.db.withSession("first-primary");

  await session
    .prepare(
      `UPDATE durable_object_registry
       SET lifecycle_status = 'quarantined',
           quarantined_at = ?,
           quarantine_reason = ?
       WHERE registry_id = ?
         AND fence_token = ?
         AND lifecycle_status IN ('reserved', 'active', 'exporting')`,
    )
    .bind(input.now, input.reason, input.registryId, input.expectedFenceToken)
    .run();

  const current = await readRegistryEntryById(session, input.registryId);

  if (!current.ok) {
    return current;
  }

  return current.value.lifecycleStatus === "quarantined" &&
    current.value.fenceToken === input.expectedFenceToken &&
    current.value.quarantinedAt === input.now &&
    current.value.quarantineReason === input.reason
    ? current
    : { ok: false, error: { code: "registry_quarantine_conflict" } };
}

export function actorActivationIdentity(
  entry: VariantBy<
    ActorRegistryEntry,
    "lifecycleStatus",
    "reserved" | "active"
  >,
  requestedAt: number,
): ActorActivationIdentity {
  return {
    registryId: entry.registryId,
    activationToken: entry.activationToken,
    identity: entry.identity,
    physicalObjectName: entry.physicalObjectName,
    placement: entry.placement,
    schemaVersion: entry.schemaVersion,
    fenceToken: entry.fenceToken,
    requestedAt,
  };
}

export function actorActivationRequest(
  entry: VariantBy<
    ActorRegistryEntry,
    "lifecycleStatus",
    "reserved" | "active"
  >,
  requestedAt: number,
  admission: ActorPlacementAdmission,
): ActorActivationRequest {
  const identity = actorActivationIdentity(entry, requestedAt);
  return {
    admission,
    registryId: identity.registryId,
    activationToken: identity.activationToken,
    identity: identity.identity,
    physicalObjectName: identity.physicalObjectName,
    placement: identity.placement,
    schemaVersion: identity.schemaVersion,
    fenceToken: identity.fenceToken,
    requestedAt: identity.requestedAt,
  };
}

export function actorPhysicalName(
  identity: ActorIdentity,
  placement: OrganisationPlacement,
): string {
  const initialName = initialActorPhysicalName(identity);

  // Epoch one adopts pre-registry objects in place. Relocations always create a new object.
  return placement.placementEpoch === 1
    ? initialName
    : `${initialName}:p${placement.placementEpoch}`;
}

/** The kinds of Actor that a Connector starts before a thread names them. */
export type WarmActorKind = "case" | "session";

/**
 * A new name for a warm slot: a Case or Session object that starts before any
 * thread names it (Plan 55F). The random part makes each name new, and the
 * registry keeps every physical name unique, so one slot serves at most one
 * identity.
 */
export function newWarmActorSlotName(
  organisationId: OrganisationId,
  kind: WarmActorKind,
): string {
  return `${organisationId}:warm:${kind}:${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Whether the name is a warm slot of the identity's Organisation and kind. */
export function isWarmActorSlotName(
  name: string,
  identity: ActorIdentity,
): boolean {
  return (
    (identity.objectKind === "case" || identity.objectKind === "session") &&
    isWarmActorSlotNameOf(name, identity.organisationId, identity.objectKind)
  );
}

/** Whether the name is a warm slot of this Organisation and kind. */
export function isWarmActorSlotNameOf(
  name: string,
  organisationId: OrganisationId,
  kind: WarmActorKind,
): boolean {
  const prefix = `${organisationId}:warm:${kind}:`;
  return (
    name.startsWith(prefix) && /^[0-9a-f]{32}$/.test(name.slice(prefix.length))
  );
}

/**
 * Whether a registry row may name this object for the identity: its derived
 * name, or a warm slot that a new Case or Session took.
 */
export function isRegisteredActorName(
  name: string,
  identity: ActorIdentity,
  placement: OrganisationPlacement,
): boolean {
  return (
    name === actorPhysicalName(identity, placement) ||
    isWarmActorSlotName(name, identity)
  );
}

/** The name an Actor has at its first placement, before any relocation. */
export function initialActorPhysicalName(identity: ActorIdentity): string {
  switch (identity.objectKind) {
    case "organisation":
      return identity.organisationId;
    case "surface":
    case "session":
    case "thread":
    case "case":
    case "connector":
      return `${identity.organisationId}:${identity.logicalObjectId}`;
    default:
      return assertNever(identity);
  }
}

async function readRegistryEntry(
  db: Pick<OrganisationDatabaseSession, "prepare">,
  identity: {
    readonly organisationId: OrganisationId;
    readonly objectKind: ActorIdentity["objectKind"];
    readonly logicalObjectId: string;
    readonly placementEpoch: number;
  },
): Promise<Result<ActorRegistryEntry, ActorRegistryError>> {
  const row = await registryEntryQuery(db, identity).first<RegistryRow>();
  return parseRegistryRow(row);
}

function registryEntryQuery(
  db: Pick<OrganisationDatabaseSession, "prepare">,
  identity: {
    readonly organisationId: OrganisationId;
    readonly objectKind: ActorIdentity["objectKind"];
    readonly logicalObjectId: string;
    readonly placementEpoch: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `${registrySelect()}
       WHERE durable_object_registry.organisation_id = ?
         AND object_kind = ?
         AND logical_object_id = ?
         AND durable_object_registry.placement_epoch = ?`,
    )
    .bind(
      identity.organisationId,
      identity.objectKind,
      identity.logicalObjectId,
      identity.placementEpoch,
    );
}

export async function readRegistryEntryById(
  db: Pick<OrganisationDatabaseSession, "prepare">,
  registryId: ActorRegistryId,
): Promise<Result<ActorRegistryEntry, ActorRegistryError>> {
  const row = await db
    .prepare(`${registrySelect()} WHERE registry_id = ?`)
    .bind(registryId)
    .first<RegistryRow>();

  return parseRegistryRow(row);
}

function registrySelect(): string {
  return `SELECT
     registry_id AS registryId,
     activation_token AS activationToken,
     durable_object_registry.organisation_id AS organisationId,
     object_kind AS objectKind,
     logical_object_id AS logicalObjectId,
     physical_object_name AS physicalObjectName,
     durable_object_registry.placement_epoch AS placementEpoch,
     durable_object_registry.placement_cell_id AS placementCellId,
     organisation_placement.placement_kind AS placementKind,
     organisation_placement.location_hint AS locationHint,
     organisation_placement.residency_jurisdiction AS residencyJurisdiction,
     schema_version AS schemaVersion,
     state_version AS stateVersion,
     lifecycle_status AS lifecycleStatus,
     durable_object_registry.fence_token AS fenceToken,
     reserved_at AS reservedAt,
     durable_object_registry.activated_at AS activatedAt,
     exporting_at AS exportingAt,
     durable_object_registry.retired_at AS retiredAt,
     quarantined_at AS quarantinedAt,
     quarantine_reason AS quarantineReason
   FROM durable_object_registry
   JOIN organisation_placement
     ON organisation_placement.organisation_id = durable_object_registry.organisation_id
    AND organisation_placement.placement_epoch = durable_object_registry.placement_epoch`;
}

function parseRegistryRow(
  row: RegistryRow | null,
): Result<ActorRegistryEntry, ActorRegistryError> {
  if (row === null) {
    return { ok: false, error: { code: "registry_entry_missing" } };
  }

  const identity = parseActorIdentity(row);
  const placement = parseRegistryPlacement(row);

  if (!identity.ok || !placement.ok || !validRegistryBase(row)) {
    return { ok: false, error: { code: "registry_entry_corrupt" } };
  }

  const registryId = parseActorRegistryId(row.registryId);
  const activationToken = parseActorActivationToken(row.activationToken);
  const fenceToken = parseActorFenceToken(row.fenceToken);

  if (!registryId.ok || !activationToken.ok || !fenceToken.ok) {
    return corruptRegistry();
  }

  const base: RegistryEntryIdentity = {
    registryId: registryId.value,
    activationToken: activationToken.value,
    identity: identity.value,
    physicalObjectName: row.physicalObjectName,
    placement: placement.value,
    schemaVersion: row.schemaVersion,
    stateVersion: row.stateVersion,
    fenceToken: fenceToken.value,
    reservedAt: row.reservedAt,
  };

  return parseRegistryLifecycle(base, row);
}

function parseRegistryLifecycle(
  base: RegistryEntryIdentity,
  row: RegistryRow,
): Result<ActorRegistryEntry, ActorRegistryError> {
  switch (row.lifecycleStatus) {
    case "reserved":
      return allNull(
        row.activatedAt,
        row.exportingAt,
        row.retiredAt,
        row.quarantinedAt,
        row.quarantineReason,
      )
        ? { ok: true, value: { ...base, lifecycleStatus: "reserved" } }
        : corruptRegistry();
    case "active":
      return validTimestamp(row.activatedAt) &&
        allNull(
          row.exportingAt,
          row.retiredAt,
          row.quarantinedAt,
          row.quarantineReason,
        )
        ? {
            ok: true,
            value: {
              ...base,
              lifecycleStatus: "active",
              activatedAt: row.activatedAt,
            },
          }
        : corruptRegistry();
    case "exporting":
      return validTimestamp(row.activatedAt) &&
        validTimestamp(row.exportingAt) &&
        allNull(row.retiredAt, row.quarantinedAt, row.quarantineReason)
        ? {
            ok: true,
            value: {
              ...base,
              lifecycleStatus: "exporting",
              activatedAt: row.activatedAt,
              exportingAt: row.exportingAt,
            },
          }
        : corruptRegistry();
    case "retired":
      return validTimestamp(row.activatedAt) &&
        validTimestamp(row.exportingAt) &&
        validTimestamp(row.retiredAt) &&
        allNull(row.quarantinedAt, row.quarantineReason)
        ? {
            ok: true,
            value: {
              ...base,
              lifecycleStatus: "retired",
              activatedAt: row.activatedAt,
              exportingAt: row.exportingAt,
              retiredAt: row.retiredAt,
            },
          }
        : corruptRegistry();
    case "quarantined":
      return nullableTimestamp(row.activatedAt) &&
        nullableTimestamp(row.exportingAt) &&
        row.retiredAt === null &&
        validTimestamp(row.quarantinedAt) &&
        typeof row.quarantineReason === "string" &&
        row.quarantineReason.length > 0
        ? {
            ok: true,
            value: {
              ...base,
              lifecycleStatus: "quarantined",
              activatedAt: row.activatedAt,
              exportingAt: row.exportingAt,
              quarantinedAt: row.quarantinedAt,
              quarantineReason: row.quarantineReason,
            },
          }
        : corruptRegistry();
    default:
      return corruptRegistry();
  }
}

function parseActorIdentity(
  row: RegistryRow,
): Result<ActorIdentity, ActorRegistryError> {
  if (
    typeof row.organisationId !== "string" ||
    typeof row.logicalObjectId !== "string"
  ) {
    return corruptRegistry();
  }

  const organisationId = parseOrganisationId(row.organisationId);

  if (!organisationId.ok) {
    return corruptRegistry();
  }

  switch (row.objectKind) {
    case "organisation":
      return row.logicalObjectId === organisationId.value
        ? {
            ok: true,
            value: {
              objectKind: row.objectKind,
              organisationId: organisationId.value,
              logicalObjectId: organisationId.value,
            },
          }
        : corruptRegistry();
    case "surface": {
      const logicalObjectId = parseChannelId(row.logicalObjectId);
      return logicalObjectId.ok
        ? {
            ok: true,
            value: {
              objectKind: row.objectKind,
              organisationId: organisationId.value,
              logicalObjectId: logicalObjectId.value,
            },
          }
        : corruptRegistry();
    }
    case "session": {
      const logicalObjectId = parseSessionId(row.logicalObjectId);
      return logicalObjectId.ok
        ? {
            ok: true,
            value: {
              objectKind: row.objectKind,
              organisationId: organisationId.value,
              logicalObjectId: logicalObjectId.value,
            },
          }
        : corruptRegistry();
    }
    case "thread": {
      const logicalObjectId = parseThreadId(row.logicalObjectId);
      return logicalObjectId.ok
        ? {
            ok: true,
            value: {
              objectKind: row.objectKind,
              organisationId: organisationId.value,
              logicalObjectId: logicalObjectId.value,
            },
          }
        : corruptRegistry();
    }
    case "case": {
      const logicalObjectId = parseCaseId(row.logicalObjectId);
      return logicalObjectId.ok
        ? {
            ok: true,
            value: {
              objectKind: row.objectKind,
              organisationId: organisationId.value,
              logicalObjectId: logicalObjectId.value,
            },
          }
        : corruptRegistry();
    }
    case "connector": {
      const logicalObjectId = parseConnectorId(row.logicalObjectId);
      return logicalObjectId.ok
        ? {
            ok: true,
            value: {
              objectKind: row.objectKind,
              organisationId: organisationId.value,
              logicalObjectId: logicalObjectId.value,
            },
          }
        : corruptRegistry();
    }
    default:
      return corruptRegistry();
  }
}

function parseRegistryPlacement(
  row: RegistryRow,
): Result<OrganisationPlacement, ActorRegistryError> {
  const raw = {
    kind: row.placementKind,
    placementEpoch: row.placementEpoch,
    placementCellId: row.placementCellId,
    locationHint: row.locationHint,
    ...(row.placementKind === "residency"
      ? { residencyJurisdiction: row.residencyJurisdiction }
      : {}),
  };
  const placement = parseOrganisationPlacement(raw, "actorRegistry.placement");

  return placement.ok ? placement : corruptRegistry();
}

function validRegistryBase(row: RegistryRow): row is RegistryRow & {
  registryId: string;
  activationToken: string;
  physicalObjectName: string;
  schemaVersion: number;
  stateVersion: number;
  fenceToken: string;
  reservedAt: number;
} {
  return (
    typeof row.registryId === "string" &&
    row.registryId.length > 0 &&
    typeof row.activationToken === "string" &&
    row.activationToken.length > 0 &&
    typeof row.physicalObjectName === "string" &&
    row.physicalObjectName.length > 0 &&
    isPositiveInteger(row.schemaVersion) &&
    isNonNegativeInteger(row.stateVersion) &&
    typeof row.fenceToken === "string" &&
    row.fenceToken.length > 0 &&
    validTimestamp(row.reservedAt)
  );
}

function registryReservationMatches(
  entry: ActorRegistryEntry,
  expected: {
    readonly registryId: ActorRegistryId;
    readonly identity: ActorIdentity;
    readonly placement: OrganisationPlacement;
    readonly physicalObjectName: string;
    readonly schemaVersion: number;
  },
): boolean {
  return (
    entry.identity.objectKind === expected.identity.objectKind &&
    entry.identity.organisationId === expected.identity.organisationId &&
    entry.identity.logicalObjectId === expected.identity.logicalObjectId &&
    entry.placement.placementEpoch === expected.placement.placementEpoch &&
    entry.placement.placementCellId === expected.placement.placementCellId &&
    // A new row has the planned name. A row that was there keeps its own.
    (entry.registryId === expected.registryId
      ? entry.physicalObjectName === expected.physicalObjectName
      : isRegisteredActorName(
          entry.physicalObjectName,
          expected.identity,
          expected.placement,
        )) &&
    registrySchemaVersionMatches(entry, expected.schemaVersion)
  );
}

function actorReservationPlan(
  reservation: ActorReservation,
): ActorReservationPlan {
  return {
    identity: reservation.identity,
    admission: reservation.admission,
    placement: reservation.admission.placement,
    schemaVersion: reservation.schemaVersion,
    now: reservation.now,
    registryId: newRegistryId(),
    activationToken: newActivationToken(),
    physicalObjectName:
      reservation.warmSlotName ??
      actorPhysicalName(reservation.identity, reservation.admission.placement),
    fenceToken: newFenceToken(),
  };
}

function reservationBindings(
  plan: ActorReservationPlan,
): readonly SqlStorageValue[] {
  return [
    plan.registryId,
    plan.activationToken,
    plan.identity.organisationId,
    plan.identity.objectKind,
    plan.identity.logicalObjectId,
    plan.physicalObjectName,
    plan.placement.placementEpoch,
    plan.placement.placementCellId,
    plan.schemaVersion,
    plan.fenceToken,
    plan.now,
  ];
}

function reservationPlanForRow(
  row: ReservationRow,
  first: ActorReservationPlan,
  second: ActorReservationPlan,
): ActorReservationPlan | null {
  if (reservationRowMatchesPlan(row, first)) return first;
  if (reservationRowMatchesPlan(row, second)) return second;
  return null;
}

function reservationRowMatchesPlan(
  row: ReservationRow,
  plan: ActorReservationPlan,
): boolean {
  return (
    row.organisationId === plan.identity.organisationId &&
    row.objectKind === plan.identity.objectKind &&
    row.logicalObjectId === plan.identity.logicalObjectId &&
    row.placementEpoch === plan.placement.placementEpoch
  );
}

function registryRowFromReservation(
  row: ReservationRow,
  placement: OrganisationPlacement,
): RegistryRow {
  return {
    ...row,
    placementKind: placement.kind,
    locationHint: placement.locationHint,
    residencyJurisdiction:
      placement.kind === "residency" ? placement.residencyJurisdiction : null,
  };
}

function sameActorRoute(
  first: ActorReservation,
  second: ActorReservation,
): boolean {
  return (
    first.identity.organisationId === second.identity.organisationId &&
    first.identity.objectKind === second.identity.objectKind &&
    first.identity.logicalObjectId === second.identity.logicalObjectId &&
    first.admission.placement.placementEpoch ===
      second.admission.placement.placementEpoch
  );
}

function registrySchemaVersionMatches(
  entry: ActorRegistryEntry,
  expectedSchemaVersion: number,
): boolean {
  switch (entry.lifecycleStatus) {
    case "reserved":
      return entry.schemaVersion === expectedSchemaVersion;
    case "active":
      // Active objects migrate their local schema when the Durable Object wakes.
      return entry.schemaVersion <= expectedSchemaVersion;
    case "exporting":
    case "retired":
    case "quarantined":
      return false;
    default:
      return assertNever(entry);
  }
}

function newRegistryId(): ActorRegistryId {
  const parsed = parseActorRegistryId(`dor_${crypto.randomUUID()}`);
  if (!parsed.ok) throw new Error("generated registry id invariant failed");
  return parsed.value;
}

function newActivationToken(): ActorActivationToken {
  const parsed = parseActorActivationToken(`doa_${crypto.randomUUID()}`);
  if (!parsed.ok)
    throw new Error("generated activation token invariant failed");
  return parsed.value;
}

function newFenceToken(): ActorFenceToken {
  const parsed = parseActorFenceToken(`dof_${crypto.randomUUID()}`);
  if (!parsed.ok) throw new Error("generated fence token invariant failed");
  return parsed.value;
}

export function parseActorRegistryId(
  raw: unknown,
): Result<ActorRegistryId, RegistryTokenParseError> {
  return validRegistryToken(raw, "dor_")
    ? { ok: true, value: raw as ActorRegistryId }
    : invalidRegistryToken();
}

export function parseActorActivationToken(
  raw: unknown,
): Result<ActorActivationToken, RegistryTokenParseError> {
  return validRegistryToken(raw, "doa_")
    ? { ok: true, value: raw as ActorActivationToken }
    : invalidRegistryToken();
}

export function parseActorFenceToken(
  raw: unknown,
): Result<ActorFenceToken, RegistryTokenParseError> {
  return validRegistryToken(raw, "dof_")
    ? { ok: true, value: raw as ActorFenceToken }
    : invalidRegistryToken();
}

function validRegistryToken(
  raw: unknown,
  prefix: "dor_" | "doa_" | "dof_",
): raw is string {
  return (
    typeof raw === "string" &&
    raw.startsWith(prefix) &&
    raw.length > prefix.length
  );
}

function invalidRegistryToken(): Result<never, RegistryTokenParseError> {
  return { ok: false, error: { code: "invalid_registry_token" } };
}

function validTimestamp(value: unknown): value is number {
  return isNonNegativeInteger(value);
}

function nullableTimestamp(value: unknown): value is number | null {
  return value === null || validTimestamp(value);
}

function allNull(...values: readonly unknown[]): boolean {
  return values.every(isNull);
}

function isNull(value: unknown): boolean {
  return value === null;
}

function corruptRegistry(): Result<never, ActorRegistryError> {
  return { ok: false, error: { code: "registry_entry_corrupt" } };
}
