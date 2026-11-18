import { selectInventoryConsumptionPlan } from "@seams/commerce-contracts";
import {
  convertPrice,
  parseCart,
  parseCheckout,
  parseInventoryAllocation,
  parseInventoryPosition,
  type CreateCommercePickupCheckoutV1,
  type CommerceCheckoutBuyerAuthorityV1,
  type CommerceBuyerPickupCheckoutLineV1,
  type CommerceBuyerQuotedCheckoutLineV1,
  type CommerceBuyerShippingAddressV1,
  type CommerceBuyerShippingCheckoutLineV1,
  type CommerceResourcesV1,
  type CommerceFoodServiceResourcesV1,
  type CommerceInventoryPositionV1,
  type CommerceMarketV1,
  type CommerceMutationErrorV1,
  type CommerceOfferV1,
  type CommerceProtectedBuyerContactV1,
  type CommercePickupCheckoutLineV1,
  type CommercePickupCheckoutSelectionV1,
  type CommerceQuantityV1,
  checkoutOnlineSource,
  pointOfSaleConfigurationIsSellable,
  pointOfSaleQuantityCeiling,
  type CreateCommerceInPersonCheckoutV1,
} from "@seams/commerce-client";
import type {
  PointOfSaleConfiguration,
  Cart,
  Checkout,
  CheckoutProfileConfiguration,
  CheckoutProfileReference,
  CheckoutPluginRun,
  CheckoutQuoteSnapshot,
  CheckoutStoredValueTender,
  ShippingQuoteSnapshot,
  InventoryAllocation,
  InventoryAllocationCommitPoint,
  InventoryConsumptionPlan,
  InventoryRequirement,
  Money,
  ShippingRouteBinding,
  Storefront,
} from "@seams/commerce-contracts";

import {
  checkoutQuoteDigest,
  findResource,
  sha256,
  variantIsSellable,
} from "./checkout-shared.ts";
import type { CommerceDatabase } from "../database.ts";
import {
  readCheckout,
  readConsumptionPlan,
  listConsumptionPlansForVariant,
} from "../checkout-persistence.ts";
import { readInventoryPositionForItemLocation } from "../inventory-persistence.ts";
import {
  readShippingProfile as readCatalogShippingProfile,
  readVariantShippingSpecification as readCatalogVariantShippingSpecification,
} from "./catalog.ts";
import type { FoodServiceMenus } from "../plugins/built-in-ports.ts";
import type {
  RegionalShipping,
  ShippingQuoteLine,
  ShippingQuoteRequest,
  ShippingQuoteResult,
} from "../regional-shipping.ts";
import { quoteShippingWithAttempt } from "../shipping-quote-attempt.ts";
import {
  readUsableInventoryQuantity,
  scaledAmount,
  wholeAmountAtScale,
} from "./inventory-planning.ts";
import {
  checkoutProfileAcceptsCurrency,
  resolveCheckoutProfileForQuote,
} from "../checkout-profile-resolution.ts";
import { marketUnitPrice, readMarket } from "../plugins/markets/index.ts";
import type { CheckoutDiscountRequest, DiscountHold } from "../plugins/discounts/index.ts";
import type { CheckoutStoredValueRequest } from "../plugins/stored-value/index.ts";
import type { PluginFunctionFailure } from "../plugins/merchant-plugins.ts";
import {
  deliveryHookStage,
  discountHookStage,
  companyPriceStage,
  discountStage,
  linesHookStage,
  tendersHookStage,
  storedValueStage,
  validationStage,
} from "./checkout-pipeline.ts";
import { pluginActive } from "../plugins/plugin-state.ts";
import { MERCHANT_TAX_AUTHORITY_REFERENCE } from "../checkout-charge-provider.ts";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

export type BuyerPickupCheckoutCommand = Readonly<{
  schemaVersion: "underclerk.submit-buyer-pickup-cart.v1";
  merchantId: string;
  expectedMerchantRevision: number;
  idempotencyKey: string;
  requestedAt: string;
  storefrontId: string;
  storefrontRevision: number;
  checkoutProfile: CheckoutProfileReference;
  buyerSessionDigest: string;
  buyerAuthority: CommerceCheckoutBuyerAuthorityV1;
  cartId: string;
  cartRevision: number;
  checkoutId: string;
  lines: readonly CommercePickupCheckoutLineV1[];
  /** Staff prices from a draft order, keyed by catalog variant. */
  priceOverrides?: readonly DraftPriceOverride[];
  /** The buyer's discount codes and customer, for the discount evaluator. */
  discount?: CheckoutDiscountRequest;
  /** The buyer's market; prices and the quote are in its currency. */
  marketId?: string;
  /** Gift cards and store credit that pay after tax. */
  storedValue?: CheckoutStoredValueRequest;
  /** The pickup time the buyer chose; the lead time applies without one. */
  pickupAt?: string;
}>;

/** The furthest ahead that a buyer can choose a pickup time. */
const PICKUP_AHEAD_LIMIT_MS = 60 * 24 * 60 * 60 * 1_000;

export type DraftPriceOverride = Readonly<{
  variantId: string;
  unitPrice: Money;
  reason: string;
}>;

export type BuyerShippingCheckoutCommand = Readonly<{
  schemaVersion: "underclerk.create-buyer-shipping-checkout.internal.v1";
  merchantId: string;
  expectedMerchantRevision: number;
  idempotencyKey: string;
  requestedAt: string;
  storefrontId: string;
  storefrontRevision: number;
  checkoutProfile: CheckoutProfileReference;
  buyerSessionDigest: string;
  buyerAuthority: CommerceCheckoutBuyerAuthorityV1;
  cartId: string;
  cartRevision: number;
  checkoutId: string;
  lines: readonly Readonly<{
    cartLineId: string;
    checkoutLineId: string;
    variantId: string;
    quantity: number;
  }>[];
  shippingServiceCode: string;
  shippingDestination: BuyerShippingDestinationAuthority;
  /** The buyer's discount codes and customer, for the discount evaluator. */
  discount?: CheckoutDiscountRequest;
  /** Gift cards and store credit that pay after tax, duty and shipping. */
  storedValue?: CheckoutStoredValueRequest;
  /** The buyer's market, which must have a converted rate. */
  marketId?: string;
}>;

export type BuyerShippingDestinationAuthority =
  | Readonly<{
      kind: "provided_address";
      address: CommerceBuyerShippingAddressV1;
      addressValidationReference: string;
      savedAddressReference?: never;
    }>
  | Readonly<{
      kind: "saved_address";
      savedAddressReference: string;
      address: CommerceBuyerShippingAddressV1;
      addressValidationReference: string;
    }>;

export type CheckoutPlanContext = Readonly<{
  checkoutRevision: number;
  cartRevision: number;
  positions: Map<string, CommerceInventoryPositionV1>;
}>;

type PickupCheckoutPlanningCommand =
  CreateCommercePickupCheckoutV1 | BuyerPickupCheckoutCommand;

export type PickupCheckoutPlan = Readonly<{
  cart: Cart;
  checkout: Checkout;
  /** The holds of this quote: new ones, and on a refresh the kept ones. */
  allocations: readonly InventoryAllocation[];
  /** The holds of the lines that a refresh dropped. */
  releasedAllocations?: readonly InventoryAllocation[];
  positions: readonly CommerceInventoryPositionV1[];
  /** Discount uses this checkout holds until it is paid or expires. */
  discountHolds?: Readonly<{
    holds: readonly DiscountHold[];
    customerId: string | null;
    expiresAt: string;
  }>;
  /** Stored value this checkout holds until it is paid or expires. */
  storedValueHolds?: readonly CheckoutStoredValueTender[];
  /** Merchant plugin functions that failed and were skipped. */
  pluginFailures?: readonly PluginFunctionFailure[];
}>;

export type InPersonCheckoutPlan = Readonly<{
  checkout: Checkout;
  allocations: readonly InventoryAllocation[];
  positions: readonly CommerceInventoryPositionV1[];
  /** Discount uses this checkout holds until it is paid or expires. */
  discountHolds?: PickupCheckoutPlan["discountHolds"];
  /** Merchant plugin functions that failed and were skipped. */
  pluginFailures?: readonly PluginFunctionFailure[];
}>;

type InPersonCheckoutPlanResult =
  | Readonly<{ kind: "planned"; value: InPersonCheckoutPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

type PickupCheckoutPlanResult =
  | Readonly<{ kind: "planned"; value: PickupCheckoutPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

type ShippingLinePlan = Readonly<{
  command: BuyerShippingCheckoutCommand["lines"][number];
  source: Variant<CheckoutQuoteSnapshot["lines"][number]["source"], "catalog">;
  requirements: readonly InventoryRequirement[];
  consumeOn: InventoryAllocationCommitPoint;
  unitPrice: Money;
  lineTotal: Money;
  title: string;
  quoteLine: ShippingQuoteLine;
}>;

/**
 * A shipping quote's lines and totals as the buyer pays them: unchanged with
 * no market, or each unit price, discount, tax, duty and shipping amount
 * converted on its own at the market's rate, with the line totals and the
 * totals summed from the converted amounts. Undefined when a converted
 * discount is more than its line.
 */
function marketShippingQuote(
  market: CommerceMarketV1 | undefined,
  lines: readonly CheckoutQuoteSnapshot["lines"][number][],
  shippingQuote: ShippingQuoteSnapshot,
  shopCurrency: string,
):
  | Readonly<{
      lines: readonly CheckoutQuoteSnapshot["lines"][number][];
      totals: CheckoutQuoteSnapshot["totals"];
    }>
  | undefined {
  const tax = shippingQuote.taxQuote.taxAmount;
  const duty = shippingQuote.dutyQuote.dutyAmount;
  const shipping = shippingQuote.carrierRate.shippingAmount;
  const pricing = market?.pricing;
  const toPaid = (money: Money): Money =>
    market === undefined || pricing?.kind !== "converted"
      ? money
      : {
          amountMinor: convertPrice(
            money.amountMinor,
            shopCurrency,
            market.currency,
            pricing.rate.value,
            pricing.roundingIncrement,
          ),
          currency: market.currency,
        };
  const paidLines: CheckoutQuoteSnapshot["lines"][number][] = [];
  for (const line of lines) {
    if (market === undefined) {
      paidLines.push(line);
      continue;
    }
    const unitPrice = toPaid(line.unitPrice);
    const discount =
      line.discount === undefined ? undefined : toPaid(line.discount);
    const lineMinor =
      unitPrice.amountMinor * line.quantity.amount -
      (discount?.amountMinor ?? 0);
    if (!Number.isSafeInteger(lineMinor) || lineMinor < 0) return undefined;
    paidLines.push({
      ...line,
      unitPrice,
      lineTotal: { amountMinor: lineMinor, currency: unitPrice.currency },
      ...(discount === undefined ? {} : { discount }),
    });
  }
  const currency = market?.currency ?? shopCurrency;
  const subtotalMinor = paidLines.reduce(
    (sum, line) => sum + line.lineTotal.amountMinor,
    0,
  );
  const discountMinor = paidLines.reduce(
    (sum, line) => sum + (line.discount?.amountMinor ?? 0),
    0,
  );
  const paidTax = toPaid(tax);
  const paidDuty = toPaid(duty);
  const paidShipping = toPaid(shipping);
  const totalMinor = checkoutTotal(
    subtotalMinor,
    paidTax.amountMinor,
    paidDuty.amountMinor,
    paidShipping.amountMinor,
  );
  if (totalMinor === undefined) return undefined;
  return {
    lines: paidLines,
    totals: {
      subtotal: { amountMinor: subtotalMinor, currency },
      tax: paidTax,
      duty: paidDuty,
      shipping: paidShipping,
      total: { amountMinor: totalMinor, currency },
      ...(discountMinor === 0
        ? {}
        : { discount: { amountMinor: discountMinor, currency } }),
    },
  };
}

export function initialCheckoutPlanContext(): CheckoutPlanContext {
  return {
    checkoutRevision: 1,
    cartRevision: 2,
    positions: new Map<string, CommerceInventoryPositionV1>(),
  };
}

export function cartSubmissionCheckoutPlanContext(
  cartRevision: number,
): CheckoutPlanContext {
  if (
    !Number.isSafeInteger(cartRevision) ||
    cartRevision < 1 ||
    cartRevision === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("cartRevision must be a positive integer");
  }
  return {
    checkoutRevision: 1,
    cartRevision: cartRevision + 1,
    positions: new Map<string, CommerceInventoryPositionV1>(),
  };
}

export function planShippingCheckout(
  database: CommerceDatabase,
  shipping: RegionalShipping | undefined,
  command: BuyerShippingCheckoutCommand,
  storefront: Storefront,
  resources: CommerceResourcesV1,
  context: CheckoutPlanContext,
): PickupCheckoutPlanResult {
  if (storefront.fulfillment.kind !== "shipping") {
    return checkoutPlanRejected("storefront.fulfillment");
  }
  const checkoutProfile = resolveCheckoutProfileForQuote({
    database,
    merchantId: command.merchantId,
    reference: command.checkoutProfile,
    storefront,
    fulfillment: "shipping",
    lineQuantities: command.lines.map(shippingLineQuantity),
    buyerSessionDigest: command.buyerSessionDigest,
    buyerAuthority: command.buyerAuthority,
    destinationAuthority: command.shippingDestination.kind,
  });
  if (checkoutProfile.kind === "rejected") return checkoutProfile;
  const buyerContact = checkoutBuyerContact(
    database,
    command.merchantId,
    command.buyerAuthority,
  );
  if (buyerContact === undefined)
    return checkoutPlanRejected("checkout.buyerContact");
  // A market sells at its converted rate. The carrier, tax and duty quote
  // in the shop currency, so a market with a price list has no rate for
  // them and cannot sell here.
  const market =
    command.marketId === undefined
      ? undefined
      : readMarket(database, command.merchantId, command.marketId);
  if (
    command.marketId !== undefined &&
    (market === undefined ||
      market.status !== "active" ||
      !market.storefrontIds.includes(command.storefrontId) ||
      market.pricing.kind !== "converted" ||
      !pluginActive(database, command.merchantId, "markets"))
  )
    return checkoutPlanRejected("checkout.market");
  const taxCalculation = shippingTaxCalculation(
    storefront,
    checkoutProfile.profile.configuration.taxPolicy,
  );
  if (taxCalculation === undefined) {
    return checkoutPlanRejected("checkoutProfile.taxPolicy");
  }
  const profile = readCatalogShippingProfile(
    database,
    command.merchantId,
    storefront.fulfillment.shippingProfileId,
  );
  if (
    profile?.lifecycle.state !== "active" ||
    profile.originLocationId !== storefront.fulfillment.originLocationId
  ) {
    return checkoutPlanRejected("checkout.shippingEligibility");
  }
  const routeBinding = shipping?.routeFor(
    profile.routes,
    command.shippingDestination.address.countryCode,
  );
  if (shipping === undefined || routeBinding === undefined) {
    return checkoutPlanRejected("checkout.shippingRoute");
  }
  const plannedLines: ShippingLinePlan[] = [];
  let currency: string | undefined;
  let subtotal = 0;
  for (const line of command.lines) {
    const planned = planShippingLine({
      database,
      command,
      line,
      storefront,
      resources,
      profile,
    });
    if (planned.kind === "rejected") return planned;
    if (
      !checkoutProfileAcceptsCurrency(
        checkoutProfile.profile.configuration,
        planned.value.unitPrice.currency,
      )
    ) {
      return checkoutPlanRejected("checkoutProfile.currencyPolicy");
    }
    if (
      currency !== undefined &&
      currency !== planned.value.unitPrice.currency
    ) {
      return checkoutPlanRejected("checkout.currency");
    }
    currency = planned.value.unitPrice.currency;
    const nextSubtotal = safeAdd(subtotal, planned.value.lineTotal.amountMinor);
    if (nextSubtotal === undefined)
      return checkoutPlanRejected("checkout.subtotal");
    subtotal = nextSubtotal;
    plannedLines.push(planned.value);
  }
  if (currency === undefined) return checkoutPlanRejected("checkout.currency");
  const quoteCurrency = currency;
  const hookRuns: CheckoutPluginRun[] = [];
  const hookFailures: PluginFunctionFailure[] = [];
  const hookQuote = (
    lines: readonly CheckoutQuoteSnapshot["lines"][number][],
  ) => ({
    checkoutId: command.checkoutId,
    kind: "shipping" as const,
    quotedAt: command.requestedAt,
    currency: quoteCurrency,
    lines,
    variants: resources.variants,
  });
  const asQuoteLine = (
    planned: ShippingLinePlan,
  ): CheckoutQuoteSnapshot["lines"][number] => ({
    checkoutLineId: planned.command.checkoutLineId,
    source: planned.source,
    quantity: { amount: planned.command.quantity, scale: 0, unit: "each" },
    unitPrice: planned.unitPrice,
    lineTotal: planned.lineTotal,
    allocationIds: [],
    title: planned.title,
  });
  const priced = linesHookStage(
    database,
    command.merchantId,
    hookQuote(
      companyPriceStage(database, command.merchantId, {
        // A market checkout keeps the market's prices, as at pickup.
        customerId:
          command.marketId === undefined
            ? (command.discount?.customerId ?? null)
            : null,
        currency: quoteCurrency,
        lines: plannedLines.map(asQuoteLine),
      }),
    ),
  );
  if (priced.kind === "refused")
    return { kind: "rejected", error: priced.error };
  hookRuns.push(...priced.runs);
  hookFailures.push(...priced.failures);
  const pricedLines = plannedLines.map((planned, index) => {
    const line = priced.value[index];
    return line === undefined ||
      line.unitPrice.amountMinor === planned.unitPrice.amountMinor
      ? planned
      : {
          ...planned,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
          quoteLine: { ...planned.quoteLine, itemSubtotal: line.lineTotal },
        };
  });
  subtotal = pricedLines.reduce(
    (sum, planned) => sum + planned.lineTotal.amountMinor,
    0,
  );
  // Discounts come off the lines before the shipping quote, so tax and duty
  // are on what is paid.
  const discounted = discountStage(database, command.merchantId, {
    checkoutId: command.checkoutId,
    request: command.discount,
    at: command.requestedAt,
    currency,
    lines: pricedLines.map(asQuoteLine),
    variants: resources.variants,
  });
  if (discounted.kind === "rejected")
    return checkoutPlanRejected(discounted.field);
  const pluginDiscount = discountHookStage(
    database,
    command.merchantId,
    hookQuote(discounted.value.lines),
  );
  if (pluginDiscount.kind === "refused")
    return { kind: "rejected", error: pluginDiscount.error };
  hookRuns.push(...pluginDiscount.runs);
  hookFailures.push(...pluginDiscount.failures);
  const discountTotal =
    discounted.value.discountTotal + pluginDiscount.value.discountTotal;
  const discountedLines = pricedLines.map((planned, index) => {
    const line = pluginDiscount.value.lines[index];
    if (line === undefined) throw new Error("A discounted line is missing");
    return line.discount === undefined
      ? planned
      : {
          ...planned,
          lineTotal: line.lineTotal,
          quoteLine: { ...planned.quoteLine, itemSubtotal: line.lineTotal },
        };
  });
  subtotal -= discountTotal;
  const quoteResult = quoteShippingCheckout(
    database,
    shipping,
    command,
    context.checkoutRevision,
    discountedLines,
    routeBinding,
    taxCalculation,
    storefront.checkout.quoteTtlSeconds,
  );
  if (quoteResult.kind !== "quoted") {
    return checkoutPlanRejected(quoteResult.field);
  }
  const shippingQuote = quoteResult.quote;
  if (
    shippingQuote.itemSubtotal.amountMinor !== subtotal ||
    shippingQuote.itemSubtotal.currency !== currency
  ) {
    return checkoutPlanRejected("checkout.total");
  }
  const total = checkoutTotal(
    subtotal,
    shippingQuote.taxQuote.taxAmount.amountMinor,
    shippingQuote.dutyQuote.dutyAmount.amountMinor,
    shippingQuote.carrierRate.shippingAmount.amountMinor,
  );
  if (total === undefined || shippingQuote.total.amountMinor !== total) {
    return checkoutPlanRejected("checkout.total");
  }
  // The buyer pays in the market's currency: each price, discount and
  // charge converted on its own, and the totals summed from them. Plugins
  // and the shipping quote keep the shop currency.
  const paid = marketShippingQuote(
    market,
    pluginDiscount.value.lines,
    shippingQuote,
    currency,
  );
  if (paid === undefined) return checkoutPlanRejected("checkout.market.price");
  const delivery = deliveryHookStage(
    database,
    command.merchantId,
    hookQuote(pluginDiscount.value.lines),
    total,
    {
      kind: "shipping",
      serviceCode: command.shippingServiceCode,
      shippingMinor: shippingQuote.carrierRate.shippingAmount.amountMinor,
      latestDeliveryAt:
        shippingQuote.estimatedDelivery.kind === "window"
          ? shippingQuote.estimatedDelivery.latest
          : null,
    },
  );
  if (delivery.kind === "refused")
    return { kind: "rejected", error: delivery.error };
  hookRuns.push(...delivery.runs);
  hookFailures.push(...delivery.failures);
  const tenders = tendersHookStage(
    database,
    command.merchantId,
    hookQuote(pluginDiscount.value.lines),
    total,
    command.storedValue,
  );
  if (tenders.kind === "refused")
    return { kind: "rejected", error: tenders.error };
  hookRuns.push(...tenders.runs);
  hookFailures.push(...tenders.failures);
  const storedValue = storedValueStage(database, command.merchantId, {
    checkoutId: command.checkoutId,
    request: command.storedValue,
    at: command.requestedAt,
    total: paid.totals.total,
  });
  if (storedValue.kind === "rejected")
    return checkoutPlanRejected(storedValue.field);
  const validated = validationStage(database, command.merchantId, {
    checkoutId: command.checkoutId,
    kind: "shipping",
    quotedAt: command.requestedAt,
    currency,
    readyBy:
      shippingQuote.estimatedDelivery.kind === "window"
        ? shippingQuote.estimatedDelivery.latest
        : shippingQuote.expiresAt,
    lines: pluginDiscount.value.lines,
    variants: resources.variants,
    subtotalMinor: subtotal,
    totalMinor: total,
    customerId: discounted.value.customerId,
  });
  if (validated.kind === "refused")
    return { kind: "rejected", error: validated.error };
  const pluginRuns = [...hookRuns, ...validated.runs];
  const pluginFailures = [...hookFailures, ...validated.failures];
  const allocations: InventoryAllocation[] = [];
  const checkoutLines: CheckoutQuoteSnapshot["lines"] = [];
  const nextPositions = context.positions;
  for (const [index, planned] of plannedLines.entries()) {
    const allocationIds: string[] = [];
    for (const requirement of planned.requirements) {
      const allocation = allocateCheckoutRequirement(
        database,
        command,
        planned.command.checkoutLineId,
        planned.command.quantity,
        requirement,
        storefront.fulfillment.originLocationId,
        nextPositions,
        shippingQuote.expiresAt,
        planned.consumeOn,
      );
      if (allocation.kind === "rejected") return allocation;
      allocations.push(allocation.allocation);
      allocationIds.push(allocation.allocation.allocationId);
    }
    const line = paid.lines[index];
    if (line === undefined) throw new Error("A discounted line is missing");
    checkoutLines.push({ ...line, allocationIds });
  }
  const quoteBase: Omit<CheckoutQuoteSnapshot, "quoteDigest"> = {
    checkoutRevision: context.checkoutRevision,
    lines: checkoutLines,
    totals: paid.totals,
    fulfillment: { kind: "shipping", quote: shippingQuote },
    quotedAt: command.requestedAt,
    expiresAt: shippingQuote.expiresAt,
    ...(market === undefined || market.pricing.kind !== "converted"
      ? {}
      : {
          market: {
            marketId: market.id,
            marketRevision: market.revision,
            shopCurrency: currency,
            rate: market.pricing.rate.value,
            shopSubtotal: {
              amountMinor: pricedLines.reduce(
                (sum, planned) => sum + planned.lineTotal.amountMinor,
                0,
              ),
              currency,
            },
            roundingIncrement: market.pricing.roundingIncrement,
          },
        }),
    ...(storedValue.value.quote === undefined
      ? {}
      : { storedValue: storedValue.value.quote }),
    ...(pluginRuns.length === 0 ? {} : { pluginRuns }),
  };
  const quote = buildCheckoutQuote(quoteBase);
  const checkout = parseCheckout({
    checkoutId: command.checkoutId,
    source: {
      kind: "online",
      storefrontId: command.storefrontId,
      cartId: command.cartId,
      buyerSessionDigest: command.buyerSessionDigest,
      buyerContact,
      checkoutProfile: command.checkoutProfile,
    },
    revision: context.checkoutRevision,
    lifecycle: {
      state: "quoted",
      quote,
    },
  });
  const cart = parseCart({
    cartId: command.cartId,
    storefrontId: command.storefrontId,
    checkoutProfile: command.checkoutProfile,
    buyerSessionDigest: command.buyerSessionDigest,
    revision: context.cartRevision,
    lines: command.lines.map(shippingCartLine),
    lifecycle: {
      state: "submitted",
      checkoutId: command.checkoutId,
      submittedAt: command.requestedAt,
    },
  });
  return {
    kind: "planned",
    value: {
      ...(pluginFailures.length === 0 ? {} : { pluginFailures }),
      cart,
      checkout,
      allocations,
      positions: [...nextPositions.values()],
      // Always written, so that a refresh drops the holds it no longer uses.
      discountHolds: {
        holds: discounted.value.holds,
        customerId: discounted.value.customerId,
        expiresAt: shippingQuote.expiresAt,
      },
      storedValueHolds: storedValue.value.tenders,
    },
  };
}

function planShippingLine(
  input: Readonly<{
    database: CommerceDatabase;
    command: BuyerShippingCheckoutCommand;
    line: BuyerShippingCheckoutCommand["lines"][number];
    storefront: Storefront;
    resources: CommerceResourcesV1;
    profile: NonNullable<ReturnType<typeof readCatalogShippingProfile>>;
  }>,
):
  | Readonly<{ kind: "planned"; value: ShippingLinePlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }> {
  if (input.storefront.fulfillment.kind !== "shipping") {
    return checkoutPlanRejected("storefront.fulfillment");
  }
  const variant = findResource(input.resources.variants, input.line.variantId);
  if (variant === undefined) return checkoutPlanRejected("checkout.variant");
  const offer = resolveCheckoutOffer(
    input.resources,
    input.storefront.salesChannelId,
    variant.id,
  );
  if (offer === undefined || offer.availability.state !== "available") {
    return checkoutPlanRejected("checkout.offer");
  }
  const specification = readCatalogVariantShippingSpecification(
    input.database,
    input.command.merchantId,
    variant.id,
    variant.revision,
  );
  if (
    specification?.shippingProfileId !== input.profile.shippingProfileId ||
    specification.shippingProfileRevision !== input.profile.revision ||
    specification.eligibility.kind !== "physical"
  ) {
    return checkoutPlanRejected("checkout.shippingEligibility");
  }
  const consumptionPlan = resolveCheckoutConsumptionPlan(
    input.database,
    input.command.merchantId,
    variant.id,
    input.storefront.fulfillment.originLocationId,
  );
  if (
    consumptionPlan?.mode.kind !== "direct" ||
    consumptionPlan.mode.commitOn !== "fulfillment_completed"
  ) {
    return checkoutPlanRejected("checkout.consumptionPlan");
  }
  const lineTotalMinor = safeMultiply(
    offer.price.amountMinor,
    input.line.quantity,
  );
  if (lineTotalMinor === undefined)
    return checkoutPlanRejected("checkout.lineTotal");
  const lineTotal = {
    amountMinor: lineTotalMinor,
    currency: offer.price.currency,
  };
  return {
    kind: "planned",
    value: {
      command: input.line,
      source: {
        kind: "catalog",
        variantId: variant.id,
        variantRevision: variant.revision,
        merchantCode: variant.sku,
        optionValues: [...variant.options],
        offerId: offer.id,
        offerRevision: offer.revision,
        consumptionPlanId: consumptionPlan.consumptionPlanId,
        consumptionPlanRevision: consumptionPlan.revision,
        inventory:
          consumptionPlan.mode.components.length === 0
            ? { kind: "untracked" }
            : {
                kind: "requirements",
                items: [...consumptionPlan.mode.components],
              },
      },
      requirements: consumptionPlan.mode.components,
      consumeOn: consumptionPlan.mode.commitOn,
      unitPrice: offer.price,
      lineTotal,
      title: variant.title,
      quoteLine: {
        checkoutLineId: input.line.checkoutLineId,
        quantity: input.line.quantity,
        itemSubtotal: lineTotal,
        inputIdentity: {
          storefrontId: input.storefront.storefrontId,
          storefrontRevision: input.storefront.revision,
          variantId: variant.id,
          variantRevision: variant.revision,
          offerId: offer.id,
          offerRevision: offer.revision,
          shippingProfileId: input.profile.shippingProfileId,
          shippingProfileRevision: input.profile.revision,
          consumptionPlanId: consumptionPlan.consumptionPlanId,
          consumptionPlanRevision: consumptionPlan.revision,
        },
        specification: specification.eligibility,
      },
    },
  };
}

function shippingLineQuantity(
  line: BuyerShippingCheckoutCommand["lines"][number],
): number {
  return line.quantity;
}

function shippingQuoteLine(line: ShippingLinePlan): ShippingQuoteLine {
  return line.quoteLine;
}

function quoteShippingCheckout(
  database: CommerceDatabase,
  shipping: RegionalShipping,
  command: BuyerShippingCheckoutCommand,
  checkoutRevision: number,
  lines: readonly ShippingLinePlan[],
  routeBinding: ShippingRouteBinding,
  taxCalculation: ShippingQuoteRequest["taxCalculation"],
  quoteTtlSeconds: number,
): ShippingQuoteResult {
  const destination = command.shippingDestination;
  return quoteShippingWithAttempt({
    database,
    shipping,
    merchantId: command.merchantId,
    storefrontId: command.storefrontId,
    checkoutId: command.checkoutId,
    checkoutRevision,
    buyerSessionDigest: command.buyerSessionDigest,
    idempotencyKey: `${command.idempotencyKey}:shipping_quote`,
    request: {
      routeBinding,
      serviceCode: command.shippingServiceCode,
      shippingQuoteId: `shipping_quote_${sha256(`${command.checkoutId}:shipping`)}`,
      packageId: `package_${sha256(`${command.checkoutId}:package`)}`,
      taxCalculation,
      lines: lines.map(shippingQuoteLine),
      addressAuthority:
        destination.kind === "saved_address"
          ? {
              kind: "saved_address",
              address: destination.address,
              protectedAddressReference: destination.savedAddressReference,
              addressValidationReference:
                destination.addressValidationReference,
            }
          : {
              kind: "provided_address",
              address: destination.address,
              addressValidationReference:
                destination.addressValidationReference,
            },
      quotedAt: command.requestedAt,
      quoteTtlSeconds,
    },
  });
}

function shippingTaxCalculation(
  storefront: Storefront,
  policy: CheckoutProfileConfiguration["taxPolicy"],
): ShippingQuoteRequest["taxCalculation"] | undefined {
  switch (storefront.checkout.tax.kind) {
    case "percentage":
      return policy.kind === "merchant_inclusive"
        ? {
            kind: "merchant_percentage",
            providerAccountReference: MERCHANT_TAX_AUTHORITY_REFERENCE,
            jurisdictionPolicyReference: policy.jurisdictionPolicyId,
            basisPoints: storefront.checkout.tax.basisPoints,
          }
        : undefined;
    case "provider_quoted":
      return policy.kind === "provider_quoted" &&
        policy.taxCapabilityId ===
          storefront.checkout.tax.providerAccountReference
        ? {
            kind: "provider_quoted",
            providerAccountReference:
              storefront.checkout.tax.providerAccountReference,
            registrationPolicyReference: policy.registrationPolicyId,
          }
        : undefined;
    default:
      return assertNever(
        storefront.checkout.tax,
        "Unsupported checkout planning branch",
      );
  }
}

function shippingCartLine(
  line: BuyerShippingCheckoutCommand["lines"][number],
): Cart["lines"][number] {
  return {
    cartLineId: line.cartLineId,
    source: { kind: "catalog", variantId: line.variantId },
    quantity: { amount: line.quantity, scale: 0, unit: "each" },
  };
}

/**
 * Plan a Checkout rung up at a terminal.
 *
 * There is no cart and no buyer session: the operator submits the basket in one
 * command. Pricing, tax, and inventory come from the same shared core the
 * online pickup path uses, so the two channels cannot drift.
 */
export function planInPersonCheckout(
  database: CommerceDatabase,
  command: CreateCommerceInPersonCheckoutV1,
  configuration: PointOfSaleConfiguration,
  resources: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
  menus: FoodServiceMenus | undefined,
  context: CheckoutPlanContext,
): InPersonCheckoutPlanResult {
  if (!pointOfSaleConfigurationIsSellable(configuration)) {
    return checkoutPlanRejected("pointOfSaleConfiguration.lifecycle");
  }
  if (configuration.revision !== command.posConfigurationRevision) {
    return checkoutPlanRejected("pointOfSaleConfiguration.revision");
  }
  if (configuration.satyrLocationId !== command.satyrLocationId) {
    return checkoutPlanRejected("pointOfSaleConfiguration.satyrLocationId");
  }
  // Provider-quoted tax has no local rate to apply at a counter.
  const tax = configuration.tax;
  if (tax.kind !== "percentage") {
    return checkoutPlanRejected("pointOfSaleConfiguration.tax");
  }
  const planned = planPointOfSaleQuote(
    database,
    command,
    { ...configuration, tax },
    resources,
    foodService,
    menus,
    context,
  );
  if (planned.kind === "rejected") return planned;
  return {
    kind: "planned",
    value: {
      checkout: parseCheckout({
        checkoutId: command.checkoutId,
        source: {
          kind: "point_of_sale",
          satyrLocationId: command.satyrLocationId,
          posConfigurationRevision: configuration.revision,
          operatorIdentity: command.operatorIdentity,
          terminalAssignmentRevision: command.terminalAssignmentRevision,
          buyer: command.buyer,
        },
        revision: context.checkoutRevision,
        lifecycle: { state: "quoted", quote: planned.quote },
      }),
      allocations: planned.allocations,
      positions: planned.positions,
      ...(planned.discountHolds.holds.length === 0
        ? {}
        : { discountHolds: planned.discountHolds }),
      ...(planned.pluginFailures.length === 0
        ? {}
        : { pluginFailures: planned.pluginFailures }),
    },
  };
}

/**
 * Price a counter basket against the counter's own published policy.
 *
 * Structurally this mirrors the online pickup quote, but every policy value —
 * currency, tax, quote lifetime, pickup lead time, and which items may be sold
 * at all — comes from the POS configuration rather than a storefront.
 */
function planPointOfSaleQuote(
  database: CommerceDatabase,
  command: CreateCommerceInPersonCheckoutV1,
  configuration: PointOfSaleConfiguration &
    Readonly<{
      tax: Variant<PointOfSaleConfiguration["tax"], "percentage">;
    }>,
  resources: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
  menus: FoodServiceMenus | undefined,
  context: CheckoutPlanContext,
):
  | Readonly<{
      kind: "planned";
      quote: CheckoutQuoteSnapshot;
      allocations: readonly InventoryAllocation[];
      positions: readonly CommerceInventoryPositionV1[];
      discountHolds: NonNullable<PickupCheckoutPlan["discountHolds"]>;
      pluginFailures: readonly PluginFunctionFailure[];
    }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }> {
  const allocationLocationId = configuration.satyrLocationId;
  const allocations: InventoryAllocation[] = [];
  const checkoutLines: CheckoutQuoteSnapshot["lines"] = [];
  const nextPositions = context.positions;
  const expiresAt = timestampAfterSeconds(
    command.requestedAt,
    configuration.quoteTtlSeconds,
  );
  if (expiresAt === undefined) return checkoutPlanRejected("checkout.policy");
  let subtotal = 0;
  for (const line of command.lines) {
    // The counter sells only what its published policy lists, up to the
    // published per-line ceiling.
    if (line.source.kind !== "catalog") {
      return checkoutPlanRejected("pointOfSaleConfiguration.supportedItems");
    }
    const ceiling = pointOfSaleQuantityCeiling(
      configuration,
      line.source.variantId,
    );
    if (
      ceiling === undefined ||
      line.quantity.amount <= 0 ||
      line.quantity.amount > ceiling
    ) {
      return checkoutPlanRejected("pointOfSaleConfiguration.supportedItems");
    }
    const selection = resolveCheckoutSelection(
      database,
      command.merchantId,
      line.source,
      foodService,
      resources,
      configuration.salesChannelId,
      allocationLocationId,
      command.requestedAt,
      menus,
    );
    if (selection.kind === "rejected") return selection;
    const { variant, offer, source, requirements, consumeOn } =
      selection.value;
    if (offer.price.currency !== configuration.currency) {
      return checkoutPlanRejected("pointOfSaleConfiguration.currency");
    }
    const lineTotal = safeMultiply(
      offer.price.amountMinor,
      line.quantity.amount,
    );
    if (lineTotal === undefined)
      return checkoutPlanRejected("checkout.lineTotal");
    const nextSubtotal = safeAdd(subtotal, lineTotal);
    if (nextSubtotal === undefined)
      return checkoutPlanRejected("checkout.subtotal");
    subtotal = nextSubtotal;
    const allocationIds: string[] = [];
    for (const requirement of requirements) {
      const positionResult = allocateCheckoutRequirement(
        database,
        command,
        line.checkoutLineId,
        line.quantity.amount,
        requirement,
        allocationLocationId,
        nextPositions,
        expiresAt,
        consumeOn,
      );
      if (positionResult.kind === "rejected") return positionResult;
      allocations.push(positionResult.allocation);
      allocationIds.push(positionResult.allocation.allocationId);
    }
    checkoutLines.push({
      checkoutLineId: line.checkoutLineId,
      source,
      quantity: line.quantity,
      unitPrice: offer.price,
      lineTotal: { amountMinor: lineTotal, currency: offer.price.currency },
      allocationIds,
      title: variant.title,
    });
  }
  const currency = configuration.currency;
  // The counter runs the same stages as an online pickup (Plan 77 step 2):
  // plugin prices, discounts, tax on what is paid, the delivery hook and
  // the checkout rules. A basket with no codes and no plugins quotes as
  // before.
  const hookRuns: CheckoutPluginRun[] = [];
  const hookFailures: PluginFunctionFailure[] = [];
  const hookQuote = (
    lines: readonly CheckoutQuoteSnapshot["lines"][number][],
  ) => ({
    checkoutId: command.checkoutId,
    kind: "pickup" as const,
    quotedAt: command.requestedAt,
    currency,
    lines,
    variants: resources.variants,
  });
  const priced = linesHookStage(
    database,
    command.merchantId,
    hookQuote(checkoutLines),
  );
  if (priced.kind === "refused")
    return { kind: "rejected", error: priced.error };
  hookRuns.push(...priced.runs);
  hookFailures.push(...priced.failures);
  subtotal = priced.value.reduce(
    (sum, line) => sum + line.lineTotal.amountMinor,
    0,
  );
  const discounted = discountStage(database, command.merchantId, {
    checkoutId: command.checkoutId,
    request: {
      codes: command.discountCodes ?? [],
      customerId:
        command.buyer.kind === "identified_customer"
          ? command.buyer.customerId
          : null,
    },
    at: command.requestedAt,
    currency,
    lines: priced.value,
    variants: resources.variants,
  });
  if (discounted.kind === "rejected")
    return checkoutPlanRejected(discounted.field);
  const pluginDiscount = discountHookStage(
    database,
    command.merchantId,
    hookQuote(discounted.value.lines),
  );
  if (pluginDiscount.kind === "refused")
    return { kind: "rejected", error: pluginDiscount.error };
  hookRuns.push(...pluginDiscount.runs);
  hookFailures.push(...pluginDiscount.failures);
  const discountTotal =
    discounted.value.discountTotal + pluginDiscount.value.discountTotal;
  const discountedLines = [...pluginDiscount.value.lines];
  subtotal -= discountTotal;
  const taxAmount = percentageOfMinorUnits(
    subtotal,
    configuration.tax.basisPoints,
  );
  if (taxAmount === undefined) return checkoutPlanRejected("checkout.tax");
  const total = safeAdd(subtotal, taxAmount);
  if (total === undefined) return checkoutPlanRejected("checkout.total");
  const proposedReadyAt = timestampAfterSeconds(
    command.requestedAt,
    configuration.pickupReadyLeadTimeSeconds,
  );
  if (proposedReadyAt === undefined)
    return checkoutPlanRejected("checkout.policy");
  const delivery = deliveryHookStage(
    database,
    command.merchantId,
    hookQuote(discountedLines),
    total,
    { kind: "pickup", readyAt: proposedReadyAt, chosen: false },
  );
  if (delivery.kind === "refused")
    return { kind: "rejected", error: delivery.error };
  hookRuns.push(...delivery.runs);
  hookFailures.push(...delivery.failures);
  const readyAt = delivery.value.readyAt ?? proposedReadyAt;
  const validated = validationStage(database, command.merchantId, {
    checkoutId: command.checkoutId,
    kind: "pickup",
    quotedAt: command.requestedAt,
    currency,
    readyBy: readyAt,
    lines: discountedLines,
    variants: resources.variants,
    subtotalMinor: subtotal,
    totalMinor: total,
    customerId: discounted.value.customerId,
  });
  if (validated.kind === "refused")
    return { kind: "rejected", error: validated.error };
  const pluginRuns = [...hookRuns, ...validated.runs];
  return {
    kind: "planned",
    quote: buildCheckoutQuote({
      checkoutRevision: context.checkoutRevision,
      lines: discountedLines,
      totals: {
        subtotal: { amountMinor: subtotal, currency },
        tax: { amountMinor: taxAmount, currency },
        duty: { amountMinor: 0, currency },
        shipping: { amountMinor: 0, currency },
        total: { amountMinor: total, currency },
        ...(discountTotal === 0
          ? {}
          : { discount: { amountMinor: discountTotal, currency } }),
      },
      fulfillment: {
        kind: "pickup",
        promise: { locationId: allocationLocationId, readyAt },
      },
      quotedAt: command.requestedAt,
      expiresAt,
      ...(pluginRuns.length === 0 ? {} : { pluginRuns }),
    }),
    allocations,
    positions: [...nextPositions.values()],
    discountHolds: {
      holds: discounted.value.holds,
      customerId: discounted.value.customerId,
      expiresAt,
    },
    pluginFailures: [...hookFailures, ...validated.failures],
  };
}

export function planPickupCheckout(
  database: CommerceDatabase,
  command: PickupCheckoutPlanningCommand,
  storefront: Storefront,
  resources: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
  menus: FoodServiceMenus | undefined,
  context: CheckoutPlanContext,
): PickupCheckoutPlanResult {
  if (storefront.fulfillment.kind !== "pickup") {
    return checkoutPlanRejected("storefront.fulfillment");
  }
  if (storefront.checkout.tax.kind !== "percentage") {
    return checkoutPlanRejected("storefront.checkout.tax");
  }
  const profile = resolveCheckoutProfileForQuote({
    database,
    merchantId: command.merchantId,
    reference: command.checkoutProfile,
    storefront,
    fulfillment: "pickup",
    lineQuantities: command.lines.map((line) => line.quantity.amount),
    buyerSessionDigest: command.buyerSessionDigest,
    buyerAuthority: command.buyerAuthority,
    destinationAuthority: "pickup",
  });
  if (profile.kind === "rejected") return profile;
  const buyerContact = checkoutBuyerContact(
    database,
    command.merchantId,
    command.buyerAuthority,
  );
  if (buyerContact === undefined)
    return checkoutPlanRejected("checkout.buyerContact");
  const allocationLocationId = storefront.fulfillment.locationId;
  const allocations: InventoryAllocation[] = [];
  const checkoutLines: CheckoutQuoteSnapshot["lines"] = [];
  const nextPositions = context.positions;
  const expiresAt = timestampAfterSeconds(
    command.requestedAt,
    storefront.checkout.quoteTtlSeconds,
  );
  if (expiresAt === undefined) return checkoutPlanRejected("checkout.policy");
  // A market sells this storefront's offers in its own currency.
  const marketId = "marketId" in command ? command.marketId : undefined;
  const market =
    marketId === undefined
      ? undefined
      : readMarket(database, command.merchantId, marketId);
  if (
    marketId !== undefined &&
    (market === undefined ||
      market.status !== "active" ||
      !market.storefrontIds.includes(command.storefrontId) ||
      !pluginActive(database, command.merchantId, "markets"))
  )
    return checkoutPlanRejected("checkout.market");
  let currency: string | undefined;
  let shopCurrency: string | undefined;
  let shopSubtotal = 0;
  let subtotal = 0;
  for (const line of command.lines) {
    const selection = resolveCheckoutSelection(
      database,
      command.merchantId,
      line.source,
      foodService,
      resources,
      storefront.salesChannelId,
      allocationLocationId,
      command.requestedAt,
      menus,
    );
    if (selection.kind === "rejected") return selection;
    const { variant, offer, source, requirements, consumeOn } =
      selection.value;
    if (
      !checkoutProfileAcceptsCurrency(
        profile.profile.configuration,
        offer.price.currency,
      )
    ) {
      return checkoutPlanRejected("checkoutProfile.currencyPolicy");
    }
    if (shopCurrency !== undefined && shopCurrency !== offer.price.currency) {
      return checkoutPlanRejected("checkout.currency");
    }
    shopCurrency = offer.price.currency;
    currency = market?.currency ?? offer.price.currency;
    const shopLineTotal = safeMultiply(offer.price.amountMinor, line.quantity.amount);
    if (shopLineTotal === undefined) return checkoutPlanRejected("checkout.lineTotal");
    shopSubtotal += shopLineTotal;
    const override =
      "priceOverrides" in command && line.source.kind === "catalog"
        ? command.priceOverrides?.find(
            (candidate) => candidate.variantId === variant.id,
          )
        : undefined;
    if (
      override !== undefined &&
      (market !== undefined ||
        override.unitPrice.currency !== offer.price.currency)
    )
      return checkoutPlanRejected("checkout.priceOverride");
    const marketPrice =
      market === undefined
        ? undefined
        : marketUnitPrice(market, variant.id, offer.price);
    if (market !== undefined && marketPrice === undefined)
      return checkoutPlanRejected("checkout.market.price");
    const unitPrice = override?.unitPrice ?? marketPrice ?? offer.price;
    const lineTotal = safeMultiply(unitPrice.amountMinor, line.quantity.amount);
    if (lineTotal === undefined)
      return checkoutPlanRejected("checkout.lineTotal");
    const nextSubtotal = safeAdd(subtotal, lineTotal);
    if (nextSubtotal === undefined)
      return checkoutPlanRejected("checkout.subtotal");
    subtotal = nextSubtotal;
    const allocationIds: string[] = [];
    for (const requirement of requirements) {
      const positionResult = allocateCheckoutRequirement(
        database,
        command,
        line.checkoutLineId,
        line.quantity.amount,
        requirement,
        allocationLocationId,
        nextPositions,
        expiresAt,
        consumeOn,
      );
      if (positionResult.kind === "rejected") return positionResult;
      allocations.push(positionResult.allocation);
      allocationIds.push(positionResult.allocation.allocationId);
    }
    checkoutLines.push({
      checkoutLineId: line.checkoutLineId,
      source,
      quantity: line.quantity,
      unitPrice,
      lineTotal: { amountMinor: lineTotal, currency: unitPrice.currency },
      allocationIds,
      title: variant.title,
      ...(override === undefined
        ? {}
        : {
            priceOverride: {
              offerPrice: offer.price,
              reason: override.reason,
            },
          }),
    });
  }
  if (currency === undefined) return checkoutPlanRejected("checkout.currency");
  const quoteCurrency = currency;
  const hookRuns: CheckoutPluginRun[] = [];
  const hookFailures: PluginFunctionFailure[] = [];
  const hookQuote = (
    lines: readonly CheckoutQuoteSnapshot["lines"][number][],
  ) => ({
    checkoutId: command.checkoutId,
    kind: "pickup" as const,
    quotedAt: command.requestedAt,
    currency: quoteCurrency,
    lines,
    variants: resources.variants,
  });
  // Market and staff prices come from the market and the draft, so the
  // lines hook runs only on shop prices.
  let pricedLines: readonly CheckoutQuoteSnapshot["lines"][number][] =
    checkoutLines;
  if (
    market === undefined &&
    checkoutLines.every((line) => line.priceOverride === undefined)
  ) {
    const priced = linesHookStage(
      database,
      command.merchantId,
      hookQuote(
        companyPriceStage(database, command.merchantId, {
          customerId:
            "discount" in command
              ? (command.discount?.customerId ?? null)
              : null,
          currency: quoteCurrency,
          lines: checkoutLines,
        }),
      ),
    );
    if (priced.kind === "refused")
      return { kind: "rejected", error: priced.error };
    hookRuns.push(...priced.runs);
    hookFailures.push(...priced.failures);
    pricedLines = priced.value;
    subtotal = pricedLines.reduce(
      (sum, line) => sum + line.lineTotal.amountMinor,
      0,
    );
  }
  const discounted = discountStage(database, command.merchantId, {
    checkoutId: command.checkoutId,
    request: "discount" in command ? command.discount : undefined,
    at: command.requestedAt,
    currency,
    lines: pricedLines,
    variants: resources.variants,
  });
  if (discounted.kind === "rejected")
    return checkoutPlanRejected(discounted.field);
  const pluginDiscount = discountHookStage(
    database,
    command.merchantId,
    hookQuote(discounted.value.lines),
  );
  if (pluginDiscount.kind === "refused")
    return { kind: "rejected", error: pluginDiscount.error };
  hookRuns.push(...pluginDiscount.runs);
  hookFailures.push(...pluginDiscount.failures);
  const discountTotal =
    discounted.value.discountTotal + pluginDiscount.value.discountTotal;
  const discountedLines = [...pluginDiscount.value.lines];
  subtotal -= discountTotal;
  const taxed = storefrontPercentageTax(subtotal, storefront.checkout.tax);
  if (taxed === undefined) return checkoutPlanRejected("checkout.tax");
  const taxAmount = taxed.tax;
  const tax = { amountMinor: taxAmount, currency };
  const total = taxed.total;
  const tenders = tendersHookStage(
    database,
    command.merchantId,
    hookQuote(discountedLines),
    total,
    "storedValue" in command ? command.storedValue : undefined,
  );
  if (tenders.kind === "refused")
    return { kind: "rejected", error: tenders.error };
  hookRuns.push(...tenders.runs);
  hookFailures.push(...tenders.failures);
  const storedValue = storedValueStage(database, command.merchantId, {
    checkoutId: command.checkoutId,
    request: "storedValue" in command ? command.storedValue : undefined,
    at: command.requestedAt,
    total: { amountMinor: total, currency },
  });
  if (storedValue.kind === "rejected")
    return checkoutPlanRejected(storedValue.field);
  const earliest = timestampAfterSeconds(
    command.requestedAt,
    storefront.fulfillment.readyLeadTimeSeconds,
  );
  if (earliest === undefined) {
    return checkoutPlanRejected("checkout.policy");
  }
  // A chosen pickup time is at least the lead time and at most 60 days ahead.
  const chosen = "pickupAt" in command ? command.pickupAt : undefined;
  if (
    chosen !== undefined &&
    (Date.parse(chosen) < Date.parse(earliest) ||
      Date.parse(chosen) >
        Date.parse(command.requestedAt) + PICKUP_AHEAD_LIMIT_MS)
  )
    return checkoutPlanRejected("checkout.pickupAt");
  const proposedReadyAt =
    chosen === undefined
      ? earliest
      : new Date(Date.parse(chosen)).toISOString();
  const delivery = deliveryHookStage(
    database,
    command.merchantId,
    hookQuote(discountedLines),
    total,
    { kind: "pickup", readyAt: proposedReadyAt, chosen: chosen !== undefined },
  );
  if (delivery.kind === "refused")
    return { kind: "rejected", error: delivery.error };
  hookRuns.push(...delivery.runs);
  hookFailures.push(...delivery.failures);
  const readyAt = delivery.value.readyAt ?? proposedReadyAt;
  const validated = validationStage(database, command.merchantId, {
    checkoutId: command.checkoutId,
    kind: "pickup",
    quotedAt: command.requestedAt,
    currency,
    readyBy: readyAt,
    lines: discountedLines,
    variants: resources.variants,
    subtotalMinor: subtotal,
    totalMinor: total,
    customerId: discounted.value.customerId,
  });
  if (validated.kind === "refused")
    return { kind: "rejected", error: validated.error };
  const pluginRuns = [...hookRuns, ...validated.runs];
  const pluginFailures = [...hookFailures, ...validated.failures];
  const quoteBase: Omit<CheckoutQuoteSnapshot, "quoteDigest"> = {
    checkoutRevision: context.checkoutRevision,
    lines: discountedLines,
    totals: {
      subtotal: { amountMinor: subtotal, currency },
      tax,
      duty: { amountMinor: 0, currency },
      shipping: { amountMinor: 0, currency },
      total: { amountMinor: total, currency },
      ...(discountTotal === 0
        ? {}
        : { discount: { amountMinor: discountTotal, currency } }),
      ...(storefront.checkout.tax.inclusion === "included"
        ? { taxIncluded: true as const }
        : {}),
    },
    fulfillment: {
      kind: "pickup",
      promise: { locationId: allocationLocationId, readyAt },
    },
    quotedAt: command.requestedAt,
    expiresAt,
    ...(market === undefined || shopCurrency === undefined
      ? {}
      : {
          market: {
            marketId: market.id,
            marketRevision: market.revision,
            shopCurrency,
            rate:
              market.pricing.kind === "converted" ? market.pricing.rate.value : null,
            shopSubtotal: { amountMinor: shopSubtotal, currency: shopCurrency },
          },
        }),
    ...(storedValue.value.quote === undefined
      ? {}
      : { storedValue: storedValue.value.quote }),
    ...(pluginRuns.length === 0 ? {} : { pluginRuns }),
  };
  const quote = buildCheckoutQuote(quoteBase);
  const checkout = parseCheckout({
    checkoutId: command.checkoutId,
    source: {
      kind: "online",
      storefrontId: command.storefrontId,
      cartId: command.cartId,
      buyerSessionDigest: command.buyerSessionDigest,
      buyerContact,
      checkoutProfile: command.checkoutProfile,
    },
    revision: context.checkoutRevision,
    lifecycle: {
      state: "quoted",
      quote,
    },
  });
  const cart = parseCart({
    cartId: command.cartId,
    storefrontId: command.storefrontId,
    checkoutProfile: command.checkoutProfile,
    buyerSessionDigest: command.buyerSessionDigest,
    revision: context.cartRevision,
    lines: command.lines.map((line) => {
      const checkoutLine = discountedLines.find(
        (candidate) => candidate.checkoutLineId === line.checkoutLineId,
      );
      if (checkoutLine === undefined)
        throw new Error("Checkout cart line source is unavailable");
      return cartLineFromCheckoutCommand(line, checkoutLine.source);
    }),
    lifecycle: {
      state: "submitted",
      checkoutId: command.checkoutId,
      submittedAt: command.requestedAt,
    },
  });
  return {
    kind: "planned",
    value: {
      ...(pluginFailures.length === 0 ? {} : { pluginFailures }),
      cart,
      checkout,
      allocations,
      positions: [...nextPositions.values()],
      // Always written, so that a refresh drops the holds it no longer uses.
      discountHolds: {
        holds: discounted.value.holds,
        customerId: discounted.value.customerId,
        expiresAt,
      },
      storedValueHolds: storedValue.value.tenders,
    },
  };
}

function checkoutBuyerContact(
  database: CommerceDatabase,
  merchantId: string,
  buyerAuthority: CommerceCheckoutBuyerAuthorityV1,
): CommerceProtectedBuyerContactV1 | undefined {
  switch (buyerAuthority.kind) {
    case "identified_customer":
      return buyerAuthority.contact;
    case "guest":
      switch (buyerAuthority.contactAuthority.kind) {
        case "provided":
          return buyerAuthority.contactAuthority.contact;
        case "retained_checkout": {
          const retained = readCheckout(
            database,
            merchantId,
            buyerAuthority.contactAuthority.checkoutId,
          );
          // Contact is retained from an online checkout; a counter sale has
          // none to retain.
          return retained === undefined
            ? undefined
            : checkoutOnlineSource(retained)?.buyerContact;
        }
        default:
          return assertNever(
            buyerAuthority.contactAuthority,
            "Unsupported checkout planning branch",
          );
      }
    default:
      return assertNever(
        buyerAuthority,
        "Unsupported checkout planning branch",
      );
  }
}

export function buildCheckoutQuote(
  input: Omit<CheckoutQuoteSnapshot, "quoteDigest">,
): CheckoutQuoteSnapshot {
  return {
    quoteDigest: checkoutQuoteDigest(input),
    checkoutRevision: input.checkoutRevision,
    lines: input.lines,
    totals: input.totals,
    fulfillment: input.fulfillment,
    quotedAt: input.quotedAt,
    expiresAt: input.expiresAt,
    ...(input.market === undefined ? {} : { market: input.market }),
    ...(input.storedValue === undefined
      ? {}
      : { storedValue: input.storedValue }),
    ...(input.pluginRuns === undefined ? {} : { pluginRuns: input.pluginRuns }),
  };
}

export type CheckoutSelection = Readonly<{
  variant: CommerceResourcesV1["variants"][number];
  offer: CommerceOfferV1;
  consumptionPlan: InventoryConsumptionPlan;
  requirements: readonly InventoryRequirement[];
  consumeOn: InventoryAllocationCommitPoint;
  source: CheckoutQuoteSnapshot["lines"][number]["source"];
}>;

export type CheckoutSelectionResult =
  | Readonly<{ kind: "planned"; value: CheckoutSelection }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function resolveCheckoutSelection(
  database: CommerceDatabase,
  merchantId: string,
  selection: CommercePickupCheckoutSelectionV1,
  foodService: CommerceFoodServiceResourcesV1,
  resources: CommerceResourcesV1,
  salesChannelId: string,
  locationId: string,
  now: string,
  menus: FoodServiceMenus | undefined,
): CheckoutSelectionResult {
  if (selection.kind === "catalog") {
    const variant = resources.variants.find(
      (candidate) => candidate.id === selection.variantId,
    );
    if (variant === undefined) return checkoutPlanRejected("checkout.variant");
    if (
      menus !== undefined &&
      pluginActive(database, merchantId, "food_service") &&
      menus.variantSoldOut(database, merchantId, locationId, variant.id, now)
    )
      return checkoutPlanRejected("checkout.soldOut");
    const offer = resolveCheckoutOffer(resources, salesChannelId, variant.id);
    if (offer === undefined) return checkoutPlanRejected("checkout.offer");
    const consumptionPlan = resolveCheckoutConsumptionPlan(
      database,
      merchantId,
      variant.id,
      locationId,
    );
    if (consumptionPlan === undefined)
      return checkoutPlanRejected("checkout.consumptionPlan");
    if (
      consumptionPlan.mode.kind !== "direct" ||
      consumptionPlan.mode.commitOn !== "fulfillment_completed"
    ) {
      return selectionRejected("checkout.catalog.consumptionPlan");
    }
    const requirements = consumptionPlan.mode.components;
    const consumeOn = consumptionPlan.mode.commitOn;
    return {
      kind: "planned",
      value: {
        variant,
        offer,
        consumptionPlan,
        requirements,
        consumeOn,
        source: {
          kind: "catalog",
          variantId: variant.id,
          variantRevision: variant.revision,
          merchantCode: variant.sku,
          optionValues: [...variant.options],
          offerId: offer.id,
          offerRevision: offer.revision,
          consumptionPlanId: consumptionPlan.consumptionPlanId,
          consumptionPlanRevision: consumptionPlan.revision,
          inventory:
            requirements.length === 0
              ? { kind: "untracked" }
              : { kind: "requirements", items: [...requirements] },
        },
      },
    };
  }
  // A paused food service plugin sells no menu line.
  return menus === undefined || !pluginActive(database, merchantId, "food_service")
    ? selectionRejected("checkout.menu")
    : menus.select({
        database,
        merchantId,
        selection,
        foodService,
        resources,
        salesChannelId,
        locationId,
        now,
      });
}

type CheckoutRequirementAllocationResult =
  | Readonly<{
      kind: "planned";
      allocation: InventoryAllocation;
    }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

function allocateCheckoutRequirement(
  database: CommerceDatabase,
  command: Readonly<{
    merchantId: string;
    checkoutId: string;
    requestedAt: string;
  }>,
  checkoutLineId: string,
  lineQuantity: number,
  requirement: Readonly<{
    inventoryItemId: string;
    quantity: CommerceQuantityV1;
  }>,
  locationId: string,
  nextPositions: Map<string, CommerceInventoryPositionV1>,
  expiresAt: string,
  consumeOn: InventoryAllocationCommitPoint,
): CheckoutRequirementAllocationResult {
  const stored =
    nextPositions.get(requirement.inventoryItemId) ??
    readInventoryPositionForItemLocation(
      database,
      command.merchantId,
      requirement.inventoryItemId,
      locationId,
    );
  if (stored === undefined) {
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "inventory_position",
        id: `${requirement.inventoryItemId}:${locationId}`,
      },
    };
  }
  if (
    stored.balance.kind !== "accounted" ||
    stored.balance.available.unit !== requirement.quantity.unit
  ) {
    return checkoutRequirementRejected("inventoryPosition.balance");
  }
  const requiredAmount = scaleCheckoutRequirement(
    requirement.quantity,
    lineQuantity,
    stored.balance.available.scale,
  );
  if (requiredAmount === undefined) {
    return checkoutRequirementRejected("inventoryRequirement.quantity");
  }
  const quantity = {
    amount: requiredAmount,
    scale: stored.balance.available.scale,
    unit: stored.balance.available.unit,
  } as const;
  const usable = readUsableInventoryQuantity(
    database,
    command.merchantId,
    stored,
    command.requestedAt,
  );
  if (!availableBalanceSatisfies(usable, quantity)) {
    return {
      kind: "rejected",
      error: {
        code: "insufficient_inventory",
        inventoryItemId: requirement.inventoryItemId,
        locationId,
        requestedAmount: requiredAmount,
        availableAmount: wholeAmountAtScale(usable, quantity.scale),
      },
    };
  }
  const positionAlreadyPlanned = nextPositions.has(requirement.inventoryItemId);
  const nextPosition = parseInventoryPosition({
    id: stored.id,
    revision: stored.revision + (positionAlreadyPlanned ? 0 : 1),
    inventoryItemId: stored.inventoryItemId,
    locationId: stored.locationId,
    balance: {
      kind: "accounted",
      onHand: stored.balance.onHand,
      allocated: {
        ...stored.balance.allocated,
        amount: stored.balance.allocated.amount + requiredAmount,
      },
      available: {
        ...stored.balance.available,
        amount: stored.balance.available.amount - requiredAmount,
      },
    },
    occurredAt: command.requestedAt,
  });
  nextPositions.set(requirement.inventoryItemId, nextPosition);
  const allocationId = `allocation_${sha256(
    `${command.merchantId}:${command.checkoutId}:${checkoutLineId}:${requirement.inventoryItemId}`,
  )}`;
  return {
    kind: "planned",
    allocation: parseInventoryAllocation({
      allocationId,
      inventoryItemId: requirement.inventoryItemId,
      locationId,
      quantity,
      revision: 1,
      lifecycle: {
        state: "held",
        demand: {
          kind: "checkout",
          checkoutId: command.checkoutId,
          checkoutLineId,
          consumeOn,
        },
        expiresAt,
      },
    }),
  };
}

function resolveCheckoutOffer(
  resources: CommerceResourcesV1,
  salesChannelId: string,
  variantId: string,
): CommerceOfferV1 | undefined {
  const variant = findResource(resources.variants, variantId);
  if (variant === undefined || !variantIsSellable(resources.products, variant))
    return undefined;
  const matches = resources.offers.filter(
    offerMatchesCheckout.bind(undefined, salesChannelId, variantId),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function offerMatchesCheckout(
  salesChannelId: string,
  variantId: string,
  offer: CommerceOfferV1,
): boolean {
  return (
    offer.salesChannelId === salesChannelId &&
    offer.variantId === variantId &&
    offer.lifecycle.state === "listed" &&
    offer.availability.state === "available"
  );
}

export function resolveCheckoutConsumptionPlan(
  database: CommerceDatabase,
  merchantId: string,
  variantId: string,
  locationId: string,
): ReturnType<typeof readConsumptionPlan> {
  const plans = listConsumptionPlansForVariant(database, merchantId, variantId);
  return selectInventoryConsumptionPlan(plans, variantId, locationId);
}

export function consumptionPlanAppliesToLocation(
  plan: NonNullable<ReturnType<typeof readConsumptionPlan>>,
  locationId: string,
): boolean {
  return (
    plan.lifecycle === "active" &&
    (plan.scope.kind === "organisation" || plan.scope.locationId === locationId)
  );
}

export function buyerVariantIsAvailable(
  database: CommerceDatabase,
  merchantId: string,
  locationId: string,
  variantId: string,
  offerIsAvailable: boolean,
  occurredAt: string,
): boolean {
  if (!offerIsAvailable) return false;
  const plan = resolveCheckoutConsumptionPlan(
    database,
    merchantId,
    variantId,
    locationId,
  );
  if (plan?.mode.kind !== "direct") return false;
  for (const requirement of plan.mode.components) {
    const position = readInventoryPositionForItemLocation(
      database,
      merchantId,
      requirement.inventoryItemId,
      locationId,
    );
    if (
      position === undefined ||
      position.balance.kind !== "accounted" ||
      !availableBalanceSatisfies(
        readUsableInventoryQuantity(database, merchantId, position, occurredAt),
        requirement.quantity,
      )
    ) {
      return false;
    }
  }
  return true;
}

export function shippingVariantIsEligible(
  database: CommerceDatabase,
  merchantId: string,
  variantId: string,
  variantRevision: number,
  shippingProfileId: string,
): boolean {
  const profile = readCatalogShippingProfile(
    database,
    merchantId,
    shippingProfileId,
  );
  const specification = readCatalogVariantShippingSpecification(
    database,
    merchantId,
    variantId,
    variantRevision,
  );
  return (
    profile?.lifecycle.state === "active" &&
    specification?.shippingProfileId === profile.shippingProfileId &&
    specification.shippingProfileRevision === profile.revision &&
    specification.eligibility.kind === "physical"
  );
}


export function refreshOperationLineIdMatches(
  operationDigest: string,
  line: CheckoutQuoteSnapshot["lines"][number],
  index: number,
): boolean {
  return (
    line.checkoutLineId.startsWith(`checkout_line_${operationDigest}_`) &&
    line.checkoutLineId.endsWith(`_${index + 1}`)
  );
}

export function refreshRequestLineIdMatches(
  operationDigest: string,
  requestDigest: string,
  line: CheckoutQuoteSnapshot["lines"][number],
  index: number,
): boolean {
  return (
    line.checkoutLineId ===
    `checkout_line_${operationDigest}_${requestDigest}_${index + 1}`
  );
}

export function sameBuyerCheckoutLines(
  quoted: readonly CommerceBuyerQuotedCheckoutLineV1[],
  requested: readonly CommerceBuyerPickupCheckoutLineV1[],
): boolean {
  if (quoted.length !== requested.length) return false;
  for (let index = 0; index < quoted.length; index += 1) {
    const left = quoted[index];
    const right = requested[index];
    if (
      left === undefined ||
      right === undefined ||
      left.kind !== right.kind ||
      left.quantity !== right.quantity
    )
      return false;
    if (left.kind === "catalog" && right.kind === "catalog") {
      if (left.variantId !== right.variantId) return false;
    } else if (left.kind === "menu" && right.kind === "menu") {
      if (
        left.menuId !== right.menuId ||
        left.menuEntryId !== right.menuEntryId ||
        left.modifierOptionIds.length !== right.modifierOptionIds.length ||
        left.modifierOptionIds.some(
          (optionId, optionIndex) =>
            optionId !== right.modifierOptionIds[optionIndex],
        )
      )
        return false;
    } else return false;
  }
  return true;
}

export function sameBuyerShippingCheckoutLines(
  quoted: readonly Variant<CommerceBuyerQuotedCheckoutLineV1, "catalog">[],
  requested: readonly CommerceBuyerShippingCheckoutLineV1[],
): boolean {
  if (quoted.length !== requested.length) return false;
  for (let index = 0; index < quoted.length; index += 1) {
    const left = quoted[index];
    const right = requested[index];
    if (
      left === undefined ||
      right === undefined ||
      left.variantId !== right.variantId ||
      left.quantity !== right.quantity
    ) {
      return false;
    }
  }
  return true;
}

export function availableBalanceSatisfies(
  available: CommerceQuantityV1,
  required: CommerceQuantityV1,
): boolean {
  if (available.unit !== required.unit) return false;
  const scale = Math.max(available.scale, required.scale);
  return scaledAmount(available, scale) >= scaledAmount(required, scale);
}

function cartLineFromCheckoutCommand(
  line: PickupCheckoutPlanningCommand["lines"][number],
  checkoutSource: CheckoutQuoteSnapshot["lines"][number]["source"],
): Cart["lines"][number] {
  if (line.source.kind === "catalog") {
    return {
      cartLineId: line.cartLineId,
      source: { kind: "catalog", variantId: line.source.variantId },
      quantity: line.quantity,
    };
  }
  if (checkoutSource.kind !== "food_service")
    throw new Error("A menu cart line needs a menu quote line");
  return {
    cartLineId: line.cartLineId,
    source: {
      kind: "food_service",
      variantId: checkoutSource.variantId,
      menuId: line.source.menuId,
      menuEntryId: line.source.menuEntryId,
      modifierOptionIds: [...line.source.modifierOptionIds],
    },
    quantity: line.quantity,
  };
}

export function scaleCheckoutRequirement(
  quantity: CommerceQuantityV1,
  multiplier: number,
  targetScale: number,
): number | undefined {
  if (targetScale < quantity.scale) return undefined;
  const scaled = scaledAmount(quantity, targetScale) * BigInt(multiplier);
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(scaled);
}

function safeMultiply(left: number, right: number): number | undefined {
  const value = BigInt(left) * BigInt(right);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(value);
}

export function safeAdd(left: number, right: number): number | undefined {
  const value = BigInt(left) + BigInt(right);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(value);
}

function checkoutTotal(
  subtotal: number,
  tax: number,
  duty: number,
  shipping: number,
): number | undefined {
  const withTax = safeAdd(subtotal, tax);
  if (withTax === undefined) return undefined;
  const withDuty = safeAdd(withTax, duty);
  return withDuty === undefined ? undefined : safeAdd(withDuty, shipping);
}

/**
 * The tax in a subtotal under a storefront percentage, and what the buyer
 * pays. An added rate goes on top of the subtotal; an included rate is
 * already in the listed prices, so the buyer pays the subtotal and the tax
 * is the part of it above the net amount.
 */
export function storefrontPercentageTax(
  subtotal: number,
  rule: Readonly<{ basisPoints: number; inclusion?: "added" | "included" }>,
): Readonly<{ tax: number; total: number }> | undefined {
  if (rule.inclusion === "included") {
    const denominator = 10_000n + BigInt(rule.basisPoints);
    const numerator = BigInt(subtotal) * BigInt(rule.basisPoints);
    const tax = (numerator * 2n + denominator) / (denominator * 2n);
    return { tax: Number(tax), total: subtotal };
  }
  const tax = percentageOfMinorUnits(subtotal, rule.basisPoints);
  if (tax === undefined) return undefined;
  const total = safeAdd(subtotal, tax);
  return total === undefined ? undefined : { tax, total };
}

function percentageOfMinorUnits(
  amountMinor: number,
  basisPoints: number,
): number | undefined {
  const numerator = BigInt(amountMinor) * BigInt(basisPoints);
  const roundedHalfUp = (numerator + 5_000n) / 10_000n;
  return roundedHalfUp > BigInt(Number.MAX_SAFE_INTEGER)
    ? undefined
    : Number(roundedHalfUp);
}

export function timestampAfterSeconds(
  timestamp: string,
  seconds: number,
): string | undefined {
  const milliseconds = Date.parse(timestamp) + seconds * 1_000;
  return Number.isSafeInteger(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
}

export function checkoutPlanRejected(
  field: string,
): Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }> {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}

export function selectionRejected(field: string): CheckoutSelectionResult {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}

function checkoutRequirementRejected(
  field: string,
): CheckoutRequirementAllocationResult {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}
