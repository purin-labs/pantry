/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import {
  applySupplierPayableCommandWithLexicon,
  validateSupplierPayoutPlanWithLexicon,
} from "../src/commerce/commerce-wasm";
import { payoutPlan, wisePayoutPlan } from "./supplier-payout-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readSupplierPayable } from "../src/data/supplier-payable-store";
import {
  PAYOUT_CERTIFICATION_CHECKS,
  SUPPLIER_PAYOUT_ADAPTER_VERSIONS,
} from "../src/data/supplier-payout-certification";
import { readSupplierPayout } from "../src/data/supplier-payout-store";
import {
  createSupplierPayoutAttemptStore,
  readSupplierPayoutAttempt,
} from "../src/data/supplier-payout-attempt";
import type {
  PayoutAttemptStore,
  SupplierPayoutPlanValidator,
  SupplierPayoutProvider,
} from "../src/payouts/executor";
import {
  approveSupplierPayout,
  proposeSupplierPayout,
  resumeSupplierPayoutFunding,
  submitSupplierPayout,
  type PayableCommandRunner,
} from "../src/payouts/supplier-payout-service";
import type { OrganisationId } from "../src/ids";
import { d1Database } from "./sqlite-d1";
const ORGANISATION = "organisation_service" as OrganisationId;
const PLAN = payoutPlan(ORGANISATION);
const DIGEST = PLAN.seal.approvalDigest;
const WISE_PLAN = wisePayoutPlan(ORGANISATION);
const WISE_DIGEST = WISE_PLAN.seal.approvalDigest;
const NOW = "2026-09-06T12:00:00Z";

const VALID: SupplierPayoutPlanValidator = () => ({
  ok: true,
  value: { economicsDigest: DIGEST, matchesApproval: true },
});

let db: SingleDatabase;
let database: DatabaseSync;

function allocator(overrides: { fail?: boolean } = {}): PayableCommandRunner {
  return overrides.fail === true
    ? allocationFailure
    : applySupplierPayableCommandWithLexicon;
}
function allocationFailure(): { ok: false } {
  return { ok: false };
}

function seed(lifecycle = "approved", inFlight = 0, settled = 0): void {
  database
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Payout service', 'beta', 1, 'active')`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO supplier_payable (
       organisation_id, payable_id, merchant_id, supplier_id, purchase_request_id,
       currency, gross_amount_minor, in_flight_minor, settled_minor,
       lifecycle, revision, payable_json, updated_at
     ) VALUES (?, 'supplier_payable_1', 'merchant_1', 'supplier_1',
       'purchase_request_1', 'JPY', 100000, ?, ?, ?, 1, ?, 1)`,
    )
    .run(
      ORGANISATION,
      inFlight,
      settled,
      lifecycle,
      JSON.stringify({
        payableId: "supplier_payable_1",
        organisationId: ORGANISATION,
        merchantId: "merchant_1",
        supplierId: "supplier_1",
        purchaseRequestId: "purchase_request_1",
        paymentReference: "INV-1",
        evidenceReference: "invoice_1",
        grossAmount: { amountMinor: 100000, currency: "JPY" },
        dueDate: "2026-09-07T00:00:00Z",
        revision: 1,
        lifecycle,
        allocation: {
          inFlight: { currency: "JPY", amountMinor: inFlight },
          settled: { currency: "JPY", amountMinor: settled },
        },
      }),
    );
  database
    .prepare(
      `INSERT INTO supplier_destination_revision (
       organisation_id, revision_id, destination_id, supplier_id, rail,
       masked_summary, configuration_ref, state, proposed_by, activated_by,
       revision, destination_json, updated_at
     ) VALUES (?, 'destination_revision_1', 'destination_1', 'supplier_1',
       'gmo_aozora_domestic', 'Sumitomo ****1234', 'vault_ref_1', 'active',
       'operator_maker', 'user_31f9ff59-f15d-5e24-a376-5a8d42b7af68', 1, '{}', 1)`,
    )
    .run(ORGANISATION);
}

/**
 * Evidence that the rail can carry this payout. Approval says a person agreed
 * to the economics; certification says Pantry has proof the rail works for this
 * account, currency and amount. Both are required to send.
 */
function certify(maximumMinor = 100_000): void {
  database
    .prepare(
      `INSERT INTO app_user (
       user_id, issuer, subject, email, display_name,
       email_verified, created_at, last_authenticated_at
     ) VALUES ('app_user_cert', 'https://accounts.google.com',
       'cert', 'cert@test.invalid', 'Cert', 1, 1, 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO provider_connection (
       provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
       credential_generation, credential_ref, lifecycle, granted_scopes,
       created_by_user_id, created_at, updated_at, environment
     ) VALUES ('connection_cert', ?, 'stripe', 'api_key', 'connection_credential',
       1, 'credential_1', 'active', '[]', 'app_user_cert', 1, 1, 'development')`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO integration_account (
       integration_account_id, organisation_id, provider_connection_id, provider,
       provider_account_id, account_kind, display_name, lifecycle,
       lifecycle_reason_code, capability_set, audience_policy, retention_policy,
       created_at, updated_at, environment, is_default_for_provider
     ) VALUES ('integration_gmo', ?, 'connection_cert', 'stripe',
       'provider_account_gmo', 'merchant_account', 'GMO', 'active',
       NULL, '[]', '{"kind":"operator"}', '{"kind":"organisation_default"}',
       1, 1, 'development', 1)`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO supplier_payout_certification (
       organisation_id, test_run_id, rail, integration_account_id, source_reference,
       funding_mode, environment, adapter_version, evidence_source,
       matrix_version, checks_json, certified_currency, certified_maximum_minor,
       evidence_digest, certified_at, recorded_at, certified_by
     ) VALUES (?, 'run_1', 'gmo_aozora_private', 'integration_gmo',
       'source_account_1', 'balance', 'development', ?, 'provider_sandbox',
       1, ?, 'JPY', ?, ?, 1, 1, 'organisation_admin')`,
    )
    .run(
      ORGANISATION,
      SUPPLIER_PAYOUT_ADAPTER_VERSIONS.gmo_aozora_private,
      JSON.stringify([...PAYOUT_CERTIFICATION_CHECKS]),
      maximumMinor,
      DIGEST,
    );
}

function seedWiseFundingRequired(): void {
  database
    .prepare(
      `UPDATE supplier_destination_revision
     SET rail = 'wise_recipient', masked_summary = 'Wise recipient ****1234'
     WHERE organisation_id = ? AND revision_id = 'destination_revision_1'`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO app_user (
       user_id, issuer, subject, email, display_name,
       email_verified, created_at, last_authenticated_at
     ) VALUES ('app_user_wise', 'https://accounts.google.com',
       'wise', 'wise@test.invalid', 'Wise', 1, 1, 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO provider_connection (
       provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
       credential_generation, credential_ref, lifecycle, granted_scopes,
       created_by_user_id, created_at, updated_at, environment
     ) VALUES ('connection_wise', ?, 'stripe', 'api_key', 'connection_credential',
       1, 'credential_wise', 'active', '[]', 'app_user_wise', 1, 1, 'development')`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO integration_account (
       integration_account_id, organisation_id, provider_connection_id, provider,
       provider_account_id, account_kind, display_name, lifecycle,
       lifecycle_reason_code, capability_set, audience_policy, retention_policy,
       created_at, updated_at, environment, is_default_for_provider
     ) VALUES ('integration_wise', ?, 'connection_wise', 'stripe',
       'provider_account_wise', 'merchant_account', 'Wise', 'active',
       NULL, '[]', '{"kind":"operator"}', '{"kind":"organisation_default"}',
       1, 1, 'development', 1)`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO supplier_payout_certification (
       organisation_id, test_run_id, rail, integration_account_id, source_reference,
       funding_mode, environment, adapter_version, evidence_source,
       matrix_version, checks_json, certified_currency, certified_maximum_minor,
       evidence_digest, certified_at, recorded_at, certified_by
     ) VALUES (?, 'run_wise', 'wise_enterprise_payouts', 'integration_wise',
       'profile_1', 'balance', 'development', ?, 'provider_sandbox',
       1, ?, 'JPY', 100000, ?, 1, 1, 'organisation_admin')`,
    )
    .run(
      ORGANISATION,
      SUPPLIER_PAYOUT_ADAPTER_VERSIONS.wise_enterprise_payouts,
      JSON.stringify([...PAYOUT_CERTIFICATION_CHECKS]),
      WISE_DIGEST,
    );
  database
    .prepare(
      `INSERT INTO supplier_payout (
       organisation_id, payout_id, payable_id, supplier_id, purchase_request_id,
       rail, integration_account_id, destination_revision_id, currency,
       recipient_amount_minor, fee_ceiling_minor, idempotency_key,
       state_kind, approval_digest, payout_json, revision, created_at, updated_at
     ) VALUES (?, 'supplier_payout_1', 'supplier_payable_1', 'supplier_1',
       'purchase_request_1', 'wise_enterprise_payouts', 'integration_wise',
       'destination_revision_1', 'JPY', 10000, 500, 'payout-request-1',
       'provider_action_required', ?, ?, 4, 1, 1)`,
    )
    .run(
      ORGANISATION,
      WISE_DIGEST,
      JSON.stringify({
        plan: WISE_PLAN,
        approval: {
          receiptId: "receipt_1",
          approverId: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
          approvedAt: 20,
        },
        state: {
          kind: "provider_action_required",
          attemptId: "attempt_1",
          providerTransferId: "transfer_1",
          actionCode: "funding_required",
          observedAt: NOW,
        },
      }),
    );
  database
    .prepare(
      `INSERT INTO supplier_payout_attempt (
       organisation_id, payout_id, attempt_id, approval_digest, request_identity,
       provider_transfer_id, funding_operation_id, dispatched_at, updated_at
     ) VALUES (?, 'supplier_payout_1', 'attempt_1', ?, 'payout-request-1',
       'transfer_1', NULL, 1, 1)`,
    )
    .run(ORGANISATION, WISE_DIGEST);
  database
    .prepare(
      `UPDATE supplier_payable SET in_flight_minor = 10000 WHERE organisation_id = ?`,
    )
    .run(ORGANISATION);
}

async function propose(overrides: Record<string, unknown> = {}) {
  return proposeSupplierPayout({
    db,
    organisationId: ORGANISATION,
    payableId: "supplier_payable_1",
    destinationId: "destination_1",
    payoutId: "supplier_payout_1",
    proposalId: "proposal_1",
    idempotencyKey: "payout-request-1",
    recipientAmountMinor: 10_000,
    feeCeilingMinor: 500,
    rail: "gmo_aozora_private",
    integrationAccountId: "integration_gmo",
    expiresAt: "2026-09-07T00:00:00Z",
    now: 10,
    applyPayableCommand: allocator(),
    ...overrides,
  } as Parameters<typeof proposeSupplierPayout>[0]);
}

describe("supplier payout service", function payoutServiceSuite() {
  beforeEach(function freshDatabase() {
    database = new DatabaseSync(":memory:");
    database.exec(singleDatabaseSchema());
    db = d1Database(database);
    seed();
  });

  it("holds the money atomically with the proposal", async function holdsFirst() {
    const proposed = await propose();
    expect(proposed.ok).toBe(true);
    const payable = await readSupplierPayable(
      db,
      ORGANISATION,
      "supplier_payable_1",
    );
    // Held, so a second proposal cannot spend the same remaining balance.
    expect(payable?.inFlightMinor).toBe(10_000);
    expect(payable?.revision).toBe(2);
    const payout = await readSupplierPayout(
      db,
      ORGANISATION,
      "supplier_payout_1",
    );
    expect(payout?.stateKind).toBe("approval_pending");
    // Nothing has been approved, so there is no digest to record yet.
    expect(payout?.approvalDigest).toBeNull();
  });

  it("leaves no allocation when creating the payout fails", async function rollback() {
    database.exec(
      "CREATE TRIGGER fail_payout BEFORE INSERT ON supplier_payout BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
    );
    await expect(propose()).rejects.toThrow("interrupted");
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.inFlightMinor,
    ).toBe(0);
    expect(
      await readSupplierPayout(db, ORGANISATION, "supplier_payout_1"),
    ).toBeUndefined();
  });

  it("refuses to pay from a payable nobody approved", async function draftPayable() {
    database.prepare("UPDATE supplier_payable SET lifecycle = 'draft'").run();
    expect(await propose()).toMatchObject({
      ok: false,
      error: "payable_not_payable",
    });
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.inFlightMinor,
    ).toBe(0);
  });

  it("refuses to pay more than the payable still owes", async function overCommit() {
    expect(await propose({ recipientAmountMinor: 100_001 })).toMatchObject({
      ok: false,
      error: "insufficient_remaining",
    });
  });

  it("counts money already held against what remains", async function countsHeld() {
    database
      .prepare("UPDATE supplier_payable SET in_flight_minor = 95000")
      .run();
    expect(await propose({ recipientAmountMinor: 10_000 })).toMatchObject({
      ok: false,
      error: "insufficient_remaining",
    });
  });

  it("refuses a destination that is not in force", async function inactiveDestination() {
    database
      .prepare("UPDATE supplier_destination_revision SET state = 'retired'")
      .run();
    expect(await propose()).toMatchObject({
      ok: false,
      error: "destination_not_active",
    });
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.inFlightMinor,
    ).toBe(0);
  });

  it("holds nothing when the contract refuses the allocation", async function allocationRefused() {
    expect(
      await propose({ applyPayableCommand: allocator({ fail: true }) }),
    ).toMatchObject({ ok: false, error: "allocation_conflict" });
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.inFlightMinor,
    ).toBe(0);
  });

  it("returns the earlier payout for a repeated request", async function idempotent() {
    await propose();
    const again = await propose({ payoutId: "supplier_payout_2" });
    expect(again).toMatchObject({ ok: false, error: "payout_exists" });
    expect(again.ok === false && again.existing?.payoutId).toBe(
      "supplier_payout_1",
    );
    // And it did not hold the money a second time.
    expect(
      (await readSupplierPayable(db, ORGANISATION, "supplier_payable_1"))
        ?.inFlightMinor,
    ).toBe(10_000);
  });

  it("seals the exact economics on approval", async function seals() {
    await propose();
    const approved = await approveSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      plan: PLAN,
      approverId: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
      approvalReceiptId: "receipt_1",
      executionDeadline: "2026-09-07T00:00:00Z",
      now: 20,
      validate: VALID,
      readDestinationProposer: async () => "operator_maker",
    });
    expect(approved.ok).toBe(true);
    const payout = await readSupplierPayout(
      db,
      ORGANISATION,
      "supplier_payout_1",
    );
    expect(payout?.stateKind).toBe("approved");
    expect(payout?.approvalDigest).toBe(DIGEST);
  });

  it("will not let the person who wrote the bank details authorize paying them", async function makerChecker() {
    await propose();
    const approved = await approveSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      plan: PLAN,
      // The same operator who proposed the destination.
      approverId: "operator_maker",
      approvalReceiptId: "receipt_1",
      executionDeadline: "2026-09-07T00:00:00Z",
      now: 20,
      validate: VALID,
      readDestinationProposer: async () => "operator_maker",
    });
    expect(approved).toEqual({ ok: false, error: "approver_is_proposer" });
    expect(
      (await readSupplierPayout(db, ORGANISATION, "supplier_payout_1"))
        ?.stateKind,
    ).toBe("approval_pending");
  });

  it("will not seal a plan that does not describe its own economics", async function economicsChanged() {
    await propose();
    const approved = await approveSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      plan: PLAN,
      approverId: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
      approvalReceiptId: "receipt_1",
      executionDeadline: "2026-09-07T00:00:00Z",
      now: 20,
      validate: () => ({
        ok: true,
        value: { economicsDigest: DIGEST, matchesApproval: false },
      }),
      readDestinationProposer: async () => "operator_maker",
    });
    expect(approved).toEqual({ ok: false, error: "economics_changed" });
  });

  it("moves a payout to submitting before the provider is called", async function submittingFirst() {
    certify();
    await propose();
    await approveSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      plan: PLAN,
      approverId: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
      approvalReceiptId: "receipt_1",
      executionDeadline: "2026-09-07T00:00:00Z",
      now: 20,
      validate: VALID,
      readDestinationProposer: async () => "operator_maker",
    });
    let stateAtCallTime: string | undefined;
    const provider: SupplierPayoutProvider = {
      async createTransfer() {
        stateAtCallTime = (
          await readSupplierPayout(db, ORGANISATION, "supplier_payout_1")
        )?.stateKind;
        return { kind: "accepted", providerTransferId: "transfer_1" };
      },
      async fundTransfer() {
        return { kind: "funded", fundingOperationId: "funding_1" };
      },
      async inquireTransfer() {
        return { kind: "unknown" };
      },
      async inquireFunding() {
        return { kind: "unknown" };
      },
    };
    const store: PayoutAttemptStore = {
      async recordDispatch() {},
      async recordProviderTransfer() {},
      async recordFundingDispatch() {},
    };
    const submitted = await submitSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      plan: PLAN,
      sourceReference: "source_account_1",
      environment: "development",
      now: NOW,
      provider,
      store,
      validate: VALID,
    });
    // An interruption at the provider leaves a payout recovery can ask
    // about, not one that still looks ready to send.
    expect(stateAtCallTime).toBe("submitting");
    expect(submitted.ok).toBe(true);
    expect(
      (await readSupplierPayout(db, ORGANISATION, "supplier_payout_1"))
        ?.stateKind,
    ).toBe("provider_pending");
  });

  it("refuses to submit a payout nobody approved", async function notApproved() {
    await propose();
    const submitted = await submitSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      plan: PLAN,
      sourceReference: "source_account_1",
      environment: "development",
      now: NOW,
      provider: {
        async createTransfer() {
          throw new Error("must not reach the provider");
        },
        async fundTransfer() {
          throw new Error("must not reach the provider");
        },
        async inquireTransfer() {
          return { kind: "unknown" };
        },
        async inquireFunding() {
          return { kind: "unknown" };
        },
      },
      store: {
        async recordDispatch() {},
        async recordProviderTransfer() {},
        async recordFundingDispatch() {},
      },
      validate: VALID,
    });
    expect(submitted).toEqual({ ok: false, error: "not_approved" });
  });

  it("refuses to send on a rail nothing has certified", async function uncertified() {
    await propose();
    await approveSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      plan: PLAN,
      approverId: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
      approvalReceiptId: "receipt_1",
      executionDeadline: "2026-09-07T00:00:00Z",
      now: 20,
      validate: VALID,
      readDestinationProposer: async () => "operator_maker",
    });
    const submitted = await submitSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      plan: PLAN,
      sourceReference: "source_account_1",
      environment: "development",
      now: NOW,
      provider: {
        async createTransfer() {
          throw new Error("must not reach an uncertified rail");
        },
        async fundTransfer() {
          throw new Error("must not reach an uncertified rail");
        },
        async inquireTransfer() {
          return { kind: "unknown" };
        },
        async inquireFunding() {
          return { kind: "unknown" };
        },
      },
      store: {
        async recordDispatch() {},
        async recordProviderTransfer() {},
        async recordFundingDispatch() {},
      },
      validate: VALID,
    });
    // An approval is a person agreeing; it is not evidence the rail works.
    expect(submitted).toEqual({ ok: false, error: "uncertified_rail" });
    expect(
      (await readSupplierPayout(db, ORGANISATION, "supplier_payout_1"))
        ?.stateKind,
    ).toBe("approved");
  });

  it("refuses to send more than the rail was certified for", async function aboveCeiling() {
    certify(5_000);
    await propose();
    await approveSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      plan: PLAN,
      approverId: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
      approvalReceiptId: "receipt_1",
      executionDeadline: "2026-09-07T00:00:00Z",
      now: 20,
      validate: VALID,
      readDestinationProposer: async () => "operator_maker",
    });
    const submitted = await submitSupplierPayout({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      attemptId: "attempt_1",
      plan: PLAN,
      sourceReference: "source_account_1",
      environment: "development",
      now: NOW,
      provider: {
        async createTransfer() {
          throw new Error("must not send above the certified ceiling");
        },
        async fundTransfer() {
          throw new Error("must not send above the certified ceiling");
        },
        async inquireTransfer() {
          return { kind: "unknown" };
        },
        async inquireFunding() {
          return { kind: "unknown" };
        },
      },
      store: {
        async recordDispatch() {},
        async recordProviderTransfer() {},
        async recordFundingDispatch() {},
      },
      validate: VALID,
    });
    // The payout is 10,000; the rail was only proved to 5,000.
    expect(submitted).toEqual({ ok: false, error: "uncertified_rail" });
  });

  it("records uncertain resumed funding once and leaves recovery inquiry-only", async function uncertainFundingResume() {
    seedWiseFundingRequired();
    const fundTransfer = vi.fn(async () => ({ kind: "unknown" as const }));
    const provider: SupplierPayoutProvider = {
      async createTransfer() {
        throw new Error("must not create another transfer");
      },
      fundTransfer,
      async inquireTransfer() {
        return { kind: "unknown" };
      },
      async inquireFunding() {
        return { kind: "unknown" };
      },
    };
    const store = createSupplierPayoutAttemptStore({
      db,
      organisationId: ORGANISATION,
      now: fixedClock,
    });
    const resumed = await resumeSupplierPayoutFunding({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      expectedPayoutRevision: 4,
      attemptId: "attempt_1",
      providerTransferId: "transfer_1",
      sourceReference: "profile_1",
      environment: "development",
      now: NOW,
      provider,
      store,
      validate: validateSupplierPayoutPlanWithLexicon,
    });
    expect(resumed.ok).toBe(true);
    expect(fundTransfer).toHaveBeenCalledTimes(1);
    expect(
      (await readSupplierPayout(db, ORGANISATION, "supplier_payout_1"))
        ?.stateKind,
    ).toBe("indeterminate");
    expect(
      (await readSupplierPayoutAttempt(db, ORGANISATION, "attempt_1"))
        ?.fundingOperationId,
    ).toBe("funding:attempt_1");

    const repeated = await resumeSupplierPayoutFunding({
      db,
      organisationId: ORGANISATION,
      payoutId: "supplier_payout_1",
      expectedPayoutRevision: 5,
      attemptId: "attempt_1",
      providerTransferId: "transfer_1",
      sourceReference: "profile_1",
      environment: "development",
      now: NOW,
      provider,
      store,
      validate: validateSupplierPayoutPlanWithLexicon,
    });
    expect(repeated).toEqual({ ok: false, error: "not_funding_required" });
    expect(fundTransfer).toHaveBeenCalledTimes(1);
  });
});

function fixedClock(): number {
  return Date.parse(NOW);
}
