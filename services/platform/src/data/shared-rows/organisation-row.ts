/**
 * The `organisation` row (Refactor 12). It is in both baselines, and this
 * module holds every write of it. See docs/refactor-12.md.
 *
 * - Onboarding and a Slack install write both copies in the same request.
 * - The regional row is the record of name and status. A rename, an archive,
 *   a restore, a deletion and a purge write it in their fenced batch, and the
 *   same request then copies name and status to the global row
 *   (`copyOrganisationRowToDirectory`). If that copy fails, the scheduled
 *   onboarding run copies it (`publishOrganisationDirectoryRow`): the copies
 *   differ for at most one run, 15 minutes.
 * - A move provisions the row in the target cell (regional-move.ts) before
 *   the copy of the other rows, and cleanup blanks it in the old cell.
 */
import { traceWarn } from "../../observability";
import type {
  GlobalDatabase,
  OrganisationDatabase,
} from "../../database-handles";
import { newRequestId, type OrganisationId } from "../../ids";
import type { AuthoritativeRuntimeReceipt } from "../authoritative-runtime-cutover";
import type { OrganisationBootstrapReservation } from "../control-plane";
import type { OrganisationQuerySource, QuerySource } from "../query-source";

/** A condition that the statement joins with AND, and its values. */
export type RowGuard = Readonly<{
  sql: string;
  bindings: readonly unknown[];
}>;

type OrganisationRow = {
  readonly name: unknown;
  readonly status: unknown;
};

/**
 * The global directory keeps a copy of each Organisation's row. Handle
 * allocation reads it, and so do the jobs that list every Organisation. A
 * rename, an archive, a restore, a deletion and a purge write the regional
 * row. This copies its name and status to the directory. It reads the current
 * regional values, so it is safe to repeat.
 */
export async function publishOrganisationDirectoryRow(input: {
  readonly directory: GlobalDatabase;
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
}): Promise<boolean> {
  const row = await input.db
    .withSession("first-primary")
    .prepare("SELECT name, status FROM organisation WHERE organisation_id = ?")
    .bind(input.organisationId)
    .first<OrganisationRow>();
  if (
    row === null ||
    typeof row.name !== "string" ||
    typeof row.status !== "string"
  )
    return false;
  // A purge also gives up the handle, which handle allocation reads here.
  const result = await input.directory
    .prepare(
      `UPDATE organisation
       SET name = ?, status = ?,
           organisation_handle = CASE WHEN ? = 'purged' THEN NULL ELSE organisation_handle END
       WHERE organisation_id = ?
         AND (name != ? OR status != ? OR (? = 'purged' AND organisation_handle IS NOT NULL))`,
    )
    .bind(
      row.name,
      row.status,
      row.status,
      input.organisationId,
      row.name,
      row.status,
      row.status,
    )
    .run();
  return result.meta.changes === 1;
}

/**
 * The request's own copy of name and status after its regional commit. A
 * failure leaves the copy to the scheduled run; the regional row is the
 * record, so the request still succeeds.
 */
export async function copyOrganisationRowToDirectory(input: {
  readonly directory: GlobalDatabase;
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
}): Promise<void> {
  try {
    await publishOrganisationDirectoryRow(input);
  } catch (error) {
    traceWarn("organisation.directory_copy_deferred", {
      requestId: newRequestId(),
      organisation_id: input.organisationId,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Onboarding writes this row in both databases. */
export function prepareBootstrapOrganisationRow(
  database: QuerySource,
  reservation: OrganisationBootstrapReservation,
  organisationName: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT OR IGNORE INTO organisation (
      organisation_id, organisation_handle, name, plan, created_at, status,
      authoritative_runtime, runtime_cutover_state, cloudflare_prepared_at,
      cloudflare_activated_at, runtime_rollback_expires_at, first_cloudflare_write_at,
      runtime_rolled_back_at
    ) VALUES (?, ?, ?, 'beta', ?, 'active', 'cloudflare', 'cloudflare_forward_only', ?, ?, ?, ?, NULL)`,
    )
    .bind(
      reservation.organisationId,
      reservation.organisationHandle,
      organisationName,
      reservation.createdAt,
      reservation.createdAt,
      reservation.createdAt,
      reservation.createdAt + 1,
      reservation.createdAt,
    );
}

/** A Slack install writes this row in both databases. */
export function prepareSlackInstallOrganisationRow(
  db: QuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    teamName: string;
    now: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO organisation (
         organisation_id, name, plan, created_at, status,
         authoritative_runtime, runtime_cutover_state,
         cloudflare_prepared_at, cloudflare_activated_at,
         runtime_rollback_expires_at, first_cloudflare_write_at,
         runtime_rolled_back_at
       ) VALUES (
         ?, ?, 'beta', ?, 'active',
         'cloudflare', 'cloudflare_forward_only',
         ?, ?, ?, ?, NULL
       )`,
    )
    .bind(
      input.organisationId,
      input.teamName,
      input.now,
      input.now,
      input.now,
      input.now + 1,
      input.now,
    );
}

/** An install that predates onboarding writes the regional row. */
export function prepareInstallOrganisationRow(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    name: string;
    createdAt: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO organisation (organisation_id, name, plan, created_at, status)
         VALUES (?, ?, 'beta', ?, 'active')`,
    )
    .bind(input.organisationId, input.name, input.createdAt);
}

/**
 * A repeat install renames and reactivates the regional row, under the
 * guard that the Organisation is in use (Refactor 15).
 */
export function prepareInstallOrganisationRename(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    name: string;
    guard: RowGuard;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation
         SET name = ?, status = 'active'
         WHERE organisation_id = ? AND ${input.guard.sql}`,
    )
    .bind(input.name, input.organisationId, ...input.guard.bindings);
}

/** A rename of the regional row, under the lifecycle batch's guard. */
export function prepareOrganisationName(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    name: string;
    guard: RowGuard;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation SET name = ? WHERE organisation_id = ? AND ${input.guard.sql}`,
    )
    .bind(input.name, input.organisationId, ...input.guard.bindings);
}

/** An archive (`deleted`) or a restore (`active`) of the regional row. */
export function prepareOrganisationStatus(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    status: "active" | "deleted";
    guard: RowGuard;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation SET status = ? WHERE organisation_id = ? AND ${input.guard.sql}`,
    )
    .bind(input.status, input.organisationId, ...input.guard.bindings);
}

/**
 * An owner's deletion of an archived Organisation: the regional row loses its
 * name and stays `deleted` (archived) until its purge.
 */
export function prepareOrganisationDeletion(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    guard: RowGuard;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation SET name = 'Deleted organisation', status = 'deleted' WHERE organisation_id = ? AND ${input.guard.sql}`,
    )
    .bind(input.organisationId, ...input.guard.bindings);
}

/**
 * The purge: the regional row loses its name and its handle, so that a new
 * Organisation can take the handle, and says `purged`. `deleted` then means
 * only an archived Organisation (or a blank row in a retired cell). The guard
 * is the purge batch's lifecycle move.
 */
export function prepareOrganisationPurge(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    guard: RowGuard;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation
       SET name = 'Archived organisation', organisation_handle = NULL, status = 'purged'
       WHERE organisation_id = ? AND ${input.guard.sql}`,
    )
    .bind(input.organisationId, ...input.guard.bindings);
}

/** The old cell keeps a blank row after a move; its other rows are gone. */
export function prepareRetiredCellOrganisationRow(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE organisation SET name = '', organisation_handle = NULL, status = 'deleted' WHERE organisation_id = ?",
    )
    .bind(organisationId);
}

/** A change of the authoritative runtime, in the database that holds it. */
export function prepareRuntimeCutoverUpdate(
  db: Pick<D1DatabaseSession, "prepare">,
  current: AuthoritativeRuntimeReceipt,
  next: AuthoritativeRuntimeReceipt,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation
     SET authoritative_runtime = ?,
         runtime_cutover_state = ?,
         cloudflare_prepared_at = ?,
         cloudflare_activated_at = ?,
         runtime_rollback_expires_at = ?,
         first_cloudflare_write_at = ?,
         runtime_rolled_back_at = ?
     WHERE organisation_id = ?
       AND authoritative_runtime = ?
       AND runtime_cutover_state = ?
       AND cloudflare_prepared_at IS ?
       AND cloudflare_activated_at IS ?
       AND runtime_rollback_expires_at IS ?
       AND first_cloudflare_write_at IS ?
       AND runtime_rolled_back_at IS ?`,
    )
    .bind(
      next.authoritativeRuntime,
      next.state,
      next.preparedAt,
      next.activatedAt,
      next.rollbackExpiresAt,
      next.firstAuthoritativeWriteAt,
      next.rolledBackAt,
      current.organisationId,
      current.authoritativeRuntime,
      current.state,
      current.preparedAt,
      current.activatedAt,
      current.rollbackExpiresAt,
      current.firstAuthoritativeWriteAt,
      current.rolledBackAt,
    );
}
