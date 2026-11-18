// Plan 78 step 2: the draft order records that packages/commerce-client
// reads in src/draft-orders.ts. Each schema follows its hand-written reader:
// exact keys, 1 to 100 lines with different ids and variants, different tags,
// and a buyer email of at most 320 characters.
import { Type, type Static } from "typebox";
import { PositiveInteger } from "../schema.ts";
import {
  boundedTextSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import { Nullable, wireMoneySchema } from "./client-wire-fields.ts";
import { commerceMutationResultV1Schema } from "./api-mutations.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;

export const draftOrdersMoneySchema = wireMoneySchema;
export type DraftOrdersMoney = Static<typeof draftOrdersMoneySchema>;

/** `requireEmail`: text of at most 320 characters around one `@`. */
const emailSchema = Type.Refine(boundedTextSchema(320), isEmail, emailError);

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/u.test(value);
}

function emailError(): string {
  return "must be an email address";
}

export const commerceDraftOrderLineV1Schema = ReadonlyStrictObject({
  lineId: text,
  variantId: text,
  quantity: Type.Integer({ minimum: 1, maximum: 999 }),
  priceOverride: Nullable(
    ReadonlyStrictObject({
      unitPrice: wireMoneySchema,
      reason: boundedTextSchema(500),
    }),
  ),
});
export type CommerceDraftOrderLineV1 = Static<
  typeof commerceDraftOrderLineV1Schema
>;

/** `parseLinesNoteAndTags`: 1 to 100 lines, each line and variant once. */
const linesSchema = Type.Refine(
  ImmutableArray(commerceDraftOrderLineV1Schema, {
    minItems: 1,
    maxItems: 100,
  }),
  hasDistinctLines,
  linesError,
);

function hasDistinctLines(
  lines: readonly Readonly<{ lineId: string; variantId: string }>[],
): boolean {
  return (
    new Set(lines.map(lineIdOf)).size === lines.length &&
    new Set(lines.map(variantIdOf)).size === lines.length
  );
}

function lineIdOf(line: Readonly<{ lineId: string }>): string {
  return line.lineId;
}

function variantIdOf(line: Readonly<{ variantId: string }>): string {
  return line.variantId;
}

function linesError(): string {
  return "lines must name each line and variant once";
}

const tagsSchema = Type.Refine(
  ImmutableArray(boundedTextSchema(255)),
  hasDistinctTags,
  tagsError,
);

function hasDistinctTags(tags: readonly string[]): boolean {
  return new Set(tags).size === tags.length;
}

function tagsError(): string {
  return "tags must be distinct";
}

export const draftCommandBaseSchema = ReadonlyOpenObject({
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
  draftOrderId: text,
});
export type DraftCommandBase = Static<typeof draftCommandBaseSchema>;

export const draftContentsSchema = ReadonlyOpenObject({
  lines: linesSchema,
  buyer: ReadonlyStrictObject({ email: emailSchema }),
  note: Type.String(),
  tags: tagsSchema,
});
export type DraftContents = Static<typeof draftContentsSchema>;

/** A draft command has its parts' keys and no other key. */
const exactKeys = { unevaluatedProperties: false } as const;

export const createCommerceDraftOrderV1Schema = Type.Intersect(
  [
    draftCommandBaseSchema,
    draftContentsSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.create-draft-order.v1"),
      storefrontId: text,
    }),
  ],
  exactKeys,
);
export type CreateCommerceDraftOrderV1 = Static<
  typeof createCommerceDraftOrderV1Schema
>;

export const updateCommerceDraftOrderV1Schema = Type.Intersect(
  [
    draftCommandBaseSchema,
    draftContentsSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.update-draft-order.v1"),
      expectedDraftOrderRevision: PositiveInteger,
    }),
  ],
  exactKeys,
);
export type UpdateCommerceDraftOrderV1 = Static<
  typeof updateCommerceDraftOrderV1Schema
>;

export const sendCommerceDraftInvoiceV1Schema = Type.Intersect(
  [
    draftCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.send-draft-invoice.v1"),
      expectedDraftOrderRevision: PositiveInteger,
      expiresAt: utcTimestampSchema,
    }),
  ],
  exactKeys,
);
export type SendCommerceDraftInvoiceV1 = Static<
  typeof sendCommerceDraftInvoiceV1Schema
>;

export const cancelCommerceDraftOrderV1Schema = Type.Intersect(
  [
    draftCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.cancel-draft-order.v1"),
      expectedDraftOrderRevision: PositiveInteger,
    }),
  ],
  exactKeys,
);
export type CancelCommerceDraftOrderV1 = Static<
  typeof cancelCommerceDraftOrderV1Schema
>;

/** `parseManualTender`: a bank transfer names its reference. */
export const commerceManualTenderV1Schema = Type.Union([
  ReadonlyStrictObject({ method: Type.Literal("cash") }),
  ReadonlyStrictObject({
    method: Type.Literal("bank_transfer"),
    reference: boundedTextSchema(255),
  }),
]);
export type CommerceManualTenderV1 = Static<
  typeof commerceManualTenderV1Schema
>;

export const markCommerceDraftOrderPaidV1Schema = Type.Intersect(
  [
    draftCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.mark-draft-order-paid.v1"),
      expectedDraftOrderRevision: PositiveInteger,
      tender: commerceManualTenderV1Schema,
      orderId: text,
      paymentId: text,
      fulfillmentId: text,
    }),
  ],
  exactKeys,
);
export type MarkCommerceDraftOrderPaidV1 = Static<
  typeof markCommerceDraftOrderPaidV1Schema
>;

export const commerceDraftOrderCommandV1Schema = Type.Union([
  createCommerceDraftOrderV1Schema,
  updateCommerceDraftOrderV1Schema,
  sendCommerceDraftInvoiceV1Schema,
  cancelCommerceDraftOrderV1Schema,
]);
export type CommerceDraftOrderCommandV1 = Static<
  typeof commerceDraftOrderCommandV1Schema
>;

export const commerceDraftInvoiceV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.draft-invoice.v1"),
  mutation: commerceMutationResultV1Schema,
  invoice: Nullable(
    ReadonlyOpenObject({ token: text, expiresAt: utcTimestampSchema }),
  ),
});
export type CommerceDraftInvoiceV1 = Static<
  typeof commerceDraftInvoiceV1Schema
>;

const sealedBuyerSchema = ReadonlyStrictObject({
  customerId: Nullable(text),
  email: Nullable(emailSchema),
});

/** A draft made before the buyer was sealed holds only its email. */
const legacyBuyerSchema = Type.Codec(
  ReadonlyStrictObject({ email: emailSchema }),
)
  .Decode(withNoCustomer)
  .Encode(withoutCustomer);

function withNoCustomer(
  buyer: Readonly<{ email: string }>,
): Static<typeof sealedBuyerSchema> {
  return { customerId: null, email: buyer.email };
}

function withoutCustomer(
  buyer: Static<typeof sealedBuyerSchema>,
): Readonly<{ email: string }> {
  return { email: buyer.email ?? "" };
}

export const commerceDraftOrderBuyerV1Schema = Type.Union([
  Type.Unsafe<Static<typeof sealedBuyerSchema>>(legacyBuyerSchema),
  sealedBuyerSchema,
]);
export type CommerceDraftOrderBuyerV1 = Static<
  typeof commerceDraftOrderBuyerV1Schema
>;

export const commerceDraftOrderLifecycleV1Schema = Type.Union([
  ReadonlyStrictObject({ state: Type.Literal("open") }),
  ReadonlyStrictObject({
    state: Type.Literal("invoiced"),
    invoicedRevision: PositiveInteger,
    expiresAt: utcTimestampSchema,
  }),
  ReadonlyStrictObject({
    state: Type.Literal("cancelled"),
    cancelledAt: utcTimestampSchema,
  }),
]);
export type CommerceDraftOrderLifecycleV1 = Static<
  typeof commerceDraftOrderLifecycleV1Schema
>;

export const commerceDraftOrderV1Schema = ReadonlyStrictObject({
  id: text,
  revision: PositiveInteger,
  storefrontId: text,
  lines: linesSchema,
  buyer: commerceDraftOrderBuyerV1Schema,
  note: Type.String(),
  tags: tagsSchema,
  lifecycle: commerceDraftOrderLifecycleV1Schema,
  occurredAt: utcTimestampSchema,
});
export type CommerceDraftOrderV1 = Static<
  typeof commerceDraftOrderV1Schema
>;

/** `parseRecordedTender`: the tender's own keys and when staff took it. */
const recordedTenderSchema = Type.Union([
  ReadonlyStrictObject({
    method: Type.Literal("cash"),
    recordedAt: utcTimestampSchema,
  }),
  ReadonlyStrictObject({
    method: Type.Literal("bank_transfer"),
    reference: boundedTextSchema(255),
    recordedAt: utcTimestampSchema,
  }),
]);

export const commerceDraftOrderViewV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.draft-order.v1"),
  draftOrder: commerceDraftOrderV1Schema,
  checkoutIds: ImmutableArray(text),
  completion: Nullable(
    ReadonlyOpenObject({
      checkoutId: text,
      orderId: text,
      manualTender: Type.Optional(
        Type.Unsafe<
          CommerceManualTenderV1 & Readonly<{ recordedAt: string }>
        >(recordedTenderSchema),
      ),
    }),
  ),
});
export type CommerceDraftOrderViewV1 = Static<
  typeof commerceDraftOrderViewV1Schema
>;

// Parsers of the client API types (Plan 78 step 2).
export const parseCancelCommerceDraftOrderV1 = wireRecordParser(
  cancelCommerceDraftOrderV1Schema,
);
export const parseCreateCommerceDraftOrderV1 = wireRecordParser(
  createCommerceDraftOrderV1Schema,
);
export const parseMarkCommerceDraftOrderPaidV1 = wireRecordParser(
  markCommerceDraftOrderPaidV1Schema,
);
export const parseSendCommerceDraftInvoiceV1 = wireRecordParser(
  sendCommerceDraftInvoiceV1Schema,
);
export const parseCommerceDraftInvoiceV1 = wireRecordParser(
  commerceDraftInvoiceV1Schema,
);
export const parseCommerceDraftOrderV1 = wireRecordParser(
  commerceDraftOrderV1Schema,
);
export const parseCommerceDraftOrderViewV1 = wireRecordParser(
  commerceDraftOrderViewV1Schema,
);
export const parseUpdateCommerceDraftOrderV1 = wireRecordParser(
  updateCommerceDraftOrderV1Schema,
);
export const parseCommerceManualTenderV1 = wireRecordParser(
  commerceManualTenderV1Schema,
);
