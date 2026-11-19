import type { CommerceInventoryItemV1 } from "@purin-labs/commerce-client";

export function inventoryItemWithId(
  id: string,
  item: CommerceInventoryItemV1,
): boolean {
  return item.id === id;
}
