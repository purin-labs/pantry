// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiCustomers from "@seams/commerce-contracts/records/api-customers";
import type {
  CreateCommerceCustomerV1,
  EraseCommerceCustomerV1,
  RequestCommerceCustomerSignInV1,
  CommerceCustomerAddressInputV1,
  SaveCommerceCustomerAddressV1,
  CommerceCustomerAddressV1,
  CommerceBuyerCustomerV1,
  CommerceCustomerAccessV1,
  UpdateCommerceCustomerV1,
  CommerceCustomerCommandV1,
  CommerceMarketingConsentState,
  CommerceMarketingConsentV1,
  CommerceCustomerV1,
  CommerceCustomerExportV1,
  CommerceCustomerSignInChallengeV1,
  CommerceNotificationV1,
  VerifyCommerceCustomerSignInV1,
} from "./customers.ts";
export type CreateCommerceCustomerV1Parity = Assert<
  Equal<CreateCommerceCustomerV1, apiCustomers.CreateCommerceCustomerV1>
>;
export type EraseCommerceCustomerV1Parity = Assert<
  Equal<EraseCommerceCustomerV1, apiCustomers.EraseCommerceCustomerV1>
>;
export type RequestCommerceCustomerSignInV1Parity = Assert<
  Equal<
    RequestCommerceCustomerSignInV1,
    apiCustomers.RequestCommerceCustomerSignInV1
  >
>;
export type CommerceCustomerAddressInputV1Parity = Assert<
  Equal<
    CommerceCustomerAddressInputV1,
    apiCustomers.CommerceCustomerAddressInputV1
  >
>;
export type SaveCommerceCustomerAddressV1Parity = Assert<
  Equal<
    SaveCommerceCustomerAddressV1,
    apiCustomers.SaveCommerceCustomerAddressV1
  >
>;
export type CommerceCustomerAddressV1Parity = Assert<
  Equal<CommerceCustomerAddressV1, apiCustomers.CommerceCustomerAddressV1>
>;
export type CommerceBuyerCustomerV1Parity = Assert<
  Equal<CommerceBuyerCustomerV1, apiCustomers.CommerceBuyerCustomerV1>
>;
export type CommerceCustomerAccessV1Parity = Assert<
  Equal<CommerceCustomerAccessV1, apiCustomers.CommerceCustomerAccessV1>
>;
export type UpdateCommerceCustomerV1Parity = Assert<
  Equal<UpdateCommerceCustomerV1, apiCustomers.UpdateCommerceCustomerV1>
>;
export type CommerceCustomerCommandV1Parity = Assert<
  Equal<CommerceCustomerCommandV1, apiCustomers.CommerceCustomerCommandV1>
>;
export type CommerceMarketingConsentStateParity = Assert<
  Equal<
    CommerceMarketingConsentState,
    apiCustomers.CommerceMarketingConsentState
  >
>;
export type CommerceMarketingConsentV1Parity = Assert<
  Equal<CommerceMarketingConsentV1, apiCustomers.CommerceMarketingConsentV1>
>;
export type CommerceCustomerV1Parity = Assert<
  Equal<CommerceCustomerV1, apiCustomers.CommerceCustomerV1>
>;
export type CommerceCustomerExportV1Parity = Assert<
  Equal<CommerceCustomerExportV1, apiCustomers.CommerceCustomerExportV1>
>;
export type CommerceCustomerSignInChallengeV1Parity = Assert<
  Equal<
    CommerceCustomerSignInChallengeV1,
    apiCustomers.CommerceCustomerSignInChallengeV1
  >
>;
export type CommerceNotificationV1Parity = Assert<
  Equal<CommerceNotificationV1, apiCustomers.CommerceNotificationV1>
>;
export type VerifyCommerceCustomerSignInV1Parity = Assert<
  Equal<
    VerifyCommerceCustomerSignInV1,
    apiCustomers.VerifyCommerceCustomerSignInV1
  >
>;
