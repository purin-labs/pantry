// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiCheckoutProfile from "@purin-labs/commerce-contracts/records/api-checkout-profile";
import type {
  ActivateCommerceCheckoutProfileV1,
  CreateCommerceCheckoutProfileDraftV1,
  PublishCommerceCheckoutProfileV1,
  ReplaceCommerceCheckoutProfileDraftV1,
  RetireCommerceCheckoutProfileV1,
  CommerceCheckoutProfileActivationV1,
  CommerceActiveCheckoutProfileV1,
} from "./checkout-profile.ts";
export type ActivateCommerceCheckoutProfileV1Parity = Assert<
  Equal<
    ActivateCommerceCheckoutProfileV1,
    apiCheckoutProfile.ActivateCommerceCheckoutProfileV1
  >
>;
export type CreateCommerceCheckoutProfileDraftV1Parity = Assert<
  Equal<
    CreateCommerceCheckoutProfileDraftV1,
    apiCheckoutProfile.CreateCommerceCheckoutProfileDraftV1
  >
>;
export type PublishCommerceCheckoutProfileV1Parity = Assert<
  Equal<
    PublishCommerceCheckoutProfileV1,
    apiCheckoutProfile.PublishCommerceCheckoutProfileV1
  >
>;
export type ReplaceCommerceCheckoutProfileDraftV1Parity = Assert<
  Equal<
    ReplaceCommerceCheckoutProfileDraftV1,
    apiCheckoutProfile.ReplaceCommerceCheckoutProfileDraftV1
  >
>;
export type RetireCommerceCheckoutProfileV1Parity = Assert<
  Equal<
    RetireCommerceCheckoutProfileV1,
    apiCheckoutProfile.RetireCommerceCheckoutProfileV1
  >
>;
export type CommerceCheckoutProfileActivationV1Parity = Assert<
  Equal<
    CommerceCheckoutProfileActivationV1,
    apiCheckoutProfile.CommerceCheckoutProfileActivationV1
  >
>;
export type CommerceActiveCheckoutProfileV1Parity = Assert<
  Equal<
    CommerceActiveCheckoutProfileV1,
    apiCheckoutProfile.CommerceActiveCheckoutProfileV1
  >
>;
