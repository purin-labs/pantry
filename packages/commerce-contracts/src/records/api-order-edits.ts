// Plan 78 step 2: the order edit records that packages/commerce-client
// reads in src/order-edits.ts. Each schema follows its hand-written reader.
import { Type, type Static, type TProperties } from "typebox";
import { NonNegativeInteger, PositiveInteger } from "@purin-labs/contract-schema";
import {
  boundedTextSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import { wireMoneySchema } from "./client-wire-fields.ts";
import { commerceManualTenderV1Schema } from "./api-draft-orders.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;

export const orderEditsMoneySchema = wireMoneySchema;
export type OrderEditsMoney = Static<typeof orderEditsMoneySchema>;

const commandBase = {
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
};

const additionSchema = ReadonlyStrictObject({
  variantId: text,
  quantity: PositiveInteger,
});

function hasDistinct<Key extends string>(
  key: Key,
  lines: readonly Readonly<Record<Key, string>>[],
): boolean {
  return new Set(lines.map(fieldOf.bind(null, key))).size === lines.length;
}

function fieldOf<Key extends string>(
  key: Key,
  line: Readonly<Record<Key, string>>,
): string {
  return line[key];
}

function hasEditLines(command: {
  readonly lineChanges: readonly Readonly<{ orderLineId: string }>[];
  readonly additions: readonly Readonly<{ variantId: string }>[];
}): boolean {
  return (
    command.lineChanges.length + command.additions.length > 0 &&
    hasDistinct("orderLineId", command.lineChanges) &&
    hasDistinct("variantId", command.additions)
  );
}

function editLinesError(): string {
  return "an order edit changes or adds lines, each named once";
}

export const editCommerceOrderV1Schema = Type.Refine(
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("commerce.edit-order.v1"),
    ...commandBase,
    editId: text,
    orderId: text,
    expectedOrderRevision: PositiveInteger,
    lineChanges: ImmutableArray(
      ReadonlyStrictObject({ orderLineId: text, quantity: NonNegativeInteger }),
    ),
    additions: ImmutableArray(additionSchema),
    reason: boundedTextSchema(500),
  }),
  hasEditLines,
  editLinesError,
);
export type EditCommerceOrderV1 = Static<typeof editCommerceOrderV1Schema>;

function hasExchangeLines(command: {
  readonly additions: readonly Readonly<{ variantId: string }>[];
}): boolean {
  return (
    command.additions.length > 0 && hasDistinct("variantId", command.additions)
  );
}

function exchangeLinesError(): string {
  return "an exchange adds lines, each variant named once";
}

export const exchangeCommerceOrderLinesV1Schema = Type.Refine(
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("commerce.exchange-order-lines.v1"),
    ...commandBase,
    exchangeId: text,
    orderId: text,
    expectedOrderRevision: PositiveInteger,
    returnId: text,
    expectedReturnRevision: PositiveInteger,
    additions: ImmutableArray(additionSchema),
    reason: boundedTextSchema(500),
  }),
  hasExchangeLines,
  exchangeLinesError,
);
export type ExchangeCommerceOrderLinesV1 = Static<
  typeof exchangeCommerceOrderLinesV1Schema
>;

export const openCommerceBuyerOrderBalanceV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.open-buyer-order-balance.v1"),
});
export type OpenCommerceBuyerOrderBalanceV1 = Static<
  typeof openCommerceBuyerOrderBalanceV1Schema
>;

export const recordCommerceOrderManualPaymentV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.record-order-manual-payment.v1"),
  ...commandBase,
  orderId: text,
  expectedOrderRevision: PositiveInteger,
  paymentId: text,
  amount: wireMoneySchema,
  tender: commerceManualTenderV1Schema,
});
export type RecordCommerceOrderManualPaymentV1 = Static<
  typeof recordCommerceOrderManualPaymentV1Schema
>;

export {
  commerceOrderBalanceCheckoutV1Schema,
  type CommerceOrderBalanceCheckoutV1,
} from "./api-storefront-responses.ts";

export const commerceOrderBalanceV1Schema = ReadonlyStrictObject({
  total: wireMoneySchema,
  captured: wireMoneySchema,
  refunded: wireMoneySchema,
  outstanding: wireMoneySchema,
  refundDue: wireMoneySchema,
});
export type CommerceOrderBalanceV1 = Static<
  typeof commerceOrderBalanceV1Schema
>;

export const commerceOrderChangeLineV1Schema = ReadonlyStrictObject({
  orderLineId: text,
  quantity: PositiveInteger,
  lineTotal: wireMoneySchema,
  tax: wireMoneySchema,
  allocationIds: ImmutableArray(text),
});
export type CommerceOrderChangeLineV1 = Static<
  typeof commerceOrderChangeLineV1Schema
>;

const changeBase = {
  id: text,
  orderId: text,
  orderRevisionBefore: PositiveInteger,
  orderRevisionAfter: PositiveInteger,
  occurredAt: utcTimestampSchema,
};

const lineChangeFields = {
  ...changeBase,
  reason: text,
  lineChanges: ImmutableArray(
    ReadonlyStrictObject({
      orderLineId: text,
      quantityBefore: PositiveInteger,
      quantityAfter: NonNegativeInteger,
    }),
  ),
  additions: ImmutableArray(
    ReadonlyStrictObject({
      orderLineId: text,
      variantId: text,
      quantity: PositiveInteger,
    }),
  ),
  totalBefore: wireMoneySchema,
  totalAfter: wireMoneySchema,
  linesBefore: ImmutableArray(commerceOrderChangeLineV1Schema),
  linesAfter: ImmutableArray(commerceOrderChangeLineV1Schema),
};

export const commerceOrderEditV1Schema = ReadonlyStrictObject({
  kind: Type.Literal("edit"),
  ...lineChangeFields,
});
export type CommerceOrderEditV1 = Static<typeof commerceOrderEditV1Schema>;

/** The edit fields and the exchange's own, with no other key. */
function exchangeChange<Properties extends TProperties>(
  properties: Properties,
) {
  return Type.Intersect(
    [ReadonlyOpenObject(lineChangeFields), ReadonlyOpenObject(properties)],
    { unevaluatedProperties: false },
  );
}

export const commerceOrderExchangeV1Schema = exchangeChange({
  kind: Type.Literal("exchange"),
  returnId: text,
  fulfillmentId: text,
});
export type CommerceOrderExchangeV1 = Static<
  typeof commerceOrderExchangeV1Schema
>;

export const commerceOrderPaymentChangeV1Schema = ReadonlyStrictObject({
  kind: Type.Literal("payment"),
  ...changeBase,
  paymentId: text,
  checkoutId: Type.Optional(text),
  amount: wireMoneySchema,
});
export type CommerceOrderPaymentChangeV1 = Static<
  typeof commerceOrderPaymentChangeV1Schema
>;

export const commerceOrderChangeV1Schema = Type.Union([
  commerceOrderEditV1Schema,
  commerceOrderExchangeV1Schema,
  commerceOrderPaymentChangeV1Schema,
]);
export type CommerceOrderChangeV1 = Static<
  typeof commerceOrderChangeV1Schema
>;

export const commerceOrderChangesV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.order-changes.v1"),
  orderId: text,
  orderRevision: PositiveInteger,
  changes: ImmutableArray(commerceOrderChangeV1Schema),
  balance: commerceOrderBalanceV1Schema,
});
export type CommerceOrderChangesV1 = Static<
  typeof commerceOrderChangesV1Schema
>;

// Parsers of the client API types (Plan 78 step 2).
export const parseEditCommerceOrderV1 = wireRecordParser(
  editCommerceOrderV1Schema,
);
export const parseExchangeCommerceOrderLinesV1 = wireRecordParser(
  exchangeCommerceOrderLinesV1Schema,
);
export const parseOpenCommerceBuyerOrderBalanceV1 = wireRecordParser(
  openCommerceBuyerOrderBalanceV1Schema,
);
export const parseRecordCommerceOrderManualPaymentV1 = wireRecordParser(
  recordCommerceOrderManualPaymentV1Schema,
);
export const parseCommerceOrderChangeV1 = wireRecordParser(
  commerceOrderChangeV1Schema,
);
export const parseCommerceOrderChangesV1 = wireRecordParser(
  commerceOrderChangesV1Schema,
);
