// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiMarkets from "@seams/commerce-contracts/records/api-markets";
import type {
  CommerceMarketRateV1,
  CommerceMarketPricingV1,
  CreateCommerceMarketV1,
  UpdateCommerceMarketV1,
  CommerceMarketCommandV1,
  CommerceMarketV1,
  CommerceOrderMarketV1,
} from "./markets.ts";
export type CommerceMarketRateV1Parity = Assert<
  Equal<CommerceMarketRateV1, apiMarkets.CommerceMarketRateV1>
>;
export type CommerceMarketPricingV1Parity = Assert<
  Equal<CommerceMarketPricingV1, apiMarkets.CommerceMarketPricingV1>
>;
export type CreateCommerceMarketV1Parity = Assert<
  Equal<CreateCommerceMarketV1, apiMarkets.CreateCommerceMarketV1>
>;
export type UpdateCommerceMarketV1Parity = Assert<
  Equal<UpdateCommerceMarketV1, apiMarkets.UpdateCommerceMarketV1>
>;
export type CommerceMarketCommandV1Parity = Assert<
  Equal<CommerceMarketCommandV1, apiMarkets.CommerceMarketCommandV1>
>;
export type CommerceMarketV1Parity = Assert<
  Equal<CommerceMarketV1, apiMarkets.CommerceMarketV1>
>;
export type CommerceOrderMarketV1Parity = Assert<
  Equal<CommerceOrderMarketV1, apiMarkets.CommerceOrderMarketV1>
>;
