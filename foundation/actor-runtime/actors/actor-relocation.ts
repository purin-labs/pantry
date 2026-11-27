import {
  prepareAbandonedMoveSourceFreeze,
  prepareAbandonedMoveTargetRelease,
  prepareRecoveryTargetReservation,
  prepareRegionalTargetAbandon,
  prepareSourceAdmissionRestore,
} from "@purin-labs/tenancy/data/shared-rows/placement-row";
import {
  abandonedMoveRecoversSql,
  markRelocationCleaning,
  markRelocationComplete,
  markRelocationCopying,
  markRelocationFrozen,
  markRelocationQuarantined,
  markRelocationRetained,
  placementMoveOpenOfOtherKind,
  prepareRecoveryRelocationStart,
  prepareRelocationAbandon,
  prepareRelocationDataVerified,
  prepareRelocationFreezeRelease,
  prepareRelocationRetentionWaiver,
  prepareRelocationSourceQuiesced,
  prepareRelocationStart,
  type PlacementMoveOpenError,
} from "@purin-labs/tenancy/data/placement-move";
import {
  isMovedRegistryEntry,
  prepareRelocationExclusions,
  readRelocationExclusions,
  warnRelocationExclusions,
  type ActorRelocationExclusion,
} from "./actor-relocation-exclusion";
import type {
  GlobalDatabase,
  OrganisationDatabase,
} from "@purin-labs/kernel/database-handles";
import type { CommerceProviderReceipt } from "@purin-labs/control-api";
import type { RelocationReceiptError } from "./actor-relocation-state";
import {
  regionalCopyTables,
  inspectRegionalCopyCapacity,
  type RegionalCopyCapacityError,
  copyRegionalOrganisationData,
  deleteInactiveRegionalOrganisationData,
  countRegionalOrganisationRows,
} from "../data/organisation-regional-copy";
import {
  provisionRegionalMoveTarget,
  resumeRegionalPlacement,
} from "@purin-labs/tenancy/data/shared-rows/regional-move";
import {
  selectOrganisationPlacementDatabase,
  type OrganisationPlacementBindings,
  type OrganisationExecutionScopeError,
} from "@purin-labs/tenancy/organisation-execution-scope";
import { actorRelocationAdmission } from "./actor-placement-admission";
import {
  beginActorExport,
  copyRetiredActorRegistryEntry,
  retiredActorRecord,
  type RetiredActorRecord,
  listPlacementActorRegistryEntries,
  parseActorRegistryId,
  retireActorRegistryEntry,
  type ActorFenceToken,
  type ActorRegistryEntry,
  type ActorRegistryError,
} from "./actor-registry";
import {
  readPlacementByEpoch,
  ORGANISATION_RELOCATION_PUBLICATION_BUDGET_MS,
  readOrganisationPlacementMove,
  resolveActiveOrganisationPlacement,
  type FrozenOrganisationPlacementMove,
  type PublishedOrganisationPlacementMove,
  type ReservedOrganisationPlacementMove,
  type OrganisationPlacementError,
  type OrganisationPlacementMoveTarget,
  type ActorRelocationId,
} from "@purin-labs/tenancy/data/organisation-placement";
import {
  freezeOrganisationPlacementMove,
  freezeRegionalOrganisationPlacement,
  publishOrganisationPlacementMove,
  reserveOrganisationPlacementMove,
} from "@purin-labs/tenancy/data/shared-rows/placement-row";
import {
  loadActorExport,
  newActorExportId,
  parseActorExportId,
  type ActorExportError,
  type ActorExportId,
  type ActorExportRef,
} from "./actor-export";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import type { Env } from "@purin-labs/kernel/env";
import {
  newRequestId,
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  definitiveActorImportFailure,
  importActorCopyTarget,
  type ActorCopyError,
} from "./actor-copy";
import {
  actorStubForRegistryEntry,
  type ActorNamespaces,
} from "./actor-router";
import { actorStub } from "./actor-stubs";
import { providerWorkReads } from "../data/provider-work-reads";
import { currentActorSchemaVersion } from "./current-actor-schema-version";
import { quiescePlacementExecution } from "./placement-execution-quiescence";
import type { VariantBy } from "@purin-labs/type-utils";
import {
  assertNever,
  isNonEmptyString,
  isNonNegativeInteger,
  isPositiveInteger,
} from "@purin-labs/std";

export const ACTOR_RELOCATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type { ActorRelocationId };

export type RelocationPreflightInventory = {
  readonly checkedAt: number;
  readonly rowCount: number;
  readonly tableCount: number;
  readonly actorBytes: number;
  readonly actorCount: number;
};

type RelocationBase = {
  readonly preflight: RelocationPreflightInventory;
  readonly relocationId: ActorRelocationId;
  readonly organisationId: OrganisationId;
  readonly sourcePlacementEpoch: number;
  readonly targetPlacementEpoch: number;
  readonly createdAt: number;
};

export type ActorRelocation =
  | ((
      | (RelocationBase & {
          readonly status: "reserved";
          readonly resumedAt?: never;
          readonly retainUntil?: never;
          readonly frozenAt?: never;
          readonly publishedAt?: never;
          readonly completedAt?: never;
          readonly quarantinedAt?: never;
          readonly quarantineReason?: never;
        })
      | (RelocationBase & {
          readonly status: "frozen" | "copying";
          readonly resumedAt?: never;
          readonly retainUntil?: never;
          readonly frozenAt: number;
          readonly publishedAt?: never;
          readonly completedAt?: never;
          readonly quarantinedAt?: never;
          readonly quarantineReason?: never;
        })
      | (RelocationBase & {
          readonly status: "published";
          readonly resumedAt?: never;
          readonly retainUntil?: never;
          readonly frozenAt: number;
          readonly publishedAt: number;
          readonly completedAt?: never;
          readonly quarantinedAt?: never;
          readonly quarantineReason?: never;
        })
      | (RelocationBase & {
          readonly status: "retained" | "cleaning";
          readonly frozenAt: number;
          readonly publishedAt: number;
          readonly resumedAt: number;
          readonly retainUntil: number;
          readonly completedAt?: never;
          readonly quarantinedAt?: never;
          readonly quarantineReason?: never;
        })
      | (RelocationBase & {
          readonly status: "complete";
          readonly resumedAt: number;
          readonly retainUntil: number;
          readonly frozenAt: number;
          readonly publishedAt: number;
          readonly completedAt: number;
          readonly quarantinedAt?: never;
          readonly quarantineReason?: never;
        })
      | (RelocationBase & {
          readonly status: "quarantined";
          readonly resumedAt?: never;
          readonly retainUntil?: never;
          readonly frozenAt: number | null;
          readonly publishedAt: number | null;
          readonly completedAt?: never;
          readonly quarantinedAt: number;
          readonly quarantineReason: string;
        })
    ) & { readonly abandonedAt?: never; readonly recoveryRelocationId?: never })
  | (RelocationBase & {
      readonly status: "abandoned";
      readonly frozenAt: number;
      readonly abandonedAt: number;
      readonly recoveryRelocationId: ActorRelocationId;
      readonly publishedAt?: never;
      readonly resumedAt?: never;
      readonly retainUntil?: never;
      readonly completedAt?: never;
      readonly quarantinedAt?: never;
      readonly quarantineReason?: never;
    });

type LiveActorRelocation = Exclude<
  ActorRelocation,
  {
    readonly status:
      "retained" | "cleaning" | "complete" | "quarantined" | "abandoned";
  }
>;

type OrganisationPlacementMove =
  | ReservedOrganisationPlacementMove
  | FrozenOrganisationPlacementMove
  | PublishedOrganisationPlacementMove;

type RelocationItemBase = {
  readonly objectKind: ActorRegistryEntry["identity"]["objectKind"];
  readonly logicalObjectId: string;
  readonly sourceRegistryId: ActorRegistryEntry["registryId"];
  readonly exportId: ActorExportId;
  readonly updatedAt: number;
};

type RelocationExportedItem = RelocationItemBase & {
  readonly exportRef: ActorExportRef;
};

export type RetainedActorRelocationExport = {
  readonly identity: ActorRegistryEntry["identity"];
  readonly sourceSchemaVersion: number;
  readonly sourceStateVersion: number;
  readonly exportRef: ActorExportRef;
};

type ActorRelocationItem =
  | (RelocationItemBase & {
      readonly status: "pending";
      readonly targetRegistryId?: never;
      readonly exportRef?: never;
    })
  | (RelocationExportedItem & {
      readonly status: "exported";
      readonly targetRegistryId?: never;
    })
  | (RelocationExportedItem & {
      readonly status: "imported" | "retired";
      readonly targetRegistryId: ActorRegistryEntry["registryId"];
    });

type RegistryLifecycleSummaryBase = {
  readonly registryId: ActorRegistryEntry["registryId"];
  readonly objectKind: ActorRegistryEntry["identity"]["objectKind"];
  readonly logicalObjectId: string;
  readonly placementEpoch: number;
  readonly schemaVersion: number;
  readonly stateVersion: number;
};

type RegistryLifecycleSummary =
  | (RegistryLifecycleSummaryBase & {
      readonly lifecycleStatus: "reserved";
      readonly activatedAt: null;
      readonly exportingAt: null;
      readonly retiredAt: null;
    })
  | (RegistryLifecycleSummaryBase & {
      readonly lifecycleStatus: "active";
      readonly activatedAt: number;
      readonly exportingAt: null;
      readonly retiredAt: null;
    })
  | (RegistryLifecycleSummaryBase & {
      readonly lifecycleStatus: "exporting";
      readonly activatedAt: number;
      readonly exportingAt: number;
      readonly retiredAt: null;
    })
  | (RegistryLifecycleSummaryBase & {
      readonly lifecycleStatus: "retired";
      readonly activatedAt: number;
      readonly exportingAt: number;
      readonly retiredAt: number;
    })
  | (RegistryLifecycleSummaryBase & {
      readonly lifecycleStatus: "quarantined";
      readonly activatedAt: number | null;
      readonly exportingAt: number | null;
      readonly retiredAt: null;
    });

type RelocationInspectionItemBase = {
  readonly objectKind: ActorRelocationItem["objectKind"];
  readonly logicalObjectId: string;
  readonly exportId: ActorExportId;
  readonly source: RegistryLifecycleSummary;
  readonly updatedAt: number;
};

type ActorRelocationInspectionItem =
  | (RelocationInspectionItemBase & {
      readonly status: "pending" | "exported";
      readonly target: null;
    })
  | (RelocationInspectionItemBase & {
      readonly status: "imported" | "retired";
      readonly target: RegistryLifecycleSummary;
    });

type ActorRelocationInspection = {
  readonly relocation: ActorRelocation;
  readonly items: readonly ActorRelocationInspectionItem[];
  /** The operator receipts of the quarantined Actors that the move left out. */
  readonly exclusions: readonly ActorRelocationExclusion[];
};

export type ActorRelocationError =
  | RegionalCopyCapacityError
  | RelocationReceiptError
  | OrganisationExecutionScopeError
  | OrganisationPlacementError
  | ActorRegistryError
  | ActorExportError
  | ActorCopyError
  | PlacementMoveOpenError
  | { readonly code: "relocation_missing" }
  | { readonly code: "relocation_corrupt" }
  | { readonly code: "relocation_conflict" }
  | { readonly code: "relocation_quarantined"; readonly reason: string }
  | { readonly code: "relocation_inventory_changed" }
  | {
      readonly code: "relocation_provider_work_unresolved";
      readonly operationId: string;
    };

type RelocationRow = {
  preflightAt: unknown;
  preflightRowCount: unknown;
  preflightTableCount: unknown;
  preflightActorBytes: unknown;
  preflightActorCount: unknown;
  relocationId: unknown;
  organisationId: unknown;
  sourcePlacementEpoch: unknown;
  targetPlacementEpoch: unknown;
  status: unknown;
  createdAt: unknown;
  frozenAt: unknown;
  publishedAt: unknown;
  resumedAt: unknown;
  retainUntil: unknown;
  completedAt: unknown;
  abandonedAt: unknown;
  recoveryRelocationId: unknown;
  quarantinedAt: unknown;
  quarantineReason: unknown;
};

type RelocationItemRow = {
  objectKind: unknown;
  logicalObjectId: unknown;
  sourceRegistryId: unknown;
  targetRegistryId: unknown;
  exportId: unknown;
  exportKey: unknown;
  exportOrganisationId: unknown;
  exportPayloadDigestB64: unknown;
  exportCreatedAt: unknown;
  status: unknown;
  updatedAt: unknown;
};

/**
 * The RPC method of the Organisation Actor that settles an observed provider
 * receipt before a frozen relocation copies its state. The class of the
 * Worker implements it.
 */
export interface RelocationReceiptOrganisationRpc
  extends Rpc.DurableObjectBranded {
  reconcileRelocationReceipt(
    input: Readonly<{
      relocationId: ActorRelocationId;
      expectedFenceToken: ActorFenceToken;
      receipt: CommerceProviderReceipt;
      now: number;
    }>,
  ): Promise<Result<null, RelocationReceiptError>>;
}

/**
 * The RPC method of the Session Actor that settles its Code Mode work before
 * a frozen relocation copies its state. The Session class implements it.
 */
export interface RelocationSettlementSessionRpc
  extends Rpc.DurableObjectBranded {
  reconcileRelocationSettlements(
    input: Readonly<{
      relocationId: ActorRelocationId;
      expectedFenceToken: ActorFenceToken;
      now: number;
    }>,
  ): Promise<
    Result<
      null,
      | RelocationReceiptError
      | {
          readonly code: "relocation_provider_work_unresolved";
          readonly operationId: string;
        }
    >
  >;
}

export type RelocationBindings = OrganisationPlacementBindings &
  Pick<
    Env,
    | "DB"
    | "ORGANISATION"
    | "SESSION"
    | "CASE"
    | "CONNECTOR"
    | "ARCHIVE"
    | "DATA_ENCRYPTION_ROOT"
  >;

export async function startActorRelocation(input: {
  readonly env: RelocationBindings;
  readonly organisationId: OrganisationId;
  readonly target: OrganisationPlacementMoveTarget;
  readonly now: number;
}): Promise<Result<ActorRelocation, ActorRelocationError>> {
  // One open move for each Organisation: a restore holds the placement.
  const openRestore = await placementMoveOpenOfOtherKind(
    input.env.DB,
    input.organisationId,
    "relocation",
  );
  if (openRestore !== null) return { ok: false, error: openRestore };
  // A previous source remains a recovery point until its cleanup completes.
  // Reject reuse before reserving or freezing the current placement.
  if (
    await hasRetainedSourceData(
      input.env.DB,
      input.organisationId,
      input.target.placementCellId,
    )
  )
    return { ok: false, error: { code: "relocation_conflict" } };

  const move = await reserveOrganisationPlacementMove({
    db: input.env.DB,
    organisationId: input.organisationId,
    target: input.target,
    now: input.now,
  });

  if (!move.ok) {
    return move;
  }

  const inventoryDatabase = await resolveRelocationDatabase({
    env: input.env,
    organisationId: input.organisationId,
    placementEpoch: move.value.source.placement.placementEpoch,
  });
  if (!inventoryDatabase.ok) return inventoryDatabase;
  const inventory = await listPlacementActorRegistryEntries({
    db: inventoryDatabase.value,
    organisationId: input.organisationId,
    placementEpoch: move.value.source.placement.placementEpoch,
  });

  if (!inventory.ok) {
    return inventory;
  }

  for (const entry of inventory.value) {
    // A retired entry is copied as a tombstone; a quarantined one stays out.
    if (!isMovedRegistryEntry(entry)) continue;
    if (entry.lifecycleStatus !== "active") {
      return { ok: false, error: { code: "relocation_inventory_changed" } };
    }
    if (!targetSupportsActorSchema(entry)) {
      return { ok: false, error: { code: "target_schema_older_than_export" } };
    }
  }

  const targetDatabase = selectOrganisationPlacementDatabase(
    input.env,
    input.organisationId,
    move.value.target.placement,
  );
  if (!targetDatabase.ok) return targetDatabase;
  const tables =
    inventoryDatabase.value === targetDatabase.value
      ? []
      : await regionalCopyTables(targetDatabase.value, inventoryDatabase.value);
  const capacity = await inspectRegionalCopyCapacity(
    inventoryDatabase.value,
    targetDatabase.value,
  );
  if (!capacity.ok) return capacity;
  traceLog("organisation.relocation_capacity_preflight", {
    requestId: newRequestId(),
    organisation_id: input.organisationId,
    source_database_bytes: capacity.value.sourceDatabaseBytes,
    target_database_bytes: capacity.value.targetDatabaseBytes,
    limit_bytes: capacity.value.limitBytes,
  });
  const rowCount = await countRegionalOrganisationRows(
    inventoryDatabase.value,
    input.organisationId,
    tables,
  );
  const actors = await inspectRelocationActors(
    input.env,
    inventory.value,
    "preflight",
  );
  if (!actors.ok) return actors;
  const pendingProvider = await providerWorkReads
    .use()
    .pendingOperation(inventoryDatabase.value, input.organisationId);
  if (pendingProvider !== null)
    return {
      ok: false,
      error: {
        code: "relocation_provider_work_unresolved",
        operationId: pendingProvider.operationId,
      },
    };

  const relocationId = newActorRelocationId();

  await prepareRelocationStart(input.env.DB, {
    relocationId,
    organisationId: input.organisationId,
    sourcePlacementEpoch: move.value.source.placement.placementEpoch,
    targetPlacementEpoch: move.value.target.placement.placementEpoch,
    now: input.now,
    rowCount,
    tableCount: tables.length,
    actorBytes: actors.value,
    actorCount: inventory.value.filter(isMovedRegistryEntry).length,
  }).run();

  const operation = await readRelocationByPlacement(
    input.env.DB,
    input.organisationId,
    move.value.source.placement.placementEpoch,
    move.value.target.placement.placementEpoch,
  );

  if (!operation.ok) {
    // A restore that started since the check above holds the placement.
    const open = await placementMoveOpenOfOtherKind(
      input.env.DB,
      input.organisationId,
      "relocation",
    );
    return open === null ? operation : { ok: false, error: open };
  }

  const recorded = await recordRelocationInventory(
    input.env.DB,
    operation.value.relocationId,
    inventory.value,
    input.now,
  );
  if (!recorded.ok) return recorded;
  warnRelocationExclusions(
    input.organisationId,
    operation.value.relocationId,
    inventory.value,
  );
  return operation;
}

async function hasRetainedSourceData(
  directory: GlobalDatabase,
  organisationId: OrganisationId,
  placementCellId: string,
): Promise<boolean> {
  const retained = await directory
    .prepare(
      `SELECT 1 FROM state_object_relocation operation
       JOIN organisation_placement source ON source.organisation_id = operation.organisation_id
         AND source.placement_epoch = operation.source_placement_epoch
       WHERE operation.organisation_id = ? AND source.placement_cell_id = ?
         AND operation.status IN ('retained', 'cleaning') LIMIT 1`,
    )
    .bind(organisationId, placementCellId)
    .first();
  return retained !== null;
}

/** Freeze admission before the final inventory. Keep existing export identities on retry. */
async function recordRelocationInventory(
  directory: GlobalDatabase,
  relocationId: ActorRelocationId,
  entries: readonly ActorRegistryEntry[],
  now: number,
): Promise<Result<null, ActorRelocationError>> {
  const statements: D1PreparedStatement[] = [];
  const executable = entries.filter(isMovedRegistryEntry);
  for (const entry of executable) {
    if (
      entry.lifecycleStatus !== "active" &&
      entry.lifecycleStatus !== "exporting"
    )
      return { ok: false, error: { code: "relocation_inventory_changed" } };
    if (!targetSupportsActorSchema(entry))
      return { ok: false, error: { code: "target_schema_older_than_export" } };
    statements.push(
      directory
        .prepare(
          `INSERT OR IGNORE INTO state_object_relocation_item (
          relocation_id, object_kind, logical_object_id, source_registry_id,
          export_id, status, updated_at
        ) SELECT ?, ?, ?, ?, ?, 'pending', ?
        WHERE EXISTS (SELECT 1 FROM state_object_relocation
          WHERE relocation_id = ? AND status IN ('reserved', 'frozen')
            AND source_quiesced_at IS NULL)`,
        )
        .bind(
          relocationId,
          entry.identity.objectKind,
          entry.identity.logicalObjectId,
          entry.registryId,
          newActorExportId(),
          now,
          relocationId,
        ),
    );
  }
  statements.push(
    ...prepareRelocationExclusions(directory, relocationId, entries, now),
  );
  if (statements.length > 0) await directory.batch(statements);
  const items = await readRelocationItems(directory, relocationId);
  if (!items.ok) return items;
  if (items.value.length !== executable.length)
    return { ok: false, error: { code: "relocation_inventory_changed" } };
  for (const item of items.value) {
    if (matchingSourceEntry(entries, item) === null)
      return { ok: false, error: { code: "relocation_inventory_changed" } };
  }
  return { ok: true, value: null };
}

export async function reconcileActorRelocationReceipt(input: {
  readonly env: RelocationBindings;
  readonly relocationId: ActorRelocationId;
  readonly receipt: CommerceProviderReceipt;
  readonly now: number;
}): Promise<Result<null, ActorRelocationError>> {
  const source = await resolveFrozenReceiptActors(
    input.env,
    input.relocationId,
  );
  if (!source.ok) return source;
  for (const entry of source.value.entries) {
    if (entry.identity.objectKind !== "organisation") continue;
    const organisation = actorStub<RelocationReceiptOrganisationRpc>(
      input.env.ORGANISATION,
      entry.physicalObjectName,
      entry.placement,
    );
    return organisation.reconcileRelocationReceipt({
      relocationId: source.value.relocationId,
      expectedFenceToken: entry.fenceToken,
      receipt: input.receipt,
      now: input.now,
    });
  }
  return { ok: false, error: { code: "relocation_receipt_rejected" } };
}

/** The Actors of a frozen relocation that may settle a receipt. */
export async function resolveFrozenReceiptActors(
  env: RelocationBindings,
  relocationId: ActorRelocationId,
): Promise<
  Result<
    {
      readonly relocationId: ActorRelocationId;
      readonly entries: readonly ActorRegistryEntry[];
    },
    ActorRelocationError
  >
> {
  const operation = await readRelocationById(env.DB, relocationId);
  if (!operation.ok) return operation;
  if (operation.value.status === "abandoned")
    return resolveFrozenReceiptActors(
      env,
      operation.value.recoveryRelocationId,
    );
  if (operation.value.status !== "frozen")
    return { ok: false, error: { code: "relocation_receipt_rejected" } };
  const database = await resolveRelocationDatabase({
    env,
    organisationId: operation.value.organisationId,
    placementEpoch: operation.value.sourcePlacementEpoch,
  });
  if (!database.ok) return database;
  const entries = await listPlacementActorRegistryEntries({
    db: database.value,
    organisationId: operation.value.organisationId,
    placementEpoch: operation.value.sourcePlacementEpoch,
  });
  if (!entries.ok) return entries;
  return { ok: true, value: { relocationId, entries: entries.value } };
}

/** Recover through new Actors in the source cell. Never reopen a frozen source epoch. */
export async function abandonActorRelocation(input: {
  readonly env: RelocationBindings;
  readonly relocationId: ActorRelocationId;
  readonly now: number;
}): Promise<Result<ActorRelocation, ActorRelocationError>> {
  const current = await readRelocationById(input.env.DB, input.relocationId);
  if (!current.ok) return current;
  if (current.value.status === "abandoned")
    return resumeAbandonedRelocation(input, current.value);
  const recoveryId = newActorRelocationId();
  const recoveryFence = `tpf_${crypto.randomUUID()}`;
  const db = input.env.DB;
  const abandonment = {
    kind: "relocation",
    operationId: input.relocationId,
    recoveryId,
    now: input.now,
  } as const;
  await db.batch([
    prepareRelocationAbandon(db, {
      relocationId: input.relocationId,
      recoveryId,
      now: input.now,
    }),
    prepareAbandonedMoveSourceFreeze(db, abandonment),
    prepareAbandonedMoveTargetRelease(db, abandonment),
    prepareRecoveryTargetReservation(db, { ...abandonment, recoveryFence }),
    prepareRecoveryRelocationStart(db, { ...abandonment, recoveryFence }),
  ]);
  const abandoned = await readRelocationById(db, input.relocationId);
  if (!abandoned.ok) return abandoned;
  if (abandoned.value.status !== "abandoned")
    return { ok: false, error: { code: "relocation_conflict" } };
  return resumeAbandonedRelocation(input, abandoned.value);
}

async function resumeAbandonedRelocation(
  input: { readonly env: RelocationBindings; readonly now: number },
  operation: VariantBy<ActorRelocation, "status", "abandoned">,
): Promise<Result<ActorRelocation, ActorRelocationError>> {
  const database = await resolveRelocationDatabase({
    env: input.env,
    organisationId: operation.organisationId,
    placementEpoch: operation.targetPlacementEpoch,
  });
  if (!database.ok) return database;
  await prepareRegionalTargetAbandon(database.value, {
    organisationId: operation.organisationId,
    placementEpoch: operation.targetPlacementEpoch,
    abandonedAt: operation.abandonedAt,
  }).run();
  const source = await resolveRelocationDatabase({
    env: input.env,
    organisationId: operation.organisationId,
    placementEpoch: operation.sourcePlacementEpoch,
  });
  if (!source.ok) return source;
  if (source.value !== database.value) {
    const abandoned = await readPlacementByEpoch(
      database.value,
      operation.organisationId,
      operation.targetPlacementEpoch,
    );
    if (abandoned.ok && abandoned.value.status === "abandoned") {
      const inUse = await database.value
        .prepare(
          `SELECT 1 FROM organisation_placement
        WHERE organisation_id = ? AND status IN ('active', 'frozen', 'reserved')`,
        )
        .bind(operation.organisationId)
        .first();
      const retained = await hasRetainedSourceData(
        input.env.DB,
        operation.organisationId,
        abandoned.value.placement.placementCellId,
      );
      if (inUse === null && !retained)
        await deleteInactiveRegionalOrganisationData({
          database: database.value,
          organisationId: operation.organisationId,
          placementEpoch: operation.targetPlacementEpoch,
          placementFenceToken: abandoned.value.fenceToken,
          inactiveStatus: "abandoned",
        });
    } else if (
      !abandoned.ok &&
      abandoned.error.code !== "organisation_placement_missing"
    )
      return abandoned;
  }
  return resumeActorRelocation({
    env: input.env,
    relocationId: operation.recoveryRelocationId,
    now: input.now,
  });
}

async function relocationPublicationExpired(
  directory: GlobalDatabase,
  operation: LiveActorRelocation,
  now: number,
): Promise<boolean> {
  if (operation.status !== "frozen" && operation.status !== "copying")
    return false;
  if (now < operation.frozenAt + ORGANISATION_RELOCATION_PUBLICATION_BUDGET_MS)
    return false;
  // A recovery of an abandoned move, of either kind, has no budget: its
  // source froze long ago, and it is the way back to an active placement.
  const recovery = await directory
    .prepare(`SELECT ${abandonedMoveRecoversSql("?")} AS recovers`)
    .bind(operation.relocationId, operation.relocationId)
    .first<{ recovers: number }>();
  return recovery?.recovers !== 1;
}

/** Explicit administrator consent to discard the retained recovery copy. */
export async function waiveActorRelocationRetention(input: {
  readonly env: RelocationBindings;
  readonly relocationId: ActorRelocationId;
  readonly now: number;
}): Promise<Result<ActorRelocation, ActorRelocationError>> {
  const operation = await readRelocationById(input.env.DB, input.relocationId);
  if (!operation.ok) return operation;
  switch (operation.value.status) {
    case "retained":
    case "cleaning":
      await prepareRelocationRetentionWaiver(input.env.DB, {
        now: input.now,
        relocationId: input.relocationId,
      }).run();
      return readRelocationById(input.env.DB, input.relocationId);
    case "complete":
      return operation;
    case "reserved":
    case "frozen":
    case "copying":
    case "published":
    case "quarantined":
    case "abandoned":
      return { ok: false, error: { code: "relocation_conflict" } };
    default:
      return assertNever(operation.value);
  }
}

export async function resumeActorRelocation(input: {
  readonly env: RelocationBindings;
  readonly relocationId: ActorRelocationId;
  readonly now: number;
}): Promise<Result<ActorRelocation, ActorRelocationError>> {
  const resumeStartedAt = Date.now();
  const operationResult = await readRelocationById(
    input.env.DB,
    input.relocationId,
  );

  if (!operationResult.ok) {
    return operationResult;
  }

  if (operationResult.value.status === "abandoned") {
    return resumeAbandonedRelocation(input, operationResult.value);
  }
  if (isRetainedRelocation(operationResult.value)) {
    return cleanupRetainedRelocation(input, operationResult.value);
  }
  if (operationResult.value.status === "complete") {
    return operationResult;
  }

  if (operationResult.value.status === "quarantined") {
    return {
      ok: false,
      error: {
        code: "relocation_quarantined",
        reason: operationResult.value.quarantineReason,
      },
    };
  }

  let operation: LiveActorRelocation = operationResult.value;
  if (await relocationPublicationExpired(input.env.DB, operation, input.now))
    return abandonActorRelocation(input);

  const moveResult = await readOrganisationPlacementMove({
    db: input.env.DB,
    organisationId: operation.organisationId,
    sourcePlacementEpoch: operation.sourcePlacementEpoch,
    targetPlacementEpoch: operation.targetPlacementEpoch,
  });

  if (!moveResult.ok) {
    return moveResult;
  }

  let move: OrganisationPlacementMove = moveResult.value;

  const sourceDatabase = selectOrganisationPlacementDatabase(
    input.env,
    move.organisationId,
    move.source.placement,
  );
  if (!sourceDatabase.ok) return sourceDatabase;
  const targetDatabase = selectOrganisationPlacementDatabase(
    input.env,
    move.organisationId,
    move.target.placement,
  );
  if (!targetDatabase.ok) return targetDatabase;
  const copyTables =
    sourceDatabase.value === targetDatabase.value
      ? []
      : await regionalCopyTables(targetDatabase.value, sourceDatabase.value);

  if (isReservedPlacementMove(move)) {
    const frozen = await freezeOrganisationPlacementMove(
      input.env.DB,
      move,
      { kind: "relocation", operationId: operation.relocationId },
      input.now,
      sourceDatabase.value,
    );

    if (!frozen.ok) {
      return frozen;
    }

    move = frozen.value;
    await markRelocationFrozen(input.env.DB, operation.relocationId, input.now);
    const refreshed = await readLiveRelocationById(
      input.env.DB,
      input.relocationId,
    );

    if (!refreshed.ok) {
      return refreshed;
    }

    operation = refreshed.value;
  }

  if (isFrozenPlacementMove(move) && operation.status === "reserved") {
    await markRelocationFrozen(input.env.DB, operation.relocationId, input.now);
    const refreshed = await readLiveRelocationById(
      input.env.DB,
      input.relocationId,
    );

    if (!refreshed.ok) {
      return refreshed;
    }

    operation = refreshed.value;
  }

  if (isFrozenPlacementMove(move)) {
    const sourceFrozen = await freezeRegionalOrganisationPlacement(
      sourceDatabase.value,
      move,
    );
    if (!sourceFrozen.ok) {
      await restoreAdmissionBeforeRegionalFreeze(
        input.env.DB,
        sourceDatabase.value,
        move,
        operation.relocationId,
      );
      return sourceFrozen;
    }
    const quiescent = await quiescePlacementExecution(
      sourceDatabase.value,
      {
        organisation: input.env.ORGANISATION,
        session: input.env.SESSION,
        case: input.env.CASE,
        connector: input.env.CONNECTOR,
      },
      move,
    );
    if (!quiescent.ok) return quiescent;
    const entries = await listPlacementActorRegistryEntries({
      db: sourceDatabase.value,
      organisationId: operation.organisationId,
      placementEpoch: operation.sourcePlacementEpoch,
    });
    if (!entries.ok) return entries;
    for (const entry of entries.value) {
      if (
        !isMovedRegistryEntry(entry) ||
        entry.identity.objectKind !== "session"
      )
        continue;
      const session = actorStub<RelocationSettlementSessionRpc>(
        input.env.SESSION,
        entry.physicalObjectName,
        entry.placement,
      );
      const reconciled = await session.reconcileRelocationSettlements({
        relocationId: operation.relocationId,
        expectedFenceToken: entry.fenceToken,
        now: input.now,
      });
      if (!reconciled.ok) return reconciled;
    }
    const settled = await inspectRelocationActors(
      input.env,
      entries.value,
      "quiescent",
    );
    if (!settled.ok) return settled;
    const recorded = await recordRelocationInventory(
      input.env.DB,
      operation.relocationId,
      entries.value,
      input.now,
    );
    if (!recorded.ok) return recorded;
    await prepareRelocationSourceQuiesced(input.env.DB, {
      now: input.now,
      relocationId: operation.relocationId,
    }).run();
    const provisioned = await provisionRegionalMoveTarget({
      sourceDatabase: sourceDatabase.value,
      targetDatabase: targetDatabase.value,
      move,
    });
    if (!provisioned.ok) return provisioned;
    for (const entry of entries.value) {
      if (entry.lifecycleStatus !== "retired") continue;
      const copiedRetirement = await copyRetiredActorRegistryEntry({
        db: targetDatabase.value,
        source: entry,
        admission: actorRelocationAdmission(
          move,
          operation.relocationId,
          entry.identity,
        ),
      });
      if (!copiedRetirement.ok) return copiedRetirement;
    }
    if (sourceDatabase.value !== targetDatabase.value) {
      try {
        await copyRegionalOrganisationData(
          {
            directory: input.env.DB,
            source: sourceDatabase.value,
            target: targetDatabase.value,
            relocationId: operation.relocationId,
            move,
            now: input.now + Date.now() - resumeStartedAt,
          },
          copyTables,
        );
      } catch (error) {
        const now = input.now + Date.now() - resumeStartedAt;
        if (await relocationPublicationExpired(input.env.DB, operation, now))
          return abandonActorRelocation({
            env: input.env,
            relocationId: operation.relocationId,
            now,
          });
        throw error;
      }
    }
    const copied = await copyRelocationObjects({
      env: input.env,
      operation,
      move,
      now: input.now + Date.now() - resumeStartedAt,
    });

    if (!copied.ok) {
      const now = input.now + Date.now() - resumeStartedAt;
      if (await relocationPublicationExpired(input.env.DB, operation, now))
        return abandonActorRelocation({
          env: input.env,
          relocationId: operation.relocationId,
          now,
        });
      return copied;
    }

    await prepareRelocationDataVerified(input.env.DB, {
      now: input.now,
      tableCount: copyTables.length,
      relocationId: operation.relocationId,
    }).run();

    const publicationNow = input.now + Date.now() - resumeStartedAt;
    if (
      await relocationPublicationExpired(
        input.env.DB,
        operation,
        publicationNow,
      )
    )
      return abandonActorRelocation({
        env: input.env,
        relocationId: operation.relocationId,
        now: publicationNow,
      });
    const published = await publishOrganisationPlacementMove(
      input.env.DB,
      move,
      { kind: "relocation", operationId: operation.relocationId },
      publicationNow,
    );

    if (!published.ok) {
      return published;
    }

    move = published.value;
  }

  if (!isPublishedPlacementMove(move)) {
    return { ok: false, error: { code: "relocation_conflict" } };
  }

  if (operation.status !== "published") {
    const refreshed = await readLiveRelocationById(
      input.env.DB,
      input.relocationId,
    );

    if (!refreshed.ok) {
      return refreshed;
    }

    operation = refreshed.value;
  }

  if (operation.status !== "published") {
    return { ok: false, error: { code: "relocation_conflict" } };
  }

  const resumed = await resumeRegionalPlacement({
    sourceDatabase: sourceDatabase.value,
    targetDatabase: targetDatabase.value,
    move,
  });
  if (!resumed.ok) return resumed;
  const retired = await retireRelocationSources({
    env: input.env,
    operation,
    move,
    now: input.now,
  });

  if (!retired.ok) {
    return retired;
  }

  const resumedAt = input.now + Date.now() - resumeStartedAt;
  const unavailableMs = resumedAt - move.source.frozenAt;
  if (unavailableMs > 10 * 60 * 1_000)
    traceWarn("organisation.relocation_maintenance_overrun", {
      requestId: newRequestId(),
      organisation_id: operation.organisationId,
      relocation_id: operation.relocationId,
      unavailable_ms: unavailableMs,
      budget_ms: 10 * 60 * 1_000,
    });
  await markRelocationRetained(input.env.DB, {
    relocationId: operation.relocationId,
    resumedAt,
    retainUntil: resumedAt + ACTOR_RELOCATION_RETENTION_MS,
  });

  return readRelocationById(input.env.DB, input.relocationId);
}

async function inspectRelocationActors(
  env: RelocationBindings,
  entries: readonly ActorRegistryEntry[],
  stage: "preflight" | "quiescent",
): Promise<Result<number, ActorRelocationError>> {
  let bytes = 0;
  for (const entry of entries) {
    if (!isMovedRegistryEntry(entry)) continue;
    const actor = actorStubForRegistryEntry({
      namespaces: {
        organisation: env.ORGANISATION,
        session: env.SESSION,
        case: env.CASE,
        connector: env.CONNECTOR,
      },
      entry,
    });
    const ready = await actor.inspectRelocationReadiness({
      expectedFenceToken: entry.fenceToken,
      stage,
    });
    if (!ready.ok) return ready;
    if (ready.value.kind === "blocked")
      return {
        ok: false,
        error: {
          code: "relocation_provider_work_unresolved",
          operationId: ready.value.unresolvedOperationId,
        },
      };
    bytes += ready.value.storedBytes;
  }
  return { ok: true, value: bytes };
}

function isRetainedRelocation(
  operation: ActorRelocation,
): operation is VariantBy<ActorRelocation, "status", "retained" | "cleaning"> {
  return operation.status === "retained" || operation.status === "cleaning";
}

async function cleanupRetainedRelocation(
  input: {
    readonly env: RelocationBindings;
    readonly relocationId: ActorRelocationId;
    readonly now: number;
  },
  operation: VariantBy<ActorRelocation, "status", "retained" | "cleaning">,
): Promise<Result<ActorRelocation, ActorRelocationError>> {
  if (input.now < operation.retainUntil) {
    const waiver = await input.env.DB.prepare(
      "SELECT 1 FROM state_object_relocation WHERE relocation_id = ? AND retention_waived_at IS NOT NULL",
    )
      .bind(operation.relocationId)
      .first();
    if (waiver === null) return { ok: true, value: operation };
  }
  // The source is retired. The target is active, or a later move (a restore,
  // or the recovery of an abandoned one) retired it; either way the source
  // copy is no longer the Organisation's data.
  const sourcePlacement = await readPlacementByEpoch(
    input.env.DB,
    operation.organisationId,
    operation.sourcePlacementEpoch,
  );
  if (!sourcePlacement.ok) return sourcePlacement;
  const targetPlacement = await readPlacementByEpoch(
    input.env.DB,
    operation.organisationId,
    operation.targetPlacementEpoch,
  );
  if (!targetPlacement.ok) return targetPlacement;
  if (
    sourcePlacement.value.status !== "retired" ||
    (targetPlacement.value.status !== "active" &&
      targetPlacement.value.status !== "retired")
  )
    return { ok: false, error: { code: "relocation_conflict" } };
  const source = selectOrganisationPlacementDatabase(
    input.env,
    operation.organisationId,
    sourcePlacement.value.placement,
  );
  if (!source.ok) return source;
  const activePlacement = await resolveActiveOrganisationPlacement(
    input.env.DB,
    operation.organisationId,
  );
  // With no active placement, an open move owns the Organisation; wait.
  if (!activePlacement.ok) return { ok: true, value: operation };
  const active = selectOrganisationPlacementDatabase(
    input.env,
    operation.organisationId,
    activePlacement.value,
  );
  if (!active.ok) return active;
  // Provider work that ended, done or left to a person, holds nothing.
  const unresolved = await providerWorkReads
    .use()
    .unresolved(active.value, operation.organisationId);
  if (unresolved) return { ok: true, value: operation };
  await markRelocationCleaning(input.env.DB, operation.relocationId, input.now);
  const current = await readRelocationById(
    input.env.DB,
    operation.relocationId,
  );
  if (!current.ok) return current;
  if (current.value.status !== "cleaning") return current;
  const sources = await listPlacementActorRegistryEntries({
    db: source.value,
    organisationId: operation.organisationId,
    placementEpoch: operation.sourcePlacementEpoch,
  });
  if (!sources.ok) return sources;
  const items = await readRelocationItems(input.env.DB, operation.relocationId);
  if (!items.ok) return items;
  const sourceById = indexRegistryEntries(sources.value);
  for (const item of items.value) {
    const entry = sourceById.get(item.sourceRegistryId);
    if (item.status !== "retired" || entry?.lifecycleStatus !== "retired")
      return { ok: false, error: { code: "relocation_inventory_changed" } };
    const pending = await input.env.DB.prepare(
      `SELECT 1 FROM state_object_relocation_item
      WHERE relocation_id = ? AND source_registry_id = ? AND source_cleaned_at IS NULL`,
    )
      .bind(operation.relocationId, item.sourceRegistryId)
      .first();
    if (pending === null) continue;
    const actor = actorStubForRegistryEntry({
      namespaces: {
        organisation: input.env.ORGANISATION,
        session: input.env.SESSION,
        case: input.env.CASE,
        connector: input.env.CONNECTOR,
      },
      entry,
    });
    const archive = await loadActorExport({
      bucket: input.env.ARCHIVE,
      root: input.env.DATA_ENCRYPTION_ROOT,
      ref: item.exportRef,
    });
    if (!archive.ok && archive.error.code !== "export_missing") return archive;
    const erased = await actor.eraseInactivePlacementState({
      kind: "retired_source",
      relocationId: operation.relocationId,
      expectedFenceToken: entry.fenceToken,
    });
    if (!erased.ok) return erased;
    if (archive.ok) {
      for (const object of archive.value.payload.r2)
        await input.env.ARCHIVE.delete(object.archiveKey);
      await input.env.ARCHIVE.delete(item.exportRef.key);
    }
    await input.env.DB.prepare(
      `UPDATE state_object_relocation_item SET source_cleaned_at = ?
      WHERE relocation_id = ? AND source_registry_id = ? AND status = 'retired'`,
    )
      .bind(input.now, operation.relocationId, item.sourceRegistryId)
      .run();
  }
  const abandoned = await cleanupAbandonedRelocationArtifacts(
    input.env,
    operation,
  );
  if (!abandoned.ok) return abandoned;
  if (source.value !== active.value) {
    await deleteInactiveRegionalOrganisationData({
      database: source.value,
      organisationId: operation.organisationId,
      placementEpoch: operation.sourcePlacementEpoch,
      inactiveStatus: "retired",
      placementFenceToken: sourcePlacement.value.fenceToken,
    });
  }
  await markRelocationComplete(input.env.DB, operation.relocationId, input.now);
  return readRelocationById(input.env.DB, operation.relocationId);
}

async function cleanupAbandonedRelocationArtifacts(
  env: RelocationBindings,
  recovery: VariantBy<ActorRelocation, "status", "retained" | "cleaning">,
): Promise<Result<null, ActorRelocationError>> {
  const rows = await env.DB.prepare(
    `WITH RECURSIVE abandoned_operations(relocation_id) AS (
      SELECT relocation_id FROM state_object_relocation WHERE status = 'abandoned' AND recovery_relocation_id = ?
      UNION SELECT operation.relocation_id FROM state_object_relocation operation
        JOIN abandoned_operations successor ON operation.recovery_relocation_id = successor.relocation_id
        WHERE operation.status = 'abandoned'
    ) ${relocationSelect()} WHERE relocation_id IN (SELECT relocation_id FROM abandoned_operations)`,
  )
    .bind(recovery.relocationId)
    .all<RelocationRow>();
  for (const raw of rows.results) {
    const operation = parseRelocationRow(raw);
    if (!operation.ok) return operation;
    const database = await resolveRelocationDatabase({
      env,
      organisationId: recovery.organisationId,
      placementEpoch: operation.value.targetPlacementEpoch,
    });
    if (!database.ok) return database;
    const actors = await listPlacementActorRegistryEntries({
      db: database.value,
      organisationId: recovery.organisationId,
      placementEpoch: operation.value.targetPlacementEpoch,
    });
    if (!actors.ok) return actors;
    for (const entry of actors.value) {
      const actor = actorStubForRegistryEntry({
        namespaces: relocationNamespaces(env),
        entry,
      });
      const erased = await actor.eraseInactivePlacementState({
        kind: "abandoned_target",
        relocationId: operation.value.relocationId,
        expectedFenceToken: entry.fenceToken,
      });
      if (!erased.ok) return erased;
    }
    const items = await readRelocationItems(
      env.DB,
      operation.value.relocationId,
    );
    if (!items.ok) return items;
    for (const item of items.value) {
      if (item.status === "pending") continue;
      const archive = await loadActorExport({
        bucket: env.ARCHIVE,
        root: env.DATA_ENCRYPTION_ROOT,
        ref: item.exportRef,
      });
      if (!archive.ok && archive.error.code !== "export_missing")
        return archive;
      if (archive.ok) {
        for (const object of archive.value.payload.r2)
          await env.ARCHIVE.delete(object.archiveKey);
        await env.ARCHIVE.delete(item.exportRef.key);
      }
    }
  }
  return { ok: true, value: null };
}

/** A rejected local freeze has exported nothing. Restore admission so issued work can recover. */
async function restoreAdmissionBeforeRegionalFreeze(
  directory: GlobalDatabase,
  source: D1Database,
  move: FrozenOrganisationPlacementMove,
  relocationId: ActorRelocationId,
): Promise<void> {
  const active = await source
    .prepare(
      `SELECT 1 FROM organisation_placement
    WHERE organisation_id = ? AND placement_epoch = ? AND fence_token = ? AND status = 'active'`,
    )
    .bind(
      move.organisationId,
      move.source.placement.placementEpoch,
      move.source.fenceToken,
    )
    .first();
  if (active === null) return;
  await directory.batch([
    prepareSourceAdmissionRestore(directory, {
      organisationId: move.organisationId,
      sourcePlacementEpoch: move.source.placement.placementEpoch,
      sourceFenceToken: move.source.fenceToken,
      relocationId,
      targetFenceToken: move.target.fenceToken,
    }),
    prepareRelocationFreezeRelease(directory, relocationId),
  ]);
}

export async function inspectActorRelocation(input: {
  readonly env: OrganisationPlacementBindings;
  readonly relocationId: ActorRelocationId;
}): Promise<Result<ActorRelocationInspection, ActorRelocationError>> {
  const relocation = await readRelocationById(input.env.DB, input.relocationId);

  if (!relocation.ok) {
    return relocation;
  }

  const items = await readRelocationItems(input.env.DB, input.relocationId);

  if (!items.ok) {
    return items;
  }

  const sourcesDatabase = await resolveRelocationDatabase({
    env: input.env,
    organisationId: relocation.value.organisationId,
    placementEpoch: relocation.value.sourcePlacementEpoch,
  });
  if (!sourcesDatabase.ok) return sourcesDatabase;
  const sources = await listPlacementActorRegistryEntries({
    db: sourcesDatabase.value,
    organisationId: relocation.value.organisationId,
    placementEpoch: relocation.value.sourcePlacementEpoch,
  });

  if (!sources.ok) {
    return sources;
  }

  const targetsDatabase = await resolveRelocationDatabase({
    env: input.env,
    organisationId: relocation.value.organisationId,
    placementEpoch: relocation.value.targetPlacementEpoch,
  });
  if (!targetsDatabase.ok) return targetsDatabase;
  const targets = await listPlacementActorRegistryEntries({
    db: targetsDatabase.value,
    organisationId: relocation.value.organisationId,
    placementEpoch: relocation.value.targetPlacementEpoch,
  });

  if (!targets.ok) {
    return targets;
  }

  const sourceById = indexRegistryEntries(sources.value);
  const targetById = indexRegistryEntries(targets.value);
  const inspectedItems: ActorRelocationInspectionItem[] = [];

  for (const item of items.value) {
    const source = sourceById.get(item.sourceRegistryId);

    if (source === undefined) {
      return relocationCorrupt();
    }

    switch (item.status) {
      case "pending":
      case "exported":
        inspectedItems.push({
          objectKind: item.objectKind,
          logicalObjectId: item.logicalObjectId,
          exportId: item.exportId,
          source: registryLifecycleSummary(source),
          status: item.status,
          target: null,
          updatedAt: item.updatedAt,
        });
        break;
      case "imported":
      case "retired": {
        const target = targetById.get(item.targetRegistryId);

        if (target === undefined) {
          return relocationCorrupt();
        }

        inspectedItems.push({
          objectKind: item.objectKind,
          logicalObjectId: item.logicalObjectId,
          exportId: item.exportId,
          source: registryLifecycleSummary(source),
          status: item.status,
          target: registryLifecycleSummary(target),
          updatedAt: item.updatedAt,
        });
        break;
      }
      default:
        return assertNever(item);
    }
  }

  const exclusions = await readRelocationExclusions(
    input.env.DB,
    input.relocationId,
  );
  if (exclusions === null) return relocationCorrupt();

  return {
    ok: true,
    value: {
      relocation: relocation.value,
      items: inspectedItems,
      exclusions,
    },
  };
}

export async function readRetainedActorRelocationExports(input: {
  readonly env: OrganisationPlacementBindings;
  readonly relocationId: ActorRelocationId;
}): Promise<
  Result<
    {
      readonly organisationId: OrganisationId;
      readonly sourcePlacementEpoch: number;
      readonly exports: readonly RetainedActorRelocationExport[];
      readonly retiredActors: readonly RetiredActorRecord[];
    },
    ActorRelocationError
  >
> {
  const relocation = await readRelocationById(input.env.DB, input.relocationId);

  if (!relocation.ok) {
    return relocation;
  }

  if (relocation.value.status !== "retained") {
    return { ok: false, error: { code: "relocation_conflict" } };
  }

  const items = await readRelocationItems(input.env.DB, input.relocationId);
  const sourcesDatabase = await resolveRelocationDatabase({
    env: input.env,
    organisationId: relocation.value.organisationId,
    placementEpoch: relocation.value.sourcePlacementEpoch,
  });
  if (!sourcesDatabase.ok) return sourcesDatabase;
  const sources = await listPlacementActorRegistryEntries({
    db: sourcesDatabase.value,
    organisationId: relocation.value.organisationId,
    placementEpoch: relocation.value.sourcePlacementEpoch,
  });

  if (!items.ok) {
    return items;
  }

  if (!sources.ok) {
    return sources;
  }

  const transferredIds = new Set(items.value.map(relocationSourceRegistryId));
  const retiredActors: RetiredActorRecord[] = [];
  for (const source of sources.value) {
    if (
      source.lifecycleStatus === "retired" &&
      !transferredIds.has(source.registryId)
    ) {
      retiredActors.push(retiredActorRecord(source));
    }
  }
  const sourceById = indexRegistryEntries(sources.value);
  const exports: RetainedActorRelocationExport[] = [];

  for (const item of items.value) {
    if (item.status !== "retired") {
      return relocationCorrupt();
    }

    const source = sourceById.get(item.sourceRegistryId);

    if (
      source === undefined ||
      source.lifecycleStatus !== "retired" ||
      source.identity.objectKind !== item.objectKind ||
      source.identity.logicalObjectId !== item.logicalObjectId
    ) {
      return relocationCorrupt();
    }

    exports.push({
      identity: source.identity,
      sourceSchemaVersion: source.schemaVersion,
      sourceStateVersion: source.stateVersion,
      exportRef: item.exportRef,
    });
  }

  return {
    ok: true,
    value: {
      organisationId: relocation.value.organisationId,
      sourcePlacementEpoch: relocation.value.sourcePlacementEpoch,
      exports,
      retiredActors,
    },
  };
}

function relocationSourceRegistryId(
  item: ActorRelocationItem,
): ActorRegistryEntry["registryId"] {
  return item.sourceRegistryId;
}

function indexRegistryEntries(
  entries: readonly ActorRegistryEntry[],
): ReadonlyMap<ActorRegistryEntry["registryId"], ActorRegistryEntry> {
  const indexed = new Map<
    ActorRegistryEntry["registryId"],
    ActorRegistryEntry
  >();

  for (const entry of entries) {
    indexed.set(entry.registryId, entry);
  }

  return indexed;
}

function registryLifecycleSummary(
  entry: ActorRegistryEntry,
): RegistryLifecycleSummary {
  const base: RegistryLifecycleSummaryBase = {
    registryId: entry.registryId,
    objectKind: entry.identity.objectKind,
    logicalObjectId: entry.identity.logicalObjectId,
    placementEpoch: entry.placement.placementEpoch,
    schemaVersion: entry.schemaVersion,
    stateVersion: entry.stateVersion,
  };

  switch (entry.lifecycleStatus) {
    case "reserved":
      return {
        ...base,
        lifecycleStatus: entry.lifecycleStatus,
        activatedAt: null,
        exportingAt: null,
        retiredAt: null,
      };
    case "active":
      return {
        ...base,
        lifecycleStatus: entry.lifecycleStatus,
        activatedAt: entry.activatedAt,
        exportingAt: null,
        retiredAt: null,
      };
    case "exporting":
      return {
        ...base,
        lifecycleStatus: entry.lifecycleStatus,
        activatedAt: entry.activatedAt,
        exportingAt: entry.exportingAt,
        retiredAt: null,
      };
    case "retired":
      return {
        ...base,
        lifecycleStatus: entry.lifecycleStatus,
        activatedAt: entry.activatedAt,
        exportingAt: entry.exportingAt,
        retiredAt: entry.retiredAt,
      };
    case "quarantined":
      return {
        ...base,
        lifecycleStatus: entry.lifecycleStatus,
        activatedAt: entry.activatedAt,
        exportingAt: entry.exportingAt,
        retiredAt: null,
      };
    default:
      return assertNever(entry);
  }
}

async function readLiveRelocationById(
  db: GlobalDatabase,
  relocationId: ActorRelocationId,
): Promise<Result<LiveActorRelocation, ActorRelocationError>> {
  const operation = await readRelocationById(db, relocationId);

  if (!operation.ok) {
    return operation;
  }

  switch (operation.value.status) {
    case "reserved":
    case "frozen":
    case "copying":
    case "published":
      return { ok: true, value: operation.value };
    case "retained":
    case "cleaning":
    case "complete":
    case "abandoned":
      return { ok: false, error: { code: "relocation_conflict" } };
    case "quarantined":
      return {
        ok: false,
        error: {
          code: "relocation_quarantined",
          reason: operation.value.quarantineReason,
        },
      };
    default:
      return assertNever(operation.value);
  }
}

function isReservedPlacementMove(
  move: OrganisationPlacementMove,
): move is ReservedOrganisationPlacementMove {
  return move.source.status === "active";
}

function isFrozenPlacementMove(
  move: OrganisationPlacementMove,
): move is FrozenOrganisationPlacementMove {
  return move.source.status === "frozen";
}

function isPublishedPlacementMove(
  move: OrganisationPlacementMove,
): move is PublishedOrganisationPlacementMove {
  return move.source.status === "retired";
}

async function copyRelocationObjects(input: {
  readonly env: RelocationBindings;
  readonly operation: LiveActorRelocation;
  readonly move: FrozenOrganisationPlacementMove;
  readonly now: number;
}): Promise<Result<null, ActorRelocationError>> {
  const startedAt = Date.now();
  const sourceEntriesDatabase = await resolveRelocationDatabase({
    env: input.env,
    organisationId: input.operation.organisationId,
    placementEpoch: input.operation.sourcePlacementEpoch,
  });
  if (!sourceEntriesDatabase.ok) return sourceEntriesDatabase;
  const sourceEntries = await listPlacementActorRegistryEntries({
    db: sourceEntriesDatabase.value,
    organisationId: input.operation.organisationId,
    placementEpoch: input.operation.sourcePlacementEpoch,
  });
  const items = await readRelocationItems(
    input.env.DB,
    input.operation.relocationId,
  );

  if (!sourceEntries.ok) {
    return { ok: false, error: sourceEntries.error };
  }

  if (!items.ok) {
    return { ok: false, error: items.error };
  }

  if (
    sourceEntries.value.filter(isMovedRegistryEntry).length !==
    items.value.length
  ) {
    return { ok: false, error: { code: "relocation_inventory_changed" } };
  }

  for (const entry of sourceEntries.value) {
    if (!isMovedRegistryEntry(entry)) continue;
    if (!targetSupportsActorSchema(entry)) {
      return { ok: false, error: { code: "target_schema_older_than_export" } };
    }
  }

  await markRelocationCopying(input.env.DB, input.operation.relocationId);

  const namespaces = relocationNamespaces(input.env);

  for (const item of items.value) {
    if (
      await relocationPublicationExpired(
        input.env.DB,
        input.operation,
        input.now + Date.now() - startedAt,
      )
    )
      return { ok: false, error: { code: "relocation_conflict" } };

    const source = matchingSourceEntry(sourceEntries.value, item);

    if (source === null) {
      return { ok: false, error: { code: "relocation_inventory_changed" } };
    }

    const exporting = await ensureSourceExporting(
      sourceEntriesDatabase.value,
      source,
      input.now,
    );

    if (!exporting.ok) {
      return exporting;
    }

    const exportRef = await ensureItemExported({
      db: input.env.DB,
      namespaces,
      relocationId: input.operation.relocationId,
      source: exporting.value,
      item,
      now: input.now,
    });

    if (!exportRef.ok) {
      return exportRef;
    }

    const target = await importActorCopyTarget({
      env: input.env,
      namespaces,
      identity: exporting.value.identity,
      sourceSchemaVersion: exporting.value.schemaVersion,
      admission: actorRelocationAdmission(
        input.move,
        input.operation.relocationId,
        exporting.value.identity,
      ),
      exportRef: exportRef.value,
      now: input.now,
    });

    if (!target.ok) {
      if (definitiveActorImportFailure(target.error)) {
        await markRelocationQuarantined(input.env.DB, {
          relocationId: input.operation.relocationId,
          reason: target.error.code,
          now: input.now,
        });
        return {
          ok: false,
          error: { code: "relocation_quarantined", reason: target.error.code },
        };
      }

      return { ok: false, error: target.error };
    }

    await markRelocationItemImported({
      db: input.env.DB,
      relocationId: input.operation.relocationId,
      item,
      exportRef: exportRef.value,
      targetRegistryId: target.value.registryId,
      now: input.now,
    });
  }

  return { ok: true, value: null };
}

function targetSupportsActorSchema(entry: ActorRegistryEntry): boolean {
  return (
    currentActorSchemaVersion(entry.identity.objectKind) >= entry.schemaVersion
  );
}

async function ensureSourceExporting(
  db: OrganisationDatabase,
  source: ActorRegistryEntry,
  now: number,
): Promise<
  Result<
    VariantBy<ActorRegistryEntry, "lifecycleStatus", "exporting">,
    ActorRelocationError
  >
> {
  if (source.lifecycleStatus === "exporting") {
    return { ok: true, value: source };
  }

  if (source.lifecycleStatus !== "active") {
    return { ok: false, error: { code: "relocation_inventory_changed" } };
  }

  const exporting = await beginActorExport({
    db,
    registryId: source.registryId,
    expectedFenceToken: source.fenceToken,
    now,
  });

  return exporting.ok && exporting.value.lifecycleStatus === "exporting"
    ? { ok: true, value: exporting.value }
    : exporting.ok
      ? { ok: false, error: { code: "registry_export_conflict" } }
      : exporting;
}

async function ensureItemExported(input: {
  readonly db: GlobalDatabase;
  readonly namespaces: ActorNamespaces;
  readonly relocationId: ActorRelocationId;
  readonly source: VariantBy<
    ActorRegistryEntry,
    "lifecycleStatus",
    "exporting"
  >;
  readonly item: ActorRelocationItem;
  readonly now: number;
}): Promise<Result<ActorExportRef, ActorRelocationError>> {
  if (input.item.status !== "pending") {
    return { ok: true, value: input.item.exportRef };
  }

  const sourceObject = actorStubForRegistryEntry({
    namespaces: input.namespaces,
    entry: input.source,
  });
  const exported = await sourceObject.exportPlacementState({
    expectedFenceToken: input.source.fenceToken,
    exportId: input.item.exportId,
    requestedAt: input.now,
  });

  if (!exported.ok) {
    return exported;
  }

  await input.db
    .prepare(
      `UPDATE state_object_relocation_item
       SET status = 'exported',
           export_key = ?,
           export_organisation_id = ?,
           export_payload_digest_b64 = ?,
           export_created_at = ?,
           updated_at = ?
       WHERE relocation_id = ?
         AND object_kind = ?
         AND logical_object_id = ?
         AND source_registry_id = ?
         AND status = 'pending'`,
    )
    .bind(
      exported.value.key,
      exported.value.organisationId,
      exported.value.payloadDigestB64,
      exported.value.createdAt,
      input.now,
      input.relocationId,
      input.item.objectKind,
      input.item.logicalObjectId,
      input.item.sourceRegistryId,
    )
    .run();

  return exported;
}

async function retireRelocationSources(input: {
  readonly env: RelocationBindings;
  readonly operation: LiveActorRelocation;
  readonly move: PublishedOrganisationPlacementMove;
  readonly now: number;
}): Promise<Result<null, ActorRelocationError>> {
  const sourcesDatabase = await resolveRelocationDatabase({
    env: input.env,
    organisationId: input.operation.organisationId,
    placementEpoch: input.move.source.placement.placementEpoch,
  });
  if (!sourcesDatabase.ok) return sourcesDatabase;
  const sources = await listPlacementActorRegistryEntries({
    db: sourcesDatabase.value,
    organisationId: input.operation.organisationId,
    placementEpoch: input.move.source.placement.placementEpoch,
  });

  if (!sources.ok) {
    return sources;
  }

  for (const source of sources.value) {
    // A quarantined source was left out of the move and keeps its entry.
    if (source.lifecycleStatus === "quarantined") continue;
    if (
      source.lifecycleStatus !== "exporting" &&
      source.lifecycleStatus !== "retired"
    ) {
      return { ok: false, error: { code: "relocation_inventory_changed" } };
    }

    const retired =
      source.lifecycleStatus === "retired"
        ? { ok: true as const, value: source }
        : await retireActorRegistryEntry({
            db: sourcesDatabase.value,
            registryId: source.registryId,
            expectedFenceToken: source.fenceToken,
            now: input.now,
          });

    if (!retired.ok) {
      return retired;
    }

    await input.env.DB.prepare(
      `UPDATE state_object_relocation_item
         SET status = 'retired', updated_at = ?
         WHERE relocation_id = ? AND source_registry_id = ? AND status = 'imported'`,
    )
      .bind(input.now, input.operation.relocationId, source.registryId)
      .run();
  }

  return { ok: true, value: null };
}

async function markRelocationItemImported(input: {
  readonly db: GlobalDatabase;
  readonly relocationId: ActorRelocationId;
  readonly item: ActorRelocationItem;
  readonly exportRef: ActorExportRef;
  readonly targetRegistryId: ActorRegistryEntry["registryId"];
  readonly now: number;
}): Promise<void> {
  await input.db
    .prepare(
      `UPDATE state_object_relocation_item
       SET status = 'imported',
           target_registry_id = ?,
           export_key = ?,
           export_organisation_id = ?,
           export_payload_digest_b64 = ?,
           export_created_at = ?,
           updated_at = ?
       WHERE relocation_id = ?
         AND object_kind = ?
         AND logical_object_id = ?
         AND source_registry_id = ?
         AND status IN ('pending', 'exported', 'imported')`,
    )
    .bind(
      input.targetRegistryId,
      input.exportRef.key,
      input.exportRef.organisationId,
      input.exportRef.payloadDigestB64,
      input.exportRef.createdAt,
      input.now,
      input.relocationId,
      input.item.objectKind,
      input.item.logicalObjectId,
      input.item.sourceRegistryId,
    )
    .run();
}

async function readRelocationById(
  db: GlobalDatabase,
  relocationId: ActorRelocationId,
): Promise<Result<ActorRelocation, ActorRelocationError>> {
  const row = await db
    .prepare(`${relocationSelect()} WHERE relocation_id = ?`)
    .bind(relocationId)
    .first<RelocationRow>();

  return parseRelocationRow(row);
}

async function readRelocationByPlacement(
  db: GlobalDatabase,
  organisationId: OrganisationId,
  sourcePlacementEpoch: number,
  targetPlacementEpoch: number,
): Promise<Result<ActorRelocation, ActorRelocationError>> {
  const row = await db
    .prepare(
      `${relocationSelect()}
       WHERE organisation_id = ?
         AND source_placement_epoch = ?
         AND target_placement_epoch = ?`,
    )
    .bind(organisationId, sourcePlacementEpoch, targetPlacementEpoch)
    .first<RelocationRow>();

  return parseRelocationRow(row);
}

function relocationSelect(): string {
  return `SELECT
     preflight_at AS preflightAt, preflight_row_count AS preflightRowCount,
     preflight_table_count AS preflightTableCount, preflight_actor_bytes AS preflightActorBytes,
     preflight_actor_count AS preflightActorCount,
     relocation_id AS relocationId,
     organisation_id AS organisationId,
     source_placement_epoch AS sourcePlacementEpoch,
     target_placement_epoch AS targetPlacementEpoch,
     status,
     created_at AS createdAt,
     frozen_at AS frozenAt,
     published_at AS publishedAt,
     resumed_at AS resumedAt,
     retain_until AS retainUntil,
     completed_at AS completedAt,
     abandoned_at AS abandonedAt,
     recovery_relocation_id AS recoveryRelocationId,
     quarantined_at AS quarantinedAt,
     quarantine_reason AS quarantineReason
   FROM state_object_relocation`;
}

function parseRelocationRow(
  row: RelocationRow | null,
): Result<ActorRelocation, ActorRelocationError> {
  if (row === null) {
    return { ok: false, error: { code: "relocation_missing" } };
  }

  const relocationId = parseActorRelocationId(row.relocationId);

  if (!isNonEmptyString(row.organisationId)) {
    return relocationCorrupt();
  }

  const organisationId = parseOrganisationId(row.organisationId);

  if (
    !relocationId.ok ||
    !organisationId.ok ||
    !isPositiveInteger(row.sourcePlacementEpoch) ||
    !isPositiveInteger(row.targetPlacementEpoch) ||
    row.targetPlacementEpoch <= row.sourcePlacementEpoch ||
    !isNonNegativeInteger(row.createdAt)
  ) {
    return relocationCorrupt();
  }

  if (
    !isNonNegativeInteger(row.preflightAt) ||
    !isNonNegativeInteger(row.preflightRowCount) ||
    !isNonNegativeInteger(row.preflightTableCount) ||
    !isNonNegativeInteger(row.preflightActorBytes) ||
    !isNonNegativeInteger(row.preflightActorCount)
  )
    return relocationCorrupt();
  const preflight: RelocationPreflightInventory = {
    checkedAt: row.preflightAt,
    rowCount: row.preflightRowCount,
    tableCount: row.preflightTableCount,
    actorBytes: row.preflightActorBytes,
    actorCount: row.preflightActorCount,
  };
  const base: RelocationBase = {
    preflight,
    relocationId: relocationId.value,
    organisationId: organisationId.value,
    sourcePlacementEpoch: row.sourcePlacementEpoch,
    targetPlacementEpoch: row.targetPlacementEpoch,
    createdAt: row.createdAt,
  };

  if (
    row.status !== "abandoned" &&
    !allNull(row.abandonedAt, row.recoveryRelocationId)
  )
    return relocationCorrupt();
  switch (row.status) {
    case "abandoned": {
      const recovery = parseActorRelocationId(row.recoveryRelocationId);
      if (
        !recovery.ok ||
        !isNonNegativeInteger(row.abandonedAt) ||
        !isNonNegativeInteger(row.frozenAt) ||
        !allNull(
          row.publishedAt,
          row.resumedAt,
          row.retainUntil,
          row.completedAt,
          row.quarantinedAt,
          row.quarantineReason,
        )
      )
        return relocationCorrupt();
      return {
        ok: true,
        value: {
          preflight: base.preflight,
          relocationId: base.relocationId,
          organisationId: base.organisationId,
          sourcePlacementEpoch: base.sourcePlacementEpoch,
          targetPlacementEpoch: base.targetPlacementEpoch,
          createdAt: base.createdAt,
          status: "abandoned",
          frozenAt: row.frozenAt,
          abandonedAt: row.abandonedAt,
          recoveryRelocationId: recovery.value,
        },
      };
    }
    case "reserved":
      return allNull(
        row.resumedAt,
        row.retainUntil,
        row.frozenAt,
        row.publishedAt,
        row.completedAt,
        row.quarantinedAt,
        row.quarantineReason,
      )
        ? { ok: true, value: { ...base, status: row.status } }
        : relocationCorrupt();
    case "frozen":
    case "copying":
      return allNull(row.resumedAt, row.retainUntil) &&
        isNonNegativeInteger(row.frozenAt) &&
        allNull(
          row.publishedAt,
          row.completedAt,
          row.quarantinedAt,
          row.quarantineReason,
        )
        ? {
            ok: true,
            value: { ...base, status: row.status, frozenAt: row.frozenAt },
          }
        : relocationCorrupt();
    case "published":
      return allNull(row.resumedAt, row.retainUntil) &&
        isNonNegativeInteger(row.frozenAt) &&
        isNonNegativeInteger(row.publishedAt) &&
        allNull(row.completedAt, row.quarantinedAt, row.quarantineReason)
        ? {
            ok: true,
            value: {
              ...base,
              status: row.status,
              frozenAt: row.frozenAt,
              publishedAt: row.publishedAt,
            },
          }
        : relocationCorrupt();
    case "retained":
    case "cleaning":
      if (
        !isNonNegativeInteger(row.frozenAt) ||
        !isNonNegativeInteger(row.publishedAt) ||
        !isNonNegativeInteger(row.resumedAt) ||
        !isNonNegativeInteger(row.retainUntil) ||
        row.retainUntil < row.resumedAt + ACTOR_RELOCATION_RETENTION_MS ||
        !allNull(row.completedAt, row.quarantinedAt, row.quarantineReason)
      )
        return relocationCorrupt();
      return {
        ok: true,
        value: {
          preflight: base.preflight,
          relocationId: base.relocationId,
          organisationId: base.organisationId,
          sourcePlacementEpoch: base.sourcePlacementEpoch,
          targetPlacementEpoch: base.targetPlacementEpoch,
          createdAt: base.createdAt,
          status: row.status,
          frozenAt: row.frozenAt,
          publishedAt: row.publishedAt,
          resumedAt: row.resumedAt,
          retainUntil: row.retainUntil,
        },
      };
    case "complete":
      return isNonNegativeInteger(row.resumedAt) &&
        isNonNegativeInteger(row.retainUntil) &&
        row.retainUntil >= row.resumedAt + ACTOR_RELOCATION_RETENTION_MS &&
        isNonNegativeInteger(row.frozenAt) &&
        isNonNegativeInteger(row.publishedAt) &&
        isNonNegativeInteger(row.completedAt) &&
        allNull(row.quarantinedAt, row.quarantineReason)
        ? {
            ok: true,
            value: {
              ...base,
              status: row.status,
              frozenAt: row.frozenAt,
              publishedAt: row.publishedAt,
              completedAt: row.completedAt,
              resumedAt: row.resumedAt,
              retainUntil: row.retainUntil,
            },
          }
        : relocationCorrupt();
    case "quarantined":
      return allNull(row.resumedAt, row.retainUntil) &&
        nullableTimestamp(row.frozenAt) &&
        nullableTimestamp(row.publishedAt) &&
        row.completedAt === null &&
        isNonNegativeInteger(row.quarantinedAt) &&
        isNonEmptyString(row.quarantineReason)
        ? {
            ok: true,
            value: {
              ...base,
              status: row.status,
              frozenAt: row.frozenAt,
              publishedAt: row.publishedAt,
              quarantinedAt: row.quarantinedAt,
              quarantineReason: row.quarantineReason,
            },
          }
        : relocationCorrupt();
    default:
      return relocationCorrupt();
  }
}

async function readRelocationItems(
  db: GlobalDatabase,
  relocationId: ActorRelocationId,
): Promise<Result<readonly ActorRelocationItem[], ActorRelocationError>> {
  const rows = await db
    .prepare(
      `SELECT
         object_kind AS objectKind,
         logical_object_id AS logicalObjectId,
         source_registry_id AS sourceRegistryId,
         target_registry_id AS targetRegistryId,
         export_id AS exportId,
         export_key AS exportKey,
         export_organisation_id AS exportOrganisationId,
         export_payload_digest_b64 AS exportPayloadDigestB64,
         export_created_at AS exportCreatedAt,
         status,
         updated_at AS updatedAt
       FROM state_object_relocation_item
       WHERE relocation_id = ?
       ORDER BY object_kind, logical_object_id`,
    )
    .bind(relocationId)
    .all<RelocationItemRow>();
  const items: ActorRelocationItem[] = [];

  for (const row of rows.results) {
    const parsed = parseRelocationItemRow(row);

    if (!parsed.ok) {
      return parsed;
    }

    items.push(parsed.value);
  }

  return { ok: true, value: items };
}

function parseRelocationItemRow(
  row: RelocationItemRow,
): Result<ActorRelocationItem, ActorRelocationError> {
  const sourceRegistryId = parseActorRegistryId(row.sourceRegistryId);
  const exportId = parseActorExportId(row.exportId);

  if (
    !objectKind(row.objectKind) ||
    !isNonEmptyString(row.logicalObjectId) ||
    !sourceRegistryId.ok ||
    !exportId.ok ||
    !isNonNegativeInteger(row.updatedAt)
  ) {
    return relocationCorrupt();
  }

  const base: RelocationItemBase = {
    objectKind: row.objectKind,
    logicalObjectId: row.logicalObjectId,
    sourceRegistryId: sourceRegistryId.value,
    exportId: exportId.value,
    updatedAt: row.updatedAt,
  };

  if (row.status === "pending") {
    return allNull(
      row.targetRegistryId,
      row.exportKey,
      row.exportOrganisationId,
      row.exportPayloadDigestB64,
      row.exportCreatedAt,
    )
      ? { ok: true, value: { ...base, status: row.status } }
      : relocationCorrupt();
  }

  const exportRef = parsePersistedExportRef(row, exportId.value);

  if (!exportRef.ok) {
    return exportRef;
  }

  if (row.status === "exported") {
    return row.targetRegistryId === null
      ? {
          ok: true,
          value: { ...base, status: row.status, exportRef: exportRef.value },
        }
      : relocationCorrupt();
  }

  if (row.status === "imported" || row.status === "retired") {
    const targetRegistryId = parseActorRegistryId(row.targetRegistryId);

    return targetRegistryId.ok
      ? {
          ok: true,
          value: {
            ...base,
            status: row.status,
            targetRegistryId: targetRegistryId.value,
            exportRef: exportRef.value,
          },
        }
      : relocationCorrupt();
  }

  return relocationCorrupt();
}

function parsePersistedExportRef(
  row: RelocationItemRow,
  exportId: ActorExportId,
): Result<ActorExportRef, ActorRelocationError> {
  if (!isNonEmptyString(row.exportOrganisationId)) {
    return relocationCorrupt();
  }

  const organisationId = parseOrganisationId(row.exportOrganisationId);

  return organisationId.ok &&
    isNonEmptyString(row.exportKey) &&
    isNonEmptyString(row.exportPayloadDigestB64) &&
    isNonNegativeInteger(row.exportCreatedAt)
    ? {
        ok: true,
        value: {
          exportId,
          organisationId: organisationId.value,
          key: row.exportKey,
          payloadDigestB64: row.exportPayloadDigestB64,
          createdAt: row.exportCreatedAt,
        },
      }
    : relocationCorrupt();
}

function matchingSourceEntry(
  entries: readonly ActorRegistryEntry[],
  item: ActorRelocationItem,
): ActorRegistryEntry | null {
  for (const entry of entries) {
    if (
      entry.registryId === item.sourceRegistryId &&
      entry.identity.objectKind === item.objectKind &&
      entry.identity.logicalObjectId === item.logicalObjectId
    ) {
      return entry;
    }
  }

  return null;
}

function relocationNamespaces(env: RelocationBindings): ActorNamespaces {
  return {
    organisation: env.ORGANISATION,
    session: env.SESSION,
    case: env.CASE,
    connector: env.CONNECTOR,
  };
}

export function parseActorRelocationId(
  value: unknown,
): Result<ActorRelocationId, { readonly code: "invalid_relocation_id" }> {
  return typeof value === "string" && /^dor_move_[0-9a-f-]+$/.test(value)
    ? { ok: true, value: value as ActorRelocationId }
    : { ok: false, error: { code: "invalid_relocation_id" } };
}

function newActorRelocationId(): ActorRelocationId {
  const parsed = parseActorRelocationId(`dor_move_${crypto.randomUUID()}`);

  if (!parsed.ok) {
    throw new Error("generated actor relocation id is invalid");
  }

  return parsed.value;
}

function objectKind(value: unknown): value is RelocationItemBase["objectKind"] {
  return (
    value === "organisation" ||
    value === "surface" ||
    value === "session" ||
    value === "thread" ||
    value === "case" ||
    value === "connector"
  );
}

function nullableTimestamp(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function allNull(...values: readonly unknown[]): boolean {
  for (const value of values) {
    if (value !== null) {
      return false;
    }
  }

  return true;
}

function relocationCorrupt(): Result<never, ActorRelocationError> {
  return { ok: false, error: { code: "relocation_corrupt" } };
}

async function resolveRelocationDatabase(input: {
  readonly env: OrganisationPlacementBindings;
  readonly organisationId: OrganisationId;
  readonly placementEpoch: number;
}): Promise<Result<OrganisationDatabase, ActorRelocationError>> {
  const placement = await readPlacementByEpoch(
    input.env.DB,
    input.organisationId,
    input.placementEpoch,
  );
  if (!placement.ok) return placement;
  const database = selectOrganisationPlacementDatabase(
    input.env,
    input.organisationId,
    placement.value.placement,
  );
  return database;
}
