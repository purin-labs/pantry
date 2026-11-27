// Plan 78 step 2: the return records that packages/commerce-client
// reads in src/returns.ts. Each schema follows its hand-written reader: exact
// keys for commands, lines and returns, and a lifecycle that keeps the fields
// of its state.
import { Type, type Static } from "typebox";
import { PositiveInteger } from "@purin-labs/contract-schema";
import {
  boundedTextSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import { Nullable } from "./client-wire-fields.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;
const exactKeys = { unevaluatedProperties: false } as const;

const commerceReturnDispositionSchema = Type.Union([
  Type.Literal("restock"),
  Type.Literal("quarantine"),
  Type.Literal("damage"),
  Type.Literal("waste"),
  Type.Literal("lost"),
]);
export type CommerceReturnDisposition = Static<
  typeof commerceReturnDispositionSchema
>;

const returnCommandBaseSchema = ReadonlyOpenObject({
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
  returnId: text,
});

const commerceReturnRequestLineV1Schema = ReadonlyStrictObject({
  orderLineId: text,
  quantity: PositiveInteger,
  reason: boundedTextSchema(500),
});
export type CommerceReturnRequestLineV1 = Static<
  typeof commerceReturnRequestLineV1Schema
>;

/** `parseRequestLines`: at least one line, each order line once. */
const requestLinesSchema = Type.Refine(
  ImmutableArray(commerceReturnRequestLineV1Schema, { minItems: 1 }),
  hasDistinctLines,
  linesError,
);

function hasDistinctLines(
  lines: readonly Readonly<{ orderLineId: string }>[],
): boolean {
  return new Set(lines.map(orderLineIdOf)).size === lines.length;
}

function orderLineIdOf(line: Readonly<{ orderLineId: string }>): string {
  return line.orderLineId;
}

function linesError(): string {
  return "lines must name each order line once";
}

const requestCommerceReturnV1Schema = Type.Intersect(
  [
    returnCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.request-return.v1"),
      orderId: text,
      lines: requestLinesSchema,
    }),
  ],
  exactKeys,
);
export type RequestCommerceReturnV1 = Static<
  typeof requestCommerceReturnV1Schema
>;

const authorizeCommerceReturnV1Schema = Type.Intersect(
  [
    returnCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.authorize-return.v1"),
      expectedReturnRevision: PositiveInteger,
      decisions: ImmutableArray(
        ReadonlyStrictObject({
          orderLineId: text,
          decision: Type.Union([
            Type.Literal("authorized"),
            Type.Literal("rejected"),
          ]),
        }),
      ),
    }),
  ],
  exactKeys,
);
export type AuthorizeCommerceReturnV1 = Static<
  typeof authorizeCommerceReturnV1Schema
>;

const receiveCommerceReturnV1Schema = Type.Intersect(
  [
    returnCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.receive-return.v1"),
      expectedReturnRevision: PositiveInteger,
      locationId: text,
      dispositions: ImmutableArray(
        ReadonlyStrictObject({
          orderLineId: text,
          disposition: commerceReturnDispositionSchema,
        }),
      ),
    }),
  ],
  exactKeys,
);
export type ReceiveCommerceReturnV1 = Static<
  typeof receiveCommerceReturnV1Schema
>;

const closeCommerceReturnV1Schema = Type.Intersect(
  [
    returnCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.close-return.v1"),
      expectedReturnRevision: PositiveInteger,
      refundAttemptId: Nullable(text),
    }),
  ],
  exactKeys,
);
export type CloseCommerceReturnV1 = Static<
  typeof closeCommerceReturnV1Schema
>;

const commerceReturnCommandV1Schema = Type.Union([
  requestCommerceReturnV1Schema,
  authorizeCommerceReturnV1Schema,
  receiveCommerceReturnV1Schema,
  closeCommerceReturnV1Schema,
]);
export type CommerceReturnCommandV1 = Static<
  typeof commerceReturnCommandV1Schema
>;

const requestCommerceBuyerReturnV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.request-buyer-return.v1"),
  idempotencyKey: text,
  lines: requestLinesSchema,
});
export type RequestCommerceBuyerReturnV1 = Static<
  typeof requestCommerceBuyerReturnV1Schema
>;

const commerceReturnLifecycleV1Schema = Type.Union([
  ReadonlyOpenObject({
    state: Type.Literal("requested"),
    requestedAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("authorized"),
    authorizedAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("rejected"),
    rejectedAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("received"),
    receivedAt: utcTimestampSchema,
    locationId: text,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("closed"),
    closedAt: utcTimestampSchema,
    refundAttemptId: Nullable(text),
    exchangeId: Type.Optional(text),
  }),
]);
export type CommerceReturnLifecycleV1 = Static<
  typeof commerceReturnLifecycleV1Schema
>;

const commerceReturnLineV1Schema = ReadonlyStrictObject({
  orderLineId: text,
  quantity: PositiveInteger,
  reason: text,
  decision: Type.Union([
    Type.Literal("pending"),
    Type.Literal("authorized"),
    Type.Literal("rejected"),
  ]),
  disposition: Nullable(commerceReturnDispositionSchema),
});
export type CommerceReturnLineV1 = Static<
  typeof commerceReturnLineV1Schema
>;

export const commerceReturnV1Schema = ReadonlyStrictObject({
  id: text,
  revision: PositiveInteger,
  orderId: text,
  requestedBy: Type.Union([Type.Literal("buyer"), Type.Literal("staff")]),
  lines: ImmutableArray(commerceReturnLineV1Schema),
  lifecycle: commerceReturnLifecycleV1Schema,
  occurredAt: utcTimestampSchema,
});
export type CommerceReturnV1 = Static<typeof commerceReturnV1Schema>;

type ReturnList = Readonly<{
  schemaVersion: "commerce.returns.v1";
  returns: readonly CommerceReturnV1[];
}>;

/** `parseReturns`: the returns of an order or a merchant. */
const returnListSchema = Type.Unsafe<readonly CommerceReturnV1[]>(
  Type.Codec(
    ReadonlyStrictObject({
      schemaVersion: Type.Literal("commerce.returns.v1"),
      returns: ImmutableArray(commerceReturnV1Schema),
    }),
  )
    .Decode(returnsOf)
    .Encode(returnList),
);

function returnsOf(list: ReturnList): readonly CommerceReturnV1[] {
  return list.returns;
}

function returnList(returns: readonly CommerceReturnV1[]): ReturnList {
  return { schemaVersion: "commerce.returns.v1", returns };
}

// Parsers of the client API types (Plan 78 step 2).
export const parseAuthorizeCommerceReturnV1 = wireRecordParser(
  authorizeCommerceReturnV1Schema,
);
export const parseCloseCommerceReturnV1 = wireRecordParser(
  closeCommerceReturnV1Schema,
);
export const parseReceiveCommerceReturnV1 = wireRecordParser(
  receiveCommerceReturnV1Schema,
);
export const parseRequestCommerceBuyerReturnV1 = wireRecordParser(
  requestCommerceBuyerReturnV1Schema,
);
export const parseRequestCommerceReturnV1 = wireRecordParser(
  requestCommerceReturnV1Schema,
);
export const parseCommerceReturnV1 = wireRecordParser(
  commerceReturnV1Schema,
);
export const parseCommerceReturnsV1 = wireRecordParser(returnListSchema);
