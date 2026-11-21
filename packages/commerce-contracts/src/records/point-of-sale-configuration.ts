// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import {
  NonNegativeInteger,
  PositiveInteger,
  StrictObject,
  recordParser,
} from "@purin-labs/contract-schema";
import { storefrontTaxConfigurationSchema } from "./commerce-records.ts";
import { identityTextSchema } from "./commerce-fields.ts";
import { currencyCodeTextSchema, normalizedTextSchema } from "./fields.ts";
import type { CommerceMerchantId } from "./identifiers.ts";

/**
 * One item a counter may sell, and how much of it per line.
 *
 * A counter basket is entered by hand under time pressure, so the quantity
 * ceiling is part of the published policy rather than a UI convention.
 */
export const pointOfSaleItemPolicySchema = StrictObject({
  variantId: normalizedTextSchema,
  maxQuantityPerLine: PositiveInteger,
});
export type PointOfSaleItemPolicy = Static<typeof pointOfSaleItemPolicySchema>;

/**
 * What catalog surface a counter rings up from: either an explicit list of
 * `supportedItems` variants, or the location's published café menu with
 * modifiers, serving hours, and sold-out enforcement.
 */
export const pointOfSaleCatalogScopeSchema = Type.Union([
  StrictObject({ kind: Type.Literal("supported_items") }),
  StrictObject({
    kind: Type.Literal("published_menu"),
    menuId: normalizedTextSchema,
    maxQuantityPerLine: PositiveInteger,
  }),
]);
export type PointOfSaleCatalogScope = Static<
  typeof pointOfSaleCatalogScopeSchema
>;

// The after-sale, presentation and lifecycle rules of a counter policy are
// the checkout profile readers' rules (`parseCheckoutAfterSalePolicy`,
// `parseCheckoutPresentationPolicy` and the client's
// `parseCheckoutProfileLifecycle`).
const refundGovernanceSchema = Type.Union([
  StrictObject({ kind: Type.Literal("approval_required") }),
  StrictObject({
    kind: Type.Literal("automatic_up_to"),
    threshold: StrictObject({
      amountMinor: PositiveInteger,
      currency: Type.String({ pattern: "^[A-Z]{3}$" }),
    }),
  }),
]);

const afterSalePolicySchema = StrictObject({
  cancellationPolicyId: identityTextSchema,
  refundPolicyId: identityTextSchema,
  refundGovernance: refundGovernanceSchema,
});

const presentationPolicySchema = StrictObject({
  locale: identityTextSchema,
  merchantDisplayName: identityTextSchema,
  termsPolicyId: identityTextSchema,
  privacyPolicyId: identityTextSchema,
  supportContact: identityTextSchema,
});

/**
 * A lifecycle timestamp: any text that `Date.parse` reads, returned as an
 * ISO 8601 UTC timestamp (`requireTimestamp` in checkout-profile.ts).
 */
const lifecycleTimestampSchema = Type.Codec(
  Type.Refine(
    normalizedTextSchema,
    isParsableTimestamp,
    parsableTimestampError,
  ),
)
  .Decode(toIsoTimestamp)
  .Encode(sameTimestamp);

const lifecycleSchema = Type.Union([
  Type.Refine(
    StrictObject({
      state: Type.Literal("draft"),
      createdAt: lifecycleTimestampSchema,
      updatedAt: lifecycleTimestampSchema,
    }),
    draftTimestampsInOrder,
    timestampOrderError,
  ),
  StrictObject({
    state: Type.Literal("published"),
    publishedAt: lifecycleTimestampSchema,
    publishedBy: identityTextSchema,
  }),
  Type.Refine(
    StrictObject({
      state: Type.Literal("retired"),
      publishedAt: lifecycleTimestampSchema,
      retiredAt: lifecycleTimestampSchema,
      retiredBy: identityTextSchema,
    }),
    retiredTimestampsInOrder,
    timestampOrderError,
  ),
]);

/**
 * The published configuration one Pantry location sells under at the counter.
 * Every field is required: a counter policy that is missing its tax rate or
 * item list is not a partial policy, it is an unsellable one.
 */
export const pointOfSaleConfigurationSchema = Type.Refine(
  Type.Refine(
    StrictObject({
      configurationId: normalizedTextSchema,
      organisationId: normalizedTextSchema,
      merchantId: Type.Unsafe<CommerceMerchantId>(normalizedTextSchema),
      pantryLocationId: normalizedTextSchema,
      salesChannelId: normalizedTextSchema,
      currency: currencyCodeTextSchema,
      supportedItems: Type.Array(pointOfSaleItemPolicySchema),
      catalogScope: Type.Optional(pointOfSaleCatalogScopeSchema),
      cashEnabled: Type.Optional(Type.Boolean()),
      quoteTtlSeconds: PositiveInteger,
      tax: storefrontTaxConfigurationSchema,
      pickupReadyLeadTimeSeconds: NonNegativeInteger,
      afterSalePolicy: afterSalePolicySchema,
      presentationPolicy: presentationPolicySchema,
      revision: PositiveInteger,
      lifecycle: lifecycleSchema,
    }),
    hasSellableCatalogScope,
    sellableCatalogScopeError,
  ),
  refundThresholdInCurrency,
  refundThresholdCurrencyError,
);
export type PointOfSaleConfiguration = Static<
  typeof pointOfSaleConfigurationSchema
>;

function isParsableTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function parsableTimestampError(): string {
  return "must be a timestamp";
}

function toIsoTimestamp(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

function sameTimestamp(value: string): string {
  return value;
}

function draftTimestampsInOrder(
  lifecycle: Readonly<{ createdAt: string; updatedAt: string }>,
): boolean {
  return !(Date.parse(lifecycle.updatedAt) < Date.parse(lifecycle.createdAt));
}

function retiredTimestampsInOrder(
  lifecycle: Readonly<{ publishedAt: string; retiredAt: string }>,
): boolean {
  return !(Date.parse(lifecycle.retiredAt) < Date.parse(lifecycle.publishedAt));
}

function timestampOrderError(): string {
  return "lifecycle timestamps are out of order";
}

/** An automatic refund threshold is money in the counter's currency. */
function refundThresholdInCurrency(
  configuration: Readonly<{
    currency: string;
    afterSalePolicy: Readonly<{
      refundGovernance:
        | Readonly<{ kind: "approval_required" }>
        | Readonly<{
            kind: "automatic_up_to";
            threshold: Readonly<{ currency: string }>;
          }>;
    }>;
  }>,
): boolean {
  const governance = configuration.afterSalePolicy.refundGovernance;
  return (
    governance.kind !== "automatic_up_to" ||
    governance.threshold.currency === configuration.currency
  );
}

function refundThresholdCurrencyError(): string {
  return "afterSalePolicy.refundGovernance.threshold must use the configuration currency";
}

function hasSellableCatalogScope(
  configuration: Readonly<{
    supportedItems: readonly PointOfSaleItemPolicy[];
    catalogScope?: PointOfSaleCatalogScope;
  }>,
): boolean {
  return (
    configuration.catalogScope?.kind === "published_menu" ||
    configuration.supportedItems.length > 0
  );
}

function sellableCatalogScopeError(): string {
  return "supportedItems must list at least one item when catalogScope is supported_items";
}

// Parsers of the records above (Plan 78 step 2).
export const parsePointOfSaleItemPolicy = recordParser(
  pointOfSaleItemPolicySchema,
);
export const parsePointOfSaleConfiguration = recordParser(
  pointOfSaleConfigurationSchema,
  "pointOfSaleConfiguration",
);
