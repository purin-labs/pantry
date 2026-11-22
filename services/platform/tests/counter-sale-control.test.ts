import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { createOrganisationExecutionFixture } from "./organisation-execution-fixture";
/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";

import {
  parseTerminalAssignment,
  type TerminalAssignment,
} from "@purin-labs/commerce-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const counterSaleMocks = vi.hoisted(() => ({
  authorizeOrganisationRequest: vi.fn(),
  readOrganisationEnvironment: vi.fn(),
  resolveUser: vi.fn(),
  resolveOrganisationCommerceMerchantBinding: vi.fn(),
  readControlMutationReplay: vi.fn(),
  recordCommerceMutationReceipt: vi.fn(),
  readSnapshot: vi.fn(),
  readCounterSale: vi.fn(),
  readPointOfSaleConfiguration: vi.fn(),
  createInPersonCheckout: vi.fn(),
  collectInPersonCheckoutPayment: vi.fn(),
  reconcileCounterSaleRefund: vi.fn(),
}));

vi.mock("../src/control/authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control/authorization")>()),
  authorizeOrganisationRequest: counterSaleMocks.authorizeOrganisationRequest,
}));
vi.mock("../src/control/organisation-runtime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/control/organisation-runtime")
  >()),
  readOrganisationEnvironment: counterSaleMocks.readOrganisationEnvironment,
}));
vi.mock("../src/data/commerce-merchant-binding", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/data/commerce-merchant-binding")
  >()),
  resolveOrganisationCommerceMerchantBinding:
    counterSaleMocks.resolveOrganisationCommerceMerchantBinding,
}));
vi.mock("../src/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/control-plane")>()),
  resolveUser: counterSaleMocks.resolveUser,
}));
vi.mock("../src/data/control-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/control-mutation")>()),
  readControlMutationReplay: counterSaleMocks.readControlMutationReplay,
}));
vi.mock("../src/control/mutation-receipt", () => ({
  recordCommerceMutationReceipt: counterSaleMocks.recordCommerceMutationReceipt,
}));
vi.mock("../src/commerce/contract/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commerce/contract/client")>()),
  createCommerceClient: vi.fn(() => ({
    readSnapshot: counterSaleMocks.readSnapshot,
    readCounterSale: counterSaleMocks.readCounterSale,
    readPointOfSaleConfiguration: counterSaleMocks.readPointOfSaleConfiguration,
    createInPersonCheckout: counterSaleMocks.createInPersonCheckout,
    collectInPersonCheckoutPayment:
      counterSaleMocks.collectInPersonCheckoutPayment,
    reconcileCounterSaleRefund: counterSaleMocks.reconcileCounterSaleRefund,
  })),
}));

import { handleControlRequest } from "../src/control-router";
import { activateTerminalAssignment } from "../src/data/terminal-assignment-store";
import { parseOrganisationId, type OrganisationId } from "@purin-labs/kernel/ids";
import { d1Database } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const ORGANISATION_ID = "organisation_counter_sale";
const MERCHANT_ID = "merchant_counter_sale";
const BASE = `https://pantry.example/v1/control/organisations/${ORGANISATION_ID}/commerce/counter-sales`;
const DIGEST = `quote_${"ab".repeat(32)}`;

let db: SingleDatabase;
let database: DatabaseSync;

function assignment(
  overrides: Record<string, unknown> = {},
): TerminalAssignment {
  const parsed = parseTerminalAssignment({
    assignmentId: "terminal_assignment_1",
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    pantryLocationId: "location_cafe",
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
    adapterVersion: "square_terminal@2026-08-19",
    revision: 4,
    state: { kind: "active" },
    ...overrides,
  });
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.error.field}`);
  return parsed.value;
}

function saleRequest(body: Record<string, unknown> = {}): Request {
  return counterRequest(BASE, {
    pantryLocationId: "location_cafe",
    checkoutId: "checkout_counter_1",
    lines: [
      {
        cartLineId: "cart_line_1",
        checkoutLineId: "checkout_line_1",
        source: { kind: "catalog", variantId: "variant_cookie" },
        quantity: { amount: 1, scale: 0, unit: "each" },
      },
    ],
    ...body,
  });
}

function collectionRequest(body: Record<string, unknown> = {}): Request {
  return counterRequest(`${BASE}/checkout_counter_1/collection`, {
    pantryLocationId: "location_cafe",
    checkoutRevision: 2,
    quoteDigest: DIGEST,
    amount: { amountMinor: 1200, currency: "JPY" },
    ...body,
  });
}

function counterRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      origin: "https://pantry.example",
      cookie:
        "pantry_session=session-counter; pantry_csrf=csrf-counter",
      "x-pantry-csrf": "csrf-counter",
      "idempotency-key": "counter-sale-test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function placedCounterSale(): Record<string, unknown> {
  return {
    checkout: {
      checkoutId: "checkout_counter_1",
      source: {
        kind: "point_of_sale",
        pantryLocationId: "location_cafe",
        posConfigurationRevision: 7,
        operatorIdentity: "user_7585a72f-b277-50a2-8525-d876e77d83f8",
        terminalAssignmentRevision: 4,
        buyer: { kind: "anonymous" },
      },
      checkoutProfile: {
        checkoutProfileId: "checkout_profile_counter",
        revision: 2,
      },
      revision: 3,
      lifecycle: {
        state: "accepted",
        orderId: "order_counter_1",
        acceptedAt: "2026-09-05T00:00:00.000Z",
      },
    },
    paymentAttempt: {
      paymentAttemptId: "payment_attempt_1",
      revision: 2,
      binding: {},
      lifecycle: {
        state: "captured",
        providerPaymentReference: "square_payment_1",
        capturedAt: "2026-09-05T00:00:00.000Z",
      },
    },
  };
}

function placedSnapshot(
  refundStatus: "pending" | "completed",
): Record<string, unknown> {
  return {
    merchantRevision: refundStatus === "pending" ? 12 : 13,
    resources: {
      orders: [
        {
          id: "order_counter_1",
          revision: refundStatus === "pending" ? 2 : 3,
          lineItems: [],
          totals: {
            shipping: { amountMinor: 0, currency: "JPY" },
          },
          adjustments: [{ kind: "refund", status: refundStatus }],
          lifecycle: { state: "fulfilled" },
        },
      ],
      payments: [
        {
          id: "payment_counter_1",
          revision: refundStatus === "pending" ? 1 : 2,
          orderId: "order_counter_1",
          amount: { amountMinor: 1200, currency: "JPY" },
          lifecycle:
            refundStatus === "pending"
              ? { state: "captured" }
              : { state: "refunded" },
        },
      ],
      fulfillments: [
        {
          kind: "pickup",
          id: "fulfillment_counter_1",
          revision: 3,
          orderId: "order_counter_1",
          lifecycle: { state: "completed" },
        },
      ],
    },
  };
}

function env(): UnitTestEnv {
  return platformEnv({
    PANTRY_PUBLIC_ORIGIN: "https://pantry.example",
    DB: db,
  });
}

describe("counter sale control routes", function counterSaleSuite() {
  beforeEach(async function configure() {
    vi.clearAllMocks();
    database = new DatabaseSync(":memory:");
    database.exec(singleDatabaseSchema());
    db = d1Database(database);
    await activateTerminalAssignment({
      db,
      organisationId: ORGANISATION_ID as OrganisationId,
      assignment: assignment(),
      now: 1,
    });
    const organisationId = parseOrganisationId(ORGANISATION_ID);
    if (!organisationId.ok)
      throw new Error("Counter sale organisation fixture is invalid");
    counterSaleMocks.authorizeOrganisationRequest.mockResolvedValue({
      ok: true,
      executionScope: await createOrganisationExecutionFixture(
        db,
        organisationId.value,
      ),
      organisationId: organisationId.value,
      authenticated: {
        token: "session-counter",
        session: {
          userId: "user_7585a72f-b277-50a2-8525-d876e77d83f8",
          expiresAt: Date.now() + 60_000,
        },
      },
      membership: { organisationId: organisationId.value, role: "owner" },
    });
    counterSaleMocks.readOrganisationEnvironment.mockResolvedValue(
      "production",
    );
    counterSaleMocks.resolveUser.mockResolvedValue({
      userId: "user_7585a72f-b277-50a2-8525-d876e77d83f8",
      issuer: "https://accounts.google.com",
      subject: "counter-sale-subject",
      email: "operator@example.test",
      displayName: "Counter Operator",
      emailVerified: true,
      createdAt: Date.now() - 60_000,
      lastAuthenticatedAt: Date.now() - 60_000,
    });
    counterSaleMocks.resolveOrganisationCommerceMerchantBinding.mockResolvedValue(
      {
        ok: true,
        value: { merchantId: MERCHANT_ID },
      },
    );
    counterSaleMocks.readControlMutationReplay.mockResolvedValue({
      kind: "absent",
    });
    counterSaleMocks.recordCommerceMutationReceipt.mockResolvedValue({
      ok: true,
      value: null,
    });
    counterSaleMocks.readSnapshot.mockResolvedValue({
      ok: true,
      value: { merchantRevision: 11 },
    });
    counterSaleMocks.readPointOfSaleConfiguration.mockResolvedValue({
      ok: true,
      value: { pantryLocationId: "location_cafe", revision: 7 },
    });
    counterSaleMocks.createInPersonCheckout.mockResolvedValue({
      ok: true,
      value: { outcome: "applied", checkoutId: "checkout_counter_1" },
    });
    counterSaleMocks.readCounterSale.mockResolvedValue({
      ok: true,
      value: {
        checkout: {
          checkoutId: "checkout_counter_1",
          source: {
            kind: "point_of_sale",
            pantryLocationId: "location_cafe",
            posConfigurationRevision: 7,
            operatorIdentity: "user_7585a72f-b277-50a2-8525-d876e77d83f8",
            terminalAssignmentRevision: 4,
            buyer: { kind: "anonymous" },
          },
          checkoutProfile: {
            checkoutProfileId: "checkout_profile_counter",
            revision: 2,
          },
          revision: 2,
          lifecycle: {
            state: "quoted",
            quote: {
              quoteDigest: DIGEST,
              checkoutRevision: 2,
              lines: [],
              totals: { total: { amountMinor: 1200, currency: "JPY" } },
            },
          },
        },
        paymentAttempt: null,
      },
    });
    counterSaleMocks.collectInPersonCheckoutPayment.mockResolvedValue({
      ok: true,
      value: {
        outcome: "ready",
        mutationOutcome: "applied",
        paymentAttemptId: "payment_attempt_counter-sale-test",
        session: {
          kind: "server_terminal_checkout",
          providerCheckoutReference: "sty_reference",
          deviceId: "device_1",
          expiresAt: "2026-09-05T00:05:00.000Z",
        },
      },
    });
    counterSaleMocks.reconcileCounterSaleRefund.mockResolvedValue({
      ok: true,
      value: placedCounterSale(),
    });
  });

  it("prices the sale by the policy and terminal actually in force", async function inForce() {
    const response = await handleControlRequest(saleRequest(), env());
    expect(response.status).toBe(200);
    const [command] =
      counterSaleMocks.createInPersonCheckout.mock.calls[0] ?? [];
    // Neither revision came from the request body.
    expect(command.posConfigurationRevision).toBe(7);
    expect(command.terminalAssignmentRevision).toBe(4);
    expect(command.expectedMerchantRevision).toBe(11);
    expect(command.merchantId).toBe(MERCHANT_ID);
    expect(command.operatorIdentity).toBe(
      "user_7585a72f-b277-50a2-8525-d876e77d83f8",
    );
    expect(command.buyer).toEqual({ kind: "anonymous" });
    // A counter sale pins no storefront profile: it is priced by the counter's
    // own published configuration.
    expect(command).not.toHaveProperty("checkoutProfile");
  });

  it("refuses to open a sale at a counter with no published policy", async function noPolicy() {
    counterSaleMocks.readPointOfSaleConfiguration.mockResolvedValue({
      ok: false,
      error: { kind: "http", status: 404, message: "not found" },
    });
    const response = await handleControlRequest(saleRequest(), env());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "counter_policy_not_found",
    });
    expect(counterSaleMocks.createInPersonCheckout).not.toHaveBeenCalled();
  });

  it("refuses to open a sale at a counter with no terminal", async function noTerminal() {
    const response = await handleControlRequest(
      saleRequest({ pantryLocationId: "location_without_terminal" }),
      env(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "terminal_assignment_not_found",
    });
    expect(counterSaleMocks.createInPersonCheckout).not.toHaveBeenCalled();
  });

  it("refuses to present an amount in a currency the terminal does not settle", async function currency() {
    const response = await handleControlRequest(
      collectionRequest({ amount: { amountMinor: 1200, currency: "USD" } }),
      env(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "counter_sale_currency_mismatch",
    });
    expect(
      counterSaleMocks.collectInPersonCheckoutPayment,
    ).not.toHaveBeenCalled();
  });

  it("replays a repeated collection rather than charging twice", async function replay() {
    counterSaleMocks.readControlMutationReplay.mockResolvedValue({
      kind: "replay",
      receipt: {
        responseBody: { ok: true, collection: { outcome: "ready" } },
        responseStatus: 200,
      },
    });
    const response = await handleControlRequest(collectionRequest(), env());
    expect(response.status).toBe(200);
    expect(
      counterSaleMocks.collectInPersonCheckoutPayment,
    ).not.toHaveBeenCalled();
  });

  it("refuses a second collection while the provider has not answered", async function unresolved() {
    counterSaleMocks.readCounterSale.mockResolvedValue({
      ok: true,
      value: {
        checkout: {
          checkoutId: "checkout_counter_1",
          source: {
            kind: "point_of_sale",
            pantryLocationId: "location_cafe",
            posConfigurationRevision: 7,
            operatorIdentity: "user_7585a72f-b277-50a2-8525-d876e77d83f8",
            terminalAssignmentRevision: 4,
            buyer: { kind: "anonymous" },
          },
          checkoutProfile: {
            checkoutProfileId: "checkout_profile_counter",
            revision: 2,
          },
          revision: 2,
          lifecycle: {
            state: "payment_pending",
            quote: {
              quoteDigest: DIGEST,
              checkoutRevision: 2,
              lines: [],
              totals: { total: { amountMinor: 1200, currency: "JPY" } },
            },
            paymentAttemptId: "payment_attempt_1",
          },
        },
        paymentAttempt: {
          paymentAttemptId: "payment_attempt_1",
          revision: 1,
          binding: {},
          lifecycle: {
            state: "indeterminate",
            reasonCode: "provider_timeout",
            reconcileAfter: "2026-09-05T00:00:00.000Z",
          },
        },
      },
    });
    const response = await handleControlRequest(collectionRequest(), env());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "counter_sale_not_collectable",
      counterSale: { state: "submission_unknown", collectable: false },
    });
    // Nothing reached the terminal, so no second charge was possible.
    expect(
      counterSaleMocks.collectInPersonCheckoutPayment,
    ).not.toHaveBeenCalled();
  });

  it("refuses a second collection on money already taken", async function captured() {
    counterSaleMocks.readCounterSale.mockResolvedValue({
      ok: true,
      value: {
        checkout: {
          checkoutId: "checkout_counter_1",
          source: {
            kind: "point_of_sale",
            pantryLocationId: "location_cafe",
            posConfigurationRevision: 7,
            operatorIdentity: "user_7585a72f-b277-50a2-8525-d876e77d83f8",
            terminalAssignmentRevision: 4,
            buyer: { kind: "anonymous" },
          },
          checkoutProfile: {
            checkoutProfileId: "checkout_profile_counter",
            revision: 2,
          },
          revision: 2,
          lifecycle: {
            state: "payment_pending",
            quote: {
              quoteDigest: DIGEST,
              checkoutRevision: 2,
              lines: [],
              totals: { total: { amountMinor: 1200, currency: "JPY" } },
            },
            paymentAttemptId: "payment_attempt_1",
          },
        },
        paymentAttempt: {
          paymentAttemptId: "payment_attempt_1",
          revision: 1,
          binding: {},
          lifecycle: {
            state: "captured",
            providerPaymentReference: "square_payment_1",
            capturedAt: "2026-09-05T00:00:00.000Z",
          },
        },
      },
    });
    const response = await handleControlRequest(collectionRequest(), env());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      counterSale: { state: "captured_unplaced" },
    });
    expect(
      counterSaleMocks.collectInPersonCheckoutPayment,
    ).not.toHaveBeenCalled();
  });

  it("reads a sale back with the state its payment is actually in", async function reads() {
    const response = await handleControlRequest(
      new Request(`${BASE}/checkout_counter_1`, {
        headers: { cookie: "pantry_session=session-counter" },
      }),
      env(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      counterSale: {
        schemaVersion: "pantry.counter-sale.v1",
        checkoutId: "checkout_counter_1",
        pantryLocationId: "location_cafe",
        state: "awaiting_collection",
        collectable: true,
      },
    });
  });

  it("reconciles a pending refund instead of creating another refund", async function refundRecovery() {
    counterSaleMocks.readCounterSale.mockResolvedValue({
      ok: true,
      value: placedCounterSale(),
    });
    counterSaleMocks.readSnapshot
      .mockResolvedValueOnce({ ok: true, value: placedSnapshot("pending") })
      .mockResolvedValueOnce({ ok: true, value: placedSnapshot("completed") });

    const response = await handleControlRequest(
      counterRequest(`${BASE}/checkout_counter_1/refund`, {}),
      env(),
    );

    expect(response.status).toBe(200);
    expect(counterSaleMocks.reconcileCounterSaleRefund).toHaveBeenCalledWith(
      MERCHANT_ID,
      "checkout_counter_1",
    );
    expect(await response.json()).toMatchObject({
      ok: true,
      counterSale: { afterSale: { refundState: "completed" } },
    });
  });
});
