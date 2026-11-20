// Wire records that the resource, admin and storefront readers share (Plan 78
// step 2). Each schema follows its hand-written client reader.
import { Type, type Static } from "typebox";
import type {
  InPersonPaymentBinding,
  OnlinePaymentBinding,
  ProtectedBuyerContact,
} from "../commerce-domain.ts";
import type { PointOfSaleBuyer } from "./commerce-records.ts";
import {
  NonNegativeInteger,
  PositiveInteger,
} from "@purin-labs/contract-schema";
import {
  parseInPersonPaymentBinding,
  parseOnlinePaymentBinding,
} from "../payment-binding.ts";
import {
  currencyCodeTextSchema,
  normalizedTextSchema,
  sha256HexSchema,
  utcTimestampSchema,
} from "./fields.ts";
import {
  inPersonPaymentBindingSchema,
  inventoryExpiryTrackingSchema,
  inventoryItemCategorySchema,
  locationKindSchema,
  onlinePaymentBindingSchema,
  quantityUnitSchema,
  salesChannelKindSchema,
} from "./commerce-records.ts";
import {
  Absent,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
} from "./wire-objects.ts";

/** `parseMoney`: a non-negative amount in an uppercase currency. */
export const wireMoneySchema = ReadonlyOpenObject({
  amountMinor: NonNegativeInteger,
  currency: currencyCodeTextSchema,
});

/** `parseQuantity`: a scale up to 6, and 0 for `each`. */
export const wireQuantitySchema = Type.Refine(
  ReadonlyOpenObject({
    amount: NonNegativeInteger,
    scale: Type.Integer({ ...NonNegativeInteger, maximum: 6 }),
    unit: quantityUnitSchema,
  }),
  isQuantityScaleValid,
  quantityScaleError,
);

function isQuantityScaleValid(
  quantity: Readonly<{ unit: string; scale: number }>,
): boolean {
  return quantity.unit !== "each" || quantity.scale === 0;
}

function quantityScaleError(): string {
  return "the scale must be 0 for each";
}

/** `parseActiveLifecycle`. */
export const wireLocationLifecycleSchema = Type.Union([
  ReadonlyOpenObject({
    state: Type.Literal("active"),
    activeAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("inactive"),
    inactiveAt: utcTimestampSchema,
  }),
]);

/** `parseLocation`. */
export const wireLocationSchema = ReadonlyOpenObject({
  id: normalizedTextSchema,
  revision: PositiveInteger,
  name: normalizedTextSchema,
  kind: locationKindSchema,
  lifecycle: wireLocationLifecycleSchema,
  occurredAt: utcTimestampSchema,
});

/** `parseSalesChannel`. */
export const wireSalesChannelSchema = ReadonlyOpenObject({
  id: normalizedTextSchema,
  revision: PositiveInteger,
  name: normalizedTextSchema,
  kind: salesChannelKindSchema,
  lifecycle: wireLocationLifecycleSchema,
  occurredAt: utcTimestampSchema,
});

/** `parseOffer`: the compare-at price is positive and in the offer currency. */
export const wireOfferSchema = Type.Refine(
  ReadonlyOpenObject({
    id: normalizedTextSchema,
    revision: PositiveInteger,
    variantId: normalizedTextSchema,
    salesChannelId: normalizedTextSchema,
    price: ReadonlyOpenObject({
      amountMinor: NonNegativeInteger,
      currency: currencyCodeTextSchema,
    }),
    compareAtPrice: Type.Union(
      [
        ReadonlyOpenObject({
          amountMinor: PositiveInteger,
          currency: currencyCodeTextSchema,
        }),
        Type.Null(),
      ],
      { default: null },
    ),
    availability: Type.Union([
      ReadonlyOpenObject({ state: Type.Literal("available") }),
      ReadonlyOpenObject({ state: Type.Literal("unavailable") }),
      ReadonlyOpenObject({
        state: Type.Literal("backordered"),
        expectedAt: utcTimestampSchema,
      }),
    ]),
    lifecycle: Type.Union([
      ReadonlyOpenObject({
        state: Type.Literal("prepared"),
        preparedAt: utcTimestampSchema,
      }),
      ReadonlyOpenObject({
        state: Type.Literal("listed"),
        listedAt: utcTimestampSchema,
      }),
      ReadonlyOpenObject({
        state: Type.Literal("archived"),
        archivedAt: utcTimestampSchema,
      }),
    ]),
    occurredAt: utcTimestampSchema,
  }),
  isCompareAtInOfferCurrency,
  compareAtCurrencyError,
);

function isCompareAtInOfferCurrency(offer: {
  readonly price: { readonly currency: string };
  readonly compareAtPrice: { readonly currency: string } | null;
}): boolean {
  return (
    offer.compareAtPrice === null ||
    offer.compareAtPrice.currency === offer.price.currency
  );
}

function compareAtCurrencyError(): string {
  return "the compare-at price must use the offer currency";
}

/** `parseBuyer`. */
export const wireBuyerSchema = Type.Union([
  ReadonlyOpenObject({
    kind: Type.Literal("identified"),
    customerReference: normalizedTextSchema,
  }),
  ReadonlyOpenObject({ kind: Type.Literal("guest") }),
]);

/** `parseProtectedBuyerContact`: exact keys and SHA-256 digests. */
export const wireProtectedBuyerContactSchema =
  Type.Unsafe<ProtectedBuyerContact>(
    Type.Union([
      Type.Object(
        { kind: Type.Literal("email"), emailDigest: sha256HexSchema },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("email_and_phone"),
          emailDigest: sha256HexSchema,
          phoneDigest: sha256HexSchema,
        },
        { additionalProperties: false },
      ),
    ]),
  );

/** `parsePointOfSaleBuyer`: exact keys in each variant. */
export const wirePointOfSaleBuyerSchema = Type.Unsafe<PointOfSaleBuyer>(
  Type.Union([
    Type.Object(
      { kind: Type.Literal("anonymous") },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("identified_customer"),
        customerId: normalizedTextSchema,
      },
      { additionalProperties: false },
    ),
  ]),
);

/** `parseInventoryReceiptPurchase`. */
export const wireInventoryReceiptPurchaseSchema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("unlinked"),
    entryId: Absent,
    entryRevision: Absent,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("replenishment"),
    entryId: normalizedTextSchema,
    entryRevision: PositiveInteger,
  }),
]);

/** `parseInventoryTracking`. */
export const wireInventoryTrackingSchema = Type.Union([
  ReadonlyOpenObject({ kind: Type.Literal("aggregate") }),
  ReadonlyOpenObject({
    kind: Type.Literal("lot_tracked"),
    expiry: inventoryExpiryTrackingSchema,
  }),
]);

/** `parseInventoryLotExpiry`. */
export const wireInventoryLotExpirySchema = Type.Union([
  ReadonlyStrictObject({ kind: Type.Literal("not_tracked") }),
  ReadonlyOpenObject({
    kind: Type.Literal("expires"),
    expiresAt: utcTimestampSchema,
  }),
]);

/** `parseOnlinePaymentBinding` from the contracts package. */
export const wireOnlinePaymentBindingSchema = Type.Unsafe<OnlinePaymentBinding>(
  Type.Refine(
    onlinePaymentBindingSchema,
    isOnlinePaymentBinding,
    invalidPaymentBinding,
  ),
);

/** `parseInPersonPaymentBinding` from the contracts package. */
export const wireInPersonPaymentBindingSchema =
  Type.Unsafe<InPersonPaymentBinding>(
    Type.Refine(
      inPersonPaymentBindingSchema,
      isInPersonPaymentBinding,
      invalidPaymentBinding,
    ),
  );

function isOnlinePaymentBinding(value: unknown): boolean {
  return parseOnlinePaymentBinding(value).ok;
}

function isInPersonPaymentBinding(value: unknown): boolean {
  return parseInPersonPaymentBinding(value).ok;
}

function invalidPaymentBinding(): string {
  return "the payment binding is invalid";
}

export { inventoryItemCategorySchema as wireInventoryItemCategorySchema };

// The client types of the records above.
export type CommerceMoneyV1 = Static<typeof wireMoneySchema>;
export type CommerceQuantityV1 = Static<typeof wireQuantitySchema>;
export type CommerceLocationLifecycle = Static<
  typeof wireLocationLifecycleSchema
>;
export type CommerceLocationV1 = Static<typeof wireLocationSchema>;
export type CommerceSalesChannelV1 = Static<typeof wireSalesChannelSchema>;
export type CommerceOfferV1 = Static<typeof wireOfferSchema>;
export type CommerceBuyerV1 = Static<typeof wireBuyerSchema>;
export type CommerceProtectedBuyerContactV1 = Static<
  typeof wireProtectedBuyerContactSchema
>;
export type CommerceInventoryReceiptPurchase = Static<
  typeof wireInventoryReceiptPurchaseSchema
>;
export type CommerceInventoryLotExpiryV1 = Static<
  typeof wireInventoryLotExpirySchema
>;
