// This built-in plugin's events (Plan 77 step 3): the kind that each of its
// commands gives in the event feed, which takes them from the plugin's
// index.ts.
import type { CommerceMutationReceiptV1 } from "@seams/commerce-client";

export const COMPANIES_COMMAND_EVENTS = {
  create_company: "company.created",
  update_company: "company.updated",
  place_draft_order_on_terms: "order.created",
  record_invoice_payment: "invoice.paid",
} as const satisfies Partial<
  Record<CommerceMutationReceiptV1["commandKind"], string>
>;
