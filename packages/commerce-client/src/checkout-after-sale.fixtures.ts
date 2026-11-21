import type {
  CommerceBuyerOrderV1,
  CommerceBuyerPaymentDisputeStatusV1,
} from "./index.ts";

const activePaymentDispute: CommerceBuyerPaymentDisputeStatusV1 = {
  disputeId: "dispute_fixture_active",
  amount: { amountMinor: 495, currency: "JPY" },
  state: "action_required",
  observedAt: "2026-08-30T10:00:00.000Z",
};

const terminalPaymentDispute: CommerceBuyerPaymentDisputeStatusV1 = {
  disputeId: "dispute_fixture_terminal",
  amount: { amountMinor: 495, currency: "JPY" },
  state: "won",
  resolvedAt: "2026-08-30T10:05:00.000Z",
};

// @ts-expect-error Active buyer disputes cannot expose a terminal timestamp.
const invalidActivePaymentDispute: CommerceBuyerPaymentDisputeStatusV1 = {
  disputeId: "dispute_fixture_invalid_active",
  amount: { amountMinor: 495, currency: "JPY" },
  state: "under_review",
  observedAt: "2026-08-30T10:00:00.000Z",
  resolvedAt: "2026-08-30T10:05:00.000Z",
};

// @ts-expect-error Terminal buyer disputes cannot expose an active timestamp.
const invalidTerminalPaymentDispute: CommerceBuyerPaymentDisputeStatusV1 = {
  disputeId: "dispute_fixture_invalid_terminal",
  amount: { amountMinor: 495, currency: "JPY" },
  state: "lost",
  observedAt: "2026-08-30T10:00:00.000Z",
  resolvedAt: "2026-08-30T10:05:00.000Z",
};

const protectedPaymentDispute = {
  ...terminalPaymentDispute,
  orderId: "order_fixture",
};

// @ts-expect-error Buyer disputes cannot expose protected Order identity.
const invalidProtectedPaymentDispute: CommerceBuyerPaymentDisputeStatusV1 =
  protectedPaymentDispute;

const invalidRefundedOrder: CommerceBuyerOrderV1 = {
  schemaVersion: "commerce.buyer-order.v1",
  checkoutId: "checkout_fixture",
  orderId: "order_fixture",
  paymentId: "payment_fixture",
  fulfillmentId: "fulfillment_fixture",
  placedAt: "2026-08-14T09:30:00.000Z",
  total: { amountMinor: 495, currency: "JPY" },
  paymentDisputes: [],
  fulfillment: "pickup",
  pickup: {
    locationId: "location_fixture",
    expectedBy: "2026-08-14T09:45:00.000Z",
  },
  state: "cancelled",
  cancelledAt: "2026-08-14T09:35:00.000Z",
  // @ts-expect-error Refunded buyer state requires the provider-confirmed timestamp.
  refund: { state: "refunded", amount: { amountMinor: 495, currency: "JPY" } },
};

const invalidActiveOrder: CommerceBuyerOrderV1 = {
  schemaVersion: "commerce.buyer-order.v1",
  checkoutId: "checkout_fixture",
  orderId: "order_fixture",
  paymentId: "payment_fixture",
  fulfillmentId: "fulfillment_fixture",
  placedAt: "2026-08-14T09:30:00.000Z",
  total: { amountMinor: 495, currency: "JPY" },
  paymentDisputes: [activePaymentDispute],
  fulfillment: "pickup",
  pickup: {
    locationId: "location_fixture",
    expectedBy: "2026-08-14T09:45:00.000Z",
  },
  state: "placed",
  // @ts-expect-error Active buyer orders cannot carry refund state.
  refund: { state: "pending", amount: { amountMinor: 495, currency: "JPY" } },
};

void invalidActivePaymentDispute;
void invalidTerminalPaymentDispute;
void invalidProtectedPaymentDispute;
void invalidRefundedOrder;
void invalidActiveOrder;
