import type { OrganisationDatabase } from "../../database-handles";
import type { Result } from "../../result";
import { isRecord } from "@purin-labs/std";
import {
  readPlacementByEpoch,
  samePlacement,
  type FrozenOrganisationPlacementMove,
  type PublishedOrganisationPlacementMove,
  type OrganisationPlacementError,
} from "../organisation-placement";

const ORGANISATION_COLUMNS = [
  "organisation_id",
  "name",
  "plan",
  "created_at",
  "status",
  "organisation_handle",
] as const;

/** Provision only the target root and fence. This does not certify data transfer. */
export async function provisionRegionalMoveTarget(input: {
  readonly sourceDatabase: OrganisationDatabase;
  readonly targetDatabase: OrganisationDatabase;
  readonly move: FrozenOrganisationPlacementMove;
}): Promise<Result<null, OrganisationPlacementError>> {
  const { move } = input;
  const source = await input.sourceDatabase
    .withSession("first-primary")
    .prepare(
      `SELECT organisation.*, placement.environment AS placement_environment
      FROM organisation JOIN organisation_placement placement ON placement.organisation_id = organisation.organisation_id
      WHERE organisation.organisation_id = ? AND placement.placement_epoch = ?
        AND placement.placement_cell_id = ? AND placement.fence_token = ?
        AND placement.status = 'frozen'`,
    )
    .bind(
      move.organisationId,
      move.source.placement.placementEpoch,
      move.source.placement.placementCellId,
      move.source.fenceToken,
    )
    .first();
  const values = organisationPersistenceValues(source);
  if (
    values === null ||
    !isRecord(source) ||
    (source.placement_environment !== "development" &&
      source.placement_environment !== "production")
  ) {
    return {
      ok: false,
      error: {
        code: "organisation_placement_corrupt",
        organisationId: move.organisationId,
      },
    };
  }
  const target = input.targetDatabase.withSession("first-primary");
  const placement = move.target.placement;
  await target.batch([
    target
      .prepare(
        `INSERT INTO organisation (${ORGANISATION_COLUMNS.join(", ")})
      VALUES (${ORGANISATION_COLUMNS.map(organisationColumnPlaceholder).join(", ")})
      ON CONFLICT (organisation_id) DO UPDATE SET ${ORGANISATION_COLUMNS.map(organisationColumnAssignment).join(", ")}
      WHERE organisation.status = 'deleted' AND NOT EXISTS (
        SELECT 1 FROM organisation_placement live WHERE live.organisation_id = organisation.organisation_id
          AND live.status IN ('active', 'frozen')
      ) AND NOT EXISTS (SELECT 1 FROM organisation_placement terminal
        WHERE terminal.organisation_id = organisation.organisation_id AND terminal.placement_epoch = ?
          AND terminal.status IN ('retired', 'abandoned'))`,
      )
      .bind(...values, placement.placementEpoch),
    target
      .prepare(
        `INSERT OR IGNORE INTO organisation_placement (
      organisation_id, placement_epoch, placement_kind, placement_cell_id, location_hint,
      residency_jurisdiction, status, fence_token, created_at, environment
    ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
      )
      .bind(
        move.organisationId,
        placement.placementEpoch,
        placement.kind,
        placement.placementCellId,
        placement.locationHint,
        placement.kind === "residency" ? placement.residencyJurisdiction : null,
        move.target.fenceToken,
        move.target.createdAt,
        source.placement_environment,
      ),
  ]);
  const organisation = await target
    .prepare(
      `SELECT ${ORGANISATION_COLUMNS.join(", ")} FROM organisation WHERE organisation_id = ?`,
    )
    .bind(move.organisationId)
    .first();
  const copied = organisationPersistenceValues(organisation);
  const reserved = await readPlacementByEpoch(
    target,
    move.organisationId,
    placement.placementEpoch,
  );
  if (!reserved.ok) return reserved;
  if (
    copied === null ||
    JSON.stringify(copied) !== JSON.stringify(values) ||
    reserved.value.status !== "reserved" ||
    reserved.value.fenceToken !== move.target.fenceToken ||
    !samePlacement(reserved.value.placement, placement)
  ) {
    return {
      ok: false,
      error: {
        code: "organisation_placement_move_conflict",
        organisationId: move.organisationId,
      },
    };
  }
  return { ok: true, value: null };
}

function organisationColumnAssignment(
  column: (typeof ORGANISATION_COLUMNS)[number],
): string {
  return `${column} = excluded.${column}`;
}

function organisationColumnPlaceholder(): string {
  return "?";
}

/** Preserve the persistence row exactly; target schema constraints validate its values. */
function organisationPersistenceValues(
  raw: unknown,
): readonly (string | number | null)[] | null {
  if (!isRecord(raw)) return null;
  const values: (string | number | null)[] = [];
  for (const column of ORGANISATION_COLUMNS) {
    const value = raw[column];
    if (
      value !== null &&
      typeof value !== "string" &&
      !(typeof value === "number" && Number.isFinite(value))
    )
      return null;
    values.push(value);
  }
  return values;
}

export async function resumeRegionalPlacement(input: {
  readonly sourceDatabase: OrganisationDatabase;
  readonly targetDatabase: OrganisationDatabase;
  readonly move: PublishedOrganisationPlacementMove;
}): Promise<Result<null, OrganisationPlacementError>> {
  const { move } = input;
  await input.sourceDatabase
    .prepare(
      `UPDATE organisation_placement SET status = 'retired', retired_at = ?
    WHERE organisation_id = ? AND placement_epoch = ? AND fence_token = ? AND status = 'frozen'`,
    )
    .bind(
      move.source.retiredAt,
      move.organisationId,
      move.source.placement.placementEpoch,
      move.source.fenceToken,
    )
    .run();
  await input.targetDatabase
    .prepare(
      `UPDATE organisation_placement SET status = 'active', activated_at = ?
    WHERE organisation_id = ? AND placement_epoch = ? AND fence_token = ? AND status = 'reserved'`,
    )
    .bind(
      move.target.activatedAt,
      move.organisationId,
      move.target.placement.placementEpoch,
      move.target.fenceToken,
    )
    .run();
  const source = await readPlacementByEpoch(
    input.sourceDatabase,
    move.organisationId,
    move.source.placement.placementEpoch,
  );
  const target = await readPlacementByEpoch(
    input.targetDatabase,
    move.organisationId,
    move.target.placement.placementEpoch,
  );
  if (!source.ok) return source;
  if (!target.ok) return target;
  if (
    source.value.status !== "retired" ||
    source.value.fenceToken !== move.source.fenceToken ||
    target.value.status !== "active" ||
    target.value.fenceToken !== move.target.fenceToken
  ) {
    return {
      ok: false,
      error: {
        code: "organisation_placement_move_conflict",
        organisationId: move.organisationId,
      },
    };
  }
  return { ok: true, value: null };
}
