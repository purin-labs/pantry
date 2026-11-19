import type {
  CommerceInPersonCheckoutPaymentCollectionV1,
  CommerceCounterSaleV1,
  CommerceMutationErrorV1,
  CommerceMutationResultV1,
} from "@purin-labs/commerce-client";

/** How often a new Square Terminal checkout is read while the buyer pays. */
export const TERMINAL_POLL_SECONDS = 5;

/** A Terminal checkout is new for this long, then read once a minute. */
export const TERMINAL_FAST_POLL_SECONDS = 10 * 60;

export const TERMINAL_SLOW_POLL_SECONDS = 60;

/** Terminal checkouts older than this are no longer read by the alarm. */
export const TERMINAL_POLL_WINDOW_SECONDS = 60 * 60;

export function requireSuccessfulCounterSaleMutation(
  result: CommerceMutationResultV1,
  message: string,
): void {
  if (result.outcome === "rejected")
    throw new Error(`${message}: ${result.error.code}`);
}

export function requireCounterSale(
  sale: CommerceCounterSaleV1 | undefined,
): CommerceCounterSaleV1 {
  if (sale === undefined)
    throw new Error("Counter sale disappeared during reconciliation");
  return sale;
}

export function inPersonCollectionRejection(
  error: CommerceMutationErrorV1,
): CommerceInPersonCheckoutPaymentCollectionV1 {
  return {
    schemaVersion: "underclerk.in-person-checkout-payment-collection.v1",
    outcome: "rejected",
    error,
  };
}

export function unavailableInPersonCheckoutCollection(
  started: Exclude<CommerceMutationResultV1, Readonly<{ outcome: "rejected" }>>,
  retryAfter: string,
): CommerceInPersonCheckoutPaymentCollectionV1 {
  return {
    schemaVersion: "underclerk.in-person-checkout-payment-collection.v1",
    outcome: "unavailable",
    mutationOutcome: started.outcome,
    receipt: started.receipt,
    retryAfter,
  };
}
