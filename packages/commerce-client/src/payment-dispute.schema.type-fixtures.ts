// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiPaymentDispute from "@seams/commerce-contracts/records/api-payment-dispute";
import type { ObserveCommercePaymentDisputeV1 } from "./payment-dispute.ts";
export type ObserveCommercePaymentDisputeV1Parity = Assert<
  Equal<
    ObserveCommercePaymentDisputeV1,
    apiPaymentDispute.ObserveCommercePaymentDisputeV1
  >
>;
