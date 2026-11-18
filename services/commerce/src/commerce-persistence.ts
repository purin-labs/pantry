import {
  parseFulfillment,
  parseLocation,
  parseOffer,
  parseOrder,
  parsePayment,
  parseProduct,
  parseSalesChannel,
  parseShipment,
  parseVariant,
  type CommerceFulfillmentV1,
  type CommerceLocationV1,
  type CommerceOfferV1,
  type CommerceOrderV1,
  type CommercePaymentV1,
  type CommerceProductV1,
  type CommerceSalesChannelV1,
  type CommerceShipmentV1,
  type CommerceVariantV1,
} from "@seams/commerce-client";

import type { CommerceDatabase } from "./database.ts";
import { writeCommerceEntityRelationText } from "./entity-plane/relation-text.ts";
import { refreshCommerceRelationshipRelation } from "./entity-plane/commerce-relationship-relation.ts";
import { refreshCommerceAttributeRelation } from "./entity-plane/commerce-attribute-relation.ts";
import { parseJson } from "@seams/std";

type LocationRow = Readonly<{
  id: string;
  revision: number;
  name: string;
  kind: string;
  lifecycleJson: string;
  occurredAt: string;
}>;

type SalesChannelRow = LocationRow;

type ProductRow = Readonly<{
  id: string;
  revision: number;
  title: string;
  description: string;
  handle: string | null;
  status: string;
  detailsJson: string;
  occurredAt: string;
}>;

type VariantRow = Readonly<{
  id: string;
  revision: number;
  productId: string;
  sku: string;
  title: string;
  definitionJson: string;
  occurredAt: string;
}>;

type OfferRow = Readonly<{
  id: string;
  revision: number;
  variantId: string;
  salesChannelId: string;
  amountMinor: number;
  currency: string;
  compareAtAmountMinor: number | null;
  availabilityJson: string;
  lifecycleJson: string;
  occurredAt: string;
}>;

type SnapshotRow = Readonly<{ snapshotJson: string }>;
type SnapshotTable = "commerce_order" | "payment" | "fulfillment" | "shipment";
type SnapshotColumn =
  | "order_snapshot_json"
  | "payment_snapshot_json"
  | "fulfillment_snapshot_json"
  | "shipment_snapshot_json";

export function writeLocation(
  database: CommerceDatabase,
  merchantId: string,
  resource: CommerceLocationV1,
): void {
  database
    .prepare(
      `INSERT INTO location (
       merchant_id, resource_id, revision, name, kind,
       lifecycle_state, lifecycle_json, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, resource_id) DO UPDATE SET
       revision = excluded.revision,
       name = excluded.name,
       kind = excluded.kind,
       lifecycle_state = excluded.lifecycle_state,
       lifecycle_json = excluded.lifecycle_json,
       occurred_at = excluded.occurred_at`,
    )
    .run(
      merchantId,
      resource.id,
      resource.revision,
      resource.name,
      resource.kind,
      resource.lifecycle.state,
      JSON.stringify(resource.lifecycle),
      resource.occurredAt,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "location",
    resource.id,
    resource.revision,
    resource.occurredAt,
    resource.name,
  );
}

export function listLocations(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceLocationV1[] {
  const rows = database
    .prepare(
      `SELECT resource_id AS id, revision, name, kind,
            lifecycle_json AS lifecycleJson, occurred_at AS occurredAt
     FROM location WHERE merchant_id = ? ORDER BY resource_id`,
    )
    .all<LocationRow>(merchantId);
  const resources: CommerceLocationV1[] = [];
  for (const row of rows) resources.push(parseLocationRow(row));
  return resources;
}

export function writeSalesChannel(
  database: CommerceDatabase,
  merchantId: string,
  resource: CommerceSalesChannelV1,
): void {
  database
    .prepare(
      `INSERT INTO sales_channel (
       merchant_id, resource_id, revision, name, kind,
       lifecycle_state, lifecycle_json, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, resource_id) DO UPDATE SET
       revision = excluded.revision,
       name = excluded.name,
       kind = excluded.kind,
       lifecycle_state = excluded.lifecycle_state,
       lifecycle_json = excluded.lifecycle_json,
       occurred_at = excluded.occurred_at`,
    )
    .run(
      merchantId,
      resource.id,
      resource.revision,
      resource.name,
      resource.kind,
      resource.lifecycle.state,
      JSON.stringify(resource.lifecycle),
      resource.occurredAt,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "sales_channel",
    resource.id,
    resource.revision,
    resource.occurredAt,
    resource.name,
  );
}

export function listSalesChannels(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceSalesChannelV1[] {
  const rows = database
    .prepare(
      `SELECT resource_id AS id, revision, name, kind,
            lifecycle_json AS lifecycleJson, occurred_at AS occurredAt
     FROM sales_channel WHERE merchant_id = ? ORDER BY resource_id`,
    )
    .all<SalesChannelRow>(merchantId);
  const resources: CommerceSalesChannelV1[] = [];
  for (const row of rows) resources.push(parseSalesChannelRow(row));
  return resources;
}

export function writeProduct(
  database: CommerceDatabase,
  merchantId: string,
  resource: CommerceProductV1,
): void {
  database
    .prepare(
      `INSERT INTO product (
       merchant_id, resource_id, revision, title, description, handle, status,
       details_json, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, resource_id) DO UPDATE SET
       revision = excluded.revision,
       title = excluded.title,
       description = excluded.description,
       handle = excluded.handle,
       status = excluded.status,
       details_json = excluded.details_json,
       occurred_at = excluded.occurred_at`,
    )
    .run(
      merchantId,
      resource.id,
      resource.revision,
      resource.title,
      resource.description,
      resource.handle,
      resource.status,
      JSON.stringify({
        productType: resource.productType,
        vendor: resource.vendor,
        tags: resource.tags,
      }),
      resource.occurredAt,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "product",
    resource.id,
    resource.revision,
    resource.occurredAt,
    resource.title,
  );
}

export function listProducts(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceProductV1[] {
  const rows = database
    .prepare(
      `SELECT resource_id AS id, revision, title, description, handle, status,
            details_json AS detailsJson, occurred_at AS occurredAt
     FROM product WHERE merchant_id = ? ORDER BY resource_id`,
    )
    .all<ProductRow>(merchantId);
  const resources: CommerceProductV1[] = [];
  for (const row of rows) resources.push(parseProductRow(row));
  return resources;
}

export function writeVariant(
  database: CommerceDatabase,
  merchantId: string,
  resource: CommerceVariantV1,
): void {
  database
    .prepare(
      `INSERT INTO sellable_variant (
       merchant_id, resource_id, revision, product_id, sku, title,
       definition_json, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, resource_id) DO UPDATE SET
       revision = excluded.revision,
       product_id = excluded.product_id,
       sku = excluded.sku,
       title = excluded.title,
       definition_json = excluded.definition_json,
       occurred_at = excluded.occurred_at`,
    )
    .run(
      merchantId,
      resource.id,
      resource.revision,
      resource.productId,
      resource.sku,
      resource.title,
      JSON.stringify({
        options: resource.options,
        media: resource.media,
        barcode: resource.barcode,
        status: resource.status,
      }),
      resource.occurredAt,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "sellable_variant",
    resource.id,
    resource.revision,
    resource.occurredAt,
    resource.title,
  );
}

export function listVariants(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceVariantV1[] {
  const rows = database
    .prepare(
      `SELECT resource_id AS id, revision, product_id AS productId, sku, title,
            definition_json AS definitionJson, occurred_at AS occurredAt
     FROM sellable_variant WHERE merchant_id = ? ORDER BY resource_id`,
    )
    .all<VariantRow>(merchantId);
  const resources: CommerceVariantV1[] = [];
  for (const row of rows) resources.push(parseVariantRow(row));
  return resources;
}

export function readOfferRevision(
  database: CommerceDatabase,
  merchantId: string,
  offerId: string,
): number | undefined {
  return database
    .prepare(
      "SELECT revision FROM offer WHERE merchant_id = ? AND resource_id = ?",
    )
    .get<Readonly<{ revision: number }>>(merchantId, offerId)?.revision;
}

/** The order's revision, or undefined for an order the merchant lacks. */
export function readOrderRevision(
  database: CommerceDatabase,
  merchantId: string,
  orderId: string,
): number | undefined {
  return database
    .prepare(
      "SELECT revision FROM commerce_order WHERE merchant_id = ? AND resource_id = ?",
    )
    .get<Readonly<{ revision: number }>>(merchantId, orderId)?.revision;
}

export function writeOffer(
  database: CommerceDatabase,
  merchantId: string,
  resource: CommerceOfferV1,
): void {
  database
    .prepare(
      `INSERT INTO offer (
       merchant_id, resource_id, revision, variant_id, sales_channel_id,
       amount_minor, currency, availability_state, availability_json,
       lifecycle_state, lifecycle_json, occurred_at, compare_at_amount_minor
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, resource_id) DO UPDATE SET
       revision = excluded.revision,
       variant_id = excluded.variant_id,
       sales_channel_id = excluded.sales_channel_id,
       amount_minor = excluded.amount_minor,
       currency = excluded.currency,
       availability_state = excluded.availability_state,
       availability_json = excluded.availability_json,
       lifecycle_state = excluded.lifecycle_state,
       lifecycle_json = excluded.lifecycle_json,
       occurred_at = excluded.occurred_at,
       compare_at_amount_minor = excluded.compare_at_amount_minor`,
    )
    .run(
      merchantId,
      resource.id,
      resource.revision,
      resource.variantId,
      resource.salesChannelId,
      resource.price.amountMinor,
      resource.price.currency,
      resource.availability.state,
      JSON.stringify(resource.availability),
      resource.lifecycle.state,
      JSON.stringify(resource.lifecycle),
      resource.occurredAt,
      resource.compareAtPrice?.amountMinor ?? null,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "offer",
    resource.id,
    resource.revision,
    resource.occurredAt,
    resource.id,
  );
  refreshCommerceAttributeRelation(database, merchantId);
}

export function listOffers(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceOfferV1[] {
  const rows = database
    .prepare(
      `SELECT resource_id AS id, revision, variant_id AS variantId,
            sales_channel_id AS salesChannelId, amount_minor AS amountMinor,
            currency, compare_at_amount_minor AS compareAtAmountMinor,
            availability_json AS availabilityJson,
            lifecycle_json AS lifecycleJson, occurred_at AS occurredAt
     FROM offer WHERE merchant_id = ? ORDER BY resource_id`,
    )
    .all<OfferRow>(merchantId);
  const resources: CommerceOfferV1[] = [];
  for (const row of rows) resources.push(parseOfferRow(row));
  return resources;
}

export function writeOrder(
  database: CommerceDatabase,
  merchantId: string,
  resource: CommerceOrderV1,
): void {
  database
    .prepare(
      `INSERT INTO commerce_order (
       merchant_id, resource_id, revision, sales_channel_id, origin_kind,
       buyer_kind, lifecycle_state, order_snapshot_json,
       occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, resource_id) DO UPDATE SET
       revision = excluded.revision,
       sales_channel_id = excluded.sales_channel_id,
       origin_kind = excluded.origin_kind,
       buyer_kind = excluded.buyer_kind,
       lifecycle_state = excluded.lifecycle_state,
       order_snapshot_json = excluded.order_snapshot_json,
       occurred_at = excluded.occurred_at`,
    )
    .run(
      merchantId,
      resource.id,
      resource.revision,
      resource.origin.salesChannelId,
      resource.origin.kind,
      resource.buyer.kind,
      resource.lifecycle.state,
      JSON.stringify(resource),
      resource.occurredAt,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "order",
    resource.id,
    resource.revision,
    resource.occurredAt,
    resource.id,
  );
  refreshCommerceRelationshipRelation(database, merchantId);
}

export function listOrders(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceOrderV1[] {
  return listSnapshots(
    database,
    "commerce_order",
    "order_snapshot_json",
    merchantId,
    parseOrder,
  );
}

export function writePayment(
  database: CommerceDatabase,
  merchantId: string,
  resource: CommercePaymentV1,
): void {
  database
    .prepare(
      `INSERT INTO payment (
       merchant_id, resource_id, revision, order_id, amount_minor, currency,
       lifecycle_state, payment_snapshot_json, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, resource_id) DO UPDATE SET
       revision = excluded.revision,
       order_id = excluded.order_id,
       amount_minor = excluded.amount_minor,
       currency = excluded.currency,
       lifecycle_state = excluded.lifecycle_state,
       payment_snapshot_json = excluded.payment_snapshot_json,
       occurred_at = excluded.occurred_at`,
    )
    .run(
      merchantId,
      resource.id,
      resource.revision,
      resource.orderId,
      resource.amount.amountMinor,
      resource.amount.currency,
      resource.lifecycle.state,
      JSON.stringify(resource),
      resource.occurredAt,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "payment",
    resource.id,
    resource.revision,
    resource.occurredAt,
    resource.id,
  );
}

export function listPayments(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommercePaymentV1[] {
  return listSnapshots(
    database,
    "payment",
    "payment_snapshot_json",
    merchantId,
    parsePayment,
  );
}

export function writeFulfillment(
  database: CommerceDatabase,
  merchantId: string,
  resource: CommerceFulfillmentV1,
): void {
  database
    .prepare(
      `INSERT INTO fulfillment (
       merchant_id, resource_id, revision, order_id, location_id, fulfillment_kind,
       lifecycle_state, fulfillment_snapshot_json, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, resource_id) DO UPDATE SET
       revision = excluded.revision,
       order_id = excluded.order_id,
       location_id = excluded.location_id,
       fulfillment_kind = excluded.fulfillment_kind,
       lifecycle_state = excluded.lifecycle_state,
       fulfillment_snapshot_json = excluded.fulfillment_snapshot_json,
       occurred_at = excluded.occurred_at`,
    )
    .run(
      merchantId,
      resource.id,
      resource.revision,
      resource.orderId,
      resource.locationId,
      resource.kind,
      resource.lifecycle.state,
      JSON.stringify(resource),
      resource.occurredAt,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "fulfillment",
    resource.id,
    resource.revision,
    resource.occurredAt,
    resource.id,
  );
  refreshCommerceRelationshipRelation(database, merchantId);
}

export function listFulfillments(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceFulfillmentV1[] {
  return listSnapshots(
    database,
    "fulfillment",
    "fulfillment_snapshot_json",
    merchantId,
    parseFulfillment,
  );
}

export function writeShipment(
  database: CommerceDatabase,
  merchantId: string,
  resource: CommerceShipmentV1,
): void {
  database
    .prepare(
      `INSERT INTO shipment (
       merchant_id, resource_id, revision, order_id, fulfillment_id,
       lifecycle_state, shipment_snapshot_json, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, resource_id) DO UPDATE SET
       revision = excluded.revision,
       order_id = excluded.order_id,
       fulfillment_id = excluded.fulfillment_id,
       lifecycle_state = excluded.lifecycle_state,
       shipment_snapshot_json = excluded.shipment_snapshot_json,
       occurred_at = excluded.occurred_at`,
    )
    .run(
      merchantId,
      resource.id,
      resource.revision,
      resource.orderId,
      resource.fulfillmentId,
      resource.lifecycle.state,
      JSON.stringify(resource),
      resource.occurredAt,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "shipment",
    resource.id,
    resource.revision,
    resource.occurredAt,
    resource.id,
  );
  refreshCommerceRelationshipRelation(database, merchantId);
}

export function listShipments(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceShipmentV1[] {
  return listSnapshots(
    database,
    "shipment",
    "shipment_snapshot_json",
    merchantId,
    parseShipment,
  );
}

function parseLocationRow(row: LocationRow): CommerceLocationV1 {
  return parseLocation({
    id: row.id,
    revision: row.revision,
    name: row.name,
    kind: row.kind,
    lifecycle: parseJson(row.lifecycleJson),
    occurredAt: row.occurredAt,
  });
}

function parseSalesChannelRow(row: SalesChannelRow): CommerceSalesChannelV1 {
  return parseSalesChannel({
    id: row.id,
    revision: row.revision,
    name: row.name,
    kind: row.kind,
    lifecycle: parseJson(row.lifecycleJson),
    occurredAt: row.occurredAt,
  });
}

function parseVariantRow(row: VariantRow): CommerceVariantV1 {
  const definition = requireDefinition(parseJson(row.definitionJson));
  return parseVariant({
    id: row.id,
    revision: row.revision,
    productId: row.productId,
    sku: row.sku,
    title: row.title,
    options: definition.options,
    media: definition.media,
    barcode: definition.barcode,
    status: definition.status,
    occurredAt: row.occurredAt,
  });
}

function parseProductRow(row: ProductRow): CommerceProductV1 {
  const details = parseJson(row.detailsJson);
  if (typeof details !== "object" || details === null || Array.isArray(details))
    throw new Error("Stored product details are invalid");
  return parseProduct({
    id: row.id,
    revision: row.revision,
    title: row.title,
    description: row.description,
    ...details,
    handle: row.handle,
    status: row.status,
    occurredAt: row.occurredAt,
  });
}

function parseOfferRow(row: OfferRow): CommerceOfferV1 {
  return parseOffer({
    id: row.id,
    revision: row.revision,
    variantId: row.variantId,
    salesChannelId: row.salesChannelId,
    price: { amountMinor: row.amountMinor, currency: row.currency },
    compareAtPrice:
      row.compareAtAmountMinor === null
        ? null
        : { amountMinor: row.compareAtAmountMinor, currency: row.currency },
    availability: parseJson(row.availabilityJson),
    lifecycle: parseJson(row.lifecycleJson),
    occurredAt: row.occurredAt,
  });
}

function listSnapshots<T>(
  database: CommerceDatabase,
  table: SnapshotTable,
  column: SnapshotColumn,
  merchantId: string,
  parser: (value: unknown) => T,
): readonly T[] {
  const rows = database
    .prepare(
      `SELECT ${column} AS snapshotJson
     FROM ${table} WHERE merchant_id = ? ORDER BY resource_id`,
    )
    .all<SnapshotRow>(merchantId);
  const resources: T[] = [];
  for (const row of rows) resources.push(parser(parseJson(row.snapshotJson)));
  return resources;
}

function requireDefinition(
  value: unknown,
): Readonly<{
  options: unknown;
  media: unknown;
  barcode: unknown;
  status: unknown;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored variant definition is invalid");
  }
  if (!("options" in value) || !("media" in value)) {
    throw new Error("Stored variant definition is incomplete");
  }
  // Variants written before schema 51 carry no barcode or status; the parser
  // reads that absence as an active variant with no barcode.
  return {
    options: value.options,
    media: value.media,
    barcode: "barcode" in value ? value.barcode : undefined,
    status: "status" in value ? value.status : undefined,
  };
}
