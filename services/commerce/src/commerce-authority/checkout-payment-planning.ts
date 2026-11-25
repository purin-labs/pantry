import {
  parseCheckout,
  parseCheckoutPaymentAttempt,
  parseFulfillment,
  parseInventoryAllocation,
  parseOrder,
  parsePayment,
  parseShipment,
  pointOfSaleCashEnabled,
  type BeginCommerceCheckoutPaymentV1,
  type CollectCommerceInPersonCheckoutPaymentV1,
  type ExpireCommerceCheckoutV1,
  type PlaceCommercePaidCheckoutV1,
  type RecordCommerceCheckoutPaymentCaptureV1,
  type RecordCommerceCounterCashPaymentV1,
  type ResolveCommerceCheckoutPaymentV1,
  type CommerceResourcesV1,
  type CommerceFulfillmentV1,
  type CommercePickupFulfillmentV1,
  type CommerceInventoryPositionV1,
  type CommerceMutationErrorV1,
  type CommerceOrderOriginV1,
  type CommerceOrderV1,
  type CommercePaymentV1,
  type CommerceFirstPartyShipmentV1,
  type CommerceOrderPaymentChangeV1,
  type CommerceBuyerV1,
  type MarkCommerceDraftOrderPaidV1,
  type PlaceCommerceDraftOrderOnTermsV1,
  type CommerceCompanyInvoiceV1,
  type CommercePaymentCaptureResultV1,
} from "@purin-labs/commerce-client";
import {
  commerceTransition,
  type Checkout,
  type CheckoutLineChargeAllocation,
  type CheckoutPaymentAttempt,
  type CheckoutPaymentAttemptLifecycle,
  type CheckoutQuoteSnapshot,
  type InventoryAllocation,
} from "@purin-labs/commerce-contracts";

import type { CommerceDatabase } from "../database.ts";
import { readPointOfSaleConfigurationForCheckout } from "../point-of-sale-configuration-persistence.ts";
import {
  readInventoryAllocation,
  readStorefront,
} from "../checkout-persistence.ts";
import { readInventoryPositionForItemLocation } from "../inventory-persistence.ts";
import {
  accountedPositionCanRelease,
  isAccountedPosition,
  releasedInventoryPosition,
} from "./inventory-planning.ts";

import {
  checkCheckoutRevision,
  checkoutQuoteDigest,
  amountDue,
  definedMutationError,
  findResource,
  orderLineIdFor,
  sameMoney,
  sha256,
  timestampAtOrBefore,
} from "./checkout-shared.ts";
import { orderWithAddedPayment } from "./order-changes.ts";
import { storedValuePaymentId } from "../plugins/stored-value/index.ts";
import type { ManualTender } from "../payments/manual-tender.ts";
import { termsInvoice } from "../plugins/companies/index.ts";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

/**
 * Places a quoted online checkout that gift cards and store credit pay in
 * full; the buyer's route builds it, so it is not a public command.
 */
export type PlaceCommerceStoredValueCheckoutV1 = Readonly<{
  schemaVersion: "commerce.place-stored-value-checkout.v1";
  merchantId: string;
  expectedMerchantRevision: number;
  idempotencyKey: string;
  requestedAt: string;
  checkoutId: string;
  checkoutRevision: number;
  quoteDigest: string;
  orderId: string;
  /** The first stored-value payment, as `storedValuePaymentId` names it. */
  paymentId: string;
  fulfillmentId: string;
  buyer: CommerceBuyerV1;
  placement: PlaceCommercePaidCheckoutV1["placement"];
}>;

/** A command that places a checkout whose amount due is paid. */
export type PaidPlacementCommand =
  | PlaceCommercePaidCheckoutV1
  | PlaceCommerceStoredValueCheckoutV1
  | RecordCommerceCounterCashPaymentV1
  | MarkCommerceDraftOrderPaidV1
  | PlaceCommerceDraftOrderOnTermsV1;

/** A draft that staff place without a provider: paid, or on terms. */
export type OfflinePlacementCommand =
  MarkCommerceDraftOrderPaidV1 | PlaceCommerceDraftOrderOnTermsV1;

/** The company terms of an order that staff place on terms. */
export type PlacementTerms = Readonly<{ companyId: string; netDays: number }>;

type PlacementCommand = Pick<
  PlaceCommercePaidCheckoutV1,
  | "merchantId"
  | "checkoutId"
  | "requestedAt"
  | "orderId"
  | "paymentId"
  | "fulfillmentId"
  | "buyer"
  | "placement"
>;

export type CheckoutPaymentStartPlan = Readonly<{
  checkout: Checkout;
  paymentAttempt: CheckoutPaymentAttempt;
}>;

type CheckoutPaymentStartPlanResult =
  | Readonly<{ kind: "planned"; value: CheckoutPaymentStartPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type CheckoutPaymentCapturePlan = Readonly<{
  paymentAttempt: CheckoutPaymentAttempt;
}>;

type CheckoutPaymentCapturePlanResult =
  | Readonly<{ kind: "planned"; value: CheckoutPaymentCapturePlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

type CheckoutPlacementCommon = Readonly<{
  checkout: Checkout;
  /** None when stored value or a manual tender paid the whole total. */
  paymentAttempt: CheckoutPaymentAttempt | undefined;
  order: CommerceOrderV1;
  /**
   * The card payment, the manual payment, or the first stored-value payment
   * when neither.
   */
  payment: CommercePaymentV1;
  /** The order's other payments: one for each further stored-value tender. */
  storedValuePayments: readonly CommercePaymentV1[];
  /** The cash or bank transfer behind `payment`, when staff took it. */
  manualTender: ManualTender | undefined;
  /** The invoice behind `payment`, when staff placed the order on terms. */
  invoice?: CommerceCompanyInvoiceV1;
  allocations: readonly InventoryAllocation[];
}>;

/** What pays the amount due of a placed checkout, besides stored value. */
type PlacementTender =
  | Readonly<{ kind: "card"; paymentAttempt: CheckoutPaymentAttempt }>
  | Readonly<{ kind: "stored_value" }>
  | Readonly<{
      kind: "manual";
      tender: MarkCommerceDraftOrderPaidV1["tender"];
      cashReceivedMinor?: number;
      changeDueMinor?: number;
    }>
  | Readonly<{ kind: "invoice"; invoiceId: string; terms: PlacementTerms }>;

export type CheckoutPlacementPlan = CheckoutPlacementCommon &
  (
    | Readonly<{
        kind: "pickup";
        fulfillment: CommercePickupFulfillmentV1;
        shipment?: never;
        change?: never;
      }>
    | Readonly<{
        /** A balance checkout adds its payment to an existing order. */
        kind: "balance";
        previousOrderRevision: number;
        change: CommerceOrderPaymentChangeV1;
        fulfillment?: never;
        shipment?: never;
      }>
    | Readonly<{
        kind: "shipping";
        fulfillment: Variant<CommerceFulfillmentV1, "shipping">;
        shipment: CommerceFirstPartyShipmentV1;
        change?: never;
      }>
  );

type CheckoutPlacementPlanResult =
  | Readonly<{ kind: "planned"; value: CheckoutPlacementPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type CheckoutPaymentResolutionPlan =
  | Readonly<{
      kind: "processing";
      checkout: Checkout;
      paymentAttempt: CheckoutPaymentAttempt;
    }>
  | Readonly<{
      kind: "indeterminate";
      checkout: Checkout;
      paymentAttempt: CheckoutPaymentAttempt;
    }>
  | Readonly<{
      kind: "declined";
      checkout: Checkout;
      paymentAttempt: CheckoutPaymentAttempt;
      allocations: readonly InventoryAllocation[];
      positions: readonly CommerceInventoryPositionV1[];
    }>;

type CheckoutPaymentResolutionPlanResult =
  | Readonly<{ kind: "planned"; value: CheckoutPaymentResolutionPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type CheckoutExpirationPlan = Readonly<{
  checkout: Checkout;
  allocations: readonly InventoryAllocation[];
  positions: readonly CommerceInventoryPositionV1[];
}>;

type CheckoutExpirationPlanResult =
  | Readonly<{ kind: "planned"; value: CheckoutExpirationPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function planCheckoutPaymentStart(
  command:
    BeginCommerceCheckoutPaymentV1 | CollectCommerceInPersonCheckoutPaymentV1,
  checkout: Checkout | undefined,
  currentOfferRevision: (offerId: string) => number | undefined,
  currentOrderRevision: (orderId: string) => number | undefined,
): CheckoutPaymentStartPlanResult {
  if (checkout === undefined) {
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "checkout",
        id: command.checkoutId,
      },
    };
  }
  if (checkout.revision !== command.checkoutRevision) {
    return {
      kind: "rejected",
      error: {
        code: "stale_resource_revision",
        kind: "checkout",
        id: command.checkoutId,
        expected: command.checkoutRevision,
        actual: checkout.revision,
      },
    };
  }
  const begin = commerceTransition(
    "checkout",
    checkout.lifecycle,
    "begin_payment",
  );
  if (!begin.allowed) return { kind: "rejected", error: begin.refusal };
  if (
    checkout.lifecycle.quote.quoteDigest !== command.quoteDigest ||
    checkout.lifecycle.quote.quoteDigest !==
      checkoutQuoteDigest(checkout.lifecycle.quote) ||
    checkout.lifecycle.quote.checkoutRevision !== command.checkoutRevision
  ) {
    return {
      kind: "rejected",
      error: {
        code: "checkout_quote_mismatch",
        checkoutId: command.checkoutId,
      },
    };
  }
  if (
    Date.parse(command.requestedAt) >=
    Date.parse(checkout.lifecycle.quote.expiresAt)
  ) {
    return {
      kind: "rejected",
      error: {
        code: "checkout_quote_expired",
        checkoutId: command.checkoutId,
        expiresAt: checkout.lifecycle.quote.expiresAt,
      },
    };
  }
  const quote = checkout.lifecycle.quote;
  // A buyer pays the price that the catalog still offers. A quote from before
  // an offer change, or from before titles were frozen, must be refreshed.
  // A balance quote from before the order changed, for example by a payment
  // that staff recorded, pays nothing any more.
  if (
    quote.lines.some(
      (line) =>
        line.title === undefined ||
        (line.source.kind === "order_balance" &&
          currentOrderRevision(line.source.orderId) !==
            line.source.orderRevision) ||
        // A staff price does not follow the offer, so only catalog-priced
        // lines must still match the current offer.
        (line.priceOverride === undefined &&
          line.source.kind !== "order_balance" &&
          currentOfferRevision(line.source.offerId) !==
            line.source.offerRevision),
    )
  ) {
    return {
      kind: "rejected",
      error: {
        code: "checkout_refresh_required",
        checkoutId: command.checkoutId,
      },
    };
  }
  // Gift cards and store credit that pay everything leave the card nothing.
  if (amountDue(quote).amountMinor === 0) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "checkout.storedValue.paidInFull",
      },
    };
  }
  if (
    !sameMoney(command.amount, amountDue(quote)) ||
    !paymentBindingMatchesQuote(command.paymentBinding, quote)
  ) {
    return {
      kind: "rejected",
      error: {
        code: "checkout_quote_mismatch",
        checkoutId: command.checkoutId,
      },
    };
  }
  const nextCheckout = parseCheckout({
    checkoutId: checkout.checkoutId,
    source: checkout.source,
    revision: checkout.revision + 1,
    lifecycle: {
      state: begin.to,
      quote,
      paymentAttemptId: command.paymentAttemptId,
    },
  });
  const paymentAttempt = parseCheckoutPaymentAttempt({
    paymentAttemptId: command.paymentAttemptId,
    revision: 1,
    binding: {
      checkoutId: command.checkoutId,
      checkoutRevision: quote.checkoutRevision,
      quoteDigest: quote.quoteDigest,
      amount: amountDue(quote),
      paymentBinding: command.paymentBinding,
      providerRequestId: command.providerRequestId,
      idempotencyKey: command.idempotencyKey,
    },
    lifecycle: { state: "pending", createdAt: command.requestedAt },
  });
  return { kind: "planned", value: { checkout: nextCheckout, paymentAttempt } };
}

export function existingPlacementResource(
  command: PlacementCommand,
  resources: CommerceResourcesV1,
  /** A balance payment joins an order that exists; only its payment is new. */
  balance: boolean,
): CommerceMutationErrorV1 | undefined {
  const payment = {
    kind: "payment",
    id: command.paymentId,
    resources: resources.payments,
  };
  const candidates: readonly Readonly<{
    kind: string;
    id: string;
    resources: readonly Readonly<{ id: string }>[];
  }>[] = balance
    ? [payment]
    : [
        {
          kind: "commerce_order",
          id: command.orderId,
          resources: resources.orders,
        },
        payment,
        {
          kind: "fulfillment",
          id: command.fulfillmentId,
          resources: resources.fulfillments,
        },
        ...(command.placement.kind === "shipping"
          ? [
              {
                kind: "shipment",
                id: command.placement.shipmentId,
                resources: resources.shipments,
              },
            ]
          : []),
      ];
  for (const candidate of candidates) {
    if (findResource(candidate.resources, candidate.id) !== undefined) {
      return {
        code: "resource_already_exists",
        kind: candidate.kind,
        id: candidate.id,
      };
    }
  }
  return undefined;
}

export function planCheckoutPaymentCapture(
  command: RecordCommerceCheckoutPaymentCaptureV1,
  checkout: Checkout | undefined,
  paymentAttempt: CheckoutPaymentAttempt | undefined,
): CheckoutPaymentCapturePlanResult {
  const revisionError = validatePaymentCaptureRevisions(
    command,
    checkout,
    paymentAttempt,
  );
  if (revisionError !== undefined)
    return { kind: "rejected", error: revisionError };
  if (checkout === undefined || paymentAttempt === undefined) {
    throw new Error(
      "Payment capture revision validation did not preserve resources",
    );
  }
  const record = commerceTransition(
    "checkout",
    checkout.lifecycle,
    "record_capture",
  );
  if (!record.allowed) return { kind: "rejected", error: record.refusal };
  const capture = commerceTransition(
    "payment_attempt",
    paymentAttempt.lifecycle,
    "capture",
  );
  if (!capture.allowed) return { kind: "rejected", error: capture.refusal };
  if (
    record.from.paymentAttemptId !== command.paymentAttemptId ||
    record.from.quote.quoteDigest !== command.quoteDigest ||
    record.from.quote.quoteDigest !== checkoutQuoteDigest(record.from.quote) ||
    paymentAttempt.binding.checkoutId !== command.checkoutId ||
    !checkoutPaymentBindingMatchesQuote(paymentAttempt, record.from.quote) ||
    !providerAnswerTimeValid(capture.from, command.requestedAt, undefined)
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "checkoutPayment.capture",
      },
    };
  }
  return {
    kind: "planned",
    value: {
      paymentAttempt: parseCheckoutPaymentAttempt({
        paymentAttemptId: paymentAttempt.paymentAttemptId,
        revision: paymentAttempt.revision + 1,
        binding: paymentAttempt.binding,
        lifecycle: {
          state: capture.to,
          providerPaymentReference: command.providerPaymentReference,
          capturedAt: command.capturedAt,
          ...(command.paymentMethod === undefined
            ? {}
            : { paymentMethod: command.paymentMethod }),
          ...(command.tenderBrand === undefined
            ? {}
            : { tenderBrand: command.tenderBrand }),
          ...(command.providerRefundable === undefined
            ? {}
            : { providerRefundable: command.providerRefundable }),
        },
      }),
    },
  };
}

export function planPaidCheckoutPlacement(
  database: CommerceDatabase,
  command: PlaceCommercePaidCheckoutV1,
  checkout: Checkout | undefined,
  paymentAttempt: CheckoutPaymentAttempt | undefined,
  resources: CommerceResourcesV1,
): CheckoutPlacementPlanResult {
  const revisionError = validatePlacementRevisions(
    command,
    checkout,
    paymentAttempt,
  );
  if (revisionError !== undefined)
    return { kind: "rejected", error: revisionError };
  if (checkout === undefined || paymentAttempt === undefined) {
    throw new Error("Placement revision validation did not preserve resources");
  }
  const place = commerceTransition("checkout", checkout.lifecycle, "place");
  if (!place.allowed) return { kind: "rejected", error: place.refusal };
  if (
    place.from.paymentAttemptId !== command.paymentAttemptId ||
    place.from.quote.quoteDigest !== command.quoteDigest ||
    place.from.quote.quoteDigest !== checkoutQuoteDigest(place.from.quote) ||
    paymentAttempt.lifecycle.state !== "captured" ||
    paymentAttempt.binding.checkoutId !== command.checkoutId ||
    paymentAttempt.binding.quoteDigest !== command.quoteDigest ||
    !checkoutPaymentBindingMatchesQuote(
      paymentAttempt,
      checkout.lifecycle.quote,
    )
  ) {
    return placementRejected("checkoutPayment.binding");
  }
  const quote = checkout.lifecycle.quote;
  if (quote.fulfillment.kind !== command.placement.kind) {
    return placementRejected("checkout.fulfillment");
  }
  if (quote.lines.some((line) => line.source.kind === "order_balance"))
    return planBalancePlacement(command, checkout, paymentAttempt, resources);
  return planOrderPlacement(database, command, checkout, {
    kind: "card",
    paymentAttempt,
  });
}

/** Places a quoted checkout that gift cards and store credit pay in full. */
export function planStoredValueCheckoutPlacement(
  database: CommerceDatabase,
  command: PlaceCommerceStoredValueCheckoutV1,
  checkout: Checkout | undefined,
  currentOfferRevision: (offerId: string) => number | undefined,
): CheckoutPlacementPlanResult {
  if (checkout === undefined)
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "checkout",
        id: command.checkoutId,
      },
    };
  if (checkout.revision !== command.checkoutRevision)
    return {
      kind: "rejected",
      error: {
        code: "stale_resource_revision",
        kind: "checkout",
        id: command.checkoutId,
        expected: command.checkoutRevision,
        actual: checkout.revision,
      },
    };
  const place = commerceTransition(
    "checkout",
    checkout.lifecycle,
    "place_with_stored_value",
  );
  if (!place.allowed) return { kind: "rejected", error: place.refusal };
  if (
    checkout.source.kind !== "online" ||
    checkout.lifecycle.quote.quoteDigest !== command.quoteDigest ||
    checkout.lifecycle.quote.quoteDigest !==
      checkoutQuoteDigest(checkout.lifecycle.quote)
  )
    return {
      kind: "rejected",
      error: {
        code: "checkout_quote_mismatch",
        checkoutId: command.checkoutId,
      },
    };
  const quote = checkout.lifecycle.quote;
  if (Date.parse(command.requestedAt) >= Date.parse(quote.expiresAt))
    return {
      kind: "rejected",
      error: {
        code: "checkout_quote_expired",
        checkoutId: command.checkoutId,
        expiresAt: quote.expiresAt,
      },
    };
  if (
    quote.storedValue === undefined ||
    quote.storedValue.due.amountMinor !== 0
  )
    return placementRejected("checkout.storedValue.due");
  if (
    quote.lines.some(
      (line) =>
        line.title === undefined ||
        (line.priceOverride === undefined &&
          line.source.kind !== "order_balance" &&
          currentOfferRevision(line.source.offerId) !==
            line.source.offerRevision),
    )
  )
    return {
      kind: "rejected",
      error: {
        code: "checkout_refresh_required",
        checkoutId: command.checkoutId,
      },
    };
  if (quote.fulfillment.kind !== command.placement.kind)
    return placementRejected("checkout.fulfillment");
  return planOrderPlacement(database, command, checkout, {
    kind: "stored_value",
  });
}

/**
 * Places a draft's quoted checkout that staff were paid for in cash or by
 * bank transfer, or that they place on its company's terms: one captured
 * payment of the amount due.
 */
export function planManualCheckoutPlacement(
  database: CommerceDatabase,
  command: OfflinePlacementCommand,
  terms: PlacementTerms | undefined,
  checkout: Checkout | undefined,
  currentOfferRevision: (offerId: string) => number | undefined,
): CheckoutPlacementPlanResult {
  if (checkout === undefined) return placementRejected("draftOrder.checkout");
  const onTerms = terms ?? { companyId: "", netDays: 0 };
  if (
    command.schemaVersion === "commerce.place-draft-order-on-terms.v1" &&
    terms === undefined
  )
    return placementRejected("company.paymentTerms");
  const place = commerceTransition(
    "checkout",
    checkout.lifecycle,
    "place_manually",
  );
  if (!place.allowed) return { kind: "rejected", error: place.refusal };
  const quote = place.from.quote;
  if (
    checkout.source.kind !== "online" ||
    quote.quoteDigest !== checkoutQuoteDigest(quote)
  )
    return {
      kind: "rejected",
      error: {
        code: "checkout_quote_mismatch",
        checkoutId: checkout.checkoutId,
      },
    };
  if (Date.parse(command.requestedAt) >= Date.parse(quote.expiresAt))
    return {
      kind: "rejected",
      error: {
        code: "checkout_quote_expired",
        checkoutId: checkout.checkoutId,
        expiresAt: quote.expiresAt,
      },
    };
  if (quote.storedValue !== undefined)
    return placementRejected("checkout.storedValue");
  if (
    quote.lines.some(
      (line) =>
        line.title === undefined ||
        (line.priceOverride === undefined &&
          line.source.kind !== "order_balance" &&
          currentOfferRevision(line.source.offerId) !==
            line.source.offerRevision),
    )
  )
    return {
      kind: "rejected",
      error: {
        code: "checkout_refresh_required",
        checkoutId: checkout.checkoutId,
      },
    };
  if (quote.fulfillment.kind !== "pickup")
    return placementRejected("checkout.fulfillment");
  return planOrderPlacement(
    database,
    {
      merchantId: command.merchantId,
      checkoutId: checkout.checkoutId,
      requestedAt: command.requestedAt,
      orderId: command.orderId,
      paymentId: command.paymentId,
      fulfillmentId: command.fulfillmentId,
      buyer: { kind: "guest" },
      placement: { kind: "pickup" },
    },
    checkout,
    command.schemaVersion === "commerce.place-draft-order-on-terms.v1"
      ? { kind: "invoice", invoiceId: command.invoiceId, terms: onTerms }
      : { kind: "manual", tender: command.tender },
  );
}

/**
 * Places a quoted `point_of_sale` counter checkout paid in cash, recording the
 * tendered cash and exact change due as one idempotent transaction.
 */
export function planCounterCashPlacement(
  database: CommerceDatabase,
  command: RecordCommerceCounterCashPaymentV1,
  checkout: Checkout | undefined,
  currentOfferRevision: (offerId: string) => number | undefined,
): CheckoutPlacementPlanResult {
  if (checkout === undefined) {
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "checkout",
        id: command.checkoutId,
      },
    };
  }
  if (checkout.source.kind !== "point_of_sale") {
    return placementRejected("checkout.source");
  }
  const revisionError = checkCheckoutRevision(
    "checkout",
    command.checkoutId,
    command.checkoutRevision,
    checkout.revision,
  );
  if (revisionError !== undefined) return { kind: "rejected", error: revisionError };
  const place = commerceTransition(
    "checkout",
    checkout.lifecycle,
    "place_manually",
  );
  if (!place.allowed) return { kind: "rejected", error: place.refusal };
  const quote = place.from.quote;
  if (
    quote.quoteDigest !== command.quoteDigest ||
    quote.quoteDigest !== checkoutQuoteDigest(quote)
  ) {
    return {
      kind: "rejected",
      error: {
        code: "checkout_quote_mismatch",
        checkoutId: checkout.checkoutId,
      },
    };
  }
  if (Date.parse(command.requestedAt) >= Date.parse(quote.expiresAt)) {
    return {
      kind: "rejected",
      error: {
        code: "checkout_quote_expired",
        checkoutId: checkout.checkoutId,
        expiresAt: quote.expiresAt,
      },
    };
  }
  if (quote.storedValue !== undefined) {
    return placementRejected("checkout.storedValue");
  }
  if (quote.fulfillment.kind !== "pickup") {
    return placementRejected("checkout.fulfillment");
  }
  const configuration = readPointOfSaleConfigurationForCheckout(
    database,
    command.merchantId,
    checkout.source.pantryLocationId,
    checkout.source.posConfigurationRevision,
  );
  if (configuration === undefined || !pointOfSaleCashEnabled(configuration)) {
    return placementRejected("pointOfSaleConfiguration.cashEnabled");
  }
  if (
    quote.lines.some(
      (line) =>
        line.title === undefined ||
        (line.priceOverride === undefined &&
          line.source.kind !== "order_balance" &&
          currentOfferRevision(line.source.offerId) !==
            line.source.offerRevision),
    )
  ) {
    return {
      kind: "rejected",
      error: {
        code: "checkout_refresh_required",
        checkoutId: checkout.checkoutId,
      },
    };
  }
  const due = amountDue(quote);
  if (due.amountMinor <= 0) return placementRejected("checkout.payment");
  if (
    command.cashReceived.currency !== due.currency ||
    command.cashReceived.amountMinor < due.amountMinor
  ) {
    return placementRejected("cashReceived");
  }
  const changeDueMinor = command.cashReceived.amountMinor - due.amountMinor;
  const buyer: CommerceBuyerV1 =
    checkout.source.buyer.kind === "anonymous"
      ? { kind: "guest" }
      : {
          kind: "identified",
          customerReference: checkout.source.buyer.customerId,
        };
  return planOrderPlacement(
    database,
    {
      merchantId: command.merchantId,
      checkoutId: checkout.checkoutId,
      requestedAt: command.requestedAt,
      orderId: command.orderId,
      paymentId: command.paymentId,
      fulfillmentId: command.fulfillmentId,
      buyer,
      placement: { kind: "pickup" },
    },
    checkout,
    {
      kind: "manual",
      tender: { method: "cash" },
      cashReceivedMinor: command.cashReceived.amountMinor,
      changeDueMinor,
    },
  );
}

// The order, its payments, fulfilment and stock of a checkout that is paid:
// by a captured card payment or a manual tender for what was due, and by each
// stored-value tender of its quote.
function planOrderPlacement(
  database: CommerceDatabase,
  command: PlacementCommand,
  checkout: Checkout,
  paid: PlacementTender,
): CheckoutPlacementPlanResult {
  const paymentAttempt = paid.kind === "card" ? paid.paymentAttempt : undefined;
  const quote = checkout.lifecycle.quote;
  // The sales channel comes from whichever policy the Checkout was accepted
  // under: an online storefront, or the counter's own published configuration.
  const salesChannelId = placementSalesChannelId(
    database,
    command.merchantId,
    checkout,
  );
  if (salesChannelId === undefined) {
    return placementRejected("checkout.salesChannel");
  }
  const taxes = allocateOrderLineTaxes(quote);
  if (taxes === undefined) return placementRejected("checkout.tax");
  const orderLines: CommerceOrderV1["lineItems"][number][] = [];
  const fulfillmentLines: CommerceFulfillmentV1["lineItems"][number][] = [];
  const allocations: InventoryAllocation[] = [];
  for (let index = 0; index < quote.lines.length; index += 1) {
    const line = quote.lines[index];
    const tax = taxes[index];
    if (line === undefined || tax === undefined) {
      throw new Error("Quote allocation is incomplete");
    }
    if (line.source.kind !== "catalog" && line.source.kind !== "food_service")
      return placementRejected("checkout.line.source");
    // The order copies the quote, never the live catalog, so an edit between
    // quote and placement cannot change what the buyer agreed to.
    if (line.title === undefined)
      return placementRejected("checkout.line.title");
    const orderLineId = orderLineIdFor(command.orderId, line.checkoutLineId);
    orderLines.push({
      id: orderLineId,
      source: line.source,
      sku: line.source.merchantCode,
      title: line.title,
      quantity: line.quantity,
      fulfilledQuantity: { amount: 0, scale: 0, unit: "each" },
      unitPrice: line.unitPrice,
      tax,
      discount: line.discount ?? zeroMoney(line.lineTotal.currency),
      lineTotal: line.lineTotal,
    });
    fulfillmentLines.push({
      lineItemId: orderLineId,
      quantity: line.quantity.amount,
    });
    const allocationResult = transferCheckoutLineAllocations(
      database,
      command,
      line.checkoutLineId,
      orderLineId,
      line.allocationIds,
    );
    if (allocationResult.kind === "rejected") return allocationResult;
    allocations.push(...allocationResult.allocations);
  }
  const nextCheckout = parseCheckout({
    checkoutId: checkout.checkoutId,
    source: checkout.source,
    revision: checkout.revision + 1,
    lifecycle: {
      state: "accepted",
      quote,
      ...(paymentAttempt === undefined
        ? {}
        : { paymentAttemptId: paymentAttempt.paymentAttemptId }),
      ...(paid.kind === "manual" || paid.kind === "invoice"
        ? { manualPaymentId: command.paymentId }
        : {}),
      orderId: command.orderId,
      acceptedAt: command.requestedAt,
    },
  });
  const order = parseOrder({
    id: command.orderId,
    revision: 1,
    origin: placementOrderOrigin(
      checkout,
      salesChannelId,
      paymentAttempt,
      command.orderId,
    ),
    buyer: command.buyer,
    lineItems: orderLines,
    totals: checkoutOrderTotals(quote),
    adjustments: [],
    lifecycle: { state: "fulfillment_pending", since: command.requestedAt },
    occurredAt: command.requestedAt,
    placedAt: command.requestedAt,
    ...(quote.market === undefined ? {} : { market: quote.market }),
  });
  const storedValuePayments = (quote.storedValue?.tenders ?? []).map((tender) =>
    parsePayment({
      id: storedValuePaymentId(command.orderId, tender.accountId),
      revision: 1,
      orderId: command.orderId,
      amount: tender.amount,
      lifecycle: { state: "captured", capturedAt: command.requestedAt },
      occurredAt: command.requestedAt,
    }),
  );
  let payment: CommercePaymentV1;
  let manualTender: ManualTender | undefined;
  let invoice: CommerceCompanyInvoiceV1 | undefined;
  switch (paid.kind) {
    case "stored_value": {
      const first = storedValuePayments.shift();
      if (first === undefined) return placementRejected("checkout.payment");
      payment = first;
      break;
    }
    case "card":
      if (paid.paymentAttempt.lifecycle.state !== "captured")
        return placementRejected("checkoutPayment.binding");
      payment = parsePayment({
        id: command.paymentId,
        revision: 1,
        orderId: command.orderId,
        amount: paid.paymentAttempt.binding.amount,
        lifecycle: {
          state: "captured",
          capturedAt: paid.paymentAttempt.lifecycle.capturedAt,
        },
        occurredAt: command.requestedAt,
      });
      break;
    case "manual": {
      const due = amountDue(quote);
      if (due.amountMinor <= 0) return placementRejected("checkout.payment");
      payment = parsePayment({
        id: command.paymentId,
        revision: 1,
        orderId: command.orderId,
        amount: due,
        lifecycle: { state: "captured", capturedAt: command.requestedAt },
        occurredAt: command.requestedAt,
      });
      manualTender = {
        ...paid.tender,
        paymentId: payment.id,
        orderId: command.orderId,
        amountMinor: due.amountMinor,
        currency: due.currency,
        ...(paid.cashReceivedMinor !== undefined &&
        paid.changeDueMinor !== undefined
          ? {
              cashReceivedMinor: paid.cashReceivedMinor,
              changeDueMinor: paid.changeDueMinor,
            }
          : {}),
        recordedAt: command.requestedAt,
      };
      break;
    }
    case "invoice": {
      const due = amountDue(quote);
      if (due.amountMinor <= 0) return placementRejected("checkout.payment");
      payment = parsePayment({
        id: command.paymentId,
        revision: 1,
        orderId: command.orderId,
        amount: due,
        lifecycle: { state: "captured", capturedAt: command.requestedAt },
        occurredAt: command.requestedAt,
      });
      invoice = termsInvoice({
        invoiceId: paid.invoiceId,
        companyId: paid.terms.companyId,
        netDays: paid.terms.netDays,
        orderId: command.orderId,
        paymentId: payment.id,
        amount: due,
        issuedAt: command.requestedAt,
      });
      break;
    }
    default:
      return assertNever(paid, "Unexpected placement tender");
  }
  const common: CheckoutPlacementCommon = {
    checkout: nextCheckout,
    paymentAttempt,
    order,
    payment,
    storedValuePayments,
    manualTender,
    ...(invoice === undefined ? {} : { invoice }),
    allocations,
  };
  if (quote.fulfillment.kind === "pickup") {
    return {
      kind: "planned",
      value: {
        ...common,
        kind: "pickup",
        fulfillment: parsePickupFulfillment({
          kind: "pickup",
          id: command.fulfillmentId,
          revision: 1,
          orderId: command.orderId,
          lineItems: fulfillmentLines,
          locationId: quote.fulfillment.promise.locationId,
          expectedBy: quote.fulfillment.promise.readyAt,
          lifecycle: { state: "requested", requestedAt: command.requestedAt },
          occurredAt: command.requestedAt,
        }),
      },
    };
  }
  // Shipping placement is online-only: it needs the storefront's origin
  // location. A counter sale is pickup and never reaches here.
  const shippingStorefront =
    checkout.source.kind === "online"
      ? readStorefront(
          database,
          command.merchantId,
          checkout.source.storefrontId,
        )
      : undefined;
  if (
    command.placement.kind !== "shipping" ||
    shippingStorefront === undefined ||
    shippingStorefront.fulfillment.kind !== "shipping" ||
    quote.fulfillment.quote.estimatedDelivery.kind !== "window"
  ) {
    return placementRejected("checkout.shippingPlacement");
  }
  const shipmentPackage = shipmentPackageForOrder(quote, command.orderId);
  if (shipmentPackage === undefined) {
    return placementRejected("checkout.shippingPackage");
  }
  return {
    kind: "planned",
    value: {
      ...common,
      kind: "shipping",
      fulfillment: parseShippingFulfillment({
        kind: "shipping",
        binding: {
          kind: "first_party_checkout",
          protectedAddressReference:
            quote.fulfillment.quote.address.protectedAddressReference,
          acceptedShippingQuote: quote.fulfillment.quote,
        },
        id: command.fulfillmentId,
        revision: 1,
        orderId: command.orderId,
        lineItems: fulfillmentLines,
        locationId: shippingStorefront.fulfillment.originLocationId,
        expectedBy: quote.fulfillment.quote.estimatedDelivery.latest,
        lifecycle: { state: "requested", requestedAt: command.requestedAt },
        occurredAt: command.requestedAt,
      }),
      shipment: parseFirstPartyShipment({
        kind: "first_party",
        id: command.placement.shipmentId,
        revision: 1,
        orderId: command.orderId,
        fulfillmentId: command.fulfillmentId,
        package: shipmentPackage,
        lifecycle: { state: "ready", readyAt: command.requestedAt },
        events: [],
        occurredAt: command.requestedAt,
      }),
    },
  };
}

// A captured balance checkout pays part of an order that already exists. The
// order gains the payment and one revision; no stock or fulfilment changes.
function planBalancePlacement(
  command: PlaceCommercePaidCheckoutV1,
  checkout: Checkout,
  paymentAttempt: CheckoutPaymentAttempt,
  resources: CommerceResourcesV1,
): CheckoutPlacementPlanResult {
  const quote = checkout.lifecycle.quote;
  const line = quote.lines[0];
  if (
    quote.lines.length !== 1 ||
    line?.source.kind !== "order_balance" ||
    line.source.orderId !== command.orderId ||
    paymentAttempt.lifecycle.state !== "captured"
  )
    return placementRejected("checkout.orderBalance");
  const order = findResource(resources.orders, command.orderId);
  if (order === undefined)
    return placementRejected("checkout.orderBalance.order");
  const payBalance = commerceTransition(
    "order",
    order.lifecycle,
    "pay_balance",
  );
  if (!payBalance.allowed)
    return { kind: "rejected", error: payBalance.refusal };
  const payment = parsePayment({
    id: command.paymentId,
    revision: 1,
    orderId: order.id,
    amount: paymentAttempt.binding.amount,
    lifecycle: {
      state: "captured",
      capturedAt: paymentAttempt.lifecycle.capturedAt,
    },
    occurredAt: command.requestedAt,
  });
  const nextOrder = orderWithAddedPayment(order, command.requestedAt);
  return {
    kind: "planned",
    value: {
      kind: "balance",
      checkout: parseCheckout({
        checkoutId: checkout.checkoutId,
        source: checkout.source,
        revision: checkout.revision + 1,
        lifecycle: {
          state: "accepted",
          quote,
          paymentAttemptId: command.paymentAttemptId,
          orderId: order.id,
          acceptedAt: command.requestedAt,
        },
      }),
      paymentAttempt,
      order: nextOrder,
      payment,
      storedValuePayments: [],
      manualTender: undefined,
      allocations: [],
      previousOrderRevision: order.revision,
      change: {
        kind: "payment",
        id: `order_change_${sha256(`${order.id}:${payment.id}`)}`,
        orderId: order.id,
        orderRevisionBefore: order.revision,
        orderRevisionAfter: nextOrder.revision,
        paymentId: payment.id,
        checkoutId: checkout.checkoutId,
        amount: payment.amount,
        occurredAt: command.requestedAt,
      },
    },
  };
}

function parsePickupFulfillment(value: unknown): CommercePickupFulfillmentV1 {
  const fulfillment = parseFulfillment(value);
  if (fulfillment.kind !== "pickup") {
    throw new Error("Pickup fulfillment parser returned a different branch");
  }
  return fulfillment;
}

function parseShippingFulfillment(
  value: unknown,
): Variant<CommerceFulfillmentV1, "shipping"> {
  const fulfillment = parseFulfillment(value);
  if (fulfillment.kind !== "shipping") {
    throw new Error("Shipping fulfillment parser returned a different branch");
  }
  return fulfillment;
}

function parseFirstPartyShipment(value: unknown): CommerceFirstPartyShipmentV1 {
  const shipment = parseShipment(value);
  if (shipment.kind !== "first_party") {
    throw new Error("First-party shipment parser returned a different branch");
  }
  return shipment;
}

function shipmentPackageForOrder(
  quote: CheckoutQuoteSnapshot,
  orderId: string,
): CommerceFirstPartyShipmentV1["package"] | undefined {
  if (quote.fulfillment.kind !== "shipping") return undefined;
  const checkoutToOrder = new Map(
    quote.lines.map((line) => [
      line.checkoutLineId,
      orderLineIdFor(orderId, line.checkoutLineId),
    ]),
  );
  const source = quote.fulfillment.quote.packagePlan.package;
  const lineQuantities = source.lineQuantities.map((line) => {
    const orderLineId = checkoutToOrder.get(line.checkoutLineId);
    return orderLineId === undefined
      ? undefined
      : {
          orderLineId,
          quantity: line.quantity,
        };
  });
  const customsLines = source.customsLines.map((line) => {
    const orderLineId = checkoutToOrder.get(line.checkoutLineId);
    return orderLineId === undefined
      ? undefined
      : {
          orderLineId,
          description: line.description,
          quantity: line.quantity,
          weight: line.weight,
          declaredValue: line.declaredValue,
          countryOfOrigin: line.countryOfOrigin,
          hsCode: line.hsCode,
        };
  });
  if (
    lineQuantities.some((line) => line === undefined) ||
    customsLines.some((line) => line === undefined)
  ) {
    return undefined;
  }
  return {
    packageId: source.packageId,
    weight: source.weight,
    dimensions: source.dimensions,
    lineQuantities: lineQuantities.filter(isPresent),
    customsLines: customsLines.filter(isPresent),
  };
}

function isPresent<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}

type OpenPaymentAttemptLifecycle = Extract<
  CheckoutPaymentAttemptLifecycle,
  Readonly<{ state: "pending" | "processing" | "indeterminate" }>
>;

/**
 * The `answer_time_valid` guard of the payment attempt machine. A pending
 * attempt takes an answer from its creation on; a slow or lost answer is read
 * again only after its `reconcileAfter`. A new slow answer must not move a
 * pending attempt's next read before the request.
 */
function providerAnswerTimeValid(
  lifecycle: OpenPaymentAttemptLifecycle,
  requestedAt: string,
  nextReconcileAfter: string | undefined,
): boolean {
  switch (lifecycle.state) {
    case "pending":
      return (
        timestampAtOrBefore(lifecycle.createdAt, requestedAt) &&
        (nextReconcileAfter === undefined ||
          timestampAtOrBefore(requestedAt, nextReconcileAfter))
      );
    case "processing":
    case "indeterminate":
      return timestampAtOrBefore(lifecycle.reconcileAfter, requestedAt);
  }
}

function validatePaymentCaptureRevisions(
  command: RecordCommerceCheckoutPaymentCaptureV1,
  checkout: Checkout | undefined,
  paymentAttempt: CheckoutPaymentAttempt | undefined,
): CommerceMutationErrorV1 | undefined {
  const errors = [
    checkCheckoutRevision(
      "checkout",
      command.checkoutId,
      command.checkoutRevision,
      checkout?.revision,
    ),
    checkCheckoutRevision(
      "checkout_payment_attempt",
      command.paymentAttemptId,
      command.paymentAttemptRevision,
      paymentAttempt?.revision,
    ),
  ];
  return errors.find(definedMutationError);
}

function validatePlacementRevisions(
  command: PlaceCommercePaidCheckoutV1,
  checkout: Checkout | undefined,
  paymentAttempt: CheckoutPaymentAttempt | undefined,
): CommerceMutationErrorV1 | undefined {
  if (checkout === undefined) {
    return {
      code: "resource_not_found",
      kind: "checkout",
      id: command.checkoutId,
    };
  }
  if (paymentAttempt === undefined) {
    return {
      code: "resource_not_found",
      kind: "checkout_payment_attempt",
      id: command.paymentAttemptId,
    };
  }
  if (checkout.revision !== command.checkoutRevision) {
    return {
      code: "stale_resource_revision",
      kind: "checkout",
      id: command.checkoutId,
      expected: command.checkoutRevision,
      actual: checkout.revision,
    };
  }
  if (paymentAttempt.revision !== command.paymentAttemptRevision) {
    return {
      code: "stale_resource_revision",
      kind: "checkout_payment_attempt",
      id: command.paymentAttemptId,
      expected: command.paymentAttemptRevision,
      actual: paymentAttempt.revision,
    };
  }
  return undefined;
}

type AllocationTransferResult =
  | Readonly<{ kind: "planned"; allocations: readonly InventoryAllocation[] }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

function transferCheckoutLineAllocations(
  database: CommerceDatabase,
  command: PlacementCommand,
  checkoutLineId: string,
  orderLineId: string,
  allocationIds: readonly string[],
): AllocationTransferResult {
  const allocations: InventoryAllocation[] = [];
  for (const allocationId of allocationIds) {
    const allocation = readInventoryAllocation(
      database,
      command.merchantId,
      allocationId,
    );
    if (allocation === undefined) {
      return {
        kind: "rejected",
        error: {
          code: "resource_not_found",
          kind: "inventory_allocation",
          id: allocationId,
        },
      };
    }
    if (
      allocation.lifecycle.state !== "held" ||
      allocation.lifecycle.demand.kind !== "checkout" ||
      allocation.lifecycle.demand.checkoutId !== command.checkoutId ||
      allocation.lifecycle.demand.checkoutLineId !== checkoutLineId
    ) {
      return allocationTransferRejected("inventoryAllocation.lifecycle");
    }
    allocations.push(
      parseInventoryAllocation({
        allocationId: allocation.allocationId,
        inventoryItemId: allocation.inventoryItemId,
        locationId: allocation.locationId,
        quantity: allocation.quantity,
        revision: allocation.revision + 1,
        lifecycle: {
          state: "allocated_to_order",
          orderId: command.orderId,
          orderLineId,
          consumeOn: allocation.lifecycle.demand.consumeOn,
          allocatedAt: command.requestedAt,
        },
      }),
    );
  }
  return { kind: "planned", allocations };
}

function allocateOrderLineTaxes(
  quote: CheckoutQuoteSnapshot,
): readonly Readonly<{ amountMinor: number; currency: string }>[] | undefined {
  if (quote.fulfillment.kind === "shipping") {
    return allocateAcceptedShippingTaxes(quote);
  }
  if (quote.lines.length === 0) return undefined;
  for (const line of quote.lines) {
    if (quote.totals.tax.currency !== line.lineTotal.currency) return undefined;
  }
  return allocateTaxAcrossLines(
    quote.lines.map((line) => ({
      id: line.checkoutLineId,
      amountMinor: line.lineTotal.amountMinor,
    })),
    quote.totals.subtotal.amountMinor,
    quote.totals.tax,
  );
}

/**
 * Splits an order's tax over its lines in proportion to each line amount. The
 * units left by rounding go to the lines with the largest remainders.
 */
export function allocateTaxAcrossLines(
  lines: readonly Readonly<{ id: string; amountMinor: number }>[],
  expectedSubtotal: number,
  tax: Readonly<{ amountMinor: number; currency: string }>,
): readonly Readonly<{ amountMinor: number; currency: string }>[] | undefined {
  let subtotal = 0;
  for (const line of lines) {
    subtotal += line.amountMinor;
    if (!Number.isSafeInteger(subtotal)) return undefined;
  }
  if (
    !Number.isSafeInteger(expectedSubtotal) ||
    expectedSubtotal < 0 ||
    subtotal !== expectedSubtotal
  ) {
    return undefined;
  }
  if (subtotal === 0) {
    return tax.amountMinor === 0
      ? lines.map(() => zeroMoney(tax.currency))
      : undefined;
  }
  type TaxShare = Readonly<{
    index: number;
    checkoutLineId: string;
    baseMinor: bigint;
    remainder: bigint;
    lineAmount: number;
  }>;
  const shares: TaxShare[] = [];
  let assigned = 0n;
  const taxMinor = BigInt(tax.amountMinor);
  const subtotalMinor = BigInt(subtotal);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) throw new Error("Tax line disappeared");
    const numerator = taxMinor * BigInt(line.amountMinor);
    const baseMinor = numerator / subtotalMinor;
    assigned += baseMinor;
    shares.push({
      index,
      checkoutLineId: line.id,
      baseMinor,
      remainder: numerator % subtotalMinor,
      lineAmount: line.amountMinor,
    });
  }
  const remainderUnits = taxMinor - assigned;
  const eligibleShares = shares.filter(taxShareHasLineAmount);
  if (remainderUnits < 0n || remainderUnits > BigInt(eligibleShares.length))
    return undefined;
  eligibleShares.sort(compareTaxShareRemainder);
  const bonusIndexes = new Set(
    eligibleShares.slice(0, Number(remainderUnits)).map(taxShareIndex),
  );
  const taxes: Array<Readonly<{ amountMinor: number; currency: string }>> = [];
  for (const share of shares) {
    taxes.push({
      amountMinor:
        Number(share.baseMinor) + (bonusIndexes.has(share.index) ? 1 : 0),
      currency: tax.currency,
    });
  }
  return taxes;
}

function taxShareHasLineAmount(
  share: Readonly<{ lineAmount: number }>,
): boolean {
  return share.lineAmount > 0;
}

function compareTaxShareRemainder(
  left: Readonly<{ remainder: bigint; checkoutLineId: string }>,
  right: Readonly<{ remainder: bigint; checkoutLineId: string }>,
): number {
  if (left.remainder > right.remainder) return -1;
  if (left.remainder < right.remainder) return 1;
  if (left.checkoutLineId < right.checkoutLineId) return -1;
  if (left.checkoutLineId > right.checkoutLineId) return 1;
  return 0;
}

function taxShareIndex(share: Readonly<{ index: number }>): number {
  return share.index;
}

function allocateAcceptedShippingTaxes(
  quote: CheckoutQuoteSnapshot,
): readonly Readonly<{ amountMinor: number; currency: string }>[] | undefined {
  if (
    quote.fulfillment.kind !== "shipping" ||
    quote.fulfillment.quote.taxQuote.lineAllocations.length !==
      quote.lines.length
  ) {
    return undefined;
  }
  const taxes: Readonly<{ amountMinor: number; currency: string }>[] = [];
  for (const line of quote.lines) {
    const allocation = findCheckoutLineChargeAllocation(
      quote.fulfillment.quote.taxQuote.lineAllocations,
      line.checkoutLineId,
    );
    if (allocation === undefined) return undefined;
    taxes.push(allocation.amount);
  }
  return taxes;
}

function findCheckoutLineChargeAllocation(
  allocations: readonly CheckoutLineChargeAllocation[],
  checkoutLineId: string,
): CheckoutLineChargeAllocation | undefined {
  for (const allocation of allocations) {
    if (allocation.checkoutLineId === checkoutLineId) return allocation;
  }
  return undefined;
}

function checkoutOrderTotals(
  quote: CheckoutQuoteSnapshot,
): CommerceOrderV1["totals"] {
  const zero = zeroMoney(quote.totals.total.currency);
  return {
    subtotal: quote.totals.subtotal,
    discount: quote.totals.discount ?? zero,
    tax: quote.totals.tax,
    duty: quote.totals.duty,
    shipping: quote.totals.shipping,
    serviceFee: zero,
    tip: zero,
    rounding: zero,
    total: quote.totals.total,
    ...(quote.totals.taxIncluded === true
      ? { taxIncluded: true as const }
      : {}),
  };
}

function zeroMoney(
  currency: string,
): Readonly<{ amountMinor: number; currency: string }> {
  return { amountMinor: 0, currency };
}

function placementRejected(field: string): CheckoutPlacementPlanResult {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}

function allocationTransferRejected(field: string): AllocationTransferResult {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}

/** The resolution that a provider answer other than a capture records. */
export function providerResolutionOutcome(
  provider: Exclude<
    CommercePaymentCaptureResultV1,
    Readonly<{ kind: "captured" }>
  >,
): ResolveCommerceCheckoutPaymentV1["outcome"] {
  return provider.kind === "declined"
    ? { kind: "declined", reasonCode: provider.reason }
    : provider.kind === "processing"
      ? {
          kind: "processing",
          reasonCode: provider.reason,
          reconcileAfter: provider.reconcileAfter,
        }
      : {
          kind: "indeterminate",
          reasonCode: provider.reason,
          reconcileAfter: provider.reconcileAfter,
        };
}

export function planCheckoutPaymentResolution(
  database: CommerceDatabase,
  command: ResolveCommerceCheckoutPaymentV1,
  checkout: Checkout | undefined,
  paymentAttempt: CheckoutPaymentAttempt | undefined,
): CheckoutPaymentResolutionPlanResult {
  const revisionError = validatePaymentResolutionRevisions(
    command,
    checkout,
    paymentAttempt,
  );
  if (revisionError !== undefined)
    return { kind: "rejected", error: revisionError };
  if (checkout === undefined || paymentAttempt === undefined) {
    throw new Error(
      "Payment resolution revision validation did not preserve resources",
    );
  }
  const settle = commerceTransition(
    "checkout",
    checkout.lifecycle,
    command.outcome.kind === "declined" ? "decline" : "record_progress",
  );
  if (!settle.allowed) return { kind: "rejected", error: settle.refusal };
  const answer = commerceTransition(
    "payment_attempt",
    paymentAttempt.lifecycle,
    command.outcome.kind === "declined"
      ? "decline"
      : command.outcome.kind === "processing"
        ? "report_processing"
        : "report_indeterminate",
  );
  if (!answer.allowed) return { kind: "rejected", error: answer.refusal };
  if (
    settle.from.paymentAttemptId !== command.paymentAttemptId ||
    settle.from.quote.quoteDigest !== command.quoteDigest ||
    settle.from.quote.quoteDigest !== checkoutQuoteDigest(settle.from.quote) ||
    paymentAttempt.binding.checkoutId !== command.checkoutId ||
    paymentAttempt.binding.quoteDigest !== command.quoteDigest ||
    !checkoutPaymentBindingMatchesQuote(paymentAttempt, settle.from.quote) ||
    !providerAnswerTimeValid(
      answer.from,
      command.requestedAt,
      command.outcome.kind === "declined"
        ? undefined
        : command.outcome.reconcileAfter,
    )
  ) {
    return paymentResolutionRejected("checkoutPayment.resolution");
  }
  if (command.outcome.kind === "processing") {
    return {
      kind: "planned",
      value: {
        kind: "processing",
        checkout,
        paymentAttempt: processingPaymentAttempt(
          paymentAttempt,
          command.outcome,
        ),
      },
    };
  }
  if (command.outcome.kind === "indeterminate") {
    return {
      kind: "planned",
      value: {
        kind: "indeterminate",
        checkout,
        paymentAttempt: indeterminatePaymentAttempt(
          paymentAttempt,
          command.outcome,
        ),
      },
    };
  }
  const release = planCheckoutAllocationRelease(
    database,
    command.merchantId,
    checkout.checkoutId,
    checkout.lifecycle.quote,
    command.requestedAt,
    "payment_declined",
  );
  if (release.kind === "rejected") return release;
  return {
    kind: "planned",
    value: {
      kind: "declined",
      checkout: expiredCheckout(checkout, command.requestedAt),
      paymentAttempt: declinedPaymentAttempt(
        paymentAttempt,
        command.outcome,
        command.requestedAt,
      ),
      allocations: release.allocations,
      positions: release.positions,
    },
  };
}

function checkoutPaymentBindingMatchesQuote(
  paymentAttempt: CheckoutPaymentAttempt,
  quote: CheckoutQuoteSnapshot,
): boolean {
  return (
    paymentAttempt.binding.checkoutRevision === quote.checkoutRevision &&
    paymentAttempt.binding.quoteDigest === quote.quoteDigest &&
    sameMoney(paymentAttempt.binding.amount, amountDue(quote)) &&
    paymentBindingMatchesQuote(paymentAttempt.binding.paymentBinding, quote)
  );
}

// Stripe charges in the buyer's currency and settles in the account's;
// Square and GMO take only the account currency.
function paymentBindingMatchesQuote(
  paymentBinding: Readonly<{
    provider: string;
    account: Readonly<{ currency: string }>;
  }>,
  quote: CheckoutQuoteSnapshot,
): boolean {
  return (
    paymentBinding.provider === "stripe_online" ||
    paymentBinding.account.currency === quote.totals.total.currency
  );
}

export function planCheckoutExpiration(
  database: CommerceDatabase,
  command: ExpireCommerceCheckoutV1,
  checkout: Checkout | undefined,
): CheckoutExpirationPlanResult {
  const revisionError = checkCheckoutRevision(
    "checkout",
    command.checkoutId,
    command.checkoutRevision,
    checkout?.revision,
  );
  if (revisionError !== undefined)
    return { kind: "rejected", error: revisionError };
  if (checkout === undefined)
    throw new Error("Expiration revision validation lost checkout");
  const expire = commerceTransition("checkout", checkout.lifecycle, "expire");
  if (!expire.allowed) return { kind: "rejected", error: expire.refusal };
  if (
    checkout.lifecycle.quote.quoteDigest !== command.quoteDigest ||
    !timestampAtOrBefore(
      checkout.lifecycle.quote.expiresAt,
      command.requestedAt,
    )
  ) {
    return expirationRejected("checkout.expiration");
  }
  const release = planCheckoutAllocationRelease(
    database,
    command.merchantId,
    checkout.checkoutId,
    checkout.lifecycle.quote,
    command.requestedAt,
    "checkout_expired",
  );
  if (release.kind === "rejected") return release;
  return {
    kind: "planned",
    value: {
      checkout: expiredCheckout(checkout, command.requestedAt),
      allocations: release.allocations,
      positions: release.positions,
    },
  };
}

function validatePaymentResolutionRevisions(
  command: ResolveCommerceCheckoutPaymentV1,
  checkout: Checkout | undefined,
  paymentAttempt: CheckoutPaymentAttempt | undefined,
): CommerceMutationErrorV1 | undefined {
  const errors = [
    checkCheckoutRevision(
      "checkout",
      command.checkoutId,
      command.checkoutRevision,
      checkout?.revision,
    ),
    checkCheckoutRevision(
      "checkout_payment_attempt",
      command.paymentAttemptId,
      command.paymentAttemptRevision,
      paymentAttempt?.revision,
    ),
  ];
  return errors.find(definedMutationError);
}

function processingPaymentAttempt(
  attempt: CheckoutPaymentAttempt,
  outcome: Variant<ResolveCommerceCheckoutPaymentV1["outcome"], "processing">,
): CheckoutPaymentAttempt {
  return parseCheckoutPaymentAttempt({
    paymentAttemptId: attempt.paymentAttemptId,
    revision: attempt.revision + 1,
    binding: attempt.binding,
    lifecycle: {
      state: "processing",
      reasonCode: outcome.reasonCode,
      reconcileAfter: outcome.reconcileAfter,
    },
  });
}

function indeterminatePaymentAttempt(
  attempt: CheckoutPaymentAttempt,
  outcome: Variant<
    ResolveCommerceCheckoutPaymentV1["outcome"],
    "indeterminate"
  >,
): CheckoutPaymentAttempt {
  return parseCheckoutPaymentAttempt({
    paymentAttemptId: attempt.paymentAttemptId,
    revision: attempt.revision + 1,
    binding: attempt.binding,
    lifecycle: {
      state: "indeterminate",
      reasonCode: outcome.reasonCode,
      reconcileAfter: outcome.reconcileAfter,
    },
  });
}

function declinedPaymentAttempt(
  attempt: CheckoutPaymentAttempt,
  outcome: Variant<ResolveCommerceCheckoutPaymentV1["outcome"], "declined">,
  requestedAt: string,
): CheckoutPaymentAttempt {
  return parseCheckoutPaymentAttempt({
    paymentAttemptId: attempt.paymentAttemptId,
    revision: attempt.revision + 1,
    binding: attempt.binding,
    lifecycle: {
      state: "declined",
      reasonCode: outcome.reasonCode,
      declinedAt: requestedAt,
    },
  });
}

function expiredCheckout(checkout: Checkout, expiredAt: string): Checkout {
  const quote = checkout.lifecycle.quote;
  return parseCheckout({
    checkoutId: checkout.checkoutId,
    source: checkout.source,
    revision: checkout.revision + 1,
    lifecycle: { state: "expired", quote, expiredAt },
  });
}

type CheckoutAllocationReleaseResult =
  | Readonly<{
      kind: "planned";
      allocations: readonly InventoryAllocation[];
      positions: readonly CommerceInventoryPositionV1[];
    }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function planCheckoutAllocationRelease(
  database: CommerceDatabase,
  merchantId: string,
  checkoutId: string,
  quote: CheckoutQuoteSnapshot,
  releasedAt: string,
  reason: string,
): CheckoutAllocationReleaseResult {
  const allocations: InventoryAllocation[] = [];
  const positions = new Map<string, CommerceInventoryPositionV1>();
  const allocationIds = new Set<string>();
  for (const line of quote.lines) {
    for (const allocationId of line.allocationIds) {
      if (!allocationIds.add(allocationId))
        return releaseRejected("checkout.allocationIds");
      const allocation = readInventoryAllocation(
        database,
        merchantId,
        allocationId,
      );
      if (
        allocation?.lifecycle.state !== "held" ||
        allocation.lifecycle.demand.kind !== "checkout" ||
        allocation.lifecycle.demand.checkoutId !== checkoutId ||
        allocation.lifecycle.demand.checkoutLineId !== line.checkoutLineId
      ) {
        return releaseRejected("checkout.allocation");
      }
      const stored = readInventoryPositionForItemLocation(
        database,
        merchantId,
        allocation.inventoryItemId,
        allocation.locationId,
      );
      const position =
        stored === undefined ? undefined : (positions.get(stored.id) ?? stored);
      if (
        position === undefined ||
        !isAccountedPosition(position) ||
        !accountedPositionCanRelease(position, allocation.quantity)
      ) {
        return releaseRejected("checkout.position");
      }
      allocations.push(
        parseInventoryAllocation({
          allocationId: allocation.allocationId,
          inventoryItemId: allocation.inventoryItemId,
          locationId: allocation.locationId,
          quantity: allocation.quantity,
          revision: allocation.revision + 1,
          lifecycle: {
            state: "released",
            demand: {
              kind: "checkout",
              checkoutId: allocation.lifecycle.demand.checkoutId,
              checkoutLineId: allocation.lifecycle.demand.checkoutLineId,
            },
            reason,
            releasedAt,
          },
        }),
      );
      positions.set(
        position.id,
        releasedInventoryPosition(
          position,
          allocation.quantity,
          releasedAt,
          positions.has(position.id),
        ),
      );
    }
  }
  return { kind: "planned", allocations, positions: [...positions.values()] };
}

function checkoutRelationshipError(field: string): CommerceMutationErrorV1 {
  return { code: "resource_relationship_invalid", field };
}

function paymentResolutionRejected(
  field: string,
): CheckoutPaymentResolutionPlanResult {
  return { kind: "rejected", error: checkoutRelationshipError(field) };
}

function expirationRejected(field: string): CheckoutExpirationPlanResult {
  return { kind: "rejected", error: checkoutRelationshipError(field) };
}

function releaseRejected(field: string): CheckoutAllocationReleaseResult {
  return { kind: "rejected", error: checkoutRelationshipError(field) };
}

/**
 * Build the Order origin from the Checkout that produced it.
 *
 * This is the TypeScript mirror of `CheckoutSource::order_origin` in
 * `packages/commerce-contracts/src/commerce/point_of_sale.rs`, which is the spec. It is
 * exhaustive on purpose: a point-of-sale Checkout must never place an `online`
 * Order just because that was the only literal available.
 */
/**
 * The sales channel an accepted Checkout places under.
 *
 * A counter sale reads the exact POS configuration revision it pinned, not
 * whatever is published now, so republishing the counter policy cannot move an
 * Order that was already rung up.
 */
function placementSalesChannelId(
  database: CommerceDatabase,
  merchantId: string,
  checkout: Checkout,
): string | undefined {
  if (checkout.source.kind === "online") {
    const storefront = readStorefront(
      database,
      merchantId,
      checkout.source.storefrontId,
    );
    return storefront === undefined || storefront.lifecycle.state !== "active"
      ? undefined
      : storefront.salesChannelId;
  }
  const configuration = readPointOfSaleConfigurationForCheckout(
    database,
    merchantId,
    checkout.source.pantryLocationId,
    checkout.source.posConfigurationRevision,
  );
  return configuration?.salesChannelId;
}

function placementOrderOrigin(
  checkout: Checkout,
  salesChannelId: string,
  paymentAttempt: CheckoutPaymentAttempt | undefined,
  orderId: string,
): CommerceOrderOriginV1 {
  switch (checkout.source.kind) {
    case "online":
      return {
        kind: "online",
        salesChannelId,
        storefrontId: checkout.source.storefrontId,
        checkoutId: checkout.checkoutId,
        configuration: {
          kind: "checkout_profile",
          checkoutProfile: checkout.source.checkoutProfile,
        },
      };
    case "point_of_sale":
      return {
        kind: "point_of_sale",
        salesChannelId,
        locationId: checkout.source.pantryLocationId,
        checkoutId: checkout.checkoutId,
        // The terminal that actually took the money, read off the payment
        // binding rather than restated by the caller.
        terminalId: placementTerminalId(paymentAttempt),
        // Pantry's own receipt identity. The provider's printed slip is
        // presentation; this is the commercial record.
        receiptNumber: orderId,
      };
    default:
      return assertNever(checkout.source, "Unsupported checkout source");
  }
}

function placementTerminalId(
  paymentAttempt: CheckoutPaymentAttempt | undefined,
): string | null {
  if (paymentAttempt === undefined) {
    return null;
  }
  const binding = paymentAttempt.binding.paymentBinding;
  if (binding.provider === "square_terminal") {
    // The Square Point of Sale app takes the money on whichever iPad is
    // signed in to the location; Commerce names no device for it.
    return binding.transport === "server_terminal" ? binding.deviceId : null;
  }
  if (binding.provider === "gmo_stera") {
    return `${binding.gatewayId}:${binding.deviceSourceKey}`;
  }
  throw new Error(
    "point_of_sale placement requires an in-person payment binding",
  );
}
