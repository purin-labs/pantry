// Plan 78 step 2: the storefront address schema type equals the address type
// that international-addresses.ts still declares.
import type * as Storefront from "@purin-labs/commerce-contracts/records/api-storefront";
import type { CommerceInternationalShippingAddressV1 } from "./international-addresses.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
export type InternationalAddressParity = Assert<
  Equal<
    Storefront.WireInternationalShippingAddress,
    CommerceInternationalShippingAddressV1
  >
>;
