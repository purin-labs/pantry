import { assertNever, rustTrim } from "@purin-labs/std";
import {
  normalizeCommerceTimestamp,
  timestampNanoseconds,
} from "./commerce-timestamp.ts";
import type {
  CanonicalCommerceDelivery,
  CanonicalCommerceObservation,
  CommerceProjection,
  CommerceValidationError,
  ExternalShipmentLifecycle,
  FulfillmentLineItem,
  InventoryBalance,
  LocationKind,
  LocationLifecycle,
  OfferLifecycle,
  OrderLifecycle,
  OrderLineItem,
  OrderTotals,
  ProductMedia,
  ProductMediaKind,
  ProductOption,
  SalesChannelKind,
  SalesChannelLifecycle,
  SellableVariantAvailability,
  PaymentLifecycle,
  Quantity,
  QuantityUnit,
  ShippingFulfillmentLifecycle,
  TrackingEvent,
  TrackingEventKind,
} from "./records/commerce-records.ts";
import type { Money } from "./records/money.ts";
import type {
  CommerceResourceType,
  CommerceSource,
  SourceProvenance,
} from "./records/provenance.ts";

/**
 * Plan 78: the constructors of `commerce/canonical.rs` and `provenance.rs`.
 * Each throws `CommerceRejection` where Rust returns its error, and checks
 * run in the Rust order, so the first refusal is the same one.
 */
export class CommerceRejection extends Error {
  readonly error: CommerceValidationError;

  constructor(error: CommerceValidationError) {
    super(error.code);
    this.error = error;
    this.name = "CommerceRejection";
  }
}

export function rejectCommerce(error: CommerceValidationError): never {
  throw new CommerceRejection(error);
}

/** Rust `require_text`: non-blank and already trimmed. */
function requireText(value: string, field: string): string {
  const trimmed = rustTrim(value);
  if (trimmed.length === 0 || value !== trimmed)
    rejectCommerce({ code: "invalid_identity", field });
  return value;
}

function requireNonEmpty<T>(values: T[], field: string): T[] {
  if (values.length === 0) rejectCommerce({ code: "empty_collection", field });
  return values;
}

/** `string_identity!` values: OrganisationId, IntegrationAccountId, ResourceId, ProviderDeliveryId. */
export function identity(
  value: string,
  name:
    | "OrganisationId"
    | "IntegrationAccountId"
    | "ResourceId"
    | "ProviderDeliveryId",
): string {
  return requireText(value, name);
}

export function resourceId(value: string): string {
  return identity(value, "ResourceId");
}

export function commerceTimestamp(value: string): string {
  const normalized = normalizeCommerceTimestamp(value);
  if (normalized === null) rejectCommerce({ code: "invalid_timestamp" });
  return normalized;
}

function nanoseconds(value: string): bigint {
  const result = timestampNanoseconds(value);
  if (result === null) rejectCommerce({ code: "invalid_timestamp" });
  return result;
}

/** Rust `CommerceTimestamp` order: the derived order of its normalized text. */
function timestampBefore(left: string, right: string): boolean {
  return left < right;
}

export function currencyCode(value: string): string {
  if (!/^[A-Z]{3}$/.test(value)) rejectCommerce({ code: "invalid_currency" });
  return value;
}

export function money(amountMinor: number, currency: string): Money {
  return { amountMinor, currency: currencyCode(currency) };
}

export function ensureNonNegative(value: Money): Money {
  if (value.amountMinor < 0) rejectCommerce({ code: "negative_money" });
  return value;
}

const ZERO_EXPONENT = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const THREE_EXPONENT = new Set([
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
]);
const I64_MAX = 9223372036854775807n;

/** Rust `Money::from_major_decimal`. */
export function moneyFromMajorDecimal(value: string, currency: string): Money {
  const code = currencyCode(currency);
  const exponent = ZERO_EXPONENT.has(code)
    ? 0
    : THREE_EXPONENT.has(code)
      ? 3
      : 2;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const parts = unsigned.split(".");
  const whole = parts[0]!;
  if (whole.length === 0 || !/^[0-9]+$/.test(whole))
    rejectCommerce({
      code: "invalid_boundary_payload",
      reason: "money amount is not a decimal",
    });
  const fraction = parts[1] ?? "";
  if (
    parts.length > 2 ||
    fraction.length > exponent ||
    !/^[0-9]*$/.test(fraction)
  )
    rejectCommerce({
      code: "invalid_boundary_payload",
      reason: "money amount has invalid precision",
    });
  const wholeMinor = BigInt(whole);
  if (wholeMinor > I64_MAX) outOfRange();
  const fractionMinor = BigInt(fraction.padEnd(exponent, "0") || "0");
  const amount = wholeMinor * 10n ** BigInt(exponent) + fractionMinor;
  if (amount > I64_MAX) outOfRange();
  return { amountMinor: Number(negative ? -amount : amount), currency: code };
}

function outOfRange(): never {
  rejectCommerce({
    code: "invalid_boundary_payload",
    reason: "money amount is out of range",
  });
}

/**
 * A counted or measured quantity: a safe integer of zero or more, with a
 * scale of 0 to 6 decimal places, and no scale for `each`. An available
 * quantity, which can be below zero, is `availableQuantity`.
 */
export function quantity(
  amount: number,
  scale: number,
  unit: QuantityUnit,
): Quantity {
  if (!Number.isSafeInteger(amount) || amount < 0)
    rejectCommerce({ code: "invalid_quantity", field: "quantity.amount" });
  if (
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > 6 ||
    (unit === "each" && scale !== 0)
  )
    rejectCommerce({ code: "invalid_quantity", field: "quantity.scale" });
  return { amount, scale, unit };
}

function quantityAtMost(left: Quantity, right: Quantity): boolean {
  if (left.unit !== right.unit) return false;
  const scale = Math.max(left.scale, right.scale);
  return (
    BigInt(left.amount) * 10n ** BigInt(scale - left.scale) <=
    BigInt(right.amount) * 10n ** BigInt(scale - right.scale)
  );
}

export function availableQuantity(
  amount: number,
  scale: number,
  unit: QuantityUnit,
): Quantity {
  if (
    !Number.isSafeInteger(amount) ||
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > 6 ||
    (unit === "each" && scale !== 0)
  )
    rejectCommerce({ code: "invalid_quantity", field: "availableQuantity" });
  return { amount, scale, unit };
}

/** Rust `SourceProvenance::new`, after its caller built each identity. */
export function sourceProvenance(
  organisationId: string,
  integrationAccountId: string,
  source: CommerceSource,
  resourceType: CommerceResourceType,
  resource: string,
  revision: number,
  occurredAt: string,
  observedAt: string,
): SourceProvenance {
  if (revision === 0) rejectCommerce({ code: "invalid_revision" });
  if (nanoseconds(observedAt) < nanoseconds(occurredAt))
    rejectCommerce({ code: "observed_before_occurred" });
  return {
    organisationId,
    integrationAccountId,
    source,
    resourceType,
    resourceId: resource,
    revision,
    occurredAt,
    observedAt,
  };
}

/** Rust `CommerceBoundaryContext`. */
export type BoundaryContext = Readonly<{
  organisationId: string;
  integrationAccountId: string;
  revision: number;
  occurredAt: string;
  observedAt: string;
  eventId: string;
  customerReference: string;
}>;

export function contextProvenance(
  context: BoundaryContext,
  source: CommerceSource,
  resourceType: CommerceResourceType,
  resource: string,
): SourceProvenance {
  const organisationId = identity(context.organisationId, "OrganisationId");
  const integrationAccountId = identity(
    context.integrationAccountId,
    "IntegrationAccountId",
  );
  const id = resourceId(resource);
  const occurredAt = commerceTimestamp(context.occurredAt);
  const observedAt = commerceTimestamp(context.observedAt);
  return sourceProvenance(
    organisationId,
    integrationAccountId,
    source,
    resourceType,
    id,
    context.revision,
    occurredAt,
    observedAt,
  );
}

export function contextDelivery(
  context: BoundaryContext,
  projections: CommerceProjection[],
): CanonicalCommerceDelivery {
  if (projections.length === 0)
    rejectCommerce({
      code: "empty_collection",
      field: "commerceBoundaryContext.projections",
    });
  const observations: CanonicalCommerceObservation[] = projections.map(
    (projection) => {
      const provenance = projection.projection.provenance as SourceProvenance;
      return {
        kind: "upsert",
        observationId: resourceId(
          `${context.eventId}:${provenance.resourceType}:${provenance.resourceId}:${provenance.revision}`,
        ),
        projection,
      } as CanonicalCommerceObservation;
    },
  );
  return canonicalDelivery(
    identity(context.eventId, "ProviderDeliveryId"),
    observations,
  );
}

function canonicalDelivery(
  providerDeliveryId: string,
  observations: CanonicalCommerceObservation[],
): CanonicalCommerceDelivery {
  requireNonEmpty(observations, "canonicalCommerceDelivery.observations");
  const seen = new Set<string>();
  for (const observation of observations) {
    if (seen.has(observation.observationId))
      rejectCommerce({
        code: "duplicate_observation",
        observationId: observation.observationId,
      });
    seen.add(observation.observationId);
  }
  return { schemaVersion: 1, providerDeliveryId, observations };
}

function requireResourceType(
  provenance: SourceProvenance,
  expected: CommerceResourceType,
): void {
  if (provenance.resourceType !== expected)
    rejectCommerce({ code: "resource_type_mismatch" });
}

function projection(
  kind: CommerceProjection["kind"],
  value: unknown,
): CommerceProjection {
  return { kind, projection: value } as CommerceProjection;
}

export function inventoryBalanceAccounted(
  onHand: Quantity,
  allocated: Quantity,
  available: Quantity,
): InventoryBalance {
  if (
    onHand.unit !== allocated.unit ||
    onHand.unit !== available.unit ||
    onHand.scale !== allocated.scale ||
    onHand.scale !== available.scale
  )
    rejectCommerce({
      code: "invalid_quantity",
      field: "inventoryPosition.balance",
    });
  if (onHand.amount < allocated.amount)
    rejectCommerce({
      code: "invalid_quantity",
      field: "inventoryPosition.balance.allocated",
    });
  if (
    BigInt(onHand.amount) - BigInt(allocated.amount) !==
    BigInt(available.amount)
  )
    rejectCommerce({
      code: "invalid_quantity",
      field: "inventoryPosition.balance.available",
    });
  return { kind: "accounted", onHand, allocated, available };
}

function orderTotalsFromTotal(total: Money): OrderTotals {
  const zero = money(0, total.currency);
  const values = [total, zero, zero, zero, zero, zero, zero, zero, total];
  if (values.some((value) => value.currency !== total.currency))
    rejectCommerce({ code: "currency_mismatch" });
  return {
    subtotal: ensureNonNegative(total),
    discount: ensureNonNegative(zero),
    tax: ensureNonNegative(zero),
    duty: ensureNonNegative(zero),
    shipping: ensureNonNegative(zero),
    serviceFee: ensureNonNegative(zero),
    tip: ensureNonNegative(zero),
    rounding: ensureNonNegative(zero),
    total: ensureNonNegative(total),
  };
}

/** Rust `Payment::new`. */
export function payment(
  provenance: SourceProvenance,
  orderId: string,
  amount: Money,
  lifecycle: PaymentLifecycle,
): CommerceProjection {
  requireResourceType(provenance, "payment");
  const checked = ensureNonNegative(amount);
  switch (lifecycle.state) {
    case "failed":
      if (rustTrim(lifecycle.reason).length === 0)
        rejectCommerce({
          code: "invalid_lifecycle",
          reason: "failed payment requires a reason",
        });
      break;
    case "partially_refunded":
      if (
        lifecycle.refundedAmount.amountMinor <= 0 ||
        lifecycle.refundedAmount.amountMinor >= checked.amountMinor
      )
        rejectCommerce({
          code: "invalid_lifecycle",
          reason: "partial refund must be positive and less than payment",
        });
      if (lifecycle.refundedAmount.currency !== checked.currency)
        rejectCommerce({ code: "currency_mismatch" });
      break;
    case "refunded":
      if (
        lifecycle.refundedAmount.amountMinor !== checked.amountMinor ||
        lifecycle.refundedAmount.currency !== checked.currency
      )
        rejectCommerce({
          code: "invalid_lifecycle",
          reason: "full refund must equal payment amount",
        });
      break;
  }
  return projection("payment", {
    provenance,
    orderId,
    amount: checked,
    lifecycle,
  });
}

export function fulfillmentLineItem(
  lineItemId: string,
  quantity: number,
): FulfillmentLineItem {
  if (quantity === 0)
    rejectCommerce({
      code: "invalid_quantity",
      field: "fulfillmentLineItem.quantity",
    });
  return { lineItemId, quantity };
}

/** Rust `Fulfillment::shipping` with the external binding that boundaries use. */
export function shippingFulfillment(
  provenance: SourceProvenance,
  orderId: string,
  lineItems: FulfillmentLineItem[],
  locationId: string,
  expectedBy: string,
  sourceReference: string,
  lifecycle: ShippingFulfillmentLifecycle,
): CommerceProjection {
  if (
    (lifecycle.state === "blocked" || lifecycle.state === "cancelled") &&
    rustTrim(lifecycle.reason).length === 0
  )
    rejectCommerce({
      code: "invalid_lifecycle",
      reason: "blocked or cancelled fulfillment requires a reason",
    });
  const trimmed = rustTrim(sourceReference);
  if (trimmed.length === 0 || trimmed !== sourceReference)
    rejectCommerce({
      code: "invalid_identity",
      field: "shippingFulfillment.binding.sourceReference",
    });
  requireResourceType(provenance, "fulfillment");
  return projection("fulfillment", {
    provenance,
    orderId,
    lineItems: requireNonEmpty(lineItems, "fulfillmentCase.lineItems"),
    locationId,
    expectedBy,
    kind: "shipping",
    binding: { kind: "external", sourceReference },
    lifecycle,
  });
}

export function trackingEvent(
  eventId: string,
  occurredAt: string,
  kind: TrackingEventKind,
  location: string,
): TrackingEvent {
  return { eventId, occurredAt, kind, location };
}

function sameEventKind(
  expected: TrackingEventKind["kind"],
  received: TrackingEventKind["kind"],
): boolean {
  return expected === received;
}

function validateTrackingEvents(
  events: TrackingEvent[],
  requireEvents: boolean,
  expected: TrackingEventKind["kind"],
): void {
  if (requireEvents && events.length === 0)
    rejectCommerce({ code: "empty_collection", field: "shipment.events" });
  for (let index = 1; index < events.length; index++)
    if (
      timestampBefore(events[index]!.occurredAt, events[index - 1]!.occurredAt)
    )
      rejectCommerce({
        code: "invalid_lifecycle",
        reason: "tracking history must be ordered",
      });
  const last = events.at(-1);
  if (last !== undefined && !sameEventKind(expected, last.kind.kind))
    rejectCommerce({
      code: "invalid_lifecycle",
      reason: "shipment state must match its final tracking event",
    });
}

/** Rust `Shipment::external`. */
export function externalShipment(
  provenance: SourceProvenance,
  orderId: string,
  fulfillmentId: string,
  carrier: string,
  trackingNumber: string,
  estimatedDeliveryAt: string,
  events: TrackingEvent[],
  lifecycle: ExternalShipmentLifecycle,
): CommerceProjection {
  requireResourceType(provenance, "shipment");
  if (
    (lifecycle.state === "delivery_exception" ||
      lifecycle.state === "returned") &&
    rustTrim(lifecycle.reason).length === 0
  )
    rejectCommerce({
      code: "invalid_lifecycle",
      reason: "shipment exception or return requires a reason",
    });
  validateTrackingEvents(events, true, lifecycle.state);
  return projection("shipment", {
    kind: "external",
    provenance,
    orderId,
    fulfillmentId,
    carrier: requireText(carrier, "shipment.carrier"),
    trackingNumber: requireText(trackingNumber, "shipment.trackingNumber"),
    estimatedDeliveryAt,
    lifecycle,
    events,
  });
}

export function productOption(name: string, value: string): ProductOption {
  return {
    name: requireText(name, "catalogOption.name"),
    value: requireText(value, "catalogOption.value"),
  };
}

export function productMedia(
  kind: ProductMediaKind,
  url: string,
  altText: string,
): ProductMedia {
  return { kind, url: requireText(url, "catalogMedia.url"), altText };
}

export function sellableVariant(
  provenance: SourceProvenance,
  productId: string,
  variantId: string,
  sku: string,
  title: string,
  options: ProductOption[],
  media: ProductMedia[],
): CommerceProjection {
  requireResourceType(provenance, "sellable_variant");
  return projection("sellable_variant", {
    provenance,
    productId,
    variantId,
    sku: requireText(sku, "catalogVariant.sku"),
    title: requireText(title, "catalogVariant.title"),
    options,
    media,
  });
}

export function product(
  provenance: SourceProvenance,
  title: string,
  description: string,
): CommerceProjection {
  requireResourceType(provenance, "product");
  return projection("product", {
    provenance,
    title: requireText(title, "catalogItem.title"),
    description,
  });
}

export function location(
  provenance: SourceProvenance,
  name: string,
  kind: LocationKind,
  lifecycle: LocationLifecycle,
): CommerceProjection {
  requireResourceType(provenance, "location");
  return projection("location", {
    provenance,
    name: requireText(name, "location.name"),
    kind,
    lifecycle,
  });
}

export function salesChannel(
  provenance: SourceProvenance,
  name: string,
  kind: SalesChannelKind,
  lifecycle: SalesChannelLifecycle,
): CommerceProjection {
  requireResourceType(provenance, "sales_channel");
  return projection("sales_channel", {
    provenance,
    name: requireText(name, "salesChannel.name"),
    kind,
    lifecycle,
  });
}

/** Rust `InventoryItem::new` for the aggregate, active finished goods that the boundaries create. */
export function finishedGoodInventoryItem(
  provenance: SourceProvenance,
  merchantCode: string,
  name: string,
): CommerceProjection {
  requireResourceType(provenance, "inventory_item");
  return projection("inventory_item", {
    provenance,
    merchantCode: requireText(merchantCode, "inventoryItem.merchantCode"),
    name: requireText(name, "inventoryItem.name"),
    baseUnit: "each",
    category: "finished_good",
    tracking: { kind: "aggregate" },
    lifecycle: "active",
  });
}

export function offer(
  provenance: SourceProvenance,
  variantId: string,
  salesChannelId: string,
  price: Money,
  availability: SellableVariantAvailability,
  lifecycle: OfferLifecycle,
): CommerceProjection {
  requireResourceType(provenance, "offer");
  return projection("offer", {
    provenance,
    variantId,
    salesChannelId,
    price: ensureNonNegative(price),
    availability,
    lifecycle,
  });
}

export function inventoryPosition(
  provenance: SourceProvenance,
  inventoryItemId: string,
  locationId: string,
  balance: InventoryBalance,
): CommerceProjection {
  requireResourceType(provenance, "inventory_position");
  return projection("inventory_position", {
    provenance,
    inventoryItemId,
    locationId,
    balance,
  });
}

/** Rust `OnlineShippingOrderLine`. */
type OnlineShippingOrderLine = Readonly<{
  id: string;
  variantId: string | null;
  sku: string;
  title: string;
  quantity: number;
  fulfilledQuantity: number;
  unitAmountMinor: number;
}>;

export type OnlineShippingOrderState =
  | Readonly<{
      kind:
        | "pending"
        | "confirmed"
        | "fulfillment_pending"
        | "partially_fulfilled"
        | "fulfilled";
    }>
  | Readonly<{ kind: "cancelled"; reason: string }>;

const I64_MIN = -9223372036854775808n;

function orderLineItem(
  lineItemId: string,
  source: OrderLineItem["source"],
  sku: string,
  title: string,
  ordered: Quantity,
  fulfilled: Quantity,
  unitPrice: Money,
  tax: Money,
  discount: Money,
  lineTotal: Money,
): OrderLineItem {
  if (source.kind === "source_only")
    requireText(
      source.sourceItemReference,
      "orderLineSource.sourceItemReference",
    );
  if (ordered.amount === 0 || !quantityAtMost(fulfilled, ordered))
    rejectCommerce({
      code: "invalid_quantity",
      field: "orderLineItem.quantity",
    });
  if (
    unitPrice.currency !== lineTotal.currency ||
    tax.currency !== lineTotal.currency ||
    discount.currency !== lineTotal.currency
  )
    rejectCommerce({ code: "currency_mismatch" });
  return {
    lineItemId,
    source,
    sku: requireText(sku, "orderLineItem.sku"),
    title: requireText(title, "orderLineItem.title"),
    quantity: ordered,
    fulfilledQuantity: fulfilled,
    unitPrice: ensureNonNegative(unitPrice),
    tax: ensureNonNegative(tax),
    discount: ensureNonNegative(discount),
    lineTotal: ensureNonNegative(lineTotal),
  } as OrderLineItem;
}

/** Rust `build_online_shipping_order` with `CommerceOrder::new`. */
export function onlineShippingOrder(
  provenance: SourceProvenance,
  checkoutId: string,
  customerReference: string,
  currency: string,
  totalAmountMinor: number,
  lines: OnlineShippingOrderLine[],
  state: OnlineShippingOrderState,
): CommerceProjection {
  const occurredAt = provenance.occurredAt;
  const lineItems = lines.map((line) => {
    if (BigInt(line.quantity) > I64_MAX)
      rejectCommerce({ code: "invalid_quantity", field: "orderLine.quantity" });
    const amount = BigInt(line.unitAmountMinor) * BigInt(line.quantity);
    if (amount > I64_MAX || amount < I64_MIN)
      rejectCommerce({
        code: "invalid_boundary_payload",
        reason: "line total overflow",
      });
    const id = resourceId(line.id);
    return orderLineItem(
      id,
      {
        kind: "source_only",
        sourceItemReference: line.variantId ?? line.id,
      } as OrderLineItem["source"],
      line.sku,
      line.title,
      quantity(line.quantity, 0, "each"),
      quantity(line.fulfilledQuantity, 0, "each"),
      money(line.unitAmountMinor, currency),
      money(0, currency),
      money(0, currency),
      money(Number(amount), currency),
    );
  });
  const lifecycle = orderLifecycle(state, occurredAt, lineItems);
  const total = money(totalAmountMinor, currency);
  const account = provenance.integrationAccountId;
  const salesChannelId = resourceId(`${account}:online`);
  const checkout = resourceId(checkoutId);
  const buyer =
    rustTrim(customerReference).length === 0
      ? { kind: "guest" }
      : { kind: "identified", customerReference };
  const totals = orderTotalsFromTotal(total);
  requireResourceType(provenance, "commerce_order");
  requireText(account, "orderOrigin.storefrontId");
  if (buyer.kind === "identified")
    requireText(customerReference, "orderBuyer.customerReference");
  if (lifecycle.state === "cancelled")
    requireText(lifecycle.reason, "orderLifecycle.cancelled.reason");
  requireNonEmpty(lineItems, "orderCase.lineItems");
  if (
    lineItems.some((item) => item.lineTotal.currency !== totals.total.currency)
  )
    rejectCommerce({ code: "currency_mismatch" });
  return projection("commerce_order", {
    provenance,
    origin: {
      kind: "online",
      salesChannelId,
      storefrontId: account,
      checkoutId: checkout,
      configuration: { kind: "external_authority" },
    },
    buyer,
    lineItems,
    totals,
    adjustments: [],
    lifecycle,
  });
}

function orderLifecycle(
  state: OnlineShippingOrderState,
  occurredAt: string,
  lineItems: OrderLineItem[],
): OrderLifecycle {
  switch (state.kind) {
    case "pending":
      return { state: "pending_confirmation", createdAt: occurredAt };
    case "confirmed":
      return { state: "confirmed", confirmedAt: occurredAt };
    case "fulfillment_pending":
      return { state: "fulfillment_pending", since: occurredAt };
    case "partially_fulfilled":
      return {
        state: "partially_fulfilled",
        since: occurredAt,
        fulfilledLineItemIds: lineItems
          .filter((line) => line.fulfilledQuantity.amount > 0)
          .map((line) => line.lineItemId),
      };
    case "fulfilled":
      return { state: "fulfilled", fulfilledAt: occurredAt };
    case "cancelled":
      return {
        state: "cancelled",
        cancelledAt: occurredAt,
        reason: state.reason,
      };
    default:
      return assertNever(state);
  }
}
