import type {
  CommerceGraphQuery,
  SystemCommerceEntityKind,
} from "@purin-labs/commerce-contracts";
import type {
  ProductSalesReport,
  CommerceAdminClient,
} from "@purin-labs/commerce-client";
import { parseCommerceGraphQuery } from "./routes";

export type MerchantProductSalesResult = Readonly<{
  kind: "product_sales";
  name: "product_sales";
  observedAt: string;
  report: ProductSalesReport;
}>;

export const PRODUCT_SALES_SOURCE_TYPES = [
  "order",
  "sellable_variant",
  "product",
] as const;

// Money and product attribution require full type reads at the restricted
// ceiling. A list, saved selector, or one-record grant cannot cover this report.
export function productSalesGrantProbe(
  typeId: SystemCommerceEntityKind,
): CommerceGraphQuery {
  const query = parseCommerceGraphQuery({
    kind: "entity_type_page",
    entityTypeId: { origin: "system", typeId },
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit: 1, cursor: null },
    traversal: { maxDepth: 0, resultLimit: 1 },
  });
  if (!query.ok) {
    throw new Error("product sales authority probe invalid");
  }
  return query.value;
}

export async function readBoundProductSales(
  input: Readonly<{
    client: CommerceAdminClient;
    organisationId: string;
    merchantId: string;
    now: string;
  }>,
): Promise<MerchantProductSalesResult> {
  const end = new Date(input.now).toISOString();
  const start = new Date(
    Date.parse(end) - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = await input.client.readProductSales(input.merchantId, {
    start,
    end,
  });
  if (!result.ok)
    throw new Error(`product sales unavailable: ${result.error.kind}`);
  if (result.value.organisationId !== input.organisationId) {
    throw new Error("product sales organisation binding mismatch");
  }
  return {
    kind: "product_sales",
    name: "product_sales",
    observedAt: end,
    report: result.value,
  };
}
