import type {
  CreateCommerceBuyerPickupCheckoutV1,
  CreateCommerceBuyerShippingCheckoutV1,
  CreateCommercePickupCheckoutV1,
  RefreshCommerceBuyerPickupCheckoutV1,
  RefreshCommerceBuyerShippingCheckoutV1,
  CommerceBuyerCartV1,
  CommerceBuyerCheckoutRecoveryV1,
  CommerceBuyerPaymentResultV1,
  CommerceBuyerPaymentSessionV1,
  CommerceBuyerQuotedCheckoutV1,
  CommerceBuyerQuotedShippingCheckoutV1,
  CommerceFoodServiceResourcesV1,
  CommerceMerchantSnapshotV1,
  CommerceMutationErrorV1,
  CommerceMutationResultV1,
} from "@seams/commerce-client";
import type { Storefront } from "@seams/commerce-contracts";
import type { CommerceDatabase } from "../../database.ts";
import type { BuyerSessionClaims } from "../../buyer-session.ts";
import type { PaymentGateway } from "../../payments/provider.ts";
import type { FoodServiceExtension } from "../../plugins/built-in-ports.ts";
import type {
  CheckoutProviderCapabilityHealthProvider,
  RegionalShipping,
} from "../../regional-shipping.ts";
import type { CheckoutCommandAuthority } from "../checkout-commands.ts";
import type {
  BuyerShippingCheckoutCommand,
  BuyerShippingDestinationAuthority,
  PickupCheckoutPlan,
} from "../checkout-planning.ts";
import type { VariantBy } from "@seams/type-utils";
import type { CheckoutBuyer } from "../../plugins/customers/index.ts";

export type BuyerMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

export type BuyerStorefrontContext = Readonly<{
  organisationId: string;
  storefront: Storefront;
}>;

export type BuyerCheckoutCreation =
  | Readonly<{ kind: "created"; checkout: CommerceBuyerQuotedCheckoutV1 }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type BuyerShippingCheckoutCreation =
  | Readonly<{
      kind: "created";
      checkout: CommerceBuyerQuotedShippingCheckoutV1;
    }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type BuyerCheckoutRecovery = CommerceBuyerCheckoutRecoveryV1;

export type BuyerCartMutation =
  | Readonly<{ kind: "resolved"; cart: CommerceBuyerCartV1 }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type BuyerPaymentAuthorityResult =
  | Exclude<CommerceBuyerPaymentResultV1, { state: "placed" }>
  | WithoutOrderRecovery<
      VariantBy<CommerceBuyerPaymentResultV1, "state", "placed">
    >;

export type WithoutOrderRecovery<T> = T extends unknown
  ? Omit<T, "orderRecovery">
  : never;

export type BuyerCheckoutProfileClaims = Pick<
  BuyerSessionClaims,
  | "sessionId"
  | "merchantId"
  | "storefrontId"
  | "storefrontRevision"
  | "checkoutProfile"
  | "buyer"
>;

export type ResolvedCreateBuyerPickupCheckoutV1 =
  CreateCommerceBuyerPickupCheckoutV1;

export type ResolvedCreateBuyerShippingCheckoutV1 = Omit<
  CreateCommerceBuyerShippingCheckoutV1,
  "shippingDestination"
> &
  Readonly<{
    shippingDestination: BuyerShippingDestinationAuthority;
  }>;

export type ResolvedRefreshBuyerPickupCheckoutV1 =
  RefreshCommerceBuyerPickupCheckoutV1;

export type ResolvedRefreshBuyerShippingCheckoutV1 = Omit<
  RefreshCommerceBuyerShippingCheckoutV1,
  "shippingDestination"
> &
  Readonly<{
    shippingDestination: BuyerShippingDestinationAuthority;
  }>;

export type BuyerPaymentResult =
  | Readonly<{ kind: "resolved"; result: BuyerPaymentAuthorityResult }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type BuyerPaymentSessionResult =
  | Readonly<{ kind: "resolved"; result: CommerceBuyerPaymentSessionV1 }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type BuyerCheckoutCommands = Pick<
  CheckoutCommandAuthority,
  | "submitBuyerPickupCheckout"
  | "submitBuyerShippingCheckout"
  | "beginCheckoutPayment"
  | "recordCheckoutPaymentCapture"
  | "resolveCheckoutPayment"
  | "placePaidCheckout"
  | "placeStoredValueCheckout"
>;

export type BuyerCheckoutAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  readMerchant: (merchantId: string) => BuyerMerchantRow | undefined;
  readSnapshot: (
    merchantId: string,
  ) => CommerceMerchantSnapshotV1 | undefined;
  readFoodServiceResources: (
    merchantId: string,
  ) => CommerceFoodServiceResourcesV1;
  checkoutCommands: BuyerCheckoutCommands;
  paymentGateway: PaymentGateway;
  /** The merchant's regional shipping, or undefined when it has none. */
  shipping: (merchantId: string) => RegionalShipping | undefined;
  foodService: FoodServiceExtension | undefined;
  checkoutCapabilityHealthProvider: CheckoutProviderCapabilityHealthProvider;
  commitPickupCheckout: (
    command: CreateCommercePickupCheckoutV1,
    merchant: BuyerMerchantRow,
    plan: PickupCheckoutPlan,
  ) => CommerceMutationResultV1;
  commitShippingCheckout: (
    command: BuyerShippingCheckoutCommand,
    merchant: BuyerMerchantRow,
    plan: PickupCheckoutPlan,
  ) => CommerceMutationResultV1;
  /** Links a new checkout to its buyer's customer record. */
  recordCheckoutBuyer: (
    merchantId: string,
    checkoutId: string,
    buyer: CheckoutBuyer,
  ) => void;
  /** The merchant's customer for a guest email, if there is one. */
  findCustomerId: (merchantId: string, email: string) => string | null;
}>;
