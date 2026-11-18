import type {
  CheckoutProfileReference,
  CheckoutStoredValue,
  CountryCode,
  DutyIncoterm,
  ShippingQuoteSnapshot,
} from "@seams/commerce-contracts";
import {
  parseCreateBuyerCartCommandRecord,
  parseCreateBuyerPickupCheckoutCommandRecord,
  parseCreateBuyerSessionCommandRecord,
  parseCreateBuyerShippingCheckoutCommandRecord,
  parsePlaceBuyerStoredValueCheckoutCommandRecord,
  parseRefreshBuyerPickupCheckoutCommandRecord,
  parseRefreshBuyerShippingCheckoutCommandRecord,
  parseReplaceBuyerCartCommandRecord,
  parseCommerceBuyerSessionV4Record,
  parseValidateBuyerShippingAddressCommandRecord,
} from "@seams/commerce-contracts/records/api-storefront";
import {
  parseCommerceBuyerCartV1 as parseCommerceBuyerCartV1Record,
  parseCommerceBuyerCatalogSearchV1 as parseCommerceBuyerCatalogSearchV1Record,
  parseCommerceBuyerCatalogV1 as parseCommerceBuyerCatalogV1Record,
  parseCommerceBuyerCheckoutRecoveryV1 as parseCommerceBuyerCheckoutRecoveryV1Record,
  parseCommerceBuyerOrderV1 as parseCommerceBuyerOrderV1Record,
  parseCommerceBuyerPaymentResultV1 as parseCommerceBuyerPaymentResultV1Record,
  parseCommerceBuyerQuotedCheckoutV1 as parseCommerceBuyerQuotedCheckoutV1Record,
  parseCommerceBuyerQuotedShippingCheckoutV1 as parseCommerceBuyerQuotedShippingCheckoutV1Record,
  parseCommerceBuyerShippingAddressValidationV1 as parseCommerceBuyerShippingAddressValidationV1Record,
  parseCommerceDraftInvoiceCheckoutV1 as parseCommerceDraftInvoiceCheckoutV1Record,
  parseCommerceOrderBalanceCheckoutV1 as parseCommerceOrderBalanceCheckoutV1Record,
} from "@seams/commerce-contracts/records/api-storefront-responses";
import { decodeRecord } from "./entity-plane/record-decoding.ts";
import {
  parseCommerceShopNameV1,
  type CommerceShopNameV1,
} from "@seams/commerce-contracts/records/api-shop-names";
import { errorMessage } from "@seams/std";
import type { Variant } from "@seams/type-utils";
import {
  parseRequestBuyerReturnCommand,
  parseReturn,
  type RequestCommerceBuyerReturnV1,
  type CommerceReturnV1,
} from "./returns.ts";
import type { CommerceOrderBalanceCheckoutV1 } from "./order-edits.ts";
import {
  normalizeGiftCardCode,
  parseGiftCardBalance,
  type CommerceGiftCardBalanceV1,
} from "./stored-value.ts";

/** Places a quoted checkout that stored value pays in full. */
export type PlaceCommerceBuyerStoredValueCheckoutV1 = WireStorefront.PlaceCommerceBuyerStoredValueCheckoutV1;

export function parsePlaceBuyerStoredValueCheckoutCommand(value: unknown): PlaceCommerceBuyerStoredValueCheckoutV1 {
  return decodeRecord(parsePlaceBuyerStoredValueCheckoutCommandRecord, value);
}
import type { CommerceShippingCountry } from "./international-addresses.ts";
import {
  parseBuyerCollectionPage,
  parseBuyerCollections,
  type CommerceBuyerCollectionPageV1,
  type CommerceBuyerCollectionsV1,
  type CommerceCollectionPageFilterV1,
} from "./collections.ts";
import {
  parseBuyerCustomer,
  parseCustomerAccess,
  parseCustomerSignInChallenge,
  parseRequestCustomerSignInCommand,
  parseSaveCustomerAddressCommand,
  parseVerifyCustomerSignInCommand,
  type RequestCommerceCustomerSignInV1,
  type SaveCommerceCustomerAddressV1,
  type CommerceBuyerCustomerV1,
  type CommerceCustomerAccessV1,
  type CommerceCustomerSignInChallengeV1,
  type VerifyCommerceCustomerSignInV1,
} from "./customers.ts";
import type {
  CommerceEngineTimestamp,
  CommerceVariantV1,
} from "./commerce-resources.ts";
import {
  parseRejectedMutation,
  type CommerceClientResult,
  type CommerceFetch,
} from "./mutations.ts";
import {
  parseBuyerPaymentSession,
  type CreateCommerceBuyerPaymentSessionV1,
  type ReconcileCommerceBuyerPaymentV1,
  type CommerceBuyerPaymentSessionV1,
} from "./payment-session.ts";
import {
  readJsonResponse,
  requireBaseUrl,
  requireText,
  responseMessage,
} from "./wire-readers.ts";
import type * as WireStorefront from "@seams/commerce-contracts/records/api-storefront";

export type CreateCommerceBuyerSessionV1 = WireStorefront.CreateCommerceBuyerSessionV1;

export type CommerceBuyerSessionV4 = WireStorefront.CommerceBuyerSessionV4;

type CommerceDraftInvoiceCheckoutV1 = Readonly<{
  schemaVersion: "underclerk.draft-invoice-checkout.v1";
  session: Readonly<{ token: string; expiresAt: CommerceEngineTimestamp }>;
  checkout: CommerceBuyerQuotedCheckoutV1;
}>;

function parseDraftInvoiceCheckout(value: unknown): CommerceDraftInvoiceCheckoutV1 {
  return decodeRecord(parseCommerceDraftInvoiceCheckoutV1Record, value);
}

function parseOrderBalanceCheckout(value: unknown): CommerceOrderBalanceCheckoutV1 {
  return decodeRecord(parseCommerceOrderBalanceCheckoutV1Record, value);
}

export type CommerceBuyerCatalogListingV1 = Readonly<{
  productId: string;
  productRevision: number;
  title: string;
  description: string;
  variantId: string;
  variantRevision: number;
  variantTitle: string;
  sku: string;
  offerId: string;
  offerRevision: number;
  price: Readonly<{ amountMinor: number; currency: string }>;
  compareAtPrice: Readonly<{ amountMinor: number; currency: string }> | null;
  handle: string | null;
  options: CommerceVariantV1["options"];
  media: CommerceVariantV1["media"];
  availability: "available" | "unavailable";
}>;

/** The listings that match a storefront search, best first. */
export type CommerceBuyerCatalogSearchV1 = Readonly<{
  schemaVersion: "underclerk.buyer-catalog-search.v1";
  query: string;
  listings: readonly CommerceBuyerCatalogListingV1[];
}>;

type CommerceBuyerCatalogStorefrontBaseV1 = Readonly<{
  storefrontId: string;
  revision: number;
  name: string;
}>;

export type CommerceBuyerShippingServiceV1 = Readonly<{
  destinationCountry: CountryCode;
  service: Readonly<{ code: string; name: string }>;
  availability:
    | Readonly<{ state: "available"; recovery?: never }>
    | Readonly<{
        state: "temporarily_unavailable";
        recovery: "try_again_later";
      }>;
}>;

export type CommerceBuyerCatalogV1 = Readonly<{
  schemaVersion: "underclerk.buyer-catalog.v1";
  storefront:
    | (CommerceBuyerCatalogStorefrontBaseV1 &
        Readonly<{
          fulfillment: "pickup";
          shippingServices?: never;
        }>)
    | (CommerceBuyerCatalogStorefrontBaseV1 &
        Readonly<{
          fulfillment: "shipping";
          shippingServices: readonly CommerceBuyerShippingServiceV1[];
        }>);
  listings: readonly CommerceBuyerCatalogListingV1[];
  menus: readonly CommerceBuyerMenuV1[];
}>;

export type CommerceBuyerMenuV1 = Readonly<{
  menuId: string;
  revision: number;
  name: string;
  sections: readonly Readonly<{
    sectionId: string;
    name: string;
    position: number;
  }>[];
  entries: readonly CommerceBuyerMenuEntryV1[];
}>;

export type CommerceBuyerMenuEntryV1 = Readonly<{
  menuEntryId: string;
  sectionId: string;
  revision: number;
  variantId: string;
  variantRevision: number;
  offerId: string;
  offerRevision: number;
  price: Readonly<{ amountMinor: number; currency: string }>;
  /** The price before a deal, higher than `price`; null with no deal. */
  compareAtPrice: Readonly<{ amountMinor: number; currency: string }> | null;
  availability: "available" | "unavailable";
  consumptionPlanId: string;
  consumptionPlanRevision: number;
  modifierGroups: readonly CommerceBuyerModifierGroupV1[];
}>;

export type CommerceBuyerModifierGroupV1 = Readonly<{
  modifierGroupId: string;
  revision: number;
  name: string;
  minimumSelections: number;
  maximumSelections: number;
  options: readonly Readonly<{
    modifierOptionId: string;
    name: string;
    priceDelta: Readonly<{ amountMinor: number; currency: string }>;
  }>[];
}>;

export type CommerceBuyerCheckoutIdentityV1 = WireStorefront.CommerceBuyerCheckoutIdentityV1;

export type CommerceBuyerCartLineV1 = CommerceBuyerPickupCheckoutLineV1;

export type CreateCommerceBuyerCartV1 = WireStorefront.CreateCommerceBuyerCartV1;

export type ReplaceCommerceBuyerCartV1 = WireStorefront.ReplaceCommerceBuyerCartV1;

type CommerceBuyerCartBaseV1 = Readonly<{
  schemaVersion: "underclerk.buyer-cart.v1";
  cartId: string;
  revision: number;
  checkoutProfile: CheckoutProfileReference;
  fulfillment: "pickup" | "shipping";
  lines: readonly CommerceBuyerCartLineV1[];
}>;

export type CommerceBuyerCartV1 =
  | (CommerceBuyerCartBaseV1 &
      Readonly<{
        state: "active";
        checkoutId?: never;
      }>)
  | (CommerceBuyerCartBaseV1 &
      Readonly<{
        state: "submitted";
        checkoutId: string;
      }>);

export type CreateCommerceBuyerPickupCheckoutV1 = WireStorefront.CreateCommerceBuyerPickupCheckoutV1;


export type CreateCommerceBuyerShippingCheckoutV1 = WireStorefront.CreateCommerceBuyerShippingCheckoutV1;

export type RefreshCommerceBuyerPickupCheckoutV1 = WireStorefront.RefreshCommerceBuyerPickupCheckoutV1;

export type RefreshCommerceBuyerShippingCheckoutV1 = WireStorefront.RefreshCommerceBuyerShippingCheckoutV1;

export type CommerceBuyerShippingCheckoutLineV1 = WireStorefront.CommerceBuyerShippingCheckoutLineV1;

export type CommerceBuyerContactV1 = WireStorefront.CommerceBuyerContactV1;

export type CommerceBuyerShippingAddressV1 = WireStorefront.CommerceBuyerShippingAddressV1;

export type CommerceBuyerShippingDestinationV1 = WireStorefront.CommerceBuyerShippingDestinationV1;

export type CommerceBuyerShippingAddressAcceptanceV1 = WireStorefront.CommerceBuyerShippingAddressAcceptanceV1;

export type ValidateCommerceBuyerShippingAddressV1 = WireStorefront.ValidateCommerceBuyerShippingAddressV1;

type CommerceBuyerShippingAddressValidationBaseV1 = Readonly<{
  schemaVersion: "underclerk.buyer-shipping-address-validation.v1";
  validationReference: string;
  expiresAt: CommerceEngineTimestamp;
}>;

export type CommerceBuyerShippingAddressValidationV1 =
  | (CommerceBuyerShippingAddressValidationBaseV1 &
      Readonly<{
        state: "accepted";
        address: CommerceBuyerShippingAddressV1;
        proposedAddress?: never;
        reason?: never;
        retryAfter?: never;
      }>)
  | (CommerceBuyerShippingAddressValidationBaseV1 &
      Readonly<{
        state: "correction_required";
        proposedAddress: CommerceBuyerShippingAddressV1;
        address?: never;
        reason?: never;
        retryAfter?: never;
      }>)
  | (CommerceBuyerShippingAddressValidationBaseV1 &
      Readonly<{
        state: "unserviceable";
        reason: string;
        address?: never;
        proposedAddress?: never;
        retryAfter?: never;
      }>)
  | (CommerceBuyerShippingAddressValidationBaseV1 &
      Readonly<{
        state: "indeterminate";
        retryAfter: CommerceEngineTimestamp;
        address?: never;
        proposedAddress?: never;
        reason?: never;
      }>);

export type CommerceBuyerPickupCheckoutLineV1 = WireStorefront.CommerceBuyerPickupCheckoutLineV1;

export type CommerceBuyerQuotedCheckoutV1 = Readonly<{
  schemaVersion: "underclerk.buyer-quoted-checkout.v1";
  checkoutId: string;
  revision: number;
  state: "quoted";
  quote: Readonly<{
    quoteDigest: string;
    lines: readonly CommerceBuyerQuotedCheckoutLineV1[];
    totals: Readonly<{
      subtotal: Readonly<{ amountMinor: number; currency: string }>;
      tax: Readonly<{ amountMinor: number; currency: string }>;
      duty: Readonly<{ amountMinor: number; currency: string }>;
      shipping: Readonly<{ amountMinor: number; currency: string }>;
      total: Readonly<{ amountMinor: number; currency: string }>;
      discount?: Readonly<{ amountMinor: number; currency: string }>;
      /** The listed prices include the tax, so the total does not add it. */
      taxIncluded?: true;
    }>;
    pickup: Readonly<{ locationId: string; readyAt: CommerceEngineTimestamp }>;
    expiresAt: CommerceEngineTimestamp;
    /** Gift cards and store credit that pay; `due` is left for the card. */
    storedValue?: CheckoutStoredValue;
  }>;
}>;

export type CommerceBuyerShippingChargeAllocationV1 = Readonly<{
  checkoutLineId: string;
  amount: Readonly<{ amountMinor: number; currency: string }>;
}>;

export type CommerceBuyerCarrierQuoteV1 = Readonly<{
  rateReference: string;
  shippingAmount: Readonly<{ amountMinor: number; currency: string }>;
  lineAllocations: readonly CommerceBuyerShippingChargeAllocationV1[];
}>;

export type CommerceBuyerTaxQuoteV1 = Readonly<{
  registrationPolicyReference: string;
  quoteReference: string;
  taxAmount: Readonly<{ amountMinor: number; currency: string }>;
  lineAllocations: readonly CommerceBuyerShippingChargeAllocationV1[];
}>;

export type CommerceBuyerDutyQuoteV1 = Readonly<{
  quoteReference: string;
  incoterm: DutyIncoterm;
  dutyAmount: Readonly<{ amountMinor: number; currency: string }>;
  lineAllocations: readonly CommerceBuyerShippingChargeAllocationV1[];
}>;

export type CommerceBuyerQuotedShippingCheckoutV1 = Readonly<{
  schemaVersion: "underclerk.buyer-quoted-shipping-checkout.v1";
  checkoutId: string;
  revision: number;
  state: "quoted";
  quote: Readonly<{
    quoteDigest: string;
    lines: readonly Variant<CommerceBuyerQuotedCheckoutLineV1, "catalog">[];
    totals: Readonly<{
      subtotal: Readonly<{ amountMinor: number; currency: string }>;
      tax: Readonly<{ amountMinor: number; currency: string }>;
      duty: Readonly<{ amountMinor: number; currency: string }>;
      shipping: Readonly<{ amountMinor: number; currency: string }>;
      total: Readonly<{ amountMinor: number; currency: string }>;
      discount?: Readonly<{ amountMinor: number; currency: string }>;
      /** The listed prices include the tax, so the total does not add it. */
      taxIncluded?: true;
    }>;
    shipping: Readonly<{
      addressValidationReference: string;
      service: Readonly<{ code: string; name: string }>;
      destinationCountry: CommerceShippingCountry;
      dutyTerms: Readonly<{
        incoterm: DutyIncoterm;
      }>;
      estimatedDelivery: Readonly<{
        kind: "window";
        earliest: CommerceEngineTimestamp;
        latest: CommerceEngineTimestamp;
      }>;
      carrierQuote: CommerceBuyerCarrierQuoteV1;
      taxQuote: CommerceBuyerTaxQuoteV1;
      dutyQuote: CommerceBuyerDutyQuoteV1;
      packagePlan: ShippingQuoteSnapshot["packagePlan"];
    }>;
    expiresAt: CommerceEngineTimestamp;
    /** Gift cards and store credit that pay; `due` is left for the card. */
    storedValue?: CheckoutStoredValue;
    /**
     * The buyer's market. The totals are in its currency; the carrier, tax
     * and duty quotes stay in the shop currency, and each total is its quote
     * converted at the rate with the market's rounding.
     */
    market?: CommerceBuyerShippingMarketV1;
  }>;
}>;

export type CommerceBuyerShippingMarketV1 = Readonly<{
  marketId: string;
  currency: string;
  shopCurrency: string;
  rate: string;
  roundingIncrement: number;
}>;

export type CommerceBuyerRecoverableCheckoutV1 =
  CommerceBuyerQuotedCheckoutV1 | CommerceBuyerQuotedShippingCheckoutV1;

export type CommerceBuyerCheckoutPaymentProgressV1 =
  | Readonly<{ state: "pending"; paymentAttemptId: string }>
  | Readonly<{ state: "captured"; paymentAttemptId: string }>
  | Readonly<{
      state: "declined";
      paymentAttemptId: string;
      reasonCode: string;
    }>
  | Readonly<{
      state: "processing";
      paymentAttemptId: string;
      reconcileAfter: CommerceEngineTimestamp;
    }>
  | Readonly<{
      state: "indeterminate";
      paymentAttemptId: string;
      reconcileAfter: CommerceEngineTimestamp;
    }>;

export type CommerceBuyerCheckoutRecoveryV1 = Readonly<{
  schemaVersion: "underclerk.buyer-checkout-recovery.v1";
  checkout: CommerceBuyerRecoverableCheckoutV1;
  progress:
    | Readonly<{ state: "quoted"; payment?: never }>
    | Readonly<{
        state: "payment_pending";
        payment: CommerceBuyerCheckoutPaymentProgressV1;
      }>;
}>;

export type CommerceBuyerQuotedCheckoutLineV1 =
  | Readonly<{
      kind: "catalog";
      checkoutLineId: string;
      variantId: string;
      quantity: number;
      unitPrice: Readonly<{ amountMinor: number; currency: string }>;
      lineTotal: Readonly<{ amountMinor: number; currency: string }>;
      /** Discounts taken from this line; the line total is net of them. */
      discount?: Readonly<{ amountMinor: number; currency: string }>;
    }>
  | Readonly<{
      kind: "menu";
      checkoutLineId: string;
      menuId: string;
      variantId: string;
      menuEntryId: string;
      modifierOptionIds: readonly string[];
      quantity: number;
      unitPrice: Readonly<{ amountMinor: number; currency: string }>;
      lineTotal: Readonly<{ amountMinor: number; currency: string }>;
      discount?: Readonly<{ amountMinor: number; currency: string }>;
    }>
  | Readonly<{
      /** The amount that an edited order still owes. */
      kind: "order_balance";
      checkoutLineId: string;
      orderId: string;
      quantity: number;
      unitPrice: Readonly<{ amountMinor: number; currency: string }>;
      lineTotal: Readonly<{ amountMinor: number; currency: string }>;
    }>;

export type CommerceBuyerOrderRecoveryV1 = Readonly<{
  token: string;
  expiresAt: CommerceEngineTimestamp;
}>;

export type CommerceBuyerPaymentResultV1 =
  | Readonly<{
      schemaVersion: "underclerk.buyer-payment-result.v1";
      state: "placed";
      checkoutId: string;
      checkoutRevision: number;
      orderId: string;
      paymentId: string;
      fulfillmentId: string;
      orderRecovery: CommerceBuyerOrderRecoveryV1;
      placedAt: CommerceEngineTimestamp;
      total: Readonly<{ amountMinor: number; currency: string }>;
      pickup: Readonly<{ locationId: string; expectedBy: CommerceEngineTimestamp }>;
      shipping?: never;
      shipmentId?: never;
    }>
  | Readonly<{
      schemaVersion: "underclerk.buyer-payment-result.v1";
      state: "placed";
      checkoutId: string;
      checkoutRevision: number;
      orderId: string;
      paymentId: string;
      fulfillmentId: string;
      shipmentId: string;
      orderRecovery: CommerceBuyerOrderRecoveryV1;
      placedAt: CommerceEngineTimestamp;
      total: Readonly<{ amountMinor: number; currency: string }>;
      shipping: Readonly<{
        destinationCountry: CountryCode;
        estimatedDelivery: ShippingQuoteSnapshot["estimatedDelivery"];
      }>;
      pickup?: never;
    }>
  | Readonly<{
      schemaVersion: "underclerk.buyer-payment-result.v1";
      state: "declined";
      checkoutId: string;
      reasonCode: string;
    }>
  | Readonly<{
      schemaVersion: "underclerk.buyer-payment-result.v1";
      state: "processing";
      checkoutId: string;
      reconcileAfter: CommerceEngineTimestamp;
    }>
  | Readonly<{
      schemaVersion: "underclerk.buyer-payment-result.v1";
      state: "indeterminate";
      checkoutId: string;
      reconcileAfter: CommerceEngineTimestamp;
    }>;

type CommerceBuyerOrderBaseV1 = Readonly<{
  schemaVersion: "underclerk.buyer-order.v1";
  checkoutId: string;
  orderId: string;
  paymentId: string;
  fulfillmentId: string;
  placedAt: CommerceEngineTimestamp;
  total: Readonly<{ amountMinor: number; currency: string }>;
  paymentDisputes: readonly CommerceBuyerPaymentDisputeStatusV1[];
}>;

export type CommerceBuyerRefundStatusV1 =
  | Readonly<{
      state: "pending";
      amount: Readonly<{ amountMinor: number; currency: string }>;
      refundedAt?: never;
    }>
  | Readonly<{
      state: "refunded";
      amount: Readonly<{ amountMinor: number; currency: string }>;
      refundedAt: CommerceEngineTimestamp;
    }>
  | Readonly<{
      state: "failed";
      amount: Readonly<{ amountMinor: number; currency: string }>;
      refundedAt?: never;
    }>;

type CommerceBuyerPaymentDisputeBaseV1 = Readonly<{
  disputeId: string;
  amount: Readonly<{ amountMinor: number; currency: string }>;
  orderId?: never;
  paymentId?: never;
  revision?: never;
  providerPaymentReference?: never;
  providerDisputeReference?: never;
  reason?: never;
  evidenceReferences?: never;
  responseDueAt?: never;
  checkoutId?: never;
  paymentAttemptId?: never;
  providerDeliveryId?: never;
  organisationId?: never;
  merchantId?: never;
}>;

export type CommerceBuyerPaymentDisputeStatusV1 =
  | (CommerceBuyerPaymentDisputeBaseV1 &
      Readonly<{
        state: "action_required";
        observedAt: CommerceEngineTimestamp;
        resolvedAt?: never;
      }>)
  | (CommerceBuyerPaymentDisputeBaseV1 &
      Readonly<{
        state: "under_review";
        observedAt: CommerceEngineTimestamp;
        resolvedAt?: never;
      }>)
  | (CommerceBuyerPaymentDisputeBaseV1 &
      Readonly<{
        state: "won";
        resolvedAt: CommerceEngineTimestamp;
        observedAt?: never;
      }>)
  | (CommerceBuyerPaymentDisputeBaseV1 &
      Readonly<{
        state: "lost";
        resolvedAt: CommerceEngineTimestamp;
        observedAt?: never;
      }>);

type CommerceBuyerUncancelledOrderV1 = Readonly<{
  cancelledAt?: never;
  refund?: never;
}>;

export type CommerceBuyerOrderV1 =
  | (CommerceBuyerOrderBaseV1 &
      CommerceBuyerUncancelledOrderV1 &
      Readonly<{
        fulfillment: "pickup";
        pickup: Readonly<{
          locationId: string;
          expectedBy: CommerceEngineTimestamp;
        }>;
        shipping?: never;
        shipmentId?: never;
        state: "placed";
      }>)
  | (CommerceBuyerOrderBaseV1 &
      CommerceBuyerUncancelledOrderV1 &
      Readonly<{
        fulfillment: "pickup";
        pickup: Readonly<{
          locationId: string;
          expectedBy: CommerceEngineTimestamp;
        }>;
        shipping?: never;
        shipmentId?: never;
        state: "ready_for_pickup";
        readyAt: CommerceEngineTimestamp;
      }>)
  | (CommerceBuyerOrderBaseV1 &
      CommerceBuyerUncancelledOrderV1 &
      Readonly<{
        fulfillment: "pickup";
        pickup: Readonly<{
          locationId: string;
          expectedBy: CommerceEngineTimestamp;
        }>;
        shipping?: never;
        shipmentId?: never;
        state: "completed";
        completedAt: CommerceEngineTimestamp;
      }>)
  | (CommerceBuyerOrderBaseV1 &
      Readonly<{
        fulfillment: "pickup";
        pickup: Readonly<{
          locationId: string;
          expectedBy: CommerceEngineTimestamp;
        }>;
        shipping?: never;
        shipmentId?: never;
        state: "cancelled";
        cancelledAt: CommerceEngineTimestamp;
        refund: CommerceBuyerRefundStatusV1;
        readyAt?: never;
        completedAt?: never;
      }>)
  | (CommerceBuyerOrderBaseV1 &
      CommerceBuyerUncancelledOrderV1 &
      Readonly<{
        fulfillment: "shipping";
        state: "ready";
        shipmentId: string;
        shipping: Readonly<{
          destinationCountry: CountryCode;
          estimatedDelivery: ShippingQuoteSnapshot["estimatedDelivery"];
        }>;
        pickup?: never;
        readyAt?: never;
        completedAt?: never;
        trackingNumber?: never;
        purchasedAt?: never;
        handedOverAt?: never;
        deliveredAt?: never;
      }>)
  | (CommerceBuyerOrderBaseV1 &
      CommerceBuyerUncancelledOrderV1 &
      Readonly<{
        fulfillment: "shipping";
        state: "label_purchased";
        shipmentId: string;
        trackingNumber: string;
        purchasedAt: CommerceEngineTimestamp;
        shipping: Readonly<{
          destinationCountry: CountryCode;
          estimatedDelivery: ShippingQuoteSnapshot["estimatedDelivery"];
        }>;
        pickup?: never;
        readyAt?: never;
        completedAt?: never;
        handedOverAt?: never;
        deliveredAt?: never;
      }>)
  | (CommerceBuyerOrderBaseV1 &
      CommerceBuyerUncancelledOrderV1 &
      Readonly<{
        fulfillment: "shipping";
        state: "in_transit";
        shipmentId: string;
        trackingNumber: string;
        handedOverAt: CommerceEngineTimestamp;
        shipping: Readonly<{
          destinationCountry: CountryCode;
          estimatedDelivery: ShippingQuoteSnapshot["estimatedDelivery"];
        }>;
        pickup?: never;
        readyAt?: never;
        completedAt?: never;
        purchasedAt?: never;
        deliveredAt?: never;
      }>)
  | (CommerceBuyerOrderBaseV1 &
      CommerceBuyerUncancelledOrderV1 &
      Readonly<{
        fulfillment: "shipping";
        state: "delivered";
        shipmentId: string;
        trackingNumber: string;
        handedOverAt: CommerceEngineTimestamp;
        deliveredAt: CommerceEngineTimestamp;
        shipping: Readonly<{
          destinationCountry: CountryCode;
          estimatedDelivery: ShippingQuoteSnapshot["estimatedDelivery"];
        }>;
        pickup?: never;
        readyAt?: never;
        completedAt?: never;
        purchasedAt?: never;
      }>);

export type CommerceStorefrontClientConfig = Readonly<{
  baseUrl: string;
  fetch?: CommerceFetch;
}>;

export class CommerceStorefrontClient {
  readonly #baseUrl: string;
  readonly #fetch: CommerceFetch;

  constructor(config: CommerceStorefrontClientConfig) {
    this.#baseUrl = requireBaseUrl(config.baseUrl);
    this.#fetch = (config.fetch ?? globalThis.fetch).bind(globalThis);
  }

  /** The storefront that a shop name opens (Plan 40B phase 2). */
  async readShopName(
    name: string,
  ): Promise<CommerceClientResult<CommerceShopNameV1>> {
    return this.#request(
      `/v1/public/shop-names/${encodeURIComponent(requireText(name, "name"))}`,
      { method: "GET" },
      parseShopName,
    );
  }

  async createSession(
    merchantId: string,
    storefrontId: string,
    command: CreateCommerceBuyerSessionV1,
  ): Promise<CommerceClientResult<CommerceBuyerSessionV4>> {
    return this.#request(
      publicStorefrontPath(merchantId, storefrontId, "/sessions"),
      {
        method: "POST",
        body: JSON.stringify(parseCreateBuyerSessionCommand(command)),
      },
      parseCommerceBuyerSessionV4,
    );
  }

  async listCollections(
    merchantId: string,
    storefrontId: string,
    sessionToken: string,
  ): Promise<CommerceClientResult<CommerceBuyerCollectionsV1>> {
    return this.#request(
      publicStorefrontPath(merchantId, storefrontId, "/collections"),
      { method: "GET", sessionToken: requireText(sessionToken, "sessionToken") },
      parseBuyerCollections,
    );
  }

  /** One page of a collection's products, in the collection's order. */
  async readCollection(
    merchantId: string,
    storefrontId: string,
    handle: string,
    sessionToken: string,
    filter: CommerceCollectionPageFilterV1 = {},
  ): Promise<CommerceClientResult<CommerceBuyerCollectionPageV1>> {
    const query = new URLSearchParams();
    if (filter.after !== undefined) query.set("after", filter.after);
    if (filter.limit !== undefined) query.set("limit", String(filter.limit));
    if (filter.tag !== undefined) query.set("tag", filter.tag);
    if (filter.minimumPrice !== undefined)
      query.set("minimumPrice", String(filter.minimumPrice));
    if (filter.maximumPrice !== undefined)
      query.set("maximumPrice", String(filter.maximumPrice));
    if (filter.availableOnly === true) query.set("availableOnly", "true");
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/collections/${encodeURIComponent(requireText(handle, "handle"))}${suffix}`,
      ),
      { method: "GET", sessionToken: requireText(sessionToken, "sessionToken") },
      parseBuyerCollectionPage,
    );
  }

  /** Sends a one-time sign-in code to the email address. */
  async requestCustomerSignIn(
    merchantId: string,
    storefrontId: string,
    command: RequestCommerceCustomerSignInV1,
  ): Promise<CommerceClientResult<CommerceCustomerSignInChallengeV1>> {
    return this.#request(
      publicStorefrontPath(merchantId, storefrontId, "/customer-sign-ins"),
      {
        method: "POST",
        body: JSON.stringify(parseRequestCustomerSignInCommand(command)),
      },
      parseCustomerSignInChallenge,
    );
  }

  async verifyCustomerSignIn(
    merchantId: string,
    storefrontId: string,
    challengeId: string,
    command: VerifyCommerceCustomerSignInV1,
  ): Promise<CommerceClientResult<CommerceCustomerAccessV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/customer-sign-ins/${encodeURIComponent(requireText(challengeId, "challengeId"))}/verification`,
      ),
      {
        method: "POST",
        body: JSON.stringify(parseVerifyCustomerSignInCommand(command)),
      },
      parseCustomerAccess,
    );
  }

  async readCustomer(
    merchantId: string,
    storefrontId: string,
    customerAccessToken: string,
  ): Promise<CommerceClientResult<CommerceBuyerCustomerV1>> {
    return this.#request(
      publicStorefrontPath(merchantId, storefrontId, "/customer"),
      {
        method: "GET",
        sessionToken: requireText(customerAccessToken, "customerAccessToken"),
      },
      parseBuyerCustomer,
    );
  }

  async saveCustomerAddress(
    merchantId: string,
    storefrontId: string,
    customerAccessToken: string,
    command: SaveCommerceCustomerAddressV1,
  ): Promise<CommerceClientResult<CommerceBuyerCustomerV1>> {
    return this.#request(
      publicStorefrontPath(merchantId, storefrontId, "/customer/addresses"),
      {
        method: "POST",
        sessionToken: requireText(customerAccessToken, "customerAccessToken"),
        body: JSON.stringify(parseSaveCustomerAddressCommand(command)),
      },
      parseBuyerCustomer,
    );
  }

  async readCatalog(
    merchantId: string,
    storefrontId: string,
    sessionToken: string,
  ): Promise<CommerceClientResult<CommerceBuyerCatalogV1>> {
    return this.#request(
      publicStorefrontPath(merchantId, storefrontId, "/catalog"),
      {
        method: "GET",
        sessionToken: requireText(sessionToken, "sessionToken"),
      },
      parseBuyerCatalog,
    );
  }

  async searchCatalog(
    merchantId: string,
    storefrontId: string,
    sessionToken: string,
    query: string,
    limit?: number,
  ): Promise<CommerceClientResult<CommerceBuyerCatalogSearchV1>> {
    const search = new URLSearchParams({ q: query });
    if (limit !== undefined) search.set("limit", String(limit));
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/catalog/search?${search.toString()}`,
      ),
      {
        method: "GET",
        sessionToken: requireText(sessionToken, "sessionToken"),
      },
      parseBuyerCatalogSearch,
    );
  }

  async createCart(
    merchantId: string,
    storefrontId: string,
    sessionToken: string,
    command: CreateCommerceBuyerCartV1,
  ): Promise<CommerceClientResult<CommerceBuyerCartV1>> {
    return this.#request(
      publicStorefrontPath(merchantId, storefrontId, "/carts"),
      {
        method: "POST",
        sessionToken: requireText(sessionToken, "sessionToken"),
        body: JSON.stringify(parseCreateBuyerCartCommand(command)),
      },
      parseBuyerCart,
    );
  }

  async readCart(
    merchantId: string,
    storefrontId: string,
    cartId: string,
    sessionToken: string,
  ): Promise<CommerceClientResult<CommerceBuyerCartV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/carts/${encodeURIComponent(requireText(cartId, "cartId"))}`,
      ),
      {
        method: "GET",
        sessionToken: requireText(sessionToken, "sessionToken"),
      },
      parseBuyerCart,
    );
  }

  async readCheckout(
    merchantId: string,
    storefrontId: string,
    checkoutId: string,
    sessionToken: string,
  ): Promise<CommerceClientResult<CommerceBuyerCheckoutRecoveryV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/checkouts/${encodeURIComponent(requireText(checkoutId, "checkoutId"))}`,
      ),
      {
        method: "GET",
        sessionToken: requireText(sessionToken, "sessionToken"),
      },
      parseBuyerCheckoutRecovery,
    );
  }

  async replaceCart(
    merchantId: string,
    storefrontId: string,
    cartId: string,
    sessionToken: string,
    command: ReplaceCommerceBuyerCartV1,
  ): Promise<CommerceClientResult<CommerceBuyerCartV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/carts/${encodeURIComponent(requireText(cartId, "cartId"))}`,
      ),
      {
        method: "PUT",
        sessionToken: requireText(sessionToken, "sessionToken"),
        body: JSON.stringify(parseReplaceBuyerCartCommand(command)),
      },
      parseBuyerCart,
    );
  }

  async createPickupCheckout(
    merchantId: string,
    storefrontId: string,
    sessionToken: string,
    command: CreateCommerceBuyerPickupCheckoutV1,
  ): Promise<CommerceClientResult<CommerceBuyerQuotedCheckoutV1>> {
    return this.#request(
      publicStorefrontPath(merchantId, storefrontId, "/checkouts"),
      {
        method: "POST",
        sessionToken: requireText(sessionToken, "sessionToken"),
        body: JSON.stringify(parseCreateBuyerPickupCheckoutCommand(command)),
      },
      parseBuyerQuotedCheckout,
    );
  }

  /**
   * Opens a draft order invoice: the invoice token buys a buyer session and a
   * checkout at the staff prices. Opening it again returns the same checkout.
   */
  async openDraftInvoice(
    merchantId: string,
    storefrontId: string,
    draftOrderId: string,
    invoiceToken: string,
  ): Promise<CommerceClientResult<CommerceDraftInvoiceCheckoutV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/draft-orders/${encodeURIComponent(requireText(draftOrderId, "draftOrderId"))}/checkouts`,
      ),
      {
        method: "POST",
        sessionToken: requireText(invoiceToken, "invoiceToken"),
        body: "{}",
      },
      parseDraftInvoiceCheckout,
    );
  }

  /** Asks to return fulfilled lines of an order, with its recovery token. */
  async requestReturn(
    merchantId: string,
    storefrontId: string,
    checkoutId: string,
    orderRecoveryToken: string,
    command: RequestCommerceBuyerReturnV1,
  ): Promise<CommerceClientResult<CommerceReturnV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/checkouts/${encodeURIComponent(requireText(checkoutId, "checkoutId"))}/order/returns`,
      ),
      {
        method: "POST",
        sessionToken: requireText(orderRecoveryToken, "orderRecoveryToken"),
        body: JSON.stringify(parseRequestBuyerReturnCommand(command)),
      },
      parseReturn,
    );
  }

  /**
   * Opens a checkout for what an edited order still owes, with the order's
   * recovery token. The session it returns pays that checkout.
   */
  async openOrderBalance(
    merchantId: string,
    storefrontId: string,
    checkoutId: string,
    orderRecoveryToken: string,
  ): Promise<CommerceClientResult<CommerceOrderBalanceCheckoutV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/checkouts/${encodeURIComponent(requireText(checkoutId, "checkoutId"))}/order/balance-checkouts`,
      ),
      {
        method: "POST",
        sessionToken: requireText(orderRecoveryToken, "orderRecoveryToken"),
        body: JSON.stringify({
          schemaVersion: "underclerk.open-buyer-order-balance.v1",
        }),
      },
      parseOrderBalanceCheckout,
    );
  }

  async createShippingCheckout(
    merchantId: string,
    storefrontId: string,
    sessionToken: string,
    command: CreateCommerceBuyerShippingCheckoutV1,
  ): Promise<CommerceClientResult<CommerceBuyerQuotedShippingCheckoutV1>> {
    return this.#request(
      publicStorefrontPath(merchantId, storefrontId, "/checkouts"),
      {
        method: "POST",
        sessionToken: requireText(sessionToken, "sessionToken"),
        body: JSON.stringify(parseCreateBuyerShippingCheckoutCommand(command)),
      },
      parseBuyerQuotedShippingCheckout,
    );
  }

  async validateShippingAddress(
    merchantId: string,
    storefrontId: string,
    sessionToken: string,
    command: ValidateCommerceBuyerShippingAddressV1,
  ): Promise<
    CommerceClientResult<CommerceBuyerShippingAddressValidationV1>
  > {
    return this.#request(
      publicStorefrontPath(merchantId, storefrontId, "/address-validations"),
      {
        method: "POST",
        sessionToken: requireText(sessionToken, "sessionToken"),
        body: JSON.stringify(parseValidateBuyerShippingAddressCommand(command)),
      },
      parseBuyerShippingAddressValidation,
    );
  }

  async refreshPickupCheckout(
    merchantId: string,
    storefrontId: string,
    checkoutId: string,
    sessionToken: string,
    command: RefreshCommerceBuyerPickupCheckoutV1,
  ): Promise<CommerceClientResult<CommerceBuyerQuotedCheckoutV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/checkouts/${encodeURIComponent(requireText(checkoutId, "checkoutId"))}/refresh`,
      ),
      {
        method: "POST",
        sessionToken: requireText(sessionToken, "sessionToken"),
        body: JSON.stringify(parseRefreshBuyerPickupCheckoutCommand(command)),
      },
      parseBuyerQuotedCheckout,
    );
  }

  async refreshShippingCheckout(
    merchantId: string,
    storefrontId: string,
    checkoutId: string,
    sessionToken: string,
    command: RefreshCommerceBuyerShippingCheckoutV1,
  ): Promise<CommerceClientResult<CommerceBuyerQuotedShippingCheckoutV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/checkouts/${encodeURIComponent(requireText(checkoutId, "checkoutId"))}/refresh`,
      ),
      {
        method: "POST",
        sessionToken: requireText(sessionToken, "sessionToken"),
        body: JSON.stringify(parseRefreshBuyerShippingCheckoutCommand(command)),
      },
      parseBuyerQuotedShippingCheckout,
    );
  }

  async createPaymentSession(
    merchantId: string,
    storefrontId: string,
    checkoutId: string,
    sessionToken: string,
    command: CreateCommerceBuyerPaymentSessionV1,
  ): Promise<CommerceClientResult<CommerceBuyerPaymentSessionV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/checkouts/${encodeURIComponent(requireText(checkoutId, "checkoutId"))}/payment-sessions`,
      ),
      {
        method: "POST",
        sessionToken: requireText(sessionToken, "sessionToken"),
        body: JSON.stringify(command),
      },
      parseBuyerPaymentSession,
    );
  }

  /** The balance of a gift card; the code goes in the body, never the URL. */
  async readGiftCardBalance(
    merchantId: string,
    storefrontId: string,
    sessionToken: string,
    code: string,
  ): Promise<CommerceClientResult<CommerceGiftCardBalanceV1>> {
    return this.#request(
      publicStorefrontPath(merchantId, storefrontId, "/gift-card-balances"),
      {
        method: "POST",
        sessionToken: requireText(sessionToken, "sessionToken"),
        body: JSON.stringify({ code: normalizeGiftCardCode(code, "code") }),
      },
      parseGiftCardBalance,
    );
  }

  /**
   * Places a checkout that gift cards and store credit pay in full; one with
   * an amount due pays through a payment session instead.
   */
  async placeStoredValueCheckout(
    merchantId: string,
    storefrontId: string,
    checkoutId: string,
    sessionToken: string,
    command: PlaceCommerceBuyerStoredValueCheckoutV1,
  ): Promise<CommerceClientResult<CommerceBuyerPaymentResultV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/checkouts/${encodeURIComponent(requireText(checkoutId, "checkoutId"))}/stored-value-placement`,
      ),
      {
        method: "POST",
        sessionToken: requireText(sessionToken, "sessionToken"),
        body: JSON.stringify(command),
      },
      parseBuyerPaymentResult,
    );
  }

  async reconcilePayment(
    merchantId: string,
    storefrontId: string,
    checkoutId: string,
    sessionToken: string,
    command: ReconcileCommerceBuyerPaymentV1,
  ): Promise<CommerceClientResult<CommerceBuyerPaymentResultV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/checkouts/${encodeURIComponent(requireText(checkoutId, "checkoutId"))}/reconcile`,
      ),
      {
        method: "POST",
        sessionToken: requireText(sessionToken, "sessionToken"),
        body: JSON.stringify(command),
      },
      parseBuyerPaymentResult,
    );
  }

  async readOrder(
    merchantId: string,
    storefrontId: string,
    checkoutId: string,
    sessionToken: string,
  ): Promise<CommerceClientResult<CommerceBuyerOrderV1>> {
    return this.#request(
      publicStorefrontPath(
        merchantId,
        storefrontId,
        `/checkouts/${encodeURIComponent(requireText(checkoutId, "checkoutId"))}/order`,
      ),
      {
        method: "GET",
        sessionToken: requireText(sessionToken, "sessionToken"),
      },
      parseBuyerOrder,
    );
  }

  async recoverOrder(
    merchantId: string,
    storefrontId: string,
    checkoutId: string,
    recoveryToken: string,
  ): Promise<CommerceClientResult<CommerceBuyerOrderV1>> {
    return this.readOrder(merchantId, storefrontId, checkoutId, recoveryToken);
  }

  async #request<T>(
    path: string,
    init: Readonly<{
      method: "GET" | "POST" | "PUT" | "DELETE";
      sessionToken?: string;
      body?: string;
    }>,
    parse: (value: unknown) => T,
  ): Promise<CommerceClientResult<T>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: init.method,
        headers: {
          ...(init.sessionToken === undefined
            ? {}
            : { authorization: `Bearer ${init.sessionToken}` }),
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
    } catch (error) {
      return {
        ok: false,
        error: { kind: "network", message: errorMessage(error) },
      };
    }
    const body = await readJsonResponse(response);
    if (!response.ok) {
      const rejection = parseRejectedMutation(response.status, body);
      if (rejection !== undefined) return { ok: false, error: rejection };
      return {
        ok: false,
        error: {
          kind: "http",
          status: response.status,
          message: responseMessage(body),
        },
      };
    }
    try {
      return { ok: true, value: parse(body) };
    } catch (error) {
      return {
        ok: false,
        error: { kind: "invalid_response", message: errorMessage(error) },
      };
    }
  }
}

function publicStorefrontPath(
  merchantId: string,
  storefrontId: string,
  suffix: string,
): string {
  return (
    `/v1/public/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}` +
    `/storefronts/${encodeURIComponent(requireText(storefrontId, "storefrontId"))}${suffix}`
  );
}

export function parseCreateBuyerSessionCommand(value: unknown): CreateCommerceBuyerSessionV1 {
  return decodeRecord(parseCreateBuyerSessionCommandRecord, value);
}

export function parseCommerceBuyerSessionV4(value: unknown): CommerceBuyerSessionV4 {
  return decodeRecord(parseCommerceBuyerSessionV4Record, value);
}

function parseBuyerCatalogSearch(value: unknown): CommerceBuyerCatalogSearchV1 {
  return decodeRecord(parseCommerceBuyerCatalogSearchV1Record, value);
}

function parseBuyerCatalog(value: unknown): CommerceBuyerCatalogV1 {
  return decodeRecord(parseCommerceBuyerCatalogV1Record, value);
}

export function parseCreateBuyerPickupCheckoutCommand(value: unknown): CreateCommerceBuyerPickupCheckoutV1 {
  return decodeRecord(parseCreateBuyerPickupCheckoutCommandRecord, value);
}

export function parseCreateBuyerCartCommand(value: unknown): CreateCommerceBuyerCartV1 {
  return decodeRecord(parseCreateBuyerCartCommandRecord, value);
}

export function parseReplaceBuyerCartCommand(value: unknown): ReplaceCommerceBuyerCartV1 {
  return decodeRecord(parseReplaceBuyerCartCommandRecord, value);
}

export function parseCreateBuyerShippingCheckoutCommand(value: unknown): CreateCommerceBuyerShippingCheckoutV1 {
  return decodeRecord(parseCreateBuyerShippingCheckoutCommandRecord, value);
}

export function parseValidateBuyerShippingAddressCommand(value: unknown): ValidateCommerceBuyerShippingAddressV1 {
  return decodeRecord(parseValidateBuyerShippingAddressCommandRecord, value);
}

export function parseRefreshBuyerPickupCheckoutCommand(value: unknown): RefreshCommerceBuyerPickupCheckoutV1 {
  return decodeRecord(parseRefreshBuyerPickupCheckoutCommandRecord, value);
}

export function parseRefreshBuyerShippingCheckoutCommand(value: unknown): RefreshCommerceBuyerShippingCheckoutV1 {
  return decodeRecord(parseRefreshBuyerShippingCheckoutCommandRecord, value);
}

function parseBuyerCart(value: unknown): CommerceBuyerCartV1 {
  return decodeRecord(parseCommerceBuyerCartV1Record, value);
}

function parseBuyerQuotedCheckout(value: unknown): CommerceBuyerQuotedCheckoutV1 {
  return decodeRecord(parseCommerceBuyerQuotedCheckoutV1Record, value);
}

function parseBuyerShippingAddressValidation(value: unknown): CommerceBuyerShippingAddressValidationV1 {
  return decodeRecord(parseCommerceBuyerShippingAddressValidationV1Record, value);
}

function parseBuyerQuotedShippingCheckout(value: unknown): CommerceBuyerQuotedShippingCheckoutV1 {
  return decodeRecord(parseCommerceBuyerQuotedShippingCheckoutV1Record, value);
}

function parseBuyerCheckoutRecovery(value: unknown): CommerceBuyerCheckoutRecoveryV1 {
  return decodeRecord(parseCommerceBuyerCheckoutRecoveryV1Record, value);
}

function parseBuyerPaymentResult(value: unknown): CommerceBuyerPaymentResultV1 {
  return decodeRecord(parseCommerceBuyerPaymentResultV1Record, value);
}

function parseBuyerOrder(value: unknown): CommerceBuyerOrderV1 {
  return decodeRecord(parseCommerceBuyerOrderV1Record, value);
}

function parseShopName(value: unknown): CommerceShopNameV1 {
  return decodeRecord(parseCommerceShopNameV1, value);
}
