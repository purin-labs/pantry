import { describe, expect, it } from "vitest";

import type { SupplierPayoutRow } from "@purin-labs/area-commerce/server/data/supplier-payout-store";
import {
  renderOutgoingPayouts,
  renderPayoutApprovalCard,
  renderPayoutOutcome,
  type PayoutApprovalCard,
} from "@purin-labs/surface-slack/server/supplier-payout-cards";

function card(overrides: Partial<PayoutApprovalCard> = {}): PayoutApprovalCard {
  return {
    supplierId: "supplier_1",
    payableId: "supplier_payable_1",
    rail: "gmo_aozora_private",
    maskedDestination: "Sumitomo ****1234",
    destinationRevisionId: "destination_revision_1",
    currency: "JPY",
    recipientAmountMinor: 10_000,
    observedFeeMinor: 330,
    feeCeilingMinor: 500,
    rate: null,
    rateExpiresAt: null,
    executionDeadline: "2026-09-07T00:00:00Z",
    ...overrides,
  };
}

function payout(overrides: Partial<SupplierPayoutRow> = {}): SupplierPayoutRow {
  return {
    payoutId: "supplier_payout_1",
    payableId: "supplier_payable_1",
    supplierId: "supplier_1",
    purchaseRequestId: "purchase_request_1",
    rail: "gmo_aozora_private",
    integrationAccountId: "integration_gmo",
    destinationRevisionId: "destination_revision_1",
    currency: "JPY",
    recipientAmountMinor: 10_000,
    feeCeilingMinor: 500,
    idempotencyKey: "payout-request-1",
    stateKind: "provider_pending",
    approvalDigest: "ab".repeat(32),
    payoutJson: "{}",
    revision: 1,
    ...overrides,
  };
}

describe("supplier payout Slack cards", function payoutCardSuite() {
  it("states the exact economics on an approval card", function economics() {
    const rendered = renderPayoutApprovalCard(card());
    expect(rendered).toContain("10,000 JPY");
    expect(rendered).toContain("330 JPY");
    expect(rendered).toContain("ceiling 500 JPY");
    expect(rendered).toContain("Sumitomo ****1234");
    expect(rendered).toContain("destination_revision_1");
  });

  it("renders a minor unit currency with its decimals", function eur() {
    const rendered = renderPayoutApprovalCard(
      card({
        currency: "EUR",
        recipientAmountMinor: 6_500,
        observedFeeMinor: 400,
        feeCeilingMinor: 600,
      }),
    );
    expect(rendered).toContain("65.00 EUR");
    expect(rendered).toContain("4.00 EUR");
  });

  it("shows an FX rate only when there is one", function rate() {
    expect(renderPayoutApprovalCard(card())).not.toContain("Rate:");
    const cross = renderPayoutApprovalCard(
      card({
        rail: "wise_enterprise_payouts",
        rate: "0.00612",
        rateExpiresAt: "2026-09-05T00:30:00Z",
      }),
    );
    expect(cross).toContain("Rate: 0.00612");
    expect(cross).toContain("expires 2026-09-05T00:30:00Z");
  });

  it("never calls an unknown outcome a failure", function indeterminate() {
    const rendered = renderPayoutOutcome(
      payout({ stateKind: "indeterminate" }),
    );
    // Telling an operator a payment failed when Pantry does not know is how a
    // supplier gets paid twice.
    expect(rendered).toMatch(/outcome unknown/u);
    expect(rendered).toMatch(/do not send again/u);
    expect(rendered).not.toMatch(/failed|refused/u);
  });

  it("says a returned payment re-owes the payable", function returned() {
    expect(renderPayoutOutcome(payout({ stateKind: "returned" }))).toMatch(
      /owed again/u,
    );
    expect(renderPayoutOutcome(payout({ stateKind: "reversed" }))).toMatch(
      /owed again/u,
    );
  });

  it("groups outstanding payments by rail", function grouped() {
    const rendered = renderOutgoingPayouts([
      payout(),
      payout({
        payoutId: "supplier_payout_2",
        rail: "wise_enterprise_payouts",
        currency: "EUR",
        recipientAmountMinor: 6_500,
        supplierId: "supplier_2",
      }),
    ]);
    // The question about a stuck payment is usually "is this rail having a bad
    // day", and a flat list buries that.
    expect(rendered).toContain("*GMO Aozora* — 1 outstanding");
    expect(rendered).toContain("*Wise* — 1 outstanding");
    expect(rendered).toContain("65.00 EUR");
  });
});
