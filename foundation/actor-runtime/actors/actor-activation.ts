import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  actorActivationIdentity,
  parseActorRegistryId,
  readRegistryEntryById,
  type ActorRegistryEntry,
  type ActorActivationRequest,
  type ActorActivationIdentity,
  type ActorActivationResult,
} from "./actor-registry";
import {
  readPlacementByEpoch,
  samePlacement,
} from "@purin-labs/tenancy/data/organisation-placement";
import {
  actorPlacementAdmissionPredicate,
  actorPlacementDirectoryAdmits,
  actorPlacementAdmissionMatchesIdentity,
} from "./actor-placement-admission";
import {
  OrganisationExecutionScope,
  selectOrganisationPlacementDatabase,
  type OrganisationPlacementBindings,
} from "@purin-labs/tenancy/organisation-execution-scope";
import { parseOrganisationPlacement } from "@purin-labs/tenancy/placement";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { assertNever } from "@purin-labs/std";
import type { StrictUnion, VariantBy } from "@purin-labs/type-utils";
import type { Result } from "@purin-labs/kernel/result";

type ActivationRow = Record<string, SqlStorageValue> & {
  registry_id: string;
  activation_token: string;
  organisation_id: string;
  object_kind: string;
  logical_object_id: string;
  physical_object_name: string;
  placement_kind: string;
  placement_epoch: number;
  placement_cell_id: string;
  location_hint: string;
  residency_jurisdiction: string | null;
  schema_version: number;
  state_version: number;
  fence_token: string;
  activated_at: number;
};

const INITIAL_STATE_VERSION = 1;

export type ActorRecoveryAdmission = StrictUnion<
  | { readonly kind: "admitted"; readonly scope: OrganisationExecutionScope }
  | { readonly kind: "deferred" }
  | { readonly kind: "inactive" }
>;

export async function admitActorRecovery(
  env: OrganisationPlacementBindings,
  storage: Pick<DurableObjectStorage, "sql" | "setAlarm" | "deleteAlarm">,
): Promise<ActorRecoveryAdmission> {
  const admission = await resolveActorRecoveryAdmission(env, storage.sql);
  switch (admission.kind) {
    case "admitted":
      return admission;
    case "deferred":
      // Imported alarms can fire before placement publication; retain their wakeup.
      await storage.setAlarm(Date.now() + 15_000);
      return admission;
    case "inactive":
      await storage.deleteAlarm();
      return admission;
    default:
      return assertNever(admission);
  }
}

/**
 * The regional database this Actor's activation pins, when the Actor belongs
 * to the named organisation. A caller may start a read there beside its
 * recovery admission. That read decides nothing unless the admission then
 * returns a scope on the same database.
 */
export function pinnedActorDatabase(
  env: OrganisationPlacementBindings,
  sql: ActorActivationSql,
  expectedOrganisationId: string,
): OrganisationDatabase | null {
  const local = readActivation(sql);
  if (local === undefined || local.organisation_id !== expectedOrganisationId)
    return null;
  const organisationId = parseOrganisationId(local.organisation_id);
  const pinned = pinnedPlacement(local);
  if (!organisationId.ok || !pinned.ok) return null;
  const selected = selectOrganisationPlacementDatabase(
    env,
    organisationId.value,
    pinned.value,
  );
  return selected.ok ? selected.value : null;
}

function pinnedPlacement(local: ActivationRow) {
  return parseOrganisationPlacement({
    kind: local.placement_kind,
    placementEpoch: local.placement_epoch,
    placementCellId: local.placement_cell_id,
    locationHint: local.location_hint,
    ...(local.residency_jurisdiction === null
      ? {}
      : { residencyJurisdiction: local.residency_jurisdiction }),
  });
}

export async function resolveActorRecoveryAdmission(
  env: OrganisationPlacementBindings,
  sql: ActorActivationSql,
): Promise<ActorRecoveryAdmission> {
  const local = readActivation(sql);
  if (local === undefined) return { kind: "inactive" };
  const registryId = parseActorRegistryId(local.registry_id);
  if (!registryId.ok) throw new Error("activation_mismatch");
  const organisationId = parseOrganisationId(local.organisation_id);
  const pinned = pinnedPlacement(local);
  if (!organisationId.ok || !pinned.ok) throw new Error("activation_mismatch");
  const selected = selectOrganisationPlacementDatabase(
    env,
    organisationId.value,
    pinned.value,
  );
  if (!selected.ok) return { kind: "deferred" };
  const session = selected.value.withSession("first-primary");
  const [registered, execution] = await Promise.all([
    readRegistryEntryById(session, registryId.value),
    OrganisationExecutionScope.resolveAtPlacement(
      env,
      organisationId.value,
      pinned.value,
    ),
  ]);
  if (!registered.ok) {
    if (registered.error.code === "registry_entry_missing")
      return { kind: "inactive" };
    throw new Error(registered.error.code);
  }
  const entry = registered.value;
  if (
    entry.lifecycleStatus === "retired" ||
    entry.lifecycleStatus === "quarantined"
  )
    return { kind: "inactive" };
  if (entry.lifecycleStatus === "active")
    return admitActiveActorRecovery(env, local, entry, execution);
  const placement = await readPlacementByEpoch(
    env.DB.withSession("first-primary"),
    entry.identity.organisationId,
    entry.placement.placementEpoch,
  );
  if (!placement.ok) throw new Error(placement.error.code);
  switch (placement.value.status) {
    case "reserved":
    case "frozen":
      return { kind: "deferred" };
    case "retired":
    case "abandoned":
      return { kind: "inactive" };
    case "active":
      switch (entry.lifecycleStatus) {
        case "reserved":
          return { kind: "deferred" };
        case "exporting":
          return { kind: "inactive" };
        default:
          return assertNever(entry);
      }
    default:
      return assertNever(placement.value);
  }
}

async function admitActiveActorRecovery(
  env: OrganisationPlacementBindings,
  local: ActivationRow,
  entry: VariantBy<ActorRegistryEntry, "lifecycleStatus", "active">,
  execution: Awaited<
    ReturnType<typeof OrganisationExecutionScope.resolveAtPlacement>
  >,
): Promise<ActorRecoveryAdmission> {
  const activationMatches = sameActivation(
    local,
    actorActivationIdentity(entry, entry.activatedAt),
  );
  if (activationMatches && execution.ok)
    return { kind: "admitted", scope: execution.value };
  // A staged target can be active locally before its placement is published.
  const placement = await readPlacementByEpoch(
    env.DB.withSession("first-primary"),
    entry.identity.organisationId,
    entry.placement.placementEpoch,
  );
  if (!placement.ok) throw new Error(placement.error.code);
  switch (placement.value.status) {
    case "reserved":
    case "frozen":
      return { kind: "deferred" };
    case "retired":
    case "abandoned":
      return { kind: "inactive" };
    case "active":
      if (!activationMatches) return { kind: "inactive" };
      if (execution.ok) return { kind: "inactive" };
      if (execution.error.code === "organisation_placement_missing")
        return { kind: "deferred" };
      throw new Error(execution.error.code);
    default:
      return assertNever(placement.value);
  }
}

export async function admitActorActivation(
  env: OrganisationPlacementBindings,
  request: ActorActivationRequest,
): Promise<boolean> {
  if (
    !actorPlacementAdmissionMatchesIdentity(
      request.admission,
      request.identity,
    ) ||
    !samePlacement(request.placement, request.admission.placement)
  )
    return false;
  const selected = selectOrganisationPlacementDatabase(
    env,
    request.identity.organisationId,
    request.placement,
  );
  if (!selected.ok) return false;
  const db = selected.value;
  const guard = actorPlacementAdmissionPredicate(request.admission);
  const [directoryAdmits, row] = await Promise.all([
    actorPlacementDirectoryAdmits(env.DB, request.admission),
    db
      .withSession("first-primary")
      .prepare(
        `SELECT 1 FROM durable_object_registry
     WHERE registry_id = ? AND activation_token = ? AND fence_token = ?
       AND organisation_id = ? AND object_kind = ? AND logical_object_id = ?
       AND physical_object_name = ? AND schema_version = ?
       AND placement_epoch = ? AND placement_cell_id = ?
       AND lifecycle_status IN ('reserved', 'active') AND ${guard.sql}`,
      )
      .bind(
        request.registryId,
        request.activationToken,
        request.fenceToken,
        request.identity.organisationId,
        request.identity.objectKind,
        request.identity.logicalObjectId,
        request.physicalObjectName,
        request.schemaVersion,
        request.placement.placementEpoch,
        request.placement.placementCellId,
        ...guard.bindings,
      )
      .first(),
  ]);
  return directoryAdmits && row !== null;
}

export type ActorActivationSchemaAdvance = {
  registryId: string;
  fenceToken: string;
  sourceSchemaVersion: number;
  targetSchemaVersion: number;
};

export type ActorActivationSchemaAdvanceError =
  | { code: "activation_missing" }
  | { code: "activation_fence_mismatch" }
  | { code: "activation_schema_mismatch" };

type ActorActivationIdentityField =
  | "registryId"
  | "activationToken"
  | "organisationId"
  | "objectKind"
  | "logicalObjectId"
  | "physicalObjectName"
  | "placementKind"
  | "placementEpoch"
  | "placementCellId"
  | "locationHint"
  | "residencyJurisdiction"
  | "fenceToken";

export type ActorActivationInspection =
  | { readonly kind: "missing" }
  | {
      readonly kind: "mismatch";
      readonly reason: "identity";
      readonly schemaVersion: number;
      readonly stateVersion: number;
      readonly mismatchedFields: readonly ActorActivationIdentityField[];
    }
  | {
      readonly kind: "mismatch";
      readonly reason: "schema";
      readonly schemaVersion: number;
      readonly stateVersion: number;
    }
  | {
      readonly kind: "match";
      readonly schemaVersion: number;
      readonly stateVersion: number;
    };

type ActorActivationSql = {
  exec<Row extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): { toArray(): Row[] };
};

export function createActorActivationSchema(sql: ActorActivationSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS state_object_activation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      registry_id TEXT NOT NULL,
      activation_token TEXT NOT NULL,
      organisation_id TEXT NOT NULL,
      object_kind TEXT NOT NULL CHECK (object_kind IN ('organisation', 'surface', 'session', 'thread', 'case', 'connector')),
      logical_object_id TEXT NOT NULL,
      physical_object_name TEXT NOT NULL,
      placement_kind TEXT NOT NULL CHECK (placement_kind IN ('affinity', 'residency')),
      placement_epoch INTEGER NOT NULL CHECK (placement_epoch > 0),
      placement_cell_id TEXT NOT NULL,
      location_hint TEXT NOT NULL,
      residency_jurisdiction TEXT,
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      state_version INTEGER NOT NULL CHECK (state_version > 0),
      fence_token TEXT NOT NULL,
      activated_at INTEGER NOT NULL,
      CHECK (
        (placement_kind = 'affinity' AND residency_jurisdiction IS NULL) OR
        (placement_kind = 'residency' AND residency_jurisdiction IN ('eu', 'fedramp'))
      )
    )`,
  );
}

export function activateActor(
  sql: ActorActivationSql,
  request: ActorActivationIdentity,
): ActorActivationResult {
  const current = readActivation(sql);

  if (current !== undefined) {
    return sameActivation(current, request)
      ? activatedResult(request, current.state_version)
      : { ok: false, error: { code: "activation_conflict" } };
  }

  sql.exec(
    `INSERT INTO state_object_activation (
       singleton,
       registry_id,
       activation_token,
       organisation_id,
       object_kind,
       logical_object_id,
       physical_object_name,
       placement_kind,
       placement_epoch,
       placement_cell_id,
       location_hint,
       residency_jurisdiction,
       schema_version,
       state_version,
       fence_token,
       activated_at
     )
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    request.registryId,
    request.activationToken,
    request.identity.organisationId,
    request.identity.objectKind,
    request.identity.logicalObjectId,
    request.physicalObjectName,
    request.placement.kind,
    request.placement.placementEpoch,
    request.placement.placementCellId,
    request.placement.locationHint,
    request.placement.kind === "residency"
      ? request.placement.residencyJurisdiction
      : null,
    request.schemaVersion,
    INITIAL_STATE_VERSION,
    request.fenceToken,
    request.requestedAt,
  );

  return activatedResult(request, INITIAL_STATE_VERSION);
}

export function advanceActorActivationSchema(
  sql: ActorActivationSql,
  input: ActorActivationSchemaAdvance,
): Result<
  { kind: "advanced"; stateVersion: number },
  ActorActivationSchemaAdvanceError
> {
  const current = readActivation(sql);
  if (current === undefined) {
    return { ok: false, error: { code: "activation_missing" } };
  }
  if (
    current.registry_id !== input.registryId ||
    current.fence_token !== input.fenceToken
  ) {
    return { ok: false, error: { code: "activation_fence_mismatch" } };
  }
  if (input.targetSchemaVersion !== input.sourceSchemaVersion + 1) {
    return { ok: false, error: { code: "activation_schema_mismatch" } };
  }
  if (current.schema_version === input.targetSchemaVersion) {
    return {
      ok: true,
      value: { kind: "advanced", stateVersion: current.state_version },
    };
  }
  if (current.schema_version !== input.sourceSchemaVersion) {
    return { ok: false, error: { code: "activation_schema_mismatch" } };
  }

  const nextStateVersion = current.state_version + 1;
  sql.exec(
    `UPDATE state_object_activation
     SET schema_version = ?, state_version = ?
     WHERE singleton = 1 AND registry_id = ? AND fence_token = ? AND schema_version = ?`,
    input.targetSchemaVersion,
    nextStateVersion,
    input.registryId,
    input.fenceToken,
    input.sourceSchemaVersion,
  );
  const advanced = readActivation(sql);
  if (
    advanced?.registry_id !== input.registryId ||
    advanced.fence_token !== input.fenceToken ||
    advanced.schema_version !== input.targetSchemaVersion ||
    advanced.state_version !== nextStateVersion
  ) {
    return { ok: false, error: { code: "activation_schema_mismatch" } };
  }
  return {
    ok: true,
    value: { kind: "advanced", stateVersion: nextStateVersion },
  };
}

export function inspectActorActivation(
  sql: ActorActivationSql,
  expected: ActorActivationIdentity,
): ActorActivationInspection {
  const current = readActivation(sql);
  if (current === undefined) {
    return { kind: "missing" };
  }
  const mismatchedFields = activationIdentityMismatches(current, expected);
  if (mismatchedFields.length > 0) {
    return {
      kind: "mismatch",
      reason: "identity",
      schemaVersion: current.schema_version,
      stateVersion: current.state_version,
      mismatchedFields,
    };
  }
  if (current.schema_version !== expected.schemaVersion) {
    return {
      kind: "mismatch",
      reason: "schema",
      schemaVersion: current.schema_version,
      stateVersion: current.state_version,
    };
  }
  return {
    kind: "match",
    schemaVersion: current.schema_version,
    stateVersion: current.state_version,
  };
}

function readActivation(sql: ActorActivationSql): ActivationRow | undefined {
  return sql
    .exec<ActivationRow>(
      `SELECT
       registry_id,
       activation_token,
       organisation_id,
       object_kind,
       logical_object_id,
       physical_object_name,
       placement_kind,
       placement_epoch,
       placement_cell_id,
       location_hint,
       residency_jurisdiction,
       schema_version,
       state_version,
       fence_token,
       activated_at
     FROM state_object_activation
     WHERE singleton = 1`,
    )
    .toArray()[0];
}

function sameActivation(
  row: ActivationRow,
  request: ActorActivationIdentity,
): boolean {
  return (
    activationIdentityMismatches(row, request).length === 0 &&
    row.schema_version === request.schemaVersion
  );
}

function activationIdentityMismatches(
  row: ActivationRow,
  request: ActorActivationIdentity,
): readonly ActorActivationIdentityField[] {
  const mismatchedFields: ActorActivationIdentityField[] = [];
  if (row.registry_id !== request.registryId)
    mismatchedFields.push("registryId");
  if (row.activation_token !== request.activationToken)
    mismatchedFields.push("activationToken");
  if (row.organisation_id !== request.identity.organisationId)
    mismatchedFields.push("organisationId");
  if (row.object_kind !== request.identity.objectKind)
    mismatchedFields.push("objectKind");
  if (row.logical_object_id !== request.identity.logicalObjectId)
    mismatchedFields.push("logicalObjectId");
  if (row.physical_object_name !== request.physicalObjectName)
    mismatchedFields.push("physicalObjectName");
  if (row.placement_kind !== request.placement.kind)
    mismatchedFields.push("placementKind");
  if (row.placement_epoch !== request.placement.placementEpoch)
    mismatchedFields.push("placementEpoch");
  if (row.placement_cell_id !== request.placement.placementCellId)
    mismatchedFields.push("placementCellId");
  if (row.location_hint !== request.placement.locationHint)
    mismatchedFields.push("locationHint");
  if (row.residency_jurisdiction !== residencyJurisdiction(request))
    mismatchedFields.push("residencyJurisdiction");
  if (row.fence_token !== request.fenceToken)
    mismatchedFields.push("fenceToken");
  return mismatchedFields;
}

function residencyJurisdiction(
  request: ActorActivationIdentity,
): string | null {
  return request.placement.kind === "residency"
    ? request.placement.residencyJurisdiction
    : null;
}

function activatedResult(
  request: ActorActivationIdentity,
  stateVersion: number,
): ActorActivationResult {
  return {
    ok: true,
    value: {
      kind: "activated",
      registryId: request.registryId,
      stateVersion,
    },
  };
}
