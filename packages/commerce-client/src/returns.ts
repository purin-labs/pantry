// Returns (Plan 76A step 2C). A buyer or staff request a return of fulfilled
// order lines; staff authorize or reject each line, receive the items with a
// disposition for each line, and close the return with the refund they made.
import type { CommerceEngineTimestamp } from "./commerce-resources.ts";
import { parseAuthorizeCommerceReturnV1 as parseAuthorizeCommerceReturnV1Record, parseCloseCommerceReturnV1 as parseCloseCommerceReturnV1Record, parseReceiveCommerceReturnV1 as parseReceiveCommerceReturnV1Record, parseRequestCommerceBuyerReturnV1 as parseRequestCommerceBuyerReturnV1Record, parseRequestCommerceReturnV1 as parseRequestCommerceReturnV1Record, parseCommerceReturnV1 as parseCommerceReturnV1Record, parseCommerceReturnsV1 as parseCommerceReturnsV1Record } from "@purin-labs/commerce-contracts/records/api-returns";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

export const RETURN_DISPOSITIONS = [
  "restock",
  "quarantine",
  "damage",
  "waste",
  "lost",
] as const;
export type CommerceReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

export type CommerceReturnLineV1 = Readonly<{
  orderLineId: string;
  quantity: number;
  reason: string;
  decision: "pending" | "authorized" | "rejected";
  disposition: CommerceReturnDisposition | null;
}>;

export type CommerceReturnLifecycleV1 =
  | Readonly<{ state: "requested"; requestedAt: CommerceEngineTimestamp }>
  | Readonly<{ state: "authorized"; authorizedAt: CommerceEngineTimestamp }>
  | Readonly<{ state: "rejected"; rejectedAt: CommerceEngineTimestamp }>
  | Readonly<{
      state: "received";
      receivedAt: CommerceEngineTimestamp;
      locationId: string;
    }>
  | Readonly<{
      state: "closed";
      closedAt: CommerceEngineTimestamp;
      refundAttemptId: string | null;
      /** The exchange that settled the return instead of a refund. */
      exchangeId?: string;
    }>;

export type CommerceReturnV1 = Readonly<{
  id: string;
  revision: number;
  orderId: string;
  requestedBy: "buyer" | "staff";
  lines: readonly CommerceReturnLineV1[];
  lifecycle: CommerceReturnLifecycleV1;
  occurredAt: CommerceEngineTimestamp;
}>;

type ReturnCommandBase = Readonly<{
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  returnId: string;
}>;

export type CommerceReturnRequestLineV1 = Readonly<{
  orderLineId: string;
  quantity: number;
  reason: string;
}>;

export type RequestCommerceReturnV1 = ReturnCommandBase &
  Readonly<{
    schemaVersion: "commerce.request-return.v1";
    orderId: string;
    lines: readonly CommerceReturnRequestLineV1[];
  }>;

export type AuthorizeCommerceReturnV1 = ReturnCommandBase &
  Readonly<{
    schemaVersion: "commerce.authorize-return.v1";
    expectedReturnRevision: number;
    decisions: readonly Readonly<{
      orderLineId: string;
      decision: "authorized" | "rejected";
    }>[];
  }>;

export type ReceiveCommerceReturnV1 = ReturnCommandBase &
  Readonly<{
    schemaVersion: "commerce.receive-return.v1";
    expectedReturnRevision: number;
    /** Restocked items go back to stock at this location. */
    locationId: string;
    dispositions: readonly Readonly<{
      orderLineId: string;
      disposition: CommerceReturnDisposition;
    }>[];
  }>;

export type CloseCommerceReturnV1 = ReturnCommandBase &
  Readonly<{
    schemaVersion: "commerce.close-return.v1";
    expectedReturnRevision: number;
    /** The succeeded refund for this return, or null when none was made. */
    refundAttemptId: string | null;
  }>;

export type CommerceReturnCommandV1 =
  | RequestCommerceReturnV1
  | AuthorizeCommerceReturnV1
  | ReceiveCommerceReturnV1
  | CloseCommerceReturnV1;

/** The buyer's request, sent with an order recovery token. */
export type RequestCommerceBuyerReturnV1 = Readonly<{
  schemaVersion: "commerce.request-buyer-return.v1";
  idempotencyKey: string;
  lines: readonly CommerceReturnRequestLineV1[];
}>;

export function parseRequestReturnCommand(value: unknown): RequestCommerceReturnV1 {
  return decodeRecord(parseRequestCommerceReturnV1Record, value);
}

export function parseRequestBuyerReturnCommand(value: unknown): RequestCommerceBuyerReturnV1 {
  return decodeRecord(parseRequestCommerceBuyerReturnV1Record, value);
}

export function parseAuthorizeReturnCommand(value: unknown): AuthorizeCommerceReturnV1 {
  return decodeRecord(parseAuthorizeCommerceReturnV1Record, value);
}

export function parseReceiveReturnCommand(value: unknown): ReceiveCommerceReturnV1 {
  return decodeRecord(parseReceiveCommerceReturnV1Record, value);
}

export function parseCloseReturnCommand(value: unknown): CloseCommerceReturnV1 {
  return decodeRecord(parseCloseCommerceReturnV1Record, value);
}

export function parseReturn(value: unknown): CommerceReturnV1 {
  return decodeRecord(parseCommerceReturnV1Record, value);
}

export function parseReturns(value: unknown): readonly CommerceReturnV1[] {
  return decodeRecord(parseCommerceReturnsV1Record, value);
}
