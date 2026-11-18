// This built-in plugin's events (Plan 77 step 3): the kind that each of its
// commands gives in the event feed, which takes them from the plugin's
// index.ts.
import type { CommerceMutationReceiptV1 } from "@seams/commerce-client";

export const DISCOUNTS_COMMAND_EVENTS = {
  create_discount: "discount.created",
  deactivate_discount: "discount.updated",
} as const satisfies Partial<
  Record<CommerceMutationReceiptV1["commandKind"], string>
>;
