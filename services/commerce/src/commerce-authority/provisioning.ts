import {
  parseProvisionDemoCommand,
  parseProvisionMerchantCommand,
  type ProvisionCommerceDemoV1,
  type ProvisionCommerceMerchantV1,
  type CommerceResourcesV1,
  type CommerceFoodServiceResourcesV1,
  type CommerceFoodServiceSnapshotV1,
  type CommerceInventoryItemV1,
  type CommerceInventoryLotV1,
  type CommerceInventoryMovementV1,
  type CommerceInventoryPositionV1,
  type CommerceMerchantProvisioningResultV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationResultV1,
  type CommerceQuantityV1,
} from "@purin-labs/commerce-client";
import { isMerchantId } from "../merchant-id.ts";
import type { CommerceDatabase } from "../database.ts";
import type { FoodServiceExtension } from "../plugins/built-in-ports.ts";
import {
  buildEcommerceDemoResources,
  ecommerceDemoFixtureIdempotencyKey,
  hasCommerceResources,
  hasEcommerceDemoFixture,
} from "../demo-fixtures.ts";

type ProvisioningMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

type ProvisioningMutation = (
  rawCommand: unknown,
) => CommerceMutationResultV1;

export type ProvisioningAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  readMerchant: (merchantId: string) => ProvisioningMerchantRow | undefined;
  readSnapshot: (
    merchantId: string,
  ) => CommerceMerchantSnapshotV1 | undefined;
  readFoodServiceSnapshot: (
    merchantId: string,
  ) => CommerceFoodServiceSnapshotV1 | undefined;
  readFoodServiceResources: (
    merchantId: string,
  ) => CommerceFoodServiceResourcesV1;
  listInventoryLots: (
    merchantId: string,
  ) => readonly CommerceInventoryLotV1[];
  listInventoryMovements: (
    merchantId: string,
  ) => readonly CommerceInventoryMovementV1[];
  createLocation: ProvisioningMutation;
  prepareCatalogListing: ProvisioningMutation;
  configurePickupStorefront: ProvisioningMutation;
  publishCatalogListing: ProvisioningMutation;
  createInventoryItem: ProvisioningMutation;
  openInventoryPosition: ProvisioningMutation;
  receiveInventory: ProvisioningMutation;
  createPreparationStation: ProvisioningMutation;
  createModifierGroupRevision: ProvisioningMutation;
  createRecipeRevision: ProvisioningMutation;
  configureStockPolicy: ProvisioningMutation;
  /** Seeds the café demo; without it the café profile is refused. */
  foodService: FoodServiceExtension | undefined;
}>;

export class ProvisioningAuthority {
  readonly #options: ProvisioningAuthorityOptions;

  constructor(options: ProvisioningAuthorityOptions) {
    this.#options = options;
  }

  provisionMerchant(
    rawCommand: unknown,
  ): CommerceMerchantProvisioningResultV1 {
    const command: ProvisionCommerceMerchantV1 =
      parseProvisionMerchantCommand(rawCommand);
    const merchantId = command.merchantId;
    if (!isMerchantId(merchantId))
      throw new Error(
        "A merchant id has 3 to 80 lowercase letters, digits, _ or -",
      );
    const externalReference = command.externalReference;
    const createdAt = command.createdAt;
    const existing = this.#options.readMerchant(merchantId);
    if (existing !== undefined) {
      if (existing.organisationId !== externalReference) {
        throw new Error(`Merchant owner mismatch for ${merchantId}`);
      }
      return merchantProvisioningResult(command, "already_provisioned");
    }
    this.#options.database
      .prepare(
        `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?)`,
      )
      .run(merchantId, externalReference, createdAt, createdAt);
    return merchantProvisioningResult(command, "provisioned");
  }

  provisionDemo(rawCommand: unknown): CommerceMerchantSnapshotV1 {
    const command: ProvisionCommerceDemoV1 =
      parseProvisionDemoCommand(rawCommand);
    this.provisionMerchant(merchantProvisioningCommand(command));
    if (command.profile === "cafe_patisserie") {
      if (this.#options.foodService === undefined)
        throw new Error("The cafe demo needs the food service extension");
      return this.#options.foodService.provisionCafeDemo(
        this.#options,
        command,
      );
    }
    const current = this.#options.readSnapshot(command.merchantId);
    if (current === undefined)
      throw new Error("Merchant provisioning did not persist");
    if (!hasEcommerceDemoFixture(current.resources)) {
      if (hasCommerceResources(current.resources)) {
        throw new Error("Demo merchant already contains a different profile");
      }
      const resources = buildEcommerceDemoResources();
      this.#seedDemoCatalog(command, resources);
      this.#seedDemoInventory(command, resources);
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (
      snapshot === undefined ||
      !hasEcommerceDemoFixture(snapshot.resources)
    ) {
      throw new Error("Demo profile verification failed");
    }
    return snapshot;
  }

  #seedDemoCatalog(
    command: ProvisionCommerceDemoV1,
    resources: CommerceResourcesV1,
  ): void {
    const location = resources.locations[0];
    const salesChannel = resources.salesChannels[0];
    if (
      location === undefined ||
      salesChannel === undefined ||
      resources.products.length === 0 ||
      resources.variants.length === 0 ||
      resources.offers.length === 0
    ) {
      throw new Error("Demo profile catalog is incomplete");
    }
    const locationResult = this.#options.createLocation({
      schemaVersion: "commerce.create-location.v1",
      merchantId: command.merchantId,
      expectedMerchantRevision: 0,
      idempotencyKey: `${ecommerceDemoFixtureIdempotencyKey()}_location`,
      requestedAt: command.createdAt,
      location,
    });
    requireDemoMutation(locationResult, "demo location");
    for (let index = 0; index < resources.products.length; index += 1) {
      const product = resources.products[index];
      const variant = resources.variants[index];
      const offer = resources.offers[index];
      if (
        product === undefined ||
        variant === undefined ||
        offer === undefined
      ) {
        throw new Error("Demo profile catalog relationships are incomplete");
      }
      const idempotencyKey = `${ecommerceDemoFixtureIdempotencyKey()}_catalog_${index}`;
      const catalogResult = this.#options.prepareCatalogListing({
        schemaVersion: "commerce.prepare-catalog-listing.v1",
        merchantId: command.merchantId,
        expectedMerchantRevision: index + 1,
        idempotencyKey,
        requestedAt: command.createdAt,
        salesChannel,
        product,
        variant,
        offer,
        consumptionPlan: {
          consumptionPlanId: `consumption_plan_${variant.id}`,
          variantId: variant.id,
          revision: 1,
          scope: { kind: "location", locationId: location.id },
          mode: { kind: "untracked" },
          lifecycle: "active",
        },
      });
      requireDemoMutation(catalogResult, "demo catalog");
    }
  }

  #seedDemoInventory(
    command: ProvisionCommerceDemoV1,
    resources: CommerceResourcesV1,
  ): void {
    for (const expectedItem of resources.inventoryItems) {
      const snapshot = this.#options.readSnapshot(command.merchantId);
      if (snapshot === undefined)
        throw new Error("Demo merchant disappeared during inventory seed");
      if (
        findResource(snapshot.resources.inventoryItems, expectedItem.id) ===
        undefined
      ) {
        const created = this.#options.createInventoryItem({
          schemaVersion: "commerce.create-inventory-item.v1",
          merchantId: command.merchantId,
          expectedMerchantRevision: snapshot.merchantRevision,
          idempotencyKey: `${ecommerceDemoFixtureIdempotencyKey()}_${expectedItem.id}`,
          requestedAt: command.createdAt,
          inventoryItemId: expectedItem.id,
          merchantCode: expectedItem.merchantCode,
          name: expectedItem.name,
          baseUnit: expectedItem.baseUnit,
          category: expectedItem.category,
          tracking: expectedItem.tracking,
        });
        requireDemoMutation(created, "inventory item");
      }
    }
    for (const expectedPosition of resources.inventoryPositions) {
      this.#seedDemoInventoryPosition(command, resources, expectedPosition);
    }
  }

  #seedDemoInventoryPosition(
    command: ProvisionCommerceDemoV1,
    resources: CommerceResourcesV1,
    expectedPosition: CommerceInventoryPositionV1,
  ): void {
    let snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined)
      throw new Error("Demo merchant disappeared during position seed");
    const item = findResource(
      snapshot.resources.inventoryItems,
      expectedPosition.inventoryItemId,
    );
    const location = findResource(
      resources.locations,
      expectedPosition.locationId,
    );
    if (item === undefined || location === undefined)
      throw new Error("Demo inventory relationship is invalid");
    let position = findResource(
      snapshot.resources.inventoryPositions,
      expectedPosition.id,
    );
    if (position === undefined) {
      const opened = this.#options.openInventoryPosition({
        schemaVersion: "commerce.open-inventory-position.v1",
        merchantId: command.merchantId,
        expectedMerchantRevision: snapshot.merchantRevision,
        idempotencyKey: `${ecommerceDemoFixtureIdempotencyKey()}_${expectedPosition.id}`,
        requestedAt: command.createdAt,
        inventoryPositionId: expectedPosition.id,
        inventoryItemId: item.id,
        inventoryItemRevision: item.revision,
        locationId: location.id,
        locationRevision: location.revision,
      });
      requireDemoMutation(opened, "inventory position");
      snapshot = this.#options.readSnapshot(command.merchantId);
      position =
        snapshot === undefined
          ? undefined
          : findResource(
              snapshot.resources.inventoryPositions,
              expectedPosition.id,
            );
    }
    if (snapshot === undefined || position === undefined) {
      throw new Error("Demo inventory position was not opened");
    }
    seedDemoPositionBalance(
      this.#options.receiveInventory,
      command,
      item,
      position,
      expectedPosition,
      snapshot.merchantRevision,
    );
  }
}

export function findResource<T extends Readonly<{ id: string }>>(
  resources: readonly T[],
  id: string,
): T | undefined {
  for (const resource of resources) {
    if (resource.id === id) return resource;
  }
  return undefined;
}

function merchantProvisioningResult(
  command: ProvisionCommerceMerchantV1,
  outcome: CommerceMerchantProvisioningResultV1["outcome"],
): CommerceMerchantProvisioningResultV1 {
  return {
    schemaVersion: "commerce.merchant-provisioning-result.v2",
    outcome,
    externalReference: command.externalReference,
    merchantId: command.merchantId,
  };
}

function merchantProvisioningCommand(
  command: ProvisionCommerceDemoV1,
): ProvisionCommerceMerchantV1 {
  return {
    schemaVersion: "commerce.provision-merchant.v2",
    externalReference: command.externalReference,
    merchantId: command.merchantId,
    createdAt: command.createdAt,
  };
}

function requireDemoMutation(
  result: CommerceMutationResultV1,
  resource: string,
): void {
  if (result.outcome === "rejected") {
    throw new Error(`Demo ${resource} seed rejected: ${result.error.code}`);
  }
}

function seedDemoPositionBalance(
  receiveInventory: ProvisioningMutation,
  command: ProvisionCommerceDemoV1,
  item: CommerceInventoryItemV1,
  position: CommerceInventoryPositionV1,
  expected: CommerceInventoryPositionV1,
  merchantRevision: number,
): void {
  if (
    position.balance.kind !== "accounted" ||
    expected.balance.kind !== "accounted"
  ) {
    throw new Error("Demo inventory positions must use accounted balances");
  }
  if (quantitiesEqual(position.balance.onHand, expected.balance.onHand)) return;
  if (
    position.balance.onHand.amount !== 0 ||
    expected.balance.allocated.amount !== 0
  ) {
    throw new Error("Demo inventory position has an unexpected balance");
  }
  if (item.tracking.kind !== "aggregate") {
    throw new Error(
      "Demo fixture lot identity must be specified for lot-tracked inventory",
    );
  }
  const result = receiveInventory({
    schemaVersion: "commerce.receive-inventory.v3",
    purchase: { kind: "unlinked" },
    organisationId: command.externalReference,
    merchantId: command.merchantId,
    expectedMerchantRevision: merchantRevision,
    idempotencyKey: `${ecommerceDemoFixtureIdempotencyKey()}_${position.id}_opening_balance`,
    actionNonce: `action_${ecommerceDemoFixtureIdempotencyKey()}_${position.id}_opening_balance`,
    requestedAt: command.createdAt,
    receiptId: `receipt_${ecommerceDemoFixtureIdempotencyKey()}_opening_balance`,
    receiptLineId: `receipt_line_${position.id}_opening_balance`,
    inventoryItemId: item.id,
    inventoryItemRevision: item.revision,
    inventoryPositionId: position.id,
    inventoryPositionRevision: position.revision,
    locationId: position.locationId,
    receivedQuantity: expected.balance.onHand,
    lot: { kind: "not_tracked" },
    receivedAt: command.createdAt,
  });
  requireDemoMutation(result, "opening balance");
}

function quantitiesEqual(
  left: CommerceQuantityV1,
  right: CommerceQuantityV1,
): boolean {
  return (
    left.amount === right.amount &&
    left.scale === right.scale &&
    left.unit === right.unit
  );
}
