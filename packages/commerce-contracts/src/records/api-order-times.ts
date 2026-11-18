// How long each order of a time window took: when it was placed, when the shop
// said it would be ready, and when that part of the work finished. It names no
// buyer: the lines and the pickup code are enough for staff.
import { Type, type Static } from "typebox";
import { normalizedTextSchema, utcTimestampSchema } from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;

export const commerceOrderTimeV1Schema = ReadonlyStrictObject({
  orderId: text,
  /** The pickup code that staff and the buyer use for this order. */
  code: text,
  channel: Type.Union([Type.Literal("online"), Type.Literal("counter")]),
  amount: ReadonlyStrictObject({
    amountMinor: Type.Integer({ minimum: 0 }),
    currency: text,
  }),
  placedAt: utcTimestampSchema,
  /** The earliest time that a fulfillment promised; null with no fulfillment. */
  expectedBy: Type.Union([utcTimestampSchema, Type.Null()]),
  /** What the order is waiting for, or how it ended. */
  stage: Type.Union([
    Type.Literal("preparing"),
    Type.Literal("ready"),
    Type.Literal("finished"),
    Type.Literal("cancelled"),
  ]),
  /** When the stage began; null while the order is preparing. */
  stageAt: Type.Union([utcTimestampSchema, Type.Null()]),
  lines: ImmutableArray(
    ReadonlyStrictObject({
      title: Type.Union([text, Type.Null()]),
      quantity: Type.Integer({ minimum: 1 }),
    }),
  ),
});
export type CommerceOrderTimeV1 = Static<typeof commerceOrderTimeV1Schema>;

export const commerceOrderTimesV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.order-times.v1"),
  merchantId: text,
  merchantRevision: Type.Integer({ minimum: 0 }),
  /** True when the window held more orders than this read returns. */
  truncated: Type.Boolean(),
  orders: ImmutableArray(commerceOrderTimeV1Schema),
});
export type CommerceOrderTimesV1 = Static<
  typeof commerceOrderTimesV1Schema
>;

export const parseCommerceOrderTimesV1 = wireRecordParser(
  commerceOrderTimesV1Schema,
);
