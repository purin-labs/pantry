import { parseProductSalesReport as parseProductSalesReportRecord } from "@purin-labs/commerce-contracts/records/api-product-sales";
import { decodeRecord } from "./entity-plane/record-decoding.ts";
export type ProductSalesWindow = Readonly<{ start: string; end: string }>;
export type ProductSalesLine = Readonly<{
  orderId: string;
  orderRevision: number;
  lineId: string;
  acceptedAt: string;
}>;
export type ProductSalesGroup = Readonly<{
  productId: string;
  currency: string;
  merchandiseMinor: number;
  lines: readonly ProductSalesLine[];
}>;
export type UnmatchedProductSalesLine = ProductSalesLine &
  Readonly<{
    reason: "source_only" | "variant_revision_unavailable";
    currency: string;
    merchandiseMinor: number;
  }>;
export type ProductSalesReport = Readonly<{
  organisationId: string;
  merchantId: string;
  merchantRevision: number;
  window: ProductSalesWindow;
}> &
  (
    | Readonly<{
        kind: "unavailable";
        reason:
          | "population_limit"
          | "acceptance_time_missing"
          | "money_basis_unreconciled"
          | "invalid_source_record";
      }>
    | Readonly<{
        kind: "reported";
        metric: "booked_merchandise_before_refunds";
        population: "accepted_non_cancelled_orders";
        groups: readonly ProductSalesGroup[];
        unmatchedLines: readonly UnmatchedProductSalesLine[];
        ordersWithAdjustments: readonly string[];
        orderCount: number;
      }>
  );

export function parseProductSalesReport(raw: unknown): ProductSalesReport {
  return decodeRecord(parseProductSalesReportRecord, raw);
}
