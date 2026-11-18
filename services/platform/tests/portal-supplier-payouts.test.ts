import { describe, expect, it } from "vitest";

import {
  needsOperator,
  payoutGuidance,
  readPayoutExceptions,
  readSupplierPayouts,
  readUnresolvedPayouts,
  supplierPayoutAuditPath,
  type PayoutReadTransport,
} from "../../../apps/portal/src/features/payouts/api";
import type { SupplierPayout } from "@seams/control-api/portal/payouts";

const ORGANISATION = "organisation_1";
const PATH = `/v1/control/organisations/${ORGANISATION}/commerce/supplier-payouts`;

function payout(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    payoutId: "supplier_payout_1",
    payableId: "supplier_payable_1",
    supplierId: "supplier_1",
    rail: "gmo_aozora_private",
    destinationRevisionId: "destination_revision_1",
    currency: "JPY",
    recipientAmountMinor: 10_000,
    feeCeilingMinor: 500,
    state: "approval_pending",
    approved: false,
    revision: 1,
    ...overrides,
  };
}

function envelope(payouts: readonly unknown[]): Record<string, unknown> {
  return { ok: true, supplierPayouts: payouts };
}

describe("Portal supplier-payout boundary", function payoutBoundarySuite() {
  it("reads the work queue", async function queue() {
    const read: PayoutReadTransport = async (path) => {
      expect(path).toBe(PATH);
      return envelope([payout({ state: "indeterminate", approved: true })]);
    };
    const parsed = await readUnresolvedPayouts(ORGANISATION, read);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.state).toBe("indeterminate");
    expect(payoutGuidance(parsed[0] as SupplierPayout)).toMatch(
      /do not send it again/u,
    );
  });

  it("scopes a supplier's history to that supplier", async function bySupplier() {
    const read: PayoutReadTransport = async (path) => {
      expect(path).toBe(`${PATH}?supplierId=supplier_1`);
      return envelope([payout({ state: "settled", approved: true })]);
    };
    expect(
      (await readSupplierPayouts(ORGANISATION, "supplier_1", read))[0]?.state,
    ).toBe("settled");
  });

  it("reads contradictory evidence and links the organisation-scoped audit attachment", async function exceptionsAndAudit() {
    const read: PayoutReadTransport = async (path) => {
      expect(path).toBe(`${PATH}?view=exceptions&after=0`);
      return {
        ok: true,
        events: [
          {
            cursor: 7,
            providerEventId: "event_1",
            rail: "wise_enterprise_payouts",
            integrationAccountId: "integration_wise",
            environment: "development",
            targetKind: "transfer",
            targetId: "transfer_1",
            payloadDigest: "ab".repeat(32),
            amountMinor: 10_000,
            currency: "JPY",
            observation: { kind: "settled" },
            occurredAt: 100,
            receivedAt: 110,
            status: "conflict",
          },
        ],
        nextCursor: null,
      };
    };
    const page = await readPayoutExceptions(ORGANISATION, 0, read);
    expect(page.events[0]).toMatchObject({
      targetKind: "transfer",
      targetId: "transfer_1",
      observationKind: "settled",
      status: "conflict",
    });
    expect(supplierPayoutAuditPath(ORGANISATION, "supplier payout/1")).toBe(
      `${PATH}/supplier%20payout%2F1/audit`,
    );
  });

  it("refuses a payload carrying anything it does not model", async function exactKeys() {
    // The platform never sends bank details; a payload that tries is refused
    // rather than rendered.
    const read: PayoutReadTransport = async () =>
      envelope([payout({ destinationAccountNumber: "12345678901" })]);
    await expect(readUnresolvedPayouts(ORGANISATION, read)).rejects.toThrow(
      /fields are invalid/u,
    );
  });

  it("refuses a state it does not recognise", async function unknownState() {
    const read: PayoutReadTransport = async () =>
      envelope([payout({ state: "escheated" })]);
    await expect(readUnresolvedPayouts(ORGANISATION, read)).rejects.toThrow(
      /state is invalid/u,
    );
  });

  it("refuses a rail it does not recognise", async function unknownRail() {
    const read: PayoutReadTransport = async () =>
      envelope([payout({ rail: "paypal_mass_pay" })]);
    await expect(readUnresolvedPayouts(ORGANISATION, read)).rejects.toThrow(
      /rail is invalid/u,
    );
  });

  it("names which payouts are waiting on a person", function operatorWork() {
    const states: readonly SupplierPayout["state"][] = [
      "approval_pending",
      "provider_action_required",
      "indeterminate",
    ];
    for (const state of states) {
      expect(
        needsOperator({ ...(payout({ state }) as unknown as SupplierPayout) }),
      ).toBe(true);
    }
    for (const state of [
      "provider_pending",
      "settled",
      "submitting",
    ] as const) {
      expect(
        needsOperator({ ...(payout({ state }) as unknown as SupplierPayout) }),
      ).toBe(false);
    }
  });
});
