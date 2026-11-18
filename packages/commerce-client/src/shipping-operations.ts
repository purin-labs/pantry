import type {
  ShipmentLabelAttempt,
  ShipmentLabelRateSnapshot,
} from "@seams/commerce-contracts";
import { decodeRecord } from "./entity-plane/record-decoding.ts";
import {
  parseAttachFulfillmentTrackingCommand as parseAttachFulfillmentTrackingCommandRecord,
  parsePurchaseShippingLabelCommand as parsePurchaseShippingLabelCommandRecord,
  parseQuoteShipmentLabelRateCommand as parseQuoteShipmentLabelRateCommandRecord,
  parseRecordShippingTrackingCommand as parseRecordShippingTrackingCommandRecord,
  parseShipmentLabelRateResult as parseShipmentLabelRateResultRecord,
  parseWireShipmentLabelAttempt as parseShipmentLabelAttemptRecord,
  parseWireShipmentLabelRate as parseShipmentLabelRateSnapshotRecord,
} from "@seams/commerce-contracts/records/api-shipping-operations";

export type QuoteShipmentLabelRateCommand = Readonly<{
  schemaVersion: "underclerk.quote-shipment-label-rate.v1";
  merchantId: string;
  idempotencyKey: string;
  requestedAt: string;
  shipmentId: string;
  shipmentRevision: number;
}>;

export type PurchaseShippingLabelCommand = Readonly<{
  schemaVersion: "underclerk.purchase-shipping-label.v1";
  merchantId: string;
  expectedMerchantRevision: number;
  idempotencyKey: string;
  requestedAt: string;
  shipmentId: string;
  shipmentRevision: number;
  labelRateId: string;
  labelAttemptId: string;
}>;

export type RecordShippingTrackingCommand = Readonly<{
  schemaVersion: "underclerk.record-shipping-tracking.v1";
  merchantId: string;
  expectedMerchantRevision: number;
  idempotencyKey: string;
  requestedAt: string;
  shipmentId: string;
  shipmentRevision: number;
  event:
    | Readonly<{
        state: "in_transit";
        providerEventId: string;
        occurredAt: string;
        location: string;
        signature: string;
      }>
    | Readonly<{
        state: "delivered";
        providerEventId: string;
        occurredAt: string;
        location: string;
        signature: string;
      }>;
}>;

export type AttachFulfillmentTrackingCommand = Readonly<{
  schemaVersion: "underclerk.attach-fulfillment-tracking.v1";
  merchantId: string;
  expectedMerchantRevision: number;
  idempotencyKey: string;
  requestedAt: string;
  orderId: string;
  fulfillmentId: string;
  fulfillmentRevision: number;
  shipmentId: string;
  shipmentRevision: number;
  trackingNumber: string;
}>;

export type ShipmentLabelRateResult = Readonly<{
  schemaVersion: "underclerk.shipment-label-rate-result.v1";
  outcome: "quoted" | "replayed";
  rate: ShipmentLabelRateSnapshot;
}>;

export type CommerceShipmentLabelAttemptV1 = ShipmentLabelAttempt;

export function parseQuoteShipmentLabelRateCommand(
  value: unknown,
): QuoteShipmentLabelRateCommand {
  return decodeRecord(parseQuoteShipmentLabelRateCommandRecord, value);
}

export function parsePurchaseShippingLabelCommand(
  value: unknown,
): PurchaseShippingLabelCommand {
  return decodeRecord(parsePurchaseShippingLabelCommandRecord, value);
}

export function parseRecordShippingTrackingCommand(
  value: unknown,
): RecordShippingTrackingCommand {
  return decodeRecord(parseRecordShippingTrackingCommandRecord, value);
}

export function parseAttachFulfillmentTrackingCommand(
  value: unknown,
): AttachFulfillmentTrackingCommand {
  return decodeRecord(parseAttachFulfillmentTrackingCommandRecord, value);
}

export function parseShipmentLabelRateResult(
  value: unknown,
): ShipmentLabelRateResult {
  return decodeRecord(parseShipmentLabelRateResultRecord, value);
}

export function parseShipmentLabelRate(
  value: unknown,
): ShipmentLabelRateSnapshot {
  return decodeRecord(parseShipmentLabelRateSnapshotRecord, value);
}

export function parseShipmentLabelAttempt(
  value: unknown,
): ShipmentLabelAttempt {
  return decodeRecord(parseShipmentLabelAttemptRecord, value);
}
