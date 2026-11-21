// Shipping from Japan (Plan 76 phase 5): Yamato within Japan, and Japan
// Post to Singapore and to the Australian, US and EU zones of a general
// international route. All rates, taxes, duties and labels are test
// fixtures; no carrier or tax service is called.
import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  DutyIncoterm,
  ShippingRouteBinding,
  ShippingQuoteSnapshot,
} from "@purin-labs/commerce-contracts";
import {
  COMMERCE_EUROPEAN_UNION_COUNTRIES,
  type CommerceBuyerShippingAddressV1,
  type CommerceInternationalShippingAddressV1,
  type CommerceShippingCountry,
} from "@purin-labs/commerce-client";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

import {
  carrierRateQuoteInputDigest,
  type CarrierRateQuoteProviderRequest,
  type CarrierRateQuoteProviderResult,
} from "../../checkout-carrier-rate-provider.ts";
import {
  sha256,
  timestampAfter,
} from "../../commerce-authority/checkout-shared.ts";
import type {
  DutyQuoteProviderRequest,
  InternationalDutyQuoteProviderRequest,
  TaxQuoteProviderRequest,
} from "../../checkout-charge-provider.ts";
import type {
  CheckoutProviderCapabilityHealthProvider,
  CheckoutProviderCapabilityKind,
  CheckoutTaxHealthBinding,
  PublishedShippingService,
  RegionalShipping,
  ShippingAddressAuthority,
  ShippingQuoteLine,
  ShippingQuoteProviders,
  ShippingQuoteRequest,
  ShippingQuoteResult,
} from "../../regional-shipping.ts";
import type {
  ShippingGateway,
  ShippingLabelPurchaseResult,
  ShippingLabelRateRequest,
  ShippingLabelRateResult,
  ShippingTrackingEventInput,
} from "../../shipping-gateway.ts";
import { DeterministicJapanCarrierRateQuoteProvider } from "./carrier-rates.ts";
import { DeterministicJapanCheckoutChargeQuoteProvider } from "./charges.ts";

type JapanShippingQuoteRequestBase = Omit<
  ShippingQuoteRequest,
  "routeBinding" | "addressAuthority"
>;

/** A core request, narrowed to one route kind and its country. */
type JapanShippingQuoteRequest =
  | (JapanShippingQuoteRequestBase &
      Readonly<{
        route: "domestic_japan";
        routeBinding: Variant<ShippingRouteBinding, "domestic_japan">;
        addressAuthority: ShippingAddressAuthority<
          VariantBy<CommerceBuyerShippingAddressV1, "countryCode", "JP">
        >;
      }>)
  | (JapanShippingQuoteRequestBase &
      Readonly<{
        route: "japan_to_singapore";
        routeBinding: Variant<ShippingRouteBinding, "japan_to_singapore">;
        addressAuthority: ShippingAddressAuthority<
          VariantBy<CommerceBuyerShippingAddressV1, "countryCode", "SG">
        >;
      }>)
  | (JapanShippingQuoteRequestBase &
      Readonly<{
        route: "international";
        routeBinding: Variant<ShippingRouteBinding, "international">;
        addressAuthority: ShippingAddressAuthority<CommerceInternationalShippingAddressV1>;
      }>);

type JapanShippingRoute = Readonly<{
  route: ShippingRouteBinding["kind"];
  destinationCountries: readonly CommerceShippingCountry[];
  carrierAccountReference: string;
  service: Readonly<{ code: string; name: string }>;
  dutyProviderAccountReference: string;
  customsRequired: boolean;
  labelAmountMinor: number;
  trackingPrefix: string;
}>;

type JapanShippingGateway = ShippingGateway &
  Readonly<{
    signTrackingEvent: (input: ShippingTrackingEventInput) => string;
  }>;

const DOMESTIC_JAPAN_ROUTE: JapanShippingRoute = {
  route: "domestic_japan",
  destinationCountries: ["JP"],
  carrierAccountReference: "yamato_transport_test",
  service: { code: "takkyubin_test", name: "Yamato Takkyubin Test" },
  dutyProviderAccountReference: "commerce_domestic_duty_not_applicable",
  customsRequired: false,
  labelAmountMinor: 800,
  trackingPrefix: "JP-DOM",
};

const DOMESTIC_JAPAN_PRIORITY_ROUTE: JapanShippingRoute = {
  route: "domestic_japan",
  destinationCountries: ["JP"],
  carrierAccountReference: "yamato_transport_test",
  service: {
    code: "takkyubin_priority_test",
    name: "Yamato Takkyubin Priority Test",
  },
  dutyProviderAccountReference: "commerce_domestic_duty_not_applicable",
  customsRequired: false,
  labelAmountMinor: 1_200,
  trackingPrefix: "JP-DOM",
};

const JAPAN_TO_SINGAPORE_ROUTE: JapanShippingRoute = {
  route: "japan_to_singapore",
  destinationCountries: ["SG"],
  carrierAccountReference: "japan_post_ems_test",
  service: { code: "ems_test", name: "Japan Post EMS Test" },
  dutyProviderAccountReference: "singapore_duty_test",
  customsRequired: true,
  labelAmountMinor: 2_100,
  trackingPrefix: "JP-SG",
};

const JAPAN_TO_SINGAPORE_AIR_PARCEL_ROUTE: JapanShippingRoute = {
  route: "japan_to_singapore",
  destinationCountries: ["SG"],
  carrierAccountReference: "japan_post_ems_test",
  service: {
    code: "international_parcel_air_test",
    name: "Japan Post Air Parcel Test",
  },
  dutyProviderAccountReference: "singapore_duty_test",
  customsRequired: true,
  labelAmountMinor: 1_700,
  trackingPrefix: "JP-SG",
};

/**
 * Japan Post routes from Japan to the zones of a general international
 * route. A route binding names the zone by its duty capability and lists the
 * zone's countries that it serves.
 */
const INTERNATIONAL_ZONES: readonly Readonly<{
  dutyCapabilityId: string;
  dutyProviderAccountReference: string;
  countries: readonly string[];
  trackingPrefix: string;
  services: readonly Readonly<{
    code: string;
    name: string;
    labelAmountMinor: number;
  }>[];
}>[] = [
  {
    dutyCapabilityId: "duty_australia_test",
    dutyProviderAccountReference: "australia_duty_test",
    countries: ["AU"],
    trackingPrefix: "JP-AU",
    services: [
      {
        code: "ems_test",
        name: "Japan Post EMS Test",
        labelAmountMinor: 3_000,
      },
      {
        code: "international_parcel_air_test",
        name: "Japan Post Air Parcel Test",
        labelAmountMinor: 2_500,
      },
    ],
  },
  {
    dutyCapabilityId: "duty_united_states_test",
    dutyProviderAccountReference: "united_states_duty_test",
    countries: ["US"],
    trackingPrefix: "JP-US",
    services: [
      {
        code: "ems_test",
        name: "Japan Post EMS Test",
        labelAmountMinor: 3_700,
      },
      {
        code: "international_parcel_air_test",
        name: "Japan Post Air Parcel Test",
        labelAmountMinor: 2_900,
      },
    ],
  },
  {
    dutyCapabilityId: "duty_european_union_test",
    dutyProviderAccountReference: "european_union_duty_test",
    countries: COMMERCE_EUROPEAN_UNION_COUNTRIES,
    trackingPrefix: "JP-EU",
    services: [
      {
        code: "ems_test",
        name: "Japan Post EMS Test",
        labelAmountMinor: 3_900,
      },
      {
        code: "international_parcel_air_test",
        name: "Japan Post Air Parcel Test",
        labelAmountMinor: 3_200,
      },
    ],
  },
];

function publishedJapanShippingServices(
  routes: readonly ShippingRouteBinding[],
  input: Readonly<{
    merchantId: string;
    taxCapability: CheckoutTaxHealthBinding;
    healthProvider: CheckoutProviderCapabilityHealthProvider;
  }>,
): readonly PublishedShippingService[] | undefined {
  const published: PublishedShippingService[] = [];
  const serviceKeys = new Set<string>();
  for (const route of routes) {
    for (const serviceCode of route.serviceCodes) {
      const compiled = resolveCompiledJapanShippingRoute(route, serviceCode);
      if (compiled === undefined) return undefined;
      for (const destinationCountry of compiled.destinationCountries) {
        const exactRoute = resolveJapanShippingRouteBinding(
          routes,
          destinationCountry,
        );
        const serviceKey = `${destinationCountry}:${compiled.service.code}`;
        if (
          exactRoute?.routeId !== route.routeId ||
          serviceKeys.has(serviceKey)
        ) {
          return undefined;
        }
        serviceKeys.add(serviceKey);
        published.push({
          destinationCountry,
          service: compiled.service,
          availability: publishedServiceAvailability(
            route,
            compiled,
            destinationCountry,
            input,
          ),
        });
      }
    }
  }
  return published;
}

function publishedServiceAvailability(
  routeBinding: ShippingRouteBinding,
  route: JapanShippingRoute,
  destinationCountry: CommerceShippingCountry,
  input: Readonly<{
    merchantId: string;
    taxCapability: CheckoutTaxHealthBinding;
    healthProvider: CheckoutProviderCapabilityHealthProvider;
  }>,
): PublishedShippingService["availability"] {
  for (const capability of checkoutProviderCapabilities(
    routeBinding,
    route,
    input.taxCapability,
  )) {
    const health = input.healthProvider.readHealth({
      merchantId: input.merchantId,
      capabilityKind: capability.kind,
      capabilityReference: capability.reference,
      destinationCountry,
      serviceCode: route.service.code,
    });
    if (health.state === "unavailable") {
      return { state: "temporarily_unavailable", recovery: "try_again_later" };
    }
  }
  return { state: "available" };
}

function checkoutProviderCapabilities(
  routeBinding: ShippingRouteBinding,
  route: JapanShippingRoute,
  taxCapability: CheckoutTaxHealthBinding,
): readonly Readonly<{
  kind: CheckoutProviderCapabilityKind;
  reference: string;
}>[] {
  const dutyCapabilityReference =
    routeBinding.kind === "domestic_japan"
      ? route.dutyProviderAccountReference
      : routeBinding.dutyCapabilityId;
  const capabilities: Array<
    Readonly<{
      kind: CheckoutProviderCapabilityKind;
      reference: string;
    }>
  > = [
    { kind: "address_validation", reference: "commerce_address_validation" },
    { kind: "carrier_rate", reference: routeBinding.carrierRateCapabilityId },
    { kind: "duty", reference: dutyCapabilityReference },
    { kind: "label", reference: routeBinding.carrierRateCapabilityId },
    { kind: "tracking", reference: routeBinding.carrierRateCapabilityId },
  ];
  if (taxCapability.kind === "provider_quoted") {
    capabilities.push({
      kind: "tax",
      reference: taxCapability.capabilityReference,
    });
  }
  return capabilities;
}

function resolveJapanShippingRouteBinding(
  routes: readonly ShippingRouteBinding[],
  destinationCountry: string,
): ShippingRouteBinding | undefined {
  let match: ShippingRouteBinding | undefined;
  for (const route of routes) {
    const matches =
      (route.kind === "domestic_japan" && destinationCountry === "JP") ||
      (route.kind === "japan_to_singapore" && destinationCountry === "SG") ||
      (route.kind === "international" &&
        route.destinationCountries.includes(destinationCountry));
    if (!matches) continue;
    if (match !== undefined) return undefined;
    match = route;
  }
  return match;
}

function quoteJapanShippingWithProviders(
  request: JapanShippingQuoteRequest,
  providers: ShippingQuoteProviders,
): ShippingQuoteResult {
  const route = resolveCompiledJapanShippingRoute(
    request.routeBinding,
    request.serviceCode,
  );
  if (route === undefined) {
    return {
      kind: "unavailable_route",
      field: "shippingRoute.carrierRateBinding",
    };
  }
  switch (request.route) {
    case "domestic_japan":
      return quoteJapanShippingRoute(
        request,
        route,
        validateJapanAddress(request.addressAuthority.address),
        providers,
      );
    case "japan_to_singapore":
      return quoteJapanShippingRoute(
        request,
        route,
        validateSingaporeAddress(request.addressAuthority.address),
        providers,
      );
    case "international":
      return quoteJapanShippingRoute(
        request,
        route,
        route.destinationCountries.includes(
          request.addressAuthority.address.countryCode,
        )
          ? undefined
          : "shippingAddress.countryCode",
        providers,
      );
  }
}

function quoteJapanShippingRoute(
  request: JapanShippingQuoteRequest,
  route: JapanShippingRoute,
  invalidAddressField: string | undefined,
  providers: ShippingQuoteProviders,
): ShippingQuoteResult {
  if (invalidAddressField !== undefined) {
    return { kind: "invalid_address", field: invalidAddressField };
  }
  if (request.lines.length === 0) {
    throw new Error("Japan shipping requires at least one line");
  }
  const itemSubtotal = sumLineSubtotals(request.lines);
  const packageWeight = sumPackageWeight(request.lines);
  const packageDimensions = combinePackageDimensions(request.lines);
  const addressDigest = sha256(
    JSON.stringify(request.addressAuthority.address),
  );
  const packageInput = request.lines.map(packageDigestLine);
  const packagePlanDigest = sha256(JSON.stringify(packageInput));
  const expiresAt = timestampAfter(request.quotedAt, request.quoteTtlSeconds);
  const destinationCountry = request.addressAuthority.address.countryCode;
  const carrierRateRequest = carrierRateProviderRequest(
    request,
    route,
    destinationCountry,
    packagePlanDigest,
    packageWeight,
    packageDimensions,
    addressDigest,
    expiresAt,
  );
  const carrierRateResult =
    providers.carrierRateQuoteProvider.quoteRate(carrierRateRequest);
  if (carrierRateResult.kind === "unavailable") {
    return { kind: "unavailable_route", field: carrierRateResult.field };
  }
  if (carrierRateResult.kind === "indeterminate") return carrierRateResult;
  if (
    !acceptedCarrierRateMatches(
      carrierRateResult,
      carrierRateRequest,
      route,
      request.lines,
    )
  ) {
    return {
      kind: "unavailable_route",
      field: "shippingRoute.carrierRateBinding",
    };
  }
  const taxResult = providers.chargeQuoteProvider.quoteTax(
    taxQuoteProviderRequest(
      request,
      destinationCountry,
      carrierRateResult.rate.shippingAmount.amountMinor,
      addressDigest,
      expiresAt,
    ),
  );
  if (taxResult.kind === "unavailable") {
    return { kind: "unavailable_route", field: taxResult.field };
  }
  if (taxResult.kind === "indeterminate") return taxResult;
  if (
    !taxQuoteMatchesCalculation(taxResult.quote, request.taxCalculation) ||
    !exactQuoteLineAllocations(
      request.lines,
      taxResult.quote.lineAllocations,
      taxResult.quote.taxAmount.amountMinor,
    ) ||
    taxResult.expiresAt !== expiresAt
  ) {
    return { kind: "unavailable_route", field: "shippingRoute.taxBinding" };
  }
  const dutyResult = providers.chargeQuoteProvider.quoteDuty(
    dutyQuoteProviderRequest(request, route, addressDigest, expiresAt),
  );
  if (dutyResult.kind === "unavailable") {
    return { kind: "unavailable_route", field: dutyResult.field };
  }
  if (dutyResult.kind === "indeterminate") return dutyResult;
  if (
    dutyResult.quote.providerAccountReference !==
      route.dutyProviderAccountReference ||
    dutyResult.quote.incoterm !== routeIncoterm(request.routeBinding) ||
    !exactQuoteLineAllocations(
      request.lines,
      dutyResult.quote.lineAllocations,
      dutyResult.quote.dutyAmount.amountMinor,
    ) ||
    dutyResult.expiresAt !== expiresAt
  ) {
    return { kind: "unavailable_route", field: "shippingRoute.dutyBinding" };
  }
  const totalAmountMinor = shippingQuoteTotal(
    itemSubtotal.amountMinor,
    carrierRateResult.rate.shippingAmount.amountMinor,
    taxResult.quote.taxAmount.amountMinor,
    dutyResult.quote.dutyAmount.amountMinor,
  );
  const inputDigest = sha256(
    JSON.stringify({
      route: request.routeBinding,
      service: route.service,
      identities: request.lines.map((line) => line.inputIdentity),
      addressDigest,
      packagePlanDigest,
      carrierRateInputDigest: carrierRateResult.inputDigest,
      itemSubtotal,
    }),
  );
  return {
    kind: "quoted",
    quote: {
      shippingQuoteId: request.shippingQuoteId,
      routeBinding: request.routeBinding,
      carrierRate: carrierRateResult.rate,
      taxQuote: taxResult.quote,
      dutyQuote: dutyResult.quote,
      itemSubtotal,
      total: { amountMinor: totalAmountMinor, currency: "JPY" },
      estimatedDelivery: carrierRateResult.estimatedDelivery,
      address: {
        protectedAddressReference:
          request.addressAuthority.kind === "saved_address"
            ? request.addressAuthority.protectedAddressReference
            : `protected_address_${addressDigest}`,
        destinationCountry,
        addressValidationReference:
          request.addressAuthority.addressValidationReference,
        addressDigest,
      },
      packagePlan: {
        packagePlanDigest,
        package: {
          packageId: request.packageId,
          weight: packageWeight,
          dimensions: packageDimensions,
          lineQuantities: request.lines.map(toShippingLineQuantity),
          customsLines: route.customsRequired
            ? request.lines.map(toCustomsLine)
            : [],
        },
      },
      inputDigest,
      quotedAt: request.quotedAt,
      expiresAt,
    },
  };
}

function taxQuoteMatchesCalculation(
  quote: ShippingQuoteSnapshot["taxQuote"],
  calculation: JapanShippingQuoteRequest["taxCalculation"],
): boolean {
  if (quote.providerAccountReference !== calculation.providerAccountReference)
    return false;
  switch (calculation.kind) {
    case "provider_quoted":
      return (
        quote.registrationPolicyReference ===
        calculation.registrationPolicyReference
      );
    case "merchant_percentage":
      return (
        quote.registrationPolicyReference ===
        calculation.jurisdictionPolicyReference
      );
    default:
      return assertNever(calculation, "Unsupported shipping tax calculation");
  }
}

function acceptedCarrierRateMatches(
  result: Variant<CarrierRateQuoteProviderResult, "quoted">,
  providerRequest: CarrierRateQuoteProviderRequest,
  route: JapanShippingRoute,
  lines: readonly ShippingQuoteLine[],
): boolean {
  const delivery = result.estimatedDelivery;
  return (
    result.rate.providerAccountReference === route.carrierAccountReference &&
    result.rate.service.code === route.service.code &&
    result.rate.service.name === route.service.name &&
    result.rate.shippingAmount.currency === "JPY" &&
    Number.isSafeInteger(result.rate.shippingAmount.amountMinor) &&
    result.rate.shippingAmount.amountMinor >= 0 &&
    exactQuoteLineAllocations(
      lines,
      result.rate.lineAllocations,
      result.rate.shippingAmount.amountMinor,
    ) &&
    result.inputDigest === carrierRateQuoteInputDigest(providerRequest) &&
    result.expiresAt === providerRequest.expiresAt &&
    delivery.kind === "window" &&
    validDeliveryWindow(
      delivery.earliest,
      delivery.latest,
      providerRequest.quotedAt,
    )
  );
}

function validDeliveryWindow(
  earliest: string,
  latest: string,
  quotedAt: string,
): boolean {
  const quotedTime = Date.parse(quotedAt);
  const earliestTime = Date.parse(earliest);
  const latestTime = Date.parse(latest);
  return (
    Number.isFinite(quotedTime) &&
    Number.isFinite(earliestTime) &&
    Number.isFinite(latestTime) &&
    earliestTime >= quotedTime &&
    latestTime >= earliestTime
  );
}

function exactQuoteLineAllocations(
  lines: readonly ShippingQuoteLine[],
  allocations: ShippingQuoteSnapshot["taxQuote"]["lineAllocations"],
  expectedTotalMinor: number,
): boolean {
  if (allocations.length !== lines.length) return false;
  const lineIds = new Set(lines.map(readJapanShippingLineId));
  const allocatedLineIds = new Set<string>();
  let allocatedMinor = 0;
  for (const allocation of allocations) {
    if (
      !lineIds.has(allocation.checkoutLineId) ||
      allocatedLineIds.has(allocation.checkoutLineId) ||
      allocation.amount.currency !== "JPY" ||
      !Number.isSafeInteger(allocation.amount.amountMinor) ||
      allocation.amount.amountMinor < 0
    ) {
      return false;
    }
    allocatedLineIds.add(allocation.checkoutLineId);
    allocatedMinor += allocation.amount.amountMinor;
    if (!Number.isSafeInteger(allocatedMinor)) return false;
  }
  return allocatedMinor === expectedTotalMinor;
}

function readJapanShippingLineId(line: ShippingQuoteLine): string {
  return line.checkoutLineId;
}

function carrierRateProviderRequest(
  request: JapanShippingQuoteRequest,
  route: JapanShippingRoute,
  destinationCountry: CommerceShippingCountry,
  packagePlanDigest: string,
  weight: CarrierRateQuoteProviderRequest["package"]["weight"],
  dimensions: CarrierRateQuoteProviderRequest["package"]["dimensions"],
  addressDigest: string,
  expiresAt: string,
): CarrierRateQuoteProviderRequest {
  return {
    providerAccountReference: route.carrierAccountReference,
    originCountry: "JP",
    destinationCountry,
    selectedServiceCode: route.service.code,
    packagePlanDigest,
    package: { weight, dimensions },
    lines: request.lines.map(toCarrierRateProviderLine),
    addressDigest,
    quotedAt: request.quotedAt,
    expiresAt,
  };
}

function toCarrierRateProviderLine(
  line: ShippingQuoteLine,
): CarrierRateQuoteProviderRequest["lines"][number] {
  return {
    checkoutLineId: line.checkoutLineId,
    amount: { amountMinor: line.itemSubtotal.amountMinor, currency: "JPY" },
  };
}

function taxQuoteProviderRequest(
  request: JapanShippingQuoteRequest,
  destinationCountry: CommerceShippingCountry,
  shippingAmountMinor: number,
  addressDigest: string,
  expiresAt: string,
): TaxQuoteProviderRequest {
  return {
    ...request.taxCalculation,
    destinationCountry,
    lines: request.lines.map(toTaxQuoteProviderLine),
    shippingAmount: { amountMinor: shippingAmountMinor, currency: "JPY" },
    addressDigest,
    quotedAt: request.quotedAt,
    expiresAt,
  };
}

function dutyQuoteProviderRequest(
  request: JapanShippingQuoteRequest,
  route: JapanShippingRoute,
  addressDigest: string,
  expiresAt: string,
): DutyQuoteProviderRequest {
  const common = {
    providerAccountReference: route.dutyProviderAccountReference,
    addressDigest,
    quotedAt: request.quotedAt,
    expiresAt,
  };
  switch (request.route) {
    case "domestic_japan":
      return {
        ...common,
        destinationCountry: "JP",
        incoterm: "not_applicable",
        lines: request.lines.map(toDomesticDutyQuoteProviderLine),
      };
    case "japan_to_singapore":
      return {
        ...common,
        destinationCountry: "SG",
        incoterm: request.routeBinding.incoterm,
        customsLines: request.lines.map(toDutyQuoteProviderLine),
      };
    case "international":
      return {
        ...common,
        destinationCountry: request.addressAuthority.address.countryCode,
        incoterm: request.routeBinding.incoterm,
        customsLines: request.lines.map(toDutyQuoteProviderLine),
      };
  }
}

function routeIncoterm(routeBinding: ShippingRouteBinding): DutyIncoterm {
  switch (routeBinding.kind) {
    case "domestic_japan":
      return "not_applicable";
    case "japan_to_singapore":
    case "international":
      return routeBinding.incoterm;
  }
}

function toTaxQuoteProviderLine(
  line: ShippingQuoteLine,
): TaxQuoteProviderRequest["lines"][number] {
  return {
    checkoutLineId: line.checkoutLineId,
    amount: { amountMinor: line.itemSubtotal.amountMinor, currency: "JPY" },
  };
}

function toDutyQuoteProviderLine(
  line: ShippingQuoteLine,
): InternationalDutyQuoteProviderRequest["customsLines"][number] {
  return {
    checkoutLineId: line.checkoutLineId,
    declaredValue: {
      amountMinor: line.itemSubtotal.amountMinor,
      currency: "JPY",
    },
    countryOfOrigin: line.specification.countryOfOrigin,
    hsCode: line.specification.hsCode,
  };
}

function toDomesticDutyQuoteProviderLine(
  line: ShippingQuoteLine,
): VariantBy<
  DutyQuoteProviderRequest,
  "destinationCountry",
  "JP"
>["lines"][number] {
  return {
    checkoutLineId: line.checkoutLineId,
    declaredValue: {
      amountMinor: line.itemSubtotal.amountMinor,
      currency: "JPY",
    },
  };
}

function shippingQuoteTotal(
  itemSubtotalMinor: number,
  shippingAmountMinor: number,
  taxAmountMinor: number,
  dutyAmountMinor: number,
): number {
  const total =
    itemSubtotalMinor + shippingAmountMinor + taxAmountMinor + dutyAmountMinor;
  if (!Number.isSafeInteger(total)) {
    throw new Error("Japan shipping quote total exceeds the supported range");
  }
  return total;
}

function sumLineSubtotals(
  lines: readonly ShippingQuoteLine[],
): Readonly<{ amountMinor: number; currency: "JPY" }> {
  let amountMinor = 0;
  for (const line of lines) {
    if (
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.itemSubtotal.currency !== "JPY" ||
      !Number.isSafeInteger(line.itemSubtotal.amountMinor) ||
      line.itemSubtotal.amountMinor < 0
    ) {
      throw new Error("Japan shipping requires positive JPY lines");
    }
    amountMinor += line.itemSubtotal.amountMinor;
    if (!Number.isSafeInteger(amountMinor)) {
      throw new Error(
        "Japan shipping item subtotal exceeds the supported range",
      );
    }
  }
  return { amountMinor, currency: "JPY" };
}

function sumPackageWeight(
  lines: readonly ShippingQuoteLine[],
): Readonly<{ grams: number }> {
  let grams = 0;
  for (const line of lines) {
    grams += multiplyWeight(line.specification.weight, line.quantity).grams;
    if (!Number.isSafeInteger(grams) || grams <= 0) {
      throw new Error(
        "Japan shipping package weight exceeds the supported range",
      );
    }
  }
  return { grams };
}

function combinePackageDimensions(
  lines: readonly ShippingQuoteLine[],
): ShippingQuoteLine["specification"]["dimensions"] {
  let lengthMillimeters = 0;
  let widthMillimeters = 0;
  let heightMillimeters = 0;
  for (const line of lines) {
    const dimensions = line.specification.dimensions;
    lengthMillimeters = Math.max(
      lengthMillimeters,
      dimensions.lengthMillimeters,
    );
    widthMillimeters = Math.max(widthMillimeters, dimensions.widthMillimeters);
    heightMillimeters += dimensions.heightMillimeters * line.quantity;
  }
  if (!Number.isSafeInteger(heightMillimeters) || heightMillimeters <= 0) {
    throw new Error(
      "Japan shipping package dimensions exceed the supported range",
    );
  }
  return { lengthMillimeters, widthMillimeters, heightMillimeters };
}

function packageDigestLine(
  line: ShippingQuoteLine,
): Readonly<Record<string, unknown>> {
  return {
    checkoutLineId: line.checkoutLineId,
    quantity: line.quantity,
    weight: multiplyWeight(line.specification.weight, line.quantity),
    dimensions: line.specification.dimensions,
    countryOfOrigin: line.specification.countryOfOrigin,
    hsCode: line.specification.hsCode,
  };
}

function toShippingLineQuantity(
  line: ShippingQuoteLine,
): ShippingQuoteSnapshot["packagePlan"]["package"]["lineQuantities"][number] {
  return {
    checkoutLineId: line.checkoutLineId,
    quantity: { amount: line.quantity, scale: 0, unit: "each" },
  };
}

function toCustomsLine(
  line: ShippingQuoteLine,
): ShippingQuoteSnapshot["packagePlan"]["package"]["customsLines"][number] {
  return {
    checkoutLineId: line.checkoutLineId,
    description: line.specification.description,
    quantity: { amount: line.quantity, scale: 0, unit: "each" },
    weight: multiplyWeight(line.specification.weight, line.quantity),
    declaredValue: line.itemSubtotal,
    countryOfOrigin: line.specification.countryOfOrigin,
    hsCode: line.specification.hsCode,
  };
}

function multiplyWeight(
  weight: Readonly<{ grams: number }>,
  quantity: number,
): Readonly<{ grams: number }> {
  const grams = weight.grams * quantity;
  if (!Number.isSafeInteger(grams) || grams <= 0) {
    throw new Error(
      "Japan shipping package weight exceeds the supported range",
    );
  }
  return { grams };
}

function quoteJapanShippingLabelRate(
  input: ShippingLabelRateRequest,
): ShippingLabelRateResult {
  const route = resolveCompiledJapanShippingRoute(
    input.routeBinding,
    input.acceptedCarrierRate.service.code,
  );
  if (
    route === undefined ||
    input.acceptedCarrierRate.providerAccountReference !==
      route.carrierAccountReference ||
    input.acceptedCarrierRate.service.code !== route.service.code ||
    input.acceptedCarrierRate.service.name !== route.service.name ||
    input.acceptedCarrierRate.shippingAmount.currency !== "JPY"
  ) {
    return { kind: "unavailable_route" };
  }
  const digest = sha256(
    JSON.stringify({
      routeBinding: input.routeBinding,
      acceptedCarrierRate: input.acceptedCarrierRate,
      shipmentId: input.shipmentId,
      shipmentRevision: input.shipmentRevision,
      packagePlanDigest: input.packagePlanDigest,
      idempotencyKey: input.idempotencyKey,
    }),
  );
  return {
    kind: "quoted",
    rate: {
      labelRateId: `label_rate_${digest}`,
      shipmentId: input.shipmentId,
      shipmentRevision: input.shipmentRevision,
      providerAccountReference: route.carrierAccountReference,
      rateReference: `label_rate_reference_${digest}`,
      service: route.service,
      amount: { amountMinor: route.labelAmountMinor, currency: "JPY" },
      packagePlanDigest: input.packagePlanDigest,
      quotedAt: input.quotedAt,
      expiresAt: timestampAfter(input.quotedAt, 900),
    },
  };
}

function purchaseJapanShippingLabel(
  input: Parameters<ShippingGateway["purchaseLabel"]>[0],
): ShippingLabelPurchaseResult {
  const route = requireCompiledJapanShippingRoute(
    input.routeBinding,
    input.serviceCode,
  );
  const digest = sha256(
    JSON.stringify({
      routeBinding: input.routeBinding,
      carrier: route.carrierAccountReference,
      shipmentId: input.shipmentId,
      serviceCode: input.serviceCode,
      labelAttemptId: input.labelAttemptId,
      rateReference: input.rateReference,
      purchasedAt: input.purchasedAt,
    }),
  );
  return {
    providerLabelReference: `label_${digest}`,
    trackingNumber: `${route.trackingPrefix}-${digest.slice(0, 12).toUpperCase()}`,
  };
}

export function createJapanShippingGateway(
  signingKey: string,
): JapanShippingGateway {
  if (signingKey.length < 16 || signingKey.trim() !== signingKey) {
    throw new Error("Japan carrier signing key is invalid");
  }
  return {
    quoteLabelRate: quoteJapanShippingLabelRate,
    purchaseLabel: purchaseJapanShippingLabel,
    signTrackingEvent: (input) => {
      const route = requireCompiledJapanShippingRoute(
        input.routeBinding,
        input.serviceCode,
      );
      return `sig_${hmac(JSON.stringify(trackingSignaturePayload(route, input)), signingKey)}`;
    },
    verifyTrackingEvent: (input) => {
      const { signature, ...event } = input;
      const route = resolveCompiledJapanShippingRoute(
        event.routeBinding,
        event.serviceCode,
      );
      if (route === undefined) return false;
      const expected = `sig_${hmac(JSON.stringify(trackingSignaturePayload(route, event)), signingKey)}`;
      const actualBytes = Buffer.from(signature);
      const expectedBytes = Buffer.from(expected);
      return (
        actualBytes.length === expectedBytes.length &&
        timingSafeEqual(actualBytes, expectedBytes)
      );
    },
  };
}

function trackingSignaturePayload(
  route: JapanShippingRoute,
  input: ShippingTrackingEventInput,
): Readonly<Record<string, unknown>> {
  return {
    carrier: route.carrierAccountReference,
    routeBinding: input.routeBinding,
    serviceCode: input.serviceCode,
    shipmentId: input.shipmentId,
    state: input.state,
    providerEventId: input.providerEventId,
    occurredAt: input.occurredAt,
    location: input.location,
  };
}

function resolveCompiledJapanShippingRoute(
  routeBinding: ShippingRouteBinding,
  serviceCode: string,
): JapanShippingRoute | undefined {
  if (!routeBinding.serviceCodes.includes(serviceCode)) return undefined;
  switch (routeBinding.kind) {
    case "domestic_japan":
      if (routeBinding.carrierRateCapabilityId !== "carrier_rate_yamato_test") {
        return undefined;
      }
      switch (serviceCode) {
        case "takkyubin_test":
          return DOMESTIC_JAPAN_ROUTE;
        case "takkyubin_priority_test":
          return DOMESTIC_JAPAN_PRIORITY_ROUTE;
        default:
          return undefined;
      }
    case "japan_to_singapore":
      if (
        routeBinding.carrierRateCapabilityId !==
          "carrier_rate_japan_post_ems_test" ||
        routeBinding.dutyCapabilityId !== "duty_singapore_test"
      ) {
        return undefined;
      }
      switch (serviceCode) {
        case "ems_test":
          return JAPAN_TO_SINGAPORE_ROUTE;
        case "international_parcel_air_test":
          return JAPAN_TO_SINGAPORE_AIR_PARCEL_ROUTE;
        default:
          return undefined;
      }
    case "international": {
      const zone = INTERNATIONAL_ZONES.find(
        (candidate) =>
          candidate.dutyCapabilityId === routeBinding.dutyCapabilityId,
      );
      const service = zone?.services.find(
        (candidate) => candidate.code === serviceCode,
      );
      if (
        zone === undefined ||
        service === undefined ||
        routeBinding.carrierRateCapabilityId !==
          "carrier_rate_japan_post_ems_test" ||
        !routeBinding.destinationCountries.every((country) =>
          zone.countries.includes(country),
        )
      ) {
        return undefined;
      }
      return {
        route: "international",
        destinationCountries:
          routeBinding.destinationCountries as readonly CommerceShippingCountry[],
        carrierAccountReference: "japan_post_ems_test",
        service: { code: service.code, name: service.name },
        dutyProviderAccountReference: zone.dutyProviderAccountReference,
        customsRequired: true,
        labelAmountMinor: service.labelAmountMinor,
        trackingPrefix: zone.trackingPrefix,
      };
    }
  }
}

function requireCompiledJapanShippingRoute(
  routeBinding: ShippingRouteBinding,
  serviceCode: string,
): JapanShippingRoute {
  const route = resolveCompiledJapanShippingRoute(routeBinding, serviceCode);
  if (route === undefined)
    throw new Error("Japan shipping route binding is unavailable");
  return route;
}

function validateSingaporeAddress(
  address: VariantBy<CommerceBuyerShippingAddressV1, "countryCode", "SG">,
): string | undefined {
  if (address.countryCode !== "SG") return "shippingAddress.countryCode";
  if (!/^\d{6}$/u.test(address.postalCode)) return "shippingAddress.postalCode";
  if (address.locality !== "Singapore") return "shippingAddress.locality";
  return undefined;
}

function validateJapanAddress(
  address: VariantBy<CommerceBuyerShippingAddressV1, "countryCode", "JP">,
): string | undefined {
  if (address.countryCode !== "JP") return "shippingAddress.countryCode";
  if (!/^\d{3}-\d{4}$/u.test(address.postalCode))
    return "shippingAddress.postalCode";
  if (address.administrativeArea.length === 0)
    return "shippingAddress.administrativeArea";
  if (address.locality.length === 0) return "shippingAddress.locality";
  return undefined;
}

function hmac(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

/**
 * A core request on the route of its kind, when the buyer's country is one
 * that the route serves.
 */
function routeRequest(
  request: ShippingQuoteRequest,
): JapanShippingQuoteRequest | undefined {
  const { routeBinding, addressAuthority, ...base } = request;
  const address = addressAuthority.address;
  const authority = <Address extends CommerceBuyerShippingAddressV1>(
    narrowed: Address,
  ): ShippingAddressAuthority<Address> => ({
    ...addressAuthority,
    address: narrowed,
  });
  switch (routeBinding.kind) {
    case "domestic_japan":
      return address.countryCode === "JP"
        ? {
            ...base,
            route: "domestic_japan",
            routeBinding,
            addressAuthority: authority(address),
          }
        : undefined;
    case "japan_to_singapore":
      return address.countryCode === "SG"
        ? {
            ...base,
            route: "japan_to_singapore",
            routeBinding,
            addressAuthority: authority(address),
          }
        : undefined;
    case "international":
      return address.countryCode !== "JP" &&
        address.countryCode !== "SG" &&
        routeBinding.destinationCountries.includes(address.countryCode)
        ? {
            ...base,
            route: "international",
            routeBinding,
            addressAuthority: authority(address),
          }
        : undefined;
  }
}

/** Shipping from Japan, signed with the carrier key for tracking events. */
export function createJapanExportShipping(
  carrierSigningKey: string,
): RegionalShipping & Readonly<{ gateway: JapanShippingGateway }> {
  return {
    gateway: createJapanShippingGateway(carrierSigningKey),
    carrierRates: new DeterministicJapanCarrierRateQuoteProvider(),
    charges: new DeterministicJapanCheckoutChargeQuoteProvider(),
    routeFor: resolveJapanShippingRouteBinding,
    publishedServices: publishedJapanShippingServices,
    quote: (request, providers) => {
      const routed = routeRequest(request);
      return routed === undefined
        ? {
            kind: "unavailable_route",
            field: "shippingRoute.destinationCountry",
          }
        : quoteJapanShippingWithProviders(routed, providers);
    },
  };
}
