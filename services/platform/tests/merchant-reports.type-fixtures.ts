import type { MerchantReportName } from "../src/commerce/entity-plane/merchant-reports";

// Exhaustiveness: adding a report name without a definition fails to compile.
const _coverage: Record<MerchantReportName, true> = {
  open_orders: true,
  low_stock_exposure: true,
  payment_failures: true,
  fulfillment_exceptions: true,
  product_sales: true,
};
void _coverage;
