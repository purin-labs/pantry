// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import {
  OpenObject,
  SafeInteger,
  recordParser,
} from "@purin-labs/contract-schema";
import { resourceIdSchema } from "./identifiers.ts";
import { currencyCodeSchema, moneySchema } from "./money.ts";
import { commerceTimestampSchema } from "./provenance.ts";

export const buyerContactPolicySchema = Type.Union([
  Type.Literal("email_required"),
  Type.Literal("email_required_phone_optional"),
  Type.Literal("email_and_phone_required"),
]);
export type BuyerContactPolicy = Static<typeof buyerContactPolicySchema>;

export const checkoutRefundGovernancePolicySchema = Type.Union([
  OpenObject({ kind: Type.Literal("approval_required") }),
  OpenObject({ kind: Type.Literal("automatic_up_to"), threshold: moneySchema }),
]);
export type CheckoutRefundGovernancePolicy = Static<
  typeof checkoutRefundGovernancePolicySchema
>;

export const checkoutAfterSalePolicySchema = OpenObject({
  cancellationPolicyId: resourceIdSchema,
  refundPolicyId: resourceIdSchema,
  refundGovernance: checkoutRefundGovernancePolicySchema,
});
export type CheckoutAfterSalePolicy = Static<
  typeof checkoutAfterSalePolicySchema
>;

export const savedAddressPolicySchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("enabled"),
]);
export type SavedAddressPolicy = Static<typeof savedAddressPolicySchema>;

export const checkoutBuyerPolicySchema = Type.Union([
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

export const checkoutCartPolicySchema = OpenObject({
  kind: Type.Literal("single_fulfillment"),
  minimumLines: SafeInteger,
  maximumLines: SafeInteger,
  maximumTotalQuantity: SafeInteger,
});
export type CheckoutCartPolicy = Static<typeof checkoutCartPolicySchema>;

export const checkoutCurrencyPolicySchema = OpenObject({
  kind: Type.Literal("fixed"),
  currency: currencyCodeSchema,
});
export type CheckoutCurrencyPolicy = Static<
  typeof checkoutCurrencyPolicySchema
>;

export const checkoutFulfillmentPolicySchema = Type.Union([
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

export const checkoutPaymentPolicySchema = OpenObject({
  kind: Type.Literal("external_provider"),
  paymentProviderBindingId: resourceIdSchema,
});
export type CheckoutPaymentPolicy = Static<typeof checkoutPaymentPolicySchema>;

export const checkoutPresentationPolicySchema = OpenObject({
  locale: Type.String(),
  merchantDisplayName: Type.String(),
  termsPolicyId: resourceIdSchema,
  privacyPolicyId: resourceIdSchema,
  supportContact: Type.String(),
});
export type CheckoutPresentationPolicy = Static<
  typeof checkoutPresentationPolicySchema
>;

export const checkoutPricingPolicySchema = OpenObject({
  kind: Type.Literal("published_offers"),
  salesChannelId: resourceIdSchema,
});
export type CheckoutPricingPolicy = Static<typeof checkoutPricingPolicySchema>;

export const checkoutTaxPolicySchema = Type.Union([
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

export const checkoutProfileConfigurationSchema = OpenObject({
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

export const checkoutProfileLifecycleSchema = Type.Union([
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

export const checkoutProfileSchema = OpenObject({
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

// Parsers of the records above (Plan 78 step 2).
export const parseBuyerContactPolicy = recordParser(buyerContactPolicySchema);
export const parseCheckoutRefundGovernancePolicy = recordParser(
  checkoutRefundGovernancePolicySchema,
);
export const parseCheckoutAfterSalePolicy = recordParser(
  checkoutAfterSalePolicySchema,
);
export const parseSavedAddressPolicy = recordParser(savedAddressPolicySchema);
export const parseCheckoutBuyerPolicy = recordParser(checkoutBuyerPolicySchema);
export const parseCheckoutCartPolicy = recordParser(checkoutCartPolicySchema);
export const parseCheckoutCurrencyPolicy = recordParser(
  checkoutCurrencyPolicySchema,
);
export const parseCheckoutFulfillmentPolicy = recordParser(
  checkoutFulfillmentPolicySchema,
);
export const parseCheckoutPaymentPolicy = recordParser(
  checkoutPaymentPolicySchema,
);
export const parseCheckoutPresentationPolicy = recordParser(
  checkoutPresentationPolicySchema,
);
export const parseCheckoutPricingPolicy = recordParser(
  checkoutPricingPolicySchema,
);
export const parseCheckoutTaxPolicy = recordParser(checkoutTaxPolicySchema);
export const parseCheckoutProfileConfiguration = recordParser(
  checkoutProfileConfigurationSchema,
);
export const parseCheckoutProfileLifecycle = recordParser(
  checkoutProfileLifecycleSchema,
);
export const parseCheckoutProfile = recordParser(checkoutProfileSchema);
export const parseCheckoutProfileReference = recordParser(
  checkoutProfileReferenceSchema,
);
