// The carrier rate contract of a shipping quote. A regional shipping
// plugin supplies the provider (src/plugins/japan-export/); the core keeps
// each rate durable (checkout-charge-attempt.ts).
import { createHash } from "node:crypto";

import type {
  CarrierRateSnapshot,
  EstimatedDeliverySnapshot,
} from "@purin-labs/commerce-contracts";
import type { CommerceShippingCountry } from "@purin-labs/commerce-client";

type JpyMoney = Readonly<{ amountMinor: number; currency: "JPY" }>;

export type CarrierRateQuoteProviderRequest = Readonly<{
  providerAccountReference: string;
  originCountry: "JP";
  destinationCountry: CommerceShippingCountry;
  selectedServiceCode: string;
  packagePlanDigest: string;
  package: Readonly<{
    weight: Readonly<{ grams: number }>;
    dimensions: Readonly<{
      lengthMillimeters: number;
      widthMillimeters: number;
      heightMillimeters: number;
    }>;
  }>;
  lines: readonly Readonly<{
    checkoutLineId: string;
    amount: JpyMoney;
  }>[];
  addressDigest: string;
  quotedAt: string;
  expiresAt: string;
}>;

export type CarrierRateQuoteProviderResult =
  | Readonly<{
      kind: "quoted";
      rate: CarrierRateSnapshot;
      estimatedDelivery: EstimatedDeliverySnapshot;
      inputDigest: string;
      expiresAt: string;
    }>
  | Readonly<{ kind: "unavailable"; field: string }>
  | Readonly<{ kind: "indeterminate"; field: string; retryAfter: string }>;

export interface CarrierRateQuoteProvider {
  quoteRate(
    request: CarrierRateQuoteProviderRequest,
  ): CarrierRateQuoteProviderResult;
}

export function carrierRateQuoteInputDigest(
  request: CarrierRateQuoteProviderRequest,
): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}
