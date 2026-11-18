// The failed payments of a time window, each with what followed it. A declined
// payment places no order and expires its checkout, so a buyer tries again on
// a new checkout. The read joins those attempts by buyer session. It names no
// buyer: the lines and the amount are enough for staff.
import { Type, type Static } from "typebox";
import { normalizedTextSchema, utcTimestampSchema } from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;

export const commerceFailedPaymentStepV1Schema = ReadonlyStrictObject({
  paymentAttemptId: text,
  /** The declined attempt that this one tried again; null for the first. */
  follows: Type.Union([text, Type.Null()]),
  channel: Type.Union([Type.Literal("online"), Type.Literal("counter")]),
  amount: ReadonlyStrictObject({
    amountMinor: Type.Integer({ minimum: 0 }),
    currency: text,
  }),
  at: utcTimestampSchema,
  state: Type.Union([Type.Literal("declined"), Type.Literal("paid")]),
  /** The provider's reason code of a declined attempt. */
  reasonCode: Type.Union([text, Type.Null()]),
  /** The pickup code of the order that a paid attempt placed. */
  orderCode: Type.Union([text, Type.Null()]),
  lines: ImmutableArray(
    ReadonlyStrictObject({
      title: Type.Union([text, Type.Null()]),
      quantity: Type.Integer({ minimum: 1 }),
    }),
  ),
});
export type CommerceFailedPaymentStepV1 = Static<
  typeof commerceFailedPaymentStepV1Schema
>;

export const commerceFailedPaymentsV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.failed-payments.v1"),
  merchantId: text,
  merchantRevision: Type.Integer({ minimum: 0 }),
  /** True when the window held more failed payments than this read returns. */
  truncated: Type.Boolean(),
  steps: ImmutableArray(commerceFailedPaymentStepV1Schema),
});
export type CommerceFailedPaymentsV1 = Static<
  typeof commerceFailedPaymentsV1Schema
>;

export const parseCommerceFailedPaymentsV1 = wireRecordParser(
  commerceFailedPaymentsV1Schema,
);
