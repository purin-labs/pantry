// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiProductSales from "@seams/commerce-contracts/records/api-product-sales";
import type {
  ProductSalesLine,
  ProductSalesGroup,
  ProductSalesWindow,
  UnmatchedProductSalesLine,
  ProductSalesReport,
} from "./product-sales.ts";
export type ProductSalesLineParity = Assert<
  Equal<ProductSalesLine, apiProductSales.ProductSalesLine>
>;
export type ProductSalesGroupParity = Assert<
  Equal<ProductSalesGroup, apiProductSales.ProductSalesGroup>
>;
export type ProductSalesWindowParity = Assert<
  Equal<ProductSalesWindow, apiProductSales.ProductSalesWindow>
>;
export type UnmatchedProductSalesLineParity = Assert<
  Equal<UnmatchedProductSalesLine, apiProductSales.UnmatchedProductSalesLine>
>;
export type ProductSalesReportParity = Assert<
  Equal<ProductSalesReport, apiProductSales.ProductSalesReport>
>;
