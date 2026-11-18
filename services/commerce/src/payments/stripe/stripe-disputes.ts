// Stripe's dispute notifications for the payments that Commerce runs (Plan
// 76 phase 3). The Worker uses the event to find the merchant; the merchant's
// object parses the same event again and records the dispute against the
// payment attempt whose PaymentIntent it names.
import { isRecord } from "@seams/std";
import type { PaymentDisputeLifecycle } from "@seams/commerce-contracts";

export type StripeDisputeObservation = Readonly<{
  eventId: string;
  accountId: string;
  providerDisputeReference: string;
  providerPaymentReference: string;
  amount: Readonly<{ amountMinor: number; currency: string }>;
  reason: string;
  lifecycle: PaymentDisputeLifecycle;
}>;

type DisputeEventType =
  "charge.dispute.created" | "charge.dispute.updated" | "charge.dispute.closed";

type DisputeStatus =
  | "warning_needs_response"
  | "warning_under_review"
  | "warning_closed"
  | "needs_response"
  | "under_review"
  | "won"
  | "lost";

export function isStripeDisputeEventType(
  raw: unknown,
): raw is DisputeEventType {
  return (
    raw === "charge.dispute.created" ||
    raw === "charge.dispute.updated" ||
    raw === "charge.dispute.closed"
  );
}

/** The dispute of a Connect event, or undefined when the event is not one. */
export function parseStripeDisputeEvent(
  event: unknown,
): StripeDisputeObservation | undefined {
  if (
    !isRecord(event) ||
    event.object !== "event" ||
    !isStripeDisputeEventType(event.type) ||
    !isRecord(event.data) ||
    !isRecord(event.data.object) ||
    event.data.object.object !== "dispute"
  )
    return undefined;
  const eventId = providerReference(event.id);
  const accountId = providerReference(event.account);
  const observedAt = unixTimestamp(event.created);
  const dispute = event.data.object;
  const providerDisputeReference = providerReference(dispute.id);
  const providerPaymentReference = providerReference(dispute.payment_intent);
  const currency = disputeCurrency(dispute.currency);
  const reason = normalizedText(dispute.reason);
  const amount = dispute.amount;
  const status = dispute.status;
  if (
    eventId === null ||
    accountId === null ||
    !accountId.startsWith("acct_") ||
    observedAt === null ||
    providerDisputeReference === null ||
    providerPaymentReference === null ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    currency === null ||
    reason === null ||
    !isDisputeStatus(status) ||
    (event.type === "charge.dispute.closed") !== isClosed(status)
  )
    return undefined;
  const lifecycle = disputeLifecycle(
    status,
    dispute.evidence_details,
    observedAt,
  );
  return lifecycle === undefined
    ? undefined
    : {
        eventId,
        accountId,
        providerDisputeReference,
        providerPaymentReference,
        amount: { amountMinor: amount, currency },
        reason,
        lifecycle,
      };
}

function disputeLifecycle(
  status: DisputeStatus,
  evidenceDetails: unknown,
  observedAt: string,
): PaymentDisputeLifecycle | undefined {
  switch (status) {
    case "warning_needs_response":
    case "needs_response": {
      const responseDueAt = isRecord(evidenceDetails)
        ? unixTimestamp(evidenceDetails.due_by)
        : null;
      return responseDueAt === null ||
        Date.parse(responseDueAt) <= Date.parse(observedAt)
        ? undefined
        : { state: "action_required", observedAt, responseDueAt };
    }
    case "warning_under_review":
    case "under_review":
      return { state: "under_review", observedAt };
    case "warning_closed":
    case "won":
      return { state: "won", resolvedAt: observedAt };
    case "lost":
      return { state: "lost", resolvedAt: observedAt };
  }
}

function isDisputeStatus(raw: unknown): raw is DisputeStatus {
  return (
    raw === "warning_needs_response" ||
    raw === "warning_under_review" ||
    raw === "warning_closed" ||
    raw === "needs_response" ||
    raw === "under_review" ||
    raw === "won" ||
    raw === "lost"
  );
}

function isClosed(status: DisputeStatus): boolean {
  return status === "warning_closed" || status === "won" || status === "lost";
}

function providerReference(raw: unknown): string | null {
  return typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= 255 &&
    raw === raw.trim()
    ? raw
    : null;
}

function disputeCurrency(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const currency = raw.toUpperCase();
  return /^[A-Z]{3}$/u.test(currency) ? currency : null;
}

function normalizedText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.normalize("NFKC").trim();
  return text.length > 0 && text.length <= 512 ? text : null;
}

function unixTimestamp(raw: unknown): string | null {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0)
    return null;
  const date = new Date(raw * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
