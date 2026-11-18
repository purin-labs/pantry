// The tax and duty contract of a shipping quote. A regional shipping
// plugin supplies the provider (src/plugins/japan-export/); the core keeps
// each quote durable (checkout-charge-attempt.ts).
import { createHash } from "node:crypto";

import type {
  DutyQuoteSnapshot,
  InternationalDutyIncoterm,
  TaxQuoteSnapshot,
} from "@seams/commerce-contracts";
import type { CommerceShippingCountry } from "@seams/commerce-client";

type JpyMoney = Readonly<{ amountMinor: number; currency: "JPY" }>;

export const MERCHANT_TAX_AUTHORITY_REFERENCE =
  "underclerk_merchant_tax_authority";

type TaxQuoteProviderRequestBase = Readonly<{
  providerAccountReference: string;
  destinationCountry: CommerceShippingCountry;
  lines: readonly Readonly<{
    checkoutLineId: string;
    amount: JpyMoney;
  }>[];
  shippingAmount: JpyMoney;
  addressDigest: string;
  quotedAt: string;
  expiresAt: string;
}>;

export type TaxCalculation =
  | Readonly<{
      kind: "provider_quoted";
      registrationPolicyReference: string;
      jurisdictionPolicyReference?: never;
      basisPoints?: never;
    }>
  | Readonly<{
      kind: "merchant_percentage";
      jurisdictionPolicyReference: string;
      basisPoints: number;
      registrationPolicyReference?: never;
    }>;

export type TaxQuoteProviderRequest = TaxQuoteProviderRequestBase &
  TaxCalculation;

type DutyQuoteProviderRequestBase = Readonly<{
  providerAccountReference: string;
  addressDigest: string;
  quotedAt: string;
  expiresAt: string;
}>;

export type DutyQuoteProviderRequest =
  | (DutyQuoteProviderRequestBase &
      Readonly<{
        destinationCountry: "JP";
        incoterm: "not_applicable";
        lines: readonly Readonly<{
          checkoutLineId: string;
          declaredValue: JpyMoney;
        }>[];
      }>)
  | (DutyQuoteProviderRequestBase &
      Readonly<{
        destinationCountry: Exclude<CommerceShippingCountry, "JP">;
        incoterm: InternationalDutyIncoterm;
        customsLines: readonly Readonly<{
          checkoutLineId: string;
          declaredValue: JpyMoney;
          countryOfOrigin: string;
          hsCode: string;
        }>[];
      }>);

/** A duty request for any destination outside Japan. */
export type InternationalDutyQuoteProviderRequest = Exclude<
  DutyQuoteProviderRequest,
  Readonly<{ destinationCountry: "JP" }>
>;

export type TaxQuoteProviderResult =
  | Readonly<{
      kind: "quoted";
      quote: TaxQuoteSnapshot;
      inputDigest: string;
      expiresAt: string;
    }>
  | Readonly<{ kind: "unavailable"; field: string }>
  | Readonly<{ kind: "indeterminate"; field: string; retryAfter: string }>;

export type DutyQuoteProviderResult =
  | Readonly<{
      kind: "quoted";
      quote: DutyQuoteSnapshot;
      inputDigest: string;
      expiresAt: string;
    }>
  | Readonly<{ kind: "unavailable"; field: string }>
  | Readonly<{ kind: "indeterminate"; field: string; retryAfter: string }>;

export interface CheckoutChargeQuoteProvider {
  quoteTax(request: TaxQuoteProviderRequest): TaxQuoteProviderResult;
  quoteDuty(request: DutyQuoteProviderRequest): DutyQuoteProviderResult;
}

export function taxQuoteInputDigest(request: TaxQuoteProviderRequest): string {
  return sha256(JSON.stringify(request));
}

export function dutyQuoteInputDigest(
  request: DutyQuoteProviderRequest,
): string {
  return sha256(JSON.stringify(request));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
