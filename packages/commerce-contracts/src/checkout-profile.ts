import type {
  BuyerContactPolicy,
  CheckoutAfterSalePolicy,
  CheckoutBuyerPolicy,
  CheckoutCartPolicy,
  CheckoutCurrencyPolicy,
  CheckoutFulfillmentPolicy,
  CheckoutPaymentPolicy,
  CheckoutPresentationPolicy,
  CheckoutPricingPolicy,
  CheckoutProfileConfiguration,
  CheckoutRefundGovernancePolicy,
  CheckoutTaxPolicy,
  SavedAddressPolicy,
} from "./commerce-domain";
import { hasExactKeys, isRecord } from "@purin-labs/std";

const IDENTITY_MAX_LENGTH = 255;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

export type CheckoutProfileParseError = Readonly<{
  code: "checkout_profile_invalid";
  field: string;
}>;

export type CheckoutProfileParseResult<TValue> =
  | Readonly<{ ok: true; value: TValue }>
  | Readonly<{ ok: false; error: CheckoutProfileParseError }>;

export function parseCheckoutProfileConfiguration(
  raw: unknown,
): CheckoutProfileParseResult<CheckoutProfileConfiguration> {
  const configuration = readObject(raw, "configuration");
  if (!configuration.ok) return configuration;
  if (
    !hasExactKeys(configuration.value, [
      "currencyPolicy",
      "buyerPolicy",
      "cartPolicy",
      "pricingPolicy",
      "fulfillmentPolicy",
      "taxPolicy",
      "paymentPolicy",
      "afterSalePolicy",
      "presentationPolicy",
    ])
  )
    return invalidProfile("configuration");

  const currencyPolicy = parseCurrencyPolicy(
    configuration.value.currencyPolicy,
  );
  if (!currencyPolicy.ok) return currencyPolicy;
  const buyerPolicy = parseBuyerPolicy(configuration.value.buyerPolicy);
  if (!buyerPolicy.ok) return buyerPolicy;
  const cartPolicy = parseCartPolicy(configuration.value.cartPolicy);
  if (!cartPolicy.ok) return cartPolicy;
  const pricingPolicy = parsePricingPolicy(configuration.value.pricingPolicy);
  if (!pricingPolicy.ok) return pricingPolicy;
  const fulfillmentPolicy = parseFulfillmentPolicy(
    configuration.value.fulfillmentPolicy,
  );
  if (!fulfillmentPolicy.ok) return fulfillmentPolicy;
  const taxPolicy = parseTaxPolicy(configuration.value.taxPolicy);
  if (!taxPolicy.ok) return taxPolicy;
  const paymentPolicy = parsePaymentPolicy(configuration.value.paymentPolicy);
  if (!paymentPolicy.ok) return paymentPolicy;
  const afterSalePolicy = parseCheckoutAfterSalePolicy(
    configuration.value.afterSalePolicy,
  );
  if (!afterSalePolicy.ok) return afterSalePolicy;
  const presentationPolicy = parseCheckoutPresentationPolicy(
    configuration.value.presentationPolicy,
  );
  if (!presentationPolicy.ok) return presentationPolicy;

  return {
    ok: true,
    value: {
      currencyPolicy: currencyPolicy.value,
      buyerPolicy: buyerPolicy.value,
      cartPolicy: cartPolicy.value,
      pricingPolicy: pricingPolicy.value,
      fulfillmentPolicy: fulfillmentPolicy.value,
      taxPolicy: taxPolicy.value,
      paymentPolicy: paymentPolicy.value,
      afterSalePolicy: afterSalePolicy.value,
      presentationPolicy: presentationPolicy.value,
    },
  };
}

function parseCurrencyPolicy(
  raw: unknown,
): CheckoutProfileParseResult<CheckoutCurrencyPolicy> {
  const policy = readTaggedObject(raw, "configuration.currencyPolicy");
  if (!policy.ok) return policy;
  if (
    policy.value.kind !== "fixed" ||
    !hasExactKeys(policy.value, ["kind", "currency"])
  ) {
    return invalidProfile("configuration.currencyPolicy.kind");
  }
  const currency = readCurrency(
    policy.value.currency,
    "configuration.currencyPolicy.currency",
  );
  return currency.ok
    ? { ok: true, value: { kind: "fixed", currency: currency.value } }
    : currency;
}

function parseBuyerPolicy(
  raw: unknown,
): CheckoutProfileParseResult<CheckoutBuyerPolicy> {
  const policy = readTaggedObject(raw, "configuration.buyerPolicy");
  if (!policy.ok) return policy;
  const requiredContact = readEnum<BuyerContactPolicy>(
    policy.value.requiredContact,
    "configuration.buyerPolicy.requiredContact",
    [
      "email_required",
      "email_required_phone_optional",
      "email_and_phone_required",
    ],
  );
  if (!requiredContact.ok) return requiredContact;
  switch (policy.value.kind) {
    case "guest":
      return hasExactKeys(policy.value, ["kind", "requiredContact"])
        ? {
            ok: true,
            value: { kind: "guest", requiredContact: requiredContact.value },
          }
        : invalidProfile("configuration.buyerPolicy");
    case "guest_or_account": {
      if (
        !hasExactKeys(policy.value, [
          "kind",
          "requiredContact",
          "savedAddressPolicy",
        ])
      ) {
        return invalidProfile("configuration.buyerPolicy");
      }
      const savedAddressPolicy = readEnum<SavedAddressPolicy>(
        policy.value.savedAddressPolicy,
        "configuration.buyerPolicy.savedAddressPolicy",
        ["disabled", "enabled"],
      );
      return savedAddressPolicy.ok
        ? {
            ok: true,
            value: {
              kind: "guest_or_account",
              requiredContact: requiredContact.value,
              savedAddressPolicy: savedAddressPolicy.value,
            },
          }
        : savedAddressPolicy;
    }
    default:
      return invalidProfile("configuration.buyerPolicy.kind");
  }
}

function parseCartPolicy(
  raw: unknown,
): CheckoutProfileParseResult<CheckoutCartPolicy> {
  const policy = readTaggedObject(raw, "configuration.cartPolicy");
  if (!policy.ok) return policy;
  if (
    policy.value.kind !== "single_fulfillment" ||
    !hasExactKeys(policy.value, [
      "kind",
      "minimumLines",
      "maximumLines",
      "maximumTotalQuantity",
    ])
  )
    return invalidProfile("configuration.cartPolicy.kind");
  const minimumLines = readPositiveInteger(
    policy.value.minimumLines,
    "configuration.cartPolicy.minimumLines",
  );
  if (!minimumLines.ok) return minimumLines;
  const maximumLines = readPositiveInteger(
    policy.value.maximumLines,
    "configuration.cartPolicy.maximumLines",
  );
  if (!maximumLines.ok) return maximumLines;
  const maximumTotalQuantity = readPositiveInteger(
    policy.value.maximumTotalQuantity,
    "configuration.cartPolicy.maximumTotalQuantity",
  );
  if (!maximumTotalQuantity.ok) return maximumTotalQuantity;
  if (
    maximumLines.value < minimumLines.value ||
    maximumTotalQuantity.value < minimumLines.value
  ) {
    return invalidProfile("configuration.cartPolicy");
  }
  return {
    ok: true,
    value: {
      kind: "single_fulfillment",
      minimumLines: minimumLines.value,
      maximumLines: maximumLines.value,
      maximumTotalQuantity: maximumTotalQuantity.value,
    },
  };
}

function parsePricingPolicy(
  raw: unknown,
): CheckoutProfileParseResult<CheckoutPricingPolicy> {
  const policy = readTaggedObject(raw, "configuration.pricingPolicy");
  if (!policy.ok) return policy;
  if (
    policy.value.kind !== "published_offers" ||
    !hasExactKeys(policy.value, ["kind", "salesChannelId"])
  ) {
    return invalidProfile("configuration.pricingPolicy.kind");
  }
  const salesChannelId = readIdentity(
    policy.value.salesChannelId,
    "configuration.pricingPolicy.salesChannelId",
  );
  return salesChannelId.ok
    ? {
        ok: true,
        value: {
          kind: "published_offers",
          salesChannelId: salesChannelId.value,
        },
      }
    : salesChannelId;
}

function parseFulfillmentPolicy(
  raw: unknown,
): CheckoutProfileParseResult<CheckoutFulfillmentPolicy> {
  const policy = readTaggedObject(raw, "configuration.fulfillmentPolicy");
  if (!policy.ok) return policy;
  switch (policy.value.kind) {
    case "pickup_only": {
      if (!hasExactKeys(policy.value, ["kind", "pickupPolicyId"])) {
        return invalidProfile("configuration.fulfillmentPolicy");
      }
      const pickupPolicyId = readIdentity(
        policy.value.pickupPolicyId,
        "configuration.fulfillmentPolicy.pickupPolicyId",
      );
      return pickupPolicyId.ok
        ? {
            ok: true,
            value: {
              kind: "pickup_only",
              pickupPolicyId: pickupPolicyId.value,
            },
          }
        : pickupPolicyId;
    }
    case "shipping_only": {
      if (!hasExactKeys(policy.value, ["kind", "shippingPolicyId"])) {
        return invalidProfile("configuration.fulfillmentPolicy");
      }
      const shippingPolicyId = readIdentity(
        policy.value.shippingPolicyId,
        "configuration.fulfillmentPolicy.shippingPolicyId",
      );
      return shippingPolicyId.ok
        ? {
            ok: true,
            value: {
              kind: "shipping_only",
              shippingPolicyId: shippingPolicyId.value,
            },
          }
        : shippingPolicyId;
    }
    case "buyer_choice": {
      if (
        !hasExactKeys(policy.value, [
          "kind",
          "pickupPolicyId",
          "shippingPolicyId",
        ])
      ) {
        return invalidProfile("configuration.fulfillmentPolicy");
      }
      const pickupPolicyId = readIdentity(
        policy.value.pickupPolicyId,
        "configuration.fulfillmentPolicy.pickupPolicyId",
      );
      if (!pickupPolicyId.ok) return pickupPolicyId;
      const shippingPolicyId = readIdentity(
        policy.value.shippingPolicyId,
        "configuration.fulfillmentPolicy.shippingPolicyId",
      );
      return shippingPolicyId.ok
        ? {
            ok: true,
            value: {
              kind: "buyer_choice",
              pickupPolicyId: pickupPolicyId.value,
              shippingPolicyId: shippingPolicyId.value,
            },
          }
        : shippingPolicyId;
    }
    default:
      return invalidProfile("configuration.fulfillmentPolicy.kind");
  }
}

function parseTaxPolicy(
  raw: unknown,
): CheckoutProfileParseResult<CheckoutTaxPolicy> {
  const policy = readTaggedObject(raw, "configuration.taxPolicy");
  if (!policy.ok) return policy;
  switch (policy.value.kind) {
    case "merchant_inclusive": {
      if (!hasExactKeys(policy.value, ["kind", "jurisdictionPolicyId"])) {
        return invalidProfile("configuration.taxPolicy");
      }
      const jurisdictionPolicyId = readIdentity(
        policy.value.jurisdictionPolicyId,
        "configuration.taxPolicy.jurisdictionPolicyId",
      );
      return jurisdictionPolicyId.ok
        ? {
            ok: true,
            value: {
              kind: "merchant_inclusive",
              jurisdictionPolicyId: jurisdictionPolicyId.value,
            },
          }
        : jurisdictionPolicyId;
    }
    case "provider_quoted": {
      if (
        !hasExactKeys(policy.value, [
          "kind",
          "taxCapabilityId",
          "registrationPolicyId",
        ])
      ) {
        return invalidProfile("configuration.taxPolicy");
      }
      const taxCapabilityId = readIdentity(
        policy.value.taxCapabilityId,
        "configuration.taxPolicy.taxCapabilityId",
      );
      if (!taxCapabilityId.ok) return taxCapabilityId;
      const registrationPolicyId = readIdentity(
        policy.value.registrationPolicyId,
        "configuration.taxPolicy.registrationPolicyId",
      );
      return registrationPolicyId.ok
        ? {
            ok: true,
            value: {
              kind: "provider_quoted",
              taxCapabilityId: taxCapabilityId.value,
              registrationPolicyId: registrationPolicyId.value,
            },
          }
        : registrationPolicyId;
    }
    default:
      return invalidProfile("configuration.taxPolicy.kind");
  }
}

function parsePaymentPolicy(
  raw: unknown,
): CheckoutProfileParseResult<CheckoutPaymentPolicy> {
  const policy = readTaggedObject(raw, "configuration.paymentPolicy");
  if (!policy.ok) return policy;
  switch (policy.value.kind) {
    case "external_provider": {
      if (!hasExactKeys(policy.value, ["kind", "paymentProviderBindingId"])) {
        return invalidProfile("configuration.paymentPolicy");
      }
      const paymentProviderBindingId = readIdentity(
        policy.value.paymentProviderBindingId,
        "configuration.paymentPolicy.paymentProviderBindingId",
      );
      return paymentProviderBindingId.ok
        ? {
            ok: true,
            value: {
              kind: "external_provider",
              paymentProviderBindingId: paymentProviderBindingId.value,
            },
          }
        : paymentProviderBindingId;
    }
    default:
      return invalidProfile("configuration.paymentPolicy.kind");
  }
}

export function parseCheckoutAfterSalePolicy(
  raw: unknown,
): CheckoutProfileParseResult<CheckoutAfterSalePolicy> {
  const policy = readObject(raw, "configuration.afterSalePolicy");
  if (!policy.ok) return policy;
  if (
    !hasExactKeys(policy.value, [
      "cancellationPolicyId",
      "refundPolicyId",
      "refundGovernance",
    ])
  ) {
    return invalidProfile("configuration.afterSalePolicy");
  }
  const cancellationPolicyId = readIdentity(
    policy.value.cancellationPolicyId,
    "configuration.afterSalePolicy.cancellationPolicyId",
  );
  if (!cancellationPolicyId.ok) return cancellationPolicyId;
  const refundPolicyId = readIdentity(
    policy.value.refundPolicyId,
    "configuration.afterSalePolicy.refundPolicyId",
  );
  if (!refundPolicyId.ok) return refundPolicyId;
  const refundGovernance = parseRefundGovernancePolicy(
    policy.value.refundGovernance,
  );
  return refundGovernance.ok
    ? {
        ok: true,
        value: {
          cancellationPolicyId: cancellationPolicyId.value,
          refundPolicyId: refundPolicyId.value,
          refundGovernance: refundGovernance.value,
        },
      }
    : refundGovernance;
}

/** Every refund waits for a merchant approval. */
function parseRefundGovernancePolicy(
  raw: unknown,
): CheckoutProfileParseResult<CheckoutRefundGovernancePolicy> {
  const policy = readTaggedObject(
    raw,
    "configuration.afterSalePolicy.refundGovernance",
  );
  if (!policy.ok) return policy;
  if (policy.value.kind !== "approval_required")
    return invalidProfile(
      "configuration.afterSalePolicy.refundGovernance.kind",
    );
  return hasExactKeys(policy.value, ["kind"])
    ? { ok: true, value: { kind: "approval_required" } }
    : invalidProfile("configuration.afterSalePolicy.refundGovernance");
}

export function parseCheckoutPresentationPolicy(
  raw: unknown,
): CheckoutProfileParseResult<CheckoutPresentationPolicy> {
  const policy = readObject(raw, "configuration.presentationPolicy");
  if (!policy.ok) return policy;
  if (
    !hasExactKeys(policy.value, [
      "locale",
      "merchantDisplayName",
      "termsPolicyId",
      "privacyPolicyId",
      "supportContact",
    ])
  )
    return invalidProfile("configuration.presentationPolicy");
  const locale = readIdentity(
    policy.value.locale,
    "configuration.presentationPolicy.locale",
  );
  if (!locale.ok) return locale;
  const merchantDisplayName = readIdentity(
    policy.value.merchantDisplayName,
    "configuration.presentationPolicy.merchantDisplayName",
  );
  if (!merchantDisplayName.ok) return merchantDisplayName;
  const termsPolicyId = readIdentity(
    policy.value.termsPolicyId,
    "configuration.presentationPolicy.termsPolicyId",
  );
  if (!termsPolicyId.ok) return termsPolicyId;
  const privacyPolicyId = readIdentity(
    policy.value.privacyPolicyId,
    "configuration.presentationPolicy.privacyPolicyId",
  );
  if (!privacyPolicyId.ok) return privacyPolicyId;
  const supportContact = readIdentity(
    policy.value.supportContact,
    "configuration.presentationPolicy.supportContact",
  );
  return supportContact.ok
    ? {
        ok: true,
        value: {
          locale: locale.value,
          merchantDisplayName: merchantDisplayName.value,
          termsPolicyId: termsPolicyId.value,
          privacyPolicyId: privacyPolicyId.value,
          supportContact: supportContact.value,
        },
      }
    : supportContact;
}

function readObject(
  raw: unknown,
  field: string,
): CheckoutProfileParseResult<Record<string, unknown>> {
  return isRecord(raw) ? { ok: true, value: raw } : invalidProfile(field);
}

function readTaggedObject(
  raw: unknown,
  field: string,
): CheckoutProfileParseResult<Record<string, unknown> & { kind: string }> {
  return isTaggedObject(raw)
    ? { ok: true, value: raw }
    : invalidProfile(`${field}.kind`);
}

function readIdentity(
  raw: unknown,
  field: string,
): CheckoutProfileParseResult<string> {
  return typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= IDENTITY_MAX_LENGTH &&
    raw.trim() === raw
    ? { ok: true, value: raw }
    : invalidProfile(field);
}

function readCurrency(
  raw: unknown,
  field: string,
): CheckoutProfileParseResult<string> {
  return typeof raw === "string" && CURRENCY_PATTERN.test(raw)
    ? { ok: true, value: raw }
    : invalidProfile(field);
}

function readPositiveInteger(
  raw: unknown,
  field: string,
): CheckoutProfileParseResult<number> {
  return Number.isSafeInteger(raw) && Number(raw) > 0
    ? { ok: true, value: Number(raw) }
    : invalidProfile(field);
}

function readEnum<TValue extends string>(
  raw: unknown,
  field: string,
  values: readonly TValue[],
): CheckoutProfileParseResult<TValue> {
  if (typeof raw !== "string") return invalidProfile(field);
  for (const value of values) {
    if (raw === value) return { ok: true, value };
  }
  return invalidProfile(field);
}

function invalidProfile(field: string): CheckoutProfileParseResult<never> {
  return { ok: false, error: { code: "checkout_profile_invalid", field } };
}

function isTaggedObject(
  raw: unknown,
): raw is Record<string, unknown> & { kind: string } {
  return isRecord(raw) && typeof raw.kind === "string";
}
