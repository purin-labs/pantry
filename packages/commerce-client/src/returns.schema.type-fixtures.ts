// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiReturns from "@purin-labs/commerce-contracts/records/api-returns";
import type {
  AuthorizeCommerceReturnV1,
  CloseCommerceReturnV1,
  CommerceReturnDisposition,
  ReceiveCommerceReturnV1,
  CommerceReturnRequestLineV1,
  RequestCommerceBuyerReturnV1,
  RequestCommerceReturnV1,
  CommerceReturnCommandV1,
  CommerceReturnLifecycleV1,
  CommerceReturnLineV1,
  CommerceReturnV1,
} from "./returns.ts";
export type AuthorizeCommerceReturnV1Parity = Assert<
  Equal<AuthorizeCommerceReturnV1, apiReturns.AuthorizeCommerceReturnV1>
>;
export type CloseCommerceReturnV1Parity = Assert<
  Equal<CloseCommerceReturnV1, apiReturns.CloseCommerceReturnV1>
>;
export type CommerceReturnDispositionParity = Assert<
  Equal<CommerceReturnDisposition, apiReturns.CommerceReturnDisposition>
>;
export type ReceiveCommerceReturnV1Parity = Assert<
  Equal<ReceiveCommerceReturnV1, apiReturns.ReceiveCommerceReturnV1>
>;
export type CommerceReturnRequestLineV1Parity = Assert<
  Equal<CommerceReturnRequestLineV1, apiReturns.CommerceReturnRequestLineV1>
>;
export type RequestCommerceBuyerReturnV1Parity = Assert<
  Equal<
    RequestCommerceBuyerReturnV1,
    apiReturns.RequestCommerceBuyerReturnV1
  >
>;
export type RequestCommerceReturnV1Parity = Assert<
  Equal<RequestCommerceReturnV1, apiReturns.RequestCommerceReturnV1>
>;
export type CommerceReturnCommandV1Parity = Assert<
  Equal<CommerceReturnCommandV1, apiReturns.CommerceReturnCommandV1>
>;
export type CommerceReturnLifecycleV1Parity = Assert<
  Equal<CommerceReturnLifecycleV1, apiReturns.CommerceReturnLifecycleV1>
>;
export type CommerceReturnLineV1Parity = Assert<
  Equal<CommerceReturnLineV1, apiReturns.CommerceReturnLineV1>
>;
export type CommerceReturnV1Parity = Assert<
  Equal<CommerceReturnV1, apiReturns.CommerceReturnV1>
>;
