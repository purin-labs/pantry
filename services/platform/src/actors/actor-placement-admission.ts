import { assertNever } from "@purin-labs/std";
import type { StrictUnion, VariantBy } from "@purin-labs/type-utils";
import {
  resolveActiveOrganisationPlacementRecord,
  samePlacement,
  type FrozenOrganisationPlacementMove,
  type OrganisationPlacementFenceToken,
} from "@purin-labs/tenancy/data/organisation-placement";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { OrganisationPlacement } from "@purin-labs/tenancy/placement";
import type { Result } from "@purin-labs/kernel/result";
import type { ActorRelocationId } from "./actor-relocation";
import type { ActorRestoreId } from "./actor-restore";
import type { ActorIdentity } from "./actor-registry";

type PlacementAdmissionBase = {
  readonly organisationId: OrganisationId;
  readonly placement: OrganisationPlacement;
  readonly fenceToken: OrganisationPlacementFenceToken;
};

export type ActorPlacementAdmission = PlacementAdmissionBase &
  StrictUnion<
    | { readonly kind: "execution" }
    | {
        readonly kind: "relocation";
        readonly relocationId: ActorRelocationId;
        readonly identity: ActorIdentity;
        readonly sourcePlacementEpoch: number;
        readonly sourceFenceToken: OrganisationPlacementFenceToken;
      }
    | {
        readonly kind: "restore";
        readonly restoreId: ActorRestoreId;
        readonly identity: ActorIdentity;
        readonly sourcePlacementEpoch: number;
        readonly sourceFenceToken: OrganisationPlacementFenceToken;
      }
  >;

export type ActorPlacementAdmissionError = {
  readonly code: "registry_placement_conflict";
};

/** Reservation and publication queries validate this captured fence atomically. */
export function actorExecutionAdmission(
  scope: OrganisationExecutionScope,
): VariantBy<ActorPlacementAdmission, "kind", "execution"> {
  return {
    kind: "execution",
    organisationId: scope.organisationId,
    placement: scope.placement,
    fenceToken: scope.fenceToken,
  };
}

export async function resolveActorExecutionAdmission(
  db: D1Database,
  organisationId: OrganisationId,
  placement: OrganisationPlacement,
): Promise<
  Result<
    VariantBy<ActorPlacementAdmission, "kind", "execution">,
    ActorPlacementAdmissionError
  >
> {
  const active = await resolveActiveOrganisationPlacementRecord(
    db.withSession("first-primary"),
    organisationId,
  );
  if (!active.ok || !samePlacement(active.value.placement, placement)) {
    return { ok: false, error: { code: "registry_placement_conflict" } };
  }
  return {
    ok: true,
    value: {
      kind: "execution",
      organisationId,
      placement: active.value.placement,
      fenceToken: active.value.fenceToken,
    },
  };
}

export function actorRelocationAdmission(
  move: FrozenOrganisationPlacementMove,
  relocationId: ActorRelocationId,
  identity: ActorIdentity,
): VariantBy<ActorPlacementAdmission, "kind", "relocation"> {
  return {
    kind: "relocation",
    organisationId: move.organisationId,
    placement: move.target.placement,
    fenceToken: move.target.fenceToken,
    relocationId,
    identity,
    sourcePlacementEpoch: move.source.placement.placementEpoch,
    sourceFenceToken: move.source.fenceToken,
  };
}

export function actorRestoreAdmission(
  move: FrozenOrganisationPlacementMove,
  restoreId: ActorRestoreId,
  identity: ActorIdentity,
): VariantBy<ActorPlacementAdmission, "kind", "restore"> {
  return {
    kind: "restore",
    organisationId: move.organisationId,
    placement: move.target.placement,
    fenceToken: move.target.fenceToken,
    restoreId,
    identity,
    sourcePlacementEpoch: move.source.placement.placementEpoch,
    sourceFenceToken: move.source.fenceToken,
  };
}

export function actorPlacementAdmissionMatchesIdentity(
  admission: ActorPlacementAdmission,
  identity: ActorIdentity,
): boolean {
  if (admission.organisationId !== identity.organisationId) return false;
  switch (admission.kind) {
    case "execution":
      return true;
    case "relocation":
    case "restore":
      return (
        admission.identity.organisationId === identity.organisationId &&
        admission.identity.objectKind === identity.objectKind &&
        admission.identity.logicalObjectId === identity.logicalObjectId
      );
    default:
      return assertNever(admission);
  }
}

function actorPlacementDirectoryAdmissionPredicate(
  admission: ActorPlacementAdmission,
): {
  readonly sql: string;
  readonly bindings: readonly (string | number)[];
} {
  const bindings: (string | number)[] = [
    admission.organisationId,
    admission.placement.placementEpoch,
    admission.placement.placementCellId,
    admission.fenceToken,
    admission.placement.kind,
    admission.placement.locationHint,
  ];
  const residency =
    admission.placement.kind === "residency"
      ? "p.residency_jurisdiction = ?"
      : "p.residency_jurisdiction IS NULL";
  if (admission.placement.kind === "residency")
    bindings.push(admission.placement.residencyJurisdiction);
  const placement = `p.organisation_id = ? AND p.placement_epoch = ?
    AND p.placement_cell_id = ? AND p.fence_token = ?
    AND p.placement_kind = ? AND p.location_hint = ? AND ${residency}`;
  switch (admission.kind) {
    case "execution":
      return {
        sql: `EXISTS (SELECT 1 FROM organisation_placement p WHERE ${placement} AND p.status = 'active')`,
        bindings,
      };
    case "relocation":
      return {
        sql: `EXISTS (SELECT 1 FROM organisation_placement p
          JOIN state_object_relocation operation ON operation.organisation_id = p.organisation_id
            AND operation.target_placement_epoch = p.placement_epoch
          JOIN organisation_placement source ON source.organisation_id = p.organisation_id
            AND source.placement_epoch = operation.source_placement_epoch
          JOIN state_object_relocation_item item ON item.relocation_id = operation.relocation_id
          WHERE ${placement} AND p.status = 'reserved'
            AND operation.relocation_id = ? AND operation.status IN ('frozen', 'copying')
            AND source.placement_epoch = ? AND source.fence_token = ? AND source.status = 'frozen'
            AND item.object_kind = ? AND item.logical_object_id = ? AND item.status IN ('exported', 'imported')
            AND p.organisation_id = ?)`,
        bindings: [
          ...bindings,
          admission.relocationId,
          admission.sourcePlacementEpoch,
          admission.sourceFenceToken,
          admission.identity.objectKind,
          admission.identity.logicalObjectId,
          admission.identity.organisationId,
        ],
      };
    case "restore":
      return {
        sql: `EXISTS (SELECT 1 FROM organisation_placement p
          JOIN state_object_restore operation ON operation.organisation_id = p.organisation_id
            AND operation.target_placement_epoch = p.placement_epoch
          JOIN organisation_placement source ON source.organisation_id = p.organisation_id
            AND source.placement_epoch = operation.local_source_placement_epoch
          JOIN state_object_restore_item item ON item.restore_id = operation.restore_id
          WHERE ${placement} AND p.status = 'reserved'
            AND operation.restore_id = ? AND operation.status IN ('frozen', 'importing')
            AND source.placement_epoch = ? AND source.fence_token = ? AND source.status = 'frozen'
            AND item.object_kind = ? AND item.logical_object_id = ? AND p.organisation_id = ?)`,
        bindings: [
          ...bindings,
          admission.restoreId,
          admission.sourcePlacementEpoch,
          admission.sourceFenceToken,
          admission.identity.objectKind,
          admission.identity.logicalObjectId,
          admission.identity.organisationId,
        ],
      };
    default:
      return assertNever(admission);
  }
}

/** Regional writes depend on the local fence. Copy targets remain reserved
 * until the global coordinator publishes the verified placement. */
export function actorPlacementAdmissionPredicate(
  admission: ActorPlacementAdmission,
): { readonly sql: string; readonly bindings: readonly (string | number)[] } {
  const status = admission.kind === "execution" ? "active" : "reserved";
  return {
    sql: `EXISTS (SELECT 1 FROM organisation_placement p
      WHERE p.organisation_id = ? AND p.placement_epoch = ?
        AND p.placement_cell_id = ? AND p.fence_token = ? AND p.status = ?)`,
    bindings: [
      admission.organisationId,
      admission.placement.placementEpoch,
      admission.placement.placementCellId,
      admission.fenceToken,
      status,
    ],
  };
}

export async function actorPlacementDirectoryAdmits(
  directory: D1Database,
  admission: ActorPlacementAdmission,
): Promise<boolean> {
  const guard = actorPlacementDirectoryAdmissionPredicate(admission);
  const row = await directory
    .withSession("first-primary")
    .prepare(`SELECT 1 AS admitted WHERE ${guard.sql}`)
    .bind(...guard.bindings)
    .first();
  return row !== null;
}
