// Draft orders (Plan 76A step 2A). Staff build an order for a buyer, change it
// while it is open, and send an invoice link. The buyer opens the link, which
// makes a checkout at the staff prices, and pays through the normal path.
import {
  type CommerceEngineTimestamp,
} from "./commerce-resources.ts";
import {
  type CommerceMutationResultV1,
} from "./mutations.ts";
import { parseCancelCommerceDraftOrderV1 as parseCancelCommerceDraftOrderV1Record, parseCreateCommerceDraftOrderV1 as parseCreateCommerceDraftOrderV1Record, parseMarkCommerceDraftOrderPaidV1 as parseMarkCommerceDraftOrderPaidV1Record, parseSendCommerceDraftInvoiceV1 as parseSendCommerceDraftInvoiceV1Record, parseCommerceDraftInvoiceV1 as parseCommerceDraftInvoiceV1Record, parseCommerceDraftOrderV1 as parseCommerceDraftOrderV1Record, parseCommerceDraftOrderViewV1 as parseCommerceDraftOrderViewV1Record, parseUpdateCommerceDraftOrderV1 as parseUpdateCommerceDraftOrderV1Record, parseCommerceManualTenderV1 as parseCommerceManualTenderV1Record } from "@purin-labs/commerce-contracts/records/api-draft-orders";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;

export type CommerceDraftOrderLineV1 = Readonly<{
  lineId: string;
  variantId: string;
  quantity: number;
  /** A staff price for this line, with the reason staff gave. */
  priceOverride: Readonly<{ unitPrice: Money; reason: string }> | null;
}>;

export type CommerceDraftOrderLifecycleV1 =
  | Readonly<{ state: "open" }>
  | Readonly<{
      state: "invoiced";
      /** The invoice link opens only this revision of the draft. */
      invoicedRevision: number;
      expiresAt: CommerceEngineTimestamp;
    }>
  | Readonly<{ state: "cancelled"; cancelledAt: CommerceEngineTimestamp }>;

/**
 * The buyer of a draft. The stored draft names the customer record whose
 * sealed profile holds the email, and no email. A staff read adds the email
 * while the customer is not erased. A draft made before the buyer was sealed
 * keeps the email it had and names no customer.
 */
export type CommerceDraftOrderBuyerV1 = Readonly<{
  customerId: string | null;
  email: string | null;
}>;

export type CommerceDraftOrderV1 = Readonly<{
  id: string;
  revision: number;
  storefrontId: string;
  lines: readonly CommerceDraftOrderLineV1[];
  buyer: CommerceDraftOrderBuyerV1;
  note: string;
  tags: readonly string[];
  lifecycle: CommerceDraftOrderLifecycleV1;
  occurredAt: CommerceEngineTimestamp;
}>;

/**
 * Money that staff took outside a payment provider: cash at the counter, or
 * a bank transfer with the reference on the statement.
 */
export type CommerceManualTenderV1 =
  | Readonly<{ method: "cash" }>
  | Readonly<{ method: "bank_transfer"; reference: string }>;

/** A draft as staff read it: the record plus the order its invoice made. */
export type CommerceDraftOrderViewV1 = Readonly<{
  schemaVersion: "underclerk.draft-order.v1";
  draftOrder: CommerceDraftOrderV1;
  checkoutIds: readonly string[];
  completion: Readonly<{
    checkoutId: string;
    orderId: string;
    /** Present when staff marked the draft as paid. */
    manualTender?: CommerceManualTenderV1 &
      Readonly<{ recordedAt: CommerceEngineTimestamp }>;
  }> | null;
}>;

type DraftCommandBase = Readonly<{
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  draftOrderId: string;
}>;

type DraftContents = Readonly<{
  lines: readonly CommerceDraftOrderLineV1[];
  buyer: Readonly<{ email: string }>;
  note: string;
  tags: readonly string[];
}>;

export type CreateCommerceDraftOrderV1 = DraftCommandBase &
  DraftContents &
  Readonly<{
    schemaVersion: "underclerk.create-draft-order.v1";
    storefrontId: string;
  }>;

export type UpdateCommerceDraftOrderV1 = DraftCommandBase &
  DraftContents &
  Readonly<{
    schemaVersion: "underclerk.update-draft-order.v1";
    expectedDraftOrderRevision: number;
  }>;

export type SendCommerceDraftInvoiceV1 = DraftCommandBase &
  Readonly<{
    schemaVersion: "underclerk.send-draft-invoice.v1";
    expectedDraftOrderRevision: number;
    expiresAt: CommerceEngineTimestamp;
  }>;

export type CancelCommerceDraftOrderV1 = DraftCommandBase &
  Readonly<{
    schemaVersion: "underclerk.cancel-draft-order.v1";
    expectedDraftOrderRevision: number;
  }>;

/**
 * Staff took the money for a draft outside a payment provider. The draft's
 * checkout becomes an order with one captured payment of the whole total.
 */
export type MarkCommerceDraftOrderPaidV1 = DraftCommandBase &
  Readonly<{
    schemaVersion: "underclerk.mark-draft-order-paid.v1";
    expectedDraftOrderRevision: number;
    tender: CommerceManualTenderV1;
    orderId: string;
    paymentId: string;
    fulfillmentId: string;
  }>;

export type CommerceDraftOrderCommandV1 =
  | CreateCommerceDraftOrderV1
  | UpdateCommerceDraftOrderV1
  | SendCommerceDraftInvoiceV1
  | CancelCommerceDraftOrderV1;

/** The result of sending an invoice: the mutation and, once applied, the link. */
export type CommerceDraftInvoiceV1 = Readonly<{
  schemaVersion: "underclerk.draft-invoice.v1";
  mutation: CommerceMutationResultV1;
  invoice: Readonly<{ token: string; expiresAt: CommerceEngineTimestamp }> | null;
}>;

export function parseCreateDraftOrderCommand(value: unknown): CreateCommerceDraftOrderV1 {
  return decodeRecord(parseCreateCommerceDraftOrderV1Record, value);
}

export function parseUpdateDraftOrderCommand(value: unknown): UpdateCommerceDraftOrderV1 {
  return decodeRecord(parseUpdateCommerceDraftOrderV1Record, value);
}

export function parseSendDraftInvoiceCommand(value: unknown): SendCommerceDraftInvoiceV1 {
  return decodeRecord(parseSendCommerceDraftInvoiceV1Record, value);
}

export function parseCancelDraftOrderCommand(value: unknown): CancelCommerceDraftOrderV1 {
  return decodeRecord(parseCancelCommerceDraftOrderV1Record, value);
}

export function parseMarkDraftOrderPaidCommand(value: unknown): MarkCommerceDraftOrderPaidV1 {
  return decodeRecord(parseMarkCommerceDraftOrderPaidV1Record, value);
}

export function parseManualTender(
  value: unknown,
  field: string,
): CommerceManualTenderV1 {
  return decodeRecord(parseCommerceManualTenderV1Record, value);
}

export function parseDraftOrder(value: unknown): CommerceDraftOrderV1 {
  return decodeRecord(parseCommerceDraftOrderV1Record, value);
}

export function parseDraftOrderView(value: unknown): CommerceDraftOrderViewV1 {
  return decodeRecord(parseCommerceDraftOrderViewV1Record, value);
}

export function parseDraftInvoice(value: unknown): CommerceDraftInvoiceV1 {
  return decodeRecord(parseCommerceDraftInvoiceV1Record, value);
}
