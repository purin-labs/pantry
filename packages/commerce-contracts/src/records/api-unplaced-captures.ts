// A capture with no order (Refactor 15, refactor 10). The provider took the
// buyer's money, and Commerce could not place the order: the checkout had
// expired, or the placement was refused. Commerce does not refund it by
// itself. Staff see the capture and record what they did: a refund on the
// provider, or an order made by hand.
import { Type, type Static } from "typebox";
import {
  NonNegativeInteger,
  PositiveInteger,
} from "@purin-labs/contract-schema";
import { normalizedTextSchema, utcTimestampSchema } from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;

const unplacedCaptureResolutionSchema = Type.Union([
  Type.Literal("refunded"),
  Type.Literal("placed_by_hand"),
]);

const unplacedCaptureLifecycleSchema = Type.Union([
  ReadonlyStrictObject({ state: Type.Literal("capture_unplaced") }),
  ReadonlyStrictObject({
    state: Type.Literal("resolved"),
    resolution: unplacedCaptureResolutionSchema,
    note: Type.Union([text, Type.Null()]),
    resolvedAt: utcTimestampSchema,
  }),
]);
export type UnplacedCaptureLifecycle = Static<
  typeof unplacedCaptureLifecycleSchema
>;

const commerceUnplacedCaptureV1Schema = ReadonlyStrictObject({
  paymentAttemptId: text,
  checkoutId: text,
  revision: PositiveInteger,
  amount: ReadonlyStrictObject({
    amountMinor: NonNegativeInteger,
    currency: text,
  }),
  /** The provider's payment, for a refund on the provider's dashboard. */
  providerPaymentReference: text,
  /** Why no order was placed: `checkout_expired`, or the refusal's code. */
  reason: text,
  openedAt: utcTimestampSchema,
  lifecycle: unplacedCaptureLifecycleSchema,
});
export type CommerceUnplacedCaptureV1 = Static<
  typeof commerceUnplacedCaptureV1Schema
>;

const commerceUnplacedCapturesV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.unplaced-captures.v1"),
  merchantId: text,
  /** The open captures first, then the resolved ones, the newest first. */
  captures: ImmutableArray(commerceUnplacedCaptureV1Schema),
});
export type CommerceUnplacedCapturesV1 = Static<
  typeof commerceUnplacedCapturesV1Schema
>;

export const parseCommerceUnplacedCaptureV1 = wireRecordParser(
  commerceUnplacedCaptureV1Schema,
);

/** Staff record what they did for a capture with no order. */
const resolveCommerceUnplacedCaptureV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.resolve-unplaced-capture.v1"),
  expectedRevision: PositiveInteger,
  resolution: unplacedCaptureResolutionSchema,
  note: Type.Optional(text),
});

export const parseResolveCommerceUnplacedCaptureV1 = wireRecordParser(
  resolveCommerceUnplacedCaptureV1Schema,
);
