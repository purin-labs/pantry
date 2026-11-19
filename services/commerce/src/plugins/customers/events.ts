// This built-in plugin's events (Plan 77 step 3): the kind that each of its
// commands gives in the event feed, which takes them from the plugin's
// index.ts.
import type { CommerceMutationReceiptV1 } from "@purin-labs/commerce-client";

export const CUSTOMERS_COMMAND_EVENTS = {
  create_customer: "customer.created",
  update_customer: "customer.updated",
  erase_customer: "customer.erased",
} as const satisfies Partial<
  Record<CommerceMutationReceiptV1["commandKind"], string>
>;
