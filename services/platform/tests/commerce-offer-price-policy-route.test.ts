import {
  TEST_ACTIVE_ORGANISATION_PLACEMENT_ROW,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
/// <reference types="@cloudflare/workers-types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const controlMocks = vi.hoisted(() => ({
  authorizeOrganisationControl: vi.fn(),
  resolveControlSession: vi.fn(),
  validateControlCsrf: vi.fn(),
}));
const bindingMocks = vi.hoisted(() => ({
  resolveOrganisationCommerceMerchantBinding: vi.fn(),
}));
const clientMocks = vi.hoisted(() => ({
  createCommerceClient: vi.fn(),
}));

vi.mock("@purin-labs/tenancy/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/tenancy/data/control-plane")>()),
  authorizeOrganisationControl: controlMocks.authorizeOrganisationControl,
  resolveControlSession: controlMocks.resolveControlSession,
  validateControlCsrf: controlMocks.validateControlCsrf,
}));
vi.mock("@purin-labs/connections/data/commerce-merchant-binding", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@purin-labs/connections/data/commerce-merchant-binding")
  >()),
  resolveOrganisationCommerceMerchantBinding:
    bindingMocks.resolveOrganisationCommerceMerchantBinding,
}));
vi.mock("../src/commerce/contract/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commerce/contract/client")>()),
  createCommerceClient: clientMocks.createCommerceClient,
}));

import { handleControlRequest } from "../src/control-router";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const ORGANISATION_ID = "organisation_price_policy";
const MERCHANT_ID = "merchant_cafe";
const OFFER_PATH = "commerce%3Amerchant_cafe%3Aoffer_coffee";
const ROUTE = `https://pantry.example/v1/control/organisations/${ORGANISATION_ID}/commerce/offers/${OFFER_PATH}/price-policy`;

describe("Offer price policy control route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bindingMocks.resolveOrganisationCommerceMerchantBinding.mockResolvedValue({
      ok: true,
      value: { merchantId: MERCHANT_ID },
    });
  });

  it("refuses to let an admin grant pricing authority", async () => {
    authorizeAs("admin");
    const client = commerceEngineClient({ setOfferPricePolicy: vi.fn() });

    const response = await handleControlRequest(
      write("PUT", { expectedRevision: null, maxMovementBps: 500 }),
      routeEnv(),
    );

    // Enabling an allowance is what lets the agent reprice unattended, so it
    // sits above the role that may merely configure the agent. Control routes
    // report an insufficient role as absence.
    expect(response.status).toBe(404);
    expect(client.setOfferPricePolicy).not.toHaveBeenCalled();
  });

  it("rejects an allowance wider than the whole price", async () => {
    authorizeAs("owner");
    const client = commerceEngineClient({ setOfferPricePolicy: vi.fn() });

    const response = await handleControlRequest(
      write("PUT", { expectedRevision: null, maxMovementBps: 10_001 }),
      routeEnv(),
    );

    expect(response.status).toBe(422);
    expect(client.setOfferPricePolicy).not.toHaveBeenCalled();
  });

  it("does not reach Commerce when no merchant is bound", async () => {
    authorizeAs("viewer");
    bindingMocks.resolveOrganisationCommerceMerchantBinding.mockResolvedValue({
      ok: false,
      error: { code: "commerce_binding_not_found" },
    });
    const client = commerceEngineClient({ readOfferPricePolicy: vi.fn() });

    const response = await handleControlRequest(read(), routeEnv());

    expect(response.status).toBe(503);
    expect(client.readOfferPricePolicy).not.toHaveBeenCalled();
  });
});

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 } as const;

const COOKIE =
  "pantry_session=session-price; pantry_csrf=csrf-price";

function read(): Request {
  return new Request(ROUTE, { headers: { cookie: COOKIE } });
}

function write(
  method: "PUT" | "DELETE",
  body: unknown,
  idempotencyKey = "price-policy-once",
): Request {
  return new Request(ROUTE, {
    method,
    headers: {
      cookie: COOKIE,
      origin: "https://pantry.example",
      "x-pantry-csrf": "csrf-price",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

function authorizeAs(role: "viewer" | "admin" | "owner"): void {
  const now = Date.now();
  controlMocks.resolveControlSession.mockResolvedValue({
    ok: true,
    value: {
      kind: "active",
      controlSessionId: "control_session_price",
      userId: "user_0b1a0c7c-370c-5cc3-bd7d-6d0b62bb39b5",
      rotationGeneration: 1,
      createdAt: now,
      rotatedAt: now,
      expiresAt: now + 60_000,
    },
  });
  controlMocks.validateControlCsrf.mockResolvedValue({ ok: true, value: true });
  // Honour the role the route asks for, so the test exercises the gate itself
  // rather than a mock that lets every membership through.
  controlMocks.authorizeOrganisationControl.mockImplementation(
    async (input: { readonly requiredRole: keyof typeof ROLE_RANK }) =>
      ROLE_RANK[role] >= ROLE_RANK[input.requiredRole]
        ? {
            ok: true,
            value: {
              session: undefined,
              membership: {
                kind: "active",
                organisationId: ORGANISATION_ID,
                userId: "user_0b1a0c7c-370c-5cc3-bd7d-6d0b62bb39b5",
                personId: "person_price",
                role,
                createdAt: now - 60_000,
              },
            },
          }
        : { ok: false, error: { code: "organisation_role_insufficient" } },
  );
}

function commerceEngineClient(
  methods: Record<string, unknown>,
): Record<string, ReturnType<typeof vi.fn>> {
  const client = {
    readOfferPricePolicy: vi.fn(),
    setOfferPricePolicy: vi.fn(),
    ...methods,
  } as Record<string, ReturnType<typeof vi.fn>>;
  clientMocks.createCommerceClient.mockReturnValue(client);
  return client;
}

function routeEnv(): UnitTestEnv {
  const first = vi.fn().mockResolvedValue({
    ...TEST_ACTIVE_ORGANISATION_PLACEMENT_ROW,
    environment: "development",
  });
  const all = vi.fn().mockResolvedValue({ results: [] });
  const bind = vi.fn().mockReturnValue({ first, all });
  return platformEnv({
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    DB: {
      prepare: vi.fn().mockReturnValue({ bind }),
      withSession: vi.fn().mockReturnThis(),
    },
    PANTRY_PUBLIC_ORIGIN: "https://pantry.example",
  });
}
