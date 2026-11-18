import type { PantryExecutionBilling } from "../src/account-platform/execution-billing";
import type { AccountExecutionFunding } from "../src/account-platform/types";

type Prepaid = Extract<
  PantryExecutionBilling,
  { kind: "isolated_e2e_completed_turn" }
>;
declare const prepaid: Prepaid;
declare const hold: Extract<Prepaid["phase"], { kind: "held" }>["hold"];
declare const completed: Extract<
  Extract<Prepaid["phase"], { kind: "terminal_pending" }>["terminal"],
  { kind: "completed" }
>;
declare const cancelled: Extract<
  Extract<Prepaid["phase"], { kind: "terminal_pending" }>["terminal"],
  { kind: "cancelled" }
>;

// @ts-expect-error A broad spread cannot turn a prepaid execution into an unpriced execution.
export const unpricedWithFunds: PantryExecutionBilling = {
  ...prepaid,
  kind: "customer_unpriced",
  phase: { kind: "admitted" },
};

// @ts-expect-error A reserve request cannot claim an accepted hold.
export const unacceptedHold: Prepaid["phase"] = {
  kind: "reserve_pending",
  ending: { kind: "open" },
  hold,
};

// @ts-expect-error Delivery requires the parsed account acknowledgement.
export const unacknowledgedCompletion: Prepaid["phase"] = {
  kind: "delivered",
  hold,
  terminal: completed,
};

const chargedCancellationSource = {
  kind: "delivered",
  hold,
  terminal: cancelled,
  receipt: {
    kind: "charged",
    chargeId: "charge",
    amountMinor: 1,
    priceVersion: "satyr-completed-turn-test-v1",
  },
} as const;

// @ts-expect-error A cancellation cannot carry a charged acknowledgement.
export const chargedCancellation: Prepaid["phase"] = chargedCancellationSource;

// @ts-expect-error Platform funding cannot select a customer credential route.
export const mixedFunding: AccountExecutionFunding = {
  kind: "platform",
  selection: "organisation_openai_api_key",
  modelRouteDigest: "digest",
};
