import React from "react";
import { commercePickupCode } from "@purin-labs/commerce-client";
import type { Variant } from "@purin-labs/type-utils";
import type { StorefrontApp } from "./storefront.tsx";
import { readOrderReceipt, readOrderStatusUrl } from "./checkout-recovery.ts";
import type { StorefrontState } from "./storefront-types.ts";
import {
  cafeCheckoutCopy,
  cafeCheckoutReviewLines,
  cafeInterfaceCopy,
  cafeOrderViewCopy,
  cafeSelection,
  shippingCheckoutCopy,
  shippingCheckoutReviewLines,
  shippingCountryCopy,
} from "./storefront-basket.tsx";
import {
  CheckoutView,
  OrderView,
  ShippingQuoteEvidence,
  StatusView,
} from "./storefront-views.tsx";
import type {
  OrderStatusPresentation,
  OrderViewCopy,
} from "./storefront-views.tsx";
import {
  buyerOrderLastUpdated,
  cafeOrderTitle,
  formatDateRange,
  formatPickupMoment,
  orderTimelineWithPaymentReview,
  paymentReviewPresentation,
  pickupOrderDetail,
  pickupOrderNextAction,
  pickupOrderTimeline,
  shippingOrderDetail,
  shippingOrderNextAction,
  shippingOrderTimeline,
  shippingOrderTitle,
} from "./order-presentation.ts";
import {
  normalizedShippingAddress,
  parseShippingCountry,
  shippingAddressForCountry,
  shippingAddressSummary,
} from "./shipping-address.ts";

export const storefrontOrderViews = {
  orderStatusHref(this: StorefrontApp): string | undefined {
    const current = this.state;
    if (current.kind === "pickup_order" || current.kind === "shipping_order") {
      return current.access.returnUrl;
    }
    return readOrderStatusUrl(this.props.config);
  },

  renderPickupQuote(
    this: StorefrontApp,
    state: Variant<StorefrontState, "pickup_quote">,
  ): React.ReactNode {
    const copy = cafeInterfaceCopy(this.cafeLanguage);
    const merchantDisplayName =
      state.context.session.checkoutProfileConfiguration.presentationPolicy
        .merchantDisplayName;
    const selection =
      this.props.config.kind === "cafe"
        ? cafeSelection(state.context.catalog, this.props.config)
        : { ok: false as const, message: "The café set is unavailable." };
    if (!selection.ok || state.context.basket.kind !== "cafe") {
      return (
        <StatusView
          title="The order could not be reviewed"
          detail={
            selection.ok ? "The café basket is unavailable." : selection.message
          }
          actionLabel={copy.editOrder}
          onAction={this.editBasket}
        />
      );
    }
    return (
      <CheckoutView
        eyebrow={copy.reviewEyebrow}
        title={copy.reviewHeading}
        detail={copy.reviewDetail}
        facts={[
          {
            label: copy.pickupAt.replace("{name}", merchantDisplayName),
            value: formatPickupMoment(
              state.quote.quote.pickup.readyAt,
              this.cafeLanguage,
            ),
          },
        ]}
        reviewLines={cafeCheckoutReviewLines(
          state.quote,
          state.context.catalog,
          this.props.config,
          copy,
          this.cafeLanguage,
        )}
        totals={state.quote.quote.totals}
        expired={state.expired}
        expiresAt={state.quote.quote.expiresAt}
        holdLabel={copy.quoteHold}
        copy={cafeCheckoutCopy(copy, state.quote.quote.totals.total)}
        feedback={state.feedback}
        onEdit={this.editBasket}
        onRefresh={this.refreshQuote}
        onPay={this.pay}
      />
    );
  },

  renderShippingQuote(
    this: StorefrontApp,
    state: Variant<StorefrontState, "shipping_quote">,
  ): React.ReactNode {
    const quote = state.quote.quote;
    const countryCode = parseShippingCountry(quote.shipping.destinationCountry);
    if (countryCode === undefined) return null;
    const address =
      state.context.basket.kind === "shipping"
        ? shippingAddressForCountry(
            normalizedShippingAddress(state.context.basket.address),
            countryCode,
          )
        : undefined;
    const countryCopy = shippingCountryCopy(countryCode);
    const facts = [
      ...(address === undefined
        ? []
        : [
            {
              label: "Deliver to",
              value: shippingAddressSummary(address),
            },
          ]),
      {
        label: "Estimated delivery",
        value: formatDateRange(
          quote.shipping.estimatedDelivery.earliest,
          quote.shipping.estimatedDelivery.latest,
          countryCode,
        ),
      },
      {
        label: "Import duties",
        value: shippingDutyMessage(quote.shipping.dutyTerms.incoterm),
      },
    ];
    return (
      <CheckoutView
        eyebrow={countryCopy.quoteEyebrow}
        title={countryCopy.quoteTitle}
        detail={`${quote.shipping.service.name} · ${countryCopy.quoteDetail}`}
        facts={facts}
        evidence={<ShippingQuoteEvidence quote={state.quote} />}
        reviewLines={shippingCheckoutReviewLines(
          state.quote,
          state.context.catalog.listings,
        )}
        totals={quote.totals}
        expired={state.expired}
        expiresAt={quote.expiresAt}
        holdLabel="Price and stock held"
        copy={shippingCheckoutCopy(quote.totals.total)}
        feedback={state.feedback}
        onEdit={this.editBasket}
        onRefresh={this.refreshQuote}
        onPay={this.pay}
      />
    );
  },

  renderPickupOrder(
    this: StorefrontApp,
    state: Variant<StorefrontState, "pickup_order">,
  ): React.ReactNode {
    const copy = cafeInterfaceCopy(this.cafeLanguage);
    const basePresentation: OrderStatusPresentation = {
      title: cafeOrderTitle(state.order.state, copy),
      detail: pickupOrderDetail(state.order, this.cafeLanguage),
      nextAction: pickupOrderNextAction(state.order, this.cafeLanguage),
      timeline: pickupOrderTimeline(state.order, this.cafeLanguage),
      complete: state.order.state === "completed",
    };
    const paymentReview = paymentReviewPresentation(
      state.order.paymentDisputes,
      this.cafeLanguage,
    );
    return (
      <OrderView
        eyebrow={copy.pickupEyebrow}
        title={basePresentation.title}
        detail={basePresentation.detail}
        orderCode={{
          label: copy.pickupCodeLabel,
          value: commercePickupCode(state.order.orderId),
        }}
        total={state.order.total}
        complete={
          basePresentation.complete && !(paymentReview?.active ?? false)
        }
        lastUpdated={
          basePresentation.lastUpdated ??
          buyerOrderLastUpdated(state.order, this.cafeLanguage)
        }
        nextAction={basePresentation.nextAction}
        timeline={orderTimelineWithPaymentReview(
          basePresentation,
          paymentReview,
          this.cafeLanguage,
        )}
        paymentReview={paymentReview}
        receipt={readOrderReceipt(state.access.checkoutId)}
        receiptHeading={copy.orderSummary}
        returnUrl={state.access.returnUrl}
        qrDetail={copy.qrDetail}
        feedback={state.feedback}
        onRefresh={this.refreshOrder}
        onCopyLink={this.copyOrderLink}
        copy={cafeOrderViewCopy(copy)}
        handoff={
          this.kioskMode
            ? {
                kind: "pickup_kiosk",
                heading: copy.kioskHeading,
                detail: copy.kioskDetail,
                clearLabel: copy.clearKiosk,
                confirmHeading: copy.kioskConfirmHeading,
                confirmDetail: copy.kioskConfirmDetail,
                confirmClear: copy.kioskConfirmClear,
                confirmKeep: copy.kioskConfirmKeep,
                onClear: this.clearPickupKiosk,
              }
            : { kind: "standard" }
        }
      />
    );
  },

  renderShippingOrder(
    this: StorefrontApp,
    state: Variant<StorefrontState, "shipping_order">,
  ): React.ReactNode {
    const order = state.order;
    const countryCode = parseShippingCountry(order.shipping.destinationCountry);
    if (countryCode === undefined) return null;
    const countryCopy = shippingCountryCopy(countryCode);
    const receipt = readOrderReceipt(state.access.checkoutId);
    const facts = [
      ...(order.shipping.estimatedDelivery.kind === "window"
        ? [
            {
              label: "Estimated delivery",
              value: formatDateRange(
                order.shipping.estimatedDelivery.earliest,
                order.shipping.estimatedDelivery.latest,
                countryCode,
              ),
            },
          ]
        : []),
      ...(order.state === "ready"
        ? []
        : [{ label: "Tracking number", value: order.trackingNumber }]),
    ];
    const basePresentation: OrderStatusPresentation = {
      title: shippingOrderTitle(order.state, countryCopy.name),
      detail: shippingOrderDetail(order),
      nextAction: shippingOrderNextAction(order),
      timeline: shippingOrderTimeline(order),
      complete: order.state === "delivered",
    };
    const paymentReview = paymentReviewPresentation(
      order.paymentDisputes,
      this.cafeLanguage,
    );
    return (
      <OrderView
        eyebrow={countryCopy.orderEyebrow}
        title={basePresentation.title}
        detail={basePresentation.detail}
        orderCode={{
          label: "Order reference",
          value: commercePickupCode(order.orderId),
        }}
        total={order.total}
        complete={
          basePresentation.complete && !(paymentReview?.active ?? false)
        }
        lastUpdated={buyerOrderLastUpdated(order, this.cafeLanguage)}
        nextAction={basePresentation.nextAction}
        timeline={orderTimelineWithPaymentReview(
          basePresentation,
          paymentReview,
          this.cafeLanguage,
        )}
        paymentReview={paymentReview}
        facts={facts}
        receipt={receipt}
        receiptHeading="Order summary"
        returnUrl={state.access.returnUrl}
        qrDetail="Scan with your phone to keep your order status with you."
        feedback={state.feedback}
        onRefresh={this.refreshOrder}
        onCopyLink={this.copyOrderLink}
        copy={shippingOrderViewCopy()}
        handoff={{ kind: "standard" }}
      />
    );
  },
};

function shippingDutyMessage(
  incoterm: "not_applicable" | "ddp" | "dap",
): string {
  switch (incoterm) {
    case "not_applicable":
      return "No import duties";
    case "ddp":
      return "Included in the checkout total";
    case "dap":
      return "Pay the carrier when the shipment arrives";
  }
}

function shippingOrderViewCopy(): OrderViewCopy {
  return {
    paid: "Paid",
    nextAction: "Next action",
    lastUpdated: "Last updated",
    progress: "Order progress",
    returnUrl: "Private order link",
    returnUrlDetail:
      "Save this link to check the order from this device or another one.",
    copyLink: "Copy order link",
    refresh: "Refresh status",
  };
}
