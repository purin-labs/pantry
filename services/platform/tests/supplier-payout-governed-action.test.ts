import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { createOrganisationExecutionFixture } from "./organisation-execution-fixture";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

// The receipt writer uses a batched session the SQLite fixture cannot bind.
// Mocked here for the same reason every other control-route test mocks it: the
// subject under test is the payout gating, not the receipt ledger.
vi.mock("@purin-labs/control/worker/mutation-receipt", () => ({
  recordCommerceMutationReceipt: vi.fn(async () => ({ ok: true, value: null })),
}));

import { executeApprovedSupplierPayout } from "@purin-labs/area-commerce/server/control/routes/supplier-payout-execution";
import { readSupplierPayout } from "@purin-labs/area-commerce/server/data/supplier-payout-store";
import {
  PAYOUT_CERTIFICATION_CHECKS,
  SUPPLIER_PAYOUT_ADAPTER_VERSIONS,
} from "@purin-labs/area-commerce/server/data/supplier-payout-certification";
import {
  parseOrganisationId,
  parseControlSessionId,
  parsePersonId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import { payoutPlan } from "./supplier-payout-fixtures";
import { d1Database } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

/**
 * The governed action path for a supplier payout, exercised through the
 * executor the control route actually calls.
 *
 * The provider rail behind it is the unavailable one, so a submission that
 * reaches a provider fails for the one true reason — no certified adapter —
 * rather than because a code path is missing.
 */

const ORGANISATION = "organisation_governed" as OrganisationId;
const PLAN = payoutPlan(ORGANISATION);
const DIGEST = PLAN.seal.approvalDigest;

let executionScope: OrganisationExecutionScope;
let db: SingleDatabase;
let database: DatabaseSync;

function env(): UnitTestEnv {
  return platformEnv({
    PANTRY_PUBLIC_ORIGIN: "https://pantry.example",
    DB: db,
  });
}

function authorized() {
  const organisationId = parseOrganisationId(ORGANISATION);
  const identityId = parseUserId("user_31f9ff59-f15d-5e24-a376-5a8d42b7af68");
  const sessionId = parseControlSessionId("session_governed");
  const personId = parsePersonId("person_checker");
  if (!organisationId.ok || !identityId.ok || !sessionId.ok || !personId.ok)
    throw new Error("governed action fixture is invalid");
  return {
    ok: true as const,
    executionScope,
    organisationId: organisationId.value,
    authenticated: {
      token: "session-governed",
      session: {
        kind: "active" as const,
        controlSessionId: sessionId.value,
        userId: identityId.value,
        rotationGeneration: 1,
        createdAt: 1,
        rotatedAt: 1,
        expiresAt: Date.now() + 60_000,
      },
    },
    membership: {
      kind: "active" as const,
      organisationId: organisationId.value,
      userId: identityId.value,
      personId: personId.value,
      createdAt: 1,
      role: "owner" as const,
    },
  };
}

function executionInput(
  overrides: Partial<Parameters<typeof executeApprovedSupplierPayout>[0]> = {},
): Parameters<typeof executeApprovedSupplierPayout>[0] {
  return {
    request: new Request("https://pantry.example/x", { method: "POST" }),
    env: env(),
    authorized: authorized(),
    identity: {
      issuer: "https://accounts.google.com",
      subject: "governed",
      userId: "user_31f9ff59-f15d-5e24-a376-5a8d42b7af68",
    },
    scope: {
      userId: authorized().authenticated.session.userId,
      organisationScope: ORGANISATION,
      route: "/x",
      operation: "commerce.action.execute",
    },
    boundary: {
      kind: "unversioned" as const,
      idempotencyKey: "governed-test",
      requestHash: "ab".repeat(32),
    },
    organisation: {},
    action: {},
    actionNonce: "nonce_governed",
    path: {
      kind: "submit_supplier_payout" as const,
      payoutId: "supplier_payout_1",
      expectedPayoutRevision: 2,
      approvalDigest: DIGEST,
    },
    now: 1000,
    ...overrides,
  };
}

function seed(stateKind = "approved", revision = 2): void {
  database
    .prepare(
      `INSERT INTO organisation_onboarding (
       organisation_id, environment, lifecycle, capability_profile,
       configuration_version, projection_revision, updated_at
     ) VALUES (?, 'development', 'configuring', 'read_and_propose', 1, 1, 1)`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO supplier_payable (
       organisation_id, payable_id, merchant_id, supplier_id, purchase_request_id,
       currency, gross_amount_minor, in_flight_minor, settled_minor,
       lifecycle, revision, payable_json, updated_at
     ) VALUES (?, 'supplier_payable_1', 'merchant_1', 'supplier_1',
       'purchase_request_1', 'JPY', 100000, 10000, 0, 'approved', 1, '{}', 1)`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO supplier_payout (
       organisation_id, payout_id, payable_id, supplier_id, purchase_request_id,
       rail, integration_account_id, destination_revision_id, currency,
       recipient_amount_minor, fee_ceiling_minor, idempotency_key,
       state_kind, approval_digest, payout_json, revision, created_at, updated_at
     ) VALUES (?, 'supplier_payout_1', 'supplier_payable_1', 'supplier_1',
       'purchase_request_1', 'gmo_aozora_private', 'integration_gmo',
       'destination_revision_1', 'JPY', 10000, 500, 'payout-request-1',
       ?, ?, ?, ?, 1, 1)`,
    )
    .run(
      ORGANISATION,
      stateKind,
      DIGEST,
      JSON.stringify({ plan: PLAN }),
      revision,
    );
}

function certify(): void {
  database
    .prepare(
      `INSERT INTO app_user (
       user_id, issuer, subject, email, display_name,
       email_verified, created_at, last_authenticated_at
     ) VALUES ('ci_gov', 'https://accounts.google.com', 'gov', 'g@test.invalid',
       'G', 1, 1, 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO provider_connection (
       provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
       credential_generation, credential_ref, lifecycle, granted_scopes,
       created_by_user_id, created_at, updated_at, environment
     ) VALUES ('pc_gov', ?, 'stripe', 'api_key', 'connection_credential',
       1, 'cred', 'active', '[]', 'ci_gov', 1, 1, 'development')`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO integration_account (
       integration_account_id, organisation_id, provider_connection_id, provider,
       provider_account_id, account_kind, display_name, lifecycle,
       lifecycle_reason_code, capability_set, audience_policy, retention_policy,
       created_at, updated_at, environment, is_default_for_provider
     ) VALUES ('integration_gmo', ?, 'pc_gov', 'stripe', 'pa_gov',
       'merchant_account', 'GMO', 'active', NULL, '[]', '{"kind":"operator"}',
       '{"kind":"organisation_default"}', 1, 1, 'development', 1)`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO supplier_payout_certification (
       organisation_id, test_run_id, rail, integration_account_id, source_reference,
       funding_mode, environment, adapter_version, evidence_source,
       matrix_version, checks_json, certified_currency, certified_maximum_minor,
       evidence_digest, certified_at, recorded_at, certified_by
     ) VALUES (?, 'run_gov', 'gmo_aozora_private', 'integration_gmo',
       'source_account_1', 'balance', 'development', ?, 'provider_sandbox',
       1, ?, 'JPY', 100000, ?, 1, 1, 'organisation_admin')`,
    )
    .run(
      ORGANISATION,
      SUPPLIER_PAYOUT_ADAPTER_VERSIONS.gmo_aozora_private,
      JSON.stringify([...PAYOUT_CERTIFICATION_CHECKS]),
      DIGEST,
    );
}

describe("supplier payout as a governed action", function governedSuite() {
  beforeEach(async function freshDatabase() {
    vi.clearAllMocks();
    database = new DatabaseSync(":memory:");
    database.exec(singleDatabaseSchema());
    db = d1Database(database);
    executionScope = await createOrganisationExecutionFixture(db, ORGANISATION);
  });

  it("refuses when the payout moved after the approval", async function staleRevision() {
    seed("approved", 3);
    const response = await executeApprovedSupplierPayout(executionInput());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "supplier_payout_revision_stale",
      payoutRevision: 3,
    });
  });

  it("refuses when the economics changed after the approval", async function movedEconomics() {
    seed();
    const response = await executeApprovedSupplierPayout(
      executionInput({
        path: {
          kind: "submit_supplier_payout",
          payoutId: "supplier_payout_1",
          expectedPayoutRevision: 2,
          approvalDigest: "cd".repeat(32),
        },
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "supplier_payout_economics_changed",
    });
  });

  it("refuses a payout nobody approved", async function notApproved() {
    seed("approval_pending");
    const response = await executeApprovedSupplierPayout(executionInput());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "supplier_payout_not_approved",
    });
  });

  it("keeps an uncertified rail disabled even on the governed path", async function uncertifiedRail() {
    seed();
    // No certification packet. An approval is a person agreeing; it is not
    // evidence the rail works, and the governed path must not be the door
    // that skips the check.
    const response = await executeApprovedSupplierPayout(executionInput());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "supplier_payout_rail_uncertified",
    });
    expect(
      (await readSupplierPayout(db, ORGANISATION, "supplier_payout_1"))
        ?.stateKind,
    ).toBe("approved");
  });

  it("reaches the provider once every gate passes, and fails on the rail", async function reachesRail() {
    seed();
    certify();
    const response = await executeApprovedSupplierPayout(executionInput());
    const body = (await response.json()) as Record<string, unknown>;
    const payout = await readSupplierPayout(
      db,
      ORGANISATION,
      "supplier_payout_1",
    );
    // Every governed check passed — revision, digest, approval state, and
    // certification — so the request reached the rail. What it must never do
    // is settle: no adapter exists behind that rail.
    expect(response.status).toBe(200);
    expect(payout?.stateKind).toBe("indeterminate");
    expect(body).toMatchObject({ ok: true });
    expect(JSON.stringify(body)).not.toMatch(
      /uncertified|revision_stale|economics_changed/u,
    );
  });
});
