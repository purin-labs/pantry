// This built-in plugin's events (Plan 77 step 3): the kind that each of its
// commands gives in the event feed, which takes them from the plugin's
// index.ts.
import type { CommerceMutationReceiptV1 } from "@seams/commerce-client";

export const MARKETS_COMMAND_EVENTS = {
  create_market: "market.created",
  update_market: "market.updated",
} as const satisfies Partial<
  Record<CommerceMutationReceiptV1["commandKind"], string>
>;
