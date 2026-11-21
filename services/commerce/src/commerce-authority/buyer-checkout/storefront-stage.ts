import {
  type CommerceBuyerCatalogListingV1,
  type CommerceBuyerCatalogV1,
} from "@purin-labs/commerce-client";
import { readStorefront } from "../../checkout-persistence.ts";
import {
  listOffers,
  listProducts,
  listSalesChannels,
  listVariants,
} from "../../commerce-persistence.ts";
import {
  buyerVariantIsAvailable,
  shippingVariantIsEligible,
} from "../checkout-planning.ts";
import { findResource, variantIsSellable } from "../checkout-shared.ts";
import { variantMedia } from "../../plugins/media/index.ts";
import { pluginActive } from "../../plugins/plugin-state.ts";
import { buyerCatalogStorefront } from "./carts.ts";
import { requireIdentity } from "../command-guards.ts";
import type { BuyerStorefrontContext } from "./types.ts";
import { BuyerCheckoutBase } from "./base.ts";

/**
 * Stage 1 of a buyer checkout: the storefront and its catalog.
 */
export abstract class BuyerStorefrontStage extends BuyerCheckoutBase {
  readBuyerStorefrontContext(
    merchantId: string,
    storefrontId: string,
  ): BuyerStorefrontContext | undefined {
    const merchant = this.options.readMerchant(
      requireIdentity(merchantId, "merchantId"),
    );
    if (merchant === undefined) return undefined;
    const storefront = readStorefront(
      this.options.database,
      merchant.merchantId,
      requireIdentity(storefrontId, "storefrontId"),
    );
    if (storefront?.lifecycle.state !== "active") {
      return undefined;
    }
    const salesChannel = findResource(
      listSalesChannels(this.options.database, merchant.merchantId),
      storefront.salesChannelId,
    );
    if (salesChannel?.lifecycle.state !== "active") return undefined;
    return { organisationId: merchant.organisationId, storefront };
  }

  /**
   * `mediaBaseUrl` is where this storefront serves uploaded images; without
   * it the catalog lists only the variants' own image links.
   */
  readBuyerCatalog(
    merchantId: string,
    storefrontId: string,
    mediaBaseUrl?: string,
  ): CommerceBuyerCatalogV1 | undefined {
    const context = this.readBuyerStorefrontContext(merchantId, storefrontId);
    if (context === undefined) return undefined;
    const products = listProducts(this.options.database, merchantId);
    const variants = listVariants(this.options.database, merchantId);
    const offers = listOffers(this.options.database, merchantId);
    const foodService = this.options.readFoodServiceResources(merchantId);
    const listings: CommerceBuyerCatalogListingV1[] = [];
    // A paused food service plugin keeps no marks; one read for the whole list.
    const soldOut: ReadonlySet<string> = pluginActive(
      this.options.database,
      merchantId,
      "food_service",
    )
      ? (this.options.foodService?.menus.soldOutVariants(
          this.options.database,
          merchantId,
          context.storefront.fulfillment.kind === "pickup"
            ? context.storefront.fulfillment.locationId
            : context.storefront.fulfillment.originLocationId,
          this.options.now(),
        ) ?? new Set<string>())
      : new Set<string>();
    for (const offer of offers) {
      if (
        offer.salesChannelId !== context.storefront.salesChannelId ||
        offer.lifecycle.state !== "listed"
      ) {
        continue;
      }
      const variant = findResource(variants, offer.variantId);
      const product =
        variant === undefined
          ? undefined
          : findResource(products, variant.productId);
      if (
        variant === undefined ||
        product === undefined ||
        !variantIsSellable(products, variant)
      )
        continue;
      const locationId =
        context.storefront.fulfillment.kind === "pickup"
          ? context.storefront.fulfillment.locationId
          : context.storefront.fulfillment.originLocationId;
      const shippingEligible =
        context.storefront.fulfillment.kind === "pickup" ||
        shippingVariantIsEligible(
          this.options.database,
          merchantId,
          variant.id,
          variant.revision,
          context.storefront.fulfillment.shippingProfileId,
        );
      listings.push({
        productId: product.id,
        productRevision: product.revision,
        title: product.title,
        description: product.description,
        variantId: variant.id,
        variantRevision: variant.revision,
        variantTitle: variant.title,
        sku: variant.sku,
        offerId: offer.id,
        offerRevision: offer.revision,
        price: offer.price,
        compareAtPrice: offer.compareAtPrice,
        handle: product.handle,
        options: variant.options,
        media: [
          ...(mediaBaseUrl === undefined
            ? []
            : variantMedia(this.options.database, merchantId, variant).map(
                (media) => ({
                  kind: "image" as const,
                  // The digest in the link lets caches keep the bytes for long.
                  url: `${mediaBaseUrl}${encodeURIComponent(media.id)}?v=${media.sha256.slice(0, 16)}`,
                  altText: media.altText,
                }),
              )),
          ...variant.media,
        ],
        availability: buyerVariantIsAvailable(
          this.options.database,
          merchantId,
          locationId,
          variant.id,
          offer.availability.state === "available" &&
            shippingEligible &&
            !soldOut.has(variant.id),
          this.options.now(),
        )
          ? "available"
          : "unavailable",
      });
    }
    // A paused food service plugin shows no menus.
    const menus =
      context.storefront.fulfillment.kind === "pickup" &&
      pluginActive(this.options.database, merchantId, "food_service")
        ? (this.options.foodService?.menus.buyerMenus({
            database: this.options.database,
            merchantId,
            foodService,
            resources: { offers, variants, products },
            salesChannelId: context.storefront.salesChannelId,
            locationId: context.storefront.fulfillment.locationId,
            now: this.options.now(),
          }) ?? [])
        : [];
    const buyerStorefront = buyerCatalogStorefront(
      this.options.database,
      merchantId,
      context.storefront,
      this.options.shipping(merchantId),
      this.options.checkoutCapabilityHealthProvider,
    );
    if (buyerStorefront === undefined) return undefined;
    return {
      schemaVersion: "commerce.buyer-catalog.v1",
      storefront: buyerStorefront,
      listings,
      menus,
    };
  }
}
