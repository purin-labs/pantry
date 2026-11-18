import {
  checkoutProfileOf,
  requireCheckoutProfile,
  type CommerceBuyerOrderV1,
  type CommerceBuyerPaymentResultV1,
  checkoutOnlineSource,
  type PlaceCommerceBuyerStoredValueCheckoutV1,
} from "@seams/commerce-client";
import { type PaymentDispute } from "@seams/commerce-contracts";
import { buyerSessionDigest } from "../../buyer-session.ts";
import {
  readCheckout,
  readCheckoutPaymentAttempt,
} from "../../checkout-persistence.ts";
import {
  listPaymentDisputesForOrder,
  listRefundAttemptsForOrder,
} from "../../payments/payment-records.ts";
import {
  listFulfillments,
  listOrders,
  listPayments,
  listShipments,
} from "../../commerce-persistence.ts";
import {
  checkoutOrderProfileMatches,
  findResource,
  sameMoney,
} from "../checkout-shared.ts";
import type { VariantBy } from "@seams/type-utils";
import { balanceCheckoutOrder, readPaymentChange } from "../order-changes.ts";
import { storedValuePaymentId } from "../../plugins/stored-value/index.ts";
import {
  buyerPaymentDisputeStatuses,
  buyerPaymentIdentityDigest,
  buyerPaymentMatchesAcceptedTender,
} from "./payments.ts";
import {
  buyerCancellationRefundStatus,
  buyerPlacementFulfillmentState,
  onlyBuyerOrder,
  onlyFulfillmentForOrder,
  orderBuyer,
  placedOrderPayments,
  placedPaymentMatches,
} from "./placements.ts";
import type {
  BuyerCheckoutProfileClaims,
  BuyerPaymentResult,
  WithoutOrderRecovery,
} from "./types.ts";
import { BuyerPaymentStage } from "./payment-stage.ts";

/**
 * Stage 7 of a buyer checkout: the placed order, the balance and the stored-value checkout.
 */
export abstract class BuyerPlacementStage extends BuyerPaymentStage {
  /**
   * Places a quoted checkout that gift cards and store credit pay in full.
   * A repeated request answers with the same placement.
   */
  placeBuyerStoredValueCheckout(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      checkoutId: string;
      command: PlaceCommerceBuyerStoredValueCheckoutV1;
    }>,
  ): BuyerPaymentResult {
    const merchant = this.options.readMerchant(input.claims.merchantId);
    if (merchant === undefined)
      throw new Error("Verified buyer session lost its merchant");
    const identityDigest = buyerPaymentIdentityDigest(input);
    const orderId = `order_${identityDigest}`;
    const fulfillmentId = `fulfillment_${identityDigest}`;
    const checkout = readCheckout(
      this.options.database,
      input.claims.merchantId,
      input.checkoutId,
    );
    const tender = checkout?.lifecycle.quote.storedValue?.tenders[0];
    if (
      checkout === undefined ||
      tender === undefined ||
      checkoutOnlineSource(checkout)?.buyerSessionDigest !==
        buyerSessionDigest(input.claims.sessionId) ||
      checkoutOnlineSource(checkout)?.storefrontId !== input.claims.storefrontId
    )
      return {
        kind: "rejected",
        error: {
          code: "resource_not_found",
          kind: "checkout",
          id: input.checkoutId,
        },
      };
    const paymentId = storedValuePaymentId(orderId, tender.accountId);
    const readPlacement = () =>
      this.readBuyerOrderPlacement(
        input.claims.merchantId,
        input.checkoutId,
        input.claims.sessionId,
        input.claims.storefrontId,
        orderId,
        paymentId,
        fulfillmentId,
      );
    const existing = readPlacement();
    if (existing !== undefined) return { kind: "resolved", result: existing };
    const placed = this.options.checkoutCommands.placeStoredValueCheckout({
      schemaVersion: "underclerk.place-stored-value-checkout.v1",
      merchantId: input.claims.merchantId,
      expectedMerchantRevision: merchant.revision,
      idempotencyKey: `buyer_stored_value_place_${identityDigest}`,
      requestedAt: this.options.now(),
      checkoutId: input.checkoutId,
      checkoutRevision: input.command.checkoutRevision,
      quoteDigest: input.command.quoteDigest,
      orderId,
      paymentId,
      fulfillmentId,
      buyer: orderBuyer(input.claims),
      placement:
        checkout.lifecycle.quote.fulfillment.kind === "pickup"
          ? { kind: "pickup" }
          : { kind: "shipping", shipmentId: `shipment_${identityDigest}` },
    });
    if (placed.outcome === "rejected")
      return { kind: "rejected", error: placed.error };
    const placement = readPlacement();
    if (placement === undefined)
      throw new Error("Applied buyer placement is unavailable");
    return { kind: "resolved", result: placement };
  }

  /** The result of a paid balance checkout: its payment joined the order. */
  readBuyerBalancePlacement(
    merchantId: string,
    checkoutId: string,
    sessionId: string,
    storefrontId: string,
    paymentId: string,
  ):
    | WithoutOrderRecovery<
        VariantBy<CommerceBuyerPaymentResultV1, "state", "placed">
      >
    | undefined {
    const checkout = readCheckout(
      this.options.database,
      merchantId,
      checkoutId,
    );
    const balance =
      checkout === undefined ? undefined : balanceCheckoutOrder(checkout);
    if (
      checkout === undefined ||
      balance === undefined ||
      checkoutOnlineSource(checkout)?.buyerSessionDigest !==
        buyerSessionDigest(sessionId) ||
      checkoutOnlineSource(checkout)?.storefrontId !== storefrontId ||
      checkout.lifecycle.state !== "accepted" ||
      checkout.lifecycle.orderId !== balance.orderId ||
      checkout.lifecycle.quote.fulfillment.kind !== "pickup"
    )
      return undefined;
    const change = readPaymentChange(
      this.options.database,
      merchantId,
      paymentId,
    );
    const payment = findResource(
      listPayments(this.options.database, merchantId),
      paymentId,
    );
    const fulfillment = listFulfillments(
      this.options.database,
      merchantId,
    ).find(
      (candidate) =>
        candidate.orderId === balance.orderId &&
        candidate.lifecycle.state !== "cancelled",
    );
    if (
      change?.checkoutId !== checkoutId ||
      change.orderId !== balance.orderId ||
      payment?.orderId !== balance.orderId ||
      fulfillment === undefined
    )
      return undefined;
    return {
      schemaVersion: "underclerk.buyer-payment-result.v1",
      state: "placed",
      checkoutId,
      checkoutRevision: checkout.revision,
      orderId: balance.orderId,
      paymentId,
      fulfillmentId: fulfillment.id,
      placedAt: checkout.lifecycle.acceptedAt,
      total: checkout.lifecycle.quote.totals.total,
      pickup: {
        locationId: checkout.lifecycle.quote.fulfillment.promise.locationId,
        expectedBy: checkout.lifecycle.quote.fulfillment.promise.readyAt,
      },
    };
  }

  readBuyerOrderPlacement(
    merchantId: string,
    checkoutId: string,
    sessionId: string,
    storefrontId: string,
    orderId: string,
    paymentId: string,
    fulfillmentId: string,
  ):
    | WithoutOrderRecovery<
        VariantBy<CommerceBuyerPaymentResultV1, "state", "placed">
      >
    | undefined {
    const checkout = readCheckout(
      this.options.database,
      merchantId,
      checkoutId,
    );
    if (
      checkout === undefined ||
      checkoutOnlineSource(checkout)?.buyerSessionDigest !==
        buyerSessionDigest(sessionId) ||
      checkoutOnlineSource(checkout)?.storefrontId !== storefrontId ||
      checkout.lifecycle.state !== "accepted" ||
      checkout.lifecycle.orderId !== orderId
    ) {
      return undefined;
    }
    const order = findResource(
      listOrders(this.options.database, merchantId),
      orderId,
    );
    const payment = findResource(
      listPayments(this.options.database, merchantId),
      paymentId,
    );
    const fulfillment = findResource(
      listFulfillments(this.options.database, merchantId),
      fulfillmentId,
    );
    const paymentAttempt =
      checkout.lifecycle.paymentAttemptId === undefined
        ? undefined
        : readCheckoutPaymentAttempt(
            this.options.database,
            merchantId,
            checkout.lifecycle.paymentAttemptId,
          );
    if (
      order === undefined ||
      !checkoutOrderProfileMatches(order.origin, checkoutProfileOf(checkout)) ||
      order.origin.checkoutId !== checkoutId ||
      (order.lifecycle.state !== "fulfillment_pending" &&
        order.lifecycle.state !== "fulfilled") ||
      payment?.orderId !== orderId ||
      payment.lifecycle.state !== "captured" ||
      !placedPaymentMatches(payment, paymentAttempt, checkout) ||
      fulfillment?.orderId !== orderId
    ) {
      return undefined;
    }
    const common = {
      schemaVersion: "underclerk.buyer-payment-result.v1",
      state: "placed",
      checkoutId,
      checkoutRevision: checkout.revision,
      orderId,
      paymentId,
      fulfillmentId,
      placedAt: checkout.lifecycle.acceptedAt,
      total: checkout.lifecycle.quote.totals.total,
    } as const;
    if (checkout.lifecycle.quote.fulfillment.kind === "pickup") {
      if (
        fulfillment.kind !== "pickup" ||
        !buyerPlacementFulfillmentState(
          fulfillment.lifecycle.state,
          order.lifecycle.state,
        )
      ) {
        return undefined;
      }
      return {
        ...common,
        pickup: {
          locationId: checkout.lifecycle.quote.fulfillment.promise.locationId,
          expectedBy: checkout.lifecycle.quote.fulfillment.promise.readyAt,
        },
      };
    }
    const shipments = listShipments(this.options.database, merchantId).filter(
      (candidate) =>
        candidate.orderId === orderId &&
        candidate.fulfillmentId === fulfillmentId,
    );
    const shipment = shipments.length === 1 ? shipments[0] : undefined;
    if (
      fulfillment.kind !== "shipping" ||
      shipment?.kind !== "first_party" ||
      shipment.orderId !== orderId ||
      shipment.fulfillmentId !== fulfillmentId ||
      !["ready", "label_purchased", "in_transit", "delivered"].includes(
        shipment.lifecycle.state,
      ) ||
      (shipment.lifecycle.state === "ready" &&
        fulfillment.lifecycle.state !== "requested") ||
      (shipment.lifecycle.state === "label_purchased" &&
        fulfillment.lifecycle.state !== "requested") ||
      (shipment.lifecycle.state === "in_transit" &&
        fulfillment.lifecycle.state !== "handed_to_carrier") ||
      (shipment.lifecycle.state === "delivered" &&
        order.lifecycle.state !== "fulfilled")
    ) {
      return undefined;
    }
    return {
      ...common,
      shipmentId: shipment.id,
      shipping: {
        destinationCountry:
          checkout.lifecycle.quote.fulfillment.quote.address.destinationCountry,
        estimatedDelivery:
          checkout.lifecycle.quote.fulfillment.quote.estimatedDelivery,
      },
    };
  }

  readBuyerOrder(
    merchantId: string,
    storefrontId: string,
    checkoutId: string,
    sessionId: string,
  ): CommerceBuyerOrderV1 | undefined {
    const checkout = readCheckout(
      this.options.database,
      merchantId,
      checkoutId,
    );
    if (
      checkout === undefined ||
      checkoutOnlineSource(checkout)?.buyerSessionDigest !==
        buyerSessionDigest(sessionId) ||
      checkoutOnlineSource(checkout)?.storefrontId !== storefrontId ||
      checkout.lifecycle.state !== "accepted"
    ) {
      return undefined;
    }
    const order = onlyBuyerOrder(
      listOrders(this.options.database, merchantId),
      storefrontId,
      checkoutId,
      checkout.lifecycle.orderId,
      requireCheckoutProfile(checkout),
    );
    if (order === undefined) return undefined;
    const payments = placedOrderPayments(
      listPayments(this.options.database, merchantId),
      order.id,
      checkout,
    );
    const payment = payments?.primary;
    const paymentAttempt =
      checkout.lifecycle.paymentAttemptId === undefined
        ? undefined
        : readCheckoutPaymentAttempt(
            this.options.database,
            merchantId,
            checkout.lifecycle.paymentAttemptId,
          );
    const fulfillment = onlyFulfillmentForOrder(
      listFulfillments(this.options.database, merchantId),
      order.id,
    );
    if (
      payment === undefined ||
      (payment.lifecycle.state !== "captured" &&
        payment.lifecycle.state !== "partially_refunded" &&
        payment.lifecycle.state !== "refunded") ||
      !buyerPaymentMatchesAcceptedTender(
        payment,
        paymentAttempt,
        order,
        checkout,
      ) ||
      !sameMoney(order.totals.total, checkout.lifecycle.quote.totals.total) ||
      fulfillment?.orderId !== order.id
    ) {
      return undefined;
    }
    let disputes: readonly PaymentDispute[];
    try {
      disputes = listPaymentDisputesForOrder(
        this.options.database,
        merchantId,
        order.id,
      );
    } catch {
      return undefined;
    }
    const paymentDisputes = buyerPaymentDisputeStatuses(
      order,
      payment,
      disputes,
    );
    if (paymentDisputes === undefined) return undefined;
    const base = {
      schemaVersion: "underclerk.buyer-order.v1" as const,
      checkoutId,
      orderId: order.id,
      paymentId: payment.id,
      fulfillmentId: fulfillment.id,
      placedAt: checkout.lifecycle.acceptedAt,
      total: order.totals.total,
      paymentDisputes,
    };
    if (checkout.lifecycle.quote.fulfillment.kind === "pickup") {
      if (
        fulfillment.kind !== "pickup" ||
        fulfillment.locationId !==
          checkout.lifecycle.quote.fulfillment.promise.locationId ||
        fulfillment.expectedBy !==
          checkout.lifecycle.quote.fulfillment.promise.readyAt
      ) {
        return undefined;
      }
      const pickup = {
        locationId: fulfillment.locationId,
        expectedBy: fulfillment.expectedBy,
      };
      switch (fulfillment.lifecycle.state) {
        case "requested":
          return order.lifecycle.state === "fulfillment_pending" &&
            payment.lifecycle.state === "captured"
            ? { ...base, fulfillment: "pickup", pickup, state: "placed" }
            : undefined;
        case "ready_for_pickup":
          return order.lifecycle.state === "fulfillment_pending" &&
            payment.lifecycle.state === "captured"
            ? {
                ...base,
                fulfillment: "pickup",
                pickup,
                state: "ready_for_pickup",
                readyAt: fulfillment.lifecycle.readyAt,
              }
            : undefined;
        case "completed": {
          if (order.lifecycle.state !== "fulfilled") return undefined;
          return {
            ...base,
            fulfillment: "pickup",
            pickup,
            state: "completed",
            completedAt: fulfillment.lifecycle.completedAt,
          };
        }
        case "preparing":
        case "blocked":
          return undefined;
        case "cancelled":
          if (
            order.lifecycle.state !== "cancelled" ||
            fulfillment.lifecycle.cancelledAt !== order.lifecycle.cancelledAt
          ) {
            return undefined;
          }
          const refund = buyerCancellationRefundStatus(
            order,
            payment,
            payments?.storedValue ?? [],
            listRefundAttemptsForOrder(
              this.options.database,
              merchantId,
              order.id,
            ),
          );
          return refund === undefined
            ? undefined
            : {
                ...base,
                fulfillment: "pickup",
                pickup,
                state: "cancelled",
                cancelledAt: order.lifecycle.cancelledAt,
                refund,
              };
      }
    }
    if (
      fulfillment.kind !== "shipping" ||
      payment.lifecycle.state !== "captured"
    )
      return undefined;
    const shipments = listShipments(this.options.database, merchantId).filter(
      (candidate) =>
        candidate.orderId === order.id &&
        candidate.fulfillmentId === fulfillment.id,
    );
    const shipment = shipments.length === 1 ? shipments[0] : undefined;
    if (
      shipment?.kind !== "first_party" ||
      shipment.orderId !== order.id ||
      shipment.fulfillmentId !== fulfillment.id
    )
      return undefined;
    const shipping = checkout.lifecycle.quote.fulfillment.quote;
    if (shipping.estimatedDelivery.kind !== "window") return undefined;
    const commonShipping = {
      ...base,
      fulfillment: "shipping" as const,
      shipmentId: shipment.id,
      shipping: {
        destinationCountry: shipping.address.destinationCountry,
        estimatedDelivery: shipping.estimatedDelivery,
      },
    };
    switch (shipment.lifecycle.state) {
      case "ready":
        return fulfillment.lifecycle.state === "requested" &&
          order.lifecycle.state === "fulfillment_pending"
          ? { ...commonShipping, state: "ready" }
          : undefined;
      case "label_purchased":
        return fulfillment.lifecycle.state === "requested" &&
          order.lifecycle.state === "fulfillment_pending"
          ? {
              ...commonShipping,
              state: "label_purchased",
              trackingNumber: shipment.lifecycle.trackingNumber,
              purchasedAt: shipment.lifecycle.purchasedAt,
            }
          : undefined;
      case "in_transit":
        return fulfillment.lifecycle.state === "handed_to_carrier" &&
          order.lifecycle.state === "fulfillment_pending"
          ? {
              ...commonShipping,
              state: "in_transit",
              trackingNumber: shipment.lifecycle.trackingNumber,
              handedOverAt: shipment.lifecycle.handedOverAt,
            }
          : undefined;
      case "delivered":
        return fulfillment.lifecycle.state === "handed_to_carrier" &&
          order.lifecycle.state === "fulfilled"
          ? {
              ...commonShipping,
              state: "delivered",
              trackingNumber: shipment.lifecycle.trackingNumber,
              handedOverAt: shipment.lifecycle.handedOverAt,
              deliveredAt: shipment.lifecycle.deliveredAt,
            }
          : undefined;
    }
  }
}
