// Plan 78 step 2: the buyer storefront responses that
// packages/commerce-client reads in storefront-client.ts: the
// catalog, carts, quoted checkouts, address validation, checkout recovery,
// payment results and orders. Each schema follows its hand-written reader:
// exact keys where the reader requires them, and each cross-field rule of the
// reader as a refinement.
import { Type, type Static } from "typebox";
import { NonNegativeInteger, PositiveInteger } from "@purin-labs/contract-schema";
import {
  countryCodeTextSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import { wireMoneySchema } from "./api-common.ts";
import { wireCheckoutProfileReferenceSchema } from "./api-admin.ts";
import {
  parsedQuoteTotalsSchema,
  commerceCompareAtPriceV1Schema,
  commerceVariantMediaV1Schema,
  commerceVariantOptionV1Schema,
} from "./api-resources.ts";
import {
  buyerPickupCheckoutLineSchema,
  buyerShippingAddressSchema,
} from "./api-storefront.ts";
import {
  parseCheckoutStoredValueOfTotal,
  wireCheckoutStoredValueSchema,
} from "./api-stored-value.ts";
import { commerceShippingCountrySchema } from "./api-international-addresses.ts";
import {
  convertMarketAmount,
  marketCurrencySchema,
  marketRateSchema,
} from "./commerce-fields.ts";
import {
  carrierServiceRecordSchema,
  dutyIncotermSchema,
  estimatedDeliverySnapshotSchema,
  packagePlanSnapshotSchema,
  type CheckoutStoredValue,
} from "./commerce-records.ts";
import {
  Absent,
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;
// A buyer page shows names and descriptions as written. Product descriptions
// are free text, so white space at an end, or an empty description, must not
// refuse the whole catalog; identifiers keep the strict rule.
const displayText = Type.String();
const money = wireMoneySchema;

type Money = Readonly<{ amountMinor: number; currency: string }>;

/** `parseBuyerListing`: older servers send no compare-at price, handle, options or media. */
const buyerCatalogListingSchema = Type.Refine(
  ReadonlyOpenObject({
    productId: text,
    productRevision: PositiveInteger,
    title: displayText,
    description: displayText,
    variantId: text,
    variantRevision: PositiveInteger,
    variantTitle: displayText,
    sku: text,
    offerId: text,
    offerRevision: PositiveInteger,
    price: money,
    compareAtPrice: commerceCompareAtPriceV1Schema,
    handle: Type.Union([text, Type.Null()], { default: null }),
    options: ImmutableArray(commerceVariantOptionV1Schema, { default: [] }),
    media: ImmutableArray(commerceVariantMediaV1Schema, { default: [] }),
    availability: Type.Union([
      Type.Literal("available"),
      Type.Literal("unavailable"),
    ]),
  }),
  compareAtUsesPriceCurrency,
  compareAtCurrencyError,
);

const commerceBuyerCatalogSearchV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.buyer-catalog-search.v1"),
  query: Type.String(),
  listings: ImmutableArray(buyerCatalogListingSchema),
});

const buyerShippingServiceSchema = ReadonlyStrictObject({
  destinationCountry: countryCodeTextSchema,
  service: carrierServiceRecordSchema,
  availability: Type.Union([
    ReadonlyStrictObject({
      state: Type.Literal("available"),
      recovery: Absent,
    }),
    ReadonlyStrictObject({
      state: Type.Literal("temporarily_unavailable"),
      recovery: Type.Literal("try_again_later"),
    }),
  ]),
});

/** At least one service, unique by destination and code. */
const buyerShippingServicesSchema = Type.Refine(
  ImmutableArray(buyerShippingServiceSchema, { minItems: 1 }),
  hasUniqueShippingServices,
  shippingServicesError,
);

const buyerModifierGroupSchema = ReadonlyOpenObject({
  modifierGroupId: text,
  revision: PositiveInteger,
  name: displayText,
  minimumSelections: NonNegativeInteger,
  maximumSelections: PositiveInteger,
  options: ImmutableArray(
    ReadonlyOpenObject({
      modifierOptionId: text,
      name: displayText,
      priceDelta: money,
    }),
  ),
});

const buyerMenuEntrySchema = ReadonlyOpenObject({
  menuEntryId: text,
  sectionId: text,
  revision: PositiveInteger,
  variantId: text,
  variantRevision: PositiveInteger,
  offerId: text,
  offerRevision: PositiveInteger,
  price: money,
  /** The offer's compare-at price, for a deal; older servers send none. */
  compareAtPrice: commerceCompareAtPriceV1Schema,
  availability: Type.Union([
    Type.Literal("available"),
    Type.Literal("unavailable"),
  ]),
  consumptionPlanId: text,
  consumptionPlanRevision: PositiveInteger,
  modifierGroups: ImmutableArray(buyerModifierGroupSchema),
});

const buyerMenuSchema = ReadonlyOpenObject({
  menuId: text,
  revision: PositiveInteger,
  name: displayText,
  sections: ImmutableArray(
    ReadonlyOpenObject({
      sectionId: text,
      name: displayText,
      position: NonNegativeInteger,
    }),
  ),
  entries: ImmutableArray(buyerMenuEntrySchema),
});

const catalogStorefront = {
  storefrontId: text,
  revision: PositiveInteger,
  name: displayText,
};

const commerceBuyerCatalogV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.buyer-catalog.v1"),
  storefront: Type.Union([
    ReadonlyStrictObject({
      ...catalogStorefront,
      fulfillment: Type.Literal("pickup"),
      shippingServices: Absent,
    }),
    ReadonlyStrictObject({
      ...catalogStorefront,
      fulfillment: Type.Literal("shipping"),
      shippingServices: buyerShippingServicesSchema,
    }),
  ]),
  listings: ImmutableArray(buyerCatalogListingSchema),
  menus: ImmutableArray(buyerMenuSchema),
});

const buyerCart = {
  schemaVersion: Type.Literal("commerce.buyer-cart.v1"),
  cartId: text,
  revision: PositiveInteger,
  checkoutProfile: wireCheckoutProfileReferenceSchema,
  fulfillment: Type.Union([Type.Literal("pickup"), Type.Literal("shipping")]),
  lines: ImmutableArray(buyerPickupCheckoutLineSchema, { minItems: 1 }),
};

const commerceBuyerCartV1Schema = Type.Union([
  ReadonlyStrictObject({
    ...buyerCart,
    state: Type.Literal("active"),
    checkoutId: Absent,
  }),
  ReadonlyStrictObject({
    ...buyerCart,
    state: Type.Literal("submitted"),
    checkoutId: text,
  }),
]);

const quotedLineAmounts = {
  checkoutLineId: text,
  quantity: PositiveInteger,
  unitPrice: money,
  lineTotal: money,
};

/** `parseBuyerQuotedCheckoutLine`: the line total is net of its discount. */
const buyerQuotedCatalogLineSchema = Type.Refine(
  ReadonlyStrictObject({
    kind: Type.Literal("catalog"),
    ...quotedLineAmounts,
    variantId: text,
    discount: Type.Optional(money),
  }),
  quotedLineAmountsMatch,
  quotedLineAmountsError,
);

const buyerQuotedLineSchema = Type.Union([
  buyerQuotedCatalogLineSchema,
  Type.Refine(
    ReadonlyStrictObject({
      kind: Type.Literal("menu"),
      ...quotedLineAmounts,
      menuId: text,
      variantId: text,
      menuEntryId: text,
      modifierOptionIds: ImmutableArray(text),
      discount: Type.Optional(money),
    }),
    quotedLineAmountsMatch,
    quotedLineAmountsError,
  ),
  Type.Refine(
    ReadonlyStrictObject({
      kind: Type.Literal("order_balance"),
      ...quotedLineAmounts,
      orderId: text,
    }),
    quotedLineAmountsMatch,
    quotedLineAmountsError,
  ),
]);

/** `parseCheckoutQuoteTotals` with the exact keys that the buyer readers require. */
const buyerQuoteTotalsSchema = ReadonlyStrictObject(
  parsedQuoteTotalsSchema.properties,
);

/** `parseCheckoutStoredValue`; the quote checks it against its total. */
const buyerStoredValueSchema = Type.Unsafe<CheckoutStoredValue>(
  wireCheckoutStoredValueSchema,
);

const quotedCheckout = {
  checkoutId: text,
  revision: PositiveInteger,
  state: Type.Literal("quoted"),
};

const commerceBuyerQuotedCheckoutV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.buyer-quoted-checkout.v1"),
  ...quotedCheckout,
  quote: Type.Refine(
    ReadonlyStrictObject({
      quoteDigest: text,
      lines: ImmutableArray(buyerQuotedLineSchema, { minItems: 1 }),
      totals: buyerQuoteTotalsSchema,
      pickup: ReadonlyStrictObject({
        locationId: text,
        readyAt: utcTimestampSchema,
      }),
      expiresAt: utcTimestampSchema,
      storedValue: Type.Optional(buyerStoredValueSchema),
    }),
    quoteMatchesTotals,
    quoteTotalsError,
  ),
});

const chargeAllocationsSchema = ImmutableArray(
  ReadonlyStrictObject({ checkoutLineId: text, amount: money }),
  { minItems: 1 },
);

const buyerShippingQuoteSchema = ReadonlyStrictObject({
  addressValidationReference: text,
  service: ReadonlyStrictObject(carrierServiceRecordSchema.properties),
  destinationCountry: commerceShippingCountrySchema,
  dutyTerms: ReadonlyStrictObject({ incoterm: dutyIncotermSchema }),
  estimatedDelivery: ReadonlyStrictObject({
    kind: Type.Literal("window"),
    earliest: utcTimestampSchema,
    latest: utcTimestampSchema,
  }),
  carrierQuote: ReadonlyStrictObject({
    rateReference: text,
    shippingAmount: money,
    lineAllocations: chargeAllocationsSchema,
  }),
  taxQuote: ReadonlyStrictObject({
    registrationPolicyReference: text,
    quoteReference: text,
    taxAmount: money,
    lineAllocations: chargeAllocationsSchema,
  }),
  dutyQuote: ReadonlyStrictObject({
    quoteReference: text,
    incoterm: dutyIncotermSchema,
    dutyAmount: money,
    lineAllocations: chargeAllocationsSchema,
  }),
  packagePlan: packagePlanSnapshotSchema,
});
type BuyerShippingQuote = Static<typeof buyerShippingQuoteSchema>;

/** `parseBuyerShippingMarket`. */
const buyerShippingMarketSchema = ReadonlyStrictObject({
  marketId: text,
  currency: marketCurrencySchema,
  shopCurrency: marketCurrencySchema,
  rate: marketRateSchema,
  roundingIncrement: PositiveInteger,
});
type BuyerShippingMarket = Static<typeof buyerShippingMarketSchema>;

const commerceBuyerQuotedShippingCheckoutV1Schema =
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("commerce.buyer-quoted-shipping-checkout.v1"),
    ...quotedCheckout,
    quote: Type.Refine(
      ReadonlyStrictObject({
        quoteDigest: text,
        lines: ImmutableArray(buyerQuotedCatalogLineSchema, { minItems: 1 }),
        totals: buyerQuoteTotalsSchema,
        shipping: buyerShippingQuoteSchema,
        expiresAt: utcTimestampSchema,
        storedValue: Type.Optional(buyerStoredValueSchema),
        market: Type.Optional(buyerShippingMarketSchema),
      }),
      shippingQuoteMatches,
      shippingQuoteError,
    ),
  });

const checkoutSession = ReadonlyOpenObject({
  token: text,
  expiresAt: utcTimestampSchema,
});

const commerceDraftInvoiceCheckoutV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.draft-invoice-checkout.v1"),
  session: checkoutSession,
  checkout: commerceBuyerQuotedCheckoutV1Schema,
});

/** The buyer checkout of an order balance (`parseOrderBalanceCheckout`). */
const commerceOrderBalanceCheckoutV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.order-balance-checkout.v1"),
  session: checkoutSession,
  checkout: commerceBuyerQuotedCheckoutV1Schema,
});
export type CommerceOrderBalanceCheckoutV1 = Static<
  typeof commerceOrderBalanceCheckoutV1Schema
>;

const addressValidation = {
  schemaVersion: Type.Literal(
    "commerce.buyer-shipping-address-validation.v1",
  ),
  validationReference: text,
  expiresAt: utcTimestampSchema,
};

const commerceBuyerShippingAddressValidationV1Schema = Type.Union([
  ReadonlyStrictObject({
    ...addressValidation,
    state: Type.Literal("accepted"),
    address: buyerShippingAddressSchema,
  }),
  ReadonlyStrictObject({
    ...addressValidation,
    state: Type.Literal("correction_required"),
    proposedAddress: buyerShippingAddressSchema,
  }),
  ReadonlyStrictObject({
    ...addressValidation,
    state: Type.Literal("unserviceable"),
    reason: text,
  }),
  ReadonlyStrictObject({
    ...addressValidation,
    state: Type.Literal("indeterminate"),
    retryAfter: utcTimestampSchema,
  }),
]);

const buyerCheckoutPaymentProgressSchema = Type.Union([
  ReadonlyStrictObject({
    state: Type.Union([Type.Literal("pending"), Type.Literal("captured")]),
    paymentAttemptId: text,
  }),
  ReadonlyStrictObject({
    state: Type.Literal("declined"),
    paymentAttemptId: text,
    reasonCode: text,
  }),
  ReadonlyStrictObject({
    state: Type.Union([
      Type.Literal("processing"),
      Type.Literal("indeterminate"),
    ]),
    paymentAttemptId: text,
    reconcileAfter: utcTimestampSchema,
  }),
]);

const commerceBuyerCheckoutRecoveryV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.buyer-checkout-recovery.v1"),
  checkout: Type.Union([
    commerceBuyerQuotedCheckoutV1Schema,
    commerceBuyerQuotedShippingCheckoutV1Schema,
  ]),
  progress: Type.Union([
    ReadonlyStrictObject({ state: Type.Literal("quoted"), payment: Absent }),
    ReadonlyStrictObject({
      state: Type.Literal("payment_pending"),
      payment: buyerCheckoutPaymentProgressSchema,
    }),
  ]),
});

const paymentResult = {
  schemaVersion: Type.Literal("commerce.buyer-payment-result.v1"),
  checkoutId: text,
};

const placedPaymentResult = {
  ...paymentResult,
  state: Type.Literal("placed"),
  checkoutRevision: PositiveInteger,
  orderId: text,
  paymentId: text,
  fulfillmentId: text,
  orderRecovery: ReadonlyOpenObject({
    token: text,
    expiresAt: utcTimestampSchema,
  }),
  placedAt: utcTimestampSchema,
  total: money,
};

/** The destination and delivery estimate that a buyer sees of a shipment. */
const buyerShipping = {
  destinationCountry: countryCodeTextSchema,
  estimatedDelivery: estimatedDeliverySnapshotSchema,
};

/** `parseBuyerPaymentResult`: the reader keeps its own fields and drops the rest. */
const commerceBuyerPaymentResultV1Schema = Type.Union([
  ReadonlyOpenObject({
    ...placedPaymentResult,
    pickup: ReadonlyOpenObject({
      locationId: text,
      expectedBy: utcTimestampSchema,
    }),
    shipping: Absent,
    shipmentId: Absent,
  }),
  ReadonlyOpenObject({
    ...placedPaymentResult,
    shipmentId: text,
    shipping: ReadonlyOpenObject(buyerShipping),
    pickup: Absent,
  }),
  ReadonlyOpenObject({
    ...paymentResult,
    state: Type.Literal("declined"),
    reasonCode: text,
  }),
  ReadonlyOpenObject({
    ...paymentResult,
    state: Type.Union([
      Type.Literal("processing"),
      Type.Literal("indeterminate"),
    ]),
    reconcileAfter: utcTimestampSchema,
  }),
]);

const buyerPaymentDisputeStatusSchema = Type.Union([
  ReadonlyStrictObject({
    disputeId: text,
    amount: money,
    state: Type.Union([
      Type.Literal("action_required"),
      Type.Literal("under_review"),
    ]),
    observedAt: utcTimestampSchema,
  }),
  ReadonlyStrictObject({
    disputeId: text,
    amount: money,
    state: Type.Union([Type.Literal("won"), Type.Literal("lost")]),
    resolvedAt: utcTimestampSchema,
  }),
]);

const buyerRefundStatusSchema = Type.Union([
  ReadonlyStrictObject({
    state: Type.Union([Type.Literal("pending"), Type.Literal("failed")]),
    amount: money,
  }),
  ReadonlyStrictObject({
    state: Type.Literal("refunded"),
    amount: money,
    refundedAt: utcTimestampSchema,
  }),
]);

const buyerOrder = {
  schemaVersion: Type.Literal("commerce.buyer-order.v1"),
  checkoutId: text,
  orderId: text,
  paymentId: text,
  fulfillmentId: text,
  placedAt: utcTimestampSchema,
  total: money,
  paymentDisputes: Type.Refine(
    ImmutableArray(buyerPaymentDisputeStatusSchema),
    hasDistinctDisputes,
    disputesError,
  ),
};

const pickupOrder = {
  ...buyerOrder,
  fulfillment: Type.Literal("pickup"),
  pickup: ReadonlyOpenObject({
    locationId: text,
    expectedBy: utcTimestampSchema,
  }),
};

/** A buyer never sees the protected shipping fields. */
const shippingOrder = {
  ...buyerOrder,
  fulfillment: Type.Literal("shipping"),
  shipmentId: text,
  shipping: ReadonlyOpenObject({
    ...buyerShipping,
    address: Absent,
    customs: Absent,
    package: Absent,
    provider: Absent,
    labelAttempt: Absent,
    labelAttemptId: Absent,
    signature: Absent,
  }),
};

const commerceBuyerOrderV1Schema = Type.Union([
  ReadonlyStrictObject({ ...pickupOrder, state: Type.Literal("placed") }),
  ReadonlyStrictObject({
    ...pickupOrder,
    state: Type.Literal("ready_for_pickup"),
    readyAt: utcTimestampSchema,
  }),
  ReadonlyStrictObject({
    ...pickupOrder,
    state: Type.Literal("completed"),
    completedAt: utcTimestampSchema,
  }),
  ReadonlyStrictObject({
    ...pickupOrder,
    state: Type.Literal("cancelled"),
    cancelledAt: utcTimestampSchema,
    refund: buyerRefundStatusSchema,
  }),
  ReadonlyStrictObject({ ...shippingOrder, state: Type.Literal("ready") }),
  ReadonlyStrictObject({
    ...shippingOrder,
    state: Type.Literal("label_purchased"),
    trackingNumber: text,
    purchasedAt: utcTimestampSchema,
  }),
  ReadonlyStrictObject({
    ...shippingOrder,
    state: Type.Literal("in_transit"),
    trackingNumber: text,
    handedOverAt: utcTimestampSchema,
  }),
  ReadonlyStrictObject({
    ...shippingOrder,
    state: Type.Literal("delivered"),
    trackingNumber: text,
    handedOverAt: utcTimestampSchema,
    deliveredAt: utcTimestampSchema,
  }),
]);

function compareAtUsesPriceCurrency(
  listing: Readonly<{
    price: Money;
    compareAtPrice: Money | null;
  }>,
): boolean {
  // The defaults are filled before the check; an older server sends none.
  const compareAt = listing.compareAtPrice ?? null;
  return compareAt === null || compareAt.currency === listing.price.currency;
}

function compareAtCurrencyError(): string {
  return "compareAtPrice must use the offer currency";
}

function hasUniqueShippingServices(
  services: readonly Readonly<{
    destinationCountry: string;
    service: Readonly<{ code: string }>;
  }>[],
): boolean {
  const keys = new Set<string>();
  for (const service of services)
    keys.add(`${service.destinationCountry}:${service.service.code}`);
  return keys.size === services.length;
}

function shippingServicesError(): string {
  return "shippingServices must be unique by destination and code";
}

/** `validateQuotedLineAmounts`. */
function quotedLineAmountsMatch(
  line: Readonly<{
    quantity: number;
    unitPrice: Money;
    lineTotal: Money;
    discount?: Money;
  }>,
): boolean {
  if (line.unitPrice.currency !== line.lineTotal.currency) return false;
  if (
    line.discount !== undefined &&
    line.discount.currency !== line.lineTotal.currency
  )
    return false;
  return (
    BigInt(line.unitPrice.amountMinor) * BigInt(line.quantity) -
      BigInt(line.discount?.amountMinor ?? 0) ===
    BigInt(line.lineTotal.amountMinor)
  );
}

function quotedLineAmountsError(): string {
  return "lineTotal must equal unitPrice multiplied by quantity, less the discount";
}

type QuoteTotals = Static<typeof parsedQuoteTotalsSchema>;

type Quote = Readonly<{
  lines: readonly Readonly<{ lineTotal: Money }>[];
  totals: QuoteTotals;
  storedValue?: unknown;
}>;

/** `validateQuoteTotals` and the stored value of the quote total. */
function quoteMatchesTotals(quote: Quote): boolean {
  const { lines, totals } = quote;
  const currency = totals.subtotal.currency;
  for (const component of [
    totals.tax,
    totals.duty,
    totals.shipping,
    totals.total,
  ])
    if (component.currency !== currency) return false;
  let subtotalMinor = 0n;
  for (const line of lines) {
    if (line.lineTotal.currency !== currency) return false;
    subtotalMinor += BigInt(line.lineTotal.amountMinor);
  }
  if (subtotalMinor !== BigInt(totals.subtotal.amountMinor)) return false;
  if (
    BigInt(totals.subtotal.amountMinor) +
      (totals.taxIncluded === true ? 0n : BigInt(totals.tax.amountMinor)) +
      BigInt(totals.duty.amountMinor) +
      BigInt(totals.shipping.amountMinor) !==
    BigInt(totals.total.amountMinor)
  )
    return false;
  return (
    quote.storedValue === undefined ||
    parseCheckoutStoredValueOfTotal(totals.total, quote.storedValue).ok
  );
}

function quoteTotalsError(): string {
  return "the quote totals must match its lines and stored value";
}

/**
 * The shipping checkout rules of `parseBuyerQuotedShippingCheckout`: the quote
 * totals, the duty terms of the destination, and quote evidence that covers
 * the quoted lines. The reader's checks for repeated checkout line IDs never
 * refuse (`Set.add` returns the set), so a repeated ID passes here too.
 */
function shippingQuoteMatches(
  quote: Quote &
    Readonly<{
      lines: readonly Readonly<{ checkoutLineId: string; lineTotal: Money }>[];
      shipping: BuyerShippingQuote;
      market?: BuyerShippingMarket;
    }>,
): boolean {
  if (!quoteMatchesTotals(quote)) return false;
  const { lines, totals, shipping, market } = quote;
  const domestic = shipping.destinationCountry === "JP";
  if (domestic !== (shipping.dutyTerms.incoterm === "not_applicable"))
    return false;
  if (
    !allocationsSumTo(
      shipping.carrierQuote.lineAllocations,
      shipping.carrierQuote.shippingAmount,
    ) ||
    !allocationsSumTo(
      shipping.taxQuote.lineAllocations,
      shipping.taxQuote.taxAmount,
    ) ||
    !allocationsSumTo(
      shipping.dutyQuote.lineAllocations,
      shipping.dutyQuote.dutyAmount,
    )
  )
    return false;
  const quotedLineIds = new Set<string>();
  for (const line of lines) quotedLineIds.add(line.checkoutLineId);
  const packageLineIds = new Set<string>();
  for (const line of shipping.packagePlan.package.lineQuantities)
    packageLineIds.add(line.checkoutLineId);
  if (!sameIds(packageLineIds, quotedLineIds)) return false;
  if (market !== undefined && totals.total.currency !== market.currency)
    return false;
  if (
    !buyerPays(shipping.carrierQuote.shippingAmount, totals.shipping, market) ||
    !buyerPays(shipping.taxQuote.taxAmount, totals.tax, market) ||
    !buyerPays(shipping.dutyQuote.dutyAmount, totals.duty, market)
  )
    return false;
  if (shipping.dutyQuote.incoterm !== shipping.dutyTerms.incoterm) return false;
  return (
    allocationsCover(shipping.carrierQuote.lineAllocations, quotedLineIds) &&
    allocationsCover(shipping.taxQuote.lineAllocations, quotedLineIds) &&
    allocationsCover(shipping.dutyQuote.lineAllocations, quotedLineIds)
  );
}

/**
 * `buyerPaysOfQuote`: the total is the quote's amount, or in a market, the
 * amount converted from the shop currency.
 */
function buyerPays(
  quoted: Money,
  total: Money,
  market: BuyerShippingMarket | undefined,
): boolean {
  if (market === undefined) return sameMoney(quoted, total);
  return (
    quoted.currency === market.shopCurrency &&
    total.currency === market.currency &&
    total.amountMinor ===
      convertMarketAmount(
        quoted.amountMinor,
        market.shopCurrency,
        market.currency,
        market.rate,
        market.roundingIncrement,
      )
  );
}

function shippingQuoteError(): string {
  return "the shipping quote must match its lines, totals and duty terms";
}

type Allocations = readonly Readonly<{
  checkoutLineId: string;
  amount: Money;
}>[];

/** `parseBuyerShippingChargeAllocations`: the component currency and total. */
function allocationsSumTo(allocations: Allocations, total: Money): boolean {
  let allocatedMinor = 0n;
  for (const allocation of allocations) {
    if (allocation.amount.currency !== total.currency) return false;
    allocatedMinor += BigInt(allocation.amount.amountMinor);
  }
  return allocatedMinor === BigInt(total.amountMinor);
}

/** Each allocation names a quoted line, and every quoted line has one. */
function allocationsCover(
  allocations: Allocations,
  quotedLineIds: ReadonlySet<string>,
): boolean {
  const allocationLineIds = new Set<string>();
  for (const allocation of allocations) {
    if (!quotedLineIds.has(allocation.checkoutLineId)) return false;
    allocationLineIds.add(allocation.checkoutLineId);
  }
  return allocationLineIds.size === quotedLineIds.size;
}

function sameIds(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const id of right) if (!left.has(id)) return false;
  return true;
}

function sameMoney(left: Money, right: Money): boolean {
  return (
    left.amountMinor === right.amountMinor && left.currency === right.currency
  );
}

function hasDistinctDisputes(
  disputes: readonly Readonly<{ disputeId: string }>[],
): boolean {
  const disputeIds = new Set<string>();
  for (const dispute of disputes) disputeIds.add(dispute.disputeId);
  return disputeIds.size === disputes.length;
}

function disputesError(): string {
  return "paymentDisputes must have distinct disputeId values";
}

// Parsers of the client API types (Plan 78 step 2).
export const parseCommerceBuyerCatalogV1 = wireRecordParser(
  commerceBuyerCatalogV1Schema,
);
export const parseCommerceBuyerCatalogSearchV1 = wireRecordParser(
  commerceBuyerCatalogSearchV1Schema,
);
export const parseCommerceBuyerCartV1 = wireRecordParser(
  commerceBuyerCartV1Schema,
);
export const parseCommerceBuyerQuotedCheckoutV1 = wireRecordParser(
  commerceBuyerQuotedCheckoutV1Schema,
);
export const parseCommerceBuyerQuotedShippingCheckoutV1 = wireRecordParser(
  commerceBuyerQuotedShippingCheckoutV1Schema,
);
export const parseCommerceDraftInvoiceCheckoutV1 = wireRecordParser(
  commerceDraftInvoiceCheckoutV1Schema,
);
export const parseCommerceOrderBalanceCheckoutV1 = wireRecordParser(
  commerceOrderBalanceCheckoutV1Schema,
);
export const parseCommerceBuyerShippingAddressValidationV1 = wireRecordParser(
  commerceBuyerShippingAddressValidationV1Schema,
);
export const parseCommerceBuyerCheckoutRecoveryV1 = wireRecordParser(
  commerceBuyerCheckoutRecoveryV1Schema,
);
export const parseCommerceBuyerPaymentResultV1 = wireRecordParser(
  commerceBuyerPaymentResultV1Schema,
);
export const parseCommerceBuyerOrderV1 = wireRecordParser(
  commerceBuyerOrderV1Schema,
);
