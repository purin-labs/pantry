import type {
  CommerceFilter,
  CommerceGraphQuery,
  SystemCommerceEntityKind,
} from "@purin-labs/contracts";

import { assertCommerceGraphQueryWithLexicon } from "../commerce-wasm";
import { assertNever } from "@purin-labs/std";
/**
 * The named merchant reports the daily brief is built from.
 *
 * Each name is a fixed question with a fixed source, filter, and unit. The
 * agent chooses which report to run; it never composes a metric of its own, so
 * every reported number traces to one declared query.
 */
export type MerchantReportName =
  | "open_orders"
  | "low_stock_exposure"
  | "payment_failures"
  | "fulfillment_exceptions"
  | "product_sales";

const MERCHANT_REPORT_NAMES: readonly MerchantReportName[] = [
  "open_orders",
  "low_stock_exposure",
  "payment_failures",
  "fulfillment_exceptions",
  "product_sales",
];

export function isMerchantReportName(
  value: unknown,
): value is MerchantReportName {
  return (
    typeof value === "string" &&
    MERCHANT_REPORT_NAMES.includes(value as MerchantReportName)
  );
}

/**
 * What the reported number counts and over which time span.
 *
 * `current_state` reports the population as it stands at the snapshot the read
 * returns; there is no time window to state, and reporting one would imply a
 * filter the query does not apply.
 */
export type MerchantReportWindow = Readonly<{ kind: "current_state" }>;

/** The unit a headline value carries, so no number is presented bare. */
export type MerchantReportUnit =
  | Readonly<{ kind: "entity_count"; entityType: SystemCommerceEntityKind }>
  | Readonly<{ kind: "money"; currency: string }>;

/**
 * A report the read surface cannot execute today, with the exact capability it
 * needs. Reporting this is the correct outcome; substituting a different
 * number would answer a question the merchant did not ask.
 */
export type MerchantReportUnsupported = Readonly<{
  kind: "unsupported";
  reason:
    | "event_time_window_filter_required"
    | "money_sum_aggregation_required"
    | "authorized_product_sales_route_required"
    | "authorized_stock_snapshot_route_required";
  dependency: string;
}>;

type MerchantReportQueries = Readonly<{
  kind: "supported";
  /** The headline aggregation. */
  headline: CommerceGraphQuery;
  /** The exact population behind the headline, for drill-down. */
  population: CommerceGraphQuery;
}>;

type MerchantReportDefinition = Readonly<{
  name: MerchantReportName;
  /** Merchant-readable statement of what the number measures. */
  metric: string;
  entityType: SystemCommerceEntityKind;
  window: MerchantReportWindow;
  unit: MerchantReportUnit;
  /** The operating decision this report is fit to support, and only that one. */
  supportsDecision: string;
  queries: MerchantReportQueries | MerchantReportUnsupported;
}>;

const POPULATION_LIMIT = 25;

export function merchantReportDefinition(
  name: MerchantReportName,
): MerchantReportDefinition {
  switch (name) {
    case "open_orders":
      return {
        name,
        metric: "Customer orders that are neither fulfilled nor cancelled.",
        entityType: "order",
        window: { kind: "current_state" },
        unit: { kind: "entity_count", entityType: "order" },
        supportsDecision:
          "Whether order work is accumulating faster than it is being cleared.",
        queries: statePair("order", openOrderFilter()),
      };
    case "low_stock_exposure":
      return {
        name,
        metric:
          "Stock rows that are low or out, the same rows that the Products and Ingredients pages count as shortages.",
        entityType: "inventory_position",
        window: { kind: "current_state" },
        unit: { kind: "entity_count", entityType: "inventory_position" },
        supportsDecision:
          "Which items need replenishment attention before they block fulfillment.",
        // Shortages come from the stock snapshot that the stock pages read,
        // because an item with no stock and no reorder point has no flag to
        // count in the graph.
        queries: {
          kind: "unsupported",
          reason: "authorized_stock_snapshot_route_required",
          dependency: "authorized_stock_snapshot_read",
        },
      };
    case "payment_failures":
      return {
        name,
        metric: "Payments whose lifecycle is failed.",
        entityType: "payment",
        window: { kind: "current_state" },
        unit: { kind: "entity_count", entityType: "payment" },
        supportsDecision:
          "Which failed attempts need investigation against linked orders and later payment outcomes before identifying unresolved payment problems.",
        queries: statePair("payment", lifecycleFilter("failed")),
      };
    case "fulfillment_exceptions":
      return {
        name,
        metric: "Shipments whose lifecycle is a delivery exception.",
        entityType: "shipment",
        window: { kind: "current_state" },
        unit: { kind: "entity_count", entityType: "shipment" },
        supportsDecision:
          "Which shipments need an operator to resolve a delivery problem.",
        queries: statePair("shipment", lifecycleFilter("delivery_exception")),
      };
    case "product_sales":
      return {
        name,
        metric: "Order value by product over an operating window.",
        entityType: "order",
        window: { kind: "current_state" },
        unit: { kind: "money", currency: "unknown" },
        supportsDecision:
          "Which products are selling well enough to prioritise or discount.",
        // Product sales uses its authorized line-level API instead of a graph count.
        queries: {
          kind: "unsupported",
          reason: "authorized_product_sales_route_required",
          dependency: "authorized_product_sales_read",
        },
      };
    default:
      return assertNever(name);
  }
}

/**
 * The headline count and the population behind it, over the same filter, so a
 * reported number and its drill-down cannot describe different sets.
 */
function statePair(
  typeId: SystemCommerceEntityKind,
  filter: CommerceFilter,
): MerchantReportQueries {
  return {
    kind: "supported",
    headline: checked({
      kind: "aggregation",
      source: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId },
      },
      filter,
      aggregation: { kind: "count" },
    }),
    population: checked({
      kind: "entity_type_page",
      entityTypeId: { origin: "system", typeId },
      filter,
      sorts: [],
      pagination: { limit: POPULATION_LIMIT, cursor: null },
      traversal: { maxDepth: 0, resultLimit: POPULATION_LIMIT },
    }),
  };
}

function openOrderFilter(): CommerceFilter {
  return brandedFilter({
    kind: "not",
    filter: {
      kind: "any",
      filters: [lifecycleClause("fulfilled"), lifecycleClause("cancelled")],
    },
  });
}

function lifecycleFilter(value: string): CommerceFilter {
  return brandedFilter(lifecycleClause(value));
}

function lifecycleClause(value: string): unknown {
  return {
    kind: "attribute",
    filter: {
      operator: "equals",
      attributeId: "lifecycle",
      value: { kind: "status", value },
    },
  };
}

/**
 * Brands one filter by validating it inside a complete query. The lexicon
 * check is the only place attribute and option identifiers become typed, so a
 * filter this module writes is proven before any report uses it.
 */
function brandedFilter(filter: unknown): CommerceFilter {
  const query = checked({
    kind: "aggregation",
    source: {
      kind: "entity_type",
      entityTypeId: { origin: "system", typeId: "order" },
    },
    filter,
    aggregation: { kind: "count" },
  });
  if (query.kind !== "aggregation")
    throw new Error("merchant report filter must be an aggregation");
  return query.filter;
}

/** Validates one named query against the lexicon before it can be issued. */
function checked(value: unknown): CommerceGraphQuery {
  assertCommerceGraphQueryWithLexicon(value);
  return value;
}

/**
 * What one named report returns to the agent.
 *
 * Every field the plan requires a factual answer to declare is present here, so
 * a grounded answer can be written from this value alone and an ungrounded one
 * has nothing to draw on.
 */
export type MerchantReportResult =
  | import("./product-sales-report").MerchantProductSalesResult
  | Readonly<{
      kind: "reported";
      name: MerchantReportName;
      metric: string;
      entityType: SystemCommerceEntityKind;
      window: MerchantReportWindow;
      unit: MerchantReportUnit;
      supportsDecision: string;
      /** The headline number. */
      value: number;
      /** The exact records behind it, truncated at the population limit. */
      population: readonly MerchantReportRecord[];
      /** True when more records match than the population lists. */
      populationTruncated: boolean;
      merchantRevision: unknown;
      provenance: readonly unknown[];
      freshness: readonly unknown[];
    }>
  | Readonly<{
      kind: "unavailable";
      name: MerchantReportName;
      metric: string;
      /** Why no number can be given, in terms the operator can act on. */
      reason: string;
      dependency: string;
    }>;

export type MerchantReportRecord = Readonly<{
  entityType: string;
  entityId: string;
  revision: number;
  displayName: string | null;
}>;
