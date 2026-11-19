import type { ReconcileCommerceInventoryV1 } from "./admin-client.ts";
import type { CommerceInventoryReceiptPurchase } from "./commerce-resources.ts";
import type { Variant } from "@purin-labs/type-utils";

declare const count: Variant<ReconcileCommerceInventoryV1["change"], "count">;

// @ts-expect-error A count cannot carry an adjustment direction through a spread.
const countWithDirection: ReconcileCommerceInventoryV1["change"] = {
  ...count,
  direction: "increase",
};
// @ts-expect-error Waste cannot increase physical stock.
const wasteIncrease: ReconcileCommerceInventoryV1["change"] = {
  kind: "adjustment",
  direction: "increase",
  reason: "waste",
  quantity: { amount: 1, scale: 0, unit: "each" },
  explanation: "Waste",
};
// @ts-expect-error Aggregate reconciliation cannot select a lot.
const aggregateWithLot: ReconcileCommerceInventoryV1["target"] = {
  kind: "aggregate",
  lotId: "lot",
  lotRevision: 1,
};
// @ts-expect-error Purchase linkage requires the selected request revision.
const incompletePurchase: CommerceInventoryReceiptPurchase = {
  kind: "replenishment",
  entryId: "purchase",
};

void countWithDirection;
void wasteIncrease;
void aggregateWithLot;
void incompletePurchase;
