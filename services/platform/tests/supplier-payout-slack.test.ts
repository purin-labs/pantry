/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import { parseSupplierPayoutQuery } from "@purin-labs/surface-slack/server/supplier-payout-command";

function message(text: string, trigger: "message" | "edit" = "message") {
  return { trigger, text } as Parameters<typeof parseSupplierPayoutQuery>[0];
}

// The answer's grant, policy and audience checks are covered by the
// tests/e2e/slack-supplier-payout-audience.test.ts journey.
describe("supplier payout Slack surface", function slackPayoutSuite() {
  it("recognises a request for outstanding payouts", function recognises() {
    for (const text of [
      "show supplier payouts",
      "list outstanding supplier payouts",
      "what are the pending supplier payouts",
      "<@U123> please show supplier payouts",
    ]) {
      expect(parseSupplierPayoutQuery(message(text))).toEqual({
        kind: "outstanding",
      });
    }
  });

  it("recognises a request for one supplier", function perSupplier() {
    expect(
      parseSupplierPayoutQuery(message("show payouts for supplier_42")),
    ).toEqual({ kind: "supplier", supplierId: "supplier_42" });
  });

  it("recognises nothing that would move money", function readsOnly() {
    // There is no phrasing that approves or sends. A chat message is not an
    // approval surface, and a text match must never be able to pay someone.
    for (const text of [
      "approve supplier payouts",
      "send supplier payouts",
      "pay supplier_42",
      "cancel supplier payouts",
      "approve payout supplier_42",
    ]) {
      expect(parseSupplierPayoutQuery(message(text))).toBeNull();
    }
  });

  it("ignores unrelated talk that merely mentions payouts", function narrow() {
    for (const text of [
      "the supplier payouts doc is out of date",
      "did anyone look at payouts",
      "supplier payout",
    ]) {
      expect(parseSupplierPayoutQuery(message(text))).toBeNull();
    }
  });

  it("never treats an edit as a command", function noEdits() {
    // Acting on an edited message means acting on something whose original a
    // person may already have seen and answered.
    expect(
      parseSupplierPayoutQuery(message("show supplier payouts", "edit")),
    ).toBeNull();
  });
});
