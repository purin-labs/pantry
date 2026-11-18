import {
  parseConfigurePickupStorefrontCommand,
  parseConfigureShippingStorefrontCommand,
  parseCreateLocationCommand,
  parsePlaceChannelListingCommand,
  parsePrepareCatalogListingCommand,
  parseUpdateProductDescriptionCommand,
  parseUpdateOfferCommand,
  parseUpdateStorefrontTaxCommand,
  parseDeleteProductCommand,
  parseUpdateProductCommand,
  parseUpdateVariantCommand,
  parsePublishCatalogListingCommand,
  type ConfigureCommercePickupStorefrontV1,
  type ConfigureCommerceShippingStorefrontV1,
  type CreateCommerceLocationV1,
  type PlaceCommerceChannelListingV1,
  type PrepareCommerceCatalogListingV1,
  type UpdateCommerceProductDescriptionV1,
  type UpdateCommerceOfferV1,
  type UpdateCommerceStorefrontTaxV1,
  type DeleteCommerceProductV1,
  type CommerceMenuV1,
  type UpdateCommerceProductV1,
  type UpdateCommerceVariantV1,
  type PublishCommerceCatalogListingV1,
  type CommerceMerchantSnapshotV1,
  type CommerceProductV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
  type CommerceOfferV1,
} from "@seams/commerce-client";

import type { CommerceDatabase } from "../database.ts";
import {
  readConsumptionPlan,
  readStorefront,
} from "../checkout-persistence.ts";
import { readFoodServiceResources } from "../plugins/food-service/index.ts";
import {
  channelPlacementShippingContext,
  findShippingConfigurationDuplicate,
  firstExistingCatalogResource,
  validateCatalogListingPreparation,
  validateChannelListingPlacement,
  validatePickupStorefrontConfiguration,
  validatePublish,
  validateShippingStorefrontConfiguration,
} from "./catalog.ts";
import {
  planOfferUpdate,
  planStorefrontTaxUpdate,
  planProductUpdate,
  planVariantUpdate,
  type CatalogEditPlan,
  type CatalogEditPlanResult,
} from "./catalog-edits.ts";

import {
  planProductDeletion,
  type ProductDeletionPlan,
} from "./product-deletion.ts";

export type CatalogMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

export type CatalogCommand =
  | CreateCommerceLocationV1
  | PrepareCommerceCatalogListingV1
  | UpdateCommerceProductDescriptionV1
  | UpdateCommerceProductV1
  | DeleteCommerceProductV1
  | UpdateCommerceVariantV1
  | UpdateCommerceOfferV1
  | UpdateCommerceStorefrontTaxV1
  | ConfigureCommercePickupStorefrontV1
  | ConfigureCommerceShippingStorefrontV1
  | PlaceCommerceChannelListingV1
  | PublishCommerceCatalogListingV1;

export type CatalogCommitRequest =
  | Readonly<{
      kind: "location";
      command: CreateCommerceLocationV1;
      merchant: CatalogMerchantRow;
    }>
  | Readonly<{
      kind: "catalog_listing_preparation";
      command: PrepareCommerceCatalogListingV1;
      merchant: CatalogMerchantRow;
    }>
  | Readonly<{
      kind: "product_description";
      command: UpdateCommerceProductDescriptionV1;
      merchant: CatalogMerchantRow;
      product: CommerceProductV1;
    }>
  | Readonly<{
      kind: "pickup_storefront";
      command: ConfigureCommercePickupStorefrontV1;
      merchant: CatalogMerchantRow;
      createLocation: boolean;
    }>
  | Readonly<{
      kind: "shipping_storefront";
      command: ConfigureCommerceShippingStorefrontV1;
      merchant: CatalogMerchantRow;
      createLocation: boolean;
    }>
  | Readonly<{
      kind: "channel_listing";
      command: PlaceCommerceChannelListingV1;
      merchant: CatalogMerchantRow;
    }>
  | Readonly<{
      kind: "publish_catalog_listing";
      command: PublishCommerceCatalogListingV1;
      merchant: CatalogMerchantRow;
      offer: CommerceOfferV1;
    }>
  | Readonly<{
      kind: "catalog_edit";
      merchant: CatalogMerchantRow;
      plan: CatalogEditPlan;
    }>
  | Readonly<{
      kind: "product_deletion";
      merchant: CatalogMerchantRow;
      plan: ProductDeletionPlan;
    }>;

export type CatalogCommandAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  readMerchant: (merchantId: string) => CatalogMerchantRow | undefined;
  readSnapshot: (
    merchantId: string,
  ) => CommerceMerchantSnapshotV1 | undefined;
  readMenus: (merchantId: string) => readonly CommerceMenuV1[];
  now: () => string;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: CatalogCommand,
  ) => CommerceMutationResultV1 | undefined;
  commit: (request: CatalogCommitRequest) => CommerceMutationResultV1;
  validateMerchant: (
    merchantId: string,
    merchant: CatalogMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
}>;

function findProduct(
  products: readonly CommerceProductV1[],
  productId: string,
): CommerceProductV1 | undefined {
  for (const product of products) {
    if (product.id === productId) return product;
  }
  return undefined;
}

export class CatalogCommandAuthority {
  readonly #options: CatalogCommandAuthorityOptions;

  constructor(options: CatalogCommandAuthorityOptions) {
    this.#options = options;
  }

  createLocation(rawCommand: unknown): CommerceMutationResultV1 {
    let command: CreateCommerceLocationV1;
    try {
      command = parseCreateLocationCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const current = this.#options.readSnapshot(command.merchantId);
    if (current === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (
      current.resources.locations.some(
        (location) => location.id === command.location.id,
      )
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "location",
        id: command.location.id,
      });
    }
    if (
      command.location.revision !== 1 ||
      command.location.lifecycle.state !== "active"
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "location",
      });
    }
    return this.#options.commit({ kind: "location", command, merchant });
  }

  prepareCatalogListing(rawCommand: unknown): CommerceMutationResultV1 {
    let command: PrepareCommerceCatalogListingV1;
    try {
      command = parsePrepareCatalogListingCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const current = this.#options.readSnapshot(command.merchantId);
    if (current === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const validation = validateCatalogListingPreparation(
      command,
      current.resources,
      readFoodServiceResources(this.#options.database, command.merchantId),
    );
    if (validation !== undefined) return this.#options.rejected(validation);
    const duplicate = firstExistingCatalogResource(command, current.resources);
    if (duplicate !== undefined) return this.#options.rejected(duplicate);
    if (
      readConsumptionPlan(
        this.#options.database,
        command.merchantId,
        command.consumptionPlan.consumptionPlanId,
      ) !== undefined
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "inventory_consumption_plan",
        id: command.consumptionPlan.consumptionPlanId,
      });
    }
    return this.#options.commit({
      kind: "catalog_listing_preparation",
      command,
      merchant,
    });
  }

  updateProductDescription(rawCommand: unknown): CommerceMutationResultV1 {
    let command: UpdateCommerceProductDescriptionV1;
    try {
      command = parseUpdateProductDescriptionCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({ code: "merchant_not_found", merchantId: command.merchantId });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined) {
      return this.#options.rejected({ code: "merchant_not_found", merchantId: command.merchantId });
    }
    const current = findProduct(snapshot.resources.products, command.productId);
    if (current === undefined) {
      return this.#options.rejected({ code: "resource_not_found", kind: "product", id: command.productId });
    }
    if (current.revision !== command.expectedProductRevision) {
      return this.#options.rejected({
        code: "stale_resource_revision",
        kind: "product",
        id: command.productId,
        expected: command.expectedProductRevision,
        actual: current.revision,
      });
    }
    return this.#options.commit({
      kind: "product_description",
      command,
      merchant,
      product: {
        ...current,
        revision: current.revision + 1,
        description: command.description,
        occurredAt: command.requestedAt,
      },
    });
  }

  updateProduct(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#editCatalog(
      rawCommand,
      parseUpdateProductCommand,
      planProductUpdate,
    );
  }

  deleteProduct(rawCommand: unknown): CommerceMutationResultV1 {
    let command: DeleteCommerceProductV1;
    try {
      command = parseDeleteProductCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (merchant === undefined || snapshot === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const planned = planProductDeletion(
      this.#options.database,
      command,
      snapshot.resources,
      this.#options.readMenus(command.merchantId),
      this.#options.now(),
    );
    if (planned.kind === "rejected")
      return this.#options.rejected(planned.error);
    return this.#options.commit({
      kind: "product_deletion",
      merchant,
      plan: planned.value,
    });
  }

  updateVariant(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#editCatalog(
      rawCommand,
      parseUpdateVariantCommand,
      planVariantUpdate,
    );
  }

  updateOffer(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#editCatalog(rawCommand, parseUpdateOfferCommand, planOfferUpdate);
  }

  updateStorefrontTax(rawCommand: unknown): CommerceMutationResultV1 {
    let command: UpdateCommerceStorefrontTaxV1;
    try {
      command = parseUpdateStorefrontTaxCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const planned = planStorefrontTaxUpdate(
      command,
      readStorefront(
        this.#options.database,
        command.merchantId,
        command.storefrontId,
      ),
    );
    if (planned.kind === "rejected")
      return this.#options.rejected(planned.error);
    return this.#options.commit({
      kind: "catalog_edit",
      merchant,
      plan: planned.value,
    });
  }

  // A catalog edit is checked against its record's revision only, so edits of
  // different records do not wait for each other.
  #editCatalog<
    TCommand extends
      | UpdateCommerceProductV1
      | UpdateCommerceVariantV1
      | UpdateCommerceOfferV1,
  >(
    rawCommand: unknown,
    parse: (value: unknown) => TCommand,
    plan: (
      command: TCommand,
      resources: CommerceMerchantSnapshotV1["resources"],
    ) => CatalogEditPlanResult,
  ): CommerceMutationResultV1 {
    let command: TCommand;
    try {
      command = parse(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (merchant === undefined || snapshot === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const planned = plan(command, snapshot.resources);
    if (planned.kind === "rejected")
      return this.#options.rejected(planned.error);
    return this.#options.commit({
      kind: "catalog_edit",
      merchant,
      plan: planned.value,
    });
  }

  configurePickupStorefront(rawCommand: unknown): CommerceMutationResultV1 {
    let command: ConfigureCommercePickupStorefrontV1;
    try {
      command = parseConfigurePickupStorefrontCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const validation = validatePickupStorefrontConfiguration(
      command,
      snapshot.resources,
    );
    if (validation !== undefined) return this.#options.rejected(validation);
    if (
      readStorefront(
        this.#options.database,
        command.merchantId,
        command.storefront.storefrontId,
      ) !== undefined
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "storefront",
        id: command.storefront.storefrontId,
      });
    }
    if (
      readConsumptionPlan(
        this.#options.database,
        command.merchantId,
        command.consumptionPlan.consumptionPlanId,
      ) !== undefined
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "inventory_consumption_plan",
        id: command.consumptionPlan.consumptionPlanId,
      });
    }
    const existingLocation = findResource(
      snapshot.resources.locations,
      command.location.id,
    );
    return this.#options.commit({
      kind: "pickup_storefront",
      command,
      merchant,
      createLocation: existingLocation === undefined,
    });
  }

  configureShippingStorefront(rawCommand: unknown): CommerceMutationResultV1 {
    let command: ConfigureCommerceShippingStorefrontV1;
    try {
      command = parseConfigureShippingStorefrontCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const validation = validateShippingStorefrontConfiguration(
      command,
      snapshot.resources,
    );
    if (validation !== undefined) return this.#options.rejected(validation);
    if (
      readStorefront(
        this.#options.database,
        command.merchantId,
        command.storefront.storefrontId,
      ) !== undefined
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "storefront",
        id: command.storefront.storefrontId,
      });
    }
    if (
      readConsumptionPlan(
        this.#options.database,
        command.merchantId,
        command.consumptionPlan.consumptionPlanId,
      ) !== undefined
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "inventory_consumption_plan",
        id: command.consumptionPlan.consumptionPlanId,
      });
    }
    const shippingDuplicate = findShippingConfigurationDuplicate(
      this.#options.database,
      command,
    );
    if (shippingDuplicate !== undefined)
      return this.#options.rejected(shippingDuplicate);
    const existingLocation = findResource(
      snapshot.resources.locations,
      command.location.id,
    );
    return this.#options.commit({
      kind: "shipping_storefront",
      command,
      merchant,
      createLocation: existingLocation === undefined,
    });
  }

  placeChannelListing(rawCommand: unknown): CommerceMutationResultV1 {
    let command: PlaceCommerceChannelListingV1;
    try {
      command = parsePlaceChannelListingCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const shipping = channelPlacementShippingContext(
      this.#options.database,
      command,
    );
    const validation = validateChannelListingPlacement(
      command,
      snapshot.resources,
      shipping,
    );
    if (validation !== undefined) return this.#options.rejected(validation);
    if (
      (command.catalog.kind === "new_product" ||
        command.catalog.kind === "new_variant") &&
      readConsumptionPlan(
        this.#options.database,
        command.merchantId,
        command.catalog.consumptionPlan.consumptionPlanId,
      ) !== undefined
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "inventory_consumption_plan",
        id: command.catalog.consumptionPlan.consumptionPlanId,
      });
    }
    return this.#options.commit({ kind: "channel_listing", command, merchant });
  }

  publishCatalogListing(rawCommand: unknown): CommerceMutationResultV1 {
    let command: PublishCommerceCatalogListingV1;
    try {
      command = parsePublishCatalogListingCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    const validation = validatePublish(command, snapshot.resources);
    if (validation !== undefined) return this.#options.rejected(validation);
    const offer = snapshot.resources.offers.find(
      (candidate) => candidate.id === command.offerId,
    );
    if (offer === undefined)
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "offer",
        id: command.offerId,
      });
    return this.#options.commit({
      kind: "publish_catalog_listing",
      command,
      merchant,
      offer,
    });
  }
}

function findResource<T extends Readonly<{ id: string }>>(
  resources: readonly T[],
  id: string,
): T | undefined {
  return resources.find((resource) => resource.id === id);
}
