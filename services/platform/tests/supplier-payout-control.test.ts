import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { createOrganisationExecutionFixture } from "./organisation-execution-fixture";
/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

const payoutControlMocks = vi.hoisted(() => ({
  authorizeOrganisationRequest: vi.fn(),
  resolveUser: vi.fn(),
  readControlMutationReplay: vi.fn(),
  recordCommerceMutationReceipt: vi.fn(),
  applySupplierPayableCommandWithLexicon: vi.fn(),
}));

vi.mock("@purin-labs/control/worker/authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/control/worker/authorization")>()),
  authorizeOrganisationRequest: payoutControlMocks.authorizeOrganisationRequest,
}));
vi.mock("@purin-labs/tenancy/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/tenancy/data/control-plane")>()),
  resolveUser: payoutControlMocks.resolveUser,
}));
vi.mock("@purin-labs/tenancy/data/control-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/tenancy/data/control-mutation")>()),
  readControlMutationReplay: payoutControlMocks.readControlMutationReplay,
}));
vi.mock("@purin-labs/control/worker/mutation-receipt", () => ({
  recordCommerceMutationReceipt:
    payoutControlMocks.recordCommerceMutationReceipt,
}));
vi.mock("../src/commerce/commerce-wasm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commerce/commerce-wasm")>()),
  applySupplierPayableCommandWithLexicon:
    payoutControlMocks.applySupplierPayableCommandWithLexicon,
}));

import { handleControlRequest } from "../src/control-router";
import { readSupplierDestinationRevision } from "../src/data/supplier-payable-store";
import { parseOrganisationId, type OrganisationId } from "@purin-labs/kernel/ids";
import { d1Database } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";
import { createAccessGrant } from "@purin-labs/authority/data/access-grants";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { defaultDenyPolicy } from "@purin-labs/authority/policy-snapshot";

const ORGANISATION_ID = "organisation_payout_control";
const BASE = `https://pantry.example/v1/control/organisations/${ORGANISATION_ID}/commerce`;

let db: SingleDatabase;
let database: DatabaseSync;

function env(): UnitTestEnv {
  return platformEnv({
    PANTRY_PUBLIC_ORIGIN: "https://pantry.example",
    DB: db,
  });
}

function mutation(
  url: string,
  body: Record<string, unknown>,
  key = "payout-test",
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      origin: "https://pantry.example",
      cookie:
        "pantry_session=session-payout; pantry_csrf=csrf-payout",
      "x-pantry-csrf": "csrf-payout",
      "idempotency-key": key,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function read(url: string): Request {
  return new Request(url, {
    headers: { cookie: "pantry_session=session-payout" },
  });
}

function seed(): void {
  database
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Payout control', 'beta', 1, 'active')`,
    )
    .run(ORGANISATION_ID);
  database
    .prepare(
      `INSERT INTO organisation_onboarding (
      organisation_id, environment, lifecycle, capability_profile,
      configuration_version, projection_revision, activation_receipt_id,
      activated_at, updated_at
    ) VALUES (?, 'development', 'active', 'read_and_propose', 1, 1,
      'payout-control-fixture', 1, 1)`,
    )
    .run(ORGANISATION_ID);
  database
    .prepare(
      `INSERT INTO supplier_payable (
       organisation_id, payable_id, merchant_id, supplier_id, purchase_request_id,
       currency, gross_amount_minor, in_flight_minor, settled_minor,
       lifecycle, revision, payable_json, updated_at
     ) VALUES (?, 'supplier_payable_1', 'merchant_1', 'supplier_1',
       'purchase_request_1', 'JPY', 100000, 0, 0, 'approved', 1, ?, 1)`,
    )
    .run(
      ORGANISATION_ID,
      JSON.stringify({
        revision: 1,
        lifecycle: "approved",
        allocation: {
          inFlight: { currency: "JPY", amountMinor: 0 },
          settled: { currency: "JPY", amountMinor: 0 },
        },
      }),
    );
  database
    .prepare(
      `INSERT INTO supplier_destination_revision (
       organisation_id, revision_id, destination_id, supplier_id, rail,
       masked_summary, configuration_ref, state, proposed_by, activated_by,
       revision, destination_json, updated_at
     ) VALUES (?, 'destination_revision_active', 'destination_1', 'supplier_1',
       'gmo_aozora_domestic', 'Sumitomo ****1234', 'vault_ref_1', 'active',
       'operator_maker', 'user_31f9ff59-f15d-5e24-a376-5a8d42b7af68', 1, '{}', 1)`,
    )
    .run(ORGANISATION_ID);
}

async function allowPayoutReads(organisationId: OrganisationId): Promise<void> {
  const policy = defaultDenyPolicy({ now: 1 });
  policy.version = 1;
  policy.authz.allowedTools = [CAPABILITY_KEYS.commerceSupplierPayoutRead];
  await db
    .prepare(
      "INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by) VALUES (?, 1, ?, 1, 'payout-control-fixture')",
    )
    .bind(organisationId, JSON.stringify(policy))
    .run();
  const grant = await createAccessGrant({
    db,
    organisationId,
    grantId: "grant_payout_control_read",
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "platform_capability",
      capabilityId: CAPABILITY_KEYS.commerceSupplierPayoutRead,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "payout-control-fixture",
    },
    now: 1,
  });
  if (!grant.ok) throw new Error(grant.error.code);
}

function proposalBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    payableId: "supplier_payable_1",
    destinationId: "destination_1",
    recipientAmountMinor: 10_000,
    feeCeilingMinor: 500,
    rail: "gmo_aozora_private",
    integrationAccountId: "integration_gmo",
    ...overrides,
  };
}

describe("supplier payout control routes", function payoutControlSuite() {
  beforeEach(async function configure() {
    vi.clearAllMocks();
    database = new DatabaseSync(":memory:");
    database.exec(singleDatabaseSchema());
    db = d1Database(database);
    seed();
    const organisationId = parseOrganisationId(ORGANISATION_ID);
    if (!organisationId.ok)
      throw new Error("Payout control organisation fixture is invalid");
    payoutControlMocks.authorizeOrganisationRequest.mockResolvedValue({
      ok: true,
      executionScope: await createOrganisationExecutionFixture(
        db,
        organisationId.value,
      ),
      organisationId: organisationId.value,
      authenticated: {
        token: "session-payout",
        session: {
          userId: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
          expiresAt: Date.now() + 60_000,
        },
      },
      membership: {
        organisationId: organisationId.value,
        personId: "person_payout_owner",
        role: "owner",
      },
    });
    await allowPayoutReads(organisationId.value);
    payoutControlMocks.resolveUser.mockResolvedValue({
      userId: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
      issuer: "https://accounts.google.com",
      subject: "payout-subject",
      email: "checker@example.test",
      displayName: "Checker",
      emailVerified: true,
      createdAt: Date.now() - 60_000,
      lastAuthenticatedAt: Date.now() - 60_000,
    });
    payoutControlMocks.readControlMutationReplay.mockResolvedValue({
      kind: "absent",
    });
    payoutControlMocks.recordCommerceMutationReceipt.mockResolvedValue({
      ok: true,
      value: null,
    });
    payoutControlMocks.applySupplierPayableCommandWithLexicon.mockImplementation(
      ({ payable, command }: { payable: unknown; command: unknown }) => {
        const current = payable as {
          revision: number;
          allocation: { inFlight: { amountMinor: number }; settled: unknown };
        };
        const amount = (command as { amount: { amountMinor: number } }).amount
          .amountMinor;
        return {
          ok: true,
          value: {
            ...current,
            revision: current.revision + 1,
            lifecycle: "approved",
            allocation: {
              inFlight: {
                currency: "JPY",
                amountMinor: current.allocation.inFlight.amountMinor + amount,
              },
              settled: current.allocation.settled,
            },
          },
        };
      },
    );
  });

  it("proposes a payout awaiting approval", async function proposes() {
    const response = await handleControlRequest(
      mutation(`${BASE}/supplier-payouts`, proposalBody()),
      env(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      supplierPayout: {
        supplierId: "supplier_1",
        recipientAmountMinor: 10_000,
        state: "approval_pending",
        // Nothing approved yet, so nothing sealed.
        approved: false,
      },
    });
  });

  it("refuses a proposal above what the payable owes", async function overCommit() {
    const response = await handleControlRequest(
      mutation(
        `${BASE}/supplier-payouts`,
        proposalBody({ recipientAmountMinor: 200_000 }),
      ),
      env(),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "insufficient_remaining",
    });
  });

  it("refuses a rail it does not settle", async function unknownRail() {
    const response = await handleControlRequest(
      mutation(
        `${BASE}/supplier-payouts`,
        proposalBody({ rail: "paypal_mass_pay" }),
      ),
      env(),
    );
    expect(response.status).toBe(422);
  });

  it("returns the earlier payout for a repeated proposal", async function idempotent() {
    await handleControlRequest(
      mutation(`${BASE}/supplier-payouts`, proposalBody()),
      env(),
    );
    // A different idempotency key, but the payout for the first one already
    // holds the money.
    const again = await handleControlRequest(
      mutation(`${BASE}/supplier-payouts`, proposalBody(), "payout-test"),
      env(),
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "payout_exists" });
  });

  it("lists the payouts whose outcome is unknown", async function workQueue() {
    await handleControlRequest(
      mutation(`${BASE}/supplier-payouts`, proposalBody()),
      env(),
    );
    database
      .prepare(
        "UPDATE supplier_payout SET state_kind = 'indeterminate', approval_digest = ?",
      )
      .run("ab".repeat(32));
    const response = await handleControlRequest(
      read(`${BASE}/supplier-payouts`),
      env(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      supplierPayouts: readonly { state: string }[];
    };
    expect(body.supplierPayouts).toHaveLength(1);
    expect(body.supplierPayouts[0]?.state).toBe("indeterminate");
  });

  it("downloads masked payout evidence through organisation authorization", async function audit() {
    await handleControlRequest(
      mutation(`${BASE}/supplier-payouts`, proposalBody()),
      env(),
    );
    const response = await handleControlRequest(
      read(`${BASE}/supplier-payouts/supplier_payout_payout-test/audit`),
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      maskedDestination: "Sumitomo ****1234",
      events: [],
      nextCursor: null,
    });
    expect(body).not.toContain("vault_ref_1");
    expect(
      payoutControlMocks.authorizeOrganisationRequest,
    ).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      ORGANISATION_ID,
      "viewer",
      false,
    );
    payoutControlMocks.authorizeOrganisationRequest.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    expect(
      (
        await handleControlRequest(
          read(`${BASE}/supplier-payouts/supplier_payout_payout-test/audit`),
          env(),
        )
      ).status,
    ).toBe(403);
  });

  it("never puts a bank account on a payout summary", async function masked() {
    await handleControlRequest(
      mutation(`${BASE}/supplier-payouts`, proposalBody()),
      env(),
    );
    const response = await handleControlRequest(
      read(`${BASE}/supplier-payouts`),
      env(),
    );
    const raw = JSON.stringify(await response.json());
    // A payout surface answers "did this supplier get paid", not "what are
    // their bank details".
    expect(raw).not.toMatch(/\d{7,}/u);
    expect(raw).not.toContain("vault_ref_1");
  });

  it("records proposed bank details as draft, never active", async function proposesDraft() {
    const response = await handleControlRequest(
      mutation(`${BASE}/supplier-destinations`, {
        destinationId: "destination_2",
        supplierId: "supplier_2",
        rail: "wise_recipient",
        maskedSummary: "Wise ****9876",
        configurationRef: "vault_ref_2",
      }),
      env(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      supplierDestination: { state: "draft" },
    });
  });

  it("refuses a summary that is not masked", async function unmasked() {
    const response = await handleControlRequest(
      mutation(`${BASE}/supplier-destinations`, {
        destinationId: "destination_2",
        supplierId: "supplier_2",
        rail: "wise_recipient",
        // A full account number is not a summary, whatever it is called.
        maskedSummary: "Wise 12345678901",
        configurationRef: "vault_ref_2",
      }),
      env(),
    );
    expect(response.status).toBe(422);
  });

  it("will not let the proposer activate their own bank details", async function makerChecker() {
    database
      .prepare(
        `INSERT INTO supplier_destination_revision (
           organisation_id, revision_id, destination_id, supplier_id, rail,
           masked_summary, configuration_ref, state, proposed_by, activated_by,
           revision, destination_json, updated_at
         ) VALUES (?, 'destination_revision_draft', 'destination_3', 'supplier_3',
           'wise_recipient', 'Wise ****1111', 'vault_ref_3', 'draft',
           'user_31f9ff59-f15d-5e24-a376-5a8d42b7af68', NULL, 1, '{}', 1)`,
      )
      .run(ORGANISATION_ID);
    const response = await handleControlRequest(
      mutation(
        `${BASE}/supplier-destinations/destination_revision_draft/activation`,
        {},
      ),
      env(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "activator_is_proposer",
    });
    const still = await readSupplierDestinationRevision(
      db,
      ORGANISATION_ID as OrganisationId,
      "destination_revision_draft",
    );
    expect(still?.state).toBe("draft");
  });

  it("activates bank details someone else proposed", async function activates() {
    database
      .prepare(
        `INSERT INTO supplier_destination_revision (
         organisation_id, revision_id, destination_id, supplier_id, rail,
         masked_summary, configuration_ref, state, proposed_by, activated_by,
         revision, destination_json, updated_at
       ) VALUES (?, 'destination_revision_draft', 'destination_3', 'supplier_3',
         'wise_recipient', 'Wise ****1111', 'vault_ref_3', 'draft',
         'operator_maker', NULL, 1, '{}', 1)`,
      )
      .run(ORGANISATION_ID);
    const response = await handleControlRequest(
      mutation(
        `${BASE}/supplier-destinations/destination_revision_draft/activation`,
        {},
      ),
      env(),
    );
    expect(response.status).toBe(200);
    const activated = await readSupplierDestinationRevision(
      db,
      ORGANISATION_ID as OrganisationId,
      "destination_revision_draft",
    );
    expect(activated?.state).toBe("active");
    expect(activated?.activatedBy).toBe(
      "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
    );
  });

  it("reports a payout that does not exist as absent", async function absent() {
    const response = await handleControlRequest(
      read(`${BASE}/supplier-payouts/supplier_payout_absent`),
      env(),
    );
    expect(response.status).toBe(404);
  });
});
