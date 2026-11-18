// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiProductionRequest from "@seams/commerce-contracts/records/api-production-request";
import type { ProductionRequestFields } from "./production-request.ts";
export type ProductionRequestFieldsParity = Assert<
  Equal<ProductionRequestFields, apiProductionRequest.ProductionRequestFields>
>;
