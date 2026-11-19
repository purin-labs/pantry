// The mutations of the catalog commands: locations, listings, storefronts,
// channel placements and catalog edits, as the ledger commits them.
import { commitOfferPriceChange } from "../offer-price-persistence";
import { type AdjustCommerceOfferPriceV1 } from "@purin-labs/commerce-client";
import {
  writeConsumptionPlan,
  writeStorefront,
} from "../checkout-persistence.ts";
import { CheckoutProfileService } from "../checkout-profile-service.ts";
import type { CommerceDatabase } from "../database.ts";
import { buildStorefrontCheckoutProfileTemplate } from "../checkout-profile-template.ts";
import {
  writeLocation,
  writeOffer,
  writeProduct,
  writeSalesChannel,
  writeVariant,
} from "../commerce-persistence.ts";
import { type CatalogEditPlan } from "./catalog-edits.ts";
import {
  carryVariantShippingSpecification,
  locationObservation,
  pickupStorefrontObservations,
  productObservation,
  salesChannelObservation,
  shippingStorefrontObservations,
  variantObservation,
  writeShippingConfiguration,
  writeVariantShippingSpecification,
} from "./catalog.ts";
import { CollectionAuthority } from "../plugins/collections/index.ts";
import { offerObservation } from "./observations.ts";
import { assertNever } from "@purin-labs/std";
import {
  type ConfigureCommercePickupStorefrontV1,
  type ConfigureCommerceShippingStorefrontV1,
  type CreateCommerceLocationV1,
  type PlaceCommerceChannelListingV1,
  type PrepareCommerceCatalogListingV1,
  type PublishCommerceCatalogListingV1,
  type CommerceOfferV1,
  type CommerceProductV1,
  type UpdateCommerceProductDescriptionV1,
} from "@purin-labs/commerce-client";
import { type Storefront } from "@purin-labs/commerce-contracts";
import type { CommerceMutation, MerchantRow } from "./ledger.ts";

export function locationMutation(
  command: CreateCommerceLocationV1,
  merchant: MerchantRow,
  committedAt: string,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "create_location",
    resource: {
      kind: "location",
      id: command.location.id,
      revision: command.location.revision,
    },
    observations: [locationObservation(command.location)],
    write: (database) => {
      writeLocation(database, command.merchantId, command.location);
    },
  };
}

export function catalogListingPreparationMutation(
  command: PrepareCommerceCatalogListingV1,
  merchant: MerchantRow,
  committedAt: string,
  collections: CollectionAuthority,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "prepare_catalog_listing",
    resource: {
      kind: "offer",
      id: command.offer.id,
      revision: command.offer.revision,
    },
    observations: [
      salesChannelObservation(command.salesChannel),
      productObservation(command.product),
      variantObservation(command.variant),
      offerObservation(command.offer),
    ],
    write: (database) => {
      writeSalesChannel(database, command.merchantId, command.salesChannel);
      writeProduct(database, command.merchantId, command.product);
      writeVariant(database, command.merchantId, command.variant);
      writeOffer(database, command.merchantId, command.offer);
      collections.refreshAutomated(command.merchantId);
      writeConsumptionPlan(
        database,
        command.merchantId,
        command.consumptionPlan,
      );
    },
  };
}

export function productDescriptionMutation(
  command: UpdateCommerceProductDescriptionV1,
  merchant: MerchantRow,
  product: CommerceProductV1,
  committedAt: string,
  collections: CollectionAuthority,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "update_product_description",
    resource: { kind: "product", id: product.id, revision: product.revision },
    observations: [productObservation(product)],
    write: (database) => {
      writeProduct(database, command.merchantId, product);
      collections.refreshAutomated(command.merchantId);
    },
  };
}

export function pickupStorefrontConfigurationMutation(
  command: ConfigureCommercePickupStorefrontV1,
  merchant: MerchantRow,
  createLocation: boolean,
  committedAt: string,
  collections: CollectionAuthority,
  checkoutProfiles: CheckoutProfileService,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "configure_pickup_storefront",
    resource: {
      kind: "storefront",
      id: command.storefront.storefrontId,
      revision: command.storefront.revision,
    },
    observations: pickupStorefrontObservations(command, createLocation),
    write: (database) =>
      writeStorefrontConfiguration(
        database,
        command,
        createLocation,
        committedAt,
        collections,
        checkoutProfiles,
      ),
  };
}

export function shippingStorefrontConfigurationMutation(
  command: ConfigureCommerceShippingStorefrontV1,
  merchant: MerchantRow,
  createLocation: boolean,
  committedAt: string,
  collections: CollectionAuthority,
  checkoutProfiles: CheckoutProfileService,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "configure_shipping_storefront",
    resource: {
      kind: "storefront",
      id: command.storefront.storefrontId,
      revision: command.storefront.revision,
    },
    observations: shippingStorefrontObservations(command, createLocation),
    write: (database) => {
      writeStorefrontConfiguration(
        database,
        command,
        createLocation,
        committedAt,
        collections,
        checkoutProfiles,
      );
      writeShippingConfiguration(database, command);
    },
  };
}

// The catalog, storefront, checkout profile and consumption plan that a
// pickup or a shipping storefront configures.
function writeStorefrontConfiguration(
  database: CommerceDatabase,
  command:
    ConfigureCommercePickupStorefrontV1 | ConfigureCommerceShippingStorefrontV1,
  createLocation: boolean,
  committedAt: string,
  collections: CollectionAuthority,
  checkoutProfiles: CheckoutProfileService,
): void {
  if (createLocation)
    writeLocation(database, command.merchantId, command.location);
  writeSalesChannel(database, command.merchantId, command.salesChannel);
  writeProduct(database, command.merchantId, command.product);
  writeVariant(database, command.merchantId, command.variant);
  writeOffer(database, command.merchantId, command.offer);
  collections.refreshAutomated(command.merchantId);
  writeStorefront(database, command.merchantId, command.storefront);
  ensureStorefrontCheckoutProfile(
    checkoutProfiles,
    command.merchantId,
    command.storefront,
    command.offer.price.currency,
    committedAt,
  );
  writeConsumptionPlan(database, command.merchantId, command.consumptionPlan);
}

export function channelListingPlacementMutation(
  command: PlaceCommerceChannelListingV1,
  merchant: MerchantRow,
  committedAt: string,
  collections: CollectionAuthority,
): CommerceMutation {
  const observations =
    command.catalog.kind === "new_product"
      ? [
          productObservation(command.catalog.product),
          variantObservation(command.catalog.variant),
          offerObservation(command.offer),
        ]
      : command.catalog.kind === "new_variant"
        ? [
            variantObservation(command.catalog.variant),
            offerObservation(command.offer),
          ]
        : [offerObservation(command.offer)];
  return {
    command,
    merchant,
    committedAt,
    commandKind: "place_channel_listing",
    resource: {
      kind: "offer",
      id: command.offer.id,
      revision: command.offer.revision,
    },
    observations,
    write: (database) => {
      if (command.catalog.kind === "new_product")
        writeProduct(database, command.merchantId, command.catalog.product);
      if (
        command.catalog.kind === "new_product" ||
        command.catalog.kind === "new_variant"
      ) {
        writeVariant(database, command.merchantId, command.catalog.variant);
        writeConsumptionPlan(
          database,
          command.merchantId,
          command.catalog.consumptionPlan,
        );
      }
      writeOffer(database, command.merchantId, command.offer);
      collections.refreshAutomated(command.merchantId);
      if (command.shippingSpecification !== undefined) {
        writeVariantShippingSpecification(
          database,
          command.merchantId,
          command.shippingSpecification,
        );
      }
    },
  };
}

export function publishMutation(
  command: PublishCommerceCatalogListingV1,
  merchant: MerchantRow,
  offer: CommerceOfferV1,
  committedAt: string,
  collections: CollectionAuthority,
): CommerceMutation {
  const nextOffer: CommerceOfferV1 = {
    ...offer,
    revision: offer.revision + 1,
    lifecycle: { state: "listed", listedAt: committedAt },
    occurredAt: committedAt,
  };
  return {
    command,
    merchant,
    committedAt,
    commandKind: "publish_catalog_listing",
    effectName: "publish",
    resource: {
      kind: "offer",
      id: nextOffer.id,
      revision: nextOffer.revision,
    },
    observations: [{ kind: "offer", resource: nextOffer }],
    write: (database) => {
      writeOffer(database, command.merchantId, nextOffer);
      collections.refreshAutomated(command.merchantId);
    },
  };
}

export function catalogEditMutation(
  merchant: MerchantRow,
  plan: CatalogEditPlan,
  committedAt: string,
  collections: CollectionAuthority,
): CommerceMutation {
  const { command } = plan;
  const edit =
    plan.kind === "product"
      ? {
          commandKind: "update_product" as const,
          observation: productObservation(plan.product),
          resource: {
            kind: "product" as const,
            id: plan.product.id,
            revision: plan.product.revision,
          },
        }
      : plan.kind === "variant"
        ? {
            commandKind: "update_variant" as const,
            observation: variantObservation(plan.variant),
            resource: {
              kind: "sellable_variant" as const,
              id: plan.variant.id,
              revision: plan.variant.revision,
            },
          }
        : plan.kind === "offer"
          ? {
              commandKind: "update_offer" as const,
              observation: offerObservation(plan.offer),
              resource: {
                kind: "offer" as const,
                id: plan.offer.id,
                revision: plan.offer.revision,
              },
            }
          : {
              commandKind: "update_storefront_tax" as const,
              observation: undefined,
              resource: {
                kind: "storefront" as const,
                id: plan.storefront.storefrontId,
                revision: plan.storefront.revision,
              },
            };
  return {
    command,
    merchant,
    committedAt,
    commandKind: edit.commandKind,
    resource: edit.resource,
    observations: edit.observation === undefined ? [] : [edit.observation],
    write: (database) => {
      switch (plan.kind) {
        case "product":
          writeProduct(database, command.merchantId, plan.product);
          break;
        case "variant":
          writeVariant(database, command.merchantId, plan.variant);
          carryVariantShippingSpecification(
            database,
            command.merchantId,
            plan.variant.id,
            plan.previousRevision,
            plan.variant.revision,
          );
          break;
        case "offer":
          writeOffer(database, command.merchantId, plan.offer);
          break;
        case "storefront":
          writeStorefront(database, command.merchantId, plan.storefront);
          break;
        default:
          assertNever(plan, "Unexpected catalog edit");
      }
      // Automated collection members change with the catalog, under the
      // same receipt.
      collections.refreshAutomated(command.merchantId);
    },
  };
}

function ensureStorefrontCheckoutProfile(
  checkoutProfiles: CheckoutProfileService,
  merchantId: string,
  storefront: Storefront,
  currency: string,
  activatedAt: string,
): void {
  if (
    checkoutProfiles.readActiveForStorefront(
      merchantId,
      storefront.storefrontId,
    ) !== undefined
  ) {
    return;
  }
  const template = buildStorefrontCheckoutProfileTemplate({
    storefront,
    currency,
  });
  const installed = checkoutProfiles.installPublishedTemplateWithinTransaction({
    merchantId,
    storefrontId: storefront.storefrontId,
    checkoutProfileId: template.checkoutProfileId,
    name: template.name,
    configuration: template.configuration,
    installedAt: activatedAt,
    installedBy: "system_storefront_template",
  });
  if (!installed.ok)
    throw new Error(
      `Checkout profile template failed: ${installed.error.code}`,
    );
}

export function offerPriceMutation(
  command: AdjustCommerceOfferPriceV1,
  merchant: MerchantRow,
  offer: CommerceOfferV1,
  committedAt: string,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "adjust_offer_price",
    resource: { kind: "offer", id: offer.id, revision: offer.revision },
    observations: [offerObservation(offer)],
    write: (database) => {
      // Re-check inside the transaction: the decision was made on a read, and
      // a concurrent change between then and here must lose rather than be
      // overwritten.
      const applied = commitOfferPriceChange({
        database,
        merchantId: command.merchantId,
        offerId: command.offerId,
        expectedOfferRevision: command.expectedOfferRevision,
        toPriceMinor: command.proposedPriceMinor,
        currency: command.currency,
        occurredAt: committedAt,
      });
      if (!applied)
        return {
          code: "resource_relationship_invalid",
          field: "offerPrice.offer_revision_stale",
        };
    },
  };
}
