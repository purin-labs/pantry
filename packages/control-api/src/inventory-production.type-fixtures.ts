import type {
  InventoryProductionCreation,
  InventoryProductionTransition,
} from "./inventory-production";

declare const creation: InventoryProductionCreation;
declare const transition: InventoryProductionTransition;
declare const unfencedCreation: Omit<
  InventoryProductionCreation,
  "listRevision"
>;
declare const unidentifiedCreation: Omit<
  InventoryProductionCreation,
  "inventoryItemId"
>;

// @ts-expect-error A frozen creation requires its original list fence.
const missingList: InventoryProductionCreation = unfencedCreation;
// @ts-expect-error Native command construction requires a stable item identity.
const missingItem: InventoryProductionCreation = unidentifiedCreation;
// @ts-expect-error Creation and status transitions carry different target identities.
const wrongTarget: InventoryProductionTransition = creation;
// @ts-expect-error A transition cannot become a creation through a broad spread.
const spreadCreation: InventoryProductionCreation = {
  ...transition,
  kind: "create",
};
const invalidStatus: InventoryProductionTransition = {
  ...transition,
  // @ts-expect-error Production lifecycle has no completed request state.
  kind: "complete",
};

void missingList;
void missingItem;
void wrongTarget;
void spreadCreation;
void invalidStatus;
