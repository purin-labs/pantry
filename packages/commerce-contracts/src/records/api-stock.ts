// Plan 78 step 2: the stock snapshot that packages/commerce-client
// reads in src/commerce-resources.ts (`parseStockSnapshot`): the commerce and
// food-service snapshots of one merchant revision, and its inventory records.
import { Type } from "typebox";
import {
  inventoryAllocationSchema,
  inventoryConsumptionPlanSchema,
} from "./commerce-records.ts";
import { wireQuantitySchema } from "./api-common.ts";
import { commerceFoodServiceSnapshotV1Schema } from "./api-food-service.ts";
import {
  commerceInventoryLotV1Schema,
  commerceInventoryMovementV1Schema,
  commerceMerchantSnapshotV1Schema,
} from "./api-resources.ts";
import { normalizedTextSchema } from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  wireRecordParser,
} from "./wire-objects.ts";

const commerceUsableInventoryV1Schema = ReadonlyOpenObject({
  positionId: normalizedTextSchema,
  quantity: wireQuantitySchema,
});

/** Both snapshots must name the same merchant revision. */
const commerceStockSnapshotV1Schema = Type.Refine(
  ReadonlyOpenObject({
    commerce: commerceMerchantSnapshotV1Schema,
    foodService: commerceFoodServiceSnapshotV1Schema,
    lots: ImmutableArray(commerceInventoryLotV1Schema),
    usable: ImmutableArray(commerceUsableInventoryV1Schema),
    movements: ImmutableArray(commerceInventoryMovementV1Schema),
    allocations: ImmutableArray(Type.Readonly(inventoryAllocationSchema)),
    consumptionPlans: ImmutableArray(
      Type.Readonly(inventoryConsumptionPlanSchema),
    ),
  }),
  hasOneScope,
  scopeMismatch,
);

type SnapshotScope = Readonly<{
  organisationId: string;
  merchantId: string;
  merchantRevision: number;
}>;

function hasOneScope(
  snapshot: Readonly<{ commerce: SnapshotScope; foodService: SnapshotScope }>,
): boolean {
  return (
    snapshot.commerce.organisationId === snapshot.foodService.organisationId &&
    snapshot.commerce.merchantId === snapshot.foodService.merchantId &&
    snapshot.commerce.merchantRevision === snapshot.foodService.merchantRevision
  );
}

function scopeMismatch(): string {
  return "Stock snapshot scope mismatch";
}

export const parseCommerceStockSnapshotV1Record = wireRecordParser(
  commerceStockSnapshotV1Schema,
);
