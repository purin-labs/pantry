import type { Cart as GeneratedCart } from "./records/commerce-records.ts";
import type { CartLifecycle as GeneratedCartLifecycle } from "./records/commerce-records.ts";
import type { Checkout as GeneratedCheckout } from "./records/commerce-records.ts";
import type { CheckoutFulfillmentQuoteSnapshot as GeneratedCheckoutFulfillmentQuoteSnapshot } from "./records/commerce-records.ts";
import type { CheckoutLifecycle as GeneratedCheckoutLifecycle } from "./records/commerce-records.ts";
import type { CheckoutPaymentAttempt as GeneratedCheckoutPaymentAttempt } from "./records/commerce-records.ts";
import type { CheckoutPaymentAttemptLifecycle as GeneratedCheckoutPaymentAttemptLifecycle } from "./records/commerce-records.ts";
import type { CheckoutPaymentBinding as GeneratedCheckoutPaymentBinding } from "./records/commerce-records.ts";
import type { CheckoutPaymentProviderBinding as GeneratedCheckoutPaymentProviderBinding } from "./records/commerce-records.ts";
import type { CheckoutQuoteSnapshot as GeneratedCheckoutQuoteSnapshot } from "./records/commerce-records.ts";
import type { CommerceOrder as GeneratedCommerceOrder } from "./records/commerce-records.ts";
import type { CheckoutBuyerPolicy as GeneratedCheckoutBuyerPolicy } from "./records/checkout-profile.ts";
import type { CheckoutCartPolicy as GeneratedCheckoutCartPolicy } from "./records/checkout-profile.ts";
import type { CheckoutCurrencyPolicy as GeneratedCheckoutCurrencyPolicy } from "./records/checkout-profile.ts";
import type { CheckoutFulfillmentPolicy as GeneratedCheckoutFulfillmentPolicy } from "./records/checkout-profile.ts";
import type { CheckoutPaymentPolicy as GeneratedCheckoutPaymentPolicy } from "./records/checkout-profile.ts";
import type { CheckoutPricingPolicy as GeneratedCheckoutPricingPolicy } from "./records/checkout-profile.ts";
import type { CheckoutProfile as GeneratedCheckoutProfile } from "./records/checkout-profile.ts";
import type { CheckoutProfileConfiguration as GeneratedCheckoutProfileConfiguration } from "./records/checkout-profile.ts";
import type { CheckoutProfileLifecycle as GeneratedCheckoutProfileLifecycle } from "./records/checkout-profile.ts";
import type { CheckoutProfileReference } from "./records/checkout-profile.ts";
import type { CheckoutTaxPolicy as GeneratedCheckoutTaxPolicy } from "./records/checkout-profile.ts";
import type { BuyerContactPolicy } from "./records/checkout-profile.ts";
import type { ProtectedBuyerContact as GeneratedProtectedBuyerContact } from "./records/commerce-records.ts";
import type { CheckoutAfterSalePolicy as GeneratedCheckoutAfterSalePolicy } from "./records/checkout-profile.ts";
import type { CheckoutPresentationPolicy } from "./records/checkout-profile.ts";
import type { SavedAddressPolicy } from "./records/checkout-profile.ts";
import type { CheckoutRefundGovernancePolicy as GeneratedCheckoutRefundGovernancePolicy } from "./records/checkout-profile.ts";
import type { CheckoutLineSource as GeneratedCheckoutLineSource } from "./records/commerce-records.ts";
import type { CommerceProjection as GeneratedCommerceProjection } from "./records/commerce-records.ts";
import type { InventoryAllocation as GeneratedInventoryAllocation } from "./records/commerce-records.ts";
import type { InventoryAllocationLifecycle as GeneratedInventoryAllocationLifecycle } from "./records/commerce-records.ts";
import type { InventoryBalance as GeneratedInventoryBalance } from "./records/commerce-records.ts";
import type { InventoryPosition as GeneratedInventoryPosition } from "./records/commerce-records.ts";
import type { Storefront as GeneratedStorefront } from "./records/commerce-records.ts";
import type { StorefrontCheckoutConfiguration as GeneratedStorefrontCheckoutConfiguration } from "./records/commerce-records.ts";
import type { StorefrontFulfillmentConfiguration as GeneratedStorefrontFulfillmentConfiguration } from "./records/commerce-records.ts";
import type { StorefrontLifecycle as GeneratedStorefrontLifecycle } from "./records/commerce-records.ts";
import type { StorefrontTaxConfiguration as GeneratedStorefrontTaxConfiguration } from "./records/commerce-records.ts";
import type { InventoryRequirementAdjustment as GeneratedInventoryRequirementAdjustment } from "./records/commerce-records.ts";
import type { InPersonPaymentBinding as GeneratedInPersonPaymentBinding } from "./records/commerce-records.ts";
import type { MenuScope as GeneratedMenuScope } from "./records/commerce-records.ts";
import type { MenuValidity as GeneratedMenuValidity } from "./records/commerce-records.ts";
import type { OrderLineInventory as GeneratedOrderLineInventory } from "./records/commerce-records.ts";
import type { OrderLineSource as GeneratedOrderLineSource } from "./records/commerce-records.ts";
import type { OnlinePaymentBinding as GeneratedOnlinePaymentBinding } from "./records/commerce-records.ts";
import type { OnlineOrderConfiguration as GeneratedOnlineOrderConfiguration } from "./records/commerce-records.ts";
import type { OrderOrigin as GeneratedOrderOrigin } from "./records/commerce-records.ts";
import type { PaymentDispute as GeneratedPaymentDispute } from "./records/after-sale.ts";
import type { PaymentDisputeLifecycle as GeneratedPaymentDisputeLifecycle } from "./records/after-sale.ts";
import type { PreparationTicketLifecycle as GeneratedPreparationTicketLifecycle } from "./records/commerce-records.ts";
import type { RecipeOutput as GeneratedRecipeOutput } from "./records/commerce-records.ts";
import type { RefundAllocation } from "./records/after-sale.ts";
import type { RefundAttempt as GeneratedRefundAttempt } from "./records/after-sale.ts";
import type { RefundAttemptLifecycle as GeneratedRefundAttemptLifecycle } from "./records/after-sale.ts";
import type { RefundReason as GeneratedRefundReason } from "./records/after-sale.ts";
import type { StrictUnion } from "@purin-labs/type-utils";

export type { BuyerContactPolicy };
export type ProtectedBuyerContact = StrictUnion<GeneratedProtectedBuyerContact>;
export type { CheckoutPresentationPolicy };
export type { CheckoutProfileReference };
export type { SavedAddressPolicy };
export type { RefundAllocation };

export type CheckoutBuyerPolicy = StrictUnion<GeneratedCheckoutBuyerPolicy>;

export type CheckoutCartPolicy = StrictUnion<GeneratedCheckoutCartPolicy>;

export type CheckoutCurrencyPolicy =
  StrictUnion<GeneratedCheckoutCurrencyPolicy>;

export type CheckoutFulfillmentPolicy =
  StrictUnion<GeneratedCheckoutFulfillmentPolicy>;

export type CheckoutPaymentPolicy = StrictUnion<GeneratedCheckoutPaymentPolicy>;

export type CheckoutPricingPolicy = StrictUnion<GeneratedCheckoutPricingPolicy>;

export type CheckoutRefundGovernancePolicy =
  StrictUnion<GeneratedCheckoutRefundGovernancePolicy>;

export type CheckoutAfterSalePolicy = Omit<
  GeneratedCheckoutAfterSalePolicy,
  "refundGovernance"
> &
  Readonly<{
    refundGovernance: CheckoutRefundGovernancePolicy;
  }>;

export type CheckoutTaxPolicy = StrictUnion<GeneratedCheckoutTaxPolicy>;

export type CheckoutProfileConfiguration = Omit<
  GeneratedCheckoutProfileConfiguration,
  | "buyerPolicy"
  | "cartPolicy"
  | "currencyPolicy"
  | "fulfillmentPolicy"
  | "paymentPolicy"
  | "pricingPolicy"
  | "taxPolicy"
> &
  Readonly<{
    buyerPolicy: CheckoutBuyerPolicy;
    cartPolicy: CheckoutCartPolicy;
    currencyPolicy: CheckoutCurrencyPolicy;
    fulfillmentPolicy: CheckoutFulfillmentPolicy;
    paymentPolicy: CheckoutPaymentPolicy;
    pricingPolicy: CheckoutPricingPolicy;
    taxPolicy: CheckoutTaxPolicy;
  }>;

export type CheckoutProfileLifecycle =
  StrictUnion<GeneratedCheckoutProfileLifecycle>;

export type CheckoutProfile = Omit<
  GeneratedCheckoutProfile,
  "configuration" | "lifecycle"
> &
  Readonly<{
    configuration: CheckoutProfileConfiguration;
    lifecycle: CheckoutProfileLifecycle;
  }>;

export type OnlineOrderConfiguration =
  StrictUnion<GeneratedOnlineOrderConfiguration>;

type OrderOriginBranch<TBranch> =
  TBranch extends Readonly<{ kind: "online" }>
    ? Omit<TBranch, "configuration"> &
        Readonly<{
          configuration: OnlineOrderConfiguration;
        }>
    : TBranch;

type OrderOrigin = StrictUnion<OrderOriginBranch<GeneratedOrderOrigin>>;

export type CommerceOrder = Omit<GeneratedCommerceOrder, "origin"> &
  Readonly<{
    origin: OrderOrigin;
  }>;

export type CheckoutLineSource = StrictUnion<GeneratedCheckoutLineSource>;

export type InventoryRequirementAdjustment =
  StrictUnion<GeneratedInventoryRequirementAdjustment>;

export type OnlinePaymentBinding = StrictUnion<GeneratedOnlinePaymentBinding>;

export type InPersonPaymentBinding =
  StrictUnion<GeneratedInPersonPaymentBinding>;

export type CheckoutPaymentProviderBinding =
  StrictUnion<GeneratedCheckoutPaymentProviderBinding>;

type CheckoutPaymentBinding = Omit<
  GeneratedCheckoutPaymentBinding,
  "paymentBinding"
> &
  Readonly<{
    paymentBinding: CheckoutPaymentProviderBinding;
  }>;

export type MenuScope = StrictUnion<GeneratedMenuScope>;

export type MenuValidity = StrictUnion<GeneratedMenuValidity>;

export type OrderLineInventory = StrictUnion<GeneratedOrderLineInventory>;

export type OrderLineSource = StrictUnion<GeneratedOrderLineSource>;

export type PreparationTicketLifecycle =
  StrictUnion<GeneratedPreparationTicketLifecycle>;

export type RecipeOutput = StrictUnion<GeneratedRecipeOutput>;

type CommerceProjectionBranch<TBranch> =
  TBranch extends Readonly<{ kind: "commerce_order" }>
    ? Omit<TBranch, "projection"> & Readonly<{ projection: CommerceOrder }>
    : TBranch;

export type CommerceProjection = StrictUnion<
  CommerceProjectionBranch<GeneratedCommerceProjection>
>;

export type InventoryBalance = StrictUnion<GeneratedInventoryBalance>;

type StorefrontLifecycle = StrictUnion<GeneratedStorefrontLifecycle>;

export type StorefrontFulfillmentConfiguration =
  StrictUnion<GeneratedStorefrontFulfillmentConfiguration>;

export type StorefrontTaxConfiguration =
  StrictUnion<GeneratedStorefrontTaxConfiguration>;

type StorefrontCheckoutConfiguration = Omit<
  GeneratedStorefrontCheckoutConfiguration,
  "tax"
> &
  Readonly<{
    tax: StorefrontTaxConfiguration;
  }>;

export type Storefront = Omit<GeneratedStorefront, "checkout" | "lifecycle"> &
  Readonly<{
    checkout: StorefrontCheckoutConfiguration;
    lifecycle: StorefrontLifecycle;
  }>;

export type CartLifecycle = StrictUnion<GeneratedCartLifecycle>;

export type Cart = Omit<GeneratedCart, "lifecycle"> &
  Readonly<{
    lifecycle: CartLifecycle;
  }>;

export type CheckoutLifecycle = StrictUnion<GeneratedCheckoutLifecycle>;

export type CheckoutFulfillmentQuoteSnapshot =
  StrictUnion<GeneratedCheckoutFulfillmentQuoteSnapshot>;

export type CheckoutQuoteSnapshot = GeneratedCheckoutQuoteSnapshot;

export type Checkout = Omit<GeneratedCheckout, "lifecycle"> &
  Readonly<{
    lifecycle: CheckoutLifecycle;
  }>;

export type CheckoutPaymentAttemptLifecycle =
  StrictUnion<GeneratedCheckoutPaymentAttemptLifecycle>;

export type CheckoutPaymentAttempt = Omit<
  GeneratedCheckoutPaymentAttempt,
  "binding" | "lifecycle"
> &
  Readonly<{
    binding: CheckoutPaymentBinding;
    lifecycle: CheckoutPaymentAttemptLifecycle;
  }>;

export type PaymentDisputeLifecycle =
  StrictUnion<GeneratedPaymentDisputeLifecycle>;

export type PaymentDispute = Omit<GeneratedPaymentDispute, "lifecycle"> &
  Readonly<{
    lifecycle: PaymentDisputeLifecycle;
  }>;

type RefundReason = StrictUnion<GeneratedRefundReason>;

export type RefundAttemptLifecycle =
  StrictUnion<GeneratedRefundAttemptLifecycle>;

export type RefundAttempt = Omit<
  GeneratedRefundAttempt,
  "lifecycle" | "reason"
> &
  Readonly<{
    lifecycle: RefundAttemptLifecycle;
    reason: RefundReason;
  }>;

export type InventoryAllocationLifecycle =
  StrictUnion<GeneratedInventoryAllocationLifecycle>;

export type InventoryAllocation = Omit<
  GeneratedInventoryAllocation,
  "lifecycle"
> &
  Readonly<{
    lifecycle: InventoryAllocationLifecycle;
  }>;

export type InventoryPosition = Omit<GeneratedInventoryPosition, "balance"> &
  Readonly<{
    balance: InventoryBalance;
  }>;
