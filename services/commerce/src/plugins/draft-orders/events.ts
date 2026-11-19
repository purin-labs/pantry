// This built-in plugin's events (Plan 77 step 3): the kind that each of its
// commands gives in the event feed, which takes them from the plugin's
// index.ts.
import type { CommerceMutationReceiptV1 } from "@purin-labs/commerce-client";

export const DRAFT_ORDERS_COMMAND_EVENTS = {
  create_draft_order: "draft_order.created",
  update_draft_order: "draft_order.updated",
  send_draft_invoice: "draft_order.invoiced",
  cancel_draft_order: "draft_order.cancelled",
  mark_draft_order_paid: "order.created",
} as const satisfies Partial<
  Record<CommerceMutationReceiptV1["commandKind"], string>
>;
