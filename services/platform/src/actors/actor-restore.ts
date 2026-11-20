import type { GlobalDatabase, OrganisationDatabase } from "../database-handles";
import {
  provisionRegionalMoveTarget,
  resumeRegionalPlacement,
} from "../data/shared-rows/regional-move";
import {
  selectOrganisationPlacementDatabase,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import { actorRestoreAdmission } from "./actor-placement-admission";
import {
  listOrganisationActorRegistryEntries,
  copyRetiredActorRegistryEntry,
  matchesRetiredActorRecord,
  type RetiredActorRecord,
  parseActorRegistryId,
  type ActorRegistryEntry,
  type ActorRegistryError,
  type ActorRegistryId,
} from "./actor-registry";
import {
  freezeOrganisationPlacementMove,
  freezeRegionalOrganisationPlacement,
  prepareAbandonedMoveSourceFreeze,
  prepareAbandonedMoveTargetRelease,
  prepareRecoveryTargetReservation,
  prepareRegionalTargetAbandon,
  publishOrganisationPlacementMove,
  reserveOrganisationPlacementMove,
} from "../data/shared-rows/placement-row";
import {
  markRestoreComplete,
  markRestoreFrozen,
  markRestoreImporting,
  markRestoreQuarantined,
  placementMoveOpenOfOtherKind,
  prepareRecoveryRelocationStart,
  prepareRestoreAbandon,
  prepareRestoreStart,
} from "../data/placement-move";
import {
  parseActorRelocationId,
  resumeActorRelocation,
  type ActorRelocation,
  type ActorRelocationId,
} from "./actor-relocation";
import {
  readOrganisationPlacementMove,
  readPlacementByEpoch,
  resolveActiveOrganisationPlacement,
  type FrozenOrganisationPlacementMove,
  type PublishedOrganisationPlacementMove,
  type ReservedOrganisationPlacementMove,
  type OrganisationPlacementError,
  type OrganisationPlacementMoveTarget,
} from "../data/organisation-placement";
import type { Env } from "../env";
import { parseOrganisationId, type OrganisationId } from "../ids";
import type { Result } from "../result";
import {
  definitiveActorImportFailure,
  importActorCopyTarget,
  type ActorCopyError,
} from "./actor-copy";
import {
  canonicalActorRestoreManifestJson,
  parseActorRestoreManifest,
  verifyActorRestoreManifestExports,
  type ActorRestoreManifestError,
  type ActorRestoreManifestObject,
  type ActorRestoreManifest,
} from "./actor-restore-manifest";
import type { ActorNamespaces } from "./actor-router";
import { quiescePlacementExecution } from "./placement-execution-quiescence";
import type { VariantBy } from "@purin-labs/type-utils";
import {
  assertNever,
  isNonEmptyString,
  isNonNegativeInteger,
  isPositiveInteger,
} from "@purin-labs/std";

declare const actorRestoreIdBrand: unique symbol;

export type ActorRestoreId = string & {
  readonly [actorRestoreIdBrand]: "ActorRestoreId";
};

type RestoreBase = {
  readonly restoreId: ActorRestoreId;
  readonly organisationId: OrganisationId;
  readonly exportSourcePlacementEpoch: number;
  readonly localSourcePlacementEpoch: number;
  readonly targetPlacementEpoch: number;
  readonly manifestDigestB64: string;
  readonly createdAt: number;
};

type ActorRestore =
  | (RestoreBase & {
      readonly status: "reserved";
      readonly frozenAt?: never;
      readonly publishedAt?: never;
      readonly completedAt?: never;
      readonly quarantinedAt?: never;
      readonly quarantineReason?: never;
    })
  | (RestoreBase & {
      readonly status: "frozen" | "importing";
      readonly frozenAt: number;
      readonly publishedAt?: never;
      readonly completedAt?: never;
      readonly quarantinedAt?: never;
      readonly quarantineReason?: never;
    })
  | (RestoreBase & {
      readonly status: "published";
      readonly frozenAt: number;
      readonly publishedAt: number;
      readonly completedAt?: never;
      readonly quarantinedAt?: never;
      readonly quarantineReason?: never;
    })
  | (RestoreBase & {
      readonly status: "complete";
      readonly frozenAt: number;
      readonly publishedAt: number;
      readonly completedAt: number;
      readonly quarantinedAt?: never;
      readonly quarantineReason?: never;
    })
  | (RestoreBase & {
      readonly status: "quarantined";
      readonly frozenAt: number | null;
      readonly publishedAt: number | null;
      readonly completedAt?: never;
      readonly quarantinedAt: number;
      readonly quarantineReason: string;
    })
  | (RestoreBase & {
      readonly status: "abandoned";
      readonly frozenAt: number;
      readonly abandonedAt: number;
      readonly recoveryRelocationId: ActorRelocationId;
      readonly publishedAt?: never;
      readonly completedAt?: never;
      readonly quarantinedAt?: never;
      readonly quarantineReason?: never;
    });

type LiveActorRestore = Exclude<
  ActorRestore,
  { readonly status: "complete" | "quarantined" | "abandoned" }
>;

/** An abandoned restore and the recovery relocation that replaced its source. */
type ActorRestoreAbandonment = {
  readonly restore: VariantBy<ActorRestore, "status", "abandoned">;
  readonly recovery: ActorRelocation;
};

type RestoreRecord = {
  readonly restore: ActorRestore;
  readonly manifest: ActorRestoreManifest;
};

type RestoreItemBase = {
  readonly object: ActorRestoreManifestObject;
  readonly updatedAt: number;
};

type ActorRestoreItem =
  | (RestoreItemBase & {
      readonly status: "pending";
      readonly targetRegistryId?: never;
    })
  | (RestoreItemBase & {
      readonly status: "imported";
      readonly targetRegistryId: ActorRegistryId;
    });

type ActorRestoreInspection = {
  readonly restore: ActorRestore;
  readonly manifest: ActorRestoreManifest;
  readonly items: readonly ActorRestoreItem[];
};

export type ActorRestoreError =
  | OrganisationPlacementError
  | ActorRegistryError
  | ActorCopyError
  | ActorRestoreManifestError
  | { readonly code: "restore_missing" }
  | { readonly code: "restore_corrupt" }
  | { readonly code: "restore_conflict" }
  | { readonly code: "restore_quarantined"; readonly reason: string }
  | { readonly code: "restore_target_not_clean" }
  | { readonly code: "restore_inventory_changed" };

type RestoreBindings = OrganisationPlacementBindings &
  Pick<
    Env,
    | "DB"
    | "ARCHIVE"
    | "DATA_ENCRYPTION_ROOT"
    | "ORGANISATION"
    | "SESSION"
    | "CASE"
    | "CONNECTOR"
  >;

type RestoreRow = {
  restoreId: unknown;
  organisationId: unknown;
  localSourcePlacementEpoch: unknown;
  targetPlacementEpoch: unknown;
  manifestDigestB64: unknown;
  manifestJson: unknown;
  status: unknown;
  createdAt: unknown;
  frozenAt: unknown;
  publishedAt: unknown;
  completedAt: unknown;
  quarantinedAt: unknown;
  quarantineReason: unknown;
  abandonedAt: unknown;
  recoveryRelocationId: unknown;
};

type RestoreItemRow = {
  objectKind: unknown;
  logicalObjectId: unknown;
  sourceSchemaVersion: unknown;
  sourceStateVersion: unknown;
  exportId: unknown;
  exportKey: unknown;
  exportOrganisationId: unknown;
  exportPayloadDigestB64: unknown;
  exportCreatedAt: unknown;
  tableCount: unknown;
  rowCount: unknown;
  kvEntryCount: unknown;
  r2ObjectCount: unknown;
  r2Bytes: unknown;
  targetRegistryId: unknown;
  status: unknown;
  updatedAt: unknown;
};

type OrganisationPlacementMove =
  | ReservedOrganisationPlacementMove
  | FrozenOrganisationPlacementMove
  | PublishedOrganisationPlacementMove;

export async function startActorRestore(input: {
  readonly env: RestoreBindings;
  readonly manifest: ActorRestoreManifest;
  readonly target: OrganisationPlacementMoveTarget;
  readonly now: number;
}): Promise<Result<ActorRestore, ActorRestoreError>> {
  const exportsVerified = await verifyActorRestoreManifestExports({
    env: input.env,
    manifest: input.manifest,
  });

  if (!exportsVerified.ok) {
    return exportsVerified;
  }

  const activePlacement = await resolveActiveOrganisationPlacement(
    input.env.DB,
    input.manifest.organisationId,
  );

  if (!activePlacement.ok) {
    return activePlacement;
  }
  // One open move for each Organisation: a relocation holds the placement.
  const openRelocation = await placementMoveOpenOfOtherKind(
    input.env.DB,
    input.manifest.organisationId,
    "restore",
  );
  if (openRelocation !== null) return { ok: false, error: openRelocation };

  const sourceDatabase = selectOrganisationPlacementDatabase(
    input.env,
    input.manifest.organisationId,
    activePlacement.value,
  );
  if (!sourceDatabase.ok) return sourceDatabase;
  const clean = await assertCleanRestoreTarget(
    sourceDatabase.value,
    input.manifest.organisationId,
  );
  if (!clean.ok) return clean;

  const move = await reserveOrganisationPlacementMove({
    db: input.env.DB,
    organisationId: input.manifest.organisationId,
    target: input.target,
    now: input.now,
  });

  if (!move.ok) {
    return move;
  }

  if (
    move.value.source.placement.placementEpoch !==
      activePlacement.value.placementEpoch ||
    move.value.target.placement.placementEpoch <=
      activePlacement.value.placementEpoch
  ) {
    return { ok: false, error: { code: "restore_conflict" } };
  }

  const restoreId = newActorRestoreId();

  await prepareRestoreStart(input.env.DB, {
    restoreId,
    organisationId: input.manifest.organisationId,
    localSourcePlacementEpoch: activePlacement.value.placementEpoch,
    targetPlacementEpoch: move.value.target.placement.placementEpoch,
    manifestDigestB64: input.manifest.manifestDigestB64,
    manifestJson: canonicalActorRestoreManifestJson(input.manifest),
    now: input.now,
  }).run();

  const record = await readRestoreByPlacement({
    db: input.env.DB,
    organisationId: input.manifest.organisationId,
    localSourcePlacementEpoch: activePlacement.value.placementEpoch,
    targetPlacementEpoch: move.value.target.placement.placementEpoch,
  });

  if (!record.ok) {
    // A relocation that started since the check above holds the placement.
    const open = await placementMoveOpenOfOtherKind(
      input.env.DB,
      input.manifest.organisationId,
      "restore",
    );
    return open === null ? record : { ok: false, error: open };
  }

  if (
    record.value.restore.manifestDigestB64 !== input.manifest.manifestDigestB64
  ) {
    return { ok: false, error: { code: "restore_conflict" } };
  }

  const statements: D1PreparedStatement[] = [];

  for (const object of input.manifest.objects) {
    statements.push(
      prepareRestoreItemInsert({
        db: input.env.DB,
        restoreId: record.value.restore.restoreId,
        object,
        now: input.now,
      }),
    );
  }

  if (statements.length > 0) {
    await input.env.DB.batch(statements);
  }

  const items = await readRestoreItems(
    input.env.DB,
    record.value.restore.restoreId,
    record.value.manifest,
  );

  if (!items.ok) {
    return items;
  }

  return items.value.length === input.manifest.objects.length
    ? { ok: true, value: record.value.restore }
    : { ok: false, error: { code: "restore_inventory_changed" } };
}

export async function resumeActorRestore(input: {
  readonly env: RestoreBindings;
  readonly restoreId: ActorRestoreId;
  readonly now: number;
}): Promise<Result<ActorRestore, ActorRestoreError>> {
  const recordResult = await readRestoreById(input.env.DB, input.restoreId);

  if (!recordResult.ok) {
    return recordResult;
  }

  if (
    recordResult.value.restore.status === "complete" ||
    recordResult.value.restore.status === "abandoned"
  ) {
    return { ok: true, value: recordResult.value.restore };
  }

  if (recordResult.value.restore.status === "quarantined") {
    return {
      ok: false,
      error: {
        code: "restore_quarantined",
        reason: recordResult.value.restore.quarantineReason,
      },
    };
  }

  let record: {
    readonly restore: LiveActorRestore;
    readonly manifest: ActorRestoreManifest;
  } = {
    restore: recordResult.value.restore,
    manifest: recordResult.value.manifest,
  };
  const moveResult = await readOrganisationPlacementMove({
    db: input.env.DB,
    organisationId: record.restore.organisationId,
    sourcePlacementEpoch: record.restore.localSourcePlacementEpoch,
    targetPlacementEpoch: record.restore.targetPlacementEpoch,
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

  if (isReservedMove(move)) {
    const frozen = await freezeOrganisationPlacementMove(
      input.env.DB,
      move,
      { kind: "restore", operationId: record.restore.restoreId },
      input.now,
      sourceDatabase.value,
    );

    if (!frozen.ok) {
      return frozen;
    }

    move = frozen.value;
    await markRestoreFrozen(input.env.DB, record.restore.restoreId, input.now);
    const refreshed = await readLiveRestoreById(input.env.DB, input.restoreId);

    if (!refreshed.ok) {
      return refreshed;
    }

    record = refreshed.value;
  }

  if (isFrozenMove(move) && record.restore.status === "reserved") {
    await markRestoreFrozen(input.env.DB, record.restore.restoreId, input.now);
    const refreshed = await readLiveRestoreById(input.env.DB, input.restoreId);

    if (!refreshed.ok) {
      return refreshed;
    }

    record = refreshed.value;
  }

  if (isFrozenMove(move)) {
    const sourceFrozen = await freezeRegionalOrganisationPlacement(
      sourceDatabase.value,
      move,
    );
    if (!sourceFrozen.ok) return sourceFrozen;
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
    const provisioned = await provisionRegionalMoveTarget({
      sourceDatabase: sourceDatabase.value,
      targetDatabase: targetDatabase.value,
      move,
    });
    if (!provisioned.ok) return provisioned;
    const imported = await importRestoreObjects({
      env: input.env,
      namespaces: restoreNamespaces(input.env),
      record,
      move,
      now: input.now,
    });

    if (!imported.ok) {
      return imported;
    }

    const published = await publishOrganisationPlacementMove(
      input.env.DB,
      move,
      { kind: "restore", operationId: record.restore.restoreId },
      input.now,
    );

    if (!published.ok) {
      return published;
    }

    move = published.value;
    const refreshed = await readRestoreById(input.env.DB, input.restoreId);
    if (!refreshed.ok) return refreshed;
    if (refreshed.value.restore.status !== "published") {
      return { ok: false, error: { code: "restore_conflict" } };
    }
    record = {
      restore: refreshed.value.restore,
      manifest: refreshed.value.manifest,
    };
  }

  if (!isPublishedMove(move)) {
    return { ok: false, error: { code: "restore_conflict" } };
  }

  const targetsVerified = await verifyPublishedRestoreTargets({
    directory: input.env.DB,
    database: targetDatabase.value,
    record,
    targetPlacementEpoch: move.target.placement.placementEpoch,
  });

  if (!targetsVerified.ok) {
    return targetsVerified;
  }
  const resumed = await resumeRegionalPlacement({
    sourceDatabase: sourceDatabase.value,
    targetDatabase: targetDatabase.value,
    move,
  });
  if (!resumed.ok) return resumed;

  if (record.restore.status !== "published") {
    return { ok: false, error: { code: "restore_conflict" } };
  }

  await markRestoreComplete(input.env.DB, record.restore.restoreId, input.now);

  const completed = await readRestoreById(input.env.DB, input.restoreId);
  return completed.ok
    ? { ok: true, value: completed.value.restore }
    : completed;
}

/**
 * The operator's exit from a restore that cannot finish: a quarantine after
 * the freeze, or an import that stopped. The restore is abandoned and its
 * target released; the frozen source is never reopened. A recovery
 * relocation moves the source to a new epoch in the source's cell and
 * publishes it, so the Organisation has an active placement again. A repeat
 * call resumes the recovery.
 */
export async function abandonActorRestore(input: {
  readonly env: RestoreBindings;
  readonly restoreId: ActorRestoreId;
  readonly now: number;
}): Promise<Result<ActorRestoreAbandonment, ActorRestoreError>> {
  const current = await readRestoreById(input.env.DB, input.restoreId);
  if (!current.ok) return current;
  if (current.value.restore.status !== "abandoned") {
    const recoveryId = newRecoveryRelocationId();
    const recoveryFence = `tpf_${crypto.randomUUID()}`;
    const db = input.env.DB;
    const abandonment = {
      kind: "restore",
      operationId: input.restoreId,
      recoveryId,
      now: input.now,
    } as const;
    await db.batch([
      prepareRestoreAbandon(db, {
        restoreId: input.restoreId,
        recoveryId,
        now: input.now,
      }),
      prepareAbandonedMoveSourceFreeze(db, abandonment),
      prepareAbandonedMoveTargetRelease(db, abandonment),
      prepareRecoveryTargetReservation(db, { ...abandonment, recoveryFence }),
      prepareRecoveryRelocationStart(db, { ...abandonment, recoveryFence }),
    ]);
  }
  const abandoned = await readRestoreById(input.env.DB, input.restoreId);
  if (!abandoned.ok) return abandoned;
  const restore = abandoned.value.restore;
  if (restore.status !== "abandoned")
    return { ok: false, error: { code: "restore_conflict" } };
  // The abandoned target epoch in its cell follows the global row.
  const target = await readPlacementByEpoch(
    input.env.DB,
    restore.organisationId,
    restore.targetPlacementEpoch,
  );
  if (!target.ok) return target;
  const targetDatabase = selectOrganisationPlacementDatabase(
    input.env,
    restore.organisationId,
    target.value.placement,
  );
  if (!targetDatabase.ok) return targetDatabase;
  await prepareRegionalTargetAbandon(targetDatabase.value, {
    organisationId: restore.organisationId,
    placementEpoch: restore.targetPlacementEpoch,
    abandonedAt: restore.abandonedAt,
  }).run();
  const recovery = await resumeActorRelocation({
    env: input.env,
    relocationId: restore.recoveryRelocationId,
    now: input.now,
  });
  return recovery.ok
    ? { ok: true, value: { restore, recovery: recovery.value } }
    : recovery;
}

function newRecoveryRelocationId(): ActorRelocationId {
  const parsed = parseActorRelocationId(`dor_move_${crypto.randomUUID()}`);
  if (!parsed.ok)
    throw new Error("generated recovery relocation id is invalid");
  return parsed.value;
}

export async function inspectActorRestore(input: {
  readonly db: GlobalDatabase;
  readonly restoreId: ActorRestoreId;
}): Promise<Result<ActorRestoreInspection, ActorRestoreError>> {
  const record = await readRestoreById(input.db, input.restoreId);

  if (!record.ok) {
    return record;
  }

  const items = await readRestoreItems(
    input.db,
    input.restoreId,
    record.value.manifest,
  );

  return items.ok
    ? {
        ok: true,
        value: {
          restore: record.value.restore,
          manifest: record.value.manifest,
          items: items.value,
        },
      }
    : items;
}

export function parseActorRestoreId(
  value: unknown,
): Result<ActorRestoreId, { readonly code: "invalid_restore_id" }> {
  return typeof value === "string" && /^dor_restore_[0-9a-f-]+$/.test(value)
    ? { ok: true, value: value as ActorRestoreId }
    : { ok: false, error: { code: "invalid_restore_id" } };
}

async function importRestoreObjects(input: {
  readonly env: RestoreBindings;
  readonly namespaces: ActorNamespaces;
  readonly record: {
    readonly restore: LiveActorRestore;
    readonly manifest: ActorRestoreManifest;
  };
  readonly move: FrozenOrganisationPlacementMove;
  readonly now: number;
}): Promise<Result<null, ActorRestoreError>> {
  const items = await readRestoreItems(
    input.env.DB,
    input.record.restore.restoreId,
    input.record.manifest,
  );

  if (!items.ok) {
    return items;
  }

  const targetDatabase = selectOrganisationPlacementDatabase(
    input.env,
    input.move.organisationId,
    input.move.target.placement,
  );
  if (!targetDatabase.ok) return targetDatabase;
  const inventory = await validateRestoreInventory({
    db: targetDatabase.value,
    record: input.record,
    items: items.value,
  });

  if (!inventory.ok) {
    await markRestoreQuarantined(input.env.DB, {
      restoreId: input.record.restore.restoreId,
      reason: inventory.error.code,
      now: input.now,
    });
    return inventory;
  }

  await markRestoreImporting(input.env.DB, input.record.restore.restoreId);

  for (const record of input.record.manifest.retiredActors) {
    const copied = await copyRetiredActorRegistryEntry({
      db: targetDatabase.value,
      source: record,
      admission: actorRestoreAdmission(
        input.move,
        input.record.restore.restoreId,
        record.identity,
      ),
    });
    if (!copied.ok) return copied;
  }

  for (const item of items.value) {
    if (item.status === "imported") {
      continue;
    }

    const target = await importActorCopyTarget({
      env: input.env,
      namespaces: input.namespaces,
      identity: item.object.identity,
      sourceSchemaVersion: item.object.sourceSchemaVersion,
      admission: actorRestoreAdmission(
        input.move,
        input.record.restore.restoreId,
        item.object.identity,
      ),
      exportRef: item.object.exportRef,
      now: input.now,
    });

    if (!target.ok) {
      if (definitiveActorImportFailure(target.error)) {
        await markRestoreQuarantined(input.env.DB, {
          restoreId: input.record.restore.restoreId,
          reason: target.error.code,
          now: input.now,
        });
        return {
          ok: false,
          error: { code: "restore_quarantined", reason: target.error.code },
        };
      }

      return target;
    }

    await markRestoreItemImported({
      db: input.env.DB,
      restoreId: input.record.restore.restoreId,
      object: item.object,
      targetRegistryId: target.value.registryId,
      now: input.now,
    });
  }

  const refreshedItems = await readRestoreItems(
    input.env.DB,
    input.record.restore.restoreId,
    input.record.manifest,
  );

  if (!refreshedItems.ok) {
    return refreshedItems;
  }

  return refreshedItems.value.every(isImportedRestoreItem)
    ? { ok: true, value: null }
    : { ok: false, error: { code: "restore_inventory_changed" } };
}

async function verifyPublishedRestoreTargets(input: {
  readonly directory: GlobalDatabase;
  readonly database: OrganisationDatabase;
  readonly record: {
    readonly restore: LiveActorRestore;
    readonly manifest: ActorRestoreManifest;
  };
  readonly targetPlacementEpoch: number;
}): Promise<Result<null, ActorRestoreError>> {
  const items = await readRestoreItems(
    input.directory,
    input.record.restore.restoreId,
    input.record.manifest,
  );
  const entries = await listRestoreRegistryEntries(
    input.database,
    input.record.restore.organisationId,
  );

  if (!items.ok) {
    return items;
  }

  if (!entries.ok) {
    return entries;
  }

  if (
    items.value.length + input.record.manifest.retiredActors.length !==
    entries.value.length
  ) {
    return { ok: false, error: { code: "restore_inventory_changed" } };
  }

  for (const retired of input.record.manifest.retiredActors) {
    const match = entries.value.find(
      matchesRetiredActorRecordReversed.bind(null, retired),
    );
    if (
      match === undefined ||
      match.placement.placementEpoch !== input.targetPlacementEpoch
    ) {
      return { ok: false, error: { code: "restore_inventory_changed" } };
    }
  }
  for (const item of items.value) {
    if (item.status !== "imported") {
      return { ok: false, error: { code: "restore_inventory_changed" } };
    }

    const target = findRegistryEntry(entries.value, item.targetRegistryId);

    if (
      target === null ||
      target.lifecycleStatus !== "active" ||
      target.placement.placementEpoch !== input.targetPlacementEpoch ||
      !sameRestoreObjectIdentity(target, item.object)
    ) {
      return { ok: false, error: { code: "restore_inventory_changed" } };
    }
  }

  return { ok: true, value: null };
}

function matchesRetiredActorRecordReversed(
  record: RetiredActorRecord,
  entry: ActorRegistryEntry,
): boolean {
  return matchesRetiredActorRecord(entry, record);
}

async function validateRestoreInventory(input: {
  readonly db: OrganisationDatabase;
  readonly record: {
    readonly restore: LiveActorRestore;
    readonly manifest: ActorRestoreManifest;
  };
  readonly items: readonly ActorRestoreItem[];
}): Promise<Result<null, ActorRestoreError>> {
  const entries = await listRestoreRegistryEntries(
    input.db,
    input.record.restore.organisationId,
  );

  if (!entries.ok) {
    return entries;
  }

  if (
    entries.value.length >
    input.items.length + input.record.manifest.retiredActors.length
  ) {
    return { ok: false, error: { code: "restore_inventory_changed" } };
  }

  for (const entry of entries.value) {
    if (
      entry.placement.placementEpoch !==
      input.record.restore.targetPlacementEpoch
    ) {
      return { ok: false, error: { code: "restore_target_not_clean" } };
    }

    if (
      entry.lifecycleStatus === "retired" &&
      input.record.manifest.retiredActors.some(
        matchesRetiredActorRecord.bind(null, entry),
      )
    )
      continue;
    const item = findRestoreItemByIdentity(input.items, entry);

    if (item === null) {
      return { ok: false, error: { code: "restore_inventory_changed" } };
    }
  }

  return { ok: true, value: null };
}

/**
 * The Organisation's registry entries in a cell, without the entries of an
 * abandoned epoch. An abandoned move left them behind, and its fence admits
 * nothing, so a restore after an abandoned one finds the cell clean.
 */
async function listRestoreRegistryEntries(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<Result<readonly ActorRegistryEntry[], ActorRegistryError>> {
  const entries = await listOrganisationActorRegistryEntries({
    db,
    organisationId,
  });
  if (!entries.ok) return entries;
  const abandoned = await db
    .prepare(
      `SELECT placement_epoch AS placementEpoch FROM organisation_placement
       WHERE organisation_id = ? AND status = 'abandoned'`,
    )
    .bind(organisationId)
    .all<{ placementEpoch: unknown }>();
  const epochs = new Set<unknown>();
  for (const row of abandoned.results) epochs.add(row.placementEpoch);
  return {
    ok: true,
    value: entries.value.filter(
      (entry) => !epochs.has(entry.placement.placementEpoch),
    ),
  };
}

async function assertCleanRestoreTarget(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<Result<null, ActorRestoreError>> {
  const entries = await listRestoreRegistryEntries(db, organisationId);

  return entries.ok && entries.value.length === 0
    ? { ok: true, value: null }
    : entries.ok
      ? { ok: false, error: { code: "restore_target_not_clean" } }
      : entries;
}

function prepareRestoreItemInsert(input: {
  readonly db: GlobalDatabase;
  readonly restoreId: ActorRestoreId;
  readonly object: ActorRestoreManifestObject;
  readonly now: number;
}): D1PreparedStatement {
  return input.db
    .prepare(
      `INSERT OR IGNORE INTO state_object_restore_item (
         restore_id,
         object_kind,
         logical_object_id,
         source_schema_version,
         source_state_version,
         export_id,
         export_key,
         export_organisation_id,
         export_payload_digest_b64,
         export_created_at,
         table_count,
         row_count,
         kv_entry_count,
         r2_object_count,
         r2_bytes,
         status,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(
      input.restoreId,
      input.object.identity.objectKind,
      input.object.identity.logicalObjectId,
      input.object.sourceSchemaVersion,
      input.object.sourceStateVersion,
      input.object.exportRef.exportId,
      input.object.exportRef.key,
      input.object.exportRef.organisationId,
      input.object.exportRef.payloadDigestB64,
      input.object.exportRef.createdAt,
      input.object.counts.tableCount,
      input.object.counts.rowCount,
      input.object.counts.kvEntryCount,
      input.object.counts.r2ObjectCount,
      input.object.counts.r2Bytes,
      input.now,
    );
}

async function markRestoreItemImported(input: {
  readonly db: GlobalDatabase;
  readonly restoreId: ActorRestoreId;
  readonly object: ActorRestoreManifestObject;
  readonly targetRegistryId: ActorRegistryId;
  readonly now: number;
}): Promise<void> {
  await input.db
    .prepare(
      `UPDATE state_object_restore_item
       SET status = 'imported', target_registry_id = ?, updated_at = ?
       WHERE restore_id = ?
         AND object_kind = ?
         AND logical_object_id = ?
         AND status IN ('pending', 'imported')`,
    )
    .bind(
      input.targetRegistryId,
      input.now,
      input.restoreId,
      input.object.identity.objectKind,
      input.object.identity.logicalObjectId,
    )
    .run();
}

async function readLiveRestoreById(
  db: GlobalDatabase,
  restoreId: ActorRestoreId,
): Promise<
  Result<
    {
      readonly restore: LiveActorRestore;
      readonly manifest: ActorRestoreManifest;
    },
    ActorRestoreError
  >
> {
  const record = await readRestoreById(db, restoreId);

  if (!record.ok) {
    return record;
  }

  switch (record.value.restore.status) {
    case "reserved":
    case "frozen":
    case "importing":
    case "published":
      return {
        ok: true,
        value: {
          restore: record.value.restore,
          manifest: record.value.manifest,
        },
      };
    case "complete":
    case "abandoned":
      return { ok: false, error: { code: "restore_conflict" } };
    case "quarantined":
      return {
        ok: false,
        error: {
          code: "restore_quarantined",
          reason: record.value.restore.quarantineReason,
        },
      };
    default:
      return assertNever(record.value.restore);
  }
}

async function readRestoreById(
  db: GlobalDatabase,
  restoreId: ActorRestoreId,
): Promise<Result<RestoreRecord, ActorRestoreError>> {
  const row = await db
    .prepare(`${restoreSelect()} WHERE restore_id = ?`)
    .bind(restoreId)
    .first<RestoreRow>();
  return parseRestoreRow(row);
}

async function readRestoreByPlacement(input: {
  readonly db: GlobalDatabase;
  readonly organisationId: OrganisationId;
  readonly localSourcePlacementEpoch: number;
  readonly targetPlacementEpoch: number;
}): Promise<Result<RestoreRecord, ActorRestoreError>> {
  const row = await input.db
    .prepare(
      `${restoreSelect()}
       WHERE organisation_id = ? AND local_source_placement_epoch = ? AND target_placement_epoch = ?`,
    )
    .bind(
      input.organisationId,
      input.localSourcePlacementEpoch,
      input.targetPlacementEpoch,
    )
    .first<RestoreRow>();
  return parseRestoreRow(row);
}

function restoreSelect(): string {
  return `SELECT
     restore_id AS restoreId,
     organisation_id AS organisationId,
     local_source_placement_epoch AS localSourcePlacementEpoch,
     target_placement_epoch AS targetPlacementEpoch,
     manifest_digest_b64 AS manifestDigestB64,
     manifest_json AS manifestJson,
     status,
     created_at AS createdAt,
     frozen_at AS frozenAt,
     published_at AS publishedAt,
     completed_at AS completedAt,
     quarantined_at AS quarantinedAt,
     quarantine_reason AS quarantineReason,
     abandoned_at AS abandonedAt,
     recovery_relocation_id AS recoveryRelocationId
   FROM state_object_restore`;
}

async function parseRestoreRow(
  row: RestoreRow | null,
): Promise<Result<RestoreRecord, ActorRestoreError>> {
  if (row === null) {
    return { ok: false, error: { code: "restore_missing" } };
  }

  if (typeof row.organisationId !== "string") {
    return restoreCorrupt();
  }

  const restoreId = parseActorRestoreId(row.restoreId);
  const organisationId = parseOrganisationId(row.organisationId);

  if (
    !restoreId.ok ||
    !organisationId.ok ||
    !isPositiveInteger(row.localSourcePlacementEpoch) ||
    !isPositiveInteger(row.targetPlacementEpoch) ||
    row.targetPlacementEpoch <= row.localSourcePlacementEpoch ||
    !isNonEmptyString(row.manifestDigestB64) ||
    !isNonEmptyString(row.manifestJson) ||
    !isNonNegativeInteger(row.createdAt)
  ) {
    return restoreCorrupt();
  }

  let rawManifest: unknown;

  try {
    rawManifest = JSON.parse(row.manifestJson);
  } catch {
    return restoreCorrupt();
  }

  const manifest = await parseActorRestoreManifest(rawManifest);

  if (
    !manifest.ok ||
    manifest.value.organisationId !== organisationId.value ||
    manifest.value.manifestDigestB64 !== row.manifestDigestB64
  ) {
    return restoreCorrupt();
  }

  const base: RestoreBase = {
    restoreId: restoreId.value,
    organisationId: organisationId.value,
    exportSourcePlacementEpoch: manifest.value.sourcePlacementEpoch,
    localSourcePlacementEpoch: row.localSourcePlacementEpoch,
    targetPlacementEpoch: row.targetPlacementEpoch,
    manifestDigestB64: row.manifestDigestB64,
    createdAt: row.createdAt,
  };
  const restore = parseRestoreLifecycle(base, row);

  return restore.ok
    ? { ok: true, value: { restore: restore.value, manifest: manifest.value } }
    : restore;
}

function parseRestoreLifecycle(
  base: RestoreBase,
  row: RestoreRow,
): Result<ActorRestore, ActorRestoreError> {
  if (
    row.status !== "abandoned" &&
    !allNull(row.abandonedAt, row.recoveryRelocationId)
  )
    return restoreCorrupt();
  switch (row.status) {
    case "abandoned": {
      const recovery = parseActorRelocationId(row.recoveryRelocationId);
      return recovery.ok &&
        isNonNegativeInteger(row.frozenAt) &&
        isNonNegativeInteger(row.abandonedAt) &&
        allNull(
          row.publishedAt,
          row.completedAt,
          row.quarantinedAt,
          row.quarantineReason,
        )
        ? {
            ok: true,
            value: {
              restoreId: base.restoreId,
              organisationId: base.organisationId,
              exportSourcePlacementEpoch: base.exportSourcePlacementEpoch,
              localSourcePlacementEpoch: base.localSourcePlacementEpoch,
              targetPlacementEpoch: base.targetPlacementEpoch,
              manifestDigestB64: base.manifestDigestB64,
              createdAt: base.createdAt,
              status: row.status,
              frozenAt: row.frozenAt,
              abandonedAt: row.abandonedAt,
              recoveryRelocationId: recovery.value,
            },
          }
        : restoreCorrupt();
    }
    case "reserved":
      return allNull(
        row.frozenAt,
        row.publishedAt,
        row.completedAt,
        row.quarantinedAt,
        row.quarantineReason,
      )
        ? {
            ok: true,
            value: {
              restoreId: base.restoreId,
              organisationId: base.organisationId,
              exportSourcePlacementEpoch: base.exportSourcePlacementEpoch,
              localSourcePlacementEpoch: base.localSourcePlacementEpoch,
              targetPlacementEpoch: base.targetPlacementEpoch,
              manifestDigestB64: base.manifestDigestB64,
              createdAt: base.createdAt,
              status: row.status,
            },
          }
        : restoreCorrupt();
    case "frozen":
    case "importing":
      return isNonNegativeInteger(row.frozenAt) &&
        allNull(
          row.publishedAt,
          row.completedAt,
          row.quarantinedAt,
          row.quarantineReason,
        )
        ? {
            ok: true,
            value: {
              restoreId: base.restoreId,
              organisationId: base.organisationId,
              exportSourcePlacementEpoch: base.exportSourcePlacementEpoch,
              localSourcePlacementEpoch: base.localSourcePlacementEpoch,
              targetPlacementEpoch: base.targetPlacementEpoch,
              manifestDigestB64: base.manifestDigestB64,
              createdAt: base.createdAt,
              status: row.status,
              frozenAt: row.frozenAt,
            },
          }
        : restoreCorrupt();
    case "published":
      return isNonNegativeInteger(row.frozenAt) &&
        isNonNegativeInteger(row.publishedAt) &&
        allNull(row.completedAt, row.quarantinedAt, row.quarantineReason)
        ? {
            ok: true,
            value: {
              restoreId: base.restoreId,
              organisationId: base.organisationId,
              exportSourcePlacementEpoch: base.exportSourcePlacementEpoch,
              localSourcePlacementEpoch: base.localSourcePlacementEpoch,
              targetPlacementEpoch: base.targetPlacementEpoch,
              manifestDigestB64: base.manifestDigestB64,
              createdAt: base.createdAt,
              status: row.status,
              frozenAt: row.frozenAt,
              publishedAt: row.publishedAt,
            },
          }
        : restoreCorrupt();
    case "complete":
      return isNonNegativeInteger(row.frozenAt) &&
        isNonNegativeInteger(row.publishedAt) &&
        isNonNegativeInteger(row.completedAt) &&
        allNull(row.quarantinedAt, row.quarantineReason)
        ? {
            ok: true,
            value: {
              restoreId: base.restoreId,
              organisationId: base.organisationId,
              exportSourcePlacementEpoch: base.exportSourcePlacementEpoch,
              localSourcePlacementEpoch: base.localSourcePlacementEpoch,
              targetPlacementEpoch: base.targetPlacementEpoch,
              manifestDigestB64: base.manifestDigestB64,
              createdAt: base.createdAt,
              status: row.status,
              frozenAt: row.frozenAt,
              publishedAt: row.publishedAt,
              completedAt: row.completedAt,
            },
          }
        : restoreCorrupt();
    case "quarantined":
      return nullableTimestamp(row.frozenAt) &&
        nullableTimestamp(row.publishedAt) &&
        row.completedAt === null &&
        isNonNegativeInteger(row.quarantinedAt) &&
        isNonEmptyString(row.quarantineReason)
        ? {
            ok: true,
            value: {
              restoreId: base.restoreId,
              organisationId: base.organisationId,
              exportSourcePlacementEpoch: base.exportSourcePlacementEpoch,
              localSourcePlacementEpoch: base.localSourcePlacementEpoch,
              targetPlacementEpoch: base.targetPlacementEpoch,
              manifestDigestB64: base.manifestDigestB64,
              createdAt: base.createdAt,
              status: row.status,
              frozenAt: row.frozenAt,
              publishedAt: row.publishedAt,
              quarantinedAt: row.quarantinedAt,
              quarantineReason: row.quarantineReason,
            },
          }
        : restoreCorrupt();
    default:
      return restoreCorrupt();
  }
}

async function readRestoreItems(
  db: GlobalDatabase,
  restoreId: ActorRestoreId,
  manifest: ActorRestoreManifest,
): Promise<Result<readonly ActorRestoreItem[], ActorRestoreError>> {
  const rows = await db
    .prepare(
      `SELECT
         object_kind AS objectKind,
         logical_object_id AS logicalObjectId,
         source_schema_version AS sourceSchemaVersion,
         source_state_version AS sourceStateVersion,
         export_id AS exportId,
         export_key AS exportKey,
         export_organisation_id AS exportOrganisationId,
         export_payload_digest_b64 AS exportPayloadDigestB64,
         export_created_at AS exportCreatedAt,
         table_count AS tableCount,
         row_count AS rowCount,
         kv_entry_count AS kvEntryCount,
         r2_object_count AS r2ObjectCount,
         r2_bytes AS r2Bytes,
         target_registry_id AS targetRegistryId,
         status,
         updated_at AS updatedAt
       FROM state_object_restore_item
       WHERE restore_id = ?
       ORDER BY object_kind, logical_object_id`,
    )
    .bind(restoreId)
    .all<RestoreItemRow>();

  if (rows.results.length !== manifest.objects.length) {
    return { ok: false, error: { code: "restore_inventory_changed" } };
  }

  const items: ActorRestoreItem[] = [];

  for (let index = 0; index < rows.results.length; index += 1) {
    const object = manifest.objects[index];
    const row = rows.results[index];

    if (
      object === undefined ||
      row === undefined ||
      !isNonNegativeInteger(row.updatedAt) ||
      !restoreItemRowMatches(row, object)
    ) {
      return restoreCorrupt();
    }

    if (row.status === "pending" && row.targetRegistryId === null) {
      items.push({ object, status: row.status, updatedAt: row.updatedAt });
      continue;
    }

    if (row.status === "imported") {
      const targetRegistryId = parseActorRegistryId(row.targetRegistryId);

      if (targetRegistryId.ok) {
        items.push({
          object,
          status: row.status,
          targetRegistryId: targetRegistryId.value,
          updatedAt: row.updatedAt,
        });
        continue;
      }
    }

    return restoreCorrupt();
  }

  return { ok: true, value: items };
}

function restoreItemRowMatches(
  row: RestoreItemRow,
  object: ActorRestoreManifestObject,
): boolean {
  return (
    row.objectKind === object.identity.objectKind &&
    row.logicalObjectId === object.identity.logicalObjectId &&
    row.sourceSchemaVersion === object.sourceSchemaVersion &&
    row.sourceStateVersion === object.sourceStateVersion &&
    row.exportId === object.exportRef.exportId &&
    row.exportKey === object.exportRef.key &&
    row.exportOrganisationId === object.exportRef.organisationId &&
    row.exportPayloadDigestB64 === object.exportRef.payloadDigestB64 &&
    row.exportCreatedAt === object.exportRef.createdAt &&
    row.tableCount === object.counts.tableCount &&
    row.rowCount === object.counts.rowCount &&
    row.kvEntryCount === object.counts.kvEntryCount &&
    row.r2ObjectCount === object.counts.r2ObjectCount &&
    row.r2Bytes === object.counts.r2Bytes
  );
}

function findRestoreItemByIdentity(
  items: readonly ActorRestoreItem[],
  entry: ActorRegistryEntry,
): ActorRestoreItem | null {
  for (const item of items) {
    if (sameRestoreObjectIdentity(entry, item.object)) {
      return item;
    }
  }

  return null;
}

function findRegistryEntry(
  entries: readonly ActorRegistryEntry[],
  registryId: ActorRegistryId,
): ActorRegistryEntry | null {
  for (const entry of entries) {
    if (entry.registryId === registryId) {
      return entry;
    }
  }

  return null;
}

function sameRestoreObjectIdentity(
  entry: ActorRegistryEntry,
  object: ActorRestoreManifestObject,
): boolean {
  return (
    entry.identity.objectKind === object.identity.objectKind &&
    entry.identity.organisationId === object.identity.organisationId &&
    entry.identity.logicalObjectId === object.identity.logicalObjectId
  );
}

function isImportedRestoreItem(
  item: ActorRestoreItem,
): item is VariantBy<ActorRestoreItem, "status", "imported"> {
  return item.status === "imported";
}

function isReservedMove(
  move: OrganisationPlacementMove,
): move is ReservedOrganisationPlacementMove {
  return move.source.status === "active";
}

function isFrozenMove(
  move: OrganisationPlacementMove,
): move is FrozenOrganisationPlacementMove {
  return move.source.status === "frozen";
}

function isPublishedMove(
  move: OrganisationPlacementMove,
): move is PublishedOrganisationPlacementMove {
  return move.source.status === "retired";
}

function restoreNamespaces(env: RestoreBindings): ActorNamespaces {
  return {
    organisation: env.ORGANISATION,
    session: env.SESSION,
    case: env.CASE,
    connector: env.CONNECTOR,
  };
}

function newActorRestoreId(): ActorRestoreId {
  const parsed = parseActorRestoreId(`dor_restore_${crypto.randomUUID()}`);

  if (!parsed.ok) {
    throw new Error("generated actor restore id is invalid");
  }

  return parsed.value;
}

function restoreCorrupt(): Result<never, ActorRestoreError> {
  return { ok: false, error: { code: "restore_corrupt" } };
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
