/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import { formatOfferPrice } from "../../../apps/portal/src/features/governed-actions/commerce";
import { parseCommerceActionRecordResponse } from "@purin-labs/commerce-control-api/portal/commerce-actions";
import { parseCommerceActionPath } from "../src/commerce/action-model";

const ACTION_NONCE = "nonce_offer_price_portal";

describe("Offer price approval surface", () => {
  it("parses a served price change the operator has to approve", () => {
    // Before this branch existed the Portal threw "Commerce action details are
    // invalid." on the whole record, so a price change could be proposed but
    // never seen, let alone approved.
    const record = parseCommerceActionRecordResponse(servedAction());

    expect(record).toMatchObject({
      state: "approval_requested",
      verb: "commerce.offer.adjust_price",
      details: {
        kind: "adjust_offer_price",
        offerId: "commerce:merchant_cafe:offer_coffee",
        expectedOfferRevision: 4,
        expectedPolicyRevision: 2,
        proposedPriceMinor: 950,
        currency: "JPY",
      },
    });
  });

  it("refuses a served price change whose currency is not a code", () => {
    expect(() =>
      parseCommerceActionRecordResponse(servedAction({ currency: "yen" })),
    ).toThrow("Offer price change details are invalid.");
  });

  it("refuses a served price change with no allowance revision", () => {
    expect(() =>
      parseCommerceActionRecordResponse(
        servedAction({ expectedPolicyRevision: 0 }),
      ),
    ).toThrow("Offer price change details are invalid.");
  });

  it("renders minor units at the currency's own exponent", () => {
    // A yen price is not 9.50, and a dollar price is not 950. Dividing by a
    // fixed hundred would misprice one of them by a factor of a hundred on the
    // screen where someone approves it.
    expect(formatOfferPrice(950, "JPY")).toContain("950");
    expect(formatOfferPrice(950, "USD")).toContain("9.50");
  });

  it("reads back the approved change from the recorded action path", () => {
    // The ledger stores a verb and a path, not the request object. What the
    // executor applies is whatever this parse returns, so it has to reproduce
    // the change the operator approved, revision for revision.
    expect(
      parseCommerceActionPath({
        verb: "commerce.offer.adjust_price",
        path:
          "/offers/commerce%3Amerchant_cafe%3Aoffer_coffee/price" +
          "?expected_revision=4&expected_policy_revision=2" +
          "&proposed_price_minor=950&currency=JPY",
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "adjust_offer_price",
        offerId: "commerce:merchant_cafe:offer_coffee",
        expectedOfferRevision: 4,
        expectedPolicyRevision: 2,
        proposedPriceMinor: 950,
        currency: "JPY",
      },
    });
  });
});

function servedAction(
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    ok: true,
    action: {
      nonce: { value: ACTION_NONCE },
      caseId: "case_offer_price",
      proposalId: "proposal_offer_price",
      resourceKey:
        "commerce:adjust_offer_price:commerce:merchant_cafe:offer_coffee",
      amount: null,
      state: "approval_requested",
      verb: "commerce.offer.adjust_price",
      commerceSystem: {
        kind: "commerce_system",
        system: "builtin_commerce",
        revision: 3,
      },
      details: {
        kind: "adjust_offer_price",
        offerId: "commerce:merchant_cafe:offer_coffee",
        expectedOfferRevision: 4,
        expectedPolicyRevision: 2,
        proposedPriceMinor: 950,
        currency: "JPY",
        ...overrides,
      },
    },
  };
}
