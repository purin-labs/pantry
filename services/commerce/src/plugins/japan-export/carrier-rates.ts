// Japan Post and Yamato test rates from Tokyo (Plan 76 phase 5).
import {
  allocateJpyAcrossCheckoutLines,
  type CheckoutLineAllocationInput,
} from "../../checkout-line-allocation.ts";
import {
  carrierRateQuoteInputDigest,
  type CarrierRateQuoteProvider,
  type CarrierRateQuoteProviderRequest,
  type CarrierRateQuoteProviderResult,
} from "../../checkout-carrier-rate-provider.ts";
import { isNormalizedText } from "@seams/std";
import {
  COMMERCE_EUROPEAN_UNION_COUNTRIES,
  type CommerceShippingCountry,
} from "@seams/commerce-client";

type JapanCarrierRate = Readonly<{
  providerAccountReference: string;
  destinationCountries: readonly CommerceShippingCountry[];
  service: Readonly<{ code: string; name: string }>;
  shippingAmountMinor: number;
  earliestDeliveryDays: number;
  latestDeliveryDays: number;
}>;

const JAPAN_CARRIER_RATES: readonly JapanCarrierRate[] = [
  {
    providerAccountReference: "yamato_transport_test",
    destinationCountries: ["JP"],
    service: { code: "takkyubin_test", name: "Yamato Takkyubin Test" },
    shippingAmountMinor: 900,
    earliestDeliveryDays: 1,
    latestDeliveryDays: 2,
  },
  {
    providerAccountReference: "yamato_transport_test",
    destinationCountries: ["JP"],
    service: {
      code: "takkyubin_priority_test",
      name: "Yamato Takkyubin Priority Test",
    },
    shippingAmountMinor: 1_300,
    earliestDeliveryDays: 1,
    latestDeliveryDays: 1,
  },
  {
    providerAccountReference: "japan_post_ems_test",
    destinationCountries: ["SG"],
    service: { code: "ems_test", name: "Japan Post EMS Test" },
    shippingAmountMinor: 2_200,
    earliestDeliveryDays: 3,
    latestDeliveryDays: 5,
  },
  {
    providerAccountReference: "japan_post_ems_test",
    destinationCountries: ["SG"],
    service: {
      code: "international_parcel_air_test",
      name: "Japan Post Air Parcel Test",
    },
    shippingAmountMinor: 1_800,
    earliestDeliveryDays: 6,
    latestDeliveryDays: 9,
  },
  {
    providerAccountReference: "japan_post_ems_test",
    destinationCountries: ["AU"],
    service: { code: "ems_test", name: "Japan Post EMS Test" },
    shippingAmountMinor: 3_150,
    earliestDeliveryDays: 3,
    latestDeliveryDays: 6,
  },
  {
    providerAccountReference: "japan_post_ems_test",
    destinationCountries: ["AU"],
    service: {
      code: "international_parcel_air_test",
      name: "Japan Post Air Parcel Test",
    },
    shippingAmountMinor: 2_600,
    earliestDeliveryDays: 6,
    latestDeliveryDays: 10,
  },
  {
    providerAccountReference: "japan_post_ems_test",
    destinationCountries: ["US"],
    service: { code: "ems_test", name: "Japan Post EMS Test" },
    shippingAmountMinor: 3_900,
    earliestDeliveryDays: 3,
    latestDeliveryDays: 6,
  },
  {
    providerAccountReference: "japan_post_ems_test",
    destinationCountries: ["US"],
    service: {
      code: "international_parcel_air_test",
      name: "Japan Post Air Parcel Test",
    },
    shippingAmountMinor: 3_000,
    earliestDeliveryDays: 6,
    latestDeliveryDays: 12,
  },
  {
    providerAccountReference: "japan_post_ems_test",
    destinationCountries: COMMERCE_EUROPEAN_UNION_COUNTRIES,
    service: { code: "ems_test", name: "Japan Post EMS Test" },
    shippingAmountMinor: 4_100,
    earliestDeliveryDays: 4,
    latestDeliveryDays: 7,
  },
  {
    providerAccountReference: "japan_post_ems_test",
    destinationCountries: COMMERCE_EUROPEAN_UNION_COUNTRIES,
    service: {
      code: "international_parcel_air_test",
      name: "Japan Post Air Parcel Test",
    },
    shippingAmountMinor: 3_300,
    earliestDeliveryDays: 7,
    latestDeliveryDays: 12,
  },
];

export class DeterministicJapanCarrierRateQuoteProvider implements CarrierRateQuoteProvider {
  quoteRate(
    request: CarrierRateQuoteProviderRequest,
  ): CarrierRateQuoteProviderResult {
    requireCarrierRateRequest(request);
    const configuredRate = findJapanCarrierRate(request);
    if (configuredRate === undefined) {
      return { kind: "unavailable", field: "shippingRoute.carrierRateBinding" };
    }
    const inputDigest = carrierRateQuoteInputDigest(request);
    return {
      kind: "quoted",
      rate: {
        providerAccountReference: configuredRate.providerAccountReference,
        rateReference: `rate_${inputDigest}`,
        service: configuredRate.service,
        shippingAmount: {
          amountMinor: configuredRate.shippingAmountMinor,
          currency: "JPY",
        },
        lineAllocations: allocateJpyAcrossCheckoutLines(
          configuredRate.shippingAmountMinor,
          request.lines.map(toAllocationInput),
        ),
      },
      estimatedDelivery: {
        kind: "window",
        earliest: timestampAfterDays(
          request.quotedAt,
          configuredRate.earliestDeliveryDays,
        ),
        latest: timestampAfterDays(
          request.quotedAt,
          configuredRate.latestDeliveryDays,
        ),
      },
      inputDigest,
      expiresAt: request.expiresAt,
    };
  }
}

function findJapanCarrierRate(
  request: CarrierRateQuoteProviderRequest,
): JapanCarrierRate | undefined {
  for (const configuredRate of JAPAN_CARRIER_RATES) {
    if (
      configuredRate.providerAccountReference ===
        request.providerAccountReference &&
      configuredRate.destinationCountries.includes(
        request.destinationCountry,
      ) &&
      configuredRate.service.code === request.selectedServiceCode
    ) {
      return configuredRate;
    }
  }
  return undefined;
}

function requireCarrierRateRequest(
  request: CarrierRateQuoteProviderRequest,
): void {
  requireText(
    request.providerAccountReference,
    "carrierRate.providerAccountReference",
  );
  requireText(request.selectedServiceCode, "carrierRate.selectedServiceCode");
  requireDigest(request.packagePlanDigest, "carrierRate.packagePlanDigest");
  requireDigest(request.addressDigest, "carrierRate.addressDigest");
  if (
    request.lines.length === 0 ||
    !Number.isSafeInteger(request.package.weight.grams) ||
    request.package.weight.grams <= 0
  ) {
    throw new Error("Carrier rate quote requires a non-empty positive package");
  }
  requirePositiveDimension(request.package.dimensions.lengthMillimeters);
  requirePositiveDimension(request.package.dimensions.widthMillimeters);
  requirePositiveDimension(request.package.dimensions.heightMillimeters);
  const quotedTime = Date.parse(request.quotedAt);
  const expiryTime = Date.parse(request.expiresAt);
  if (
    !Number.isFinite(quotedTime) ||
    !Number.isFinite(expiryTime) ||
    expiryTime <= quotedTime
  ) {
    throw new Error("Carrier rate quote requires a future expiry");
  }
  for (const line of request.lines) {
    requireText(line.checkoutLineId, "carrierRate.checkoutLineId");
    if (
      line.amount.currency !== "JPY" ||
      !Number.isSafeInteger(line.amount.amountMinor) ||
      line.amount.amountMinor < 0
    ) {
      throw new Error(
        "Carrier rate quote requires non-negative JPY line amounts",
      );
    }
  }
}

function requirePositiveDimension(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Carrier rate quote requires positive package dimensions");
  }
}

function toAllocationInput(
  line: CarrierRateQuoteProviderRequest["lines"][number],
): CheckoutLineAllocationInput {
  return {
    checkoutLineId: line.checkoutLineId,
    weightMinor: line.amount.amountMinor,
  };
}

function timestampAfterDays(timestamp: string, days: number): string {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds))
    throw new Error("Carrier rate quote time is invalid");
  return new Date(milliseconds + days * 86_400_000).toISOString();
}

function requireText(value: string, field: string): void {
  if (!isNormalizedText(value)) {
    throw new Error(`${field} must be normalized text`);
  }
}

function requireDigest(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value))
    throw new Error(`${field} must be a SHA-256 digest`);
}
