// The archive (Plan 76A step 5). Finished orders and old events move from
// the merchant DO to files in R2 that never change. An order reads the same
// from either place; the record says which.
import type { RefundAttempt } from "@seams/commerce-contracts";

import {
  type CommerceFulfillmentV1,
  type CommerceOrderV1,
  type CommercePaymentV1,
  type CommerceShipmentV1,
} from "./commerce-resources.ts";
import { type CommerceOrderChangeV1 } from "./order-edits.ts";
import { type CommerceReturnV1 } from "./returns.ts";
import { parseCommerceArchiveRunV1 as parseCommerceArchiveRunV1Record, parseCommerceOrderRecordV1 as parseCommerceOrderRecordV1Record } from "@seams/commerce-contracts/records/api-archive";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

export type CommerceArchiveLocationV1 = Readonly<{
  fileKey: string;
  offset: number;
  length: number;
  sha256: string;
}>;

export type CommerceOrderRecordV1 = Readonly<{
  schemaVersion: "underclerk.order-record.v1";
  source: "live" | "archived";
  archive: CommerceArchiveLocationV1 | null;
  order: CommerceOrderV1;
  payments: readonly CommercePaymentV1[];
  fulfillments: readonly CommerceFulfillmentV1[];
  shipments: readonly CommerceShipmentV1[];
  returns: readonly CommerceReturnV1[];
  refundAttempts: readonly RefundAttempt[];
  changes: readonly CommerceOrderChangeV1[];
}>;

export type CommerceArchiveFileV1 = Readonly<{
  fileKey: string;
  kind: "orders" | "events";
  month: string;
  records: number;
  size: number;
  sha256: string;
  /** False when the same file was already in R2 from an interrupted run. */
  written: boolean;
}>;

export type CommerceArchiveRunV1 = Readonly<{
  schemaVersion: "underclerk.archive-run.v1";
  files: readonly CommerceArchiveFileV1[];
  orders: number;
  events: number;
}>;

export function parseOrderRecord(value: unknown): CommerceOrderRecordV1 {
  return decodeRecord(parseCommerceOrderRecordV1Record, value);
}

export function parseArchiveRun(value: unknown): CommerceArchiveRunV1 {
  return decodeRecord(parseCommerceArchiveRunV1Record, value);
}
