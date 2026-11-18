import type { CommerceEntityTypeId } from "@seams/commerce-contracts";
import type { CommerceListId } from "@seams/commerce-contracts";
import type { PublishedCommerceSelector } from "@seams/commerce-contracts";

export type CommerceReadGrantScope =
  | { kind: "entity_type"; entityTypeId: CommerceEntityTypeId }
  | { kind: "commerce_list"; listId: CommerceListId }
  | { kind: "saved_selector"; selector: PublishedCommerceSelector };
