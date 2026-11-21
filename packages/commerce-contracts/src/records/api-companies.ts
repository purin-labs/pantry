// Plan 76 phase 8 slice 3: B2B companies. A company groups customers who
// buy for a business, gives them its own price for some variants, and can
// let staff place their orders on invoice terms (net days). These
// schemas are the only source of the company records (Plan 78: a new type
// goes into TypeScript); `src/companies.ts` in the client reads them.
import { Type, type Static } from "typebox";
import { NonNegativeInteger, PositiveInteger } from "@purin-labs/contract-schema";
import {
  boundedTextSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import { Nullable } from "./client-wire-fields.ts";
import { marketCurrencySchema } from "./commerce-fields.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;
const exactKeys = { unevaluatedProperties: false } as const;

function hasUniqueItems(items: readonly string[]): boolean {
  return new Set(items).size === items.length;
}

function hasUniqueVariants(
  items: readonly Readonly<{ variantId: string }>[],
): boolean {
  return new Set(items.map(variantIdOf)).size === items.length;
}

function variantIdOf(item: Readonly<{ variantId: string }>): string {
  return item.variantId;
}

function uniqueItemsError(): string {
  return "must name unique items";
}

/** The customers who buy for the company; a customer is in one company. */
const customerIdsSchema = Type.Refine(
  ImmutableArray(text, { maxItems: 200 }),
  hasUniqueItems,
  uniqueItemsError,
);

/** The company's unit price of each listed variant, in one currency. */
export const commerceCompanyPricesV1Schema = ReadonlyStrictObject({
  currency: marketCurrencySchema,
  items: Type.Refine(
    ImmutableArray(
      ReadonlyStrictObject({ variantId: text, amountMinor: PositiveInteger }),
      { maxItems: 500 },
    ),
    hasUniqueVariants,
    uniqueItemsError,
  ),
});
export type CommerceCompanyPricesV1 = Static<
  typeof commerceCompanyPricesV1Schema
>;

const statusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("inactive"),
]);

/** Invoice terms: an order placed on terms is due this many days later. */
export const commerceCompanyPaymentTermsV1Schema = ReadonlyStrictObject({
  netDays: Type.Integer({ minimum: 0, maximum: 120 }),
});
export type CommerceCompanyPaymentTermsV1 = Static<
  typeof commerceCompanyPaymentTermsV1Schema
>;

export const commerceCompanyV1Schema = ReadonlyStrictObject({
  id: text,
  revision: PositiveInteger,
  name: text,
  customerIds: customerIdsSchema,
  prices: commerceCompanyPricesV1Schema,
  paymentTerms: Nullable(commerceCompanyPaymentTermsV1Schema),
  status: statusSchema,
  occurredAt: utcTimestampSchema,
});
export type CommerceCompanyV1 = Static<typeof commerceCompanyV1Schema>;

const companyCommandBaseSchema = ReadonlyOpenObject({
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
  companyId: text,
});

export const createCommerceCompanyV1Schema = Type.Intersect(
  [
    companyCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.create-company.v1"),
      name: boundedTextSchema(100),
      customerIds: customerIdsSchema,
      prices: commerceCompanyPricesV1Schema,
      /** None when the company pays at checkout. */
      paymentTerms: Type.Optional(
        Nullable(commerceCompanyPaymentTermsV1Schema),
      ),
    }),
  ],
  exactKeys,
);
export type CreateCommerceCompanyV1 = Static<
  typeof createCommerceCompanyV1Schema
>;

function namesAChange(changes: object): boolean {
  return Object.keys(changes).length > 0;
}

function noChangeError(): string {
  return "changes must name at least one field";
}

export const updateCommerceCompanyV1Schema = Type.Intersect(
  [
    companyCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.update-company.v1"),
      expectedRevision: PositiveInteger,
      changes: Type.Refine(
        ReadonlyStrictObject({
          name: Type.Optional(boundedTextSchema(100)),
          customerIds: Type.Optional(customerIdsSchema),
          prices: Type.Optional(commerceCompanyPricesV1Schema),
          paymentTerms: Type.Optional(
            Nullable(commerceCompanyPaymentTermsV1Schema),
          ),
          status: Type.Optional(statusSchema),
        }),
        namesAChange,
        noChangeError,
      ),
    }),
  ],
  exactKeys,
);
export type UpdateCommerceCompanyV1 = Static<
  typeof updateCommerceCompanyV1Schema
>;

export type CommerceCompanyCommandV1 =
  CreateCommerceCompanyV1 | UpdateCommerceCompanyV1;

export const commerceCompaniesV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.companies.v1"),
  companies: ImmutableArray(commerceCompanyV1Schema),
});
export type CommerceCompaniesV1 = Static<typeof commerceCompaniesV1Schema>;

const moneySchema = ReadonlyStrictObject({
  amountMinor: NonNegativeInteger,
  currency: marketCurrencySchema,
});

/**
 * An order on invoice terms. The order holds a captured payment of the
 * amount due, as a paid order does; the invoice says whether the company
 * paid it.
 */
export const commerceCompanyInvoiceV1Schema = ReadonlyStrictObject({
  id: text,
  revision: PositiveInteger,
  companyId: text,
  orderId: text,
  paymentId: text,
  amount: moneySchema,
  issuedAt: utcTimestampSchema,
  dueAt: utcTimestampSchema,
  state: Type.Union([
    ReadonlyStrictObject({ kind: Type.Literal("open") }),
    ReadonlyStrictObject({
      kind: Type.Literal("overdue"),
      since: utcTimestampSchema,
    }),
    ReadonlyStrictObject({
      kind: Type.Literal("paid"),
      paidAt: utcTimestampSchema,
      /** The reference on the bank statement. */
      reference: boundedTextSchema(100),
    }),
  ]),
  occurredAt: utcTimestampSchema,
});
export type CommerceCompanyInvoiceV1 = Static<
  typeof commerceCompanyInvoiceV1Schema
>;

const commandBaseSchema = ReadonlyOpenObject({
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
});

/** Staff place a draft order for a company's buyer on the company's terms. */
export const placeCommerceDraftOrderOnTermsV1Schema = Type.Intersect(
  [
    commandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.place-draft-order-on-terms.v1"),
      draftOrderId: text,
      expectedDraftOrderRevision: PositiveInteger,
      orderId: text,
      paymentId: text,
      fulfillmentId: text,
      invoiceId: text,
    }),
  ],
  exactKeys,
);
export type PlaceCommerceDraftOrderOnTermsV1 = Static<
  typeof placeCommerceDraftOrderOnTermsV1Schema
>;

/** Staff record the company's bank transfer of an invoice. */
export const recordCommerceInvoicePaymentV1Schema = Type.Intersect(
  [
    commandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.record-invoice-payment.v1"),
      invoiceId: text,
      expectedRevision: PositiveInteger,
      reference: boundedTextSchema(100),
    }),
  ],
  exactKeys,
);
export type RecordCommerceInvoicePaymentV1 = Static<
  typeof recordCommerceInvoicePaymentV1Schema
>;

export const commerceCompanyInvoicesV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.company-invoices.v1"),
  invoices: ImmutableArray(commerceCompanyInvoiceV1Schema),
});

export const parseCommerceCompanyInvoiceV1 = wireRecordParser(
  commerceCompanyInvoiceV1Schema,
);
export const parsePlaceCommerceDraftOrderOnTermsV1 = wireRecordParser(
  placeCommerceDraftOrderOnTermsV1Schema,
);
export const parseRecordCommerceInvoicePaymentV1 = wireRecordParser(
  recordCommerceInvoicePaymentV1Schema,
);
export const parseCommerceCompanyInvoicesV1 = wireRecordParser(
  commerceCompanyInvoicesV1Schema,
);

export const parseCommerceCompanyV1 = wireRecordParser(
  commerceCompanyV1Schema,
);
export const parseCreateCommerceCompanyV1 = wireRecordParser(
  createCommerceCompanyV1Schema,
);
export const parseUpdateCommerceCompanyV1 = wireRecordParser(
  updateCommerceCompanyV1Schema,
);
export const parseCommerceCompaniesV1 = wireRecordParser(
  commerceCompaniesV1Schema,
);
