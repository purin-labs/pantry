import { formatMoneyMinorEnglish } from "../../formatting";
import type { MenuPriceDetails } from "@seams/control-api/portal/menu-price-details";

/** Whether the change sets a deal, ends one, or changes only the price. */
export function menuPriceChangeKind(
  details: Pick<MenuPriceDetails, "before" | "after">,
): "deal" | "end_deal" | "price" {
  if (details.after.compareAtPrice !== null) return "deal";
  if (details.before.compareAtPrice !== null) return "end_deal";
  return "price";
}

export function formatMenuPrice(
  money: Readonly<{ amountMinor: number; currency: string }>,
): string {
  return formatMoneyMinorEnglish(money.amountMinor, money.currency);
}
