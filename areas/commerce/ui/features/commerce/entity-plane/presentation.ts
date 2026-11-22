/**
 * Merchant-facing presentation of commerce entity-plane values.
 *
 * The graph API speaks wire format: decimals arrive as `{ unscaled, scale }`,
 * money as minor units, statuses and choices as option IDs, operators as
 * principal references. A café operator reads "460 cups", not "460000000e6".
 *
 * Nothing here decides what a value means — only how a person reads it. No JSX,
 * so wording can be tested without a component tree.
 */
import type {
  AttributeDefinitionKind,
  AttributeOption,
  AttributeValue,
  ListEntryAttributeDefinition,
} from "@purin-labs/commerce-contracts";

import {
  formatAbsoluteTime,
  humanizeIdentifier,
} from "@purin-labs/ui/formatting";
import type { StatusChipStatus } from "@purin-labs/ui/status-chip";
import { assertNever } from "@purin-labs/std";

/** Rendered when an attribute carries no value for this record. */
export const COMMERCE_VALUE_ABSENT = "—";

/**
 * The published label for an attribute, falling back to a humanized identifier
 * when the definition is unavailable (a saved view may list an attribute whose
 * definition this page did not load).
 */
export function commerceAttributeLabel(
  attributeId: string,
  definition: ListEntryAttributeDefinition | undefined,
): string {
  return definition?.definition.label ?? sentenceCaseIdentifier(attributeId);
}

/**
 * Console labels are sentence case, so a derived label capitalises only its
 * first word: `placed_at` reads as "Placed at", not "Placed At".
 */
function sentenceCaseIdentifier(value: string): string {
  const humanized = humanizeIdentifier(value);
  return `${humanized.slice(0, 1)}${humanized.slice(1).toLocaleLowerCase()}`;
}

/**
 * Values a reader compares down a column — quantities, money, counts — are
 * aligned to the end of the cell and set in tabular figures.
 */
export function isNumericCommerceValue(value: AttributeValue): boolean {
  switch (value.kind) {
    case "integer":
    case "decimal":
    case "money":
      return true;
    case "short_text":
    case "long_text":
    case "boolean":
    case "date":
    case "timestamp":
    case "status":
    case "choice":
    case "merchant_operator_reference":
    case "external_resource_reference":
      return false;
    default:
      return assertNever(value, "Unhandled commerce attribute value");
  }
}

/**
 * Human-readable text for one typed attribute value. The definition supplies
 * status and choice labels; without it the option ID is humanized.
 */
export function formatCommerceAttributeValue(
  value: AttributeValue,
  definition: AttributeDefinitionKind | undefined,
): string {
  switch (value.kind) {
    case "short_text":
    case "long_text":
      return value.value;
    case "integer":
      return formatInteger(value.value);
    case "decimal":
      return formatDecimal(value.value.unscaled, value.value.scale);
    case "boolean":
      return value.value ? "Yes" : "No";
    case "date":
      return formatCommerceDate(value.value);
    case "timestamp":
      return formatCommerceTimestamp(value.value);
    case "status":
      return optionLabel(String(value.value), definition);
    case "choice":
      return value.values.length === 0
        ? COMMERCE_VALUE_ABSENT
        : value.values
            .map((option) => optionLabel(String(option), definition))
            .join(", ");
    case "money":
      return formatMoney(value.value.amountMinor, String(value.value.currency));
    case "merchant_operator_reference":
      return value.value.displayName;
    case "external_resource_reference":
      return (
        value.value.label ??
        `${value.value.source} ${String(value.value.resourceId)}`
      );
    default:
      return assertNever(value, "Unhandled commerce attribute value");
  }
}

/**
 * A status value rendered as a chip rather than as text. Returns null for every
 * other value kind so callers can fall through to text.
 */
/**
 * A record whose name is its long hash identifier reads as "Order D2AF70". A
 * name that a person can read stays as it is. The full identifier stays on the
 * record's page.
 */
export function commerceRecordLabel(displayName: string): string {
  const match = /^([a-z]+)_([0-9a-f]{16,})$/u.exec(displayName);
  if (match === null) return displayName;
  const [, type = "", hash = ""] = match;
  return `${type.slice(0, 1).toLocaleUpperCase()}${type.slice(1)} ${hash.slice(0, 6).toLocaleUpperCase()}`;
}

export function commerceStatusChip(
  value: AttributeValue,
  definition: AttributeDefinitionKind | undefined,
): StatusChipStatus | null {
  if (value.kind !== "status") return null;
  const optionId = String(value.value);
  return {
    kind: commerceStatusTone(optionId),
    label: optionLabel(optionId, definition),
  };
}

/**
 * Tone for the published status vocabularies in use today (export coordination
 * stages, replenishment lifecycle, priority). An unrecognised merchant-defined
 * option stays neutral rather than guessing a severity.
 */
function commerceStatusTone(optionId: string): StatusChipStatus["kind"] {
  switch (optionId) {
    case "delivered":
    case "received":
    case "ready":
      return "success";
    case "exception":
    case "late":
      return "danger";
    case "missing_documents":
    case "trade_partner_follow_up":
    case "partial":
    case "needs_review":
    case "high":
      return "warning";
    case "in_transit":
    case "requested":
    case "expected":
      return "info";
    default:
      return "neutral";
  }
}

/** The label published for an option ID, or a humanized fallback. */
function optionLabel(
  optionId: string,
  definition: AttributeDefinitionKind | undefined,
): string {
  for (const option of definitionOptions(definition)) {
    if (String(option.id) === optionId) return option.label;
  }
  return sentenceCaseIdentifier(optionId);
}

/** The selectable options of a status or choice definition. */
function definitionOptions(
  definition: AttributeDefinitionKind | undefined,
): readonly AttributeOption[] {
  if (definition === undefined) return [];
  return definition.kind === "status" || definition.kind === "choice"
    ? definition.options
    : [];
}

/**
 * Merchant-facing names for the entity types this console shows. `TradePartner`
 * is the entity-plane identity behind the merchant-facing "Supplier" (Plan
 * 31-B): the internal name never reaches the page.
 */
export function commerceEntityTypeLabel(
  typeId: string,
  plural: boolean,
): string {
  switch (typeId) {
    case "trade_partner":
      return plural ? "suppliers" : "supplier";
    case "order":
      return plural ? "customer orders" : "customer order";
    case "product":
      return plural ? "products" : "product";
    case "inventory_item":
      return plural ? "inventory items" : "inventory item";
    case "stock_policy":
      return plural ? "stock rules" : "stock rule";
    case "shipment":
      return plural ? "shipments" : "shipment";
    case "fulfillment":
      return plural ? "fulfillments" : "fulfillment";
    case "payment":
      return plural ? "payments" : "payment";
    case "export_document":
      return plural ? "export documents" : "export document";
    case "production_batch":
      return plural ? "production batches" : "production batch";
    case "location":
      return plural ? "locations" : "location";
    case "menu":
      return plural ? "menus" : "menu";
    case "offer":
      return plural ? "offers" : "offer";
    case "sellable_variant":
      return plural ? "variants" : "variant";
    case "recipe_revision":
      return plural ? "recipes" : "recipe";
    case "preparation_ticket":
      return plural ? "preparation tickets" : "preparation ticket";
    default: {
      const humanized = humanizeIdentifier(typeId).toLocaleLowerCase();
      return plural ? `${humanized}s` : humanized;
    }
  }
}

/**
 * How one record relates to another, read from the relationship's own
 * identifier: `supplier_inventory_item` between a supplier and an item reads as
 * "Supplied item". The published definition carries source and inverse labels,
 * but a graph result returns only definition references, so the identifier is
 * the best source available on this page.
 */
export function commerceRelationshipLabel(definitionId: string): string {
  switch (definitionId) {
    case "order_shipment":
      return "Shipment";
    case "order_fulfillment":
      return "Fulfillment";
    case "fulfillment_shipment":
      return "Shipment";
    case "shipment_production_batch":
      return "Production batch";
    case "recipe_revision_production_batch":
      return "Production batch";
    case "production_batch_recipe_revision":
      return "Recipe";
    case "trade_partner_order":
      return "Supplier";
    case "supplier_inventory_item":
      return "Supplied item";
    case "shipment_export_document":
      return "Export document";
    default:
      return humanizeIdentifier(definitionId);
  }
}

/** Where a projected record's facts came from, in words rather than an enum. */
export function commerceSourceLabel(source: string): string {
  switch (source) {
    case "commerce":
      return "Purin Checkout";
    case "shopify":
      return "Shopify";
    case "stripe":
      return "Stripe";
    case "lab":
      return "Commerce lab";
    default:
      return humanizeIdentifier(source);
  }
}

/**
 * Dates arrive as calendar days (`2026-09-01`). Constructing them through the
 * Date parser would read them as UTC midnight and shift the day backwards for
 * any viewer west of Greenwich, so the parts are placed in local time.
 */
function formatCommerceDate(value: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (parts === null) return value;
  const local = new Date(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
  );
  return local.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** Instants keep their time; the console shows them in the viewer's zone. */
export function formatCommerceTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : formatAbsoluteTime(parsed);
}

/**
 * `{ unscaled: 460000000, scale: 6 }` is 460. The digits are placed by string
 * so a large unscaled value cannot lose precision on the way through a float,
 * and trailing zeros of the fixed scale are dropped: quantities read as "460",
 * not "460.000000".
 */
function formatDecimal(unscaled: number, scale: number): string {
  const exact = exactDecimalText(unscaled, scale);
  const separator = exact.indexOf(".");
  const fractionDigits = separator === -1 ? 0 : exact.length - separator - 1;
  const numeric = Number(exact);
  if (!Number.isFinite(numeric)) return exact;
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(numeric);
}

function exactDecimalText(unscaled: number, scale: number): string {
  if (!Number.isFinite(unscaled) || !Number.isFinite(scale) || scale <= 0)
    return String(unscaled);
  const negative = unscaled < 0;
  const digits = String(Math.abs(Math.trunc(unscaled))).padStart(
    scale + 1,
    "0",
  );
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/u, "");
  const text = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}

/** Counts arrive as bigint; Intl formats them without a lossy Number cast. */
function formatInteger(value: bigint): string {
  return new Intl.NumberFormat().format(value);
}

/**
 * Money arrives in the currency's minor unit. The exponent differs by currency
 * — JPY has none, USD two, BHD three — so it is read from the currency itself
 * rather than assumed to be 100.
 */
function formatMoney(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const major = amountMinor / 10 ** exponent;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(major);
  } catch {
    return `${new Intl.NumberFormat().format(major)} ${currency}`;
  }
}

function currencyExponent(currency: string): number {
  try {
    const resolved = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).resolvedOptions();
    return resolved.maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}
