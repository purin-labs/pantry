/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  readActiveSupplierDestination,
  readSupplierDestinationRevision,
  readSupplierPayable,
  writeSupplierDestinationRevision,
  writeSupplierPayable,
  type SupplierDestinationRow,
  type SupplierPayableRow,
} from "@purin-labs/area-commerce/server/data/supplier-payable-store";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { d1Database } from "./sqlite-d1";
const ORGANISATION = "organisation_1" as OrganisationId;
let db: SingleDatabase;

function payable(
  overrides: Partial<SupplierPayableRow> = {},
): SupplierPayableRow {
  return {
    payableId: "supplier_payable_1",
    merchantId: "merchant_1",
    supplierId: "supplier_1",
    purchaseRequestId: "purchase_request_1",
    currency: "JPY",
    grossAmountMinor: 10_000,
    inFlightMinor: 0,
    settledMinor: 0,
    lifecycle: "approved",
    revision: 1,
    payableJson: "{}",
    ...overrides,
  };
}

function destination(
  overrides: Partial<SupplierDestinationRow> = {},
): SupplierDestinationRow {
  return {
    revisionId: "destination_revision_1",
    destinationId: "destination_1",
    supplierId: "supplier_1",
    rail: "gmo_aozora_domestic",
    maskedSummary: "Sumitomo ****1234",
    configurationRef: "vault_ref_1",
    state: "verified",
    proposedBy: "operator_maker",
    activatedBy: null,
    revision: 1,
    destinationJson: "{}",
    ...overrides,
  };
}

describe("supplier payable and destination persistence", function supplierStoreSuite() {
  beforeEach(function freshDatabase() {
    const database = new DatabaseSync(":memory:");
    database.exec(singleDatabaseSchema());
    db = d1Database(database);
  });

  it("never commits more money than the payable owes", async function neverOvercommits() {
    expect(
      await writeSupplierPayable({
        db,
        organisationId: ORGANISATION,
        payable: payable(),
        expectedRevision: null,
        now: 1,
      }),
    ).toBe(true);
    // 6,000 in flight plus 5,000 settled is more than the 10,000 owed.
    await expect(
      writeSupplierPayable({
        db,
        organisationId: ORGANISATION,
        payable: payable({
          inFlightMinor: 6_000,
          settledMinor: 5_000,
          revision: 2,
        }),
        expectedRevision: 1,
        now: 2,
      }),
    ).rejects.toThrow();
  });

  it("lets only one concurrent allocation win", async function compareAndSet() {
    await writeSupplierPayable({
      db,
      organisationId: ORGANISATION,
      payable: payable(),
      expectedRevision: null,
      now: 1,
    });
    expect(
      await writeSupplierPayable({
        db,
        organisationId: ORGANISATION,
        payable: payable({ inFlightMinor: 4_000, revision: 2 }),
        expectedRevision: 1,
        now: 2,
      }),
    ).toBe(true);
    // The loser read revision 1 too; it must not also commit money.
    expect(
      await writeSupplierPayable({
        db,
        organisationId: ORGANISATION,
        payable: payable({ inFlightMinor: 3_000, revision: 2 }),
        expectedRevision: 1,
        now: 3,
      }),
    ).toBe(false);
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.inFlightMinor,
    ).toBe(4_000);
  });

  it("refuses to activate an account its own author wrote", async function makerChecker() {
    await writeSupplierDestinationRevision({
      db,
      organisationId: ORGANISATION,
      destination: destination(),
      now: 1,
    });
    // The person who typed the bank details cannot be the one who approves them.
    await expect(
      writeSupplierDestinationRevision({
        db,
        organisationId: ORGANISATION,
        destination: destination({
          state: "active",
          activatedBy: "operator_maker",
        }),
        now: 2,
      }),
    ).rejects.toThrow();

    expect(
      await writeSupplierDestinationRevision({
        db,
        organisationId: ORGANISATION,
        destination: destination({
          state: "active",
          activatedBy: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
        }),
        now: 3,
      }),
    ).toBe(true);
    expect(
      (await readActiveSupplierDestination(db, ORGANISATION, "destination_1"))
        ?.activatedBy,
    ).toBe("user_31f9ff59-f15d-5e24-a376-5a8d42b7af68");
  });

  it("refuses an active destination with no approver", async function activeNeedsApprover() {
    await expect(
      writeSupplierDestinationRevision({
        db,
        organisationId: ORGANISATION,
        destination: destination({ state: "active", activatedBy: null }),
        now: 1,
      }),
    ).rejects.toThrow();
  });

  it("pays a supplier to one account at a time", async function oneActiveAccount() {
    await writeSupplierDestinationRevision({
      db,
      organisationId: ORGANISATION,
      destination: destination({
        state: "active",
        activatedBy: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
      }),
      now: 1,
    });
    await expect(
      writeSupplierDestinationRevision({
        db,
        organisationId: ORGANISATION,
        destination: destination({
          revisionId: "destination_revision_2",
          revision: 2,
          state: "active",
          activatedBy: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
        }),
        now: 2,
      }),
    ).rejects.toThrow();
  });

  it("keeps a superseded revision readable for an approved payout", async function revisionStaysReadable() {
    await writeSupplierDestinationRevision({
      db,
      organisationId: ORGANISATION,
      destination: destination({
        state: "retired",
        activatedBy: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
      }),
      now: 1,
    });
    // A payout approved against this revision must still resolve it.
    expect(
      (
        await readSupplierDestinationRevision(
          db,
          ORGANISATION,
          "destination_revision_1",
        )
      )?.maskedSummary,
    ).toBe("Sumitomo ****1234");
    expect(
      await readActiveSupplierDestination(db, ORGANISATION, "destination_1"),
    ).toBeUndefined();
  });
});
