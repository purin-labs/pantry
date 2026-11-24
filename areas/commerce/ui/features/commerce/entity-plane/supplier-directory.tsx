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
import { Select } from "@purin-labs/ui/select";
import { StatusChip } from "@purin-labs/ui/page-components";
import type { StatusChipStatus } from "@purin-labs/ui/status-chip";
import {
  CommerceBoardEntryDrawer,
  CommerceBoardList,
  renderCommerceFact,
  type CommerceBoardListFact,
  type CommerceBoardListLane,
  type CommerceBoardListRow,
} from "./board-list";
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
} from "./api";
import { purchaseRequestRowSummary } from "./purchasing-controls";
import {
  COMMERCE_VALUE_ABSENT,
  commerceAttributeLabel,
  commerceStatusChip,
  formatCommerceAttributeValue,
} from "./presentation";
import { SUPPLIER_SORTS, renderCommerceSelectParts } from "./select-items";
import "./supplier-directory.css";

/**
 * The Supplier Directory of the Purchasing page, as the same list as the
 * Replenishment Queue: filters by each supplier's open requests, one row for
 * each supplier, a sort, and one drawer with the supplier's facts and its open
 * requests. The supplier's record page shows the same facts. The reads that
 * join the two purchasing lists live here too.
 */

/** One open purchase request of a supplier, as its drawer and record show it. */
type SupplierOpenRequest = Readonly<{
  key: string;
  item: string;
  /** The amount and the due day, such as "12 kg · Due 3 Sep". */
  detail: string;
  status: StatusChipStatus;
  late: boolean;
}>;

type SupplierRequests = ReadonlyMap<string, readonly SupplierOpenRequest[]>;

/** What one purchasing list reads from the other. */
export type PurchasingReads = Readonly<{
  /** Supplier names for the ids that the queue stores as plain text. */
  names: ReadonlyMap<string, string>;
  /** The open requests of each supplier, by supplier id. */
  supplierRequests: SupplierRequests;
}>;

const NO_NAMES: ReadonlyMap<string, string> = new Map();
const NO_REQUESTS: SupplierRequests = new Map();
const NO_SUPPLIER_REQUESTS: readonly SupplierOpenRequest[] = [];
export const NO_PURCHASING_READS: PurchasingReads = {
  names: NO_NAMES,
  supplierRequests: NO_REQUESTS,
};

/**
 * The queue shows each supplier's name, so it reads the directory; the
 * directory shows each supplier's open requests, so it reads the queue. A
 * failed read leaves the list as it is: an id for a name, no request counts.
 */
export async function loadPurchasingReads(
  organisationId: string,
  model: CommercePublishedCollectionModel,
  metadata: CommercePublishedResourceMetadata,
  fetcher: CommerceGraphFetch | undefined,
): Promise<PurchasingReads> {
  const listId = model.list?.listId;
  if (listId === REPLENISHMENT_QUEUE_LIST_ID)
    return {
      names: await readSupplierNames(organisationId, metadata, fetcher),
      supplierRequests: NO_REQUESTS,
    };
  if (listId === SUPPLIER_DIRECTORY_LIST_ID)
    return {
      names: NO_NAMES,
      supplierRequests: await readSupplierRequests(
        organisationId,
        metadata,
        fetcher,
      ),
    };
  return NO_PURCHASING_READS;
}

async function readSupplierNames(
  organisationId: string,
  metadata: CommercePublishedResourceMetadata,
  fetcher: CommerceGraphFetch | undefined,
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
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
    const text = commerceBoardFactText.bind(null, model, NO_NAMES, row);
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
      late: status?.value === "late",
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

export function isSupplierDirectoryModel(
  model: CommercePublishedCollectionModel,
): boolean {
  return model.list?.listId === SUPPLIER_DIRECTORY_LIST_ID;
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
    text: commerceBoardFactText.bind(null, model, NO_NAMES, row),
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

/**
 * A supplier's facts: its directory entry (contact, terms and notes), then its
 * own record facts (legal name, country code). Without an entry, only the
 * record facts.
 */
function supplierFacts(
  entity: CommerceEntity,
  entry: SupplierEntryText | null,
): readonly CommerceBoardListFact[] {
  const facts: CommerceBoardListFact[] =
    entry === null
      ? []
      : [
          ...["contact_name", "email", "phone"].map(
            supplierTextFact.bind(null, entry),
          ),
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
  for (const attribute of entity.attributes) {
    const id = String(attribute.attributeId);
    facts.push({
      id,
      label: commerceAttributeLabel(id, undefined),
      value:
        formatCommerceAttributeValue(attribute.value, undefined) ||
        COMMERCE_VALUE_ABSENT,
      numeric: false,
    });
  }
  return facts;
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

/** Each supplier with its open requests, for the list, its lanes and sorts. */
type SupplierListEntry = Readonly<{
  row: CommerceCollectionRow;
  entry: SupplierEntryText;
  requests: readonly SupplierOpenRequest[];
  laneId: SupplierLaneId;
}>;

type SupplierLaneId = "open" | "late" | "none";

const SUPPLIER_LANES: readonly Readonly<{
  id: SupplierLaneId;
  label: string;
}>[] = [
  { id: "open", label: "Open requests" },
  { id: "late", label: "Late" },
  { id: "none", label: "No open requests" },
];

type SupplierSort = "name" | "lead_time" | "open_requests";

export function SupplierDirectoryList(
  props: Readonly<{
    label: string;
    model: CommercePublishedCollectionModel;
    requests: SupplierRequests;
    recordHref: (entity: CommerceEntity) => string | null;
  }>,
): React.ReactNode {
  const [sort, setSort] = React.useState<SupplierSort>("name");
  const suppliers = props.model.rows.map(
    supplierListEntry.bind(null, props.model, props.requests),
  );
  const sorted = [...suppliers].sort(supplierOrder.bind(null, sort));
  return (
    <CommerceBoardList
      label={props.label}
      lanes={SUPPLIER_LANES.map(supplierLane.bind(null, suppliers))}
      rows={sorted.map(supplierBoardRow.bind(null, props.recordHref))}
      controls={
        <Select.Root
          items={SUPPLIER_SORTS}
          value={sort}
          onValueChange={selectSupplierSort.bind(null, setSort)}
        >
          {renderCommerceSelectParts(SUPPLIER_SORTS, "Sort suppliers")}
        </Select.Root>
      }
    />
  );
}

function selectSupplierSort(
  setSort: React.Dispatch<React.SetStateAction<SupplierSort>>,
  value: string | null,
): void {
  if (value === "name" || value === "lead_time" || value === "open_requests")
    setSort(value);
}

function supplierListEntry(
  model: CommercePublishedCollectionModel,
  requests: SupplierRequests,
  row: CommerceCollectionRow,
): SupplierListEntry {
  const own =
    requests.get(String(row.entity.reference.entityId)) ?? NO_SUPPLIER_REQUESTS;
  return {
    row,
    entry: supplierEntryText(model, row),
    requests: own,
    laneId: own.some(isLateRequest) ? "late" : own.length > 0 ? "open" : "none",
  };
}

function supplierLane(
  suppliers: readonly SupplierListEntry[],
  lane: (typeof SUPPLIER_LANES)[number],
): CommerceBoardListLane {
  return {
    id: lane.id,
    label: lane.label,
    count: suppliers.filter(supplierInLane.bind(null, lane.id)).length,
  };
}

function supplierInLane(
  laneId: SupplierLaneId,
  supplier: SupplierListEntry,
): boolean {
  return supplier.laneId === laneId;
}

/**
 * By name; by lead time, the shortest first; or by open requests, the
 * suppliers with a late request first, then the most requests. Ties go by
 * name.
 */
function supplierOrder(
  sort: SupplierSort,
  left: SupplierListEntry,
  right: SupplierListEntry,
): number {
  const byName = left.row.entity.displayName.localeCompare(
    right.row.entity.displayName,
  );
  switch (sort) {
    case "name":
      return byName;
    case "lead_time":
      return leadTimeDays(left) - leadTimeDays(right) || byName;
    case "open_requests":
      return (
        Number(right.laneId === "late") - Number(left.laneId === "late") ||
        right.requests.length - left.requests.length ||
        byName
      );
  }
}

function leadTimeDays(supplier: SupplierListEntry): number {
  const days = Number.parseInt(supplier.entry.text("lead_time_days"), 10);
  return Number.isNaN(days) ? Number.POSITIVE_INFINITY : days;
}

function isLateRequest(request: SupplierOpenRequest): boolean {
  return request.late;
}

/**
 * One supplier as a list row: the contact under the name, then the email, the
 * lead time and the minimum order, and a tag for its open requests.
 */
function supplierBoardRow(
  recordHref: (entity: CommerceEntity) => string | null,
  supplier: SupplierListEntry,
): CommerceBoardListRow {
  const { row, entry, requests } = supplier;
  const contact = entry.text("contact_name");
  const email = entry.text("email");
  const leadTime = leadTimeText(entry.text("lead_time_days"));
  const minimum = minimumOrderText(entry);
  return {
    key: `${String(row.entry.listId)}:${String(row.entry.entryId)}`,
    laneId: supplier.laneId,
    name: row.entity.displayName,
    secondary: contact.length === 0 ? null : contact,
    columns: [
      {
        id: "email",
        text: email.length === 0 ? "No email" : email,
        numeric: false,
      },
      {
        id: "lead_time_days",
        text:
          leadTime === COMMERCE_VALUE_ABSENT
            ? leadTime
            : `${leadTime} lead time`,
        numeric: true,
      },
      {
        id: "minimum_order",
        text: minimum === null ? "No minimum set" : `Minimum ${minimum}`,
        numeric: false,
      },
    ],
    laneTag:
      requests.length === 0 ? null : (
        <StatusChip status={supplierRequestsTag(supplier)} />
      ),
    drawer: renderSupplierDrawer.bind(null, recordHref, supplier),
  };
}

/** "1 late" when a request is late, else "2 open". */
function supplierRequestsTag(supplier: SupplierListEntry): StatusChipStatus {
  const late = supplier.requests.filter(isLateRequest).length;
  return late > 0
    ? { kind: "danger", label: `${late} late` }
    : { kind: "neutral", label: `${supplier.requests.length} open` };
}

function renderSupplierDrawer(
  recordHref: (entity: CommerceEntity) => string | null,
  supplier: SupplierListEntry,
  open: boolean,
  close: () => void,
): React.ReactNode {
  return (
    <CommerceBoardEntryDrawer
      open={open}
      close={close}
      title={supplier.row.entity.displayName}
      href={recordHref(supplier.row.entity)}
      facts={supplierFacts(supplier.row.entity, supplier.entry)}
      laneControl={null}
    >
      <SupplierOpenRequests
        className="supplier-drawer-requests"
        requests={supplier.requests}
      />
    </CommerceBoardEntryDrawer>
  );
}

/** A supplier's open requests: the item, its amount and due day, its lane. */
function SupplierOpenRequests(
  props: Readonly<{
    className: string;
    requests: readonly SupplierOpenRequest[];
  }>,
): React.ReactNode {
  const headingId = React.useId();
  if (props.requests.length === 0) return null;
  return (
    <section className={props.className} aria-labelledby={headingId}>
      <h3 id={headingId}>Open requests</h3>
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
 * The Details and the open requests of a supplier's record page. The record
 * read carries no directory entry, so this reads the directory and the queue.
 * Until they answer, or when they fail, Details shows the record's own facts.
 */
export function SupplierRecordDetails(
  props: Readonly<{
    organisationId: string;
    fetcher: CommerceGraphFetch | undefined;
    entity: CommerceEntity;
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
  return (
    <>
      <section
        className="commerce-dossier-section"
        aria-labelledby="commerce-attributes-title"
      >
        <h3 id="commerce-attributes-title">Details</h3>
        <dl className="commerce-facts">
          {supplierFacts(
            props.entity,
            record.kind === "ready" ? record.entry : null,
          ).map(renderCommerceFact)}
        </dl>
      </section>
      <SupplierOpenRequests
        className="commerce-dossier-section"
        requests={
          record.kind === "ready" ? record.requests : NO_SUPPLIER_REQUESTS
        }
      />
    </>
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
