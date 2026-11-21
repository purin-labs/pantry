// A conformance corpus for stores that execute Lexicon commerce query plans
// over the normalized relations: Commerce's merchant relations and Pantry's
// commerce projection both run every case and must return the expected ids.
// The two suites share this module so the corpus cannot drift (Plan 76
// phase 1 split the former single parity test along the runtime boundary).

export type NormalizedConformanceRow = Readonly<{
  entityType: "order" | "shipment" | "production_batch";
  entityId: string;
  displayName: string;
  /** Milliseconds since the epoch. */
  updatedAt: number;
}>;

/** Four orders, three shipments and two production batches. */
export const NORMALIZED_CONFORMANCE_ROWS: readonly NormalizedConformanceRow[] = [
  { entityType: "order", entityId: "order_tie_a", displayName: "Café", updatedAt: 100 },
  // The same name in the decomposed form (e + U+0301) ties after folding.
  { entityType: "order", entityId: "order_tie_b", displayName: "Cafe\u0301", updatedAt: 100 },
  { entityType: "order", entityId: "order_export", displayName: "Straße", updatedAt: 90 },
  { entityType: "order", entityId: "order_missing_attribute", displayName: "STRASSE", updatedAt: 80 },
  { entityType: "shipment", entityId: "shipment_export", displayName: "東京", updatedAt: 70 },
  { entityType: "shipment", entityId: "shipment_two", displayName: "Shipment two", updatedAt: 60 },
  { entityType: "shipment", entityId: "shipment_three", displayName: "Shipment three", updatedAt: 50 },
  {
    entityType: "production_batch",
    entityId: "production_batch_export",
    displayName: "Production batch production_batch_export",
    updatedAt: 40,
  },
  {
    entityType: "production_batch",
    entityId: "production_batch_two",
    displayName: "Production batch production_batch_two",
    updatedAt: 30,
  },
];

/** order_shipment relationships, source order to target shipment. */
export const NORMALIZED_CONFORMANCE_EDGES: readonly (readonly [string, string])[] = [
  ["order_export", "shipment_export"],
  ["order_tie_b", "shipment_two"],
  ["order_tie_a", "shipment_three"],
];

/** Orders whose `lifecycle` attribute is "open"; order_missing_attribute has none. */
export const NORMALIZED_CONFORMANCE_LIFECYCLE_IDS: readonly string[] = ["order_tie_a", "order_tie_b", "order_export"];

/** The order page in the default order: newest first, then UTF-8 id order. */
export const NORMALIZED_CONFORMANCE_ORDER_PAGE_IDS: readonly string[] = [
  "order_tie_a",
  "order_tie_b",
  "order_export",
  "order_missing_attribute",
];

export type NormalizedConformanceCase = Readonly<{
  name: string;
  /** A raw CommerceGraphQuery; each suite parses it with its own contracts. */
  query: Readonly<Record<string, unknown>>;
  sortableAttributeIds: readonly string[];
  filterableAttributeIds: readonly string[];
  /**
   * The expected order ids, or the expected count. A bounded case compares
   * the first `ids.length` rows; a store may fetch one more row to look ahead.
   */
  expected:
    | Readonly<{ kind: "ids"; ids: readonly string[]; bounded?: true }>
    | Readonly<{ kind: "count"; value: number }>;
}>;

const ORDER = { origin: "system", typeId: "order" } as const;

function orderPage(limit: number, extra: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    kind: "entity_type_page",
    entityTypeId: ORDER,
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit, cursor: null },
    traversal: { maxDepth: 0, resultLimit: limit },
    ...extra,
  };
}

function orderSearch(text: string): Readonly<Record<string, unknown>> {
  return {
    kind: "search",
    text,
    entityTypeId: ORDER,
    pagination: { limit: 4, cursor: null },
    traversal: { maxDepth: 0, resultLimit: 4 },
  };
}

function exactOrder(entityId: string): Readonly<Record<string, unknown>> {
  return {
    kind: "entity_by_ref",
    reference: { ...ORDER, entityId },
    traversal: { maxDepth: 0, resultLimit: 1 },
  };
}

export const NORMALIZED_CONFORMANCE_CASES: readonly NormalizedConformanceCase[] = [
  {
    name: "order page",
    query: orderPage(4),
    sortableAttributeIds: [],
    filterableAttributeIds: [],
    expected: { kind: "ids", ids: NORMALIZED_CONFORMANCE_ORDER_PAGE_IDS },
  },
  ...[1, 3, 4].map(
    (limit): NormalizedConformanceCase => ({
      name: `bounded order page of ${limit}`,
      query: orderPage(limit),
      sortableAttributeIds: [],
      filterableAttributeIds: [],
      expected: { kind: "ids", ids: NORMALIZED_CONFORMANCE_ORDER_PAGE_IDS.slice(0, limit), bounded: true },
    }),
  ),
  {
    name: "folded text search",
    query: orderSearch("STRASSE"),
    sortableAttributeIds: [],
    filterableAttributeIds: [],
    expected: { kind: "ids", ids: ["order_export", "order_missing_attribute"] },
  },
  {
    name: "relationship exists filter",
    query: orderPage(4, {
      filter: {
        kind: "relationship",
        filter: {
          operator: "exists",
          relationshipDefinition: { origin: "system", definitionId: "order_shipment", revision: 1 },
        },
      },
    }),
    sortableAttributeIds: [],
    filterableAttributeIds: [],
    expected: { kind: "ids", ids: ["order_tie_a", "order_tie_b", "order_export"] },
  },
  {
    name: "count",
    query: {
      kind: "aggregation",
      source: { kind: "entity_type", entityTypeId: ORDER },
      aggregation: { kind: "count" },
      filter: { kind: "all" },
    },
    sortableAttributeIds: [],
    filterableAttributeIds: [],
    expected: { kind: "count", value: 4 },
  },
  {
    name: "attribute sort with nulls last",
    query: orderPage(4, {
      sorts: [{ field: { kind: "attribute", attributeId: "lifecycle" }, direction: "ascending" }],
    }),
    sortableAttributeIds: ["lifecycle"],
    filterableAttributeIds: ["lifecycle"],
    expected: { kind: "ids", ids: ["order_export", "order_tie_a", "order_tie_b", "order_missing_attribute"] },
  },
  {
    name: "missing attribute filter",
    query: orderPage(20, { filter: { kind: "attribute", filter: { operator: "is_empty", attributeId: "lifecycle" } } }),
    sortableAttributeIds: [],
    filterableAttributeIds: ["lifecycle"],
    expected: { kind: "ids", ids: ["order_missing_attribute"] },
  },
  {
    name: "sort by an attribute that every row lacks",
    query: orderPage(20, {
      sorts: [{ field: { kind: "attribute", attributeId: "optional_all_null" }, direction: "ascending" }],
    }),
    sortableAttributeIds: ["optional_all_null"],
    filterableAttributeIds: [],
    expected: { kind: "ids", ids: ["order_export", "order_missing_attribute", "order_tie_a", "order_tie_b"] },
  },
  {
    name: "exact reference",
    query: exactOrder("order_export"),
    sortableAttributeIds: [],
    filterableAttributeIds: [],
    expected: { kind: "ids", ids: ["order_export"] },
  },
  {
    name: "absent exact reference",
    query: exactOrder("order_missing"),
    sortableAttributeIds: [],
    filterableAttributeIds: [],
    expected: { kind: "ids", ids: [] },
  },
  {
    name: "search without a match",
    query: orderSearch("不存在"),
    sortableAttributeIds: [],
    filterableAttributeIds: [],
    expected: { kind: "ids", ids: [] },
  },
];

/** The planner input for one case; each suite calls its own Lexicon planner. */
export function normalizedConformancePlanInput(
  query: unknown,
  scope: Readonly<{ organisationId: string; merchantId: string }>,
  sortableAttributeIds: readonly string[],
  filterableAttributeIds: readonly string[],
): Readonly<Record<string, unknown>> {
  return {
    query,
    semantics: {
      semanticsVersion: "v1",
      orderingVersion: "v1",
      textNormalization: "commerce_unicode_v1",
      nullPlacement: "last",
    },
    projection: { attributeIds: [], relationshipDefinitions: [], includeProvenance: false, includeFreshness: false },
    organisationId: scope.organisationId,
    merchantId: scope.merchantId,
    watermark: { kind: "commerce_native", merchantRevision: 1 },
    capabilities: {
      kind: "system_mapped",
      systemEntityKind: "order",
      systemSchemaRevision: 1,
      capability: { filterableAttributeIds, sortableAttributeIds, aggregation: { kind: "count_only" } },
    },
  };
}
