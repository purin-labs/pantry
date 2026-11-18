// The failed payments and the payments of a window (spec section 12). A decline
// expires its checkout, so a retry is a new attempt on a new checkout: these
// reads count a later attempt in the same buyer session as a retry. A session
// lasts 30 minutes, so a buyer who comes back later counts as a new buyer. A
// counter sale has no buyer session, so its attempt stands alone. The payments
// read also lists a payment that no decline came before. Both reads use an
// index, so they stay small however many payments the merchant has taken.
import {
  parseCheckoutPaymentAttempt,
  commercePickupCode,
  type CommerceFailedPaymentsV1,
  type CommerceFailedPaymentStepV1,
  type CommercePaymentsV1,
} from "@seams/commerce-client";
import { readCheckout } from "../checkout-persistence.ts";
import type { CommerceDatabase } from "../database.ts";

export type FailedPaymentsWindow = Readonly<{ start: string; end: string }>;

/** What a read lists: the declines and their retries, or every payment. */
type Scope = "failed" | "all";

/** The attempts of each state that one read looks at, the most recent first. */
const ATTEMPT_READ_LIMIT: Readonly<Record<Scope, number>> = {
  failed: 2_000,
  all: 5_000,
};
const CHAIN_LIMIT: Readonly<Record<Scope, number>> = { failed: 200, all: 500 };

type Attempt = ReturnType<typeof parseCheckoutPaymentAttempt>;
type Chain = readonly CommerceFailedPaymentStepV1[];

export function readFailedPayments(
  database: CommerceDatabase,
  merchantId: string,
  merchantRevision: number,
  window: FailedPaymentsWindow,
): CommerceFailedPaymentsV1 {
  return {
    schemaVersion: "underclerk.failed-payments.v1",
    merchantId,
    merchantRevision,
    ...readChains(database, merchantId, window, "failed"),
  };
}

export function readPayments(
  database: CommerceDatabase,
  merchantId: string,
  merchantRevision: number,
  window: FailedPaymentsWindow,
): CommercePaymentsV1 {
  return {
    schemaVersion: "underclerk.payments.v1",
    merchantId,
    merchantRevision,
    ...readChains(database, merchantId, window, "all"),
  };
}

function readChains(
  database: CommerceDatabase,
  merchantId: string,
  window: FailedPaymentsWindow,
  scope: Scope,
): Readonly<{ truncated: boolean; steps: Chain }> {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  const inWindow = (at: number): boolean => at >= start && at < end;
  const states = scope === "failed" ? ["declined"] : ["declined", "captured"];
  const readLimit = ATTEMPT_READ_LIMIT[scope];
  const lists = states.map((state) =>
    database
      .prepare(
        `SELECT payment_attempt_json AS attemptJson
         FROM checkout_payment_attempt
         WHERE merchant_id = ? AND lifecycle_state = ?
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all<Readonly<{ attemptJson: string }>>(merchantId, state, readLimit),
  );
  const chains: Chain[] = [];
  const sessions = new Set<string>();
  for (const row of lists.flat()) {
    const attempt = parseCheckoutPaymentAttempt(JSON.parse(row.attemptJson));
    if (!inWindow(attemptTime(attempt))) continue;
    const checkout = readCheckout(
      database,
      merchantId,
      attempt.binding.checkoutId,
    );
    if (checkout === undefined) continue;
    if (checkout.source.kind === "online") {
      sessions.add(checkout.source.buyerSessionDigest);
      continue;
    }
    const step = stepOf(database, merchantId, attempt, null);
    if (step !== null) chains.push([step]);
  }
  for (const session of sessions)
    for (const chain of sessionChains(database, merchantId, session, scope))
      if (inWindow(firstAt(chain))) chains.push(chain);
  chains.sort((first, second) => firstAt(second) - firstAt(first));
  const limit = CHAIN_LIMIT[scope];
  return {
    truncated:
      chains.length > limit || lists.some((list) => list.length >= readLimit),
    steps: chains.slice(0, limit).flat(),
  };
}

function firstAt(chain: Chain): number {
  const first = chain[0];
  return first === undefined ? 0 : Date.parse(first.at);
}

/**
 * Each run of a session's attempts that starts with a decline. A payment that
 * no decline came before is a run of its own when the read lists every payment.
 */
function sessionChains(
  database: CommerceDatabase,
  merchantId: string,
  session: string,
  scope: Scope,
): readonly Chain[] {
  const attempts = database
    .prepare(
      `SELECT attempt.payment_attempt_json AS attemptJson
       FROM buyer_checkout AS checkout
       JOIN checkout_payment_attempt AS attempt
         ON attempt.merchant_id = checkout.merchant_id
        AND attempt.checkout_id = checkout.checkout_id
       WHERE checkout.merchant_id = ?
         AND checkout.buyer_session_digest = ?
         AND attempt.lifecycle_state IN ('declined', 'captured')`,
    )
    .all<Readonly<{ attemptJson: string }>>(merchantId, session)
    .map((row) => parseCheckoutPaymentAttempt(JSON.parse(row.attemptJson)))
    .sort((first, second) => attemptTime(first) - attemptTime(second));
  const chains: CommerceFailedPaymentStepV1[][] = [];
  let current: CommerceFailedPaymentStepV1[] | null = null;
  for (const attempt of attempts) {
    const last: CommerceFailedPaymentStepV1 | undefined = current?.at(-1);
    const follows = last?.state === "declined" ? last.paymentAttemptId : null;
    if (
      scope === "failed" &&
      follows === null &&
      attempt.lifecycle.state !== "declined"
    ) {
      // A payment with no decline before it is not a failed payment.
      current = null;
      continue;
    }
    const step = stepOf(database, merchantId, attempt, follows);
    if (step === null) continue;
    if (follows !== null && current !== null) current.push(step);
    else {
      current = [step];
      chains.push(current);
    }
  }
  return chains;
}

/** When the provider answered; zero for an attempt with no answer yet. */
function attemptTime(attempt: Attempt): number {
  const lifecycle = attempt.lifecycle;
  switch (lifecycle.state) {
    case "declined":
      return Date.parse(lifecycle.declinedAt);
    case "captured":
      return Date.parse(lifecycle.capturedAt);
    default:
      return 0;
  }
}

function stepOf(
  database: CommerceDatabase,
  merchantId: string,
  attempt: Attempt,
  follows: string | null,
): CommerceFailedPaymentStepV1 | null {
  const checkout = readCheckout(
    database,
    merchantId,
    attempt.binding.checkoutId,
  );
  const lifecycle = attempt.lifecycle;
  if (
    checkout === undefined ||
    (lifecycle.state !== "declined" && lifecycle.state !== "captured")
  )
    return null;
  const base = {
    paymentAttemptId: attempt.paymentAttemptId,
    follows,
    channel:
      checkout.source.kind === "online"
        ? ("online" as const)
        : ("counter" as const),
    amount: {
      amountMinor: attempt.binding.amount.amountMinor,
      currency: attempt.binding.amount.currency,
    },
    lines: checkout.lifecycle.quote.lines.map((line) => ({
      title: line.title ?? null,
      quantity: line.quantity.amount,
    })),
  };
  return lifecycle.state === "declined"
    ? {
        ...base,
        at: lifecycle.declinedAt,
        state: "declined",
        reasonCode: lifecycle.reasonCode,
        orderCode: null,
      }
    : {
        ...base,
        at: lifecycle.capturedAt,
        state: "paid",
        reasonCode: null,
        orderCode:
          checkout.lifecycle.state === "accepted"
            ? commercePickupCode(checkout.lifecycle.orderId)
            : null,
      };
}
