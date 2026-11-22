/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  createSupplierPayoutAttemptStore,
  listSupplierPayoutAttempts,
  readSupplierPayoutAttempt,
} from "@purin-labs/area-commerce/server/data/supplier-payout-attempt";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import {
  executeSupplierPayout,
  type SupplierPayoutProvider,
} from "@purin-labs/area-commerce/server/payouts/executor";
import { d1Database } from "./sqlite-d1";
const ORGANISATION = "organisation_1" as OrganisationId;
/** Stands in for Lexicon; plan validation is exercised in the executor suite. */
const VALID = () => ({
  ok: true as const,
  value: { economicsDigest: DIGEST, matchesApproval: true },
});

const DIGEST = "ab".repeat(32);

const PLAN = {
  kind: "gmo_aozora",
  subject: { payoutId: "supplier_payout_1" },
  seal: {
    approvalDigest: DIGEST,
    executionDeadline: "2026-09-07T00:00:00Z",
    idempotencyKey: "payout-request-1",
  },
} as never;

let db: SingleDatabase;
let clock = 100;

function store() {
  return createSupplierPayoutAttemptStore({
    db,
    organisationId: ORGANISATION,
    now: () => clock,
  });
}

function provider(
  overrides: Partial<SupplierPayoutProvider> = {},
): SupplierPayoutProvider {
  return {
    async createTransfer() {
      return { kind: "unknown" };
    },
    async fundTransfer() {
      return { kind: "unknown" };
    },
    async inquireTransfer() {
      return { kind: "unknown" };
    },
    async inquireFunding() {
      return { kind: "unknown" };
    },
    ...overrides,
  };
}

describe("supplier payout attempt store", function payoutAttemptSuite() {
  beforeEach(function freshDatabase() {
    clock = 100;
    const database = new DatabaseSync(":memory:");
    database.exec(singleDatabaseSchema());
    db = d1Database(database);
  });

  it("records the attempt before the provider is called", async function dispatchFirst() {
    let seenAtCallTime: unknown;
    await executeSupplierPayout({
      plan: PLAN,
      attemptId: "attempt_1",
      payoutApprovalDigest: DIGEST,
      now: "2026-09-06T12:00:00Z",
      provider: provider({
        async createTransfer() {
          // The row must already exist by the time the provider is reached.
          seenAtCallTime = await readSupplierPayoutAttempt(
            db,
            ORGANISATION,
            "attempt_1",
          );
          return { kind: "unknown" };
        },
      }),
      store: store(),
      validate: VALID,
    });
    expect(seenAtCallTime).toMatchObject({
      payoutId: "supplier_payout_1",
      approvalDigest: DIGEST,
      requestIdentity: "payout-request-1",
      // No transfer identity yet — that absence is the durable record of an
      // indeterminate submission.
      providerTransferId: null,
    });
  });

  it("keeps an unresolved attempt with no transfer identity", async function indeterminateHasNoTransfer() {
    await executeSupplierPayout({
      plan: PLAN,
      attemptId: "attempt_1",
      payoutApprovalDigest: DIGEST,
      now: "2026-09-06T12:00:00Z",
      provider: provider(),
      store: store(),
      validate: VALID,
    });
    const stored = await readSupplierPayoutAttempt(
      db,
      ORGANISATION,
      "attempt_1",
    );
    expect(stored?.providerTransferId).toBe(null);
    expect(stored?.fundingOperationId).toBe(null);
  });

  it("records the provider transfer once and never overwrites it", async function transferIsWriteOnce() {
    const attempts = store();
    await attempts.recordDispatch({
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      approvalDigest: DIGEST,
      requestIdentity: "payout-request-1",
    });
    await attempts.recordProviderTransfer({
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      providerTransferId: "transfer_1",
    });
    // A later pass must not replace the reference recovery depends on.
    await expect(
      attempts.recordProviderTransfer({
        payoutId: "supplier_payout_1",
        attemptId: "attempt_1",
        providerTransferId: "transfer_2",
      }),
    ).rejects.toThrow("payout_transfer_identity_conflict");
    expect(
      (await readSupplierPayoutAttempt(db, ORGANISATION, "attempt_1"))
        ?.providerTransferId,
    ).toBe("transfer_1");
  });

  it("preserves one attempt and refuses another dispatch", async function idempotentDispatch() {
    const attempts = store();
    const dispatch = {
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      approvalDigest: DIGEST,
      requestIdentity: "payout-request-1",
    };
    await attempts.recordDispatch(dispatch);
    await attempts.recordProviderTransfer({
      ...dispatch,
      providerTransferId: "transfer_1",
    });
    clock = 200;
    await expect(attempts.recordDispatch(dispatch)).rejects.toThrow(
      "payout_attempt_already_dispatched",
    );
    const rows = await listSupplierPayoutAttempts(
      db,
      ORGANISATION,
      "supplier_payout_1",
    );
    expect(rows).toHaveLength(1);
    // A retried dispatch must not erase what the provider already told us.
    expect(rows[0]?.providerTransferId).toBe("transfer_1");
    expect(rows[0]?.dispatchedAt).toBe(100);
  });

  it("surfaces every attempt for a payout", async function listsAttempts() {
    const attempts = store();
    for (const attemptId of ["attempt_1", "attempt_2"]) {
      await attempts.recordDispatch({
        payoutId: "supplier_payout_1",
        attemptId,
        approvalDigest: DIGEST,
        requestIdentity: `payout-request-${attemptId}`,
      });
      clock += 10;
    }
    // Two attempts means an earlier one went unresolved — worth surfacing,
    // not tidying away.
    expect(
      (
        await listSupplierPayoutAttempts(db, ORGANISATION, "supplier_payout_1")
      ).map((row) => row.attemptId),
    ).toEqual(["attempt_1", "attempt_2"]);
  });

  it("refuses a second request identity for one payout", async function oneRequestIdentity() {
    const attempts = store();
    await attempts.recordDispatch({
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      approvalDigest: DIGEST,
      requestIdentity: "payout-request-1",
    });
    await expect(
      attempts.recordDispatch({
        payoutId: "supplier_payout_1",
        attemptId: "attempt_2",
        approvalDigest: DIGEST,
        requestIdentity: "payout-request-1",
      }),
    ).rejects.toThrow();
  });

  it("will not attach a funding operation to a different transfer", async function fundingBoundToTransfer() {
    const attempts = store();
    await attempts.recordDispatch({
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      approvalDigest: DIGEST,
      requestIdentity: "payout-request-1",
    });
    await attempts.recordProviderTransfer({
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      providerTransferId: "transfer_1",
    });
    // Recovery adopted a different transfer; funding for the old one must not
    // land on it, or the attempt would claim to have funded a transfer it
    // never funded.
    await expect(
      attempts.recordFundingDispatch({
        payoutId: "supplier_payout_1",
        attemptId: "attempt_1",
        providerTransferId: "transfer_other",
        fundingOperationId: "funding:attempt_1",
      }),
    ).rejects.toThrow("payout_funding_dispatch_conflict");
    expect(
      (await readSupplierPayoutAttempt(db, ORGANISATION, "attempt_1"))
        ?.fundingOperationId,
    ).toBeNull();
  });

  it("records a funding operation once and never overwrites it", async function fundingWriteOnce() {
    const attempts = store();
    await attempts.recordDispatch({
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      approvalDigest: DIGEST,
      requestIdentity: "payout-request-1",
    });
    await attempts.recordProviderTransfer({
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      providerTransferId: "transfer_1",
    });
    await attempts.recordFundingDispatch({
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      providerTransferId: "transfer_1",
      fundingOperationId: "funding:attempt_1",
    });
    await expect(
      attempts.recordFundingDispatch({
        payoutId: "supplier_payout_1",
        attemptId: "attempt_1",
        providerTransferId: "transfer_1",
        fundingOperationId: "funding:something_else",
      }),
    ).rejects.toThrow("payout_funding_dispatch_conflict");
    expect(
      (await readSupplierPayoutAttempt(db, ORGANISATION, "attempt_1"))
        ?.fundingOperationId,
    ).toBe("funding:attempt_1");
  });
});
