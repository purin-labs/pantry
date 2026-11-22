/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  advanceSupplierPayout,
  createSupplierPayout,
  listSupplierPayoutsForSupplier,
  listUnresolvedSupplierPayouts,
  readSupplierPayout,
  readSupplierPayoutByIdempotencyKey,
  type SupplierPayoutRow,
} from "../src/data/supplier-payout-store";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { d1Database } from "./sqlite-d1";
const ORGANISATION = "organisation_payout" as OrganisationId;
const DIGEST = "ab".repeat(32);

let db: SingleDatabase;
let database: DatabaseSync;

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
    stateKind: "approval_pending",
    approvalDigest: null,
    payoutJson: JSON.stringify({ state: { kind: "approval_pending" } }),
    revision: 1,
    ...overrides,
  };
}

function seed(): void {
  database
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Supplier payout store', 'beta', 1, 'active')`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO supplier_payable (
       organisation_id, payable_id, merchant_id, supplier_id, purchase_request_id,
       currency, gross_amount_minor, in_flight_minor, settled_minor,
       lifecycle, revision, payable_json, updated_at
     ) VALUES (?, 'supplier_payable_1', 'merchant_1', 'supplier_1',
       'purchase_request_1', 'JPY', 100000, 0, 0, 'approved', 1, '{}', 1)`,
    )
    .run(ORGANISATION);
}

async function create(overrides: Partial<SupplierPayoutRow> = {}) {
  return createSupplierPayout({
    db,
    organisationId: ORGANISATION,
    payout: payout(overrides),
    now: 10,
  });
}

describe("supplier payout store", function payoutStoreSuite() {
  beforeEach(function freshDatabase() {
    database = new DatabaseSync(":memory:");
    database.exec(singleDatabaseSchema());
    db = d1Database(database);
    seed();
  });

  it("creates a payout at revision one", async function creates() {
    expect(await create()).toEqual({ ok: true, revision: 1 });
    const stored = await readSupplierPayout(
      db,
      ORGANISATION,
      "supplier_payout_1",
    );
    expect(stored?.stateKind).toBe("approval_pending");
    expect(stored?.revision).toBe(1);
    expect(stored?.approvalDigest).toBeNull();
  });

  it("refuses a second payout for one request identity", async function idempotent() {
    await create();
    // A retried proposal must find its own payout, never mint a second one
    // against the same payable.
    expect(await create({ payoutId: "supplier_payout_2" })).toEqual({
      ok: false,
      error: "idempotency_conflict",
    });
    expect(
      await readSupplierPayout(db, ORGANISATION, "supplier_payout_2"),
    ).toBeUndefined();
  });

  it("finds the payout a request identity already produced", async function findsByKey() {
    await create();
    expect(
      (
        await readSupplierPayoutByIdempotencyKey(
          db,
          ORGANISATION,
          "payout-request-1",
        )
      )?.payoutId,
    ).toBe("supplier_payout_1");
  });

  it("advances only from the revision the caller read", async function compareAndSet() {
    await create();
    expect(
      await advanceSupplierPayout({
        db,
        organisationId: ORGANISATION,
        payoutId: "supplier_payout_1",
        expectedRevision: 1,
        stateKind: "approved",
        approvalDigest: DIGEST,
        payoutJson: JSON.stringify({ state: { kind: "approved" } }),
        now: 20,
      }),
    ).toEqual({ ok: true, revision: 2 });

    // A second writer that read revision 1 loses. Both winning would advance
    // one payout twice.
    expect(
      await advanceSupplierPayout({
        db,
        organisationId: ORGANISATION,
        payoutId: "supplier_payout_1",
        expectedRevision: 1,
        stateKind: "submitting",
        approvalDigest: DIGEST,
        payoutJson: JSON.stringify({ state: { kind: "submitting" } }),
        now: 21,
      }),
    ).toEqual({ ok: false, error: "revision_conflict" });
    expect(
      (await readSupplierPayout(db, ORGANISATION, "supplier_payout_1"))
        ?.stateKind,
    ).toBe("approved");
  });

  it("refuses a payout past approval that carries no approval digest", async function digestRequired() {
    await create();
    // The schema, not the caller, is what makes this impossible: nothing
    // downstream could tell whether the economics moved.
    await expect(
      advanceSupplierPayout({
        db,
        organisationId: ORGANISATION,
        payoutId: "supplier_payout_1",
        expectedRevision: 1,
        stateKind: "submitting",
        approvalDigest: null,
        payoutJson: "{}",
        now: 20,
      }),
    ).rejects.toThrow();
  });

  it("refuses an approval digest that is not one Pantry could have computed", async function digestShape() {
    await expect(
      create({ stateKind: "approved", approvalDigest: "not-a-digest" }),
    ).rejects.toThrow();
  });

  it("allows cancellation without an approval", async function cancelWithoutApproval() {
    await create();
    expect(
      await advanceSupplierPayout({
        db,
        organisationId: ORGANISATION,
        payoutId: "supplier_payout_1",
        expectedRevision: 1,
        stateKind: "cancelled",
        approvalDigest: null,
        payoutJson: JSON.stringify({ state: { kind: "cancelled" } }),
        now: 20,
      }),
    ).toEqual({ ok: true, revision: 2 });
  });

  it("refuses a payout for a payable that does not exist", async function payableRequired() {
    await expect(
      create({ payableId: "supplier_payable_absent" }),
    ).rejects.toThrow();
  });

  it("refuses a rail it does not know", async function knownRails() {
    await expect(
      create({ rail: "paypal_mass_pay" as SupplierPayoutRow["rail"] }),
    ).rejects.toThrow();
  });

  it("refuses a payout of nothing", async function positiveAmount() {
    await expect(create({ recipientAmountMinor: 0 })).rejects.toThrow();
  });

  it("queues the payouts whose outcome is not yet known, oldest first", async function unresolvedQueue() {
    await create();
    await advanceSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      expectedRevision: 1,
      stateKind: "indeterminate",
      approvalDigest: DIGEST,
      payoutJson: "{}",
      now: 30,
    });
    await createSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payout: payout({
        payoutId: "supplier_payout_2",
        idempotencyKey: "payout-request-2",
        stateKind: "settled",
        approvalDigest: DIGEST,
      }),
      now: 40,
    });
    await createSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payout: payout({
        payoutId: "supplier_payout_3",
        idempotencyKey: "payout-request-3",
        stateKind: "provider_pending",
        approvalDigest: DIGEST,
      }),
      now: 50,
    });
    // Settled is resolved and must not appear; the longest-unresolved comes
    // first, because that is the supplier most likely already asking.
    expect(
      (await listUnresolvedSupplierPayouts(db, ORGANISATION)).map(
        (row) => row.payoutId,
      ),
    ).toEqual(["supplier_payout_1", "supplier_payout_3"]);
  });

  it("lists a supplier's payouts and no other supplier's", async function bySupplier() {
    await create();
    await createSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payout: payout({
        payoutId: "supplier_payout_other",
        idempotencyKey: "payout-request-other",
        supplierId: "supplier_2",
      }),
      now: 20,
    });
    expect(
      (
        await listSupplierPayoutsForSupplier(db, ORGANISATION, "supplier_1")
      ).map((r) => r.payoutId),
    ).toEqual(["supplier_payout_1"]);
  });

  it("does not surface another organisation's payouts", async function organisationScoped() {
    await create();
    expect(
      await readSupplierPayout(
        db,
        "organisation_other" as OrganisationId,
        "supplier_payout_1",
      ),
    ).toBeUndefined();
    expect(
      await listUnresolvedSupplierPayouts(
        db,
        "organisation_other" as OrganisationId,
      ),
    ).toEqual([]);
  });
});
