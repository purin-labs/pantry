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
import type { MerchantRow } from "./ledger.ts";
import {
  beginMerchantCommand,
  beginSnapshotCommand,
  type MerchantCommandPorts,
} from "./merchant-command.ts";

import {
  planProductDeletion,
  type ProductDeletionPlan,
} from "./product-deletion.ts";

type CatalogCommand =
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
      merchant: MerchantRow;
    }>
  | Readonly<{
      kind: "catalog_listing_preparation";
      command: PrepareCommerceCatalogListingV1;
      merchant: MerchantRow;
    }>
  | Readonly<{
      kind: "product_description";
      command: UpdateCommerceProductDescriptionV1;
      merchant: MerchantRow;
      product: CommerceProductV1;
    }>
  | Readonly<{
      kind: "pickup_storefront";
      command: ConfigureCommercePickupStorefrontV1;
      merchant: MerchantRow;
      createLocation: boolean;
    }>
  | Readonly<{
      kind: "shipping_storefront";
      command: ConfigureCommerceShippingStorefrontV1;
      merchant: MerchantRow;
      createLocation: boolean;
    }>
  | Readonly<{
      kind: "channel_listing";
      command: PlaceCommerceChannelListingV1;
      merchant: MerchantRow;
    }>
  | Readonly<{
      kind: "publish_catalog_listing";
      command: PublishCommerceCatalogListingV1;
      merchant: MerchantRow;
      offer: CommerceOfferV1;
    }>
  | Readonly<{
      kind: "catalog_edit";
      merchant: MerchantRow;
      plan: CatalogEditPlan;
    }>
  | Readonly<{
      kind: "product_deletion";
      merchant: MerchantRow;
      plan: ProductDeletionPlan;
    }>;

type CatalogCommandAuthorityOptions = MerchantCommandPorts<CatalogCommand> &
  Readonly<{
    database: CommerceDatabase;
    readSnapshot: (
      merchantId: string,
    ) => CommerceMerchantSnapshotV1 | undefined;
    readMenus: (merchantId: string) => readonly CommerceMenuV1[];
    now: () => string;
    commit: (request: CatalogCommitRequest) => CommerceMutationResultV1;
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
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseCreateLocationCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    if (
      snapshot.resources.locations.some(
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
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parsePrepareCatalogListingCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const validation = validateCatalogListingPreparation(
      command,
      snapshot.resources,
      readFoodServiceResources(this.#options.database, command.merchantId),
    );
    if (validation !== undefined) return this.#options.rejected(validation);
    const duplicate = firstExistingCatalogResource(command, snapshot.resources);
    if (duplicate !== undefined) return this.#options.rejected(duplicate);
    const existingPlan = this.#existingConsumptionPlan(
      command.merchantId,
      command.consumptionPlan.consumptionPlanId,
    );
    if (existingPlan !== undefined) return this.#options.rejected(existingPlan);
    return this.#options.commit({
      kind: "catalog_listing_preparation",
      command,
      merchant,
    });
  }

  updateProductDescription(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseUpdateProductDescriptionCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const current = findProduct(snapshot.resources.products, command.productId);
    if (current === undefined) {
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "product",
        id: command.productId,
      });
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
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseDeleteProductCommand,
    );
    if (start.kind !== "ready") return start.result;
    const planned = planProductDeletion(
      this.#options.database,
      start.command,
      start.snapshot.resources,
      this.#options.readMenus(start.command.merchantId),
      this.#options.now(),
    );
    if (planned.kind === "rejected")
      return this.#options.rejected(planned.error);
    return this.#options.commit({
      kind: "product_deletion",
      merchant: start.merchant,
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
    return this.#editCatalog(
      rawCommand,
      parseUpdateOfferCommand,
      planOfferUpdate,
    );
  }

  updateStorefrontTax(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginMerchantCommand(
      this.#options,
      rawCommand,
      parseUpdateStorefrontTaxCommand,
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant } = start;
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
      UpdateCommerceProductV1 | UpdateCommerceVariantV1 | UpdateCommerceOfferV1,
  >(
    rawCommand: unknown,
    parse: (value: unknown) => TCommand,
    plan: (
      command: TCommand,
      resources: CommerceMerchantSnapshotV1["resources"],
    ) => CatalogEditPlanResult,
  ): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(this.#options, rawCommand, parse);
    if (start.kind !== "ready") return start.result;
    const planned = plan(start.command, start.snapshot.resources);
    if (planned.kind === "rejected")
      return this.#options.rejected(planned.error);
    return this.#options.commit({
      kind: "catalog_edit",
      merchant: start.merchant,
      plan: planned.value,
    });
  }

  configurePickupStorefront(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseConfigurePickupStorefrontCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const validation = validatePickupStorefrontConfiguration(
      command,
      snapshot.resources,
    );
    if (validation !== undefined) return this.#options.rejected(validation);
    const existing = this.#existingStorefrontOrPlan(command);
    if (existing !== undefined) return this.#options.rejected(existing);
    return this.#options.commit({
      kind: "pickup_storefront",
      command,
      merchant,
      createLocation:
        findResource(snapshot.resources.locations, command.location.id) ===
        undefined,
    });
  }

  configureShippingStorefront(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseConfigureShippingStorefrontCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const validation = validateShippingStorefrontConfiguration(
      command,
      snapshot.resources,
    );
    if (validation !== undefined) return this.#options.rejected(validation);
    const existing = this.#existingStorefrontOrPlan(command);
    if (existing !== undefined) return this.#options.rejected(existing);
    const shippingDuplicate = findShippingConfigurationDuplicate(
      this.#options.database,
      command,
    );
    if (shippingDuplicate !== undefined)
      return this.#options.rejected(shippingDuplicate);
    return this.#options.commit({
      kind: "shipping_storefront",
      command,
      merchant,
      createLocation:
        findResource(snapshot.resources.locations, command.location.id) ===
        undefined,
    });
  }

  placeChannelListing(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parsePlaceChannelListingCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
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
      command.catalog.kind === "new_product" ||
      command.catalog.kind === "new_variant"
    ) {
      const existingPlan = this.#existingConsumptionPlan(
        command.merchantId,
        command.catalog.consumptionPlan.consumptionPlanId,
      );
      if (existingPlan !== undefined)
        return this.#options.rejected(existingPlan);
    }
    return this.#options.commit({ kind: "channel_listing", command, merchant });
  }

  publishCatalogListing(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parsePublishCatalogListingCommand,
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
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

  // A new storefront refuses a storefront id, and then a consumption plan id,
  // that exists.
  #existingStorefrontOrPlan(
    command:
      | ConfigureCommercePickupStorefrontV1
      | ConfigureCommerceShippingStorefrontV1,
  ): CommerceMutationErrorV1 | undefined {
    if (
      readStorefront(
        this.#options.database,
        command.merchantId,
        command.storefront.storefrontId,
      ) !== undefined
    ) {
      return {
        code: "resource_already_exists",
        kind: "storefront",
        id: command.storefront.storefrontId,
      };
    }
    return this.#existingConsumptionPlan(
      command.merchantId,
      command.consumptionPlan.consumptionPlanId,
    );
  }

  #existingConsumptionPlan(
    merchantId: string,
    consumptionPlanId: string,
  ): CommerceMutationErrorV1 | undefined {
    return readConsumptionPlan(
      this.#options.database,
      merchantId,
      consumptionPlanId,
    ) === undefined
      ? undefined
      : {
          code: "resource_already_exists",
          kind: "inventory_consumption_plan",
          id: consumptionPlanId,
        };
  }
}

function findResource<T extends Readonly<{ id: string }>>(
  resources: readonly T[],
  id: string,
): T | undefined {
  return resources.find((resource) => resource.id === id);
}
