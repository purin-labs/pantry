// This built-in plugin's events (Plan 77 step 3): the kind that each of its
// commands gives in the event feed, which takes them from the plugin's
// index.ts.
import type { CommerceMutationReceiptV1 } from "@seams/commerce-client";

export const STORED_VALUE_COMMAND_EVENTS = {
  issue_gift_card: "gift_card.created",
  credit_store_credit: "store_credit.credited",
  disable_stored_value_account: "stored_value_account.disabled",
} as const satisfies Partial<
  Record<CommerceMutationReceiptV1["commandKind"], string>
>;
