import React from "react";
import type {
  CommerceEntity,
  CommerceListEntry,
} from "@purin-labs/commerce-contracts";
import {
  REPLENISHMENT_QUEUE_LIST_ID,
  REPLENISHMENT_QUEUE_VIEW_ID,
  SUPPLIER_DIRECTORY_LIST_ID,
} from "@purin-labs/commerce-client";
import { StatusChip } from "@purin-labs/ui/page-components";
import type { StatusChipStatus } from "@purin-labs/ui/status-chip";
import { renderCommerceFact, type CommerceBoardListFact } from "./board-list";
import { commerceBoardFactText, listAttributeDefinition } from "./board-rows";
import {
  buildPublishedCommerceCollectionModel,
  findCommerceCollectionDefinition,
  type CommerceCollectionRow,
  type CommercePublishedCollectionModel,
} from "./models";
import {
  commerceCollectionQuery,
  readCommerceGraph,
  readPublishedCommerceResources,
  type CommerceCollectionSelection,
  type CommerceGraphFetch,
  type CommercePublishedResourceMetadata,
} from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";
import { purchaseRequestRowSummary } from "./purchasing-controls";
import {
  COMMERCE_VALUE_ABSENT,
  commerceAttributeLabel,
  commerceStatusChip,
  formatCommerceAttributeValue,
} from "./presentation";
import "./supplier-directory.css";

/**
 * The reads that join the two purchasing lists: the Replenishment Queue shows
 * each supplier's name from the Supplier Directory, and a supplier's record
 * page shows its directory entry and its open requests in the queue. The
 * directory tab itself is the table of its published list.
 */

/** One open purchase request of a supplier, as its record page shows it. */
type SupplierOpenRequest = Readonly<{
  key: string;
  item: string;
  /** The amount and the due day, such as "12 kg · Due 3 Sep". */
  detail: string;
  status: StatusChipStatus;
}>;

/** The open requests of each supplier, by supplier id. */
type SupplierRequests = ReadonlyMap<string, readonly SupplierOpenRequest[]>;

export const NO_SUPPLIER_NAMES: ReadonlyMap<string, string> = new Map();
const NO_REQUESTS: SupplierRequests = new Map();
const NO_SUPPLIER_REQUESTS: readonly SupplierOpenRequest[] = [];

/**
 * The queue stores each supplier as its id in plain text, so it reads the
 * directory for the names. A failed read leaves the id in the cell, which is
 * worse than a name but better than an empty cell.
 */
export async function loadSupplierNames(
  organisationId: string,
  model: CommercePublishedCollectionModel,
  metadata: CommercePublishedResourceMetadata,
  fetcher: CommerceGraphFetch | undefined,
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
  if (model.list?.listId !== REPLENISHMENT_QUEUE_LIST_ID) return names;
  const directory = metadata.lists.find(isSupplierDirectoryList);
  if (directory === undefined) return names;
  try {
    const result = await readCommerceGraph(
      organisationId,
      commerceCollectionQuery({
        kind: "commerce_list",
        listId: directory.listId,
      }),
      fetcher,
    );
    for (const entity of result.entities)
      names.set(String(entity.reference.entityId), entity.displayName);
  } catch {
    // The queue still renders; supplier cells fall back to their identifier.
  }
  return names;
}

async function readSupplierRequests(
  organisationId: string,
  metadata: CommercePublishedResourceMetadata,
  fetcher: CommerceGraphFetch | undefined,
): Promise<SupplierRequests> {
  const selection = replenishmentQueueSelection(metadata);
  const definition =
    selection === null
      ? null
      : findCommerceCollectionDefinition(metadata, selection);
  if (selection === null || definition === null) return NO_REQUESTS;
  try {
    const model = buildPublishedCommerceCollectionModel(
      await readCommerceGraph(
        organisationId,
        commerceCollectionQuery(selection),
        fetcher,
      ),
      definition,
    );
    return model.ok ? supplierRequestsOf(model.value) : NO_REQUESTS;
  } catch {
    return NO_REQUESTS;
  }
}

/** The queue's view, which leaves out received entries, else its list. */
function replenishmentQueueSelection(
  metadata: CommercePublishedResourceMetadata,
): CommerceCollectionSelection | null {
  for (const view of metadata.views)
    if (view.viewId === REPLENISHMENT_QUEUE_VIEW_ID)
      return { kind: "saved_commerce_view", viewId: view.viewId };
  for (const list of metadata.lists)
    if (list.listId === REPLENISHMENT_QUEUE_LIST_ID)
      return { kind: "commerce_list", listId: list.listId };
  return null;
}

function supplierRequestsOf(
  model: CommercePublishedCollectionModel,
): SupplierRequests {
  const requests = new Map<string, SupplierOpenRequest[]>();
  const statusKind = listAttributeDefinition(model, "status")?.definition.kind;
  for (const row of model.rows) {
    const status = listEntryStatus(row.entry);
    const text = commerceBoardFactText.bind(
      null,
      model,
      NO_SUPPLIER_NAMES,
      row,
    );
    const supplierId = text("supplier_id");
    if (status?.value === "received" || supplierId.length === 0) continue;
    const [amount, due] = purchaseRequestRowSummary(row.entry, text).columns;
    const request: SupplierOpenRequest = {
      key: `${String(row.entry.listId)}:${String(row.entry.entryId)}`,
      item: row.entity.displayName,
      detail: `${amount?.text ?? COMMERCE_VALUE_ABSENT} · ${due?.text ?? ""}`,
      status: (status === undefined
        ? null
        : commerceStatusChip(status, statusKind)) ?? {
        kind: "neutral",
        label: "Open",
      },
    };
    const own = requests.get(supplierId);
    if (own === undefined) requests.set(supplierId, [request]);
    else own.push(request);
  }
  return requests;
}

function listEntryStatus(entry: CommerceListEntry) {
  for (const attribute of entry.attributeValues)
    if (
      String(attribute.attributeId) === "status" &&
      attribute.value.kind === "status"
    )
      return attribute.value;
  return undefined;
}

export function isSupplierDirectoryList(
  list: CommercePublishedResourceMetadata["lists"][number],
): boolean {
  return list.listId === SUPPLIER_DIRECTORY_LIST_ID;
}

/** A directory entry's values as text, and the published label of each. */
type SupplierEntryText = Readonly<{
  text: (attributeId: string) => string;
  label: (attributeId: string) => string;
}>;

function supplierEntryText(
  model: CommercePublishedCollectionModel,
  row: CommerceCollectionRow,
): SupplierEntryText {
  return {
    text: commerceBoardFactText.bind(null, model, NO_SUPPLIER_NAMES, row),
    label: publishedAttributeLabel.bind(null, model),
  };
}

function publishedAttributeLabel(
  model: CommercePublishedCollectionModel,
  attributeId: string,
): string {
  return commerceAttributeLabel(
    attributeId,
    listAttributeDefinition(model, attributeId),
  );
}

/** The terms of the directory entry: lead time, minimum order and notes. */
function supplierOrderingFacts(
  entry: SupplierEntryText,
): readonly CommerceBoardListFact[] {
  return [
    {
      id: "lead_time_days",
      label: "Lead time",
      value: leadTimeText(entry.text("lead_time_days")),
      numeric: true,
    },
    {
      id: "minimum_order_quantity",
      label: entry.label("minimum_order_quantity"),
      value: minimumOrderText(entry) ?? COMMERCE_VALUE_ABSENT,
      numeric: true,
    },
    supplierTextFact(entry, "purchasing_notes"),
  ];
}

/**
 * Who the supplier is: the contact of its directory entry, then its own
 * record facts (legal name, country). Without an entry, only the record facts.
 */
function supplierCompanyFacts(
  entity: CommerceEntity,
  entry: SupplierEntryText | null,
): readonly CommerceBoardListFact[] {
  const facts: CommerceBoardListFact[] =
    entry === null
      ? []
      : ["contact_name", "email", "phone"].map(
          supplierTextFact.bind(null, entry),
        );
  for (const attribute of entity.attributes) {
    const id = String(attribute.attributeId);
    facts.push({
      id,
      // The record stores a country code; the page names it "Country", as
      // the Add supplier dialog does.
      label:
        id === "country_code"
          ? "Country"
          : commerceAttributeLabel(id, undefined),
      value:
        formatCommerceAttributeValue(attribute.value, undefined) ||
        COMMERCE_VALUE_ABSENT,
      numeric: false,
    });
  }
  return facts;
}

/** A titled group of facts: one framed list, a label and a value in each row. */
function SupplierFactGroup(
  props: Readonly<{
    id: string;
    title: string;
    facts: readonly CommerceBoardListFact[];
  }>,
): React.ReactNode {
  if (props.facts.length === 0) return null;
  return (
    <section className="commerce-dossier-section" aria-labelledby={props.id}>
      <h3 id={props.id}>{props.title}</h3>
      <dl className="commerce-fact-rows">
        {props.facts.map(renderCommerceFact)}
      </dl>
    </section>
  );
}

function supplierTextFact(
  entry: SupplierEntryText,
  attributeId: string,
): CommerceBoardListFact {
  return {
    id: attributeId,
    label: entry.label(attributeId),
    value: entry.text(attributeId) || COMMERCE_VALUE_ABSENT,
    numeric: false,
  };
}

/** "3 days", or a dash when the entry has no lead time. */
function leadTimeText(days: string): string {
  if (days.length === 0) return COMMERCE_VALUE_ABSENT;
  return days === "1" ? "1 day" : `${days} days`;
}

/** "10 case", or null when the supplier sets no minimum. */
function minimumOrderText(entry: SupplierEntryText): string | null {
  const quantity = entry.text("minimum_order_quantity");
  if (quantity.length === 0) return null;
  return `${quantity} ${entry.text("minimum_order_unit")}`.trim();
}

/** A supplier's open requests: the item, its amount and due day, its lane. */
function SupplierOpenRequests(
  props: Readonly<{ requests: readonly SupplierOpenRequest[] }>,
): React.ReactNode {
  if (props.requests.length === 0) return null;
  return (
    <section
      className="commerce-dossier-section"
      aria-labelledby="supplier-requests-title"
    >
      <h3 id="supplier-requests-title">Open requests</h3>
      <ul className="supplier-request-rows">
        {props.requests.map(renderSupplierRequest)}
      </ul>
    </section>
  );
}

function renderSupplierRequest(request: SupplierOpenRequest): React.ReactNode {
  return (
    <li key={request.key}>
      <span>
        <strong>{request.item}</strong>
        <small>{request.detail}</small>
      </span>
      <StatusChip status={request.status} />
    </li>
  );
}

type SupplierRecordRead =
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "ready";
      entry: SupplierEntryText | null;
      requests: readonly SupplierOpenRequest[];
    }>;

/**
 * The body of a supplier's record page: Ordering, the open requests, the items
 * they supply, Company, then the history. The record read carries no directory
 * entry, so this reads the directory and the queue. Until they answer, or when
 * they fail, the page shows the record's own facts and no Ordering group.
 */
export function SupplierRecordDetails(
  props: Readonly<{
    organisationId: string;
    fetcher: CommerceGraphFetch | undefined;
    entity: CommerceEntity;
    /** The "Items they supply" section, or null when no item is linked. */
    items: React.ReactNode;
    /** The sections that close the page, Activity last. */
    history: React.ReactNode;
  }>,
): React.ReactNode {
  const supplierId = String(props.entity.reference.entityId);
  const [record, setRecord] = React.useState<SupplierRecordRead>({
    kind: "loading",
  });
  React.useEffect(
    loadSupplierRecordEffect.bind(
      null,
      props.organisationId,
      supplierId,
      props.fetcher,
      setRecord,
    ),
    [props.organisationId, supplierId, props.fetcher],
  );
  const entry = record.kind === "ready" ? record.entry : null;
  return (
    <div className="supplier-record">
      {entry === null ? null : (
        <SupplierFactGroup
          id="supplier-ordering-title"
          title="Ordering"
          facts={supplierOrderingFacts(entry)}
        />
      )}
      <SupplierOpenRequests
        requests={
          record.kind === "ready" ? record.requests : NO_SUPPLIER_REQUESTS
        }
      />
      {props.items}
      <SupplierFactGroup
        id="supplier-company-title"
        title="Company"
        facts={supplierCompanyFacts(props.entity, entry)}
      />
      {props.history}
    </div>
  );
}

function loadSupplierRecordEffect(
  organisationId: string,
  supplierId: string,
  fetcher: CommerceGraphFetch | undefined,
  setRecord: React.Dispatch<React.SetStateAction<SupplierRecordRead>>,
): () => void {
  const state = { cancelled: false };
  setRecord({ kind: "loading" });
  void readSupplierRecord(organisationId, supplierId, fetcher).then(
    setSupplierRecordUnlessCancelled.bind(null, state, setRecord),
  );
  return cancelSupplierRecordRead.bind(null, state);
}

function setSupplierRecordUnlessCancelled(
  state: { cancelled: boolean },
  setRecord: React.Dispatch<React.SetStateAction<SupplierRecordRead>>,
  record: SupplierRecordRead,
): void {
  if (!state.cancelled) setRecord(record);
}

function cancelSupplierRecordRead(state: { cancelled: boolean }): void {
  state.cancelled = true;
}

async function readSupplierRecord(
  organisationId: string,
  supplierId: string,
  fetcher: CommerceGraphFetch | undefined,
): Promise<SupplierRecordRead> {
  try {
    const metadata = await readPublishedCommerceResources(
      organisationId,
      fetcher,
    );
    const [entry, requests] = await Promise.all([
      readSupplierDirectoryEntry(organisationId, supplierId, metadata, fetcher),
      readSupplierRequests(organisationId, metadata, fetcher),
    ]);
    return {
      kind: "ready",
      entry,
      requests: requests.get(supplierId) ?? NO_SUPPLIER_REQUESTS,
    };
  } catch {
    return { kind: "ready", entry: null, requests: NO_SUPPLIER_REQUESTS };
  }
}

/** The supplier's entry in the first page of the directory, as the tab reads it. */
async function readSupplierDirectoryEntry(
  organisationId: string,
  supplierId: string,
  metadata: CommercePublishedResourceMetadata,
  fetcher: CommerceGraphFetch | undefined,
): Promise<SupplierEntryText | null> {
  const directory = metadata.lists.find(isSupplierDirectoryList);
  if (directory === undefined) return null;
  const selection: CommerceCollectionSelection = {
    kind: "commerce_list",
    listId: directory.listId,
  };
  const definition = findCommerceCollectionDefinition(metadata, selection);
  if (definition === null) return null;
  const model = buildPublishedCommerceCollectionModel(
    await readCommerceGraph(
      organisationId,
      commerceCollectionQuery(selection),
      fetcher,
    ),
    definition,
  );
  if (!model.ok) return null;
  const row = model.value.rows.find(rowHasSupplierId.bind(null, supplierId));
  return row === undefined ? null : supplierEntryText(model.value, row);
}

function rowHasSupplierId(
  supplierId: string,
  row: CommerceCollectionRow,
): boolean {
  return String(row.entity.reference.entityId) === supplierId;
}
