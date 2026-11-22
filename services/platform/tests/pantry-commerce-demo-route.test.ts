// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import { COMMERCE_API_SCOPES } from "@purin-labs/commerce-client";
import {
  TEST_ACTIVE_ORGANISATION_PLACEMENT_ROW,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
/// <reference types="@cloudflare/workers-types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const controlMocks = vi.hoisted(() => ({
  authorizeOrganisationControl: vi.fn(),
  resolveUser: vi.fn(),
  resolveControlSession: vi.fn(),
  validateControlCsrf: vi.fn(),
}));
const actorMocks = vi.hoisted(() => ({
  requireActiveOrganisationActor: vi.fn(),
}));
const mutationMocks = vi.hoisted(() => ({
  prepareControlMutationReceipt: vi.fn(),
  readControlMutationReplay: vi.fn(),
}));
const bindingMocks = vi.hoisted(() => ({
  resolveOrganisationCommerceMerchantBinding: vi.fn(),
}));
const commerceSystemMocks = vi.hoisted(() => ({
  resolveOrganisationCommerceSystem: vi.fn(),
  selectOrganisationCommerceSystem: vi.fn(),
}));
const integrationAccountMocks = vi.hoisted(() => ({
  listIntegrationAccounts: vi.fn(),
}));

vi.mock("@purin-labs/tenancy/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/tenancy/data/control-plane")>()),
  authorizeOrganisationControl: controlMocks.authorizeOrganisationControl,
  resolveUser: controlMocks.resolveUser,
  resolveControlSession: controlMocks.resolveControlSession,
  validateControlCsrf: controlMocks.validateControlCsrf,
}));
vi.mock("@purin-labs/actor-runtime/actors/actor-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/actor-runtime/actors/actor-router")>()),
  requireActiveOrganisationActorAtPlacement: actorMocks.requireActiveOrganisationActor,
  requireActiveOrganisationActor: actorMocks.requireActiveOrganisationActor,
}));
vi.mock("@purin-labs/tenancy/data/control-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/tenancy/data/control-mutation")>()),
  prepareControlMutationReceipt: mutationMocks.prepareControlMutationReceipt,
  readControlMutationReplay: mutationMocks.readControlMutationReplay,
}));
vi.mock("@purin-labs/connections/data/commerce-merchant-binding", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@purin-labs/connections/data/commerce-merchant-binding")
  >()),
  resolveOrganisationCommerceMerchantBinding:
    bindingMocks.resolveOrganisationCommerceMerchantBinding,
}));
vi.mock("@purin-labs/connections/data/organisation-commerce-system", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@purin-labs/connections/data/organisation-commerce-system")
  >()),
  resolveOrganisationCommerceSystem: commerceSystemMocks.resolveOrganisationCommerceSystem,
  selectOrganisationCommerceSystem: commerceSystemMocks.selectOrganisationCommerceSystem,
}));
vi.mock("@purin-labs/connections/data/integration-account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/connections/data/integration-account")>()),
  listIntegrationAccounts: integrationAccountMocks.listIntegrationAccounts,
}));

vi.mock("../src/control/organisation-runtime", mockOrganisationRuntime);

async function mockOrganisationRuntime(
  importOriginal: () => Promise<typeof import("../src/control/organisation-runtime")>,
) {
  return {
    ...(await importOriginal()),
    ensureCreatedOrganisationActor: vi.fn(),
  };
}

import { handleControlRequest } from "../src/control-router";
import { parseIntegrationAccountId, parseOrganisationId } from "@purin-labs/kernel/ids";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const ORGANISATION_ID = "organisation_demo_profiles";
const INTEGRATION_ACCOUNT_ID = "integration_commerce_demo_profiles";
const MERCHANT_ID = "merchant_pantry_demo_profiles";

describe("Purin Checkout demo profile route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareAuthorizedControlMocks();
  });

  it("selects an explicit profile and rejects a different profile", async () => {
    const commerceFetch = vi.fn(commerceDemoFetch);
    const env = demoRouteEnv(commerceFetch);

    const invalid = await handleControlRequest(
      demoRequest("invalid-profile", "invalid-demo-profile"),
      env,
    );
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toEqual({
      ok: false,
      error: "builtin_commerce_setup_invalid",
    });
    expect(commerceFetch).not.toHaveBeenCalled();

    mutationMocks.readControlMutationReplay.mockResolvedValueOnce({
      kind: "absent",
    });
    const accepted = await handleControlRequest(
      demoRequest("pantry_ecommerce", "pantry-ecommerce-demo"),
      env,
    );
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      ok: true,
      profile: "pantry_ecommerce",
      commerceSystem: { kind: "builtin_commerce", merchantId: MERCHANT_ID },
      sync: "queued",
    });
    expect(await commerceCommand(commerceFetch, 0)).toMatchObject({
      externalReference: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      profile: "pantry_ecommerce",
    });
    // Pantry installs itself on the new merchant for its organisation.
    expect(await commerceCommand(commerceFetch, 1)).toMatchObject({
      scopes: [...COMMERCE_API_SCOPES],
      externalReference: ORGANISATION_ID,
    });
    // No payment authority goes to Commerce: it runs the payments itself.
    expect(commerceFetch).toHaveBeenCalledTimes(2);

    mutationMocks.readControlMutationReplay.mockResolvedValueOnce({
      kind: "absent",
    });
    const conflict = await handleControlRequest(
      demoRequest("cafe_patisserie", "cafe-patisserie-demo"),
      env,
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      ok: false,
      error: "commerce_demo_profile_conflict",
    });
  });
});

function prepareAuthorizedControlMocks(): void {
  const organisationId = parseOrganisationId(ORGANISATION_ID);
  const integrationAccountId = parseIntegrationAccountId(
    INTEGRATION_ACCOUNT_ID,
  );
  if (!organisationId.ok || !integrationAccountId.ok)
    throw new Error("demo fixture IDs are invalid");
  controlMocks.resolveControlSession.mockResolvedValue({
    ok: true,
    value: {
      kind: "active",
      controlSessionId: "control_session_demo_profiles",
      userId: "user_669215b1-1993-52f5-8e1a-413b0b9a67c3",
      rotationGeneration: 1,
      createdAt: 1,
      rotatedAt: 1,
      expiresAt: Date.now() + 60_000,
    },
  });
  controlMocks.validateControlCsrf.mockResolvedValue({ ok: true, value: true });
  controlMocks.authorizeOrganisationControl.mockResolvedValue({
    ok: true,
    value: {
      membership: {
        kind: "active",
        organisationId: organisationId.value,
        userId: "user_669215b1-1993-52f5-8e1a-413b0b9a67c3",
        personId: "person_demo_profiles",
        role: "owner",
        createdAt: 1,
      },
    },
  });
  controlMocks.resolveUser.mockResolvedValue({
    userId: "user_669215b1-1993-52f5-8e1a-413b0b9a67c3",
    issuer: "https://accounts.google.com",
    subject: "demo-profiles",
    email: "demo@example.com",
    displayName: "Demo Owner",
    emailVerified: true,
    createdAt: 1,
    lastAuthenticatedAt: 1,
  });
  actorMocks.requireActiveOrganisationActor.mockResolvedValue({
    ensureOrganisation: vi.fn(),
  });
  bindingMocks.resolveOrganisationCommerceMerchantBinding.mockResolvedValue({
    ok: true,
    value: {
      bindingId: "commerce_binding_demo_profiles",
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      merchantId: MERCHANT_ID,
      environment: "development",
    },
  });
  commerceSystemMocks.resolveOrganisationCommerceSystem
    .mockResolvedValueOnce({
      ok: false,
      error: { code: "commerce_system_not_found" },
    })
    .mockResolvedValue({
      ok: true,
      value: {
        kind: "builtin_commerce",
        organisationId: organisationId.value,
        bindingId: "commerce_binding_demo_profiles",
        merchantId: MERCHANT_ID,
        revision: 1,
      },
    });
  commerceSystemMocks.selectOrganisationCommerceSystem.mockResolvedValue({
    ok: true,
    value: {
      kind: "selected",
      commerceSystem: {
        kind: "builtin_commerce",
        organisationId: organisationId.value,
        bindingId: "commerce_binding_demo_profiles",
        merchantId: MERCHANT_ID,
        revision: 1,
      },
    },
  });
  mutationMocks.prepareControlMutationReceipt.mockReturnValue({
    kind: "receipt_statement",
  });
  integrationAccountMocks.listIntegrationAccounts.mockResolvedValue([
    {
      integrationAccountId: "integration_stripe_demo_profiles",
      organisationId: organisationId.value,
      providerConnectionId: "connection_stripe_demo_profiles",
      provider: "stripe",
      environment: "development",
      providerAccountId: "acct_demo_profiles",
      accountKind: "merchant_account",
      displayName: "Demo Stripe",
      lifecycle: { kind: "active" },
      isDefaultForProvider: true,
      capabilities: ["payments.read"],
      audiencePolicy: { kind: "operator" },
      retentionPolicy: { kind: "organisation_default" },
      createdAt: 1,
      updatedAt: 1,
    },
  ]);
}

function demoRequest(profile: string, idempotencyKey: string): Request {
  return new Request(
    `https://pantry.example/v1/control/organisations/${ORGANISATION_ID}/commerce-system/builtin-commerce/demo`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://pantry.example",
        cookie:
          "pantry_session=session-demo; pantry_csrf=csrf-demo",
        "x-pantry-csrf": "csrf-demo",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ profile }),
    },
  );
}

function demoRouteEnv(
  commerceFetch: typeof commerceDemoFetch,
): UnitTestEnv {
  const first = vi.fn(async () => ({
    ...TEST_ACTIVE_ORGANISATION_PLACEMENT_ROW,
    name: "Demo workspace",
    createdAt: 1,
    environment: "development",
  }));
  const all = vi.fn(async () => ({ results: [] }));
  const bind = vi.fn(() => ({ first, all }));
  const batch = vi.fn(async () => [{ meta: { changes: 1 } }]);
  return platformEnv({
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    DB: {
      prepare: vi.fn(() => ({ bind })),
      withSession: vi.fn(() => ({ batch, prepare: vi.fn(() => ({ bind })) })),
    },
    EVENT_Q: { send: vi.fn(async () => undefined) },
    COMMERCE: { fetch: commerceFetch },
    COMMERCE_BASE_URL: "https://commerce.example",
    COMMERCE_SERVICE_TOKEN: "commerce-service-token",
    DATA_ENCRYPTION_ROOT: {
      get: vi.fn(async () => Buffer.alloc(32, 17).toString("base64")),
    },
    PANTRY_PUBLIC_ORIGIN: "https://pantry.example",
  });
}

async function commerceDemoFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const command = (await request.json()) as {
    readonly profile?: unknown;
    readonly organisationId?: unknown;
    readonly merchantId?: unknown;
    readonly authority?: Readonly<{ readonly kind?: unknown }>;
  };
  if (new URL(request.url).pathname.endsWith("/app-installations/pantry")) {
    return Response.json({
      credentialId: "installation_demo_profiles",
      appId: "pantry",
      scopes: COMMERCE_API_SCOPES,
      token: "uca_installation_demo_profiles",
    });
  }
  if (command.profile === "cafe_patisserie") {
    return Response.json(
      { message: "Demo merchant already contains a different profile" },
      { status: 409 },
    );
  }
  return Response.json({
    schemaVersion: "commerce.commerce-snapshot.v2",
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    merchantRevision: 1,
    deliverySigner: {
      keyId: "key_demo_profiles",
      algorithm: "ed25519",
      publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
    resources: {
      locations: [],
      salesChannels: [],
      products: [],
      variants: [],
      inventoryItems: [],
      offers: [],
      inventoryPositions: [],
      orders: [],
      payments: [],
      fulfillments: [],
      shipments: [],
    },
  });
}

async function commerceCommand(
  fetchMock: ReturnType<typeof vi.fn>,
  index: number,
): Promise<unknown> {
  const call = fetchMock.mock.calls[index];
  if (call === undefined)
    throw new Error("Commerce request was not recorded");
  const request =
    call[0] instanceof Request
      ? call[0]
      : new Request(
          call[0] as RequestInfo | URL,
          call[1] as RequestInit | undefined,
        );
  return request.clone().json();
}
