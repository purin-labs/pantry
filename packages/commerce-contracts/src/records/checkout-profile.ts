// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger } from "@purin-labs/contract-schema";
import { resourceIdSchema } from "./identifiers.ts";
import { currencyCodeSchema } from "./money.ts";
import { commerceTimestampSchema } from "./provenance.ts";

const buyerContactPolicySchema = Type.Union([
  Type.Literal("email_required"),
  Type.Literal("email_required_phone_optional"),
  Type.Literal("email_and_phone_required"),
]);
export type BuyerContactPolicy = Static<typeof buyerContactPolicySchema>;

// Every refund waits for a merchant approval. A profile names that rule, so
// that a later rule is a new kind and not a change of meaning.
const checkoutRefundGovernancePolicySchema = OpenObject({
  kind: Type.Literal("approval_required"),
});
export type CheckoutRefundGovernancePolicy = Static<
  typeof checkoutRefundGovernancePolicySchema
>;

const checkoutAfterSalePolicySchema = OpenObject({
  cancellationPolicyId: resourceIdSchema,
  refundPolicyId: resourceIdSchema,
  refundGovernance: checkoutRefundGovernancePolicySchema,
});
export type CheckoutAfterSalePolicy = Static<
  typeof checkoutAfterSalePolicySchema
>;

const savedAddressPolicySchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("enabled"),
]);
export type SavedAddressPolicy = Static<typeof savedAddressPolicySchema>;

const checkoutBuyerPolicySchema = Type.Union([
  OpenObject({
    kind: Type.Literal("guest"),
    requiredContact: buyerContactPolicySchema,
  }),
  OpenObject({
    kind: Type.Literal("guest_or_account"),
    requiredContact: buyerContactPolicySchema,
    savedAddressPolicy: savedAddressPolicySchema,
  }),
]);
export type CheckoutBuyerPolicy = Static<typeof checkoutBuyerPolicySchema>;

const checkoutCartPolicySchema = OpenObject({
  kind: Type.Literal("single_fulfillment"),
  minimumLines: SafeInteger,
  maximumLines: SafeInteger,
  maximumTotalQuantity: SafeInteger,
});
export type CheckoutCartPolicy = Static<typeof checkoutCartPolicySchema>;

const checkoutCurrencyPolicySchema = OpenObject({
  kind: Type.Literal("fixed"),
  currency: currencyCodeSchema,
});
export type CheckoutCurrencyPolicy = Static<
  typeof checkoutCurrencyPolicySchema
>;

const checkoutFulfillmentPolicySchema = Type.Union([
  OpenObject({
    kind: Type.Literal("pickup_only"),
    pickupPolicyId: resourceIdSchema,
  }),
  OpenObject({
    kind: Type.Literal("shipping_only"),
    shippingPolicyId: resourceIdSchema,
  }),
  OpenObject({
    kind: Type.Literal("buyer_choice"),
    pickupPolicyId: resourceIdSchema,
    shippingPolicyId: resourceIdSchema,
  }),
]);
export type CheckoutFulfillmentPolicy = Static<
  typeof checkoutFulfillmentPolicySchema
>;

const checkoutPaymentPolicySchema = OpenObject({
  kind: Type.Literal("external_provider"),
  paymentProviderBindingId: resourceIdSchema,
});
export type CheckoutPaymentPolicy = Static<typeof checkoutPaymentPolicySchema>;

const checkoutPresentationPolicySchema = OpenObject({
  locale: Type.String(),
  merchantDisplayName: Type.String(),
  termsPolicyId: resourceIdSchema,
  privacyPolicyId: resourceIdSchema,
  supportContact: Type.String(),
});
export type CheckoutPresentationPolicy = Static<
  typeof checkoutPresentationPolicySchema
>;

const checkoutPricingPolicySchema = OpenObject({
  kind: Type.Literal("published_offers"),
  salesChannelId: resourceIdSchema,
});
export type CheckoutPricingPolicy = Static<typeof checkoutPricingPolicySchema>;

const checkoutTaxPolicySchema = Type.Union([
  OpenObject({
    kind: Type.Literal("merchant_inclusive"),
    jurisdictionPolicyId: resourceIdSchema,
  }),
  OpenObject({
    kind: Type.Literal("provider_quoted"),
    taxCapabilityId: resourceIdSchema,
    registrationPolicyId: resourceIdSchema,
  }),
]);
export type CheckoutTaxPolicy = Static<typeof checkoutTaxPolicySchema>;

const checkoutProfileConfigurationSchema = OpenObject({
  currencyPolicy: checkoutCurrencyPolicySchema,
  buyerPolicy: checkoutBuyerPolicySchema,
  cartPolicy: checkoutCartPolicySchema,
  pricingPolicy: checkoutPricingPolicySchema,
  fulfillmentPolicy: checkoutFulfillmentPolicySchema,
  taxPolicy: checkoutTaxPolicySchema,
  paymentPolicy: checkoutPaymentPolicySchema,
  afterSalePolicy: checkoutAfterSalePolicySchema,
  presentationPolicy: checkoutPresentationPolicySchema,
});
export type CheckoutProfileConfiguration = Static<
  typeof checkoutProfileConfigurationSchema
>;

const checkoutProfileLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("draft"),
    createdAt: commerceTimestampSchema,
    updatedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("published"),
    publishedAt: commerceTimestampSchema,
    publishedBy: resourceIdSchema,
  }),
  OpenObject({
    state: Type.Literal("retired"),
    publishedAt: commerceTimestampSchema,
    retiredAt: commerceTimestampSchema,
    retiredBy: resourceIdSchema,
  }),
]);
export type CheckoutProfileLifecycle = Static<
  typeof checkoutProfileLifecycleSchema
>;

const checkoutProfileSchema = OpenObject({
  checkoutProfileId: resourceIdSchema,
  merchantId: resourceIdSchema,
  revision: SafeInteger,
  name: Type.String(),
  configuration: checkoutProfileConfigurationSchema,
  lifecycle: checkoutProfileLifecycleSchema,
});
export type CheckoutProfile = Static<typeof checkoutProfileSchema>;

export const checkoutProfileReferenceSchema = OpenObject({
  checkoutProfileId: resourceIdSchema,
  revision: SafeInteger,
});
export type CheckoutProfileReference = Static<
  typeof checkoutProfileReferenceSchema
>;
