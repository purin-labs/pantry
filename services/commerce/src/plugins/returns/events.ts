// This built-in plugin's events (Plan 77 step 3): the kind that each of its
// commands gives in the event feed, which takes them from the plugin's
// index.ts.
import type { CommerceMutationReceiptV1 } from "@purin-labs/commerce-client";

export const RETURNS_COMMAND_EVENTS = {
  request_return: "return.requested",
  authorize_return: "return.authorized",
  receive_return: "return.received",
  close_return: "return.closed",
  exchange_order_lines: "order.exchanged",
} as const satisfies Partial<
  Record<CommerceMutationReceiptV1["commandKind"], string>
>;
