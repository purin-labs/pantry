import {
  parseShippingProfile,
  parseVariantShippingSpecification,
  type ConfigureCommercePickupStorefrontV1,
  type ConfigureCommerceShippingStorefrontV1,
  type PlaceCommerceChannelListingV1,
  type PrepareCommerceCatalogListingV1,
  type PublishCommerceCatalogListingV1,
  type CommerceAggregateObservationV1,
  type CommerceResourcesV1,
  type CommerceFoodServiceResourcesV1,
  type CommerceMutationErrorV1,
} from "@purin-labs/commerce-client";
import type {
  InventoryConsumptionPlan,
  ShippingProfile,
  VariantShippingSpecification,
} from "@purin-labs/commerce-contracts";

import type { CommerceDatabase } from "../database.ts";
import { readChannelShippingStorefront } from "../checkout-persistence.ts";

type ChannelPlacementShippingContext =
  | Readonly<{
      kind: "shipping";
      shippingProfileId: string;
      shippingProfileRevision: number;
      specificationExists: boolean;
    }>
  | Readonly<{ kind: "none" }>;

export function validatePickupStorefrontConfiguration(
  command: ConfigureCommercePickupStorefrontV1,
  current: CommerceResourcesV1,
): CommerceMutationErrorV1 | undefined {
  const existingLocation = findResource(current.locations, command.location.id);
  if (
    existingLocation !== undefined &&
    !sameResource(existingLocation, command.location)
  ) {
    return { code: "resource_relationship_invalid", field: "location" };
  }
  const duplicate = firstExistingStorefrontResource(command, current);
  if (duplicate !== undefined) return duplicate;
  if (
    command.location.revision !== 1 ||
    command.salesChannel.revision !== 1 ||
    command.product.revision !== 1 ||
    command.variant.revision !== 1 ||
    command.offer.revision !== 1 ||
    command.storefront.revision !== 1 ||
    command.consumptionPlan.revision !== 1
  ) {
    return { code: "resource_relationship_invalid", field: "revision" };
  }
  if (
    command.location.lifecycle.state !== "active" ||
    command.salesChannel.lifecycle.state !== "active" ||
    command.offer.lifecycle.state !== "listed" ||
    command.storefront.lifecycle.state !== "active" ||
    command.consumptionPlan.lifecycle !== "active"
  ) {
    return { code: "resource_relationship_invalid", field: "lifecycle" };
  }
  if (
    command.variant.productId !== command.product.id ||
    command.offer.variantId !== command.variant.id ||
    command.offer.salesChannelId !== command.salesChannel.id ||
    command.storefront.salesChannelId !== command.salesChannel.id ||
    command.storefront.fulfillment.kind !== "pickup" ||
    command.storefront.fulfillment.locationId !== command.location.id ||
    command.consumptionPlan.variantId !== command.variant.id ||
    command.consumptionPlan.scope.kind !== "location" ||
    command.consumptionPlan.scope.locationId !== command.location.id
  ) {
    return {
      code: "resource_relationship_invalid",
      field: "pickupStorefront.relationship",
    };
  }
  if (
    command.consumptionPlan.mode.kind !== "direct" ||
    command.consumptionPlan.mode.components.length === 0 ||
    command.consumptionPlan.mode.commitOn !== "fulfillment_completed"
  ) {
    return {
      code: "resource_relationship_invalid",
      field: "consumptionPlan.mode",
    };
  }
  for (const requirement of command.consumptionPlan.mode.components) {
    const item = findResource(
      current.inventoryItems,
      requirement.inventoryItemId,
    );
    if (item === undefined) {
      return {
        code: "resource_not_found",
        kind: "inventory_item",
        id: requirement.inventoryItemId,
      };
    }
    if (
      item.lifecycle !== "active" ||
      item.baseUnit !== requirement.quantity.unit
    ) {
      return {
        code: "resource_relationship_invalid",
        field: "consumptionPlan.mode.components",
      };
    }
  }
  return undefined;
}

export function validateShippingStorefrontConfiguration(
  command: ConfigureCommerceShippingStorefrontV1,
  current: CommerceResourcesV1,
): CommerceMutationErrorV1 | undefined {
  const existingLocation = findResource(current.locations, command.location.id);
  if (
    existingLocation !== undefined &&
    !sameResource(existingLocation, command.location)
  ) {
    return { code: "resource_relationship_invalid", field: "location" };
  }
  const duplicate = firstExistingStorefrontResource(command, current);
  if (duplicate !== undefined) return duplicate;
  if (
    command.location.revision !== 1 ||
    command.salesChannel.revision !== 1 ||
    command.product.revision !== 1 ||
    command.variant.revision !== 1 ||
    command.offer.revision !== 1 ||
    command.storefront.revision !== 1 ||
    command.consumptionPlan.revision !== 1 ||
    command.shippingProfile.revision !== 1
  ) {
    return { code: "resource_relationship_invalid", field: "revision" };
  }
  if (
    command.location.lifecycle.state !== "active" ||
    command.salesChannel.lifecycle.state !== "active" ||
    command.offer.lifecycle.state !== "listed" ||
    command.storefront.lifecycle.state !== "active" ||
    command.consumptionPlan.lifecycle !== "active" ||
    command.shippingProfile.lifecycle.state !== "active"
  ) {
    return { code: "resource_relationship_invalid", field: "lifecycle" };
  }
  if (
    command.variant.productId !== command.product.id ||
    command.offer.variantId !== command.variant.id ||
    command.offer.salesChannelId !== command.salesChannel.id ||
    command.storefront.salesChannelId !== command.salesChannel.id ||
    command.storefront.fulfillment.kind !== "shipping" ||
    command.storefront.fulfillment.originLocationId !== command.location.id ||
    command.storefront.fulfillment.shippingProfileId !==
      command.shippingProfile.shippingProfileId ||
    command.shippingProfile.originLocationId !== command.location.id ||
    command.shippingSpecification.variantId !== command.variant.id ||
    command.shippingSpecification.variantRevision !==
      command.variant.revision ||
    command.shippingSpecification.shippingProfileId !==
      command.shippingProfile.shippingProfileId ||
    command.shippingSpecification.shippingProfileRevision !==
      command.shippingProfile.revision ||
    command.shippingSpecification.eligibility.kind !== "physical" ||
    command.consumptionPlan.variantId !== command.variant.id ||
    command.consumptionPlan.scope.kind !== "location" ||
    command.consumptionPlan.scope.locationId !== command.location.id
  ) {
    return {
      code: "resource_relationship_invalid",
      field: "shippingStorefront.relationship",
    };
  }
  if (
    command.consumptionPlan.mode.kind !== "direct" ||
    command.consumptionPlan.mode.components.length === 0 ||
    command.consumptionPlan.mode.commitOn !== "fulfillment_completed"
  ) {
    return {
      code: "resource_relationship_invalid",
      field: "consumptionPlan.mode",
    };
  }
  let includesPackaging = false;
  for (const requirement of command.consumptionPlan.mode.components) {
    const item = findResource(
      current.inventoryItems,
      requirement.inventoryItemId,
    );
    if (item === undefined) {
      return {
        code: "resource_not_found",
        kind: "inventory_item",
        id: requirement.inventoryItemId,
      };
    }
    if (
      item.lifecycle !== "active" ||
      item.baseUnit !== requirement.quantity.unit
    ) {
      return {
        code: "resource_relationship_invalid",
        field: "consumptionPlan.mode.components",
      };
    }
    includesPackaging ||= item.category === "packaging";
  }
  if (!includesPackaging) {
    return {
      code: "resource_relationship_invalid",
      field: "consumptionPlan.packaging",
    };
  }
  return undefined;
}

export function validateCatalogListingPreparation(
  command: PrepareCommerceCatalogListingV1,
  current: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
): CommerceMutationErrorV1 | undefined {
  if (
    command.salesChannel.revision !== 1 ||
    command.product.revision !== 1 ||
    command.variant.revision !== 1 ||
    command.offer.revision !== 1 ||
    command.consumptionPlan.revision !== 1
  ) {
    return { code: "resource_relationship_invalid", field: "revision" };
  }
  if (
    command.salesChannel.lifecycle.state !== "active" ||
    command.offer.lifecycle.state !== "prepared"
  ) {
    return { code: "resource_relationship_invalid", field: "lifecycle" };
  }
  if (command.variant.productId !== command.product.id) {
    return {
      code: "resource_relationship_invalid",
      field: "variant.productId",
    };
  }
  if (command.offer.variantId !== command.variant.id) {
    return { code: "resource_relationship_invalid", field: "offer.variantId" };
  }
  if (command.offer.salesChannelId !== command.salesChannel.id) {
    return {
      code: "resource_relationship_invalid",
      field: "offer.salesChannelId",
    };
  }
  const plan = command.consumptionPlan;
  if (plan.variantId !== command.variant.id || plan.lifecycle !== "active") {
    return {
      code: "resource_relationship_invalid",
      field: "consumptionPlan.variantId",
    };
  }
  if (plan.scope.kind === "location") {
    const locationId = plan.scope.locationId;
    const location = current.locations.find(
      (candidate) => candidate.id === locationId,
    );
    if (location === undefined)
      return { code: "resource_not_found", kind: "location", id: locationId };
    if (location.lifecycle.state !== "active")
      return {
        code: "resource_relationship_invalid",
        field: "consumptionPlan.scope.locationId",
      };
  }
  if (plan.mode.kind === "direct") {
    if (plan.mode.commitOn !== "fulfillment_completed") {
      return {
        code: "resource_relationship_invalid",
        field: "consumptionPlan.mode.commitOn",
      };
    }
    const items = new Map(
      current.inventoryItems.map((item) => [item.id, item]),
    );
    for (const requirement of plan.mode.components) {
      const item = items.get(requirement.inventoryItemId);
      if (item === undefined)
        return {
          code: "resource_not_found",
          kind: "inventory_item",
          id: requirement.inventoryItemId,
        };
      if (
        item.lifecycle !== "active" ||
        item.baseUnit !== requirement.quantity.unit
      ) {
        return {
          code: "resource_relationship_invalid",
          field: "consumptionPlan.mode.components",
        };
      }
    }
  } else if (plan.mode.kind === "prepared") {
    const recipeId = plan.mode.recipeId;
    const recipeRevision = plan.mode.recipeRevision;
    const recipe = foodService.recipeRevisions.find(
      (candidate) => candidate.recipeId === recipeId,
    );
    if (recipe === undefined)
      return {
        code: "resource_not_found",
        kind: "recipe_revision",
        id: recipeId,
      };
    if (
      recipe.revision !== recipeRevision ||
      recipe.lifecycle.state !== "active" ||
      recipe.output.kind !== "immediate"
    ) {
      return {
        code: "resource_relationship_invalid",
        field: "consumptionPlan.mode.recipe",
      };
    }
  }
  return undefined;
}

export function firstExistingCatalogResource(
  command: PrepareCommerceCatalogListingV1,
  current: CommerceResourcesV1,
): CommerceMutationErrorV1 | undefined {
  const existingChannel = findResource(
    current.salesChannels,
    command.salesChannel.id,
  );
  if (
    existingChannel !== undefined &&
    !sameResource(existingChannel, command.salesChannel)
  ) {
    return { code: "resource_relationship_invalid", field: "salesChannel" };
  }
  const resources: readonly Readonly<{
    kind: string;
    id: string;
    current: readonly Readonly<{ id: string }>[];
  }>[] = [
    { kind: "product", id: command.product.id, current: current.products },
    {
      kind: "sellable_variant",
      id: command.variant.id,
      current: current.variants,
    },
    { kind: "offer", id: command.offer.id, current: current.offers },
  ];
  for (const resource of resources) {
    if (findResource(resource.current, resource.id) !== undefined) {
      return {
        code: "resource_already_exists",
        kind: resource.kind,
        id: resource.id,
      };
    }
  }
  return undefined;
}

export function validatePublish(
  command: PublishCommerceCatalogListingV1,
  resources: CommerceResourcesV1,
): CommerceMutationErrorV1 | undefined {
  const product = resources.products.find(
    (candidate) => candidate.id === command.productId,
  );
  const variant = resources.variants.find(
    (candidate) => candidate.id === command.variantId,
  );
  const offer = resources.offers.find(
    (candidate) => candidate.id === command.offerId,
  );
  const channel = resources.salesChannels.find(
    (candidate) => candidate.id === command.salesChannelId,
  );
  const checks = [
    checkCatalogRevision(
      "product",
      command.productId,
      command.productRevision,
      product?.revision,
    ),
    checkCatalogRevision(
      "sellable_variant",
      command.variantId,
      command.variantRevision,
      variant?.revision,
    ),
    checkCatalogRevision(
      "offer",
      command.offerId,
      command.offerRevision,
      offer?.revision,
    ),
    checkCatalogRevision(
      "sales_channel",
      command.salesChannelId,
      command.salesChannelRevision,
      channel?.revision,
    ),
  ];
  const failed = checks.find((candidate) => candidate !== undefined);
  if (failed !== undefined) return failed;
  if (variant?.productId !== command.productId) {
    return {
      code: "resource_relationship_invalid",
      field: "variant.productId",
    };
  }
  if (offer?.variantId !== command.variantId) {
    return { code: "resource_relationship_invalid", field: "offer.variantId" };
  }
  if (offer?.salesChannelId !== command.salesChannelId) {
    return {
      code: "resource_relationship_invalid",
      field: "offer.salesChannelId",
    };
  }
  if (offer.lifecycle.state !== "prepared") {
    return {
      code: "offer_not_prepared",
      offerId: offer.id,
      state: offer.lifecycle.state,
    };
  }
  return undefined;
}

export function channelPlacementShippingContext(
  database: CommerceDatabase,
  command: PlaceCommerceChannelListingV1,
): ChannelPlacementShippingContext {
  const storefront = readChannelShippingStorefront(
    database,
    command.merchantId,
    command.salesChannelId,
  );
  if (storefront === undefined || storefront.fulfillment.kind !== "shipping") {
    return { kind: "none" };
  }
  const profile = readShippingProfile(
    database,
    command.merchantId,
    storefront.fulfillment.shippingProfileId,
  );
  if (profile === undefined) return { kind: "none" };
  const target =
    command.catalog.kind === "new_product" ||
    command.catalog.kind === "new_variant"
      ? {
          variantId: command.catalog.variant.id,
          variantRevision: command.catalog.variant.revision,
        }
      : {
          variantId: command.catalog.variantId,
          variantRevision: command.catalog.variantRevision,
        };
  return {
    kind: "shipping",
    shippingProfileId: profile.shippingProfileId,
    shippingProfileRevision: profile.revision,
    specificationExists:
      readVariantShippingSpecification(
        database,
        command.merchantId,
        target.variantId,
        target.variantRevision,
      ) !== undefined,
  };
}

export function validateChannelListingPlacement(
  command: PlaceCommerceChannelListingV1,
  current: CommerceResourcesV1,
  shipping: ChannelPlacementShippingContext,
): CommerceMutationErrorV1 | undefined {
  const channel = findResource(current.salesChannels, command.salesChannelId);
  if (channel === undefined) {
    return {
      code: "resource_not_found",
      kind: "sales_channel",
      id: command.salesChannelId,
    };
  }
  if (channel.lifecycle.state !== "active") {
    return {
      code: "resource_relationship_invalid",
      field: "salesChannel.lifecycle",
    };
  }
  if (command.offer.revision !== 1) {
    return { code: "resource_relationship_invalid", field: "offer.revision" };
  }
  if (command.offer.lifecycle.state !== "listed") {
    return { code: "resource_relationship_invalid", field: "offer.lifecycle" };
  }
  if (command.offer.salesChannelId !== command.salesChannelId) {
    return {
      code: "resource_relationship_invalid",
      field: "offer.salesChannelId",
    };
  }
  if (findResource(current.offers, command.offer.id) !== undefined) {
    return {
      code: "resource_already_exists",
      kind: "offer",
      id: command.offer.id,
    };
  }
  let placedVariantId: string;
  let placedVariantRevision: number;
  if (command.catalog.kind === "new_product") {
    if (
      command.catalog.product.revision !== 1 ||
      command.catalog.variant.revision !== 1 ||
      command.catalog.consumptionPlan.revision !== 1
    ) {
      return {
        code: "resource_relationship_invalid",
        field: "catalog.revision",
      };
    }
    if (
      findResource(current.products, command.catalog.product.id) !== undefined
    ) {
      return {
        code: "resource_already_exists",
        kind: "product",
        id: command.catalog.product.id,
      };
    }
    if (
      findResource(current.variants, command.catalog.variant.id) !== undefined
    ) {
      return {
        code: "resource_already_exists",
        kind: "sellable_variant",
        id: command.catalog.variant.id,
      };
    }
    if (command.catalog.variant.productId !== command.catalog.product.id) {
      return {
        code: "resource_relationship_invalid",
        field: "catalog.variant.productId",
      };
    }
    const planError = validatePlacementConsumptionPlan(
      command.catalog.consumptionPlan,
      command.catalog.variant.id,
      current,
      shipping.kind === "shipping",
    );
    if (planError !== undefined) return planError;
    placedVariantId = command.catalog.variant.id;
    placedVariantRevision = command.catalog.variant.revision;
  } else if (command.catalog.kind === "new_variant") {
    const product = findResource(current.products, command.catalog.productId);
    if (product === undefined) {
      return {
        code: "resource_not_found",
        kind: "product",
        id: command.catalog.productId,
      };
    }
    if (product.revision !== command.catalog.productRevision) {
      return {
        code: "stale_resource_revision",
        kind: "product",
        id: product.id,
        expected: command.catalog.productRevision,
        actual: product.revision,
      };
    }
    if (
      command.catalog.variant.revision !== 1 ||
      command.catalog.consumptionPlan.revision !== 1
    ) {
      return {
        code: "resource_relationship_invalid",
        field: "catalog.revision",
      };
    }
    if (
      findResource(current.variants, command.catalog.variant.id) !== undefined
    ) {
      return {
        code: "resource_already_exists",
        kind: "sellable_variant",
        id: command.catalog.variant.id,
      };
    }
    if (command.catalog.variant.productId !== product.id) {
      return {
        code: "resource_relationship_invalid",
        field: "catalog.variant.productId",
      };
    }
    const sku = command.catalog.variant.sku;
    if (current.variants.some((variant) => variant.sku === sku)) {
      return { code: "resource_already_exists", kind: "sku", id: sku };
    }
    const planError = validatePlacementConsumptionPlan(
      command.catalog.consumptionPlan,
      command.catalog.variant.id,
      current,
      shipping.kind === "shipping",
    );
    if (planError !== undefined) return planError;
    placedVariantId = command.catalog.variant.id;
    placedVariantRevision = command.catalog.variant.revision;
  } else {
    const variant = findResource(current.variants, command.catalog.variantId);
    if (variant === undefined) {
      return {
        code: "resource_not_found",
        kind: "sellable_variant",
        id: command.catalog.variantId,
      };
    }
    if (variant.revision !== command.catalog.variantRevision) {
      return {
        code: "stale_resource_revision",
        kind: "sellable_variant",
        id: variant.id,
        expected: command.catalog.variantRevision,
        actual: variant.revision,
      };
    }
    placedVariantId = variant.id;
    placedVariantRevision = variant.revision;
  }
  if (command.offer.variantId !== placedVariantId) {
    return { code: "resource_relationship_invalid", field: "offer.variantId" };
  }
  const placedOffer = current.offers.find(
    (candidate) =>
      candidate.variantId === placedVariantId &&
      candidate.salesChannelId === command.salesChannelId,
  );
  if (placedOffer !== undefined) {
    return {
      code: "resource_already_exists",
      kind: "channel_offer",
      id: placedOffer.id,
    };
  }
  if (shipping.kind === "shipping") {
    if (command.shippingSpecification === undefined) {
      return shipping.specificationExists
        ? undefined
        : {
            code: "resource_relationship_invalid",
            field: "shippingSpecification.required",
          };
    }
    if (shipping.specificationExists) {
      return {
        code: "resource_already_exists",
        kind: "variant_shipping_specification",
        id: placedVariantId,
      };
    }
    const specification = command.shippingSpecification;
    if (
      specification.variantId !== placedVariantId ||
      specification.variantRevision !== placedVariantRevision ||
      specification.shippingProfileId !== shipping.shippingProfileId ||
      specification.shippingProfileRevision !==
        shipping.shippingProfileRevision ||
      specification.eligibility.kind !== "physical"
    ) {
      return {
        code: "resource_relationship_invalid",
        field: "shippingSpecification.relationship",
      };
    }
    return undefined;
  }
  if (command.shippingSpecification !== undefined) {
    return {
      code: "resource_relationship_invalid",
      field: "shippingSpecification.channel",
    };
  }
  return undefined;
}

function validatePlacementConsumptionPlan(
  plan: InventoryConsumptionPlan,
  variantId: string,
  current: CommerceResourcesV1,
  requirePackaging: boolean,
): CommerceMutationErrorV1 | undefined {
  if (plan.variantId !== variantId || plan.lifecycle !== "active") {
    return {
      code: "resource_relationship_invalid",
      field: "consumptionPlan.variantId",
    };
  }
  if (plan.scope.kind !== "location") {
    return {
      code: "resource_relationship_invalid",
      field: "consumptionPlan.scope",
    };
  }
  const location = findResource(current.locations, plan.scope.locationId);
  if (location === undefined) {
    return {
      code: "resource_not_found",
      kind: "location",
      id: plan.scope.locationId,
    };
  }
  if (location.lifecycle.state !== "active") {
    return {
      code: "resource_relationship_invalid",
      field: "consumptionPlan.scope.locationId",
    };
  }
  if (
    plan.mode.kind !== "direct" ||
    plan.mode.components.length === 0 ||
    plan.mode.commitOn !== "fulfillment_completed"
  ) {
    return {
      code: "resource_relationship_invalid",
      field: "consumptionPlan.mode",
    };
  }
  let includesPackaging = false;
  for (const requirement of plan.mode.components) {
    const item = findResource(
      current.inventoryItems,
      requirement.inventoryItemId,
    );
    if (item === undefined) {
      return {
        code: "resource_not_found",
        kind: "inventory_item",
        id: requirement.inventoryItemId,
      };
    }
    if (
      item.lifecycle !== "active" ||
      item.baseUnit !== requirement.quantity.unit
    ) {
      return {
        code: "resource_relationship_invalid",
        field: "consumptionPlan.mode.components",
      };
    }
    includesPackaging ||= item.category === "packaging";
  }
  if (requirePackaging && !includesPackaging) {
    return {
      code: "resource_relationship_invalid",
      field: "consumptionPlan.packaging",
    };
  }
  return undefined;
}

export function findShippingConfigurationDuplicate(
  database: CommerceDatabase,
  command: ConfigureCommerceShippingStorefrontV1,
): CommerceMutationErrorV1 | undefined {
  const profile = database
    .prepare(
      `SELECT shipping_profile_id AS id FROM shipping_profile
     WHERE merchant_id = ? AND shipping_profile_id = ?`,
    )
    .get<Readonly<{ id: string }>>(
      command.merchantId,
      command.shippingProfile.shippingProfileId,
    );
  if (profile !== undefined) {
    return {
      code: "resource_already_exists",
      kind: "shipping_profile",
      id: profile.id,
    };
  }
  const specification = database
    .prepare(
      `SELECT variant_id AS id FROM variant_shipping_specification
     WHERE merchant_id = ? AND variant_id = ? AND variant_revision = ?`,
    )
    .get<Readonly<{ id: string }>>(
      command.merchantId,
      command.shippingSpecification.variantId,
      command.shippingSpecification.variantRevision,
    );
  if (specification !== undefined) {
    return {
      code: "resource_already_exists",
      kind: "variant_shipping_specification",
      id: specification.id,
    };
  }
  return undefined;
}

export function readShippingProfile(
  database: CommerceDatabase,
  merchantId: string,
  shippingProfileId: string,
): ShippingProfile | undefined {
  const row = database
    .prepare(
      `SELECT profile_json AS profileJson FROM shipping_profile
     WHERE merchant_id = ? AND shipping_profile_id = ?`,
    )
    .get<Readonly<{ profileJson: string }>>(merchantId, shippingProfileId);
  return row === undefined
    ? undefined
    : parseShippingProfile(JSON.parse(row.profileJson));
}

export function readVariantShippingSpecification(
  database: CommerceDatabase,
  merchantId: string,
  variantId: string,
  variantRevision: number,
): VariantShippingSpecification | undefined {
  const row = database
    .prepare(
      `SELECT specification_json AS specificationJson FROM variant_shipping_specification
     WHERE merchant_id = ? AND variant_id = ? AND variant_revision = ?`,
    )
    .get<Readonly<{ specificationJson: string }>>(
      merchantId,
      variantId,
      variantRevision,
    );
  return row === undefined
    ? undefined
    : parseVariantShippingSpecification(JSON.parse(row.specificationJson));
}

export function writeShippingConfiguration(
  database: CommerceDatabase,
  command: ConfigureCommerceShippingStorefrontV1,
): void {
  database
    .prepare(
      `INSERT INTO shipping_profile (
       merchant_id, shipping_profile_id, revision, origin_location_id,
       lifecycle_state, profile_json
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      command.merchantId,
      command.shippingProfile.shippingProfileId,
      command.shippingProfile.revision,
      command.shippingProfile.originLocationId,
      command.shippingProfile.lifecycle.state,
      JSON.stringify(command.shippingProfile),
    );
  writeVariantShippingSpecification(
    database,
    command.merchantId,
    command.shippingSpecification,
  );
}

export function writeVariantShippingSpecification(
  database: CommerceDatabase,
  merchantId: string,
  specification: VariantShippingSpecification,
): void {
  database
    .prepare(
      `INSERT INTO variant_shipping_specification (
       merchant_id, variant_id, variant_revision, shipping_profile_id,
       shipping_profile_revision, eligibility_kind, specification_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      specification.variantId,
      specification.variantRevision,
      specification.shippingProfileId,
      specification.shippingProfileRevision,
      specification.eligibility.kind,
      JSON.stringify(specification),
    );
}

/**
 * A shipping specification belongs to one variant revision. A variant edit
 * carries it to the new revision, so the edit keeps the variant on sale.
 */
export function carryVariantShippingSpecification(
  database: CommerceDatabase,
  merchantId: string,
  variantId: string,
  fromRevision: number,
  toRevision: number,
): void {
  database
    .prepare(
      `INSERT INTO variant_shipping_specification (
       merchant_id, variant_id, variant_revision, shipping_profile_id,
       shipping_profile_revision, eligibility_kind, specification_json
     )
     SELECT merchant_id, variant_id, ?, shipping_profile_id,
       shipping_profile_revision, eligibility_kind,
       json_set(specification_json, '$.variantRevision', ?)
     FROM variant_shipping_specification
     WHERE merchant_id = ? AND variant_id = ? AND variant_revision = ?`,
    )
    .run(toRevision, toRevision, merchantId, variantId, fromRevision);
}

export function pickupStorefrontObservations(
  command: ConfigureCommercePickupStorefrontV1,
  includeLocation: boolean,
): readonly CommerceAggregateObservationV1[] {
  return storefrontObservations(command, includeLocation);
}

export function shippingStorefrontObservations(
  command: ConfigureCommerceShippingStorefrontV1,
  includeLocation: boolean,
): readonly CommerceAggregateObservationV1[] {
  return storefrontObservations(command, includeLocation);
}

function storefrontObservations(
  command:
    | ConfigureCommercePickupStorefrontV1
    | ConfigureCommerceShippingStorefrontV1,
  includeLocation: boolean,
): readonly CommerceAggregateObservationV1[] {
  const observations: CommerceAggregateObservationV1[] = [];
  if (includeLocation) observations.push(locationObservation(command.location));
  observations.push(
    salesChannelObservation(command.salesChannel),
    productObservation(command.product),
    variantObservation(command.variant),
    offerObservation(command.offer),
  );
  return observations;
}

export function locationObservation(
  resource: CommerceResourcesV1["locations"][number],
): CommerceAggregateObservationV1 {
  return { kind: "location", resource };
}

export function salesChannelObservation(
  resource: CommerceResourcesV1["salesChannels"][number],
): CommerceAggregateObservationV1 {
  return { kind: "sales_channel", resource };
}

export function productObservation(
  resource: CommerceResourcesV1["products"][number],
): CommerceAggregateObservationV1 {
  return { kind: "product", resource };
}

export function variantObservation(
  resource: CommerceResourcesV1["variants"][number],
): CommerceAggregateObservationV1 {
  return { kind: "sellable_variant", resource };
}

function offerObservation(
  resource: CommerceResourcesV1["offers"][number],
): CommerceAggregateObservationV1 {
  return { kind: "offer", resource };
}

function firstExistingStorefrontResource(
  command:
    | ConfigureCommercePickupStorefrontV1
    | ConfigureCommerceShippingStorefrontV1,
  current: CommerceResourcesV1,
): CommerceMutationErrorV1 | undefined {
  const resources: readonly Readonly<{
    kind: string;
    id: string;
    current: readonly Readonly<{ id: string }>[];
  }>[] = [
    {
      kind: "sales_channel",
      id: command.salesChannel.id,
      current: current.salesChannels,
    },
    { kind: "product", id: command.product.id, current: current.products },
    {
      kind: "sellable_variant",
      id: command.variant.id,
      current: current.variants,
    },
    { kind: "offer", id: command.offer.id, current: current.offers },
  ];
  for (const resource of resources) {
    if (findResource(resource.current, resource.id) !== undefined) {
      return {
        code: "resource_already_exists",
        kind: resource.kind,
        id: resource.id,
      };
    }
  }
  return undefined;
}

function checkCatalogRevision(
  kind: string,
  id: string,
  expected: number,
  actual: number | undefined,
): CommerceMutationErrorV1 | undefined {
  if (actual === undefined) return { code: "resource_not_found", kind, id };
  if (actual !== expected)
    return { code: "stale_resource_revision", kind, id, expected, actual };
  return undefined;
}

function findResource<T extends Readonly<{ id: string }>>(
  resources: readonly T[],
  id: string,
): T | undefined {
  return resources.find((resource) => resource.id === id);
}

function sameResource(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
