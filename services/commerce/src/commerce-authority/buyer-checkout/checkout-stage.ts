import { buyerSessionDigest } from "../../buyer-session.ts";
import { readCart, readCheckout } from "../../checkout-persistence.ts";
import {
  type BuyerShippingCheckoutCommand,
  type DraftPriceOverride,
} from "../checkout-planning.ts";
import type {
  CommerceDraftOrderV1,
  CommerceMutationErrorV1,
} from "@seams/commerce-client";
import type { Cart } from "@seams/commerce-contracts";
import { sha256, timestampBefore } from "../checkout-shared.ts";
import { buyerIdentityRejected } from "./placements.ts";
import {
  buyerCheckoutCartMissing,
  buyerCheckoutCartReferenceError,
  buyerCheckoutIdentityDigest,
  buyerShippingCapabilityUnavailable,
  buyerShippingServiceIsAvailable,
  createCheckoutBuyerAuthority,
  pickupCheckoutLinesFromCart,
  shippingCheckoutLinesFromCart,
} from "./quotes.ts";
import type {
  BuyerCheckoutCreation,
  BuyerCheckoutProfileClaims,
  BuyerShippingCheckoutCreation,
  ResolvedCreateBuyerPickupCheckoutV1,
  ResolvedCreateBuyerShippingCheckoutV1,
} from "./types.ts";
import { BuyerQuoteStage } from "./quote-stage.ts";

/**
 * Stage 4 of a buyer checkout: pickup, draft and shipping checkouts from a cart.
 */
export abstract class BuyerCheckoutCreationStage extends BuyerQuoteStage {
  createBuyerPickupCheckout(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      command: ResolvedCreateBuyerPickupCheckoutV1;
    }>,
  ): BuyerCheckoutCreation {
    const identityDigest = buyerCheckoutIdentityDigest(
      input.claims,
      input.command.idempotencyKey,
    );
    return this.createPickupCheckout({
      ...input,
      identityDigest,
      checkoutId: `checkout_${identityDigest}`,
    });
  }

  /**
   * Makes the checkout for a draft order invoice: a cart from the draft lines
   * and a quote at the staff prices, for the session the invoice opened.
   */
  createDraftPickupCheckout(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      draft: CommerceDraftOrderV1;
      buyerEmail: string;
      checkoutId: string;
    }>,
  ): BuyerCheckoutCreation {
    const cart = this.createBuyerCart({
      claims: input.claims,
      command: {
        schemaVersion: "underclerk.create-buyer-cart.v1",
        idempotencyKey: `${input.checkoutId}_cart`,
        lines: input.draft.lines.map((line) => ({
          kind: "catalog" as const,
          variantId: line.variantId,
          quantity: line.quantity,
        })),
      },
    });
    if (cart.kind === "rejected") return cart;
    const priceOverrides: DraftPriceOverride[] = [];
    for (const line of input.draft.lines)
      if (line.priceOverride !== null)
        priceOverrides.push({
          variantId: line.variantId,
          ...line.priceOverride,
        });
    return this.createPickupCheckout({
      claims: input.claims,
      command: {
        schemaVersion: "underclerk.create-buyer-pickup-checkout.v1",
        idempotencyKey: input.checkoutId,
        cartId: cart.cart.cartId,
        cartRevision: cart.cart.revision,
        buyer: {
          kind: "guest",
          contact: { kind: "email", email: input.buyerEmail },
        },
      },
      identityDigest: sha256(
        JSON.stringify([input.claims.merchantId, input.checkoutId]),
      ),
      checkoutId: input.checkoutId,
      priceOverrides,
    });
  }

  protected createPickupCheckout(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      command: ResolvedCreateBuyerPickupCheckoutV1;
      identityDigest: string;
      checkoutId: string;
      priceOverrides?: readonly DraftPriceOverride[];
    }>,
  ): BuyerCheckoutCreation {
    const merchant = this.options.readMerchant(input.claims.merchantId);
    if (merchant === undefined) {
      throw new Error("Verified buyer session lost its merchant");
    }
    const { identityDigest, checkoutId } = input;
    const cart = this.#checkoutCart(input.claims, input.command, checkoutId);
    if ("error" in cart) {
      return cart;
    }
    const buyerAuthority = createCheckoutBuyerAuthority(
      input.claims,
      input.command.buyer,
    );
    if (buyerAuthority === undefined) return buyerIdentityRejected();
    const result = this.submitBuyerPickupCheckout({
      schemaVersion: "underclerk.submit-buyer-pickup-cart.v1",
      merchantId: input.claims.merchantId,
      expectedMerchantRevision: merchant.revision,
      idempotencyKey: `buyer_checkout_${identityDigest}`,
      requestedAt: this.options.now(),
      storefrontId: input.claims.storefrontId,
      storefrontRevision: input.claims.storefrontRevision,
      checkoutProfile: input.claims.checkoutProfile,
      buyerSessionDigest: buyerSessionDigest(input.claims.sessionId),
      buyerAuthority,
      cartId: cart.cartId,
      cartRevision: input.command.cartRevision,
      checkoutId,
      lines: pickupCheckoutLinesFromCart(cart, identityDigest),
      ...(input.priceOverrides === undefined ||
      input.priceOverrides.length === 0
        ? {}
        : { priceOverrides: input.priceOverrides }),
      ...this.#checkoutOffers(input.claims, input.command),
      ...(input.command.pickupAt === undefined
        ? {}
        : { pickupAt: input.command.pickupAt }),
    });
    if (result.outcome === "rejected")
      return { kind: "rejected", error: result.error };
    this.recordBuyer(input.claims, checkoutId, input.command.buyer);
    const checkout = this.readBuyerQuotedCheckout(
      input.claims.merchantId,
      checkoutId,
      input.claims.sessionId,
    );
    if (checkout === undefined) {
      const appliedCheckout = readCheckout(
        this.options.database,
        input.claims.merchantId,
        checkoutId,
      );
      if (
        appliedCheckout?.lifecycle.state === "quoted" &&
        !timestampBefore(
          this.options.now(),
          appliedCheckout.lifecycle.quote.expiresAt,
        )
      ) {
        return {
          kind: "rejected",
          error: {
            code: "checkout_quote_expired",
            checkoutId,
            expiresAt: appliedCheckout.lifecycle.quote.expiresAt,
          },
        };
      }
      return {
        kind: "rejected",
        error: {
          code: "idempotency_conflict",
          idempotencyKey: input.command.idempotencyKey,
        },
      };
    }
    return { kind: "created", checkout };
  }

  createBuyerShippingCheckout(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      command: ResolvedCreateBuyerShippingCheckoutV1;
    }>,
  ): BuyerShippingCheckoutCreation {
    const merchant = this.options.readMerchant(input.claims.merchantId);
    if (merchant === undefined) {
      throw new Error("Verified buyer session lost its merchant");
    }
    const identityDigest = buyerCheckoutIdentityDigest(
      input.claims,
      input.command.idempotencyKey,
    );
    const checkoutId = `checkout_${identityDigest}`;
    const cart = this.#checkoutCart(input.claims, input.command, checkoutId);
    if ("error" in cart) {
      return cart;
    }
    if (
      !buyerShippingServiceIsAvailable(
        this.readBuyerCatalog(
          input.claims.merchantId,
          input.claims.storefrontId,
        ),
        input.command.shippingDestination.address.countryCode,
        input.command.shippingServiceCode,
      )
    ) {
      return buyerShippingCapabilityUnavailable();
    }
    const buyerAuthority = createCheckoutBuyerAuthority(
      input.claims,
      input.command.buyer,
    );
    if (buyerAuthority === undefined) return buyerIdentityRejected();
    const command: BuyerShippingCheckoutCommand = {
      schemaVersion: "underclerk.create-buyer-shipping-checkout.internal.v1",
      merchantId: input.claims.merchantId,
      expectedMerchantRevision: merchant.revision,
      idempotencyKey: `buyer_shipping_checkout_${identityDigest}`,
      requestedAt: this.options.now(),
      storefrontId: input.claims.storefrontId,
      storefrontRevision: input.claims.storefrontRevision,
      checkoutProfile: input.claims.checkoutProfile,
      buyerSessionDigest: buyerSessionDigest(input.claims.sessionId),
      buyerAuthority,
      cartId: cart.cartId,
      cartRevision: input.command.cartRevision,
      checkoutId,
      lines: shippingCheckoutLinesFromCart(cart, identityDigest),
      shippingServiceCode: input.command.shippingServiceCode,
      shippingDestination: input.command.shippingDestination,
      ...this.#checkoutOffers(input.claims, input.command),
    };
    const result = this.submitBuyerShippingCheckout(command);
    if (result.outcome === "rejected")
      return { kind: "rejected", error: result.error };
    this.recordBuyer(input.claims, checkoutId, input.command.buyer);
    const checkout = this.readBuyerQuotedShippingCheckout(
      command.merchantId,
      command.checkoutId,
      input.claims.sessionId,
    );
    return checkout === undefined
      ? {
          kind: "rejected",
          error: {
            code: "idempotency_conflict",
            idempotencyKey: input.command.idempotencyKey,
          },
        }
      : { kind: "created", checkout };
  }

  // The buyer's cart that a new checkout names, at the revision it names.
  #checkoutCart(
    claims: BuyerCheckoutProfileClaims,
    command: Readonly<{ cartId: string; cartRevision: number }>,
    checkoutId: string,
  ): Cart | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }> {
    const cart = readCart(
      this.options.database,
      claims.merchantId,
      command.cartId,
    );
    const cartError = buyerCheckoutCartReferenceError(
      cart,
      claims,
      command.cartId,
      command.cartRevision,
      checkoutId,
    );
    return cartError !== undefined || cart === undefined
      ? {
          kind: "rejected",
          error: cartError ?? buyerCheckoutCartMissing(command.cartId),
        }
      : cart;
  }

  // The discount codes, market and stored value that a new checkout uses.
  #checkoutOffers(
    claims: BuyerCheckoutProfileClaims,
    command:
      | ResolvedCreateBuyerPickupCheckoutV1
      | ResolvedCreateBuyerShippingCheckoutV1,
  ) {
    return {
      discount: {
        codes: command.discountCodes ?? [],
        customerId: this.customerIdOf(claims, command.buyer),
      },
      ...(command.marketId === undefined ? {} : { marketId: command.marketId }),
      ...(command.giftCardCodes === undefined && command.storeCredit !== true
        ? {}
        : {
            storedValue: {
              giftCardCodes: command.giftCardCodes ?? [],
              customerId: this.customerIdOf(claims, command.buyer),
              storeCredit: command.storeCredit === true,
            },
          }),
    };
  }
}
