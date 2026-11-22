import type { ControlMutationIntent } from "@purin-labs/control/portal/control-client";
import { parseCommerceGraphQuery, parseCommerceViewPresentation, parseEntityPlaneCommandResult, parseEntityPlaneChanges, parseEntityPlanePublishedResourceMetadataResponse, parsePurchasingPresetPublishResponse, parsePurchasingReconcileResponse, purchaseRequestAttributeValues, REPLENISHMENT_QUEUE_LIST_ID, type PurchaseRequestUpdate, type CommerceEntityPlaneChanges, type CommerceEntityPlanePublishedResourceMetadataResponse } from "@purin-labs/commerce-client";
import type {
  AttributeDefinitionId,
  AttributeOption,
  CommerceAggregationResult,
  CommerceEntityPlaneCommand,
  CommerceEntityRef,
  CommerceEntityTypeId,
  CommerceFilter,
  CommerceGraphQuery,
  CommerceGraphQueryResult,
  CommerceList,
  CommerceListEntry,
  CommerceListId,
  CommercePagination,
  CommerceSnapshotRevision,
  CommerceTraversalLimits,
  CommerceViewPresentation,
  CustomCommerceEntityRef,
  ListEntryAttributeDefinition,
  ListEntryAttributeValue,
  SavedCommerceView,
  SavedCommerceViewId,
  SystemCommerceEntityKind,
  CommerceMutationReceiptV1,
} from "@purin-labs/commerce-contracts";
import { parseInventory } from "@purin-labs/commerce-contracts";
import { responseJson } from "@purin-labs/control/portal/control-client";
import { needsReorder } from "../stock-status";
import {
  parseCommerceGraphQueryResult,
} from "@purin-labs/commerce-control-api/portal/entity-plane-boundary";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isRecord } from "@purin-labs/std";
import type {
  CommerceActivityResource,
  CommerceBoardDragPreview,
  CommerceBoardPresenceEntry,
  CommerceBoardPresenceSelection,
  SupplierCreation,
} from "@purin-labs/commerce-control-api";
import {
  type CommerceActivityResult,
  type CommerceListEntryPatchOutcome,
  parseCommerceActivityResponse,
  parseCommerceBoardPresenceEntry,
  parseCommerceListEntryPatchResponse,
} from "@purin-labs/commerce-control-api/portal/entity-plane";

const TABLE_TRAVERSAL: CommerceTraversalLimits = {
  maxDepth: 0,
  resultLimit: 100,
};

const DOSSIER_TRAVERSAL: CommerceTraversalLimits = {
  maxDepth: 2,
  resultLimit: 20,
};

export type CommerceGraphFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type CommerceMutationTransport = (
  path: string,
  body: unknown,
  intent: ControlMutationIntent,
) => Promise<unknown>;

export type CommercePresenceTransport = (
  path: string,
  body: unknown,
) => Promise<unknown>;

type CommerceHomeGraphCountName =
  | "home_open_customer_orders"
  | "home_payment_failures"
  | "home_delayed_shipments";

type CommerceHomeAggregationName =
  | CommerceHomeGraphCountName
  | "home_product_shortages"
  | "home_supply_shortages";

export type CommerceHomeAggregation = Readonly<{
  name: CommerceHomeAggregationName;
  result: CommerceAggregationResult | null;
  merchantRevision: CommerceSnapshotRevision | null;
}>;

export type CommerceCollectionSelection =
  | Readonly<{ kind: "commerce_list"; listId: CommerceListId }>
  | Readonly<{ kind: "saved_commerce_view"; viewId: SavedCommerceViewId }>;

export type CommerceCollectionSelectionInput =
  | CommerceCollectionSelection
  | Readonly<{ kind: "commerce_list"; listId: string }>
  | Readonly<{ kind: "saved_commerce_view"; viewId: string }>;

export type CommercePublishedResourceMetadata = Variant<
  CommerceEntityPlanePublishedResourceMetadataResponse,
  "enumerated"
>;

export type { PurchaseRequestUpdate };

export async function readCommerceGraph(
  organisationId: string,
  query: CommerceGraphQuery,
  fetcher: CommerceGraphFetch = globalThis.fetch.bind(globalThis),
): Promise<CommerceGraphQueryResult> {
  const response = await responseJson(
    await fetcher(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/graph`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query }),
      },
    ),
  );
  const parsed = parseCommerceGraphQueryResult(response);
  if (!parsed.ok)
    throw new Error(
      `Commerce graph response is invalid at ${parsed.error.path}.`,
    );
  return parsed.value;
}

export async function readPublishedCommerceResources(
  organisationId: string,
  fetcher: CommerceGraphFetch = globalThis.fetch.bind(globalThis),
): Promise<CommercePublishedResourceMetadata> {
  const response = await responseJson(
    await fetcher(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/published-resources`,
      { method: "GET", headers: { accept: "application/json" } },
    ),
  );
  if (
    !isRecord(response) ||
    response.ok !== true ||
    !("metadata" in response)
  ) {
    throw new Error("Published commerce resource response is invalid.");
  }
  const metadata = parseEntityPlanePublishedResourceMetadataResponse(
    response.metadata,
  );
  if (metadata.kind !== "enumerated") {
    throw new Error(
      "Published commerce resource response is not an enumeration.",
    );
  }
  if (String(metadata.organisationId) !== organisationId) {
    throw new Error(
      "Published commerce resource response belongs to another organisation.",
    );
  }
  return metadata;
}

export async function readCommerceActivity(
  organisationId: string,
  resource: CommerceActivityResource,
  fetcher: CommerceGraphFetch = globalThis.fetch.bind(globalThis),
): Promise<CommerceActivityResult> {
  const response = await responseJson(
    await fetcher(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/graph/activity`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ resource, limit: 20 }),
      },
    ),
  );
  return parseCommerceActivityResponse(response);
}

export async function readCommerceChanges(
  organisationId: string,
  afterMerchantRevision: CommerceSnapshotRevision,
  fetcher: CommerceGraphFetch = globalThis.fetch.bind(globalThis),
): Promise<CommerceEntityPlaneChanges> {
  const response = await responseJson(
    await fetcher(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/graph/changes?after=${Number(afterMerchantRevision)}&limit=100`,
      { method: "GET", headers: { accept: "application/json" } },
    ),
  );
  if (!isRecord(response) || response.ok !== true) {
    throw new Error("Commerce change response is invalid.");
  }
  return parseEntityPlaneChanges(response.changes);
}

export async function activatePurchasing(
  organisationId: string,
  mutate: CommerceMutationTransport,
): Promise<void> {
  const response = await mutate(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/purchasing/activate`,
    {},
    `commerce-purchasing-activate:${organisationId}`,
  );
  if (!isRecord(response) || response.ok !== true)
    throw new Error("Purchasing activation failed.");
  parsePurchasingPresetPublishResponse(response.publication);
  parsePurchasingReconcileResponse(response.reconciliation);
}

export async function reconcilePurchasing(
  organisationId: string,
  mutate: CommerceMutationTransport,
): Promise<void> {
  const response = await mutate(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/purchasing/reconcile`,
    {},
    `commerce-purchasing-reconcile:${organisationId}`,
  );
  if (!isRecord(response) || response.ok !== true)
    throw new Error("Purchasing reconciliation failed.");
  parsePurchasingReconcileResponse(response.reconciliation);
}

export async function createSupplier(
  organisationId: string,
  supplier: SupplierCreation,
  mutate: CommerceMutationTransport,
): Promise<void> {
  const response = await mutate(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/suppliers`,
    supplier,
    `commerce-supplier-create:${supplier.supplierId}`,
  );
  if (
    !isRecord(response) ||
    response.ok !== true ||
    !isRecord(response.supplier) ||
    response.supplier.supplierId !== supplier.supplierId ||
    !Array.isArray(response.supplier.receipts)
  ) {
    throw new Error("Supplier creation failed.");
  }
  for (const receipt of response.supplier.receipts) {
    const parsed = parseEntityPlaneCommandResult({
      status: "accepted",
      receipt,
    });
    if (parsed.status !== "accepted")
      throw new Error("Supplier receipt is invalid.");
  }
  parsePurchasingReconcileResponse(response.reconciliation);
}

export async function updatePurchaseRequest(
  organisationId: string,
  list: CommerceList,
  entry: CommerceListEntry,
  update: PurchaseRequestUpdate,
  mutate: CommerceMutationTransport,
): Promise<CommerceMutationReceiptV1> {
  if (
    list.listId !== REPLENISHMENT_QUEUE_LIST_ID ||
    entry.listId !== list.listId
  ) {
    throw new Error("The purchase request is outside the Replenishment Queue.");
  }
  const attributeValues = purchaseRequestAttributeValues(list, entry, update);
  const command = buildCommerceListEntryStatusPatchCommand(
    list,
    entry,
    attributeValues,
  );
  const response = await mutate(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/list-entries/${encodeURIComponent(String(entry.entryId))}/patch`,
    command,
    `commerce-purchase-request:${String(entry.entryId)}:${Number(entry.revision)}:${update.purchaseRequestId}`,
  );
  if (!isRecord(response) || response.ok !== true || !("receipt" in response)) {
    throw new Error("The purchase-request response is invalid.");
  }
  const result = parseEntityPlaneCommandResult({
    status: "accepted",
    receipt: response.receipt,
  });
  if (
    result.status !== "accepted" ||
    result.receipt.target.kind !== "commerce_list_entry" ||
    result.receipt.target.entry.entryId !== entry.entryId ||
    Number(result.receipt.target.entry.revision) !== Number(entry.revision) + 1
  ) {
    throw new Error(
      "The purchase-request receipt does not match the requested entry.",
    );
  }
  return result.receipt;
}

export async function patchCommerceListEntryStatus(
  organisationId: string,
  list: CommerceList,
  entry: CommerceListEntry,
  laneAttributeId: AttributeDefinitionId,
  statusOptionId: string,
  mutate: CommerceMutationTransport,
): Promise<CommerceListEntryPatchOutcome> {
  const definition = findListEntryAttributeDefinition(list, laneAttributeId);
  const statusOption =
    definition === undefined
      ? undefined
      : findStatusOption(definition, statusOptionId);
  if (definition === undefined || statusOption === undefined) {
    throw new Error(
      "The requested board lane is not a published status option.",
    );
  }
  const attributeValues = replaceListEntryStatus(
    entry,
    definition,
    statusOption,
  );
  const command = buildCommerceListEntryStatusPatchCommand(
    list,
    entry,
    attributeValues,
  );
  const response = await mutate(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/list-entries/${encodeURIComponent(String(entry.entryId))}/patch`,
    command,
    `commerce-list-entry:${String(entry.entryId)}:${Number(entry.revision)}:${statusOptionId}`,
  );
  return ensureCommerceListEntryPatchOutcomeMatchesEntry(
    parseCommerceListEntryPatchResponse(response),
    entry,
  );
}

export async function publishCommerceSavedViewPresentation(
  organisationId: string,
  view: SavedCommerceView,
  presentationInput: CommerceViewPresentation,
  mutate: CommerceMutationTransport,
): Promise<CommerceMutationReceiptV1> {
  const presentation = parseCommerceViewPresentation(presentationInput);
  const response = await mutate(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/saved-views/${encodeURIComponent(String(view.viewId))}/presentation`,
    { expectedRevision: view.revision, presentation },
    `commerce-saved-view:${String(view.viewId)}:${Number(view.revision)}:${commerceViewPresentationIntentKey(presentation)}`,
  );
  if (!isRecord(response) || response.ok !== true || !("receipt" in response)) {
    throw new Error("The saved-view response is invalid.");
  }
  const result = parseEntityPlaneCommandResult({
    status: "accepted",
    receipt: response.receipt,
  });
  if (
    result.status !== "accepted" ||
    result.receipt.target.kind !== "saved_commerce_view" ||
    result.receipt.target.viewId !== view.viewId ||
    Number(result.receipt.target.revision) !== Number(view.revision) + 1
  ) {
    throw new Error(
      "The saved-view receipt does not match the requested revision.",
    );
  }
  return result.receipt;
}

export async function updateCommerceBoardPresence(
  organisationId: string,
  resourceKey: string,
  selection: CommerceBoardPresenceSelection,
  dragPreview: CommerceBoardDragPreview,
  transport: CommercePresenceTransport,
): Promise<readonly CommerceBoardPresenceEntry[]> {
  const response = await transport(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/board-presence`,
    { resourceKey, selection, dragPreview },
  );
  if (
    !isRecord(response) ||
    response.ok !== true ||
    !Array.isArray(response.presence)
  ) {
    throw new Error("The board presence response is invalid.");
  }
  const entries: CommerceBoardPresenceEntry[] = [];
  for (const entry of response.presence)
    entries.push(parseCommerceBoardPresenceEntry(entry, resourceKey));
  return entries;
}

function ensureCommerceListEntryPatchOutcomeMatchesEntry(
  outcome: CommerceListEntryPatchOutcome,
  entry: CommerceListEntry,
): CommerceListEntryPatchOutcome {
  switch (outcome.kind) {
    case "executed":
      if (
        outcome.receipt.target.kind !== "commerce_list_entry" ||
        outcome.receipt.target.entry.entryId !== entry.entryId ||
        outcome.receipt.target.entry.listId !== entry.listId ||
        Number(outcome.receipt.target.revision) !== Number(entry.revision) + 1
      ) {
        throw new Error(
          "The list-entry patch receipt does not match the requested entry.",
        );
      }
      return outcome;
    case "approval_requested":
      if (
        outcome.action.resourceKey !== commerceListEntryPatchResourceKey(entry)
      ) {
        throw new Error(
          "The list-entry patch approval does not match the requested entry.",
        );
      }
      return outcome;
    default:
      return assertNever(outcome, "Unhandled commerce activity value");
  }
}

function commerceListEntryPatchResourceKey(entry: CommerceListEntry): string {
  return `commerce:list_entry:${String(entry.listId)}:${String(entry.entryId)}:${Number(entry.revision)}`;
}

function commerceViewPresentationIntentKey(
  presentation: CommerceViewPresentation,
): string {
  return presentation.kind === "table"
    ? `table:${presentation.configuration.density}:${presentation.configuration.showRowNumbers ? "numbered" : "plain"}`
    : `board:${String(presentation.configuration.laneAttributeId)}:${commerceBoardCardAttributeIntentKey(presentation.configuration.cardAttributeIds)}`;
}

function commerceBoardCardAttributeIntentKey(
  attributeIds: readonly AttributeDefinitionId[],
): string {
  const values: string[] = [];
  for (const attributeId of attributeIds) values.push(String(attributeId));
  return values.join(",");
}

function buildCommerceListEntryStatusPatchCommand(
  list: CommerceList,
  entry: CommerceListEntry,
  attributeValues: ListEntryAttributeValue[],
): Variant<CommerceEntityPlaneCommand, "patch_commerce_list_entry"> {
  return {
    kind: "patch_commerce_list_entry",
    command: {
      target: {
        entry: {
          entryId: entry.entryId,
          listId: entry.listId,
          revision: entry.revision,
        },
        expectedRevision: entry.revision,
      },
      expectedListRevision: list.publishedRevision,
      attributeValues,
    },
  };
}

function findListEntryAttributeDefinition(
  list: CommerceList,
  attributeId: AttributeDefinitionId,
): ListEntryAttributeDefinition | undefined {
  for (const candidate of list.entryAttributeDefinitions) {
    if (candidate.attributeId === attributeId) return candidate;
  }
  return undefined;
}

function findStatusOption(
  definition: ListEntryAttributeDefinition,
  statusOptionId: string,
): AttributeOption | undefined {
  if (definition.definition.kind.kind !== "status") return undefined;
  for (const option of definition.definition.kind.options) {
    if (option.id === statusOptionId) return option;
  }
  return undefined;
}

function replaceListEntryStatus(
  entry: CommerceListEntry,
  definition: ListEntryAttributeDefinition,
  statusOption: AttributeOption,
): ListEntryAttributeValue[] {
  const values: ListEntryAttributeValue[] = [];
  for (const attribute of entry.attributeValues) {
    if (attribute.attributeId !== definition.attributeId)
      values.push(attribute);
  }
  values.push({
    attributeId: definition.attributeId,
    scope: definition.definition.scope,
    definitionRevision: definition.definition.revision,
    sensitivity: definition.definition.sensitivity,
    value: { kind: "status", value: statusOption.id },
  });
  return values;
}

/**
 * The Home counts. The stock counts read the same records as the Products and
 * Ingredients pages, so the three pages agree. Each read fails by itself, so
 * one that fails leaves the others readable.
 */
export async function readCommerceHomeAggregations(
  organisationId: string,
  fetcher: CommerceGraphFetch = globalThis.fetch.bind(globalThis),
): Promise<readonly CommerceHomeAggregation[]> {
  const [graph, stock] = await Promise.all([
    readHomeGraphCounts(organisationId, fetcher),
    readHomeStockCounts(organisationId, fetcher),
  ]);
  const [openOrders, ...problems] = graph;
  return [
    ...(openOrders === undefined ? [] : [openOrders]),
    ...stock,
    ...problems,
  ];
}

async function readHomeGraphCounts(
  organisationId: string,
  fetcher: CommerceGraphFetch,
): Promise<readonly CommerceHomeAggregation[]> {
  const names: readonly CommerceHomeGraphCountName[] = [
    "home_open_customer_orders",
    "home_payment_failures",
    "home_delayed_shipments",
  ];
  let answers: readonly unknown[] = [];
  try {
    const response = await responseJson(
      await fetcher(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/graph`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            queries: names.map(homeCommerceAggregationQuery),
          }),
        },
      ),
    );
    if (isRecord(response) && Array.isArray(response.results))
      answers = response.results;
  } catch {
    answers = [];
  }
  return names.map((name, index) => namedHomeAggregation(name, answers[index]));
}

async function readHomeStockCounts(
  organisationId: string,
  fetcher: CommerceGraphFetch,
): Promise<readonly CommerceHomeAggregation[]> {
  try {
    const { rows } = parseInventory(
      await responseJson(
        await fetcher(
          `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/inventory`,
          { headers: { accept: "application/json" } },
        ),
      ),
    );
    const shortages = rows.filter(needsReorder);
    const supplies = shortages.filter(isSupplyRow).length;
    return [
      homeStockCount("home_product_shortages", shortages.length - supplies),
      homeStockCount("home_supply_shortages", supplies),
    ];
  } catch {
    return [
      homeAggregationUnavailable("home_product_shortages"),
      homeAggregationUnavailable("home_supply_shortages"),
    ];
  }
}

function isSupplyRow(row: Readonly<{ kind: string }>): boolean {
  return row.kind === "supply";
}

function homeStockCount(
  name: CommerceHomeAggregationName,
  value: number,
): CommerceHomeAggregation {
  return {
    name,
    result: { kind: "count", value: BigInt(value) },
    merchantRevision: null,
  };
}

export function entityTypePageQuery(
  typeId: SystemCommerceEntityKind,
  pagination: CommercePagination = { limit: 50, cursor: null },
): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "entity_type_page",
    entityTypeId: systemEntityTypeId(typeId),
    filter: allFilter(),
    sorts: [],
    pagination,
    traversal: TABLE_TRAVERSAL,
  });
}

export function searchEntityTypeQuery(
  text: string,
  typeId: SystemCommerceEntityKind,
  pagination: CommercePagination = { limit: 50, cursor: null },
): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "search",
    text,
    entityTypeId: systemEntityTypeId(typeId),
    pagination,
    traversal: TABLE_TRAVERSAL,
  });
}

export function entityDossierQuery(
  reference: CommerceEntityRef,
): CommerceGraphQuery {
  return relationshipTraversalQuery(reference);
}

export function commerceCollectionQuery(
  selection: CommerceCollectionSelectionInput,
  pagination: CommercePagination = { limit: 50, cursor: null },
): CommerceGraphQuery {
  switch (selection.kind) {
    case "commerce_list":
      return parseCommerceGraphQuery({
        kind: "commerce_list_page",
        listId: selection.listId,
        filter: allFilter(),
        sorts: [],
        pagination,
      });
    case "saved_commerce_view":
      return parseCommerceGraphQuery({
        kind: "saved_commerce_view",
        viewId: selection.viewId,
        pagination,
      });
    default:
      return assertNever(selection, "Unhandled commerce activity value");
  }
}

export function systemEntityRef(
  typeId: SystemCommerceEntityKind,
  entityId: string,
): CommerceEntityRef {
  const query = parseCommerceGraphQuery({
    kind: "entity_by_ref",
    reference: { origin: "system", typeId, entityId },
    traversal: { maxDepth: 0, resultLimit: 1 },
    filter: null,
  });
  if (query.kind !== "entity_by_ref")
    throw new Error("Commerce reference query changed shape.");
  return query.reference;
}

export function customEntityRef(
  typeId: string,
  entityId: string,
): CustomCommerceEntityRef {
  const query = parseCommerceGraphQuery({
    kind: "entity_by_ref",
    reference: { origin: "custom", typeId, entityId },
    traversal: { maxDepth: 0, resultLimit: 1 },
    filter: null,
  });
  if (query.kind !== "entity_by_ref" || query.reference.origin !== "custom") {
    throw new Error("Commerce custom reference query changed shape.");
  }
  return query.reference;
}

function relationshipTraversalQuery(
  seed: CommerceEntityRef,
): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "relationship_traversal",
    seeds: [seed],
    relationshipDefinition: null,
    traversal: DOSSIER_TRAVERSAL,
    filter: null,
  });
}

function commerceAggregationQuery(
  typeId: SystemCommerceEntityKind,
  filter: CommerceFilter = allFilter(),
): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "aggregation",
    source: { kind: "entity_type", entityTypeId: systemEntityTypeId(typeId) },
    filter,
    aggregation: { kind: "count" },
  });
}

function homeCommerceAggregationQuery(
  name: CommerceHomeGraphCountName,
): CommerceGraphQuery {
  switch (name) {
    case "home_open_customer_orders":
      return commerceAggregationQuery("order", {
        kind: "not",
        filter: {
          kind: "any",
          filters: [lifecycleFilter("fulfilled"), lifecycleFilter("cancelled")],
        },
      });
    case "home_payment_failures":
      return commerceAggregationQuery(
        "payment",
        attributeFilter("lifecycle", { kind: "status", value: "failed" }),
      );
    case "home_delayed_shipments":
      return commerceAggregationQuery(
        "shipment",
        attributeFilter("lifecycle", {
          kind: "status",
          value: "delivery_exception",
        }),
      );
  }
}

function systemEntityTypeId(
  typeId: SystemCommerceEntityKind,
): CommerceEntityTypeId {
  return { origin: "system", typeId };
}

function allFilter(): CommerceFilter {
  return { kind: "all" };
}

function namedHomeAggregation(
  name: CommerceHomeAggregationName,
  answer: unknown,
): CommerceHomeAggregation {
  const parsed = parseCommerceGraphQueryResult(answer);
  return parsed.ok
    ? {
        name,
        result: parsed.value.aggregations[0] ?? null,
        merchantRevision: parsed.value.merchantRevision,
      }
    : homeAggregationUnavailable(name);
}

function homeAggregationUnavailable(
  name: CommerceHomeAggregationName,
): CommerceHomeAggregation {
  return { name, result: null, merchantRevision: null };
}

function lifecycleFilter(value: "fulfilled" | "cancelled"): CommerceFilter {
  return attributeFilter("lifecycle", { kind: "status", value });
}

function attributeFilter(
  attributeId: string,
  value: Readonly<
    { kind: "boolean"; value: boolean } | { kind: "status"; value: string }
  >,
): CommerceFilter {
  const query = parseCommerceGraphQuery({
    kind: "aggregation",
    source: { kind: "entity_type", entityTypeId: systemEntityTypeId("order") },
    filter: {
      kind: "attribute",
      filter: { operator: "equals", attributeId, value },
    },
    aggregation: { kind: "count" },
  });
  if (query.kind !== "aggregation")
    throw new Error("Commerce aggregation filter changed shape.");
  return query.filter;
}
