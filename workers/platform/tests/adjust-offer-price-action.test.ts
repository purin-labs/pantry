import { describe, expect, it } from "vitest";

import {
  commerceActionExpectedRevision,
  parseCommerceActionRequest,
} from "@purin-labs/area-commerce/server/action-model";

const VALID = {
  kind: "adjust_offer_price",
  offerId: "offer_matcha_latte",
  expectedOfferRevision: 5,
  expectedPolicyRevision: 2,
  proposedPriceMinor: 950,
  currency: "JPY",
};

describe("adjust_offer_price action requests", () => {
  it("accepts a well-formed price change and binds both revisions", () => {
    const parsed = parseCommerceActionRequest(VALID);
    if (!parsed.ok) throw new Error(`refused: ${parsed.error.code}`);
    expect(parsed.value).toEqual(VALID);
    // The Offer revision is what staleness is checked against downstream.
    expect(commerceActionExpectedRevision(parsed.value)).toBe(5);
  });

  it("refuses a zero or negative price rather than treating it as a discount", () => {
    for (const proposedPriceMinor of [0, -100]) {
      expect(
        parseCommerceActionRequest({ ...VALID, proposedPriceMinor }),
      ).toEqual({
        ok: false,
        error: { code: "commerce_action_invalid", field: "proposedPriceMinor" },
      });
    }
  });

  it("requires both the Offer and the policy revision", () => {
    expect(
      parseCommerceActionRequest({ ...VALID, expectedOfferRevision: 0 }),
    ).toEqual({
      ok: false,
      error: {
        code: "commerce_action_invalid",
        field: "expectedOfferRevision",
      },
    });
    // Without the policy revision, an approval could outlive the allowance it
    // was given under.
    expect(
      parseCommerceActionRequest({ ...VALID, expectedPolicyRevision: 0 }),
    ).toEqual({
      ok: false,
      error: {
        code: "commerce_action_invalid",
        field: "expectedPolicyRevision",
      },
    });
  });

  it("refuses a currency that is not a three-letter code", () => {
    for (const currency of ["jpy", "JPYEN", "¥"]) {
      expect(parseCommerceActionRequest({ ...VALID, currency })).toEqual({
        ok: false,
        error: { code: "commerce_action_invalid", field: "currency" },
      });
    }
  });

  it("refuses a request carrying fields from a different action", () => {
    expect(
      parseCommerceActionRequest({ ...VALID, salesChannelId: "channel_1" }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_action_invalid", field: "salesChannelId" },
    });
  });

  it("accepts the null-padded shape the proposal tool schema forces", () => {
    // The tool schema is one flat strict object covering every action kind, so
    // a model that obeys it sends the other kinds' fields explicitly as null.
    // Refusing that would make the action unproposable.
    expect(
      parseCommerceActionRequest({
        ...VALID,
        productId: null,
        productRevision: null,
        variantId: null,
        variantRevision: null,
        offerRevision: null,
        salesChannelId: null,
        salesChannelRevision: null,
        resourceId: null,
        expectedRevision: null,
        reason: null,
        refund: null,
        restock: null,
        notifyCustomer: null,
        note: null,
      }),
    ).toEqual({ ok: true, value: VALID });
  });

  it("refuses a request missing a required field", () => {
    const { currency: _currency, ...withoutCurrency } = VALID;
    expect(parseCommerceActionRequest(withoutCurrency)).toEqual({
      ok: false,
      error: { code: "commerce_action_invalid", field: "currency" },
    });
  });
});
