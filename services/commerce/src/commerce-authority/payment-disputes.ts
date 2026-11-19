import {
  parsePaymentDispute,
  type CommerceResourcesV1,
  type CommerceMutationErrorV1,
  type ObserveCommercePaymentDisputeV1,
  type CommerceOrderV1,
  type CommercePaymentV1,
  orderOriginCheckoutId,
} from "@purin-labs/commerce-client";
import {
  commerceTransition,
  type CommerceMachineEvent,
  type PaymentDispute,
} from "@purin-labs/commerce-contracts";
import type { CommerceDatabase } from "../database.ts";
import { sha256 } from "./ledger.ts";
import { validatePaymentDisputeLifecycleAdvance } from "../payments/payment-records.ts";
import {
  readCheckout,
  readCheckoutPaymentAttempt,
} from "../checkout-persistence.ts";
import { amountDue, sameMoney } from "./checkout-shared.ts";
import { storedValuePaymentId } from "../plugins/stored-value/index.ts";
import { listOrderChanges, readPaymentChange } from "./order-changes.ts";
import { assertNever, errorMessage } from "@purin-labs/std";

type PaymentDisputeCorrelation = Readonly<{
  order: CommerceOrderV1;
  payment: CommercePaymentV1;
}>;

type PaymentDisputeCorrelationResult =
  | Readonly<{ kind: "resolved"; value: PaymentDisputeCorrelation }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

type PaymentDisputeBuildResult =
  | Readonly<{ kind: "resolved"; value: PaymentDispute }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function resolvePaymentDisputeCorrelation(
  database: CommerceDatabase,
  command: ObserveCommercePaymentDisputeV1,
  resources: CommerceResourcesV1,
): PaymentDisputeCorrelationResult {
  const checkout = readCheckout(
    database,
    command.merchantId,
    command.checkoutId,
  );
  if (checkout?.lifecycle.state !== "accepted") {
    return rejectedPaymentDisputeCorrelation("checkoutId");
  }
  const paymentAttempt = readCheckoutPaymentAttempt(
    database,
    command.merchantId,
    command.paymentAttemptId,
  );
  if (
    paymentAttempt === undefined ||
    command.paymentAttemptId !== checkout.lifecycle.paymentAttemptId ||
    paymentAttempt.binding.checkoutId !== command.checkoutId ||
    paymentAttempt.binding.checkoutRevision !==
      checkout.lifecycle.quote.checkoutRevision ||
    paymentAttempt.binding.quoteDigest !==
      checkout.lifecycle.quote.quoteDigest ||
    paymentAttempt.lifecycle.state !== "captured" ||
    paymentAttempt.lifecycle.providerPaymentReference !==
      command.providerPaymentReference
  ) {
    return rejectedPaymentDisputeCorrelation("paymentAttemptId");
  }
  const order = findOrder(resources.orders, checkout.lifecycle.orderId);
  // A card-present sale can be disputed too, so correlation resolves the
  // Checkout from whichever channel placed the Order.
  if (
    order === undefined ||
    orderOriginCheckoutId(order.origin) !== command.checkoutId
  ) {
    return rejectedPaymentDisputeCorrelation("checkoutId");
  }
  // Gift cards and store credit that paid part of the order are payments
  // of their own, and so are later payments: a balance checkout's card or a
  // manual payment, each with its order change. The checkout's card payment
  // is the one other payment.
  const storedValuePayments = new Set(
    (checkout.lifecycle.quote.storedValue?.tenders ?? []).map((tender) =>
      storedValuePaymentId(order.id, tender.accountId),
    ),
  );
  const payment = findOnlyPaymentForOrder(
    resources.payments.filter(
      (item) =>
        !storedValuePayments.has(item.id) &&
        readPaymentChange(database, command.merchantId, item.id) === undefined,
    ),
    order.id,
  );
  if (payment === undefined)
    return rejectedPaymentDisputeCorrelation("providerPaymentReference");
  const dispute = commerceTransition(
    "payment",
    payment.lifecycle,
    "record_dispute",
  );
  if (!dispute.allowed) return { kind: "rejected", error: dispute.refusal };
  if (
    !sameMoney(paymentAttempt.binding.amount, payment.amount) ||
    !sameMoney(amountDue(checkout.lifecycle.quote), payment.amount) ||
    // An edit or an exchange changes the order's total after its checkout.
    (listOrderChanges(database, command.merchantId, order.id).length === 0 &&
      !sameMoney(order.totals.total, checkout.lifecycle.quote.totals.total))
  ) {
    return rejectedPaymentDisputeCorrelation("providerPaymentReference");
  }
  if (
    command.amount.currency !== payment.amount.currency ||
    command.amount.amountMinor > payment.amount.amountMinor
  ) {
    return rejectedPaymentDisputeCorrelation("amount");
  }
  return { kind: "resolved", value: { order, payment } };
}

function rejectedPaymentDisputeCorrelation(
  field: string,
): PaymentDisputeCorrelationResult {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}

function findOrder(
  orders: readonly CommerceOrderV1[],
  orderId: string,
): CommerceOrderV1 | undefined {
  for (const order of orders) {
    if (order.id === orderId) return order;
  }
  return undefined;
}

function findOnlyPaymentForOrder(
  payments: readonly CommercePaymentV1[],
  orderId: string,
): CommercePaymentV1 | undefined {
  let found: CommercePaymentV1 | undefined;
  for (const payment of payments) {
    if (payment.orderId !== orderId) continue;
    if (found !== undefined) return undefined;
    found = payment;
  }
  return found;
}

export function buildObservedPaymentDispute(
  command: ObserveCommercePaymentDisputeV1,
  correlation: PaymentDisputeCorrelation,
  existing: PaymentDispute | undefined,
): PaymentDisputeBuildResult {
  const disputeId = `dispute_${sha256(
    `${command.merchantId}:${command.providerDisputeReference}`,
  )}`;
  if (
    existing !== undefined &&
    !paymentDisputeIdentityMatches(existing, disputeId, correlation, command)
  ) {
    return rejectedPaymentDisputeBuild("providerDisputeReference");
  }
  if (existing !== undefined) {
    const report = commerceTransition(
      "payment_dispute",
      existing.lifecycle,
      disputeEvent(command.lifecycle.state),
    );
    if (!report.allowed) return { kind: "rejected", error: report.refusal };
    const lifecycleValidation = validatePaymentDisputeLifecycleAdvance(
      existing.lifecycle,
      command.lifecycle,
    );
    switch (lifecycleValidation.kind) {
      case "accepted":
        break;
      case "terminal":
      case "timestamp_not_forward":
        return rejectedPaymentDisputeBuild("lifecycle");
      default:
        return assertNever(
          lifecycleValidation,
          "Unexpected commerce authority request",
        );
    }
  }
  const revision = existing === undefined ? 1 : existing.revision + 1;
  if (!Number.isSafeInteger(revision))
    return rejectedPaymentDisputeBuild("revision");
  try {
    return {
      kind: "resolved",
      value: parsePaymentDispute({
        disputeId,
        orderId: correlation.order.id,
        paymentId: correlation.payment.id,
        revision,
        providerDisputeReference: command.providerDisputeReference,
        amount: command.amount,
        reason: command.reason,
        evidenceReferences: command.evidenceReferences,
        lifecycle: command.lifecycle,
      }),
    };
  } catch (error) {
    return rejectedPaymentDisputeBuild(errorMessage(error));
  }
}

/** The dispute machine's event for the state that the provider reports. */
function disputeEvent(
  state: PaymentDispute["lifecycle"]["state"],
): CommerceMachineEvent<"payment_dispute"> {
  switch (state) {
    case "action_required":
      return "report_action_required";
    case "under_review":
      return "report_under_review";
    case "won":
      return "win";
    case "lost":
      return "lose";
  }
}

function rejectedPaymentDisputeBuild(field: string): PaymentDisputeBuildResult {
  return { kind: "rejected", error: { code: "invalid_command", field } };
}

function paymentDisputeIdentityMatches(
  existing: PaymentDispute,
  disputeId: string,
  correlation: PaymentDisputeCorrelation,
  command: ObserveCommercePaymentDisputeV1,
): boolean {
  return (
    existing.disputeId === disputeId &&
    existing.orderId === correlation.order.id &&
    existing.paymentId === correlation.payment.id &&
    existing.providerDisputeReference === command.providerDisputeReference &&
    existing.amount.amountMinor === command.amount.amountMinor &&
    existing.amount.currency === command.amount.currency &&
    existing.reason === command.reason &&
    sameStringSequence(existing.evidenceReferences, command.evidenceReferences)
  );
}

function sameStringSequence(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
