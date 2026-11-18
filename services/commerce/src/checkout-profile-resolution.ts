import { checkoutProfileOf } from "@seams/commerce-client";
import {
  commerceTransition,
  type CheckoutProfile,
  type CheckoutProfileConfiguration,
  type CheckoutProfileReference,
  type Storefront,
} from "@seams/commerce-contracts";
import type {
  CommerceBuyerContactAuthorityV1,
  CommerceCheckoutBuyerAuthorityV1,
  CommerceMutationErrorV1,
  CommerceProtectedBuyerContactV1,
} from "@seams/commerce-client";
import { checkoutOnlineSource } from "@seams/commerce-client";

import { readCheckout } from "./checkout-persistence.ts";
import { readProfile } from "./checkout-profile-persistence.ts";
import type { CommerceDatabase } from "./database.ts";
import { assertNever } from "@seams/std";

type CheckoutProfileResolutionResult =
  | Readonly<{ kind: "resolved"; profile: CheckoutProfile }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

type CheckoutProfileCartResolutionResult =
  | Readonly<{ kind: "resolved"; profile: CheckoutProfile }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function resolveCheckoutProfileForQuote(
  input: Readonly<{
    database: CommerceDatabase;
    merchantId: string;
    reference: CheckoutProfileReference;
    storefront: Storefront;
    fulfillment: "pickup" | "shipping";
    lineQuantities: readonly number[];
    buyerSessionDigest: string;
    buyerAuthority: CommerceCheckoutBuyerAuthorityV1;
    destinationAuthority: "pickup" | "provided_address" | "saved_address";
  }>,
): CheckoutProfileResolutionResult {
  const profile = readProfile(
    input.database,
    input.merchantId,
    input.reference.checkoutProfileId,
    input.reference.revision,
  );
  if (profile === undefined)
    return checkoutProfileRejected("checkoutProfile.lifecycle");
  const use = commerceTransition("checkout_profile", profile.lifecycle, "use");
  if (!use.allowed) return { kind: "rejected", error: use.refusal };
  const configuration = profile.configuration;
  if (
    !buyerAuthorityMatches(input, configuration) ||
    !destinationAuthorityMatches(input, configuration)
  ) {
    return checkoutProfileRejected("checkoutProfile.buyerPolicy");
  }
  const cartError = validateCartPolicy(configuration, input.lineQuantities);
  if (cartError !== undefined) return checkoutProfileRejected(cartError);
  if (
    configuration.pricingPolicy.kind !== "published_offers" ||
    configuration.pricingPolicy.salesChannelId !==
      input.storefront.salesChannelId
  ) {
    return checkoutProfileRejected("checkoutProfile.pricingPolicy");
  }
  if (
    !fulfillmentPolicyMatches(
      configuration,
      input.storefront,
      input.fulfillment,
    )
  ) {
    return checkoutProfileRejected("checkoutProfile.fulfillmentPolicy");
  }
  if (!taxPolicyMatches(configuration, input.storefront, input.fulfillment)) {
    return checkoutProfileRejected("checkoutProfile.taxPolicy");
  }
  return { kind: "resolved", profile };
}

export function resolveCheckoutProfileForCart(
  input: Readonly<{
    database: CommerceDatabase;
    merchantId: string;
    reference: CheckoutProfileReference;
    storefront: Storefront;
    lineQuantities: readonly number[];
  }>,
): CheckoutProfileCartResolutionResult {
  const profile = readProfile(
    input.database,
    input.merchantId,
    input.reference.checkoutProfileId,
    input.reference.revision,
  );
  if (profile === undefined)
    return checkoutProfileRejected("checkoutProfile.lifecycle");
  const use = commerceTransition("checkout_profile", profile.lifecycle, "use");
  if (!use.allowed) return { kind: "rejected", error: use.refusal };
  const configuration = profile.configuration;
  const cartError = validateCartPolicy(configuration, input.lineQuantities);
  if (cartError !== undefined) return checkoutProfileRejected(cartError);
  if (
    configuration.pricingPolicy.kind !== "published_offers" ||
    configuration.pricingPolicy.salesChannelId !==
      input.storefront.salesChannelId
  ) {
    return checkoutProfileRejected("checkoutProfile.pricingPolicy");
  }
  if (
    !fulfillmentPolicyMatches(
      configuration,
      input.storefront,
      input.storefront.fulfillment.kind,
    )
  ) {
    return checkoutProfileRejected("checkoutProfile.fulfillmentPolicy");
  }
  return { kind: "resolved", profile };
}

function buyerAuthorityMatches(
  input: Readonly<{
    database: CommerceDatabase;
    merchantId: string;
    reference: CheckoutProfileReference;
    buyerSessionDigest: string;
    buyerAuthority: CommerceCheckoutBuyerAuthorityV1;
  }>,
  configuration: CheckoutProfileConfiguration,
): boolean {
  switch (input.buyerAuthority.kind) {
    case "guest":
      return (
        guestBuyerPolicyMatches(configuration) &&
        guestContactAuthorityMatches(
          input,
          configuration,
          input.buyerAuthority.contactAuthority,
        )
      );
    case "identified_customer":
      return (
        configuration.buyerPolicy.kind === "guest_or_account" &&
        providedBuyerContactMatches(
          configuration.buyerPolicy.requiredContact,
          input.buyerAuthority.contact.kind,
        )
      );
    default:
      return assertNever(
        input.buyerAuthority,
        "Unsupported checkout profile policy",
      );
  }
}

function guestBuyerPolicyMatches(
  configuration: CheckoutProfileConfiguration,
): boolean {
  return (
    configuration.buyerPolicy.kind === "guest" ||
    configuration.buyerPolicy.kind === "guest_or_account"
  );
}

function guestContactAuthorityMatches(
  input: Readonly<{
    database: CommerceDatabase;
    merchantId: string;
    reference: CheckoutProfileReference;
    buyerSessionDigest: string;
  }>,
  configuration: CheckoutProfileConfiguration,
  authority: CommerceBuyerContactAuthorityV1,
): boolean {
  switch (authority.kind) {
    case "provided":
      return providedBuyerContactMatches(
        configuration.buyerPolicy.requiredContact,
        authority.contact.kind,
      );
    case "retained_checkout": {
      const checkout = readCheckout(
        input.database,
        input.merchantId,
        authority.checkoutId,
      );
      return (
        checkout !== undefined &&
        checkoutProfileOf(checkout)?.checkoutProfileId ===
          input.reference.checkoutProfileId &&
        checkoutProfileOf(checkout)?.revision === input.reference.revision &&
        checkoutOnlineSource(checkout)?.buyerSessionDigest ===
          input.buyerSessionDigest &&
        checkout.revision === authority.checkoutRevision &&
        checkout.lifecycle.quote.quoteDigest === authority.quoteDigest &&
        (checkout.lifecycle.state === "quoted" ||
          checkout.lifecycle.state === "expired")
      );
    }
    default:
      return assertNever(authority, "Unsupported checkout profile policy");
  }
}

function destinationAuthorityMatches(
  input: Readonly<{
    buyerAuthority: CommerceCheckoutBuyerAuthorityV1;
    destinationAuthority: "pickup" | "provided_address" | "saved_address";
  }>,
  configuration: CheckoutProfileConfiguration,
): boolean {
  if (input.destinationAuthority !== "saved_address") return true;
  return (
    input.buyerAuthority.kind === "identified_customer" &&
    configuration.buyerPolicy.kind === "guest_or_account" &&
    configuration.buyerPolicy.savedAddressPolicy === "enabled"
  );
}

function providedBuyerContactMatches(
  policy: CheckoutProfileConfiguration["buyerPolicy"]["requiredContact"],
  contactKind: CommerceProtectedBuyerContactV1["kind"],
): boolean {
  switch (policy) {
    case "email_required":
      return contactKind === "email";
    case "email_required_phone_optional":
      return contactKind === "email" || contactKind === "email_and_phone";
    case "email_and_phone_required":
      return contactKind === "email_and_phone";
    default:
      return assertNever(policy, "Unsupported checkout profile policy");
  }
}

export function checkoutProfileAcceptsCurrency(
  configuration: CheckoutProfileConfiguration,
  currency: string,
): boolean {
  return (
    configuration.currencyPolicy.kind === "fixed" &&
    configuration.currencyPolicy.currency === currency
  );
}

function validateCartPolicy(
  configuration: CheckoutProfileConfiguration,
  lineQuantities: readonly number[],
): string | undefined {
  const policy = configuration.cartPolicy;
  if (
    policy.kind !== "single_fulfillment" ||
    lineQuantities.length < policy.minimumLines ||
    lineQuantities.length > policy.maximumLines
  ) {
    return "checkoutProfile.cartPolicy";
  }
  let totalQuantity = 0;
  for (const quantity of lineQuantities) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      return "checkoutProfile.cartPolicy";
    }
    totalQuantity += quantity;
    if (
      !Number.isSafeInteger(totalQuantity) ||
      totalQuantity > policy.maximumTotalQuantity
    ) {
      return "checkoutProfile.cartPolicy";
    }
  }
  return undefined;
}

function fulfillmentPolicyMatches(
  configuration: CheckoutProfileConfiguration,
  storefront: Storefront,
  fulfillment: "pickup" | "shipping",
): boolean {
  switch (configuration.fulfillmentPolicy.kind) {
    case "pickup_only":
      return (
        fulfillment === "pickup" && storefront.fulfillment.kind === "pickup"
      );
    case "shipping_only":
      return (
        fulfillment === "shipping" &&
        storefront.fulfillment.kind === "shipping" &&
        configuration.fulfillmentPolicy.shippingPolicyId ===
          storefront.fulfillment.shippingProfileId
      );
    case "buyer_choice":
      return fulfillment === "pickup"
        ? storefront.fulfillment.kind === "pickup"
        : storefront.fulfillment.kind === "shipping" &&
            configuration.fulfillmentPolicy.shippingPolicyId ===
              storefront.fulfillment.shippingProfileId;
    default:
      return assertNever(
        configuration.fulfillmentPolicy,
        "Unsupported checkout profile policy",
      );
  }
}

function taxPolicyMatches(
  configuration: CheckoutProfileConfiguration,
  storefront: Storefront,
  fulfillment: "pickup" | "shipping",
): boolean {
  switch (storefront.checkout.tax.kind) {
    case "percentage":
      return (
        (fulfillment === "pickup" || fulfillment === "shipping") &&
        configuration.taxPolicy.kind === "merchant_inclusive"
      );
    case "provider_quoted":
      return (
        fulfillment === "shipping" &&
        configuration.taxPolicy.kind === "provider_quoted" &&
        configuration.taxPolicy.taxCapabilityId ===
          storefront.checkout.tax.providerAccountReference
      );
    default:
      return assertNever(
        storefront.checkout.tax,
        "Unsupported checkout profile policy",
      );
  }
}

function checkoutProfileRejected(
  field: string,
): Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }> {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}
