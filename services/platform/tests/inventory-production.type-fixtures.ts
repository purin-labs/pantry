import type { InventoryProductionRequest } from "@purin-labs/control-api";

const request: InventoryProductionRequest = {
  id: "request",
  revision: 1,
  name: "Cookie production",
  itemId: "cookies",
  locationId: "cafe",
  recipeId: "recipe",
  recipeRevision: 1,
  quantity: { amount: 24, scale: 0, unit: "each" },
  neededBy: "2026-10-05T12:00:00.000Z",
  status: "requested",
  batches: [],
};

const rawQuantityRequest: InventoryProductionRequest = {
  ...request,
  // @ts-expect-error Production quantities require their unit and scale.
  quantity: "24",
};

const separateUnitRequest: InventoryProductionRequest = {
  ...request,
  // @ts-expect-error Quantity owns the unit; there is no separate request unit.
  unit: "each",
};

void rawQuantityRequest;
void separateUnitRequest;
