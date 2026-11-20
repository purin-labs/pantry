import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { createOrganisationExecutionFixture } from "./organisation-execution-fixture";
/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";

import {
  parseTerminalAssignment,
  type TerminalAssignment,
} from "@purin-labs/commerce-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminalControlMocks = vi.hoisted(() => ({
  authorizeOrganisationRequest: vi.fn(),
  resolveUser: vi.fn(),
  readControlMutationReplay: vi.fn(),
  recordCommerceMutationReceipt: vi.fn(),
  resolveOrganisationCommerceMerchantBinding: vi.fn(),
  createCommerceClient: vi.fn(),
}));

vi.mock("../src/control/authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control/authorization")>()),
  authorizeOrganisationRequest:
    terminalControlMocks.authorizeOrganisationRequest,
}));
vi.mock("../src/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/control-plane")>()),
  resolveUser: terminalControlMocks.resolveUser,
}));
vi.mock("../src/data/control-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/control-mutation")>()),
  readControlMutationReplay: terminalControlMocks.readControlMutationReplay,
}));
vi.mock("../src/control/mutation-receipt", () => ({
  recordCommerceMutationReceipt:
    terminalControlMocks.recordCommerceMutationReceipt,
}));
vi.mock("../src/data/commerce-merchant-binding", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/data/commerce-merchant-binding")
  >()),
  resolveOrganisationCommerceMerchantBinding:
    terminalControlMocks.resolveOrganisationCommerceMerchantBinding,
}));
vi.mock("../src/commerce/contract/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commerce/contract/client")>()),
  createCommerceClient: terminalControlMocks.createCommerceClient,
}));

import { handleControlRequest } from "../src/control-router";
import { activateTerminalAssignment } from "../src/data/terminal-assignment-store";
import { parseOrganisationId, type OrganisationId } from "../src/ids";
import { d1Database } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const ORGANISATION_ID = "organisation_terminal_control";
const ROUTE = `https://pantry.example/v1/control/organisations/${ORGANISATION_ID}/commerce/terminal-operations`;
const ADAPTER = "square_terminal@2026-08-19";

let db: SingleDatabase;
let database: DatabaseSync;

describe("terminal operations control routes", function terminalControlSuite() {
  beforeEach(async function freshFixture() {
    vi.clearAllMocks();
    database = new DatabaseSync(":memory:");
    database.exec(singleDatabaseSchema());
    db = d1Database(database);
    seedOrganisation();
    const organisationId = parseOrganisationId(ORGANISATION_ID);
    if (!organisationId.ok)
      throw new Error("Terminal control organisation fixture is invalid");
    terminalControlMocks.authorizeOrganisationRequest.mockResolvedValue({
      ok: true,
      executionScope: await createOrganisationExecutionFixture(
        db,
        organisationId.value,
      ),
      organisationId: organisationId.value,
      authenticated: {
        token: "session-terminal",
        session: {
          userId: "user_7bad5cc8-9fd4-5b8f-b432-e8f025771882",
          expiresAt: Date.now() + 60_000,
        },
      },
      membership: { organisationId: organisationId.value, role: "owner" },
    });
    terminalControlMocks.resolveUser.mockResolvedValue({
      userId: "user_7bad5cc8-9fd4-5b8f-b432-e8f025771882",
      issuer: "https://accounts.google.com",
      subject: "terminal-control-subject",
      email: "owner@example.test",
      displayName: "Terminal Owner",
      emailVerified: true,
      createdAt: Date.now() - 60_000,
      lastAuthenticatedAt: Date.now() - 60_000,
    });
    terminalControlMocks.readControlMutationReplay.mockResolvedValue({
      kind: "absent",
    });
    terminalControlMocks.recordCommerceMutationReceipt.mockResolvedValue({
      ok: true,
      value: null,
    });
    terminalControlMocks.resolveOrganisationCommerceMerchantBinding.mockResolvedValue(
      {
        ok: false,
        error: { code: "underclerk_binding_not_found" },
      },
    );
    terminalControlMocks.createCommerceClient.mockReturnValue(null);
  });

  it("reads the counters an organisation sells card-present through", async function reads() {
    await activateTerminalAssignment({
      db,
      organisationId: ORGANISATION_ID as OrganisationId,
      assignment: assignment(),
      now: 1,
    });
    const response = await handleControlRequest(
      new Request(ROUTE, {
        headers: { cookie: "satyr_control_session=session-terminal" },
      }),
      env(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      terminalOperations: {
        schemaVersion: "satyr.terminal-operations.v2",
        counters: [
          {
            satyrLocationId: "pantry_location_1",
            blockedReason: null,
            paymentsLinked: false,
            assignment: { deviceId: "device_1", revision: 1 },
          },
        ],
      },
    });
  });

  it("rejects an unsupported method", async function readOnly() {
    const response = await handleControlRequest(
      new Request(ROUTE, {
        method: "PUT",
        headers: { cookie: "satyr_control_session=session-terminal" },
      }),
      env(),
    );
    expect(response.status).toBe(405);
  });

  it("retires a counter and reports it gone", async function retires() {
    await activateTerminalAssignment({
      db,
      organisationId: ORGANISATION_ID as OrganisationId,
      assignment: assignment(),
      now: 1,
    });
    const response = await handleControlRequest(retirementRequest(), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      terminalOperations: { counters: [] },
    });
    expect(
      terminalControlMocks.recordCommerceMutationReceipt,
    ).toHaveBeenCalledTimes(1);
  });

  it("reports a location with no assignment as absent rather than retired", async function absent() {
    const response = await handleControlRequest(retirementRequest(), env());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "terminal_assignment_not_found",
    });
  });
});

function retirementRequest(): Request {
  return new Request(`${ROUTE}/pantry_location_1/retirement`, {
    method: "POST",
    headers: {
      origin: "https://pantry.example",
      cookie:
        "satyr_control_session=session-terminal; satyr_control_csrf=csrf-terminal",
      "x-satyr-csrf": "csrf-terminal",
      "idempotency-key": "terminal-retirement-test",
      "content-type": "application/json",
    },
    body: "{}",
  });
}

function env(): UnitTestEnv {
  return platformEnv({
    PANTRY_PUBLIC_ORIGIN: "https://pantry.example",
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
}

function assignment(
  overrides: Record<string, unknown> = {},
): TerminalAssignment {
  const parsed = parseTerminalAssignment({
    assignmentId: "terminal_assignment_1",
    organisationId: ORGANISATION_ID,
    merchantId: "merchant_1",
    satyrLocationId: "pantry_location_1",
    account: {
      integrationAccountId: "integration_square",
      providerAccountId: "merchant_square",
      environment: "production",
      capabilityRevision: 1,
      country: "JP",
      currency: "JPY",
    },
    providerLocationId: "provider_location_1",
    target: { kind: "paired_physical", providerDeviceId: "device_1" },
    transport: "server_terminal",
    adapterVersion: ADAPTER,
    revision: 1,
    state: { kind: "active" },
    ...overrides,
  });
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.error.field}`);
  return parsed.value;
}

function seedOrganisation(): void {
  database
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Terminal operations control', 'beta', 1, 'active')`,
    )
    .run(ORGANISATION_ID);
  database
    .prepare(
      `INSERT INTO app_user (
       user_id, issuer, subject, email, display_name,
       email_verified, created_at, last_authenticated_at
     ) VALUES (
       'user_7bad5cc8-9fd4-5b8f-b432-e8f025771882', 'https://accounts.google.com',
       'terminal-control-subject', 'terminal-control@test.invalid',
       'Terminal Owner', 1, 1, 1
     )`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO provider_connection (
       provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
       credential_generation, credential_ref, lifecycle, granted_scopes,
       created_by_user_id, created_at, updated_at, environment,
       provider_subject_id
     ) VALUES (
       'connection_square', ?, 'square', 'api_key', 'connection_credential',
       1, 'vault:organisation_terminal_control:square:merchant_square:oauth:g1', 'active', '["payments.read"]',
       'user_7bad5cc8-9fd4-5b8f-b432-e8f025771882', 1, 1, 'production', 'merchant_square'
     )`,
    )
    .run(ORGANISATION_ID);
  database
    .prepare(
      `INSERT INTO integration_account (
       integration_account_id, organisation_id, provider_connection_id, provider,
       provider_account_id, account_kind, display_name, lifecycle,
       lifecycle_reason_code, capability_set, audience_policy, retention_policy,
       created_at, updated_at, environment, is_default_for_provider
     ) VALUES (
       'integration_square', ?, 'connection_square', 'square',
       'merchant_square', 'merchant_account', 'Square', 'active',
       NULL, '["payments.read"]', '{"kind":"operator"}',
       '{"kind":"organisation_default"}', 1, 1, 'production', 1
     )`,
    )
    .run(ORGANISATION_ID);
}
