/**
 * The `organisation_placement` row (Refactor 12). It is in both baselines, and
 * this module holds every write of it. See docs/history/refactor-12.md.
 *
 * The global row is the routing authority: a request finds its cell there. The
 * regional row is the execution fence: a write in the cell checks it in the
 * same batch. The global row leads. A move freezes the global row first and the
 * regional row in its next step, and it publishes the global rows first and
 * the regional rows next (regional-move.ts). A stopped relocation resumes, or
 * it is abandoned after the publication budget, 5 minutes. Onboarding and a
 * Slack install activate the regional row first and the global row last; the
 * scheduled onboarding run activates a global row that a stopped request left
 * reserved (`publishStoppedInitialPlacement`).
 */
import {
  sameBinding,
  type GlobalDatabase,
  type OrganisationDatabase,
} from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import {
  parseOrganisationPlacement,
  type InitialOrganisationPlacement,
  type OrganisationPlacement,
} from "../../placement";
import type { Result } from "@purin-labs/kernel/result";
import type {
  GlobalQuerySource,
  OrganisationQuerySource,
  QuerySource,
} from "../query-source";
import type {
  OrganisationBootstrapReservation,
  OrganisationEnvironment,
} from "../control-plane";
import { assertNever, isNonNegativeInteger } from "@purin-labs/std";
import {
  abandonedMoveRecoversSql,
  preparePlacementMovePublication,
  type PlacementMoveKind,
} from "../placement-move";
import {
  type FrozenOrganisationPlacementMove,
  ORGANISATION_RELOCATION_PUBLICATION_BUDGET_MS,
  type OrganisationPlacementError,
  type OrganisationPlacementFenceToken,
  type OrganisationPlacementMoveTarget,
  type OrganisationPlacementPublication,
  type PublishedOrganisationPlacementMove,
  type ReservedOrganisationPlacementMove,
  parseOrganisationPlacementFenceToken,
  placementCorrupt,
  placementMoveConflict,
  readPlacementByEpoch,
  readPlacementByStatus,
  resolveActiveOrganisationPlacement,
  samePlacement,
} from "../organisation-placement";

export async function ensureInitialOrganisationPlacement(input: {
  readonly db: D1Database;
  readonly organisationId: OrganisationId;
  readonly environment: "development" | "production";
  readonly placement: InitialOrganisationPlacement;
  readonly now: number;
}): Promise<Result<OrganisationPlacement, OrganisationPlacementError>> {
  await prepareInitialOrganisationPlacementInsert(
    input.db,
    input.organisationId,
    input.environment,
    input.placement,
    input.now,
  ).run();

  const active = await resolveActiveOrganisationPlacement(
    input.db,
    input.organisationId,
  );

  if (!active.ok) {
    return active;
  }

  return samePlacement(active.value, input.placement)
    ? active
    : {
        ok: false,
        error: {
          code: "organisation_placement_immutable",
          organisationId: input.organisationId,
        },
      };
}

export function prepareInitialOrganisationPlacementInsert(
  db: QuerySource,
  organisationId: OrganisationId,
  environment: "development" | "production",
  placement: InitialOrganisationPlacement,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO organisation_placement (
         organisation_id,
         placement_epoch,
         placement_kind,
         placement_cell_id,
         location_hint,
         residency_jurisdiction,
         status,
         fence_token,
         created_at,
         activated_at,
         environment
       )
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .bind(
      organisationId,
      placement.placementEpoch,
      placement.kind,
      placement.placementCellId,
      placement.locationHint,
      placement.kind === "residency" ? placement.residencyJurisdiction : null,
      crypto.randomUUID(),
      now,
      now,
      environment,
    );
}

export async function reserveOrganisationPlacementMove(input: {
  readonly db: GlobalDatabase;
  readonly organisationId: OrganisationId;
  readonly target: OrganisationPlacementMoveTarget;
  readonly now: number;
}): Promise<
  Result<ReservedOrganisationPlacementMove, OrganisationPlacementError>
> {
  const session = input.db.withSession("first-primary");
  const source = await readPlacementByStatus(
    session,
    input.organisationId,
    "active",
  );

  if (!source.ok || source.value.status !== "active") {
    return source.ok ? placementMoveConflict(input.organisationId) : source;
  }

  const existing = await readPlacementByStatus(
    session,
    input.organisationId,
    "reserved",
  );
  const highest = await session
    .prepare(
      "SELECT MAX(placement_epoch) AS epoch FROM organisation_placement WHERE organisation_id = ?",
    )
    .bind(input.organisationId)
    .first<{ epoch: number }>();
  if (highest === null || !isNonNegativeInteger(highest.epoch))
    return placementCorrupt(input.organisationId);
  if (!existing.ok && existing.error.code !== "organisation_placement_missing")
    return existing;
  const targetPlacement = nextPlacement(
    existing.ok ? existing.value.placement.placementEpoch - 1 : highest.epoch,
    input.target,
    input.organisationId,
  );

  if (!targetPlacement.ok) {
    return placementCorrupt(input.organisationId);
  }

  const targetFenceToken = newOrganisationPlacementFenceToken();

  await session
    .prepare(
      `INSERT OR IGNORE INTO organisation_placement (
         organisation_id,
         placement_epoch,
         placement_kind,
         placement_cell_id,
         location_hint,
         residency_jurisdiction,
         status,
         fence_token,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
    )
    .bind(
      input.organisationId,
      targetPlacement.value.placementEpoch,
      targetPlacement.value.kind,
      targetPlacement.value.placementCellId,
      targetPlacement.value.locationHint,
      targetPlacement.value.kind === "residency"
        ? targetPlacement.value.residencyJurisdiction
        : null,
      targetFenceToken,
      input.now,
    )
    .run();

  const target = await readPlacementByEpoch(
    session,
    input.organisationId,
    targetPlacement.value.placementEpoch,
  );

  if (
    !target.ok ||
    target.value.status !== "reserved" ||
    !samePlacement(target.value.placement, targetPlacement.value)
  ) {
    return target.ok ? placementMoveConflict(input.organisationId) : target;
  }

  return {
    ok: true,
    value: {
      organisationId: input.organisationId,
      source: source.value,
      target: target.value,
    },
  };
}

const regionalFreezeReadiness = `
  AND NOT EXISTS (SELECT 1 FROM durable_object_registry registry
    WHERE registry.organisation_id = organisation_placement.organisation_id
      AND registry.placement_epoch = organisation_placement.placement_epoch
      AND registry.lifecycle_status = 'reserved')
  AND NOT EXISTS (SELECT 1 FROM provider_connection_attempt attempt
    WHERE attempt.organisation_id = organisation_placement.organisation_id
      AND attempt.lifecycle IN ('callback_received', 'provisioning'))
  AND NOT EXISTS (SELECT 1 FROM provider_account_cleanup cleanup
    WHERE cleanup.organisation_id = organisation_placement.organisation_id
      AND cleanup.lifecycle = 'running_provider_cleanup')`;

export async function freezeOrganisationPlacementMove(
  db: GlobalDatabase,
  move: ReservedOrganisationPlacementMove,
  publication: OrganisationPlacementPublication,
  now: number,
  sourceDatabase: OrganisationDatabase,
): Promise<
  Result<FrozenOrganisationPlacementMove, OrganisationPlacementError>
> {
  const session = db.withSession("first-primary");
  const journal = publicationJournal(publication);
  await session
    .prepare(
      `UPDATE organisation_placement
       SET status = 'frozen', frozen_at = ?
       WHERE organisation_id = ?
         AND placement_epoch = ?
         AND fence_token = ?
         AND status = 'active'
         ${sameBinding(sourceDatabase, db) ? regionalFreezeReadiness : ""}
         AND EXISTS (
           SELECT 1 FROM ${journal.table} operation
           JOIN organisation_placement target ON target.organisation_id = operation.organisation_id
             AND target.placement_epoch = operation.target_placement_epoch
           WHERE operation.${journal.idColumn} = ?
             AND operation.organisation_id = organisation_placement.organisation_id
             AND operation.${journal.sourceColumn} = organisation_placement.placement_epoch
             AND operation.target_placement_epoch = ? AND operation.status = 'reserved'
             AND target.fence_token = ? AND target.status = 'reserved'
         )`,
    )
    .bind(
      now,
      move.organisationId,
      move.source.placement.placementEpoch,
      move.source.fenceToken,
      publication.operationId,
      move.target.placement.placementEpoch,
      move.target.fenceToken,
    )
    .run();

  const source = await readPlacementByEpoch(
    session,
    move.organisationId,
    move.source.placement.placementEpoch,
  );
  const target = await readPlacementByEpoch(
    session,
    move.organisationId,
    move.target.placement.placementEpoch,
  );

  if (!source.ok) {
    return { ok: false, error: source.error };
  }

  if (!target.ok) {
    return { ok: false, error: target.error };
  }

  if (
    source.value.status !== "frozen" ||
    target.value.status !== "reserved" ||
    source.value.fenceToken !== move.source.fenceToken ||
    target.value.fenceToken !== move.target.fenceToken
  ) {
    return placementMoveConflict(move.organisationId);
  }

  return {
    ok: true,
    value: {
      organisationId: move.organisationId,
      source: source.value,
      target: target.value,
    },
  };
}

function publicationJournal(publication: OrganisationPlacementPublication) {
  switch (publication.kind) {
    case "relocation":
      return {
        table: "state_object_relocation",
        idColumn: "relocation_id",
        sourceColumn: "source_placement_epoch",
        readyStatus: "copying",
      };
    case "restore":
      return {
        table: "state_object_restore",
        idColumn: "restore_id",
        sourceColumn: "local_source_placement_epoch",
        readyStatus: "importing",
      };
    default:
      return assertNever(publication);
  }
}

export async function publishOrganisationPlacementMove(
  db: GlobalDatabase,
  move: FrozenOrganisationPlacementMove,
  publication: OrganisationPlacementPublication,
  now: number,
): Promise<
  Result<PublishedOrganisationPlacementMove, OrganisationPlacementError>
> {
  const session = db.withSession("first-primary");
  const journal = publicationJournal(publication);

  const dataReady =
    publication.kind === "relocation"
      ? `AND (operation.frozen_at > ? OR ${abandonedMoveRecoversSql("operation.relocation_id")})
       AND operation.source_quiesced_at IS NOT NULL AND operation.data_verified_at IS NOT NULL AND operation.data_table_count IS NOT NULL
       AND operation.data_table_count = (SELECT COUNT(*) FROM state_object_relocation_copy copied
         WHERE copied.relocation_id = operation.relocation_id AND copied.status = 'verified')
       AND NOT EXISTS (SELECT 1 FROM state_object_relocation_copy copied
         WHERE copied.relocation_id = operation.relocation_id AND copied.status <> 'verified')`
      : "";

  // Each write depends on its predecessor in this transaction. A rejected
  // publication cannot activate a target or advance its operation journal.
  const results = await session.batch([
    session
      .prepare(
        `UPDATE organisation_placement
         SET status = 'retired', retired_at = ?
         WHERE organisation_id = ?
           AND placement_epoch = ?
           AND fence_token = ?
           AND status = 'frozen'
           AND EXISTS (
             SELECT 1 FROM organisation_placement
             WHERE organisation_id = ? AND placement_epoch = ?
               AND fence_token = ? AND status = 'reserved'
           )
           AND EXISTS (
             SELECT 1 FROM ${journal.table} operation
             WHERE operation.${journal.idColumn} = ?
               AND operation.organisation_id = ?
               AND operation.${journal.sourceColumn} = ?
               AND operation.target_placement_epoch = ?
               AND operation.status = ? ${dataReady}
               AND NOT EXISTS (
                 SELECT 1 FROM ${journal.table}_item item
                 WHERE item.${journal.idColumn} = operation.${journal.idColumn}
                   AND item.status <> 'imported'
               )
           )`,
      )
      .bind(
        now,
        move.organisationId,
        move.source.placement.placementEpoch,
        move.source.fenceToken,
        move.organisationId,
        move.target.placement.placementEpoch,
        move.target.fenceToken,
        publication.operationId,
        move.organisationId,
        move.source.placement.placementEpoch,
        move.target.placement.placementEpoch,
        journal.readyStatus,
        ...(publication.kind === "relocation"
          ? [now - ORGANISATION_RELOCATION_PUBLICATION_BUDGET_MS]
          : []),
      ),
    session
      .prepare(
        `UPDATE organisation_placement
         SET status = 'active', activated_at = ?
         WHERE organisation_id = ?
           AND placement_epoch = ?
           AND fence_token = ?
           AND status = 'reserved'
           AND changes() = 1`,
      )
      .bind(
        now,
        move.organisationId,
        move.target.placement.placementEpoch,
        move.target.fenceToken,
      ),
    preparePlacementMovePublication(session, {
      kind: publication.kind,
      operationId: publication.operationId,
      now,
    }),
  ]);

  if (results.some(publicationWriteRejected)) {
    return placementMoveConflict(move.organisationId);
  }

  const source = await readPlacementByEpoch(
    session,
    move.organisationId,
    move.source.placement.placementEpoch,
  );
  const target = await readPlacementByEpoch(
    session,
    move.organisationId,
    move.target.placement.placementEpoch,
  );

  if (!source.ok) {
    return { ok: false, error: source.error };
  }

  if (!target.ok) {
    return { ok: false, error: target.error };
  }

  if (
    source.value.status !== "retired" ||
    target.value.status !== "active" ||
    source.value.fenceToken !== move.source.fenceToken ||
    target.value.fenceToken !== move.target.fenceToken
  ) {
    return placementMoveConflict(move.organisationId);
  }

  return {
    ok: true,
    value: {
      organisationId: move.organisationId,
      source: source.value,
      target: target.value,
    },
  };
}

function publicationWriteRejected(result: D1Result): boolean {
  return result.meta.changes !== 1;
}

function nextPlacement(
  lastEpoch: number,
  target: OrganisationPlacementMoveTarget,
  organisationId: OrganisationId,
): Result<OrganisationPlacement, OrganisationPlacementError> {
  if (lastEpoch >= Number.MAX_SAFE_INTEGER) {
    return placementCorrupt(organisationId);
  }

  const parsed = parseOrganisationPlacement({
    ...target,
    placementEpoch: lastEpoch + 1,
  });

  return parsed.ok ? parsed : placementCorrupt(organisationId);
}

function newOrganisationPlacementFenceToken(): OrganisationPlacementFenceToken {
  const token = parseOrganisationPlacementFenceToken(
    `tpf_${crypto.randomUUID()}`,
  );

  if (!token.ok) {
    throw new Error("generated organisation placement fence token is invalid");
  }

  return token.value;
}

/** Close the regional write fence after the directory freezes admission.
 * Retries must use the same epoch and token; no other placement can be frozen. */
export async function freezeRegionalOrganisationPlacement(
  database: OrganisationDatabase,
  move: FrozenOrganisationPlacementMove,
): Promise<Result<null, OrganisationPlacementError>> {
  const session = database.withSession("first-primary");
  await session
    .prepare(
      `UPDATE organisation_placement SET status = 'frozen', frozen_at = ?
      WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
        AND fence_token = ? AND status = 'active'
        ${regionalFreezeReadiness}`,
    )
    .bind(
      move.source.frozenAt,
      move.organisationId,
      move.source.placement.placementEpoch,
      move.source.placement.placementCellId,
      move.source.fenceToken,
    )
    .run();
  const source = await readPlacementByEpoch(
    session,
    move.organisationId,
    move.source.placement.placementEpoch,
  );
  if (!source.ok) return source;
  if (
    source.value.status !== "frozen" ||
    source.value.fenceToken !== move.source.fenceToken ||
    !samePlacement(source.value.placement, move.source.placement)
  ) {
    return placementMoveConflict(move.organisationId);
  }
  return { ok: true, value: null };
}

/** Onboarding reserves epoch 1 in the global database, then in the cell. */
export function prepareBootstrapPlacement(
  database: QuerySource,
  reservation: OrganisationBootstrapReservation,
  environment: OrganisationEnvironment,
): D1PreparedStatement {
  const placement = reservation.placement;
  return database
    .prepare(
      `INSERT OR IGNORE INTO organisation_placement (
      organisation_id, placement_epoch, placement_kind, placement_cell_id, location_hint,
      residency_jurisdiction, status, fence_token, created_at, environment
    ) VALUES (?, 1, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
    )
    .bind(
      reservation.organisationId,
      placement.kind,
      placement.placementCellId,
      placement.locationHint,
      placement.kind === "residency" ? placement.residencyJurisdiction : null,
      reservation.fenceToken,
      reservation.createdAt,
      environment,
    );
}

/**
 * Epoch 1 becomes active: in the cell when its rows are written, then in the
 * global database, which publishes the Organisation for routing.
 */
export function prepareInitialPlacementActivation(
  db: QuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    fenceToken: string;
    activatedAt: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation_placement SET status = 'active', activated_at = ?
     WHERE organisation_id = ? AND placement_epoch = 1 AND fence_token = ? AND status = 'reserved'`,
    )
    .bind(input.activatedAt, input.organisationId, input.fenceToken);
}

/** A Slack install reserves epoch 1 in the global database. */
export function prepareSlackInstallPlacementReservation(
  directory: GlobalQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    placement: InitialOrganisationPlacement;
    fenceToken: string;
    createdAt: number;
    environment: string;
  }>,
): D1PreparedStatement {
  return directory
    .prepare(
      `INSERT OR IGNORE INTO organisation_placement (
      organisation_id, placement_epoch, placement_kind, placement_cell_id, location_hint,
      residency_jurisdiction, status, fence_token, created_at, environment
    ) VALUES (?, 1, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
    )
    .bind(
      input.organisationId,
      input.placement.kind,
      input.placement.placementCellId,
      input.placement.locationHint,
      input.placement.kind === "residency"
        ? input.placement.residencyJurisdiction
        : null,
      input.fenceToken,
      input.createdAt,
      input.environment,
    );
}

/** A Slack install copies the global reservation into the cell as active. */
export function prepareSlackInstallRegionalPlacement(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    placement: InitialOrganisationPlacement;
    fenceToken: string;
    createdAt: number;
    environment: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO organisation_placement (
        organisation_id, placement_epoch, placement_kind, placement_cell_id, location_hint,
        residency_jurisdiction, status, fence_token, created_at, activated_at, environment
      ) VALUES (?, 1, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .bind(
      input.organisationId,
      input.placement.kind,
      input.placement.placementCellId,
      input.placement.locationHint,
      input.placement.kind === "residency"
        ? input.placement.residencyJurisdiction
        : null,
      input.fenceToken,
      input.createdAt,
      input.createdAt,
      input.environment,
    );
}

/**
 * The recovery of an abandoned move, in the global database: the source
 * freezes, the target is abandoned, and a new target epoch is reserved in the
 * source's cell. The journal row of the move, a relocation or a restore,
 * decides each one.
 */
type AbandonedMove = Readonly<{
  kind: PlacementMoveKind;
  operationId: string;
  recoveryId: string;
}>;

function abandonedMoveJournal(kind: PlacementMoveKind) {
  return kind === "relocation"
    ? {
        table: "state_object_relocation",
        idColumn: "relocation_id",
        sourceColumn: "source_placement_epoch",
      }
    : {
        table: "state_object_restore",
        idColumn: "restore_id",
        sourceColumn: "local_source_placement_epoch",
      };
}

export function prepareAbandonedMoveSourceFreeze(
  directory: GlobalQuerySource,
  input: AbandonedMove & Readonly<{ now: number }>,
): D1PreparedStatement {
  const journal = abandonedMoveJournal(input.kind);
  return directory
    .prepare(
      `UPDATE organisation_placement SET status = 'frozen', frozen_at = COALESCE(frozen_at, ?)
      WHERE status IN ('active', 'frozen') AND EXISTS (
        SELECT 1 FROM ${journal.table} operation WHERE operation.${journal.idColumn} = ?
          AND operation.status = 'abandoned' AND operation.recovery_relocation_id = ?
          AND operation.organisation_id = organisation_placement.organisation_id
          AND operation.${journal.sourceColumn} = organisation_placement.placement_epoch)`,
    )
    .bind(input.now, input.operationId, input.recoveryId);
}

export function prepareAbandonedMoveTargetRelease(
  directory: GlobalQuerySource,
  input: AbandonedMove & Readonly<{ now: number }>,
): D1PreparedStatement {
  const journal = abandonedMoveJournal(input.kind);
  return directory
    .prepare(
      `UPDATE organisation_placement SET status = 'abandoned', abandoned_at = ?
      WHERE status = 'reserved' AND EXISTS (
        SELECT 1 FROM ${journal.table} operation WHERE operation.${journal.idColumn} = ?
          AND operation.status = 'abandoned' AND operation.recovery_relocation_id = ?
          AND operation.organisation_id = organisation_placement.organisation_id
          AND operation.target_placement_epoch = organisation_placement.placement_epoch)`,
    )
    .bind(input.now, input.operationId, input.recoveryId);
}

export function prepareRecoveryTargetReservation(
  directory: GlobalQuerySource,
  input: AbandonedMove &
    Readonly<{
      recoveryFence: string;
      now: number;
    }>,
): D1PreparedStatement {
  const journal = abandonedMoveJournal(input.kind);
  return directory
    .prepare(
      `INSERT INTO organisation_placement (
        organisation_id, placement_epoch, placement_kind, placement_cell_id, location_hint,
        residency_jurisdiction, status, fence_token, created_at, environment
      ) SELECT source.organisation_id,
        (SELECT MAX(placement_epoch) + 1 FROM organisation_placement WHERE organisation_id = source.organisation_id),
        source.placement_kind, source.placement_cell_id, source.location_hint,
        source.residency_jurisdiction, 'reserved', ?, ?, source.environment
      FROM ${journal.table} operation JOIN organisation_placement source
        ON source.organisation_id = operation.organisation_id AND source.placement_epoch = operation.${journal.sourceColumn}
      WHERE operation.${journal.idColumn} = ? AND operation.status = 'abandoned'
        AND operation.recovery_relocation_id = ? AND source.status = 'frozen'`,
    )
    .bind(input.recoveryFence, input.now, input.operationId, input.recoveryId);
}

/** The abandoned target epoch in its cell follows the global row. */
export function prepareRegionalTargetAbandon(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    placementEpoch: number;
    abandonedAt: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation_placement SET status = 'abandoned', abandoned_at = ?
    WHERE organisation_id = ? AND placement_epoch = ? AND status = 'reserved'`,
    )
    .bind(input.abandonedAt, input.organisationId, input.placementEpoch);
}

/**
 * Before the regional freeze, a relocation can give the source its admission
 * back: the frozen global source becomes active while the target is still
 * reserved and the source has not quiesced.
 */
export function prepareSourceAdmissionRestore(
  directory: GlobalQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    sourcePlacementEpoch: number;
    sourceFenceToken: string;
    relocationId: string;
    targetFenceToken: string;
  }>,
): D1PreparedStatement {
  return directory
    .prepare(
      `UPDATE organisation_placement SET status = 'active', frozen_at = NULL
      WHERE organisation_id = ? AND placement_epoch = ? AND fence_token = ? AND status = 'frozen'
        AND EXISTS (SELECT 1 FROM state_object_relocation operation
          JOIN organisation_placement target ON target.organisation_id = operation.organisation_id
            AND target.placement_epoch = operation.target_placement_epoch
          WHERE operation.relocation_id = ? AND operation.organisation_id = organisation_placement.organisation_id
            AND operation.source_placement_epoch = organisation_placement.placement_epoch
            AND operation.status = 'frozen' AND operation.source_quiesced_at IS NULL
            AND target.status = 'reserved' AND target.fence_token = ?)`,
    )
    .bind(
      input.organisationId,
      input.sourcePlacementEpoch,
      input.sourceFenceToken,
      input.relocationId,
      input.targetFenceToken,
    );
}

/**
 * Onboarding and an install activate epoch 1 in the cell, with the cell's
 * rows, before the global row. A request that stops between the two leaves the
 * global row reserved, and the Organisation does not route. The scheduled
 * onboarding run calls this for each Organisation that has an onboarding row
 * in the cell: it activates the global row when the cell's epoch 1 is active
 * with the same fence token. It is true when it activated the row.
 */
export async function publishStoppedInitialPlacement(input: {
  readonly directory: GlobalDatabase;
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
}): Promise<boolean> {
  const directory = input.directory.withSession("first-primary");
  const published = await readPlacementByEpoch(
    directory,
    input.organisationId,
    1,
  );
  if (!published.ok || published.value.status !== "reserved") return false;
  const local = await readPlacementByEpoch(
    input.db.withSession("first-primary"),
    input.organisationId,
    1,
  );
  if (
    !local.ok ||
    local.value.status !== "active" ||
    local.value.fenceToken !== published.value.fenceToken ||
    !samePlacement(local.value.placement, published.value.placement)
  )
    return false;
  const result = await prepareInitialPlacementActivation(directory, {
    organisationId: input.organisationId,
    fenceToken: published.value.fenceToken,
    activatedAt: local.value.activatedAt,
  }).run();
  return result.meta.changes === 1;
}
