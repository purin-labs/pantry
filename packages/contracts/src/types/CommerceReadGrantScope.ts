import type { CommerceEntityTypeId } from "@purin-labs/commerce-contracts";
import type { CommerceListId } from "@purin-labs/commerce-contracts";
import type { PublishedCommerceSelector } from "@purin-labs/commerce-contracts";

export type CommerceReadGrantScope =
  | { kind: "entity_type"; entityTypeId: CommerceEntityTypeId }
  | { kind: "commerce_list"; listId: CommerceListId }
  | { kind: "saved_selector"; selector: PublishedCommerceSelector };
