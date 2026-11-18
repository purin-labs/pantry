import { readStorefront } from "../../checkout-persistence.ts";
import {
  type CommerceMutationResultV1,
  type CommerceMediaLibraryV1,
  type CommerceMediaV1,
  type CommerceCollectionPageFilterV1,
  type CommerceCollectionV1,
  parseAdjustOfferPriceCommand,
  type AdjustCommerceOfferPriceV1,
} from "@seams/commerce-client";
import type {
  ShippingProfile,
  Storefront,
  VariantShippingSpecification,
} from "@seams/commerce-contracts";
import { offerPriceMutation } from "../catalog-mutations.ts";
import { rejected, validateMerchant } from "../ledger.ts";
import {
  adjustOfferPriceDecision,
  disableOfferPricePolicy,
  readOfferPricePolicyView,
  setOfferPricePolicy,
  type OfferPriceCommandResult,
  type OfferPricePolicyView,
} from "../offer-price-commands.ts";
import {
  readShippingProfile as readCatalogShippingProfile,
  readVariantShippingSpecification as readCatalogVariantShippingSpecification,
} from "../catalog.ts";
import {
  mediaUsingBytes,
  readMedia,
  variantMedia,
  type StoredMedia,
} from "../../plugins/media/index.ts";
import { CollectionAuthority } from "../../plugins/collections/index.ts";
import { invalidCommand } from "../command-guards.ts";
import { CommerceSnapshotFamily } from "./snapshots.ts";

/**
 * Catalog commands: locations, listings, products, storefronts, media, collections and offer prices.
 */
export abstract class CatalogFamily extends CommerceSnapshotFamily {
  createLocation(rawCommand: unknown): CommerceMutationResultV1 {
    return this.catalogCommands.createLocation(rawCommand);
  }

  prepareCatalogListing(rawCommand: unknown): CommerceMutationResultV1 {
    return this.catalogCommands.prepareCatalogListing(rawCommand);
  }

  updateProductDescription(rawCommand: unknown): CommerceMutationResultV1 {
    return this.catalogCommands.updateProductDescription(rawCommand);
  }

  updateProduct(rawCommand: unknown): CommerceMutationResultV1 {
    return this.catalogCommands.updateProduct(rawCommand);
  }

  deleteProduct(rawCommand: unknown): CommerceMutationResultV1 {
    return this.catalogCommands.deleteProduct(rawCommand);
  }

  /** `uploaded` is what the media store holds under the command's digest. */
  createMedia(
    rawCommand: unknown,
    uploaded: StoredMedia | null,
  ): CommerceMutationResultV1 {
    return this.media.createMedia(rawCommand, uploaded);
  }

  updateMedia(rawCommand: unknown): CommerceMutationResultV1 {
    return this.media.updateMedia(rawCommand);
  }

  deleteMedia(rawCommand: unknown): CommerceMutationResultV1 {
    return this.media.deleteMedia(rawCommand);
  }

  setProductMedia(rawCommand: unknown): CommerceMutationResultV1 {
    return this.media.setProductMedia(rawCommand);
  }

  readMediaLibrary(merchantId: string): CommerceMediaLibraryV1 {
    return this.media.library(merchantId);
  }

  readMedia(
    merchantId: string,
    mediaId: string,
  ): CommerceMediaV1 | undefined {
    return readMedia(this.database, merchantId, mediaId);
  }

  /** How many media records still name these bytes. */
  mediaUsingBytes(merchantId: string, sha256: string): number {
    return mediaUsingBytes(this.database, merchantId, sha256);
  }

  /** An image that this storefront's catalog shows, and nothing else. */
  readStorefrontMedia(
    merchantId: string,
    storefrontId: string,
    mediaId: string,
  ): CommerceMediaV1 | undefined {
    const catalog = this.buyerCheckout.readBuyerCatalog(
      merchantId,
      storefrontId,
    );
    for (const listing of catalog?.listings ?? []) {
      const media = variantMedia(this.database, merchantId, {
        id: listing.variantId,
        productId: listing.productId,
      }).find((item) => item.id === mediaId);
      if (media !== undefined) return media;
    }
    return undefined;
  }

  createCollection(rawCommand: unknown): CommerceMutationResultV1 {
    return this.collections.createCollection(rawCommand);
  }

  updateCollection(rawCommand: unknown): CommerceMutationResultV1 {
    return this.collections.updateCollection(rawCommand);
  }

  deleteCollection(rawCommand: unknown): CommerceMutationResultV1 {
    return this.collections.deleteCollection(rawCommand);
  }

  listCollections(merchantId: string): readonly CommerceCollectionV1[] {
    return this.collections.listCollections(merchantId);
  }

  readBuyerCollections(
    merchantId: string,
    salesChannelId: string,
  ): ReturnType<CollectionAuthority["buyerCollections"]> {
    return this.collections.buyerCollections(merchantId, salesChannelId);
  }

  readBuyerCollectionPage(
    merchantId: string,
    salesChannelId: string,
    handle: string,
    filter: CommerceCollectionPageFilterV1,
  ): ReturnType<CollectionAuthority["buyerCollectionPage"]> {
    return this.collections.buyerCollectionPage(
      merchantId,
      salesChannelId,
      handle,
      filter,
    );
  }

  updateVariant(rawCommand: unknown): CommerceMutationResultV1 {
    return this.catalogCommands.updateVariant(rawCommand);
  }

  updateOffer(rawCommand: unknown): CommerceMutationResultV1 {
    return this.catalogCommands.updateOffer(rawCommand);
  }

  updateStorefrontTax(rawCommand: unknown): CommerceMutationResultV1 {
    return this.catalogCommands.updateStorefrontTax(rawCommand);
  }

  configurePickupStorefront(rawCommand: unknown): CommerceMutationResultV1 {
    return this.catalogCommands.configurePickupStorefront(rawCommand);
  }

  configureShippingStorefront(rawCommand: unknown): CommerceMutationResultV1 {
    return this.catalogCommands.configureShippingStorefront(rawCommand);
  }

  placeChannelListing(rawCommand: unknown): CommerceMutationResultV1 {
    return this.catalogCommands.placeChannelListing(rawCommand);
  }

  readShippingProfile(
    merchantId: string,
    shippingProfileId: string,
  ): ShippingProfile | undefined {
    return readCatalogShippingProfile(
      this.database,
      merchantId,
      shippingProfileId,
    );
  }

  readVariantShippingSpecification(
    merchantId: string,
    variantId: string,
    variantRevision: number,
  ): VariantShippingSpecification | undefined {
    return readCatalogVariantShippingSpecification(
      this.database,
      merchantId,
      variantId,
      variantRevision,
    );
  }

  /**
   * Reads one Offer's price allowance beside the price it applies to.
   *
   * An Offer with no policy reports a disabled one at revision zero, which is
   * the same refusal a stored disabled policy gives.
   */
  readOfferPricePolicy(
    merchantId: string,
    offerId: string,
  ): OfferPriceCommandResult<OfferPricePolicyView> {
    return readOfferPricePolicyView(this.database, merchantId, offerId);
  }

  /** Enables a price allowance, or resets an enabled one to today's price. */
  setOfferPricePolicy(
    input: Readonly<{
      merchantId: string;
      offerId: string;
      expectedRevision: number | null;
      maxMovementBps: number;
      occurredAt: string;
    }>,
  ): OfferPriceCommandResult<OfferPricePolicyView> {
    return setOfferPricePolicy({ database: this.database, ...input });
  }

  /** Withdraws all pricing authority for one Offer. */
  disableOfferPricePolicy(
    input: Readonly<{
      merchantId: string;
      offerId: string;
      expectedRevision: number;
      occurredAt: string;
    }>,
  ): OfferPriceCommandResult<OfferPricePolicyView> {
    return disableOfferPricePolicy({ database: this.database, ...input });
  }

  /**
   * Applies one approved price change.
   *
   * Every check runs here against state read now — the policy, both revisions,
   * the currency, the listing state, and the allowance — because an approval
   * is permission to attempt the change, not evidence it is still valid. The
   * committed price advances the Offer atomically with its receipt and a
   * signed observation, so the change and the evidence of it cannot diverge.
   */
  adjustOfferPrice(rawCommand: unknown): CommerceMutationResultV1 {
    let command: AdjustCommerceOfferPriceV1;
    try {
      command = parseAdjustOfferPriceCommand(rawCommand);
    } catch (error) {
      return rejected(invalidCommand(error));
    }
    const merchant = this.ledger.readMerchant(command.merchantId);
    if (merchant === undefined) {
      return rejected({
        code: "resource_not_found",
        kind: "merchant",
        id: command.merchantId,
      });
    }
    const replay = this.ledger.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    const merchantCheck = validateMerchant(command.merchantId, merchant);
    if (merchantCheck !== undefined) return rejected(merchantCheck);

    const decided = adjustOfferPriceDecision({
      database: this.database,
      command: {
        merchantId: command.merchantId,
        offerId: command.offerId,
        expectedOfferRevision: command.expectedOfferRevision,
        expectedPolicyRevision: command.expectedPolicyRevision,
        proposedPriceMinor: command.proposedPriceMinor,
        currency: command.currency,
      },
    });
    if (!decided.ok) {
      return rejected({
        code: "resource_relationship_invalid",
        field: `offerPrice.${decided.refusal.code}`,
      });
    }

    return this.ledger.commit(
      offerPriceMutation(command, merchant, decided.value.offer, this.now()),
    );
  }

  publishCatalogListing(rawCommand: unknown): CommerceMutationResultV1 {
    return this.catalogCommands.publishCatalogListing(rawCommand);
  }

  /** One storefront: its sales channel, fulfillment and checkout. */
  readStorefront(
    merchantId: string,
    storefrontId: string,
  ): Storefront | undefined {
    return readStorefront(this.database, merchantId, storefrontId);
  }
}
