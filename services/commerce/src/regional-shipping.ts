// The shipping quote contract between the core and a regional shipping
// plugin (Plan 76 phase 5). The core plans a checkout, keeps quote attempts
// durable and records the quote; the plugin knows which route serves a
// country, the carriers, the tax and duty rules and the label provider. The
// Worker passes it in with its carrier key (src/plugins/japan-export/).
import type {
  ShippingQuoteSnapshot,
  ShippingRouteBinding,
  VariantShippingSpecification,
} from "@purin-labs/commerce-contracts";
import type {
  CommerceBuyerShippingAddressV1,
  CommerceShippingCountry,
} from "@purin-labs/commerce-client";
import type { Variant } from "@purin-labs/type-utils";

import type { CarrierRateQuoteProvider } from "./checkout-carrier-rate-provider.ts";
import type {
  CheckoutChargeQuoteProvider,
  TaxCalculation,
} from "./checkout-charge-provider.ts";
import type { ShippingGateway } from "./shipping-gateway.ts";

export type ShippingAddressAuthority<
  Address extends CommerceBuyerShippingAddressV1,
> =
  | Readonly<{
      kind: "provided_address";
      address: Address;
      addressValidationReference: string;
      protectedAddressReference?: never;
    }>
  | Readonly<{
      kind: "saved_address";
      address: Address;
      protectedAddressReference: string;
      addressValidationReference: string;
    }>;

export type ShippingQuoteLine = Readonly<{
  checkoutLineId: string;
  quantity: number;
  itemSubtotal: Readonly<{ amountMinor: number; currency: string }>;
  inputIdentity: Readonly<{
    storefrontId: string;
    storefrontRevision: number;
    variantId: string;
    variantRevision: number;
    offerId: string;
    offerRevision: number;
    shippingProfileId: string;
    shippingProfileRevision: number;
    consumptionPlanId: string;
    consumptionPlanRevision: number;
  }>;
  specification: Variant<
    VariantShippingSpecification["eligibility"],
    "physical"
  >;
}>;

/** One package on one route to one address, as the core plans it. */
export type ShippingQuoteRequest = Readonly<{
  routeBinding: ShippingRouteBinding;
  addressAuthority: ShippingAddressAuthority<CommerceBuyerShippingAddressV1>;
  shippingQuoteId: string;
  packageId: string;
  serviceCode: string;
  taxCalculation: TaxCalculation &
    Readonly<{ providerAccountReference: string }>;
  lines: readonly ShippingQuoteLine[];
  quotedAt: string;
  quoteTtlSeconds: number;
}>;

export type ShippingQuoteResult =
  | Readonly<{ kind: "quoted"; quote: ShippingQuoteSnapshot }>
  | Readonly<{ kind: "invalid_address"; field: string }>
  | Readonly<{ kind: "unavailable_route"; field: string }>
  | Readonly<{ kind: "indeterminate"; field: string; retryAfter: string }>;

/** The providers of one quote; the core wraps them to keep them durable. */
export type ShippingQuoteProviders = Readonly<{
  carrierRateQuoteProvider: CarrierRateQuoteProvider;
  chargeQuoteProvider: CheckoutChargeQuoteProvider;
}>;

export type CheckoutProviderCapabilityKind =
  "address_validation" | "carrier_rate" | "tax" | "duty" | "label" | "tracking";

export type CheckoutProviderCapabilityHealthRequest = Readonly<{
  merchantId: string;
  capabilityKind: CheckoutProviderCapabilityKind;
  capabilityReference: string;
  destinationCountry: CommerceShippingCountry;
  serviceCode: string;
}>;

export type CheckoutProviderCapabilityHealth =
  Readonly<{ state: "ready" }> | Readonly<{ state: "unavailable" }>;

export interface CheckoutProviderCapabilityHealthProvider {
  readHealth(
    request: CheckoutProviderCapabilityHealthRequest,
  ): CheckoutProviderCapabilityHealth;
}

export class ReadyCheckoutProviderCapabilityHealthProvider implements CheckoutProviderCapabilityHealthProvider {
  readHealth(
    _request: CheckoutProviderCapabilityHealthRequest,
  ): CheckoutProviderCapabilityHealth {
    return { state: "ready" };
  }
}

export type PublishedShippingService = Readonly<{
  destinationCountry: CommerceShippingCountry;
  service: Readonly<{ code: string; name: string }>;
  availability:
    | Readonly<{ state: "available" }>
    | Readonly<{
        state: "temporarily_unavailable";
        recovery: "try_again_later";
      }>;
}>;

export type CheckoutTaxHealthBinding =
  | Readonly<{ kind: "provider_quoted"; capabilityReference: string }>
  | Readonly<{ kind: "merchant_percentage" }>;

/** What a regional shipping extension gives the core. */
export type RegionalShipping = Readonly<{
  /** Labels and tracking of shipments on the extension's routes. */
  gateway: ShippingGateway;
  carrierRates: CarrierRateQuoteProvider;
  charges: CheckoutChargeQuoteProvider;
  /** The one route of `routes` that serves the country, if exactly one. */
  routeFor(
    routes: readonly ShippingRouteBinding[],
    destinationCountry: string,
  ): ShippingRouteBinding | undefined;
  /** Every destination and service of `routes`, or undefined if invalid. */
  publishedServices(
    routes: readonly ShippingRouteBinding[],
    input: Readonly<{
      merchantId: string;
      taxCapability: CheckoutTaxHealthBinding;
      healthProvider: CheckoutProviderCapabilityHealthProvider;
    }>,
  ): readonly PublishedShippingService[] | undefined;
  quote(
    request: ShippingQuoteRequest,
    providers: ShippingQuoteProviders,
  ): ShippingQuoteResult;
}>;
