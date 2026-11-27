// Customer accounts (Plan 76A step 3). A customer record holds a buyer's
// contact, addresses and consent, encrypted with a key for each customer.
// Buyers sign in with a one-time email code; staff can read, change, export
// and erase a customer. An erased customer has no personal fields.
import type { CommerceEngineTimestamp } from "./commerce-resources.ts";
import {
  requireString,
} from "./wire-readers.ts";
import { parseCreateCommerceCustomerV1 as parseCreateCommerceCustomerV1Record, parseEraseCommerceCustomerV1 as parseEraseCommerceCustomerV1Record, parseRequestCommerceCustomerSignInV1 as parseRequestCommerceCustomerSignInV1Record, parseSaveCommerceCustomerAddressV1 as parseSaveCommerceCustomerAddressV1Record, parseCommerceBuyerCustomerV1 as parseCommerceBuyerCustomerV1Record, parseCommerceCustomerAccessV1 as parseCommerceCustomerAccessV1Record, parseCommerceCustomerExportV1 as parseCommerceCustomerExportV1Record, parseCommerceCustomerSignInChallengeV1 as parseCommerceCustomerSignInChallengeV1Record, parseCommerceCustomerV1 as parseCommerceCustomerV1Record, parseUpdateCommerceCustomerV1 as parseUpdateCommerceCustomerV1Record, parseVerifyCommerceCustomerSignInV1 as parseVerifyCommerceCustomerSignInV1Record, parseCommerceNotificationsV1 as parseCommerceNotificationsV1Record } from "@purin-labs/commerce-contracts/records/api-customers";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;

const MARKETING_CONSENT_STATES = [
  "not_subscribed",
  "subscribed",
  "unsubscribed",
] as const;
export type CommerceMarketingConsentState =
  (typeof MARKETING_CONSENT_STATES)[number];

export type CommerceMarketingConsentV1 = Readonly<{
  state: CommerceMarketingConsentState;
  updatedAt: CommerceEngineTimestamp | null;
  source: "buyer" | "staff" | null;
}>;

export type CommerceCustomerAddressInputV1 = Readonly<{
  recipient: string;
  line1: string;
  line2: string | null;
  locality: string;
  region: string | null;
  postalCode: string;
  countryCode: string;
}>;

export type CommerceCustomerAddressV1 = CommerceCustomerAddressInputV1 &
  Readonly<{ addressId: string }>;

export type CommerceCustomerV1 = Readonly<{
  id: string;
  revision: number;
  state: "active" | "erased";
  /** `enabled` once the buyer has signed in. */
  account: "none" | "enabled";
  email: string | null;
  name: string | null;
  phone: string | null;
  note: string | null;
  addresses: readonly CommerceCustomerAddressV1[];
  tags: readonly string[];
  marketing: Readonly<{
    email: CommerceMarketingConsentV1;
    sms: CommerceMarketingConsentV1;
  }>;
  orderIds: readonly string[];
  createdAt: CommerceEngineTimestamp;
  occurredAt: CommerceEngineTimestamp;
}>;

type CustomerCommandBase = Readonly<{
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  customerId: string;
}>;

export type CreateCommerceCustomerV1 = CustomerCommandBase &
  Readonly<{
    schemaVersion: "commerce.create-customer.v1";
    email: string;
    name: string | null;
    phone: string | null;
    note: string | null;
    tags: readonly string[];
  }>;

export type UpdateCommerceCustomerV1 = CustomerCommandBase &
  Readonly<{
    schemaVersion: "commerce.update-customer.v1";
    expectedRevision: number;
    /** Only the named fields change. */
    changes: Readonly<{
      name?: string | null;
      phone?: string | null;
      note?: string | null;
      tags?: readonly string[];
      marketing?: Readonly<{
        email?: CommerceMarketingConsentState;
        sms?: CommerceMarketingConsentState;
      }>;
    }>;
  }>;

export type EraseCommerceCustomerV1 = CustomerCommandBase &
  Readonly<{
    schemaVersion: "commerce.erase-customer.v1";
    expectedRevision: number;
    reason: string;
  }>;

export type CommerceCustomerCommandV1 =
  | CreateCommerceCustomerV1
  | UpdateCommerceCustomerV1
  | EraseCommerceCustomerV1;

/** Everything the merchant holds about one customer. */
export type CommerceCustomerExportV1 = Readonly<{
  schemaVersion: "commerce.customer-export.v1";
  customer: CommerceCustomerV1;
  exportedAt: CommerceEngineTimestamp;
}>;

export type RequestCommerceCustomerSignInV1 = Readonly<{
  schemaVersion: "commerce.request-customer-sign-in.v1";
  email: string;
}>;

export type CommerceCustomerSignInChallengeV1 = Readonly<{
  schemaVersion: "commerce.customer-sign-in-challenge.v1";
  challengeId: string;
  expiresAt: CommerceEngineTimestamp;
}>;

export type VerifyCommerceCustomerSignInV1 = Readonly<{
  schemaVersion: "commerce.verify-customer-sign-in.v1";
  code: string;
}>;

/** A signed-in buyer's token; a buyer session is made from it. */
export type CommerceCustomerAccessV1 = Readonly<{
  schemaVersion: "commerce.customer-access.v1";
  customerAccessToken: string;
  expiresAt: CommerceEngineTimestamp;
}>;

export type SaveCommerceCustomerAddressV1 = Readonly<{
  schemaVersion: "commerce.save-customer-address.v1";
  address: CommerceCustomerAddressInputV1;
}>;

/** What a signed-in buyer sees of their own account. */
export type CommerceBuyerCustomerV1 = Readonly<{
  schemaVersion: "commerce.buyer-customer.v1";
  email: string;
  name: string | null;
  addresses: readonly CommerceCustomerAddressV1[];
  orders: readonly Readonly<{
    orderId: string;
    placedAt: CommerceEngineTimestamp;
    total: Money;
    state: string;
  }>[];
}>;

export type CommerceNotificationV1 = Readonly<{
  notificationId: string;
  kind:
    | "order_confirmation"
    | "ready_for_pickup"
    | "sign_in_code"
    | "order_shipped"
    | "refund_issued";
  orderId: string | null;
  customerId: string | null;
  status: "pending" | "sent" | "failed" | "dropped";
  attempts: number;
  providerMessageId: string | null;
  createdAt: CommerceEngineTimestamp;
  sentAt: CommerceEngineTimestamp | null;
}>;

export function normalizeCustomerEmail(value: unknown, field: string): string {
  const email = requireString(value, field).trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error(`${field} must be an email address`);
  return email;
}

export function parseCreateCustomerCommand(value: unknown): CreateCommerceCustomerV1 {
  return decodeRecord(parseCreateCommerceCustomerV1Record, value);
}

export function parseUpdateCustomerCommand(value: unknown): UpdateCommerceCustomerV1 {
  return decodeRecord(parseUpdateCommerceCustomerV1Record, value);
}

export function parseEraseCustomerCommand(value: unknown): EraseCommerceCustomerV1 {
  return decodeRecord(parseEraseCommerceCustomerV1Record, value);
}

export function parseRequestCustomerSignInCommand(value: unknown): RequestCommerceCustomerSignInV1 {
  return decodeRecord(parseRequestCommerceCustomerSignInV1Record, value);
}

export function parseVerifyCustomerSignInCommand(value: unknown): VerifyCommerceCustomerSignInV1 {
  return decodeRecord(parseVerifyCommerceCustomerSignInV1Record, value);
}

export function parseSaveCustomerAddressCommand(value: unknown): SaveCommerceCustomerAddressV1 {
  return decodeRecord(parseSaveCommerceCustomerAddressV1Record, value);
}

export function parseCustomer(value: unknown): CommerceCustomerV1 {
  return decodeRecord(parseCommerceCustomerV1Record, value);
}

export function parseCustomerExport(value: unknown): CommerceCustomerExportV1 {
  return decodeRecord(parseCommerceCustomerExportV1Record, value);
}

export function parseCustomerSignInChallenge(value: unknown): CommerceCustomerSignInChallengeV1 {
  return decodeRecord(parseCommerceCustomerSignInChallengeV1Record, value);
}

export function parseCustomerAccess(value: unknown): CommerceCustomerAccessV1 {
  return decodeRecord(parseCommerceCustomerAccessV1Record, value);
}

export function parseBuyerCustomer(value: unknown): CommerceBuyerCustomerV1 {
  return decodeRecord(parseCommerceBuyerCustomerV1Record, value);
}

export function parseNotifications(
  value: unknown,
): readonly CommerceNotificationV1[] {
  return decodeRecord(parseCommerceNotificationsV1Record, value);
}
