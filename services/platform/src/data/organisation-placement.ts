declare const actorRelocationIdBrand: unique symbol;
declare const actorRestoreIdBrand: unique symbol;

/**
 * The ids of the two moves of an Organisation's Actors. A placement row
 * names the move that holds it, so the ids are types of the placement. The
 * Actor runtime makes and parses them.
 */
export type ActorRelocationId = string & {
  readonly [actorRelocationIdBrand]: "ActorRelocationId";
};
export type ActorRestoreId = string & {
  readonly [actorRestoreIdBrand]: "ActorRestoreId";
};
import type { OrganisationId } from "../ids";
import {
  parseOrganisationPlacement,
  type PlacementCellId,
  type DurableObjectLocationHint,
  type ResidencyJurisdiction,
  type OrganisationPlacement,
} from "../placement";
import type { Result } from "../result";
import type { VariantBy } from "@purin-labs/type-utils";
import type { QuerySource } from "./query-source";
import { isNonNegativeInteger, isRecord } from "@purin-labs/std";

export const ORGANISATION_RELOCATION_PUBLICATION_BUDGET_MS = 5 * 60 * 1_000;

export type OrganisationPlacementError =
  | {
      readonly code: "organisation_placement_missing";
      readonly organisationId: OrganisationId;
    }
  | {
      readonly code: "organisation_placement_corrupt";
      readonly organisationId: OrganisationId;
    }
  | {
      readonly code: "organisation_placement_immutable";
      readonly organisationId: OrganisationId;
    }
  | {
      readonly code: "organisation_placement_move_conflict";
      readonly organisationId: OrganisationId;
    };

declare const organisationPlacementFenceTokenBrand: unique symbol;

export type OrganisationPlacementFenceToken = string & {
  readonly [organisationPlacementFenceTokenBrand]: "OrganisationPlacementFenceToken";
};

export type OrganisationPlacementMoveTarget =
  | {
      readonly kind: "affinity";
      readonly placementCellId: PlacementCellId;
      readonly locationHint: DurableObjectLocationHint;
      readonly residencyJurisdiction?: never;
    }
  | {
      readonly kind: "residency";
      readonly placementCellId: PlacementCellId;
      readonly locationHint: DurableObjectLocationHint;
      readonly residencyJurisdiction: ResidencyJurisdiction;
    };

type OrganisationPlacementMoveTargetBoundaryError = {
  readonly code: "invalid_organisation_placement_move_target";
  readonly path: string;
};

type PlacementRecordBase = {
  readonly placement: OrganisationPlacement;
  readonly fenceToken: OrganisationPlacementFenceToken;
  readonly createdAt: number;
};

export type OrganisationPlacementRecord =
  | (PlacementRecordBase & {
      readonly status: "reserved";
      readonly activatedAt?: never;
      readonly frozenAt?: never;
      readonly retiredAt?: never;
      readonly abandonedAt?: never;
    })
  | (PlacementRecordBase & {
      readonly status: "active";
      readonly activatedAt: number;
      readonly frozenAt?: never;
      readonly retiredAt?: never;
      readonly abandonedAt?: never;
    })
  | (PlacementRecordBase & {
      readonly status: "frozen";
      readonly activatedAt: number;
      readonly frozenAt: number;
      readonly retiredAt?: never;
      readonly abandonedAt?: never;
    })
  | (PlacementRecordBase & {
      readonly status: "retired";
      readonly activatedAt: number;
      readonly frozenAt: number;
      readonly retiredAt: number;
      readonly abandonedAt?: never;
    })
  | (PlacementRecordBase & {
      readonly status: "abandoned";
      readonly abandonedAt: number;
      readonly activatedAt?: never;
      readonly frozenAt?: never;
      readonly retiredAt?: never;
    });

export type ReservedOrganisationPlacementMove = {
  readonly organisationId: OrganisationId;
  readonly source: VariantBy<OrganisationPlacementRecord, "status", "active">;
  readonly target: VariantBy<OrganisationPlacementRecord, "status", "reserved">;
};

export type FrozenOrganisationPlacementMove = {
  readonly organisationId: OrganisationId;
  readonly source: VariantBy<OrganisationPlacementRecord, "status", "frozen">;
  readonly target: VariantBy<OrganisationPlacementRecord, "status", "reserved">;
};

export type PublishedOrganisationPlacementMove = {
  readonly organisationId: OrganisationId;
  readonly source: VariantBy<OrganisationPlacementRecord, "status", "retired">;
  readonly target: VariantBy<OrganisationPlacementRecord, "status", "active">;
};

type OrganisationPlacementRow = {
  placementKind: unknown;
  placementEpoch: unknown;
  placementCellId: unknown;
  locationHint: unknown;
  residencyJurisdiction: unknown;
};

type OrganisationPlacementRecordRow = OrganisationPlacementRow & {
  fenceToken: unknown;
  status: unknown;
  createdAt: unknown;
  activatedAt: unknown;
  frozenAt: unknown;
  retiredAt: unknown;
  abandonedAt: unknown;
};

export function parseOrganisationPlacementMoveTarget(
  raw: unknown,
  path = "target",
): Result<
  OrganisationPlacementMoveTarget,
  OrganisationPlacementMoveTargetBoundaryError
> {
  if (!isRecord(raw)) {
    return invalidPlacementMoveTarget(path);
  }

  if (raw.kind === "affinity") {
    if ("residencyJurisdiction" in raw) {
      return invalidPlacementMoveTarget(`${path}.residencyJurisdiction`);
    }

    const placement = parseOrganisationPlacement(
      {
        kind: raw.kind,
        placementEpoch: 1,
        placementCellId: raw.placementCellId,
        locationHint: raw.locationHint,
      },
      path,
    );

    return placement.ok && placement.value.kind === "affinity"
      ? {
          ok: true,
          value: {
            kind: placement.value.kind,
            placementCellId: placement.value.placementCellId,
            locationHint: placement.value.locationHint,
          },
        }
      : invalidPlacementMoveTarget(
          placement.ok ? `${path}.kind` : placement.error.path,
        );
  }

  if (raw.kind === "residency") {
    const placement = parseOrganisationPlacement(
      {
        kind: raw.kind,
        placementEpoch: 1,
        placementCellId: raw.placementCellId,
        locationHint: raw.locationHint,
        residencyJurisdiction: raw.residencyJurisdiction,
      },
      path,
    );

    return placement.ok && placement.value.kind === "residency"
      ? {
          ok: true,
          value: {
            kind: placement.value.kind,
            placementCellId: placement.value.placementCellId,
            locationHint: placement.value.locationHint,
            residencyJurisdiction: placement.value.residencyJurisdiction,
          },
        }
      : invalidPlacementMoveTarget(
          placement.ok ? `${path}.kind` : placement.error.path,
        );
  }

  return invalidPlacementMoveTarget(`${path}.kind`);
}

export async function resolveActiveOrganisationPlacement(
  db: QuerySource,
  organisationId: OrganisationId,
): Promise<Result<OrganisationPlacement, OrganisationPlacementError>> {
  const row = await db
    .prepare(
      `SELECT
         placement_kind AS placementKind,
         placement_epoch AS placementEpoch,
         placement_cell_id AS placementCellId,
         location_hint AS locationHint,
         residency_jurisdiction AS residencyJurisdiction
       FROM organisation_placement
       WHERE organisation_id = ? AND status = 'active'`,
    )
    .bind(organisationId)
    .first<OrganisationPlacementRow>();

  if (row === null) {
    return {
      ok: false,
      error: { code: "organisation_placement_missing", organisationId },
    };
  }

  const parsed = parseOrganisationPlacement({
    kind: row.placementKind,
    placementEpoch: row.placementEpoch,
    placementCellId: row.placementCellId,
    locationHint: row.locationHint,
    ...(row.placementKind === "residency"
      ? { residencyJurisdiction: row.residencyJurisdiction }
      : {}),
  });

  return parsed.ok
    ? parsed
    : {
        ok: false,
        error: { code: "organisation_placement_corrupt", organisationId },
      };
}

export async function resolveActiveOrganisationPlacementRecord(
  db: QuerySource,
  organisationId: OrganisationId,
): Promise<
  Result<
    VariantBy<OrganisationPlacementRecord, "status", "active">,
    OrganisationPlacementError
  >
> {
  const record = await readPlacementByStatus(db, organisationId, "active");
  if (!record.ok) return record;
  return record.value.status === "active"
    ? { ok: true, value: record.value }
    : placementCorrupt(organisationId);
}

export type OrganisationPlacementPublication =
  | { readonly kind: "relocation"; readonly operationId: ActorRelocationId }
  | { readonly kind: "restore"; readonly operationId: ActorRestoreId };

export async function readOrganisationPlacementMove(input: {
  readonly db: D1Database;
  readonly organisationId: OrganisationId;
  readonly sourcePlacementEpoch: number;
  readonly targetPlacementEpoch: number;
}): Promise<
  Result<
    | ReservedOrganisationPlacementMove
    | FrozenOrganisationPlacementMove
    | PublishedOrganisationPlacementMove,
    OrganisationPlacementError
  >
> {
  const source = await readPlacementByEpoch(
    input.db,
    input.organisationId,
    input.sourcePlacementEpoch,
  );
  const target = await readPlacementByEpoch(
    input.db,
    input.organisationId,
    input.targetPlacementEpoch,
  );

  if (!source.ok) {
    return { ok: false, error: source.error };
  }

  if (!target.ok) {
    return { ok: false, error: target.error };
  }

  if (source.value.status === "active" && target.value.status === "reserved") {
    return {
      ok: true,
      value: {
        organisationId: input.organisationId,
        source: source.value,
        target: target.value,
      },
    };
  }

  if (source.value.status === "frozen" && target.value.status === "reserved") {
    return {
      ok: true,
      value: {
        organisationId: input.organisationId,
        source: source.value,
        target: target.value,
      },
    };
  }

  if (source.value.status === "retired" && target.value.status === "active") {
    return {
      ok: true,
      value: {
        organisationId: input.organisationId,
        source: source.value,
        target: target.value,
      },
    };
  }

  return placementMoveConflict(input.organisationId);
}

export async function readPlacementByStatus(
  db: QuerySource,
  organisationId: OrganisationId,
  status: OrganisationPlacementRecord["status"],
): Promise<Result<OrganisationPlacementRecord, OrganisationPlacementError>> {
  const row = await db
    .prepare(
      `${placementRecordSelect()} WHERE organisation_id = ? AND status = ?`,
    )
    .bind(organisationId, status)
    .first<OrganisationPlacementRecordRow>();

  return parsePlacementRecord(row, organisationId);
}

export async function readPlacementByEpoch(
  db: QuerySource,
  organisationId: OrganisationId,
  placementEpoch: number,
): Promise<Result<OrganisationPlacementRecord, OrganisationPlacementError>> {
  const row = await db
    .prepare(
      `${placementRecordSelect()} WHERE organisation_id = ? AND placement_epoch = ?`,
    )
    .bind(organisationId, placementEpoch)
    .first<OrganisationPlacementRecordRow>();

  return parsePlacementRecord(row, organisationId);
}

function placementRecordSelect(): string {
  return `SELECT
     placement_kind AS placementKind,
     placement_epoch AS placementEpoch,
     placement_cell_id AS placementCellId,
     location_hint AS locationHint,
     residency_jurisdiction AS residencyJurisdiction,
     fence_token AS fenceToken,
     status,
     created_at AS createdAt,
     activated_at AS activatedAt,
     frozen_at AS frozenAt,
     abandoned_at AS abandonedAt,
     retired_at AS retiredAt
   FROM organisation_placement`;
}

function parsePlacementRecord(
  row: OrganisationPlacementRecordRow | null,
  organisationId: OrganisationId,
): Result<OrganisationPlacementRecord, OrganisationPlacementError> {
  if (row === null) {
    return {
      ok: false,
      error: { code: "organisation_placement_missing", organisationId },
    };
  }

  const placement = parseOrganisationPlacement({
    kind: row.placementKind,
    placementEpoch: row.placementEpoch,
    placementCellId: row.placementCellId,
    locationHint: row.locationHint,
    ...(row.placementKind === "residency"
      ? { residencyJurisdiction: row.residencyJurisdiction }
      : {}),
  });
  const fenceToken = parseOrganisationPlacementFenceToken(row.fenceToken);

  if (!placement.ok || !fenceToken.ok || !isNonNegativeInteger(row.createdAt)) {
    return placementCorrupt(organisationId);
  }

  const base: PlacementRecordBase = {
    placement: placement.value,
    fenceToken: fenceToken.value,
    createdAt: row.createdAt,
  };

  if (row.status !== "abandoned" && row.abandonedAt !== null)
    return placementCorrupt(organisationId);
  switch (row.status) {
    case "abandoned":
      return isNonNegativeInteger(row.abandonedAt) &&
        row.activatedAt === null &&
        row.frozenAt === null &&
        row.retiredAt === null
        ? {
            ok: true,
            value: {
              placement: base.placement,
              fenceToken: base.fenceToken,
              createdAt: base.createdAt,
              status: "abandoned",
              abandonedAt: row.abandonedAt,
            },
          }
        : placementCorrupt(organisationId);
    case "reserved":
      return row.activatedAt === null &&
        row.frozenAt === null &&
        row.retiredAt === null
        ? { ok: true, value: { ...base, status: row.status } }
        : placementCorrupt(organisationId);
    case "active":
      return isNonNegativeInteger(row.activatedAt) &&
        row.frozenAt === null &&
        row.retiredAt === null
        ? {
            ok: true,
            value: {
              ...base,
              status: row.status,
              activatedAt: row.activatedAt,
            },
          }
        : placementCorrupt(organisationId);
    case "frozen":
      return isNonNegativeInteger(row.activatedAt) &&
        isNonNegativeInteger(row.frozenAt) &&
        row.retiredAt === null
        ? {
            ok: true,
            value: {
              ...base,
              status: row.status,
              activatedAt: row.activatedAt,
              frozenAt: row.frozenAt,
            },
          }
        : placementCorrupt(organisationId);
    case "retired":
      return isNonNegativeInteger(row.activatedAt) &&
        isNonNegativeInteger(row.frozenAt) &&
        isNonNegativeInteger(row.retiredAt)
        ? {
            ok: true,
            value: {
              ...base,
              status: row.status,
              activatedAt: row.activatedAt,
              frozenAt: row.frozenAt,
              retiredAt: row.retiredAt,
            },
          }
        : placementCorrupt(organisationId);
    default:
      return placementCorrupt(organisationId);
  }
}

export function parseOrganisationPlacementFenceToken(
  value: unknown,
): Result<
  OrganisationPlacementFenceToken,
  { readonly code: "invalid_placement_fence" }
> {
  return typeof value === "string" && value.length > 0
    ? { ok: true, value: value as OrganisationPlacementFenceToken }
    : { ok: false, error: { code: "invalid_placement_fence" } };
}

function invalidPlacementMoveTarget(
  path: string,
): Result<never, OrganisationPlacementMoveTargetBoundaryError> {
  return {
    ok: false,
    error: { code: "invalid_organisation_placement_move_target", path },
  };
}

export function placementCorrupt(
  organisationId: OrganisationId,
): Result<never, OrganisationPlacementError> {
  return {
    ok: false,
    error: { code: "organisation_placement_corrupt", organisationId },
  };
}

export function placementMoveConflict(
  organisationId: OrganisationId,
): Result<never, OrganisationPlacementError> {
  return {
    ok: false,
    error: { code: "organisation_placement_move_conflict", organisationId },
  };
}

export function samePlacement(
  left: OrganisationPlacement,
  right: OrganisationPlacement,
): boolean {
  if (
    left.kind !== right.kind ||
    left.placementEpoch !== right.placementEpoch ||
    left.placementCellId !== right.placementCellId ||
    left.locationHint !== right.locationHint
  ) {
    return false;
  }

  return (
    left.kind === "affinity" ||
    (right.kind === "residency" &&
      left.residencyJurisdiction === right.residencyJurisdiction)
  );
}

/** The placement that a policy command of the Organisation runs at. */
export type OrganisationPolicyPlacement = Readonly<{
  placement: OrganisationPlacement;
  fenceToken: OrganisationPlacementFenceToken;
}>;

/** Whether the policy placement is still the active one, read from the primary. */
export async function isOrganisationPolicyPlacementActive(
  db: D1Database,
  organisationId: OrganisationId,
  expected: OrganisationPolicyPlacement,
): Promise<boolean> {
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT 1 FROM organisation_placement WHERE organisation_id = ?
     AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active'`,
    )
    .bind(
      organisationId,
      expected.placement.placementEpoch,
      expected.placement.placementCellId,
      expected.fenceToken,
    )
    .first();
  return row !== null;
}
