import { describe, expect, it } from "vitest";

import {
  MAX_MOVEMENT_BPS,
  allowedPriceRange,
  decideOfferPriceChange,
  validateEnabledPolicy,
  type OfferPricePolicy,
} from "../src/commerce-authority/offer-pricing";
import type { Variant } from "@seams/type-utils";

const OFFER = "offer_matcha_latte";

/** Reference 1,000 JPY with a 10% allowance: 900 through 1,100. */
function enabledPolicy(
  overrides: Partial<Variant<OfferPricePolicy, "enabled">> = {},
) {
  return {
    kind: "enabled" as const,
    offerId: OFFER,
    revision: 2,
    referenceOfferRevision: 5,
    referencePriceMinor: 1_000,
    currency: "JPY",
    maxMovementBps: 1_000,
    ...overrides,
  };
}

function decide(
  overrides: {
    policy?: OfferPricePolicy;
    proposedPriceMinor?: number;
    currentPriceMinor?: number;
    currentOfferRevision?: number;
    expectedOfferRevision?: number;
    expectedPolicyRevision?: number;
    currency?: string;
    currentCurrency?: string;
  } = {},
) {
  return decideOfferPriceChange({
    policy: overrides.policy ?? enabledPolicy(),
    request: {
      offerId: OFFER,
      expectedOfferRevision: overrides.expectedOfferRevision ?? 5,
      expectedPolicyRevision: overrides.expectedPolicyRevision ?? 2,
      proposedPriceMinor: overrides.proposedPriceMinor ?? 950,
      currency: overrides.currency ?? "JPY",
    },
    currentOfferRevision: overrides.currentOfferRevision ?? 5,
    currentPriceMinor: overrides.currentPriceMinor ?? 1_000,
    currentCurrency: overrides.currentCurrency ?? "JPY",
  });
}

describe("Offer price policy", () => {
  it("allows a change exactly at the limit and refuses one minor unit past it", () => {
    expect(decide({ proposedPriceMinor: 900 }).ok).toBe(true);
    expect(decide({ proposedPriceMinor: 1_100 }).ok).toBe(true);
    expect(decide({ proposedPriceMinor: 899 })).toEqual({
      ok: false,
      refusal: { code: "offer_price_movement_exceeded" },
    });
    expect(decide({ proposedPriceMinor: 1_101 })).toEqual({
      ok: false,
      refusal: { code: "offer_price_movement_exceeded" },
    });
  });

  it("refuses a currency that does not match the policy or the Offer", () => {
    expect(decide({ currency: "USD" })).toEqual({
      ok: false,
      refusal: { code: "offer_price_policy_currency_mismatch" },
    });
    expect(decide({ currentCurrency: "USD" })).toEqual({
      ok: false,
      refusal: { code: "offer_price_policy_currency_mismatch" },
    });
  });

  it("refuses a zero or negative price on any side", () => {
    expect(decide({ proposedPriceMinor: 0 })).toEqual({
      ok: false,
      refusal: { code: "offer_price_not_positive" },
    });
    expect(decide({ currentPriceMinor: 0 })).toEqual({
      ok: false,
      refusal: { code: "offer_price_not_positive" },
    });
    expect(
      decide({ policy: enabledPolicy({ referencePriceMinor: 0 }) }),
    ).toEqual({
      ok: false,
      refusal: { code: "offer_price_not_positive" },
    });
  });

  it("refuses a change that moves nothing", () => {
    expect(
      decide({ proposedPriceMinor: 1_000, currentPriceMinor: 1_000 }),
    ).toEqual({
      ok: false,
      refusal: { code: "offer_price_unchanged" },
    });
  });

  it("refuses every change when the allowance is zero", () => {
    const frozen = enabledPolicy({ maxMovementBps: 0 });
    expect(decide({ policy: frozen, proposedPriceMinor: 1_001 })).toEqual({
      ok: false,
      refusal: { code: "offer_price_movement_exceeded" },
    });
    expect(decide({ policy: frozen, proposedPriceMinor: 999 })).toEqual({
      ok: false,
      refusal: { code: "offer_price_movement_exceeded" },
    });
  });

  it("reports the allowed range as prices and never below one minor unit", () => {
    expect(allowedPriceRange(enabledPolicy())).toEqual({
      minimumMinor: 900,
      maximumMinor: 1_100,
    });
    // A full allowance would put the floor at zero, which no price may take.
    expect(
      allowedPriceRange(enabledPolicy({ maxMovementBps: MAX_MOVEMENT_BPS })),
    ).toEqual({ minimumMinor: 1, maximumMinor: 2_000 });
  });

  it("rounds a displayed movement down so it never overstates the movement", () => {
    // 100 of 3,000 is 3.333...%, which must not display as more movement than
    // actually happened.
    const result = decide({
      policy: enabledPolicy({ referencePriceMinor: 3_000 }),
      proposedPriceMinor: 2_900,
      currentPriceMinor: 3_000,
    });
    if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
    expect(result.decision.movementFromReferenceBps).toBe(333);
  });

  it("keeps the displayed movement inside the limit at the exact boundary", () => {
    // A change allowed at exactly the limit must not display as over it.
    const result = decide({ proposedPriceMinor: 900 });
    if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
    expect(result.decision.movementFromReferenceBps).toBe(
      result.decision.maxMovementBps,
    );
  });

  it("rejects a malformed policy before it can be stored", () => {
    const valid = {
      referenceOfferRevision: 5,
      referencePriceMinor: 1_000,
      currency: "JPY",
      maxMovementBps: 1_000,
    };
    expect(validateEnabledPolicy(valid)).toBeNull();
    expect(validateEnabledPolicy({ ...valid, referencePriceMinor: 0 })).toEqual(
      { code: "offer_price_policy_invalid", field: "referencePriceMinor" },
    );
    expect(
      validateEnabledPolicy({ ...valid, maxMovementBps: MAX_MOVEMENT_BPS + 1 }),
    ).toEqual({ code: "offer_price_policy_invalid", field: "maxMovementBps" });
    expect(validateEnabledPolicy({ ...valid, maxMovementBps: -1 })).toEqual({
      code: "offer_price_policy_invalid",
      field: "maxMovementBps",
    });
    expect(validateEnabledPolicy({ ...valid, currency: "jpy" })).toEqual({
      code: "offer_price_policy_invalid",
      field: "currency",
    });
    expect(
      validateEnabledPolicy({ ...valid, referenceOfferRevision: 0 }),
    ).toEqual({
      code: "offer_price_policy_invalid",
      field: "referenceOfferRevision",
    });
  });
});
