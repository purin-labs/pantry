import { formatMoneyMinorEnglish } from "@purin-labs/ui/formatting";

export function formatMenuPrice(
  money: Readonly<{ amountMinor: number; currency: string }>,
): string {
  return formatMoneyMinorEnglish(money.amountMinor, money.currency);
}
