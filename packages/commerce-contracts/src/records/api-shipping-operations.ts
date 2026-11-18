// Plan 78 step 2: the shipping label and tracking records that
// packages/commerce-client reads in src/shipping-operations.ts.
// Each schema follows its hand-written reader: the readers keep the fields
// they know and drop the rest, and write each UTC timestamp as
// `Date.toISOString` writes it.
import { Type, type Static } from "typebox";
import {
  NonNegativeInteger,
  PositiveInteger,
  ReadonlyRecord,
} from "../schema.ts";
import type {
  ShipmentLabelAttempt,
  ShipmentLabelRateSnapshot,
} from "./commerce-records.ts";
import { normalizedTextSchema } from "./fields.ts";
import { ReadonlyOpenObject, wireRecordParser } from "./wire-objects.ts";

const text = normalizedTextSchema;

/** `timestamp`: whole or millisecond UTC seconds, as an ISO string. */
const timestampSchema = Type.Codec(
  Type.Refine(text, isUtcTimestamp, timestampError),
)
  .Decode(isoTimestamp)
  .Encode(sameText);

function isUtcTimestamp(value: string): boolean {
  return (
    Number.isFinite(Date.parse(value)) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  );
}

function timestampError(): string {
  return "must be a UTC timestamp";
}

function isoTimestamp(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

function sameText(value: string): string {
  return value;
}

export const jsonObjectSchema = ReadonlyRecord(Type.String(), Type.Unknown());
export type JsonObject = Static<typeof jsonObjectSchema>;

export const quoteShipmentLabelRateCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.quote-shipment-label-rate.v1"),
  merchantId: text,
  idempotencyKey: text,
  requestedAt: timestampSchema,
  shipmentId: text,
  shipmentRevision: PositiveInteger,
});
export type QuoteShipmentLabelRateCommand = Static<
  typeof quoteShipmentLabelRateCommandSchema
>;

const mutationBase = {
  merchantId: text,
  expectedMerchantRevision: PositiveInteger,
  idempotencyKey: text,
  requestedAt: timestampSchema,
};

export const purchaseShippingLabelCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.purchase-shipping-label.v1"),
  ...mutationBase,
  shipmentId: text,
  shipmentRevision: PositiveInteger,
  labelRateId: text,
  labelAttemptId: text,
});
export type PurchaseShippingLabelCommand = Static<
  typeof purchaseShippingLabelCommandSchema
>;

const trackingEvent = {
  providerEventId: text,
  occurredAt: timestampSchema,
  location: text,
  signature: text,
};

export const recordShippingTrackingCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.record-shipping-tracking.v1"),
  ...mutationBase,
  shipmentId: text,
  shipmentRevision: PositiveInteger,
  event: Type.Union([
    ReadonlyOpenObject({ state: Type.Literal("in_transit"), ...trackingEvent }),
    ReadonlyOpenObject({ state: Type.Literal("delivered"), ...trackingEvent }),
  ]),
});
export type RecordShippingTrackingCommand = Static<
  typeof recordShippingTrackingCommandSchema
>;

export const attachFulfillmentTrackingCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.attach-fulfillment-tracking.v1"),
  ...mutationBase,
  orderId: text,
  fulfillmentId: text,
  fulfillmentRevision: PositiveInteger,
  shipmentId: text,
  shipmentRevision: PositiveInteger,
  trackingNumber: text,
});
export type AttachFulfillmentTrackingCommand = Static<
  typeof attachFulfillmentTrackingCommandSchema
>;

export const wireShipmentLabelRateSchema =
  Type.Unsafe<ShipmentLabelRateSnapshot>(
    ReadonlyOpenObject({
      labelRateId: text,
      shipmentId: text,
      shipmentRevision: PositiveInteger,
      providerAccountReference: text,
      rateReference: text,
      service: ReadonlyOpenObject({ code: text, name: text }),
      amount: ReadonlyOpenObject({
        amountMinor: NonNegativeInteger,
        currency: text,
      }),
      packagePlanDigest: text,
      quotedAt: timestampSchema,
      expiresAt: timestampSchema,
    }),
  );

export const shipmentLabelRateResultSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.shipment-label-rate-result.v1"),
  outcome: Type.Union([Type.Literal("quoted"), Type.Literal("replayed")]),
  rate: wireShipmentLabelRateSchema,
});
export type ShipmentLabelRateResult = Static<
  typeof shipmentLabelRateResultSchema
>;

export const commerceShipmentLabelAttemptV1Schema =
  Type.Unsafe<ShipmentLabelAttempt>(
    ReadonlyOpenObject({
      labelAttemptId: text,
      shipmentId: text,
      shipmentRevision: PositiveInteger,
      labelRateId: text,
      rateReference: text,
      packagePlanDigest: text,
      idempotencyKey: text,
      revision: PositiveInteger,
      lifecycle: Type.Union([
        ReadonlyOpenObject({
          state: Type.Literal("requested"),
          requestedAt: timestampSchema,
        }),
        ReadonlyOpenObject({
          state: Type.Literal("purchased"),
          providerLabelReference: text,
          trackingNumber: text,
          purchasedAt: timestampSchema,
        }),
        ReadonlyOpenObject({
          state: Type.Literal("rejected"),
          reason: text,
          rejectedAt: timestampSchema,
        }),
        ReadonlyOpenObject({
          state: Type.Literal("indeterminate"),
          lastAttemptAt: timestampSchema,
        }),
      ]),
    }),
  );
export type CommerceShipmentLabelAttemptV1 = Static<
  typeof commerceShipmentLabelAttemptV1Schema
>;

// Parsers of the client API types (Plan 78 step 2).
export const parseAttachFulfillmentTrackingCommand = wireRecordParser(
  attachFulfillmentTrackingCommandSchema,
);
export const parsePurchaseShippingLabelCommand = wireRecordParser(
  purchaseShippingLabelCommandSchema,
);
export const parseQuoteShipmentLabelRateCommand = wireRecordParser(
  quoteShipmentLabelRateCommandSchema,
);
export const parseRecordShippingTrackingCommand = wireRecordParser(
  recordShippingTrackingCommandSchema,
);
export const parseShipmentLabelRateResult = wireRecordParser(
  shipmentLabelRateResultSchema,
);
export const parseWireShipmentLabelRate = wireRecordParser(
  wireShipmentLabelRateSchema,
);
export const parseWireShipmentLabelAttempt = wireRecordParser(
  commerceShipmentLabelAttemptV1Schema,
);
