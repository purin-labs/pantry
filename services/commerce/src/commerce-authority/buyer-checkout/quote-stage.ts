import {
  requireCheckoutProfile,
  type CommerceBuyerQuotedCheckoutV1,
  type CommerceBuyerQuotedShippingCheckoutV1,
  checkoutOnlineSource,
} from "@seams/commerce-client";
import { buyerSessionDigest } from "../../buyer-session.ts";
import {
  readCart,
  readCheckout,
  readCheckoutPaymentAttempt,
  readCheckoutPaymentAttemptForCheckout,
} from "../../checkout-persistence.ts";
import { buyerCartMatchesClaims } from "./carts.ts";
import {
  toBuyerCheckoutPaymentProgress,
  toBuyerQuotedPickupCheckout,
  toBuyerQuotedShippingCheckout,
  toBuyerRecoverableQuote,
} from "./quote-views.ts";
import { timestampBefore } from "./shared.ts";
import type {
  BuyerCheckoutProfileClaims,
  BuyerCheckoutRecovery,
} from "./types.ts";
import { BuyerCartStage } from "./cart-stage.ts";

/**
 * Stage 3 of a buyer checkout: the quoted and recoverable checkout reads.
 */
export abstract class BuyerQuoteStage extends BuyerCartStage {
  readBuyerQuotedCheckout(
    merchantId: string,
    checkoutId: string,
    sessionId: string,
  ): CommerceBuyerQuotedCheckoutV1 | undefined {
    const checkout = readCheckout(
      this.options.database,
      merchantId,
      checkoutId,
    );
    if (
      checkout === undefined ||
      checkoutOnlineSource(checkout)?.buyerSessionDigest !==
        buyerSessionDigest(sessionId) ||
      checkout.lifecycle.state !== "quoted" ||
      !timestampBefore(
        this.options.now(),
        checkout.lifecycle.quote.expiresAt,
      ) ||
      checkout.lifecycle.quote.lines.length === 0 ||
      checkout.lifecycle.quote.fulfillment.kind !== "pickup"
    ) {
      return undefined;
    }
    return toBuyerQuotedPickupCheckout(checkout);
  }

  readBuyerQuotedShippingCheckout(
    merchantId: string,
    checkoutId: string,
    sessionId: string,
  ): CommerceBuyerQuotedShippingCheckoutV1 | undefined {
    const checkout = readCheckout(
      this.options.database,
      merchantId,
      checkoutId,
    );
    if (
      checkout === undefined ||
      checkoutOnlineSource(checkout)?.buyerSessionDigest !==
        buyerSessionDigest(sessionId) ||
      checkout.lifecycle.state !== "quoted" ||
      !timestampBefore(
        this.options.now(),
        checkout.lifecycle.quote.expiresAt,
      ) ||
      checkout.lifecycle.quote.lines.length === 0 ||
      checkout.lifecycle.quote.fulfillment.kind !== "shipping"
    ) {
      return undefined;
    }
    return toBuyerQuotedShippingCheckout(checkout);
  }

  readBuyerRecoverableCheckout(
    claims: BuyerCheckoutProfileClaims,
    checkoutId: string,
  ): BuyerCheckoutRecovery | undefined {
    const merchant = this.options.readMerchant(claims.merchantId);
    const context = this.readBuyerStorefrontContext(
      claims.merchantId,
      claims.storefrontId,
    );
    const checkout = readCheckout(
      this.options.database,
      claims.merchantId,
      checkoutId,
    );
    const checkoutOnline =
      checkout === undefined ? undefined : checkoutOnlineSource(checkout);
    if (
      merchant === undefined ||
      context === undefined ||
      context.storefront.revision !== claims.storefrontRevision ||
      checkout === undefined ||
      checkoutOnline === undefined ||
      checkout.checkoutId !== checkoutId ||
      checkoutOnline.storefrontId !== claims.storefrontId ||
      checkoutOnline.buyerSessionDigest !==
        buyerSessionDigest(claims.sessionId) ||
      requireCheckoutProfile(checkout).checkoutProfileId !==
        claims.checkoutProfile.checkoutProfileId ||
      requireCheckoutProfile(checkout).revision !==
        claims.checkoutProfile.revision ||
      checkout.lifecycle.state === "accepted"
    ) {
      return undefined;
    }
    const cart = readCart(
      this.options.database,
      claims.merchantId,
      checkoutOnline.cartId,
    );
    if (
      cart === undefined ||
      !buyerCartMatchesClaims(cart, claims) ||
      cart.lifecycle.state !== "submitted" ||
      cart.lifecycle.checkoutId !== checkoutId
    ) {
      return undefined;
    }
    const recoverableCheckout = toBuyerRecoverableQuote(checkout);
    if (recoverableCheckout === undefined) return undefined;
    if (checkout.lifecycle.state === "quoted") {
      return {
        schemaVersion: "underclerk.buyer-checkout-recovery.v1",
        checkout: recoverableCheckout,
        progress: { state: "quoted" },
      };
    }
    const paymentAttempt =
      checkout.lifecycle.state === "payment_pending"
        ? readCheckoutPaymentAttempt(
            this.options.database,
            claims.merchantId,
            checkout.lifecycle.paymentAttemptId,
          )
        : readCheckoutPaymentAttemptForCheckout(
            this.options.database,
            claims.merchantId,
            checkout.checkoutId,
          );
    if (
      paymentAttempt === undefined &&
      checkout.lifecycle.state === "expired"
    ) {
      return {
        schemaVersion: "underclerk.buyer-checkout-recovery.v1",
        checkout: recoverableCheckout,
        progress: { state: "quoted" },
      };
    }
    const payment = toBuyerCheckoutPaymentProgress(checkout, paymentAttempt);
    return payment === undefined
      ? undefined
      : {
          schemaVersion: "underclerk.buyer-checkout-recovery.v1",
          checkout: recoverableCheckout,
          progress: { state: "payment_pending", payment },
        };
  }
}
