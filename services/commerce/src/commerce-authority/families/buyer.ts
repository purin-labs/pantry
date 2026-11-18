import {
  type CommerceBuyerCatalogV1,
  type CreateCommerceBuyerCartV1,
  type ReplaceCommerceBuyerCartV1,
  type CommerceBuyerCartV1,
  type CommerceBuyerQuotedCheckoutV1,
  type CommerceBuyerQuotedShippingCheckoutV1,
  type ReconcileCommerceBuyerPaymentV1,
  type CommerceBuyerOrderV1,
} from "@seams/commerce-client";
import { BuyerCheckoutAuthority } from "../buyer-checkout.ts";
import type {
  BuyerCartMutation,
  BuyerCheckoutCreation,
  BuyerCheckoutProfileClaims,
  BuyerPaymentResult,
  BuyerPaymentSessionResult,
  BuyerCheckoutRecovery,
  ResolvedCreateBuyerPickupCheckoutV1,
  ResolvedCreateBuyerShippingCheckoutV1,
  ResolvedRefreshBuyerPickupCheckoutV1,
  ResolvedRefreshBuyerShippingCheckoutV1,
  BuyerShippingCheckoutCreation,
  BuyerStorefrontContext,
} from "../buyer-checkout/types.ts";
import type { CommerceUnplacedCapturesV1 } from "@seams/commerce-contracts/records/api-unplaced-captures";
import {
  listUnplacedCaptures,
  resolveUnplacedCapture,
  type UnplacedCaptureResolution,
} from "../../payments/unplaced-captures.ts";
import { PaymentFamily } from "./payments.ts";

/**
 * The buyer checkout of a storefront, through BuyerCheckoutAuthority.
 */
export abstract class BuyerFamily extends PaymentFamily {
  readBuyerStorefrontContext(
    merchantId: string,
    storefrontId: string,
  ): BuyerStorefrontContext | undefined {
    return this.buyerCheckout.readBuyerStorefrontContext(
      merchantId,
      storefrontId,
    );
  }

  readBuyerCatalog(
    merchantId: string,
    storefrontId: string,
    mediaBaseUrl?: string,
  ): CommerceBuyerCatalogV1 | undefined {
    return this.buyerCheckout.readBuyerCatalog(
      merchantId,
      storefrontId,
      mediaBaseUrl,
    );
  }

  createBuyerCart(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      command: CreateCommerceBuyerCartV1;
    }>,
  ): BuyerCartMutation {
    return this.buyerCheckout.createBuyerCart(input);
  }

  readBuyerCart(
    claims: BuyerCheckoutProfileClaims,
    cartId: string,
  ): CommerceBuyerCartV1 | undefined {
    return this.buyerCheckout.readBuyerCart(claims, cartId);
  }

  replaceBuyerCart(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      cartId: string;
      command: ReplaceCommerceBuyerCartV1;
    }>,
  ): BuyerCartMutation {
    return this.buyerCheckout.replaceBuyerCart(input);
  }

  createBuyerPickupCheckout(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      command: ResolvedCreateBuyerPickupCheckoutV1;
    }>,
  ): BuyerCheckoutCreation {
    return this.buyerCheckout.createBuyerPickupCheckout(input);
  }

  createBuyerShippingCheckout(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      command: ResolvedCreateBuyerShippingCheckoutV1;
    }>,
  ): BuyerShippingCheckoutCreation {
    return this.buyerCheckout.createBuyerShippingCheckout(input);
  }

  refreshBuyerPickupCheckout(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      checkoutId: string;
      command: ResolvedRefreshBuyerPickupCheckoutV1;
    }>,
  ): BuyerCheckoutCreation {
    return this.buyerCheckout.refreshBuyerPickupCheckout(input);
  }

  refreshBuyerShippingCheckout(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      checkoutId: string;
      command: ResolvedRefreshBuyerShippingCheckoutV1;
    }>,
  ): BuyerShippingCheckoutCreation {
    return this.buyerCheckout.refreshBuyerShippingCheckout(input);
  }

  readBuyerQuotedCheckout(
    merchantId: string,
    checkoutId: string,
    sessionId: string,
  ): CommerceBuyerQuotedCheckoutV1 | undefined {
    return this.buyerCheckout.readBuyerQuotedCheckout(
      merchantId,
      checkoutId,
      sessionId,
    );
  }

  readBuyerQuotedShippingCheckout(
    merchantId: string,
    checkoutId: string,
    sessionId: string,
  ): CommerceBuyerQuotedShippingCheckoutV1 | undefined {
    return this.buyerCheckout.readBuyerQuotedShippingCheckout(
      merchantId,
      checkoutId,
      sessionId,
    );
  }

  readBuyerRecoverableCheckout(
    claims: BuyerCheckoutProfileClaims,
    checkoutId: string,
  ): BuyerCheckoutRecovery | undefined {
    return this.buyerCheckout.readBuyerRecoverableCheckout(claims, checkoutId);
  }

  async createBuyerPaymentSession(
    input: Parameters<BuyerCheckoutAuthority["createBuyerPaymentSession"]>[0],
  ): Promise<BuyerPaymentSessionResult> {
    return this.buyerCheckout.createBuyerPaymentSession(input);
  }

  /** Places a captured online payment's order from a provider notification. */
  settleOnlineCheckoutPayment(
    merchantId: string,
    paymentAttemptId: string,
  ): ReturnType<BuyerCheckoutAuthority["settleOnlineCheckoutPayment"]> {
    return this.buyerCheckout.settleOnlineCheckoutPayment(
      merchantId,
      paymentAttemptId,
    );
  }

  /**
   * The `payment_due` pass of the alarm: settles the online payments that are
   * due, and returns when the next one is due.
   */
  reconcileDuePayments(): Promise<string | null> {
    return this.buyerCheckout.reconcileDuePayments();
  }

  /** The captures that placed no order, for staff (spec section 12). */
  listUnplacedCaptures(
    merchantId: string,
  ): CommerceUnplacedCapturesV1 | undefined {
    return !this.hasMerchant(merchantId)
      ? undefined
      : listUnplacedCaptures(this.database, merchantId);
  }

  /** Staff record what they did for a capture that placed no order. */
  resolveUnplacedCapture(
    merchantId: string,
    paymentAttemptId: string,
    body: unknown,
  ): UnplacedCaptureResolution {
    return resolveUnplacedCapture(
      this.database,
      merchantId,
      paymentAttemptId,
      body,
      this.now(),
    );
  }

  placeBuyerStoredValueCheckout(
    input: Parameters<
      BuyerCheckoutAuthority["placeBuyerStoredValueCheckout"]
    >[0],
  ): ReturnType<BuyerCheckoutAuthority["placeBuyerStoredValueCheckout"]> {
    return this.buyerCheckout.placeBuyerStoredValueCheckout(input);
  }

  async reconcileBuyerCheckoutPayment(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      checkoutId: string;
      command: ReconcileCommerceBuyerPaymentV1;
    }>,
  ): Promise<BuyerPaymentResult> {
    return this.buyerCheckout.reconcileBuyerCheckoutPayment(input);
  }

  readBuyerOrderPlacement(
    merchantId: string,
    checkoutId: string,
    sessionId: string,
    storefrontId: string,
    orderId: string,
    paymentId: string,
    fulfillmentId: string,
  ): ReturnType<BuyerCheckoutAuthority["readBuyerOrderPlacement"]> {
    return this.buyerCheckout.readBuyerOrderPlacement(
      merchantId,
      checkoutId,
      sessionId,
      storefrontId,
      orderId,
      paymentId,
      fulfillmentId,
    );
  }

  readBuyerOrder(
    merchantId: string,
    storefrontId: string,
    checkoutId: string,
    sessionId: string,
  ): CommerceBuyerOrderV1 | undefined {
    return this.buyerCheckout.readBuyerOrder(
      merchantId,
      storefrontId,
      checkoutId,
      sessionId,
    );
  }
}
