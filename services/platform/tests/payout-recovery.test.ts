import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { SupplierPayable } from "@purin-labs/commerce-contracts";
import { d1Database } from "./sqlite-d1";
import { payoutPlan } from "./supplier-payout-fixtures";
import { parseOrganisationId } from "../src/ids";
import { createSupplierPayout } from "../src/data/supplier-payout-store";
import { createSupplierPayoutAttemptStore } from "../src/data/supplier-payout-attempt";
import {
  admitSupplierPayoutEvent,
  readSupplierPayoutAuditEvents,
  listSupplierPayoutExceptions,
  type SupplierPayoutEvidence,
} from "../src/data/supplier-payout-event-inbox";
import {
  writeSupplierPayable,
  readSupplierPayable,
} from "../src/data/supplier-payable-store";
import { proposeSupplierPayout } from "../src/payouts/supplier-payout-service";
import { applySupplierPayableCommandWithLexicon } from "../src/commerce/commerce-wasm";
import {
  recoverUnresolvedPayouts,
  type PayoutRecoveryProvider,
} from "../src/payouts/recovery";
import { reconcilePayoutInbox } from "../src/payouts/reconciliation";
import { readSupplierPayout } from "../src/data/supplier-payout-store";
import type { VariantBy } from "@purin-labs/type-utils";

const parsedOrganisation = parseOrganisationId("organisation_recovery");
if (!parsedOrganisation.ok) throw new Error("invalid fixture organisation");
const ORGANISATION = parsedOrganisation.value;
const PLAN = payoutPlan(ORGANISATION);
const NOW = Date.parse("2026-09-06T12:00:00Z");
let database: DatabaseSync;
let db: SingleDatabase;
let inquiryAt = NOW;

function clock(): number {
  return NOW;
}
function unavailable(): PayoutRecoveryProvider {
  return {
    async createTransfer() {
      throw new Error("recovery sent a transfer");
    },
    async fundTransfer() {
      throw new Error("recovery funded a transfer");
    },
    async inquireTransfer() {
      return { kind: "unknown" };
    },
    async inquireFunding() {
      return { kind: "unknown" };
    },
    async inquireStatus() {
      return null;
    },
  };
}
function evidence(
  kind: "settled" | "returned",
  id: string,
  occurredAt: number,
): VariantBy<SupplierPayoutEvidence, "targetKind", "transfer"> {
  return {
    providerEventId: id,
    rail: "gmo_aozora_private",
    integrationAccountId: "integration_gmo",
    sourceReference: "source_account_1",
    environment: "development",
    targetKind: "transfer",
    targetId: "transfer_1",
    payloadDigest: (kind === "settled" ? "ab" : "cd").repeat(32),
    amountMinor: 10000,
    currency: "JPY",
    observation:
      kind === "settled"
        ? {
            kind,
            providerTransferId: "transfer_1",
            receiptReference: "receipt_1",
            settledAt: new Date(occurredAt).toISOString(),
          }
        : {
            kind,
            providerTransferId: "transfer_1",
            payableRestorationReceiptId: "restoration_1",
            returnedAt: new Date(occurredAt).toISOString(),
          },
    occurredAt,
    receivedAt: NOW + 100,
    evidenceRef: `protected/${id}`,
  };
}
function requestFailure(): VariantBy<
  SupplierPayoutEvidence,
  "targetKind",
  "request"
> {
  return {
    providerEventId: "request_rejected_1",
    rail: "gmo_aozora_private",
    integrationAccountId: "integration_gmo",
    sourceReference: "source_account_1",
    environment: "development",
    targetKind: "request",
    targetId: "payout-request-1",
    payloadDigest: "ef".repeat(32),
    amountMinor: 10000,
    currency: "JPY",
    observation: {
      kind: "failed",
      failure: "provider_rejected",
      providerEvidenceId: "rejection_receipt_1",
      failedAt: new Date(NOW).toISOString(),
    },
    occurredAt: NOW,
    receivedAt: NOW + 100,
    evidenceRef: "protected/rejection_1",
  };
}
async function recover(provider: PayoutRecoveryProvider = unavailable()) {
  return recoverUnresolvedPayouts({
    db,
    organisationId: ORGANISATION,
    now: new Date((inquiryAt += 60000)).toISOString(),
    providerFor: providerFor.bind(null, provider),
  });
}
function providerFor(provider: PayoutRecoveryProvider): PayoutRecoveryProvider {
  return provider;
}

beforeEach(async function seed() {
  inquiryAt = NOW;
  database = new DatabaseSync(":memory:");
  database.exec(singleDatabaseSchema());
  db = d1Database(database);
  database
    .prepare(
      "INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES (?, 'Recovery', 'beta', 1, 'active')",
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO organisation_onboarding (organisation_id, environment, lifecycle, capability_profile,
    configuration_version, projection_revision, updated_at) VALUES (?, 'development', 'configuring', 'read_and_propose', 1, 1, 1)`,
    )
    .run(ORGANISATION);
  const payable: SupplierPayable = {
    payableId: "supplier_payable_1",
    organisationId: ORGANISATION,
    merchantId: PLAN.subject.merchantId,
    supplierId: "supplier_1",
    purchaseRequestId: "purchase_request_1",
    paymentReference: "INV-1",
    evidenceReference: "invoice_1",
    grossAmount: { amountMinor: 10000, currency: "JPY" },
    dueDate: "2026-09-07T00:00:00Z",
    revision: 2,
    lifecycle: "approved",
    allocation: {
      inFlight: { amountMinor: 10000, currency: "JPY" },
      settled: { amountMinor: 0, currency: "JPY" },
    },
  };
  await writeSupplierPayable({
    db,
    organisationId: ORGANISATION,
    payable: {
      payableId: payable.payableId,
      merchantId: payable.merchantId,
      supplierId: payable.supplierId,
      purchaseRequestId: payable.purchaseRequestId,
      currency: "JPY",
      grossAmountMinor: 10000,
      inFlightMinor: 10000,
      settledMinor: 0,
      lifecycle: "approved",
      revision: 2,
      payableJson: JSON.stringify(payable),
    },
    expectedRevision: null,
    now: NOW,
  });
  await createSupplierPayout({
    db,
    organisationId: ORGANISATION,
    payout: {
      payoutId: "supplier_payout_1",
      payableId: payable.payableId,
      supplierId: payable.supplierId,
      purchaseRequestId: payable.purchaseRequestId,
      rail: "gmo_aozora_private",
      integrationAccountId: "integration_gmo",
      destinationRevisionId: "destination_revision_1",
      currency: "JPY",
      recipientAmountMinor: 10000,
      feeCeilingMinor: 500,
      idempotencyKey: "payout-request-1",
      stateKind: "indeterminate",
      approvalDigest: PLAN.seal.approvalDigest,
      payoutJson: JSON.stringify({
        plan: PLAN,
        state: { kind: "indeterminate" },
      }),
      revision: 1,
    },
    now: NOW,
  });
  const store = createSupplierPayoutAttemptStore({
    db,
    organisationId: ORGANISATION,
    now: clock,
  });
  await store.recordDispatch({
    payoutId: "supplier_payout_1",
    attemptId: "attempt_1",
    approvalDigest: PLAN.seal.approvalDigest,
    requestIdentity: "payout-request-1",
  });
  await store.recordProviderTransfer({
    payoutId: "supplier_payout_1",
    attemptId: "attempt_1",
    providerTransferId: "transfer_1",
  });
});
afterEach(function close() {
  database.close();
});

describe("durable payout reconciliation through real Lexicon", function suite() {
  it("settles and restores exactly once, retaining late earlier events without regression", async function lifecycle() {
    const settled = evidence("settled", "event_1", NOW);
    expect(
      (
        await admitSupplierPayoutEvent({
          db,
          organisationId: ORGANISATION,
          event: settled,
        })
      ).outcome,
    ).toBe("admitted");
    expect(
      (
        await admitSupplierPayoutEvent({
          db,
          organisationId: ORGANISATION,
          event: settled,
        })
      ).outcome,
    ).toBe("duplicate");
    expect(await reconcilePayoutInbox(db, ORGANISATION, NOW + 100)).toEqual([
      "applied",
    ]);
    expect(
      await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"),
    ).toMatchObject({
      inFlightMinor: 0,
      settledMinor: 10000,
      lifecycle: "paid",
    });
    const returned = evidence("returned", "event_2", NOW + 10);
    await admitSupplierPayoutEvent({
      db,
      organisationId: ORGANISATION,
      event: returned,
    });
    await reconcilePayoutInbox(db, ORGANISATION, NOW + 100);
    await reconcilePayoutInbox(db, ORGANISATION, NOW + 100);
    expect(
      await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"),
    ).toMatchObject({
      inFlightMinor: 0,
      settledMinor: 0,
      lifecycle: "approved",
      revision: 4,
    });
    await admitSupplierPayoutEvent({
      db,
      organisationId: ORGANISATION,
      event: { ...settled, providerEventId: "event_late" },
    });
    await reconcilePayoutInbox(db, ORGANISATION, NOW + 100);
    expect(
      (await readSupplierPayout(db, ORGANISATION, "supplier_payout_1"))
        ?.stateKind,
    ).toBe("returned");
  });

  it("retains holds across failed inquiries and expired approval; funding acknowledgement stays pending", async function unknown() {
    await db
      .prepare(
        "UPDATE supplier_payout_attempt SET funding_operation_id = 'funding:attempt_1'",
      )
      .run();
    for (let pass = 0; pass < 3; pass++) {
      inquiryAt = Date.parse("2027-09-06T12:00:00Z") + pass * 60000;
      await recoverUnresolvedPayouts({
        db,
        organisationId: ORGANISATION,
        now: new Date(inquiryAt).toISOString(),
        providerFor: unavailable,
      });
    }
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.inFlightMinor,
    ).toBe(10000);
    const provider = unavailable();
    provider.inquireFunding = async function funded() {
      return { kind: "funded", fundingOperationId: "funding:attempt_1" };
    };
    await recover(provider);
    expect(
      (await readSupplierPayout(db, ORGANISATION, "supplier_payout_1"))
        ?.stateKind,
    ).toBe("provider_pending");
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.settledMinor,
    ).toBe(0);
    await recover({
      ...provider,
      async inquireStatus() {
        return evidence("settled", "status_1", NOW);
      },
    });
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.settledMinor,
    ).toBe(10000);
  });

  it("quarantines conflicting delivery identities and wrong source evidence without changing allocations", async function mismatches() {
    const event = evidence("settled", "event_1", NOW);
    await admitSupplierPayoutEvent({ db, organisationId: ORGANISATION, event });
    expect(
      (
        await admitSupplierPayoutEvent({
          db,
          organisationId: ORGANISATION,
          event: { ...event, payloadDigest: "ef".repeat(32) },
        })
      ).outcome,
    ).toBe("conflict");
    await admitSupplierPayoutEvent({
      db,
      organisationId: ORGANISATION,
      event: {
        ...event,
        providerEventId: "event_wrong",
        sourceReference: "other_account",
      },
    });
    expect(await reconcilePayoutInbox(db, ORGANISATION, NOW + 100)).toEqual([
      "conflict",
    ]);
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.inFlightMinor,
    ).toBe(10000);
  });

  it("rolls back payout, payable and inbox together if the payable write fails", async function atomicity() {
    await admitSupplierPayoutEvent({
      db,
      organisationId: ORGANISATION,
      event: evidence("settled", "event_1", NOW),
    });
    database.exec(
      "CREATE TRIGGER fail_payable BEFORE UPDATE ON supplier_payable BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
    );
    await expect(
      reconcilePayoutInbox(db, ORGANISATION, NOW + 100),
    ).rejects.toThrow("interrupted");
    expect(
      (await readSupplierPayout(db, ORGANISATION, "supplier_payout_1"))
        ?.stateKind,
    ).toBe("indeterminate");
    expect(
      database.prepare("SELECT status FROM supplier_payout_event").get(),
    ).toMatchObject({ status: "pending" });
    database.exec("DROP TRIGGER fail_payable");
    expect(await reconcilePayoutInbox(db, ORGANISATION, NOW + 100)).toEqual([
      "applied",
    ]);
  });

  it("releases held money on definitive failure and quarantines contradictory delivery", async function failedThenSettled() {
    const failure = evidence("settled", "failed_1", NOW);
    await admitSupplierPayoutEvent({
      db,
      organisationId: ORGANISATION,
      event: {
        ...failure,
        observation: {
          kind: "failed",
          failure: "provider_rejected",
          providerEvidenceId: "rejection_receipt_1",
          failedAt: new Date(NOW).toISOString(),
        },
      },
    });
    expect(await reconcilePayoutInbox(db, ORGANISATION, NOW + 100)).toEqual([
      "applied",
    ]);
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.inFlightMinor,
    ).toBe(0);
    await admitSupplierPayoutEvent({
      db,
      organisationId: ORGANISATION,
      event: evidence("settled", "settlement_1", NOW - 10),
    });
    expect(await reconcilePayoutInbox(db, ORGANISATION, NOW + 100)).toEqual([
      "conflict",
    ]);
    const audit = await readSupplierPayoutAuditEvents(
      db,
      ORGANISATION,
      "supplier_payout_1",
      0,
    );
    expect(audit.events).toHaveLength(2);
    expect(audit.events[0]?.observation).toMatchObject({
      providerEvidenceId: "rejection_receipt_1",
    });
    expect(audit.events[1]?.status).toBe("conflict");
    expect(
      (await listSupplierPayoutExceptions(db, ORGANISATION, 0)).events,
    ).toHaveLength(1);
    expect(
      await proposeSupplierPayout({
        db,
        organisationId: ORGANISATION,
        payableId: "supplier_payable_1",
        destinationId: "destination_1",
        payoutId: "payout_2",
        proposalId: "proposal_2",
        idempotencyKey: "request_2",
        recipientAmountMinor: 10000,
        feeCeilingMinor: 500,
        rail: "gmo_aozora_private",
        integrationAccountId: "integration_gmo",
        expiresAt: "2026-09-07T00:00:00Z",
        now: NOW,
        applyPayableCommand: applySupplierPayableCommandWithLexicon,
      }),
    ).toEqual({ ok: false, error: "allocation_conflict" });
    expect(JSON.stringify(audit)).not.toContain("protected/");
  });

  it("recovers a rejected request without inventing a transfer and preserves later contradictory acceptance", async function rejectedRequest() {
    await db
      .prepare("UPDATE supplier_payout_attempt SET provider_transfer_id = NULL")
      .run();
    const rejection = requestFailure();
    await admitSupplierPayoutEvent({
      db,
      organisationId: ORGANISATION,
      event: {
        ...rejection,
        targetId: "unrelated_request",
        providerEventId: "unrelated_event",
      },
    });
    expect(await reconcilePayoutInbox(db, ORGANISATION, NOW + 100)).toEqual([
      "waiting",
    ]);
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.inFlightMinor,
    ).toBe(10000);
    await recover({
      ...unavailable(),
      async inquireStatus(plan, target) {
        expect(plan.seal.idempotencyKey).toBe("payout-request-1");
        expect(target).toEqual({
          kind: "request",
          identity: "payout-request-1",
        });
        return rejection;
      },
    });
    expect(
      (await readSupplierPayout(db, ORGANISATION, "supplier_payout_1"))
        ?.stateKind,
    ).toBe("failed");
    expect(
      await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"),
    ).toMatchObject({ inFlightMinor: 0, settledMinor: 0, revision: 3 });
    expect(
      (
        await admitSupplierPayoutEvent({
          db,
          organisationId: ORGANISATION,
          event: rejection,
        })
      ).outcome,
    ).toBe("duplicate");
    await reconcilePayoutInbox(db, ORGANISATION, NOW + 100);
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.revision,
    ).toBe(3);
    expect(
      (
        await readSupplierPayoutAuditEvents(
          db,
          ORGANISATION,
          "supplier_payout_1",
          0,
        )
      ).events,
    ).toMatchObject([
      {
        targetKind: "request",
        targetId: "payout-request-1",
        observation: { providerEvidenceId: "rejection_receipt_1" },
        status: "applied",
      },
    ]);
    const attempts = createSupplierPayoutAttemptStore({
      db,
      organisationId: ORGANISATION,
      now: clock,
    });
    await attempts.recordProviderTransfer({
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      providerTransferId: "late_transfer",
    });
    expect(
      (await listSupplierPayoutExceptions(db, ORGANISATION, 0)).events,
    ).toMatchObject([{ targetKind: "request", status: "conflict" }]);
    expect(
      await proposeSupplierPayout({
        db,
        organisationId: ORGANISATION,
        payableId: "supplier_payable_1",
        destinationId: "destination_1",
        payoutId: "payout_2",
        proposalId: "proposal_2",
        idempotencyKey: "request_2",
        recipientAmountMinor: 10000,
        feeCeilingMinor: 500,
        rail: "gmo_aozora_private",
        integrationAccountId: "integration_gmo",
        expiresAt: "2026-09-07T00:00:00Z",
        now: NOW,
        applyPayableCommand: applySupplierPayableCommandWithLexicon,
      }),
    ).toEqual({ ok: false, error: "allocation_conflict" });
  });

  it("retains the allocation when rejection by request contradicts an already recorded transfer", async function requestContradiction() {
    await admitSupplierPayoutEvent({
      db,
      organisationId: ORGANISATION,
      event: requestFailure(),
    });
    expect(await reconcilePayoutInbox(db, ORGANISATION, NOW + 100)).toEqual([
      "conflict",
    ]);
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.inFlightMinor,
    ).toBe(10000);
  });

  it("keeps events for unknown transfers until recovery learns the identity", async function unknownTransfer() {
    await db
      .prepare("UPDATE supplier_payout_attempt SET provider_transfer_id = NULL")
      .run();
    await admitSupplierPayoutEvent({
      db,
      organisationId: ORGANISATION,
      event: evidence("settled", "event_1", NOW),
    });
    expect(await reconcilePayoutInbox(db, ORGANISATION, NOW + 100)).toEqual([
      "waiting",
    ]);
    const provider = unavailable();
    provider.inquireTransfer = async function accepted() {
      return { kind: "accepted", providerTransferId: "transfer_1" };
    };
    await recover(provider);
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.settledMinor,
    ).toBe(10000);
  });
});
