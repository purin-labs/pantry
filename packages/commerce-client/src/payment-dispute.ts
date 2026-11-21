import type {
  Money,
  PaymentDispute,
  PaymentDisputeLifecycle,
} from "@purin-labs/commerce-contracts";
import { decodeRecord } from "./entity-plane/record-decoding.ts";
import {
  parseObserveCommercePaymentDisputeV1 as parseObserveCommercePaymentDisputeV1Record,
  parseWirePaymentDispute as parsePaymentDisputeRecord,
} from "@purin-labs/commerce-contracts/records/api-payment-dispute";

export type ObserveCommercePaymentDisputeV1 = Readonly<{
  schemaVersion: "commerce.observe-payment-dispute.v1";
  organisationId: string;
  merchantId: string;
  providerDeliveryId: string;
  receivedAt: string;
  checkoutId: string;
  paymentAttemptId: string;
  providerPaymentReference: string;
  providerDisputeReference: string;
  amount: Money;
  reason: string;
  evidenceReferences: readonly string[];
  lifecycle: PaymentDisputeLifecycle;
}>;

export function parseObservePaymentDisputeCommand(
  raw: unknown,
): ObserveCommercePaymentDisputeV1 {
  return decodeRecord(parseObserveCommercePaymentDisputeV1Record, raw);
}

export function parsePaymentDispute(raw: unknown): PaymentDispute {
  return decodeRecord(parsePaymentDisputeRecord, raw);
}
