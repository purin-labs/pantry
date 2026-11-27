// Plan 78 step 2: the archive records that packages/commerce-client
// reads in src/archive.ts. Each schema follows its hand-written reader: exact
// keys and SHA-256 digests. The order, payments, fulfillments and shipments of
// an order record belong to the resource readers of commerce-resources.ts,
// which are not ported yet; until then their schemas check only the shape.
import { Type, type Static } from "typebox";
import { NonNegativeInteger, PositiveInteger } from "@purin-labs/contract-schema";
import {
  commerceFulfillmentV1Schema,
  commerceOrderV1Schema,
  commercePaymentV1Schema,
  commerceShipmentV1Schema,
} from "./api-resources.ts";
import { normalizedTextSchema, sha256HexSchema } from "./fields.ts";
import { Nullable } from "./client-wire-fields.ts";
import { wireRefundAttemptSchema } from "./api-after-sale.ts";
import { commerceOrderChangeV1Schema } from "./api-order-edits.ts";
import { commerceReturnV1Schema } from "./api-returns.ts";
import {
  ImmutableArray,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;

const commerceArchiveFileV1Schema = ReadonlyStrictObject({
  fileKey: text,
  kind: Type.Union([Type.Literal("orders"), Type.Literal("events")]),
  month: text,
  records: PositiveInteger,
  size: PositiveInteger,
  sha256: sha256HexSchema,
  written: Type.Boolean(),
});
export type CommerceArchiveFileV1 = Static<
  typeof commerceArchiveFileV1Schema
>;

const commerceArchiveLocationV1Schema = ReadonlyStrictObject({
  fileKey: text,
  offset: NonNegativeInteger,
  length: PositiveInteger,
  sha256: sha256HexSchema,
});
export type CommerceArchiveLocationV1 = Static<
  typeof commerceArchiveLocationV1Schema
>;

const commerceArchiveRunV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.archive-run.v1"),
  files: ImmutableArray(commerceArchiveFileV1Schema),
  orders: NonNegativeInteger,
  events: NonNegativeInteger,
});
export type CommerceArchiveRunV1 = Static<
  typeof commerceArchiveRunV1Schema
>;

const commerceOrderRecordV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.order-record.v1"),
  source: Type.Union([Type.Literal("live"), Type.Literal("archived")]),
  archive: Nullable(commerceArchiveLocationV1Schema),
  order: commerceOrderV1Schema,
  payments: ImmutableArray(commercePaymentV1Schema),
  fulfillments: ImmutableArray(commerceFulfillmentV1Schema),
  shipments: ImmutableArray(commerceShipmentV1Schema),
  returns: ImmutableArray(commerceReturnV1Schema),
  refundAttempts: ImmutableArray(wireRefundAttemptSchema),
  changes: ImmutableArray(commerceOrderChangeV1Schema),
});
export type CommerceOrderRecordV1 = Static<
  typeof commerceOrderRecordV1Schema
>;

// Parsers of the client API types (Plan 78 step 2).
export const parseCommerceArchiveRunV1 = wireRecordParser(
  commerceArchiveRunV1Schema,
);
export const parseCommerceOrderRecordV1 = wireRecordParser(
  commerceOrderRecordV1Schema,
);
