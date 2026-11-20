// Plan 78 step 2: the customer records that packages/commerce-client
// reads in src/customers.ts. Each schema follows its hand-written reader:
// exact keys, bounded text, unique tags, and a buyer email in lower case.
import { Type, type Static } from "typebox";
import { NonNegativeInteger, PositiveInteger } from "@purin-labs/contract-schema";
import {
  boundedTextSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import { Nullable, wireMoneySchema } from "./client-wire-fields.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;
const exactKeys = { unevaluatedProperties: false } as const;

export const customersMoneySchema = wireMoneySchema;
export type CustomersMoney = Static<typeof customersMoneySchema>;

/** `normalizeCustomerEmail`: trimmed, in lower case, at most 254 characters. */
const customerEmailSchema = Type.Codec(
  Type.Refine(Type.String(), isCustomerEmail, customerEmailError),
)
  .Decode(normalizeCustomerEmail)
  .Encode(sameText);

function normalizeCustomerEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isCustomerEmail(value: string): boolean {
  const email = normalizeCustomerEmail(value);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function customerEmailError(): string {
  return "must be an email address";
}

function sameText(value: string): string {
  return value;
}

/** `parseTags`: text of at most 64 characters, each tag once. */
const tagsSchema = Type.Refine(
  ImmutableArray(boundedTextSchema(64)),
  hasUniqueTags,
  tagsError,
);

function hasUniqueTags(tags: readonly string[]): boolean {
  return new Set(tags).size === tags.length;
}

function tagsError(): string {
  return "tags must be unique";
}

export const customerCommandBaseSchema = ReadonlyOpenObject({
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
  customerId: text,
});
export type CustomerCommandBase = Static<typeof customerCommandBaseSchema>;

export const createCommerceCustomerV1Schema = Type.Intersect(
  [
    customerCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.create-customer.v1"),
      email: customerEmailSchema,
      name: Nullable(boundedTextSchema(200)),
      phone: Nullable(boundedTextSchema(40)),
      note: Nullable(boundedTextSchema(2_000)),
      tags: tagsSchema,
    }),
  ],
  exactKeys,
);
export type CreateCommerceCustomerV1 = Static<
  typeof createCommerceCustomerV1Schema
>;

export const commerceMarketingConsentStateSchema = Type.Union([
  Type.Literal("not_subscribed"),
  Type.Literal("subscribed"),
  Type.Literal("unsubscribed"),
]);
export type CommerceMarketingConsentState = Static<
  typeof commerceMarketingConsentStateSchema
>;

/** Only the named fields change; at least one is named. */
const customerChangesSchema = Type.Refine(
  ReadonlyStrictObject({
    name: Type.Optional(Nullable(boundedTextSchema(200))),
    phone: Type.Optional(Nullable(boundedTextSchema(40))),
    note: Type.Optional(Nullable(boundedTextSchema(2_000))),
    tags: Type.Optional(tagsSchema),
    marketing: Type.Optional(
      ReadonlyStrictObject({
        email: Type.Optional(commerceMarketingConsentStateSchema),
        sms: Type.Optional(commerceMarketingConsentStateSchema),
      }),
    ),
  }),
  namesAChange,
  noChangeError,
);

function namesAChange(changes: object): boolean {
  return Object.keys(changes).length > 0;
}

function noChangeError(): string {
  return "changes must name at least one field";
}

export const updateCommerceCustomerV1Schema = Type.Intersect(
  [
    customerCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.update-customer.v1"),
      expectedRevision: PositiveInteger,
      changes: customerChangesSchema,
    }),
  ],
  exactKeys,
);
export type UpdateCommerceCustomerV1 = Static<
  typeof updateCommerceCustomerV1Schema
>;

export const eraseCommerceCustomerV1Schema = Type.Intersect(
  [
    customerCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.erase-customer.v1"),
      expectedRevision: PositiveInteger,
      reason: boundedTextSchema(500),
    }),
  ],
  exactKeys,
);
export type EraseCommerceCustomerV1 = Static<
  typeof eraseCommerceCustomerV1Schema
>;

export const commerceCustomerCommandV1Schema = Type.Union([
  createCommerceCustomerV1Schema,
  updateCommerceCustomerV1Schema,
  eraseCommerceCustomerV1Schema,
]);
export type CommerceCustomerCommandV1 = Static<
  typeof commerceCustomerCommandV1Schema
>;

export const requestCommerceCustomerSignInV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.request-customer-sign-in.v1"),
  email: customerEmailSchema,
});
export type RequestCommerceCustomerSignInV1 = Static<
  typeof requestCommerceCustomerSignInV1Schema
>;

export const verifyCommerceCustomerSignInV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.verify-customer-sign-in.v1"),
  code: Type.String({ pattern: "^\\d{6}$" }),
});
export type VerifyCommerceCustomerSignInV1 = Static<
  typeof verifyCommerceCustomerSignInV1Schema
>;

const addressInputProperties = {
  recipient: boundedTextSchema(200),
  line1: boundedTextSchema(200),
  line2: Nullable(boundedTextSchema(200)),
  locality: boundedTextSchema(100),
  region: Nullable(boundedTextSchema(100)),
  postalCode: boundedTextSchema(20),
  countryCode: Type.String({ pattern: "^[A-Z]{2}$" }),
};

export const commerceCustomerAddressInputV1Schema = ReadonlyStrictObject(
  addressInputProperties,
);
export type CommerceCustomerAddressInputV1 = Static<
  typeof commerceCustomerAddressInputV1Schema
>;

export const saveCommerceCustomerAddressV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.save-customer-address.v1"),
  address: commerceCustomerAddressInputV1Schema,
});
export type SaveCommerceCustomerAddressV1 = Static<
  typeof saveCommerceCustomerAddressV1Schema
>;

export const commerceCustomerAddressV1Schema = Type.Intersect(
  [
    ReadonlyOpenObject(addressInputProperties),
    ReadonlyOpenObject({ addressId: text }),
  ],
  exactKeys,
);
export type CommerceCustomerAddressV1 = Static<
  typeof commerceCustomerAddressV1Schema
>;

export const commerceMarketingConsentV1Schema = ReadonlyStrictObject({
  state: commerceMarketingConsentStateSchema,
  updatedAt: Nullable(utcTimestampSchema),
  source: Nullable(Type.Union([Type.Literal("buyer"), Type.Literal("staff")])),
});
export type CommerceMarketingConsentV1 = Static<
  typeof commerceMarketingConsentV1Schema
>;

export const commerceCustomerV1Schema = ReadonlyStrictObject({
  id: text,
  revision: PositiveInteger,
  state: Type.Union([Type.Literal("active"), Type.Literal("erased")]),
  account: Type.Union([Type.Literal("none"), Type.Literal("enabled")]),
  email: Nullable(text),
  name: Nullable(boundedTextSchema(200)),
  phone: Nullable(boundedTextSchema(40)),
  note: Nullable(boundedTextSchema(2_000)),
  addresses: ImmutableArray(commerceCustomerAddressV1Schema),
  tags: tagsSchema,
  marketing: ReadonlyStrictObject({
    email: commerceMarketingConsentV1Schema,
    sms: commerceMarketingConsentV1Schema,
  }),
  orderIds: ImmutableArray(text),
  createdAt: utcTimestampSchema,
  occurredAt: utcTimestampSchema,
});
export type CommerceCustomerV1 = Static<typeof commerceCustomerV1Schema>;

export const commerceCustomerExportV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.customer-export.v1"),
  customer: commerceCustomerV1Schema,
  exportedAt: utcTimestampSchema,
});
export type CommerceCustomerExportV1 = Static<
  typeof commerceCustomerExportV1Schema
>;

export const commerceCustomerSignInChallengeV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.customer-sign-in-challenge.v1"),
  challengeId: text,
  expiresAt: utcTimestampSchema,
});
export type CommerceCustomerSignInChallengeV1 = Static<
  typeof commerceCustomerSignInChallengeV1Schema
>;

export const commerceCustomerAccessV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.customer-access.v1"),
  customerAccessToken: text,
  expiresAt: utcTimestampSchema,
});
export type CommerceCustomerAccessV1 = Static<
  typeof commerceCustomerAccessV1Schema
>;

export const commerceBuyerCustomerV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.buyer-customer.v1"),
  email: text,
  name: Nullable(boundedTextSchema(200)),
  addresses: ImmutableArray(commerceCustomerAddressV1Schema),
  orders: ImmutableArray(
    ReadonlyStrictObject({
      orderId: text,
      placedAt: utcTimestampSchema,
      total: wireMoneySchema,
      state: text,
    }),
  ),
});
export type CommerceBuyerCustomerV1 = Static<
  typeof commerceBuyerCustomerV1Schema
>;

export const commerceNotificationV1Schema = ReadonlyStrictObject({
  notificationId: text,
  kind: Type.Union([
    Type.Literal("order_confirmation"),
    Type.Literal("ready_for_pickup"),
    Type.Literal("sign_in_code"),
    Type.Literal("order_shipped"),
    Type.Literal("refund_issued"),
  ]),
  orderId: Nullable(text),
  customerId: Nullable(text),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("sent"),
    Type.Literal("failed"),
    Type.Literal("dropped"),
  ]),
  attempts: NonNegativeInteger,
  providerMessageId: Nullable(text),
  createdAt: utcTimestampSchema,
  sentAt: Nullable(utcTimestampSchema),
});
export type CommerceNotificationV1 = Static<
  typeof commerceNotificationV1Schema
>;

/** `parseNotifications`: the list of a merchant's buyer messages. */
export const commerceNotificationsV1Schema = Type.Codec(
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.notifications.v1"),
    notifications: ImmutableArray(commerceNotificationV1Schema),
  }),
)
  .Decode(notificationsOf)
  .Encode(notificationsList);

type NotificationList = Readonly<{
  schemaVersion: "underclerk.notifications.v1";
  notifications: readonly CommerceNotificationV1[];
}>;

function notificationsOf(
  list: NotificationList,
): readonly CommerceNotificationV1[] {
  return list.notifications;
}

function notificationsList(
  notifications: readonly CommerceNotificationV1[],
): NotificationList {
  return { schemaVersion: "underclerk.notifications.v1", notifications };
}

// Parsers of the client API types (Plan 78 step 2).
export const parseCreateCommerceCustomerV1 = wireRecordParser(
  createCommerceCustomerV1Schema,
);
export const parseEraseCommerceCustomerV1 = wireRecordParser(
  eraseCommerceCustomerV1Schema,
);
export const parseRequestCommerceCustomerSignInV1 = wireRecordParser(
  requestCommerceCustomerSignInV1Schema,
);
export const parseSaveCommerceCustomerAddressV1 = wireRecordParser(
  saveCommerceCustomerAddressV1Schema,
);
export const parseCommerceBuyerCustomerV1 = wireRecordParser(
  commerceBuyerCustomerV1Schema,
);
export const parseCommerceCustomerAccessV1 = wireRecordParser(
  commerceCustomerAccessV1Schema,
);
export const parseCommerceCustomerExportV1 = wireRecordParser(
  commerceCustomerExportV1Schema,
);
export const parseCommerceCustomerSignInChallengeV1 = wireRecordParser(
  commerceCustomerSignInChallengeV1Schema,
);
export const parseCommerceCustomerV1 = wireRecordParser(
  commerceCustomerV1Schema,
);
export const parseUpdateCommerceCustomerV1 = wireRecordParser(
  updateCommerceCustomerV1Schema,
);
export const parseVerifyCommerceCustomerSignInV1 = wireRecordParser(
  verifyCommerceCustomerSignInV1Schema,
);
export const parseCommerceNotificationsV1 = wireRecordParser(
  Type.Unsafe<readonly CommerceNotificationV1[]>(
    commerceNotificationsV1Schema,
  ),
);
