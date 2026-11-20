/**
 * The one writer of a placement move's state (Refactor 15, refactor 5): the
 * `status` of `state_object_relocation` and of `state_object_restore`. Each
 * move of `PLACEMENT_MOVE_MACHINE` is one statement here; its `from` states
 * come from the machine, so a statement cannot move a journal row in a way
 * that the machine does not allow. The flows in `actors/actor-relocation.ts`
 * and `actors/actor-restore.ts` decide when to move; they write no status.
 *
 * An Organisation has one open move. A journal row is open while it holds the
 * source or the target of its move: from `reserved` to `published`, and in
 * `quarantined`. A start of either kind refuses while a move of the other
 * kind is open, in the same statement that inserts the row.
 */
import type { MachineEvent } from "@purin-labs/std/state-machine";

import type { GlobalDatabase } from "../database-handles";
import type { OrganisationId } from "../ids";
import type { GlobalQuerySource } from "./query-source";
import { PLACEMENT_MOVE_MACHINE } from "./placement-move.machine";

type PlacementMoveEvent = MachineEvent<typeof PLACEMENT_MOVE_MACHINE>;

export type PlacementMoveKind = "relocation" | "restore";

type OpenPlacementMove = Readonly<{
  kind: PlacementMoveKind;
  operationId: string;
}>;

export type PlacementMoveOpenError = Readonly<{
  code: "placement_move_open";
  kind: PlacementMoveKind;
  operationId: string;
}>;

/** The states in which a journal row holds its source or its target. */
const OPEN_STATES = sqlList([
  "reserved",
  "frozen",
  "copying",
  "importing",
  "published",
  "quarantined",
]);

/** The restore states after which no import reads an export again. */
const ENDED_RESTORE_STATES = sqlList(["complete", "quarantined", "abandoned"]);

/** The provider cleanup states that no later attempt leaves. */
const ENDED_PROVIDER_CLEANUP_STATES = sqlList([
  "completed",
  "manual_action_required",
]);

function sqlList(states: readonly string[]): string {
  return states.map((state) => `'${state}'`).join(", ");
}

/** The SQL of one move: its target state and the states it may leave. */
function move(event: PlacementMoveEvent): Readonly<{
  to: string;
  from: string;
}> {
  for (const transition of PLACEMENT_MOVE_MACHINE.transitions)
    if (transition.event === event)
      return { to: `'${transition.to}'`, from: sqlList(transition.from) };
  throw new Error(`placement_move_event_unknown:${event}`);
}

function openMoveOf(kind: PlacementMoveKind, organisation: string): string {
  return kind === "relocation"
    ? `EXISTS (SELECT 1 FROM state_object_relocation open_move
        WHERE open_move.organisation_id = ${organisation} AND open_move.status IN (${OPEN_STATES}))`
    : `EXISTS (SELECT 1 FROM state_object_restore open_move
        WHERE open_move.organisation_id = ${organisation} AND open_move.status IN (${OPEN_STATES}))`;
}

/** The open move of the Organisation, of either kind, or null. */
async function readOpenPlacementMove(
  directory: GlobalQuerySource,
  organisationId: OrganisationId,
): Promise<OpenPlacementMove | null> {
  const row = await directory
    .prepare(
      `SELECT 'relocation' AS kind, relocation_id AS operationId FROM state_object_relocation
        WHERE organisation_id = ? AND status IN (${OPEN_STATES})
       UNION ALL
       SELECT 'restore' AS kind, restore_id AS operationId FROM state_object_restore
        WHERE organisation_id = ? AND status IN (${OPEN_STATES})
       LIMIT 1`,
    )
    .bind(organisationId, organisationId)
    .first<{ kind: PlacementMoveKind; operationId: string }>();
  return row === null ? null : { kind: row.kind, operationId: row.operationId };
}

/** The refusal of a start while a move of the other kind is open. */
export async function placementMoveOpenOfOtherKind(
  directory: GlobalQuerySource,
  organisationId: OrganisationId,
  kind: PlacementMoveKind,
): Promise<PlacementMoveOpenError | null> {
  const open = await readOpenPlacementMove(directory, organisationId);
  return open === null || open.kind === kind
    ? null
    : {
        code: "placement_move_open",
        kind: open.kind,
        operationId: open.operationId,
      };
}

// --- Relocation journal -----------------------------------------------------

export function prepareRelocationStart(
  directory: GlobalQuerySource,
  input: Readonly<{
    relocationId: string;
    organisationId: OrganisationId;
    sourcePlacementEpoch: number;
    targetPlacementEpoch: number;
    now: number;
    rowCount: number;
    tableCount: number;
    actorBytes: number;
    actorCount: number;
  }>,
): D1PreparedStatement {
  return directory
    .prepare(
      `INSERT OR IGNORE INTO state_object_relocation (
         relocation_id, organisation_id, source_placement_epoch, target_placement_epoch,
         status, created_at, preflight_at, preflight_row_count, preflight_table_count,
         preflight_actor_bytes, preflight_actor_count
       )
       SELECT ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?
       WHERE NOT ${openMoveOf("restore", "?")}`,
    )
    .bind(
      input.relocationId,
      input.organisationId,
      input.sourcePlacementEpoch,
      input.targetPlacementEpoch,
      input.now,
      input.now,
      input.rowCount,
      input.tableCount,
      input.actorBytes,
      input.actorCount,
      input.organisationId,
    );
}

export async function markRelocationFrozen(
  directory: GlobalDatabase,
  relocationId: string,
  now: number,
): Promise<void> {
  const freeze = move("freeze");
  await directory
    .prepare(
      `UPDATE state_object_relocation SET status = ${freeze.to}, frozen_at = ?
       WHERE relocation_id = ? AND status IN (${freeze.from})`,
    )
    .bind(now, relocationId)
    .run();
}

/**
 * A rejected regional freeze gives the relocation back its reservation, in
 * the batch that gives the source its admission back.
 */
export function prepareRelocationFreezeRelease(
  directory: GlobalQuerySource,
  relocationId: string,
): D1PreparedStatement {
  const release = move("release");
  return directory
    .prepare(
      `UPDATE state_object_relocation SET status = ${release.to}, frozen_at = NULL
       WHERE relocation_id = ? AND status IN (${release.from})
         AND source_quiesced_at IS NULL AND changes() = 1`,
    )
    .bind(relocationId);
}

export async function markRelocationCopying(
  directory: GlobalDatabase,
  relocationId: string,
): Promise<void> {
  const copy = move("copy");
  await directory
    .prepare(
      `UPDATE state_object_relocation SET status = ${copy.to}
       WHERE relocation_id = ? AND status IN (${copy.from})`,
    )
    .bind(relocationId)
    .run();
}

export async function markRelocationRetained(
  directory: GlobalDatabase,
  input: Readonly<{
    relocationId: string;
    resumedAt: number;
    retainUntil: number;
  }>,
): Promise<void> {
  const retain = move("retain");
  await directory
    .prepare(
      `UPDATE state_object_relocation
       SET status = ${retain.to}, resumed_at = ?, retain_until = ?
       WHERE relocation_id = ? AND status IN (${retain.from})`,
    )
    .bind(input.resumedAt, input.retainUntil, input.relocationId)
    .run();
}

/**
 * The cleanup starts when the retention ended or was waived, when the copy
 * was verified, and when no restore of the Organisation can still read an
 * export. A restore that completed, quarantined or was abandoned reads none.
 */
export async function markRelocationCleaning(
  directory: GlobalDatabase,
  relocationId: string,
  now: number,
): Promise<void> {
  const clean = move("clean");
  await directory
    .prepare(
      `UPDATE state_object_relocation SET status = ${clean.to}
       WHERE relocation_id = ? AND status IN (${clean.from})
         AND (retain_until <= ? OR retention_waived_at IS NOT NULL)
         AND source_quiesced_at IS NOT NULL AND data_verified_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM state_object_restore restore
           WHERE restore.organisation_id = state_object_relocation.organisation_id
             AND restore.status NOT IN (${ENDED_RESTORE_STATES}))`,
    )
    .bind(relocationId, now)
    .run();
}

/** The provider work that still holds a relocation's cleanup. */
export function unresolvedProviderWorkQuery(): string {
  return `SELECT 1 FROM provider_account_cleanup
    WHERE organisation_id = ? AND lifecycle NOT IN (${ENDED_PROVIDER_CLEANUP_STATES})
    UNION ALL SELECT 1 FROM provider_connection_attempt
    WHERE organisation_id = ? AND lifecycle IN ('callback_received', 'provisioning') LIMIT 1`;
}

export async function markRelocationComplete(
  directory: GlobalDatabase,
  relocationId: string,
  now: number,
): Promise<void> {
  const complete = move("complete");
  await directory
    .prepare(
      `UPDATE state_object_relocation SET status = ${complete.to}, completed_at = ?
       WHERE relocation_id = ? AND status IN (${complete.from}) AND status = 'cleaning'
         AND NOT EXISTS (SELECT 1 FROM state_object_relocation_item item
           WHERE item.relocation_id = state_object_relocation.relocation_id
             AND item.source_cleaned_at IS NULL)`,
    )
    .bind(now, relocationId)
    .run();
}

export async function markRelocationQuarantined(
  directory: GlobalDatabase,
  input: Readonly<{ relocationId: string; reason: string; now: number }>,
): Promise<void> {
  const quarantine = move("quarantine");
  await directory
    .prepare(
      `UPDATE state_object_relocation
       SET status = ${quarantine.to}, quarantined_at = ?, quarantine_reason = ?
       WHERE relocation_id = ? AND status IN (${quarantine.from})`,
    )
    .bind(input.now, input.reason, input.relocationId)
    .run();
}

/**
 * The abandon of a relocation that has not published, while its target is
 * still reserved. The same batch freezes the source, releases the target and
 * reserves the recovery epoch (`placement-row.ts`).
 */
export function prepareRelocationAbandon(
  directory: GlobalQuerySource,
  input: Readonly<{ relocationId: string; recoveryId: string; now: number }>,
): D1PreparedStatement {
  const abandon = move("abandon");
  return directory
    .prepare(
      `UPDATE state_object_relocation
       SET status = ${abandon.to}, abandoned_at = ?, recovery_relocation_id = ?,
         frozen_at = COALESCE(frozen_at, ?), quarantined_at = NULL, quarantine_reason = NULL
       WHERE relocation_id = ? AND status IN (${abandon.from})
         AND published_at IS NULL
         AND EXISTS (SELECT 1 FROM organisation_placement source
           JOIN organisation_placement target ON target.organisation_id = source.organisation_id
           WHERE source.organisation_id = state_object_relocation.organisation_id
             AND source.placement_epoch = state_object_relocation.source_placement_epoch
             AND source.status IN ('active', 'frozen')
             AND target.placement_epoch = state_object_relocation.target_placement_epoch
             AND target.status = 'reserved')`,
    )
    .bind(input.now, input.recoveryId, input.now, input.relocationId);
}

/**
 * The recovery relocation of an abandoned move: from the frozen source to the
 * recovery epoch that the same batch reserved in the source's cell. It starts
 * `frozen`, so its resume quiesces the source and publishes the new epoch.
 */
export function prepareRecoveryRelocationStart(
  directory: GlobalQuerySource,
  input: Readonly<{
    kind: PlacementMoveKind;
    operationId: string;
    recoveryId: string;
    recoveryFence: string;
    now: number;
  }>,
): D1PreparedStatement {
  const sql =
    input.kind === "relocation"
      ? `INSERT INTO state_object_relocation (
           relocation_id, organisation_id, source_placement_epoch, target_placement_epoch,
           status, created_at, frozen_at, preflight_at, preflight_row_count,
           preflight_table_count, preflight_actor_bytes, preflight_actor_count
         ) SELECT ?, operation.organisation_id, operation.source_placement_epoch, target.placement_epoch,
           'frozen', ?, source.frozen_at, operation.preflight_at, operation.preflight_row_count,
           0, operation.preflight_actor_bytes, operation.preflight_actor_count
         FROM state_object_relocation operation JOIN organisation_placement source
           ON source.organisation_id = operation.organisation_id AND source.placement_epoch = operation.source_placement_epoch
         JOIN organisation_placement target ON target.organisation_id = operation.organisation_id AND target.fence_token = ?
         WHERE operation.relocation_id = ? AND operation.status = 'abandoned'
           AND operation.recovery_relocation_id = ? AND target.status = 'reserved'`
      : `INSERT INTO state_object_relocation (
           relocation_id, organisation_id, source_placement_epoch, target_placement_epoch,
           status, created_at, frozen_at, preflight_at, preflight_row_count,
           preflight_table_count, preflight_actor_bytes, preflight_actor_count
         ) SELECT ?, operation.organisation_id, operation.local_source_placement_epoch, target.placement_epoch,
           'frozen', ?, source.frozen_at, operation.abandoned_at, 0, 0, 0, 0
         FROM state_object_restore operation JOIN organisation_placement source
           ON source.organisation_id = operation.organisation_id AND source.placement_epoch = operation.local_source_placement_epoch
         JOIN organisation_placement target ON target.organisation_id = operation.organisation_id AND target.fence_token = ?
         WHERE operation.restore_id = ? AND operation.status = 'abandoned'
           AND operation.recovery_relocation_id = ? AND target.status = 'reserved'`;
  return directory
    .prepare(sql)
    .bind(
      input.recoveryId,
      input.now,
      input.recoveryFence,
      input.operationId,
      input.recoveryId,
    );
}

/** True when an abandoned move of either kind names this recovery. */
export function abandonedMoveRecoversSql(operation: string): string {
  return `(EXISTS (SELECT 1 FROM state_object_relocation abandoned
      WHERE abandoned.status = 'abandoned' AND abandoned.recovery_relocation_id = ${operation})
    OR EXISTS (SELECT 1 FROM state_object_restore abandoned
      WHERE abandoned.status = 'abandoned' AND abandoned.recovery_relocation_id = ${operation}))`;
}

// --- Restore journal --------------------------------------------------------

/**
 * A restore starts only when no relocation of the Organisation is open, and
 * when no relocation that holds one of its exports is cleaning or complete.
 */
export function prepareRestoreStart(
  directory: GlobalQuerySource,
  input: Readonly<{
    restoreId: string;
    organisationId: OrganisationId;
    localSourcePlacementEpoch: number;
    targetPlacementEpoch: number;
    manifestDigestB64: string;
    manifestJson: string;
    now: number;
  }>,
): D1PreparedStatement {
  return directory
    .prepare(
      `INSERT OR IGNORE INTO state_object_restore (
         restore_id, organisation_id, local_source_placement_epoch, target_placement_epoch,
         manifest_digest_b64, manifest_json, status, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, 'reserved', ?
       WHERE NOT ${openMoveOf("relocation", "?")}
       AND NOT EXISTS (
         SELECT 1 FROM state_object_relocation_item item
         JOIN state_object_relocation relocation ON relocation.relocation_id = item.relocation_id
         WHERE (relocation.status IN ('cleaning', 'complete') OR EXISTS (
           WITH RECURSIVE recovery AS (
             SELECT relocation_id, status, recovery_relocation_id FROM state_object_relocation
               WHERE relocation_id = relocation.recovery_relocation_id
             UNION SELECT successor.relocation_id, successor.status, successor.recovery_relocation_id
               FROM state_object_relocation successor JOIN recovery predecessor
                 ON successor.relocation_id = predecessor.recovery_relocation_id
               WHERE predecessor.status = 'abandoned'
           ) SELECT 1 FROM recovery WHERE status IN ('cleaning', 'complete')
         ))
           AND item.export_id IN (
             SELECT json_extract(value, '$.exportRef.exportId') FROM json_each(?, '$.objects')
           )
       )`,
    )
    .bind(
      input.restoreId,
      input.organisationId,
      input.localSourcePlacementEpoch,
      input.targetPlacementEpoch,
      input.manifestDigestB64,
      input.manifestJson,
      input.now,
      input.organisationId,
      input.manifestJson,
    );
}

export async function markRestoreFrozen(
  directory: GlobalDatabase,
  restoreId: string,
  now: number,
): Promise<void> {
  const freeze = move("freeze");
  await directory
    .prepare(
      `UPDATE state_object_restore SET status = ${freeze.to}, frozen_at = ?
       WHERE restore_id = ? AND status IN (${freeze.from})`,
    )
    .bind(now, restoreId)
    .run();
}

export async function markRestoreImporting(
  directory: GlobalDatabase,
  restoreId: string,
): Promise<void> {
  const importing = move("import");
  await directory
    .prepare(
      `UPDATE state_object_restore SET status = ${importing.to}
       WHERE restore_id = ? AND status IN (${importing.from})`,
    )
    .bind(restoreId)
    .run();
}

export async function markRestoreComplete(
  directory: GlobalDatabase,
  restoreId: string,
  now: number,
): Promise<void> {
  const complete = move("complete");
  await directory
    .prepare(
      `UPDATE state_object_restore SET status = ${complete.to}, completed_at = ?
       WHERE restore_id = ? AND status IN (${complete.from}) AND status = 'published'`,
    )
    .bind(now, restoreId)
    .run();
}

export async function markRestoreQuarantined(
  directory: GlobalDatabase,
  input: Readonly<{ restoreId: string; reason: string; now: number }>,
): Promise<void> {
  const quarantine = move("quarantine");
  await directory
    .prepare(
      `UPDATE state_object_restore
       SET status = ${quarantine.to}, quarantined_at = ?, quarantine_reason = ?
       WHERE restore_id = ? AND status IN (${quarantine.from})`,
    )
    .bind(input.now, input.reason, input.restoreId)
    .run();
}

/** The abandon of a restore that has not published, as for a relocation. */
export function prepareRestoreAbandon(
  directory: GlobalQuerySource,
  input: Readonly<{ restoreId: string; recoveryId: string; now: number }>,
): D1PreparedStatement {
  const abandon = move("abandon");
  return directory
    .prepare(
      `UPDATE state_object_restore
       SET status = ${abandon.to}, abandoned_at = ?, recovery_relocation_id = ?,
         frozen_at = COALESCE(frozen_at, ?), quarantined_at = NULL, quarantine_reason = NULL
       WHERE restore_id = ? AND status IN (${abandon.from})
         AND published_at IS NULL
         AND EXISTS (SELECT 1 FROM organisation_placement source
           JOIN organisation_placement target ON target.organisation_id = source.organisation_id
           WHERE source.organisation_id = state_object_restore.organisation_id
             AND source.placement_epoch = state_object_restore.local_source_placement_epoch
             AND source.status IN ('active', 'frozen')
             AND target.placement_epoch = state_object_restore.target_placement_epoch
             AND target.status = 'reserved')`,
    )
    .bind(input.now, input.recoveryId, input.now, input.restoreId);
}

// --- Publication ------------------------------------------------------------

/**
 * The journal's publication, as the third statement of the publication batch
 * in `placement-row.ts`: it applies only when the two placement writes before
 * it did.
 */
export function preparePlacementMovePublication(
  directory: GlobalQuerySource,
  input: Readonly<{
    kind: PlacementMoveKind;
    operationId: string;
    now: number;
  }>,
): D1PreparedStatement {
  const publish = move("publish");
  const sql =
    input.kind === "relocation"
      ? `UPDATE state_object_relocation SET status = ${publish.to}, published_at = ?
         WHERE relocation_id = ? AND status IN (${publish.from}) AND changes() = 1`
      : `UPDATE state_object_restore SET status = ${publish.to}, published_at = ?
         WHERE restore_id = ? AND status IN (${publish.from}) AND changes() = 1`;
  return directory.prepare(sql).bind(input.now, input.operationId);
}

/** Waives the retention of a retained or cleaning relocation. A waiver keeps its time. */
export function prepareRelocationRetentionWaiver(
  globalDatabase: GlobalDatabase,
  input: Readonly<{ now: number; relocationId: string }>,
): D1PreparedStatement {
  return globalDatabase
    .prepare(
      `UPDATE state_object_relocation
         SET retention_waived_at = COALESCE(retention_waived_at, ?)
         WHERE relocation_id = ? AND status IN ('retained', 'cleaning')`,
    )
    .bind(input.now, input.relocationId);
}

/** Records that the source of a frozen or copying relocation stopped work. */
export function prepareRelocationSourceQuiesced(
  globalDatabase: GlobalDatabase,
  input: Readonly<{ now: number; relocationId: string }>,
): D1PreparedStatement {
  return globalDatabase
    .prepare(
      "UPDATE state_object_relocation SET source_quiesced_at = ? WHERE relocation_id = ? AND status IN ('frozen', 'copying')",
    )
    .bind(input.now, input.relocationId);
}

/** Records the verified copy of the data of a copying relocation. */
export function prepareRelocationDataVerified(
  globalDatabase: GlobalDatabase,
  input: Readonly<{ now: number; tableCount: number; relocationId: string }>,
): D1PreparedStatement {
  return globalDatabase
    .prepare(
      "UPDATE state_object_relocation SET data_verified_at = ?, data_table_count = ? WHERE relocation_id = ? AND status = 'copying'",
    )
    .bind(input.now, input.tableCount, input.relocationId);
}
