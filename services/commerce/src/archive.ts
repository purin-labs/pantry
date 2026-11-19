// The archive (Plan 76A step 5). Finished orders and old events move from
// the merchant DO to R2 files that never change. Each record is its own gzip
// member, so one range read returns one record.
//
// The write order is safe after a crash:
// 1. Build each file and its index from one batch; the bytes are the same for
//    the same batch.
// 2. Write both objects to R2, or find them already there with the same
//    digest from an interrupted run.
// 3. In one transaction, record an entry for each record and delete the
//    source rows, after checking that no source row changed since step 1.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  parseCommerceDelivery,
  parseFulfillment,
  parseOrder,
  parseOrderChange,
  parsePayment,
  parseRefundAttempt,
  parseReturn,
  parseShipment,
  type CommerceArchiveFileV1,
  type CommerceArchiveRunV1,
  type CommerceEventV1,
  type CommerceOrderRecordV1,
} from "@purin-labs/commerce-client";
import { canonicalJson } from "@purin-labs/std";

import type { CommerceDatabase, CommerceSqlValue } from "./database.ts";
import { parseCursor, readEventPage } from "./event-feed.ts";

export interface ArchiveStore {
  head(key: string): Promise<Readonly<{ sha256: string; size: number }> | null>;
  put(key: string, body: Uint8Array, sha256: string): Promise<void>;
  read(key: string, offset: number, length: number): Promise<Uint8Array | null>;
}

/** The R2 bucket binding, as far as the archive uses it. */
export type R2BucketLike = Readonly<{
  head: (key: string) => Promise<{
    size: number;
    customMetadata?: Record<string, string>;
  } | null>;
  put: (
    key: string,
    body: Uint8Array,
    options: Readonly<{ customMetadata: Record<string, string> }>,
  ) => Promise<unknown>;
  get: (
    key: string,
    options: Readonly<{ range: Readonly<{ offset: number; length: number }> }>,
  ) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null>;
}>;

export class R2ArchiveStore implements ArchiveStore {
  readonly #bucket: R2BucketLike;

  constructor(bucket: R2BucketLike) {
    this.#bucket = bucket;
  }

  async head(key: string) {
    const object = await this.#bucket.head(key);
    const sha256 = object?.customMetadata?.sha256;
    return object === null || sha256 === undefined
      ? null
      : { sha256, size: object.size };
  }

  async put(key: string, body: Uint8Array, sha256: string): Promise<void> {
    await this.#bucket.put(key, body, { customMetadata: { sha256 } });
  }

  async read(key: string, offset: number, length: number) {
    const object = await this.#bucket.get(key, { range: { offset, length } });
    return object === null ? null : new Uint8Array(await object.arrayBuffer());
  }
}

export type ArchiveOptions = Readonly<{
  /** Days since an order's last change before it may move. */
  orderDelayDays: number;
  /** Days before a delivered event may move. */
  eventRetentionDays: number;
  batchSize: number;
}>;

const DEFAULT_ARCHIVE_OPTIONS: ArchiveOptions = {
  orderDelayDays: 180,
  eventRetentionDays: 90,
  batchSize: 500,
};

const DAY_MS = 24 * 60 * 60 * 1_000;

type Row = Readonly<Record<string, unknown>>;

/** Every table that holds part of an order, children after parents. */
const ORDER_TABLES = [
  "commerce_order",
  "payment",
  "fulfillment",
  "shipment",
  "shipment_label_rate",
  "shipment_label_attempt",
  "refund_attempt",
  "payment_dispute",
  "order_return",
  "order_change",
  "manual_tender",
] as const;

type OrderTable = (typeof ORDER_TABLES)[number];

type OrderBundle = Readonly<{
  orderId: string;
  lastChangedAt: string;
  tables: Readonly<Record<OrderTable, readonly Row[]>>;
}>;

type PlannedRecord = Readonly<{ id: string; month: string; json: string; revision: number | null }>;

type PlannedFile = Readonly<{
  kind: "orders" | "events";
  month: string;
  sequence: number;
  key: string;
  body: Buffer;
  sha256: string;
  entries: readonly Readonly<{
    id: string;
    offset: number;
    length: number;
    sha256: string;
    revision: number | null;
    json: string;
  }>[];
}>;

export class ArchiveAuthority {
  readonly #database: CommerceDatabase;
  readonly #now: () => string;

  constructor(database: CommerceDatabase, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  async run(
    merchantId: string,
    store: ArchiveStore,
    options: ArchiveOptions = DEFAULT_ARCHIVE_OPTIONS,
  ): Promise<CommerceArchiveRunV1> {
    const now = Date.parse(this.#now());
    const orders = this.#finishedOrders(
      merchantId,
      now - options.orderDelayDays * DAY_MS,
    ).map((bundle) => ({
      id: bundle.orderId,
      month: bundle.lastChangedAt.slice(0, 7),
      json: canonicalJson(bundle),
      revision: null,
    }));
    const events = this.#oldEvents(
      merchantId,
      now - options.eventRetentionDays * DAY_MS,
    ).map((event) => ({
      id: event.eventId,
      month: event.occurredAt.slice(0, 7),
      json: canonicalJson(event),
      revision: event.merchantRevision,
    }));
    const files = [
      ...this.#plan(merchantId, "orders", orders, options.batchSize),
      ...this.#plan(merchantId, "events", events, options.batchSize),
    ];
    const results: CommerceArchiveFileV1[] = [];
    let archivedOrders = 0;
    let archivedEvents = 0;
    for (const file of files) {
      const written = await this.#upload(store, file);
      if (!this.#commit(merchantId, file)) continue;
      if (file.kind === "orders") archivedOrders += file.entries.length;
      else archivedEvents += file.entries.length;
      results.push({
        fileKey: file.key,
        kind: file.kind,
        month: file.month,
        records: file.entries.length,
        size: file.body.length,
        sha256: file.sha256,
        written,
      });
    }
    return {
      schemaVersion: "underclerk.archive-run.v1",
      files: results,
      orders: archivedOrders,
      events: archivedEvents,
    };
  }

  /** One order, read from the live tables or from its archive entry. */
  async readOrderRecord(
    merchantId: string,
    orderId: string,
    store: ArchiveStore | undefined,
  ): Promise<CommerceOrderRecordV1 | undefined> {
    const live = this.#bundle(merchantId, orderId);
    if (live !== undefined) return orderRecord(live, "live", null);
    const entry = this.#entry(merchantId, "order", orderId);
    if (entry === undefined || store === undefined) return undefined;
    const record = await readRecord(store, entry);
    return orderRecord(JSON.parse(record) as OrderBundle, "archived", {
      fileKey: entry.fileKey,
      offset: entry.offset,
      length: entry.length,
      sha256: entry.sha256,
    });
  }

  /** The event feed across the archive and the live outbox. */
  async readEvents(
    merchantId: string,
    after: string | undefined,
    limit: number,
    store: ArchiveStore | undefined,
  ): Promise<Readonly<{ events: readonly CommerceEventV1[]; nextCursor: string | null }>> {
    const position = after === undefined ? { revision: 0, deliveryId: "" } : parseCursor(after);
    const size = Math.max(1, Math.min(200, Math.trunc(limit)));
    const archived =
      store === undefined
        ? []
        : this.#database
            .prepare(
              `${ENTRY_COLUMNS} WHERE merchant_id = ? AND kind = 'event'
                 AND (merchant_revision > ? OR (merchant_revision = ? AND record_id > ?))
               ORDER BY merchant_revision, record_id LIMIT ?`,
            )
            .all<EntryRow>(
              merchantId,
              position.revision,
              position.revision,
              position.deliveryId,
              size,
            );
    const events: CommerceEventV1[] = [];
    for (const entry of archived) {
      if (store === undefined) break;
      const event = JSON.parse(await readRecord(store, entry)) as CommerceEventV1;
      events.push({ ...event, delivery: parseCommerceDelivery(event.delivery) });
    }
    const cursor = events.at(-1)?.cursor ?? after;
    if (events.length < size) {
      events.push(
        ...readEventPage(this.#database, merchantId, cursor, size - events.length)
          .events,
      );
    }
    return { events, nextCursor: events.at(-1)?.cursor ?? null };
  }

  #plan(
    merchantId: string,
    kind: "orders" | "events",
    records: readonly PlannedRecord[],
    batchSize: number,
  ): PlannedFile[] {
    const byMonth = new Map<string, PlannedRecord[]>();
    for (const record of records) {
      const list = byMonth.get(record.month) ?? [];
      list.push(record);
      byMonth.set(record.month, list);
    }
    const files: PlannedFile[] = [];
    for (const month of [...byMonth.keys()].sort()) {
      const monthRecords = byMonth.get(month) ?? [];
      if (kind === "orders")
        monthRecords.sort((left, right) => (left.id < right.id ? -1 : 1));
      let sequence = this.#nextSequence(merchantId, kind, month);
      for (let start = 0; start < monthRecords.length; start += batchSize) {
        const batch = monthRecords.slice(start, start + batchSize);
        const parts: Buffer[] = [];
        const entries: Array<PlannedFile["entries"][number]> = [];
        let offset = 0;
        for (const record of batch) {
          const member = gzipSync(Buffer.from(`${record.json}\n`, "utf8"));
          entries.push({
            id: record.id,
            offset,
            length: member.length,
            sha256: sha256(member),
            revision: record.revision,
            json: record.json,
          });
          parts.push(member);
          offset += member.length;
        }
        const body = Buffer.concat(parts);
        files.push({
          kind,
          month,
          sequence,
          key: `merchants/${merchantId}/${kind}/${month}/${sequence}.ndjson.gz`,
          body,
          sha256: sha256(body),
          entries,
        });
        sequence += 1;
      }
    }
    return files;
  }

  // Writes the file and its index, unless an interrupted run already wrote
  // the same bytes. Returns whether this run wrote the file.
  async #upload(store: ArchiveStore, file: PlannedFile): Promise<boolean> {
    const index = Buffer.from(
      `${canonicalJson(
        file.entries.map(({ id, offset, length, sha256: digest }) => ({
          id,
          offset,
          length,
          sha256: digest,
        })),
      )}\n`,
      "utf8",
    );
    let written = false;
    for (const [key, body, digest] of [
      [file.key, file.body, file.sha256],
      [`${file.key}.index.json`, index, sha256(index)],
    ] as const) {
      const existing = await store.head(key);
      if (existing !== null) {
        if (existing.sha256 !== digest)
          throw new Error(`Archive object ${key} holds different bytes`);
        continue;
      }
      await store.put(key, body, digest);
      const stored = await store.head(key);
      if (stored?.sha256 !== digest)
        throw new Error(`Archive object ${key} did not store`);
      if (key === file.key) written = true;
    }
    return written;
  }

  // Deletes the source rows only if they still match what was written.
  #commit(merchantId: string, file: PlannedFile): boolean {
    const database = this.#database;
    const archivedAt = this.#now();
    return database.transaction(() => {
      for (const entry of file.entries) {
        const current =
          file.kind === "orders"
            ? this.#bundle(merchantId, entry.id)
            : this.#eventRow(merchantId, entry.id);
        if (current === undefined) return false;
        const json =
          file.kind === "orders"
            ? canonicalJson(current)
            : canonicalJson(readEventAt(database, merchantId, entry.id));
        if (json !== entry.json) return false;
      }
      database
        .prepare(
          `INSERT INTO archive_file (
             merchant_id, file_key, kind, month, sequence, sha256, size,
             records, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          merchantId,
          file.key,
          file.kind,
          file.month,
          file.sequence,
          file.sha256,
          file.body.length,
          file.entries.length,
          archivedAt,
        );
      for (const entry of file.entries) {
        database
          .prepare(
            `INSERT INTO archive_entry (
               merchant_id, kind, record_id, file_key, offset, length, sha256,
               merchant_revision, archived_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            merchantId,
            file.kind === "orders" ? "order" : "event",
            entry.id,
            file.key,
            entry.offset,
            entry.length,
            entry.sha256,
            entry.revision,
            archivedAt,
          );
        if (file.kind === "orders") this.#deleteOrder(merchantId, entry.id);
        else
          database
            .prepare(
              "DELETE FROM observation_outbox WHERE merchant_id = ? AND delivery_id = ?",
            )
            .run(merchantId, entry.id);
      }
      return true;
    });
  }

  #finishedOrders(merchantId: string, cutoff: number): OrderBundle[] {
    const ids = this.#database
      .prepare(
        `SELECT resource_id AS id FROM commerce_order
         WHERE merchant_id = ? AND lifecycle_state IN ('cancelled', 'fulfilled')
         ORDER BY resource_id`,
      )
      .all<Readonly<{ id: string }>>(merchantId);
    const bundles: OrderBundle[] = [];
    for (const { id } of ids) {
      const bundle = this.#bundle(merchantId, id);
      if (
        bundle !== undefined &&
        Date.parse(bundle.lastChangedAt) <= cutoff &&
        orderIsFinished(bundle)
      )
        bundles.push(bundle);
    }
    return bundles;
  }

  #bundle(merchantId: string, orderId: string): OrderBundle | undefined {
    const select = (sql: string, ...params: CommerceSqlValue[]) =>
      this.#database.prepare(sql).all<Row>(merchantId, ...params);
    const order = select(
      "SELECT * FROM commerce_order WHERE merchant_id = ? AND resource_id = ?",
      orderId,
    );
    if (order.length === 0) return undefined;
    const byOrder = (table: string, key: string) =>
      select(
        `SELECT * FROM ${table} WHERE merchant_id = ? AND order_id = ? ORDER BY ${key}`,
        orderId,
      );
    const shipments = byOrder("shipment", "resource_id");
    const byShipment = (table: string, key: string) =>
      shipments.flatMap((shipment) =>
        select(
          `SELECT * FROM ${table} WHERE merchant_id = ? AND shipment_id = ? ORDER BY ${key}`,
          String(shipment.resource_id),
        ),
      );
    const tables: Record<OrderTable, readonly Row[]> = {
      commerce_order: order,
      payment: byOrder("payment", "resource_id"),
      fulfillment: byOrder("fulfillment", "resource_id"),
      shipment: shipments,
      shipment_label_rate: byShipment("shipment_label_rate", "label_rate_id"),
      shipment_label_attempt: byShipment("shipment_label_attempt", "label_attempt_id"),
      refund_attempt: byOrder("refund_attempt", "refund_attempt_id"),
      payment_dispute: byOrder("payment_dispute", "dispute_id"),
      order_return: byOrder("order_return", "return_id"),
      order_change: byOrder("order_change", "change_id"),
      manual_tender: byOrder("manual_tender", "payment_id"),
    };
    let lastChangedAt = "";
    for (const rows of Object.values(tables))
      for (const row of rows) {
        for (const column of ["occurred_at", "created_at"]) {
          const value = row[column];
          if (typeof value === "string" && value > lastChangedAt) lastChangedAt = value;
        }
      }
    return { orderId, lastChangedAt, tables };
  }

  #deleteOrder(merchantId: string, orderId: string): void {
    const shipmentIds = this.#database
      .prepare("SELECT resource_id AS id FROM shipment WHERE merchant_id = ? AND order_id = ?")
      .all<Readonly<{ id: string }>>(merchantId, orderId)
      .map((row) => row.id);
    for (const shipmentId of shipmentIds)
      for (const table of ["shipment_label_attempt", "shipment_label_rate"])
        this.#database
          .prepare(`DELETE FROM ${table} WHERE merchant_id = ? AND shipment_id = ?`)
          .run(merchantId, shipmentId);
    for (const table of [
      "manual_tender",
      "shipment",
      "payment_dispute",
      "refund_attempt",
      "order_change",
      "order_return",
      "payment",
      "fulfillment",
    ])
      this.#database
        .prepare(`DELETE FROM ${table} WHERE merchant_id = ? AND order_id = ?`)
        .run(merchantId, orderId);
    this.#database
      .prepare("DELETE FROM commerce_order WHERE merchant_id = ? AND resource_id = ?")
      .run(merchantId, orderId);
  }

  // The oldest events, up to the first one that must stay: one Platform has
  // not acknowledged, one too young, or one a webhook still needs.
  #oldEvents(merchantId: string, cutoff: number): CommerceEventV1[] {
    const rows = this.#database
      .prepare(
        `SELECT o.delivery_id AS deliveryId, o.merchant_revision AS merchantRevision,
                o.status, o.created_at AS createdAt,
                EXISTS (
                  SELECT 1 FROM webhook_delivery d
                  WHERE d.merchant_id = o.merchant_id AND d.event_id = o.delivery_id
                    AND d.status = 'pending'
                ) AS webhookPending
         FROM observation_outbox o WHERE o.merchant_id = ?
         ORDER BY o.merchant_revision, o.delivery_id`,
      )
      .all<
        Readonly<{
          deliveryId: string;
          merchantRevision: number;
          status: string;
          createdAt: string;
          webhookPending: number;
        }>
      >(merchantId);
    const cursors = this.#database
      .prepare(
        "SELECT cursor FROM webhook_subscription WHERE merchant_id = ? AND state = 'active'",
      )
      .all<Readonly<{ cursor: string }>>(merchantId)
      .map((row) => parseCursor(row.cursor).revision);
    const fannedOutTo = cursors.length === 0 ? Infinity : Math.min(...cursors);
    const events: CommerceEventV1[] = [];
    for (const row of rows) {
      if (
        row.status === "pending" ||
        row.webhookPending === 1 ||
        Date.parse(row.createdAt) > cutoff ||
        row.merchantRevision > fannedOutTo
      )
        break;
      events.push(readEventAt(this.#database, merchantId, row.deliveryId));
    }
    return events;
  }

  #eventRow(merchantId: string, deliveryId: string): Row | undefined {
    return this.#database
      .prepare(
        "SELECT delivery_id FROM observation_outbox WHERE merchant_id = ? AND delivery_id = ? AND status != 'pending'",
      )
      .get<Row>(merchantId, deliveryId);
  }

  #nextSequence(merchantId: string, kind: string, month: string): number {
    return (
      (this.#database
        .prepare(
          "SELECT MAX(sequence) AS sequence FROM archive_file WHERE merchant_id = ? AND kind = ? AND month = ?",
        )
        .get<Readonly<{ sequence: number | null }>>(merchantId, kind, month)
        ?.sequence ?? 0) + 1
    );
  }

  #entry(merchantId: string, kind: "order" | "event", recordId: string) {
    return this.#database
      .prepare(`${ENTRY_COLUMNS} WHERE merchant_id = ? AND kind = ? AND record_id = ?`)
      .get<EntryRow>(merchantId, kind, recordId);
  }
}

type EntryRow = Readonly<{
  recordId: string;
  fileKey: string;
  offset: number;
  length: number;
  sha256: string;
}>;

const ENTRY_COLUMNS = `SELECT record_id AS recordId, file_key AS fileKey,
  offset, length, sha256 FROM archive_entry`;

function orderIsFinished(bundle: OrderBundle): boolean {
  return (
    bundle.tables.refund_attempt.every(
      (row) => row.lifecycle_state === "succeeded" || row.lifecycle_state === "failed",
    ) &&
    bundle.tables.payment_dispute.every(
      (row) => row.lifecycle_state === "won" || row.lifecycle_state === "lost",
    ) &&
    bundle.tables.order_return.every(
      (row) => row.lifecycle_state === "closed" || row.lifecycle_state === "rejected",
    )
  );
}

function readEventAt(
  database: CommerceDatabase,
  merchantId: string,
  deliveryId: string,
): CommerceEventV1 {
  const row = database
    .prepare(
      "SELECT merchant_revision AS revision FROM observation_outbox WHERE merchant_id = ? AND delivery_id = ?",
    )
    .get<Readonly<{ revision: number }>>(merchantId, deliveryId);
  if (row === undefined) throw new Error(`Event ${deliveryId} is not in the outbox`);
  const event = readEventPage(
    database,
    merchantId,
    `${row.revision - 1}:￿`,
    50,
  ).events.find((candidate) => candidate.eventId === deliveryId);
  if (event === undefined) throw new Error(`Event ${deliveryId} is not readable`);
  return event;
}

async function readRecord(store: ArchiveStore, entry: EntryRow): Promise<string> {
  const member = await store.read(entry.fileKey, entry.offset, entry.length);
  if (member === null || sha256(Buffer.from(member)) !== entry.sha256)
    throw new Error(`Archived record ${entry.recordId} does not match its entry`);
  return gunzipSync(member).toString("utf8").trimEnd();
}

function orderRecord(
  bundle: OrderBundle,
  source: CommerceOrderRecordV1["source"],
  archive: CommerceOrderRecordV1["archive"],
): CommerceOrderRecordV1 {
  const json = (rows: readonly Row[], column: string) =>
    rows.map((row) => JSON.parse(String(row[column])) as unknown);
  const [order] = json(bundle.tables.commerce_order, "order_snapshot_json");
  return {
    schemaVersion: "underclerk.order-record.v1",
    source,
    archive,
    order: parseOrder(order),
    payments: json(bundle.tables.payment, "payment_snapshot_json").map(parsePayment),
    fulfillments: json(bundle.tables.fulfillment, "fulfillment_snapshot_json").map(
      parseFulfillment,
    ),
    shipments: json(bundle.tables.shipment, "shipment_snapshot_json").map(parseShipment),
    returns: json(bundle.tables.order_return, "return_json").map(parseReturn),
    refundAttempts: json(bundle.tables.refund_attempt, "attempt_json").map(
      parseRefundAttempt,
    ),
    changes: json(bundle.tables.order_change, "change_json").map(parseOrderChange),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
