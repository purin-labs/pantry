// The `machine.guard` hook of merchant plugins (Plan 77 step 4). After a state
// machine allows a move that staff asked for, the merchant's guard functions
// read the move and its record and return `{ refusals: [{ message }] }`; a
// refusal refuses the command with `transition_refused`. Guards run on staff
// commands in a request (order cancellation and refund, return decisions): a
// provider's report or an alarm states a fact that a plugin cannot refuse. The runs are counted at once, and a failure is kept for its
// report, as at checkout.
import type {
  CommerceFulfillmentV1,
  CommerceMutationErrorV1,
  CommerceOrderV1,
} from "@purin-labs/commerce-client";

import type { CommerceDatabase } from "../database.ts";
import { runHook } from "./checkout-hooks.ts";
import { functionScope } from "./function-runtime.ts";
import { recordFunctionRuns, refusalMessages } from "./merchant-plugins.ts";

/** What a guard reads of the record that moves. */
export type GuardSubject = Readonly<{ kind: string; id: string }> &
  Readonly<Record<string, unknown>>;

export type GuardedMove = Readonly<{
  machine: string;
  event: string;
  from: string;
  to: string;
  subject: GuardSubject;
  /** The command's time, the functions' clock. */
  at: string;
  /** Tells apart two commands on one record. */
  attempt: string;
}>;

/** The refusal of the first guard that refuses the move, or undefined. */
export function guardMove(
  database: CommerceDatabase,
  merchantId: string,
  move: GuardedMove,
): CommerceMutationErrorV1 | undefined {
  // Only a request prepares function VMs; an alarm's replay is not a
  // request that a plugin can refuse.
  if (functionScope.getStore() === undefined) return undefined;
  const { subject, at, attempt, ...transition } = move;
  const result = runHook(
    database,
    merchantId,
    "machine.guard",
    { move: { ...transition, at }, subject },
    at,
    refusalMessages,
  );
  if (result.kind === "refused")
    return {
      code: "transition_refused",
      pluginId: "pluginId" in result.error ? result.error.pluginId : "",
      machine: move.machine,
      event: move.event,
      message:
        "message" in result.error
          ? result.error.message
          : "This change cannot be checked now. Try again later.",
    };
  recordFunctionRuns(
    database,
    merchantId,
    { id: subject.id, attempt },
    result.runs,
    result.failures,
    at,
  );
  for (const { pluginId, output } of result.outputs) {
    const message = output[0];
    if (message !== undefined)
      return {
        code: "transition_refused",
        pluginId,
        machine: move.machine,
        event: move.event,
        message,
      };
  }
  return undefined;
}

/** An order as a guard reads it: its lines, total and fulfillment. */
export function orderSubject(
  order: CommerceOrderV1,
  fulfillment: CommerceFulfillmentV1 | undefined,
  variants: readonly Readonly<{ id: string; productId: string }>[],
): GuardSubject {
  return {
    kind: "order",
    id: order.id,
    placedAt: order.occurredAt,
    currency: order.totals.total.currency,
    totalMinor: order.totals.total.amountMinor,
    lines: order.lineItems.map((line) => {
      const variantId =
        line.source.kind === "catalog" ? line.source.variantId : null;
      return {
        orderLineId: line.id,
        variantId,
        productId:
          variants.find((variant) => variant.id === variantId)?.productId ??
          null,
        title: line.title,
        quantity: line.quantity.amount,
        lineTotalMinor: line.lineTotal.amountMinor,
      };
    }),
    fulfillment:
      fulfillment === undefined
        ? null
        : {
            kind: fulfillment.kind,
            state: fulfillment.lifecycle.state,
            expectedBy: fulfillment.expectedBy,
          },
  };
}
