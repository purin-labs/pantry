/**
 * The conditions of a placement move of tenancy on the records of the Actor
 * runtime (Refactor 17): the Actor registry and the item and copy rows of a
 * relocation. Each text is a part of one statement of tenancy. The Worker
 * registers them with the provider work holds (`worker-ports.ts`).
 */
import type { PlacementMoveConditions } from "@purin-labs/tenancy/data/placement-move-conditions";

/** An Actor of the placement epoch is reserved and not yet active. */
export const RESERVED_ACTOR_FREEZE_HOLD = `EXISTS (SELECT 1 FROM durable_object_registry registry
    WHERE registry.organisation_id = organisation_placement.organisation_id
      AND registry.placement_epoch = organisation_placement.placement_epoch
      AND registry.lifecycle_status = 'reserved')`;

export const RELOCATION_JOURNAL_CONDITIONS: Omit<
  PlacementMoveConditions,
  "freezeHolds"
> = {
  relocationHasUncleanedItemSql: (
    relocationIdSql,
  ) => `EXISTS (SELECT 1 FROM state_object_relocation_item item
           WHERE item.relocation_id = ${relocationIdSql}
             AND item.source_cleaned_at IS NULL)`,
  verifiedCopyCountSql: (
    relocationIdSql,
  ) => `(SELECT COUNT(*) FROM state_object_relocation_copy copied
         WHERE copied.relocation_id = ${relocationIdSql} AND copied.status = 'verified')`,
  relocationHasUnverifiedCopySql: (
    relocationIdSql,
  ) => `EXISTS (SELECT 1 FROM state_object_relocation_copy copied
         WHERE copied.relocation_id = ${relocationIdSql} AND copied.status <> 'verified')`,
};
