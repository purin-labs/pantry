// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiInternationalAddresses from "@seams/commerce-contracts/records/api-international-addresses";
import type {
  CommerceInternationalShippingCountry,
  CommerceInternationalShippingAddressV1,
  CommerceShippingCountry,
} from "./international-addresses.ts";
export type CommerceInternationalShippingCountryParity = Assert<
  Equal<
    CommerceInternationalShippingCountry,
    apiInternationalAddresses.CommerceInternationalShippingCountry
  >
>;
export type CommerceInternationalShippingAddressV1Parity = Assert<
  Equal<
    CommerceInternationalShippingAddressV1,
    apiInternationalAddresses.CommerceInternationalShippingAddressV1
  >
>;
export type CommerceShippingCountryParity = Assert<
  Equal<
    CommerceShippingCountry,
    apiInternationalAddresses.CommerceShippingCountry
  >
>;
