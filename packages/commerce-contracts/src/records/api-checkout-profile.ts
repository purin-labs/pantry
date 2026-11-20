// Plan 78 step 2: the checkout profile records that
// packages/commerce-client reads in src/checkout-profile.ts. Each
// schema follows its hand-written reader: exact keys, text of at most 255
// characters, timestamps written as `Date.toISOString` writes them, and the
// configuration as `parseCheckoutProfileConfiguration` reads it.
import { Type, type Static } from "typebox";
import { PositiveInteger } from "@purin-labs/contract-schema";
import type {
  CheckoutProfile,
  CheckoutProfileLifecycle,
} from "../commerce-domain.ts";
import { parseCheckoutProfileConfiguration } from "../checkout-profile.ts";
import { ParsedBy } from "./client-wire-fields.ts";
import { boundedTextSchema, normalizedTextSchema } from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = boundedTextSchema(255);

/** `requireTimestamp` of checkout-profile.ts, rewritten as an ISO string. */
const timestampSchema = Type.Codec(
  Type.Refine(normalizedTextSchema, isTimestamp, timestampError),
)
  .Decode(isoTimestamp)
  .Encode(sameText);

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function timestampError(): string {
  return "must be a timestamp";
}

function isoTimestamp(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

function sameText(value: string): string {
  return value;
}

const configurationSchema = ParsedBy(parseCheckoutProfileConfiguration);

export const createCommerceCheckoutProfileDraftV1Schema =
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.create-checkout-profile-draft.v1"),
    merchantId: text,
    checkoutProfileId: text,
    name: text,
    configuration: configurationSchema,
    createdAt: timestampSchema,
  });
export type CreateCommerceCheckoutProfileDraftV1 = Static<
  typeof createCommerceCheckoutProfileDraftV1Schema
>;

export const replaceCommerceCheckoutProfileDraftV1Schema =
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.replace-checkout-profile-draft.v1"),
    merchantId: text,
    checkoutProfileId: text,
    expectedRevision: PositiveInteger,
    name: text,
    configuration: configurationSchema,
    updatedAt: timestampSchema,
  });
export type ReplaceCommerceCheckoutProfileDraftV1 = Static<
  typeof replaceCommerceCheckoutProfileDraftV1Schema
>;

export const publishCommerceCheckoutProfileV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.publish-checkout-profile.v1"),
  merchantId: text,
  checkoutProfileId: text,
  expectedRevision: PositiveInteger,
  publishedAt: timestampSchema,
  publishedBy: text,
});
export type PublishCommerceCheckoutProfileV1 = Static<
  typeof publishCommerceCheckoutProfileV1Schema
>;

export const retireCommerceCheckoutProfileV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.retire-checkout-profile.v1"),
  merchantId: text,
  checkoutProfileId: text,
  expectedRevision: PositiveInteger,
  retiredAt: timestampSchema,
  retiredBy: text,
});
export type RetireCommerceCheckoutProfileV1 = Static<
  typeof retireCommerceCheckoutProfileV1Schema
>;

const activationProperties = {
  merchantId: text,
  storefrontId: text,
  checkoutProfileId: text,
  checkoutProfileRevision: PositiveInteger,
  activatedAt: timestampSchema,
  activatedBy: text,
};

export const activateCommerceCheckoutProfileV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.activate-checkout-profile.v1"),
  ...activationProperties,
});
export type ActivateCommerceCheckoutProfileV1 = Static<
  typeof activateCommerceCheckoutProfileV1Schema
>;

export const commerceCheckoutProfileActivationV1Schema =
  ReadonlyStrictObject(activationProperties);
export type CommerceCheckoutProfileActivationV1 = Static<
  typeof commerceCheckoutProfileActivationV1Schema
>;

/** `requireTimestampOrder`: the later time is not before the earlier one. */
function inOrder(earlier: string, later: string, value: unknown): boolean {
  const record = value as Readonly<Record<string, string>>;
  return Date.parse(record[later]!) >= Date.parse(record[earlier]!);
}

function outOfOrder(): string {
  return "timestamps are out of order";
}

export const wireCheckoutProfileLifecycleSchema =
  Type.Unsafe<CheckoutProfileLifecycle>(
    Type.Union([
      Type.Refine(
        ReadonlyStrictObject({
          state: Type.Literal("draft"),
          createdAt: timestampSchema,
          updatedAt: timestampSchema,
        }),
        inOrder.bind(null, "createdAt", "updatedAt"),
        outOfOrder,
      ),
      ReadonlyStrictObject({
        state: Type.Literal("published"),
        publishedAt: timestampSchema,
        publishedBy: text,
      }),
      Type.Refine(
        ReadonlyStrictObject({
          state: Type.Literal("retired"),
          publishedAt: timestampSchema,
          retiredAt: timestampSchema,
          retiredBy: text,
        }),
        inOrder.bind(null, "publishedAt", "retiredAt"),
        outOfOrder,
      ),
    ]),
  );

export const wireCheckoutProfileSchema = Type.Unsafe<CheckoutProfile>(
  ReadonlyStrictObject({
    checkoutProfileId: text,
    merchantId: text,
    revision: PositiveInteger,
    name: text,
    configuration: configurationSchema,
    lifecycle: wireCheckoutProfileLifecycleSchema,
  }),
);

export const commerceActiveCheckoutProfileV1Schema = ReadonlyStrictObject({
  activation: commerceCheckoutProfileActivationV1Schema,
  profile: wireCheckoutProfileSchema,
});
export type CommerceActiveCheckoutProfileV1 = Static<
  typeof commerceActiveCheckoutProfileV1Schema
>;

/** `parseCheckoutProfiles`. */
export const commerceCheckoutProfilesV1Schema = ImmutableArray(
  wireCheckoutProfileSchema,
);

/** `parseCheckoutProfileActivations`. */
export const commerceCheckoutProfileActivationsV1Schema = ImmutableArray(
  commerceCheckoutProfileActivationV1Schema,
);

/** `parseStorefrontIds`: each storefront once, in sorted order. */
export const commerceCheckoutProfileStorefrontIdsV1Schema = Type.Unsafe<
  readonly string[]
>(Type.Codec(ImmutableArray(text)).Decode(uniqueSortedIds).Encode(sameIds));

function uniqueSortedIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort();
}

function sameIds(ids: readonly string[]): readonly string[] {
  return ids;
}

// Parsers of the client API types (Plan 78 step 2).
export const parseCommerceCheckoutProfilesV1 = wireRecordParser(
  commerceCheckoutProfilesV1Schema,
);
export const parseCommerceCheckoutProfileActivationsV1 = wireRecordParser(
  commerceCheckoutProfileActivationsV1Schema,
);
export const parseCommerceCheckoutProfileStorefrontIdsV1 = wireRecordParser(
  commerceCheckoutProfileStorefrontIdsV1Schema,
);
export const parseActivateCommerceCheckoutProfileV1 = wireRecordParser(
  activateCommerceCheckoutProfileV1Schema,
);
export const parseCreateCommerceCheckoutProfileDraftV1 = wireRecordParser(
  createCommerceCheckoutProfileDraftV1Schema,
);
export const parsePublishCommerceCheckoutProfileV1 = wireRecordParser(
  publishCommerceCheckoutProfileV1Schema,
);
export const parseReplaceCommerceCheckoutProfileDraftV1 = wireRecordParser(
  replaceCommerceCheckoutProfileDraftV1Schema,
);
export const parseRetireCommerceCheckoutProfileV1 = wireRecordParser(
  retireCommerceCheckoutProfileV1Schema,
);
export const parseCommerceActiveCheckoutProfileV1 = wireRecordParser(
  commerceActiveCheckoutProfileV1Schema,
);
export const parseWireCheckoutProfile = wireRecordParser(
  wireCheckoutProfileSchema,
);
export const parseWireCheckoutProfileLifecycle = wireRecordParser(
  wireCheckoutProfileLifecycleSchema,
);
