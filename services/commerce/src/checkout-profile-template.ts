import type {
  CheckoutProfileConfiguration,
  Storefront,
} from "@purin-labs/commerce-contracts";
import { assertNever } from "@purin-labs/std";

import { TEMPLATE_PAYMENT_BINDING_ID } from "./working-payment-bindings.ts";

type CheckoutProfileTemplate = Readonly<{
  checkoutProfileId: string;
  name: string;
  configuration: CheckoutProfileConfiguration;
}>;

export function buildStorefrontCheckoutProfileTemplate(
  input: Readonly<{
    storefront: Storefront;
    currency: string;
    /** A working account's binding; the lab binding when there is none. */
    paymentProviderBindingId?: string;
  }>,
): CheckoutProfileTemplate {
  return {
    checkoutProfileId: `checkout_profile_${input.storefront.storefrontId}_default`,
    name: `${input.storefront.name} checkout`,
    configuration: {
      currencyPolicy: { kind: "fixed", currency: input.currency },
      buyerPolicy: {
        kind: "guest_or_account",
        requiredContact: "email_required_phone_optional",
        savedAddressPolicy: "enabled",
      },
      cartPolicy: {
        kind: "single_fulfillment",
        minimumLines: 1,
        maximumLines: 50,
        maximumTotalQuantity: 100,
      },
      pricingPolicy: {
        kind: "published_offers",
        salesChannelId: input.storefront.salesChannelId,
      },
      fulfillmentPolicy: templateFulfillmentPolicy(input.storefront),
      taxPolicy: templateTaxPolicy(input.storefront),
      paymentPolicy: {
        kind: "external_provider",
        paymentProviderBindingId:
          input.paymentProviderBindingId ?? TEMPLATE_PAYMENT_BINDING_ID,
      },
      afterSalePolicy: {
        cancellationPolicyId: "cancellation_policy_standard",
        refundPolicyId: "refund_policy_standard",
        refundGovernance: { kind: "approval_required" },
      },
      presentationPolicy: {
        locale: "en",
        merchantDisplayName: input.storefront.name,
        termsPolicyId: "terms_policy_standard",
        privacyPolicyId: "privacy_policy_standard",
        supportContact: "merchant_support",
      },
    },
  };
}

function templateFulfillmentPolicy(
  storefront: Storefront,
): CheckoutProfileConfiguration["fulfillmentPolicy"] {
  switch (storefront.fulfillment.kind) {
    case "pickup":
      return {
        kind: "pickup_only",
        pickupPolicyId: `pickup_policy_${storefront.storefrontId}`,
      };
    case "shipping":
      return {
        kind: "shipping_only",
        shippingPolicyId: storefront.fulfillment.shippingProfileId,
      };
    default:
      return assertNever(
        storefront.fulfillment,
        "Unsupported storefront fulfillment",
      );
  }
}

function templateTaxPolicy(
  storefront: Storefront,
): CheckoutProfileConfiguration["taxPolicy"] {
  switch (storefront.checkout.tax.kind) {
    case "percentage":
      return {
        kind: "merchant_inclusive",
        jurisdictionPolicyId: `tax_policy_${storefront.storefrontId}`,
      };
    case "provider_quoted":
      return {
        kind: "provider_quoted",
        taxCapabilityId: storefront.checkout.tax.providerAccountReference,
        registrationPolicyId: `tax_registration_${storefront.storefrontId}`,
      };
    default:
      return assertNever(
        storefront.checkout.tax,
        "Unsupported storefront fulfillment",
      );
  }
}
