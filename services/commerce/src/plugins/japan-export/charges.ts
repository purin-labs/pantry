// Test tax and duty rules for shipping from Japan (Plan 76 phase 5).
import type { DutyIncoterm } from "@seams/commerce-contracts";

import {
  allocateJpyAcrossCheckoutLines,
  type CheckoutLineAllocationInput,
} from "../../checkout-line-allocation.ts";
import {
  MERCHANT_TAX_AUTHORITY_REFERENCE,
  dutyQuoteInputDigest,
  taxQuoteInputDigest,
  type CheckoutChargeQuoteProvider,
  type DutyQuoteProviderRequest,
  type DutyQuoteProviderResult,
  type InternationalDutyQuoteProviderRequest,
  type TaxQuoteProviderRequest,
  type TaxQuoteProviderResult,
} from "../../checkout-charge-provider.ts";
import type { VariantBy } from "@seams/type-utils";
import { assertNever, isNormalizedText } from "@seams/std";
import {
  COMMERCE_EUROPEAN_UNION_COUNTRIES,
  type CommerceShippingCountry,
} from "@seams/commerce-client";

type JpyMoney = Readonly<{ amountMinor: number; currency: "JPY" }>;

type TaxAccount = Readonly<{
  providerAccountReference: string;
  destinationCountries: readonly CommerceShippingCountry[];
  basisPoints: number;
}>;

type DutyAccount = Readonly<{
  providerAccountReference: string;
  destinationCountries: readonly CommerceShippingCountry[];
  incoterm: DutyIncoterm;
  basisPoints: number;
}>;

const EUROPEAN_UNION_VAT_BASIS_POINTS: Readonly<
  Record<(typeof COMMERCE_EUROPEAN_UNION_COUNTRIES)[number], number>
> = {
  AT: 2_000,
  BE: 2_100,
  BG: 2_000,
  CY: 1_900,
  CZ: 2_100,
  DE: 1_900,
  DK: 2_500,
  EE: 2_400,
  ES: 2_100,
  FI: 2_550,
  FR: 2_000,
  GR: 2_400,
  HR: 2_500,
  HU: 2_700,
  IE: 2_300,
  IT: 2_200,
  LT: 2_100,
  LU: 1_700,
  LV: 2_100,
  MT: 1_800,
  NL: 2_100,
  PL: 2_300,
  PT: 2_300,
  RO: 2_100,
  SE: 2_500,
  SI: 2_200,
  SK: 2_300,
};

const TAX_ACCOUNTS: readonly TaxAccount[] = [
  {
    providerAccountReference: "tax_account_jp_test",
    destinationCountries: ["JP"],
    basisPoints: 1_000,
  },
  {
    providerAccountReference: "tax_account_sg_test",
    destinationCountries: ["JP"],
    basisPoints: 1_000,
  },
  {
    providerAccountReference: "tax_account_sg_test",
    destinationCountries: ["SG"],
    basisPoints: 900,
  },
  // Export storefronts: Japanese consumption tax at home, Singapore and
  // Australian GST, no consumption tax collected for the United States, and
  // the standard VAT of each EU country under the import one-stop shop.
  {
    providerAccountReference: "tax_account_export_test",
    destinationCountries: ["JP"],
    basisPoints: 1_000,
  },
  {
    providerAccountReference: "tax_account_export_test",
    destinationCountries: ["SG"],
    basisPoints: 900,
  },
  {
    providerAccountReference: "tax_account_export_test",
    destinationCountries: ["AU"],
    basisPoints: 1_000,
  },
  {
    providerAccountReference: "tax_account_export_test",
    destinationCountries: ["US"],
    basisPoints: 0,
  },
  ...Object.entries(EUROPEAN_UNION_VAT_BASIS_POINTS).map(
    ([country, basisPoints]): TaxAccount => ({
      providerAccountReference: "tax_account_export_test",
      destinationCountries: [country as CommerceShippingCountry],
      basisPoints,
    }),
  ),
];

const DUTY_ACCOUNTS: readonly DutyAccount[] = [
  {
    providerAccountReference: "underclerk_domestic_duty_not_applicable",
    destinationCountries: ["JP"],
    incoterm: "not_applicable",
    basisPoints: 0,
  },
  {
    providerAccountReference: "singapore_duty_test",
    destinationCountries: ["SG"],
    incoterm: "ddp",
    basisPoints: 500,
  },
  {
    providerAccountReference: "singapore_duty_test",
    destinationCountries: ["SG"],
    incoterm: "dap",
    basisPoints: 0,
  },
  // Australia: no duty on goods up to AUD 1,000. United States: duty on
  // every import since the end of de minimis, at the 15% rate for Japan.
  // European Union: no duty on goods up to EUR 150.
  {
    providerAccountReference: "australia_duty_test",
    destinationCountries: ["AU"],
    incoterm: "ddp",
    basisPoints: 0,
  },
  {
    providerAccountReference: "australia_duty_test",
    destinationCountries: ["AU"],
    incoterm: "dap",
    basisPoints: 0,
  },
  {
    providerAccountReference: "united_states_duty_test",
    destinationCountries: ["US"],
    incoterm: "ddp",
    basisPoints: 1_500,
  },
  {
    providerAccountReference: "united_states_duty_test",
    destinationCountries: ["US"],
    incoterm: "dap",
    basisPoints: 0,
  },
  {
    providerAccountReference: "european_union_duty_test",
    destinationCountries: COMMERCE_EUROPEAN_UNION_COUNTRIES,
    incoterm: "ddp",
    basisPoints: 0,
  },
  {
    providerAccountReference: "european_union_duty_test",
    destinationCountries: COMMERCE_EUROPEAN_UNION_COUNTRIES,
    incoterm: "dap",
    basisPoints: 0,
  },
];

export class DeterministicJapanCheckoutChargeQuoteProvider implements CheckoutChargeQuoteProvider {
  quoteTax(request: TaxQuoteProviderRequest): TaxQuoteProviderResult {
    const taxableAmountMinor = sumTaxableAmount(
      request.lines,
      request.shippingAmount,
    );
    const inputDigest = taxQuoteInputDigest(request);
    const calculation = resolveTaxCalculation(request);
    if (calculation === undefined) {
      return { kind: "unavailable", field: "shippingRoute.taxBinding" };
    }
    const taxAmountMinor = percentageOf(
      taxableAmountMinor,
      calculation.basisPoints,
    );
    return {
      kind: "quoted",
      quote: {
        providerAccountReference: request.providerAccountReference,
        registrationPolicyReference: calculation.policyReference,
        quoteReference: `tax_${inputDigest}`,
        taxAmount: { amountMinor: taxAmountMinor, currency: "JPY" },
        lineAllocations: allocateJpyAcrossCheckoutLines(
          taxAmountMinor,
          request.lines.map(toTaxAllocationInput),
        ),
      },
      inputDigest,
      expiresAt: requireQuoteWindow(request.quotedAt, request.expiresAt),
    };
  }

  quoteDuty(request: DutyQuoteProviderRequest): DutyQuoteProviderResult {
    const account = findDutyAccount(request);
    if (account === undefined) {
      return { kind: "unavailable", field: "shippingRoute.dutyBinding" };
    }
    const declaredAmountMinor = sumDeclaredAmount(request);
    const inputDigest = dutyQuoteInputDigest(request);
    const dutyAmountMinor = percentageOf(
      declaredAmountMinor,
      account.basisPoints,
    );
    return {
      kind: "quoted",
      quote: {
        providerAccountReference: account.providerAccountReference,
        quoteReference: `duty_${inputDigest}`,
        incoterm: account.incoterm,
        dutyAmount: { amountMinor: dutyAmountMinor, currency: "JPY" },
        lineAllocations: allocateJpyAcrossCheckoutLines(
          dutyAmountMinor,
          dutyAllocationInputs(request),
        ),
      },
      inputDigest,
      expiresAt: requireQuoteWindow(request.quotedAt, request.expiresAt),
    };
  }
}

function toTaxAllocationInput(
  line: TaxQuoteProviderRequest["lines"][number],
): CheckoutLineAllocationInput {
  return {
    checkoutLineId: line.checkoutLineId,
    weightMinor: line.amount.amountMinor,
  };
}

function dutyAllocationInputs(
  request: DutyQuoteProviderRequest,
): readonly CheckoutLineAllocationInput[] {
  return request.destinationCountry === "JP"
    ? request.lines.map(toDutyAllocationInput)
    : request.customsLines.map(toDutyAllocationInput);
}

function toDutyAllocationInput(
  line: Readonly<{ checkoutLineId: string; declaredValue: JpyMoney }>,
): CheckoutLineAllocationInput {
  return {
    checkoutLineId: line.checkoutLineId,
    weightMinor: line.declaredValue.amountMinor,
  };
}

function findTaxAccount(
  request: TaxQuoteProviderRequest,
): TaxAccount | undefined {
  if (request.kind !== "provider_quoted") return undefined;
  for (const account of TAX_ACCOUNTS) {
    if (
      account.providerAccountReference === request.providerAccountReference &&
      account.destinationCountries.includes(request.destinationCountry)
    )
      return account;
  }
  return undefined;
}

function resolveTaxCalculation(
  request: TaxQuoteProviderRequest,
): Readonly<{ basisPoints: number; policyReference: string }> | undefined {
  switch (request.kind) {
    case "provider_quoted": {
      const account = findTaxAccount(request);
      return account !== undefined &&
        validTaxRegistrationPolicy(request.registrationPolicyReference)
        ? {
            basisPoints: account.basisPoints,
            policyReference: request.registrationPolicyReference,
          }
        : undefined;
    }
    case "merchant_percentage":
      return validMerchantTaxPolicy(
        request.providerAccountReference,
        request.jurisdictionPolicyReference,
        request.basisPoints,
      )
        ? {
            basisPoints: request.basisPoints,
            policyReference: request.jurisdictionPolicyReference,
          }
        : undefined;
    default:
      return assertNever(request, "Unsupported tax calculation");
  }
}

function findDutyAccount(
  request: DutyQuoteProviderRequest,
): DutyAccount | undefined {
  for (const account of DUTY_ACCOUNTS) {
    if (
      account.providerAccountReference === request.providerAccountReference &&
      account.destinationCountries.includes(request.destinationCountry) &&
      account.incoterm === request.incoterm
    )
      return account;
  }
  return undefined;
}

function validTaxRegistrationPolicy(value: string): boolean {
  return (
    value.startsWith("tax_registration_") &&
    value.length > "tax_registration_".length &&
    value === value.trim()
  );
}

function validMerchantTaxPolicy(
  providerAccountReference: string,
  policyReference: string,
  basisPoints: number,
): boolean {
  return (
    providerAccountReference === MERCHANT_TAX_AUTHORITY_REFERENCE &&
    policyReference.length > 0 &&
    policyReference === policyReference.trim() &&
    Number.isSafeInteger(basisPoints) &&
    basisPoints >= 0 &&
    basisPoints <= 10_000
  );
}

function sumTaxableAmount(
  lines: TaxQuoteProviderRequest["lines"],
  shippingAmount: JpyMoney,
): number {
  let amountMinor = requireJpyAmount(shippingAmount, "tax.shippingAmount");
  for (const line of lines) {
    requireText(line.checkoutLineId, "tax.checkoutLineId");
    amountMinor = safeAdd(
      amountMinor,
      requireJpyAmount(line.amount, "tax.lineAmount"),
      "taxable amount",
    );
  }
  return amountMinor;
}

function sumDeclaredAmount(request: DutyQuoteProviderRequest): number {
  return request.destinationCountry === "JP"
    ? sumDomesticDeclaredAmount(request.lines)
    : sumInternationalDeclaredAmount(request.customsLines);
}

function sumDomesticDeclaredAmount(
  lines: VariantBy<
    DutyQuoteProviderRequest,
    "destinationCountry",
    "JP"
  >["lines"],
): number {
  let amountMinor = 0;
  for (const line of lines) {
    requireText(line.checkoutLineId, "duty.checkoutLineId");
    amountMinor = safeAdd(
      amountMinor,
      requireJpyAmount(line.declaredValue, "duty.declaredValue"),
      "declared amount",
    );
  }
  return amountMinor;
}

function sumInternationalDeclaredAmount(
  lines: InternationalDutyQuoteProviderRequest["customsLines"],
): number {
  let amountMinor = 0;
  for (const line of lines) {
    requireText(line.checkoutLineId, "duty.checkoutLineId");
    requireText(line.countryOfOrigin, "duty.countryOfOrigin");
    requireText(line.hsCode, "duty.hsCode");
    amountMinor = safeAdd(
      amountMinor,
      requireJpyAmount(line.declaredValue, "duty.declaredValue"),
      "declared amount",
    );
  }
  return amountMinor;
}

function requireJpyAmount(value: JpyMoney, field: string): number {
  if (
    value.currency !== "JPY" ||
    !Number.isSafeInteger(value.amountMinor) ||
    value.amountMinor < 0
  ) {
    throw new Error(`${field} must be a non-negative JPY amount`);
  }
  return value.amountMinor;
}

function requireQuoteWindow(quotedAt: string, expiresAt: string): string {
  const quotedTime = Date.parse(quotedAt);
  const expiryTime = Date.parse(expiresAt);
  if (
    !Number.isFinite(quotedTime) ||
    !Number.isFinite(expiryTime) ||
    expiryTime <= quotedTime
  ) {
    throw new Error("Charge quote requires a future expiry");
  }
  return expiresAt;
}

function requireText(value: string, field: string): void {
  if (!isNormalizedText(value)) {
    throw new Error(`${field} must be normalized text`);
  }
}

function safeAdd(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result))
    throw new Error(`${field} exceeds the safe range`);
  return result;
}

function percentageOf(amountMinor: number, basisPoints: number): number {
  const scaled = BigInt(amountMinor) * BigInt(basisPoints);
  const amount = (scaled + 5_000n) / 10_000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Charge quote exceeds the safe range");
  }
  return Number(amount);
}
