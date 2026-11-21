import {
  isCommerceInternationalShippingCountry,
  type CommerceBuyerCheckoutPaymentProgressV1,
  type CommerceBuyerQuotedCheckoutV1,
  type CommerceBuyerQuotedShippingCheckoutV1,
} from "@purin-labs/commerce-client";
import type { Checkout, CheckoutPaymentAttempt } from "@purin-labs/commerce-contracts";
import type { VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

export function toBuyerRecoverableQuote(
  checkout: Checkout,
):
  | CommerceBuyerQuotedCheckoutV1
  | CommerceBuyerQuotedShippingCheckoutV1
  | undefined {
  switch (checkout.lifecycle.quote.fulfillment.kind) {
    case "pickup":
      return toBuyerQuotedPickupCheckout(checkout);
    case "shipping":
      return toBuyerQuotedShippingCheckout(checkout);
    default:
      return assertNever(
        checkout.lifecycle.quote.fulfillment,
        "Unsupported buyer checkout state",
      );
  }
}

export function toBuyerCheckoutPaymentProgress(
  checkout: Checkout,
  attempt: CheckoutPaymentAttempt | undefined,
): CommerceBuyerCheckoutPaymentProgressV1 | undefined {
  if (
    attempt === undefined ||
    (checkout.lifecycle.state !== "payment_pending" &&
      checkout.lifecycle.state !== "expired") ||
    (checkout.lifecycle.state === "payment_pending" &&
      checkout.lifecycle.paymentAttemptId !== attempt.paymentAttemptId) ||
    attempt.binding.checkoutId !== checkout.checkoutId ||
    attempt.binding.checkoutRevision !==
      checkout.lifecycle.quote.checkoutRevision ||
    attempt.binding.quoteDigest !== checkout.lifecycle.quote.quoteDigest
  ) {
    return undefined;
  }
  switch (attempt.lifecycle.state) {
    case "pending":
    case "captured":
      return {
        state: attempt.lifecycle.state,
        paymentAttemptId: attempt.paymentAttemptId,
      };
    case "declined":
      return {
        state: "declined",
        paymentAttemptId: attempt.paymentAttemptId,
        reasonCode: attempt.lifecycle.reasonCode,
      };
    case "processing":
    case "indeterminate":
      return {
        state: attempt.lifecycle.state,
        paymentAttemptId: attempt.paymentAttemptId,
        reconcileAfter: attempt.lifecycle.reconcileAfter,
      };
    default:
      return assertNever(attempt.lifecycle, "Unsupported buyer checkout state");
  }
}

export function toBuyerQuotedPickupCheckout(
  checkout: Checkout,
): CommerceBuyerQuotedCheckoutV1 | undefined {
  if (
    (checkout.lifecycle.state !== "quoted" &&
      checkout.lifecycle.state !== "payment_pending" &&
      checkout.lifecycle.state !== "expired") ||
    checkout.lifecycle.quote.lines.length === 0 ||
    checkout.lifecycle.quote.fulfillment.kind !== "pickup"
  ) {
    return undefined;
  }
  const lines: Array<
    CommerceBuyerQuotedCheckoutV1["quote"]["lines"][number]
  > = [];
  for (const line of checkout.lifecycle.quote.lines) {
    if (line.quantity.scale !== 0 || line.quantity.unit !== "each")
      return undefined;
    switch (line.source.kind) {
      case "catalog":
        lines.push({
          kind: "catalog",
          checkoutLineId: line.checkoutLineId,
          variantId: line.source.variantId,
          quantity: line.quantity.amount,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
          ...(line.discount === undefined ? {} : { discount: line.discount }),
        });
        break;
      case "food_service": {
        const modifierOptionIds: string[] = [];
        for (const modifier of line.source.modifiers) {
          modifierOptionIds.push(modifier.modifierOptionId);
        }
        lines.push({
          kind: "menu",
          checkoutLineId: line.checkoutLineId,
          menuId: line.source.menuId,
          variantId: line.source.variantId,
          menuEntryId: line.source.menuEntryId,
          modifierOptionIds,
          quantity: line.quantity.amount,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
          ...(line.discount === undefined ? {} : { discount: line.discount }),
        });
        break;
      }
      case "order_balance":
        lines.push({
          kind: "order_balance",
          checkoutLineId: line.checkoutLineId,
          orderId: line.source.orderId,
          quantity: line.quantity.amount,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        });
        break;
      default:
        return assertNever(line.source, "Unsupported buyer checkout state");
    }
  }
  return {
    schemaVersion: "commerce.buyer-quoted-checkout.v1",
    checkoutId: checkout.checkoutId,
    revision: checkout.lifecycle.quote.checkoutRevision,
    state: "quoted",
    quote: {
      quoteDigest: checkout.lifecycle.quote.quoteDigest,
      lines,
      totals: checkout.lifecycle.quote.totals,
      pickup: checkout.lifecycle.quote.fulfillment.promise,
      expiresAt: checkout.lifecycle.quote.expiresAt,
      ...(checkout.lifecycle.quote.storedValue === undefined
        ? {}
        : { storedValue: checkout.lifecycle.quote.storedValue }),
    },
  };
}

export function toBuyerQuotedShippingCheckout(
  checkout: Checkout,
): CommerceBuyerQuotedShippingCheckoutV1 | undefined {
  if (
    (checkout.lifecycle.state !== "quoted" &&
      checkout.lifecycle.state !== "payment_pending" &&
      checkout.lifecycle.state !== "expired") ||
    checkout.lifecycle.quote.lines.length === 0 ||
    checkout.lifecycle.quote.fulfillment.kind !== "shipping"
  ) {
    return undefined;
  }
  const shipping = checkout.lifecycle.quote.fulfillment.quote;
  if (
    shipping.estimatedDelivery.kind !== "window" ||
    (shipping.address.destinationCountry !== "JP" &&
      shipping.address.destinationCountry !== "SG" &&
      !isCommerceInternationalShippingCountry(
        shipping.address.destinationCountry,
      ))
  ) {
    return undefined;
  }
  const lines = toBuyerShippingCheckoutLines(checkout.lifecycle.quote.lines);
  if (lines === undefined) return undefined;
  const market = checkout.lifecycle.quote.market;
  return {
    schemaVersion: "commerce.buyer-quoted-shipping-checkout.v1",
    checkoutId: checkout.checkoutId,
    revision: checkout.lifecycle.quote.checkoutRevision,
    state: "quoted",
    quote: {
      quoteDigest: checkout.lifecycle.quote.quoteDigest,
      lines,
      totals: checkout.lifecycle.quote.totals,
      shipping: {
        addressValidationReference: shipping.address.addressValidationReference,
        service: shipping.carrierRate.service,
        destinationCountry: shipping.address.destinationCountry,
        dutyTerms: { incoterm: shipping.dutyQuote.incoterm },
        estimatedDelivery: shipping.estimatedDelivery,
        carrierQuote: {
          rateReference: shipping.carrierRate.rateReference,
          shippingAmount: shipping.carrierRate.shippingAmount,
          lineAllocations: shipping.carrierRate.lineAllocations,
        },
        taxQuote: {
          registrationPolicyReference:
            shipping.taxQuote.registrationPolicyReference,
          quoteReference: shipping.taxQuote.quoteReference,
          taxAmount: shipping.taxQuote.taxAmount,
          lineAllocations: shipping.taxQuote.lineAllocations,
        },
        dutyQuote: {
          quoteReference: shipping.dutyQuote.quoteReference,
          incoterm: shipping.dutyQuote.incoterm,
          dutyAmount: shipping.dutyQuote.dutyAmount,
          lineAllocations: shipping.dutyQuote.lineAllocations,
        },
        packagePlan: shipping.packagePlan,
      },
      expiresAt: checkout.lifecycle.quote.expiresAt,
      ...(checkout.lifecycle.quote.storedValue === undefined
        ? {}
        : { storedValue: checkout.lifecycle.quote.storedValue }),
      ...(market?.rate == null || market.roundingIncrement === undefined
        ? {}
        : {
            market: {
              marketId: market.marketId,
              currency: checkout.lifecycle.quote.totals.total.currency,
              shopCurrency: market.shopCurrency,
              rate: market.rate,
              roundingIncrement: market.roundingIncrement,
            },
          }),
    },
  };
}

function toBuyerShippingCheckoutLines(
  lines: VariantBy<Checkout["lifecycle"], "state", "quoted">["quote"]["lines"],
): CommerceBuyerQuotedShippingCheckoutV1["quote"]["lines"] | undefined {
  const result: Array<
    CommerceBuyerQuotedShippingCheckoutV1["quote"]["lines"][number]
  > = [];
  for (const line of lines) {
    if (
      line.source.kind !== "catalog" ||
      line.quantity.scale !== 0 ||
      line.quantity.unit !== "each"
    ) {
      return undefined;
    }
    result.push({
      kind: "catalog",
      checkoutLineId: line.checkoutLineId,
      variantId: line.source.variantId,
      quantity: line.quantity.amount,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      ...(line.discount === undefined ? {} : { discount: line.discount }),
    });
  }
  return result;
}
