import { type PaymentEnvironment } from "@purin-labs/commerce-contracts";
import {
  parseCreateCommerceBuyerPaymentSessionV1 as parseCreateCommerceBuyerPaymentSessionV1Record,
  parseReconcileCommerceBuyerPaymentV1 as parseReconcileCommerceBuyerPaymentV1Record,
  parseCommerceBuyerPaymentSessionV1 as parseCommerceBuyerPaymentSessionV1Record,
  parseCommerceInPersonCollectionResultV1 as parseCommerceInPersonCollectionResultV1Record,
  parseCommercePaymentRefundResultV1 as parseCommercePaymentRefundResultV1Record,
  parseCommercePaymentSessionResultV1 as parseCommercePaymentSessionResultV1Record,
} from "@purin-labs/commerce-contracts/records/api-payment-session";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

export type CommercePaymentMoneyV1 = Readonly<{
  amountMinor: number;
  currency: string;
}>;

export type CommercePaymentPublicConfigurationV1 =
  | Readonly<{
      provider: "stripe_online";
      clientSecret: string;
      publishableKey: string;
      connectedAccountId: string;
    }>
  | Readonly<{
      provider: "gmo_pg_online";
      shopId: string;
    }>
  | Readonly<{
      provider: "square_online";
      applicationId: string;
      locationId: string;
      environment: PaymentEnvironment;
    }>;

export type CommercePaymentPublicSessionV1 =
  | Readonly<{
      kind: "embedded_public_session";
      providerSessionReference: string;
      publicConfiguration: CommercePaymentPublicConfigurationV1;
      expiresAt: string;
    }>
  | Readonly<{
      kind: "hosted_redirect";
      providerSessionReference: string;
      redirectUrl: string;
      returnUrl: string;
      expiresAt: string;
    }>;

export type CommercePaymentSessionResultV1 =
  | Readonly<{
      schemaVersion: "commerce.payment-session-result.v1";
      kind: "ready";
      paymentAttemptId: string;
      session: CommercePaymentPublicSessionV1;
    }>
  | Readonly<{
      schemaVersion: "commerce.payment-session-result.v1";
      kind: "unavailable";
      reason: string;
      retryAfter: string;
    }>;

export type CommerceInPersonCollectionSessionV1 =
  | Readonly<{
      kind: "server_terminal_checkout";
      providerCheckoutReference: string;
      deviceId: string;
      expiresAt: string;
    }>
  | Readonly<{
      kind: "gateway_terminal_checkout";
      gatewayId: string;
      deviceSourceKey: string;
      expiresAt: string;
    }>
  | Readonly<{
      kind: "client_app_handoff";
      app: "square_point_of_sale";
      clientId: string;
      locationId: string;
      amountMinor: number;
      currency: string;
      tenderTypes: ("CREDIT_CARD" | "PAYPAY")[];
      handoffReference: string;
      note: string;
      expiresAt: string;
    }>;

export type CommerceInPersonCollectionResultV1 =
  | Readonly<{
      schemaVersion: "commerce.in-person-collection-result.v1";
      kind: "ready";
      paymentAttemptId: string;
      session: CommerceInPersonCollectionSessionV1;
    }>
  | Readonly<{
      schemaVersion: "commerce.in-person-collection-result.v1";
      kind: "unavailable";
      reason: string;
      retryAfter: string;
    }>;

export type CommercePaymentClientConfirmationV1 =
  | Readonly<{ kind: "provider_ui_completed" }>
  | Readonly<{ kind: "square_source_token"; sourceToken: string }>;

export type CommercePaymentRefundResultV1 =
  | Readonly<{
      schemaVersion: "commerce.payment-refund-result.v1";
      kind: "refunded";
      providerRefundReference: string;
      money: CommercePaymentMoneyV1;
      refundedAt: string;
    }>
  | Readonly<{
      schemaVersion: "commerce.payment-refund-result.v1";
      kind: "processing";
      reconciliationIdentity: string;
      reconcileAfter: string;
    }>
  | Readonly<{
      schemaVersion: "commerce.payment-refund-result.v1";
      kind: "rejected";
      reason: string;
    }>
  | Readonly<{
      schemaVersion: "commerce.payment-refund-result.v1";
      kind: "indeterminate";
      reconciliationIdentity: string;
      reconcileAfter: string;
    }>;

export type CreateCommerceBuyerPaymentSessionV1 = Readonly<{
  schemaVersion: "commerce.create-buyer-payment-session.v1";
  idempotencyKey: string;
  checkoutRevision: number;
  quoteDigest: string;
  returnUrl: string;
}>;

export type ReconcileCommerceBuyerPaymentV1 = Readonly<{
  schemaVersion: "commerce.reconcile-buyer-payment.v1";
  idempotencyKey: string;
  checkoutRevision: number;
  quoteDigest: string;
  confirmation: CommercePaymentClientConfirmationV1;
}>;

export type CommerceBuyerPaymentSessionV1 =
  | Readonly<{
      schemaVersion: "commerce.buyer-payment-session.v1";
      state: "ready";
      checkoutId: string;
      checkoutRevision: number;
      paymentAttemptId: string;
      session: CommercePaymentPublicSessionV1;
    }>
  | Readonly<{
      schemaVersion: "commerce.buyer-payment-session.v1";
      state: "unavailable";
      checkoutId: string;
      retryAfter: string;
    }>;

export function parsePaymentSessionResultV1(
  raw: unknown,
): CommercePaymentSessionResultV1 {
  return decodeRecord(parseCommercePaymentSessionResultV1Record, raw);
}

export function parseInPersonCollectionResultV1(
  raw: unknown,
): CommerceInPersonCollectionResultV1 {
  return decodeRecord(parseCommerceInPersonCollectionResultV1Record, raw);
}

export function parsePaymentRefundResultV1(
  raw: unknown,
): CommercePaymentRefundResultV1 {
  return decodeRecord(parseCommercePaymentRefundResultV1Record, raw);
}

export function parseCreateBuyerPaymentSessionCommand(
  raw: unknown,
): CreateCommerceBuyerPaymentSessionV1 {
  return decodeRecord(parseCreateCommerceBuyerPaymentSessionV1Record, raw);
}

export function parseReconcileBuyerPaymentCommand(
  raw: unknown,
): ReconcileCommerceBuyerPaymentV1 {
  return decodeRecord(parseReconcileCommerceBuyerPaymentV1Record, raw);
}

export function parseBuyerPaymentSession(
  raw: unknown,
): CommerceBuyerPaymentSessionV1 {
  return decodeRecord(parseCommerceBuyerPaymentSessionV1Record, raw);
}
