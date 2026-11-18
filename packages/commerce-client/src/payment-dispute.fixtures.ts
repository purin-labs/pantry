import type { ObserveCommercePaymentDisputeV1 } from "./index.ts";

const validActionRequired: ObserveCommercePaymentDisputeV1 = {
  schemaVersion: "underclerk.observe-payment-dispute.v1",
  organisationId: "organisation_fixture",
  merchantId: "merchant_fixture",
  providerDeliveryId: "delivery_fixture",
  receivedAt: "2026-08-30T10:00:00.000Z",
  checkoutId: "checkout_fixture",
  paymentAttemptId: "payment_attempt_fixture",
  providerPaymentReference: "Pi_CASE_SENSITIVE",
  providerDisputeReference: "Dispute_CASE_SENSITIVE",
  amount: { amountMinor: 990, currency: "JPY" },
  reason: "cardholder_claim",
  evidenceReferences: ["receipt_fixture", "capture_fixture"],
  lifecycle: {
    state: "action_required",
    observedAt: "2026-08-30T10:00:00.000Z",
    responseDueAt: "2026-09-06T10:00:00.000Z",
  },
};

const validUnderReview: ObserveCommercePaymentDisputeV1 = {
  ...validActionRequired,
  lifecycle: {
    state: "under_review",
    observedAt: "2026-08-30T10:00:00.000Z",
  },
};

const validWon: ObserveCommercePaymentDisputeV1 = {
  ...validActionRequired,
  lifecycle: {
    state: "won",
    resolvedAt: "2026-08-31T10:00:00.000Z",
  },
};

const validLost: ObserveCommercePaymentDisputeV1 = {
  ...validActionRequired,
  lifecycle: {
    state: "lost",
    resolvedAt: "2026-08-31T10:00:00.000Z",
  },
};

const invalidActionRequiredLifecycle: ObserveCommercePaymentDisputeV1 = {
  ...validActionRequired,
  // @ts-expect-error Action-required lifecycle cannot carry terminal fields.
  lifecycle: {
    state: "action_required",
    observedAt: "2026-08-30T10:00:00.000Z",
    responseDueAt: "2026-09-06T10:00:00.000Z",
    resolvedAt: "2026-09-07T10:00:00.000Z",
  },
};

const invalidWonLifecycle: ObserveCommercePaymentDisputeV1 = {
  ...validWon,
  // @ts-expect-error Terminal lifecycle cannot carry observation fields.
  lifecycle: {
    state: "won",
    resolvedAt: "2026-08-31T10:00:00.000Z",
    observedAt: "2026-08-30T10:00:00.000Z",
  },
};

const invalidOrderIdentity: ObserveCommercePaymentDisputeV1 = {
  ...validActionRequired,
  // @ts-expect-error Observation commands cannot accept caller-supplied order identity.
  orderId: "order_forbidden",
};

const invalidPaymentIdentity: ObserveCommercePaymentDisputeV1 = {
  ...validActionRequired,
  // @ts-expect-error Observation commands cannot accept caller-supplied payment identity.
  paymentId: "payment_forbidden",
};

// @ts-expect-error Payment-attempt correlation is required at the observation boundary.
const invalidMissingPaymentAttempt: ObserveCommercePaymentDisputeV1 = {
  schemaVersion: "underclerk.observe-payment-dispute.v1",
  organisationId: "organisation_fixture",
  merchantId: "merchant_fixture",
  providerDeliveryId: "delivery_fixture",
  receivedAt: "2026-08-30T10:00:00.000Z",
  checkoutId: "checkout_fixture",
  providerPaymentReference: "Pi_CASE_SENSITIVE",
  providerDisputeReference: "Dispute_CASE_SENSITIVE",
  amount: { amountMinor: 990, currency: "JPY" },
  reason: "cardholder_claim",
  evidenceReferences: [],
  lifecycle: {
    state: "under_review",
    observedAt: "2026-08-30T10:00:00.000Z",
  },
};

void validActionRequired;
void validUnderReview;
void validWon;
void validLost;
void invalidActionRequiredLifecycle;
void invalidWonLifecycle;
void invalidOrderIdentity;
void invalidPaymentIdentity;
void invalidMissingPaymentAttempt;
