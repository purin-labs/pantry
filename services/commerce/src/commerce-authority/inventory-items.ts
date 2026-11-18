import type { CommerceInventoryItemV1 } from "@seams/commerce-client";

export function inventoryItemWithId(
  id: string,
  item: CommerceInventoryItemV1,
): boolean {
  return item.id === id;
}
