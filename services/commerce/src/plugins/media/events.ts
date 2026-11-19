// This built-in plugin's events (Plan 77 step 3): the kind that each of its
// commands gives in the event feed, which takes them from the plugin's
// index.ts.
import type { CommerceMutationReceiptV1 } from "@purin-labs/commerce-client";

export const MEDIA_COMMAND_EVENTS = {
  create_media: "media.created",
  update_media: "media.updated",
  delete_media: "media.deleted",
  set_product_media: "product.media_updated",
} as const satisfies Partial<
  Record<CommerceMutationReceiptV1["commandKind"], string>
>;
