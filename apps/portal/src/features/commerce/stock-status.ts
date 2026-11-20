import type { StockStatus } from "@purin-labs/commerce-contracts";

/** One rule for a stock shortage, on the stock pages and on Home. */
export function needsReorder(row: Readonly<{ status: StockStatus }>): boolean {
  return row.status === "low" || row.status === "out";
}
