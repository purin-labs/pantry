import { createMigratedDatabase } from "./sqlite-d1";
import { createOrganisationExecutionFixture } from "./organisation-execution-fixture";
/// <reference types="@cloudflare/workers-types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const counterPolicyMocks = vi.hoisted(() => ({
  authorizeOrganisationRequest: vi.fn(),
  readOrganisationEnvironment: vi.fn(),
  resolveUser: vi.fn(),
  resolveOrganisationCommerceMerchantBinding: vi.fn(),
  readControlMutationReplay: vi.fn(),
  recordCommerceMutationReceipt: vi.fn(),
  publishPointOfSaleConfiguration: vi.fn(),
}));

vi.mock("../src/control/authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control/authorization")>()),
  authorizeOrganisationRequest: counterPolicyMocks.authorizeOrganisationRequest,
}));
vi.mock("../src/control/organisation-runtime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/control/organisation-runtime")
  >()),
  readOrganisationEnvironment: counterPolicyMocks.readOrganisationEnvironment,
}));
vi.mock("@purin-labs/connections/data/commerce-merchant-binding", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@purin-labs/connections/data/commerce-merchant-binding")
  >()),
  resolveOrganisationCommerceMerchantBinding:
    counterPolicyMocks.resolveOrganisationCommerceMerchantBinding,
}));
vi.mock("@purin-labs/tenancy/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/tenancy/data/control-plane")>()),
  resolveUser: counterPolicyMocks.resolveUser,
}));
vi.mock("@purin-labs/tenancy/data/control-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/tenancy/data/control-mutation")>()),
  readControlMutationReplay: counterPolicyMocks.readControlMutationReplay,
}));
vi.mock("../src/control/mutation-receipt", () => ({
  recordCommerceMutationReceipt:
    counterPolicyMocks.recordCommerceMutationReceipt,
}));
vi.mock("../src/commerce/contract/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commerce/contract/client")>()),
  createCommerceClient: vi.fn(() => ({
    publishPointOfSaleConfiguration:
      counterPolicyMocks.publishPointOfSaleConfiguration,
  })),
}));

import { handleControlRequest } from "../src/control-router";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const ORGANISATION_ID = "organisation_counter_policy";
const ROUTE = `https://pantry.example/v1/control/organisations/${ORGANISATION_ID}/commerce/counter-policies`;
const MERCHANT_ID = "merchant_counter_policy";

function policy(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    configurationId: "pos_configuration_counter",
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    pantryLocationId: "location_cafe",
    salesChannelId: "channel_cafe",
    currency: "JPY",
    supportedItems: [{ variantId: "variant_cookie", maxQuantityPerLine: 5 }],
    quoteTtlSeconds: 900,
    tax: { kind: "percentage", basisPoints: 1_000 },
    pickupReadyLeadTimeSeconds: 0,
    afterSalePolicy: {
      cancellationPolicyId: "cancellation_counter",
      refundPolicyId: "refund_counter",
      refundGovernance: { kind: "approval_required" },
    },
    presentationPolicy: {
      locale: "ja-JP",
      merchantDisplayName: "Pantry Cafe",
      termsPolicyId: "terms_counter",
      privacyPolicyId: "privacy_counter",
      supportContact: "support@example.test",
    },
    revision: 1,
    lifecycle: {
      state: "published",
      publishedAt: "2026-09-05T00:00:00.000Z",
      publishedBy: "op",
    },
    ...overrides,
  };
}

function publicationRequest(body: Record<string, unknown>): Request {
  return new Request(ROUTE, {
    method: "POST",
    headers: {
      origin: "https://pantry.example",
      cookie:
        "pantry_session=session-counter; pantry_csrf=csrf-counter",
      "x-pantry-csrf": "csrf-counter",
      "idempotency-key": "counter-policy-test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function env(): UnitTestEnv {
  return platformEnv({ PANTRY_PUBLIC_ORIGIN: "https://pantry.example" });
}

describe("counter policy control routes", function counterPolicySuite() {
  beforeEach(async function configure() {
    vi.clearAllMocks();
    const organisationId = parseOrganisationId(ORGANISATION_ID);
    if (!organisationId.ok)
      throw new Error("Counter policy organisation fixture is invalid");
    counterPolicyMocks.authorizeOrganisationRequest.mockResolvedValue({
      ok: true,
      executionScope: await createOrganisationExecutionFixture(
        createMigratedDatabase(),
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
    counterPolicyMocks.readOrganisationEnvironment.mockResolvedValue(
      "development",
    );
    counterPolicyMocks.resolveUser.mockResolvedValue({
      userId: "user_7585a72f-b277-50a2-8525-d876e77d83f8",
      issuer: "https://accounts.google.com",
      subject: "counter-policy-subject",
      email: "owner@example.test",
      displayName: "Counter Owner",
      emailVerified: true,
      createdAt: Date.now() - 60_000,
      lastAuthenticatedAt: Date.now() - 60_000,
    });
    counterPolicyMocks.resolveOrganisationCommerceMerchantBinding.mockResolvedValue(
      {
        ok: true,
        value: { merchantId: MERCHANT_ID },
      },
    );
    counterPolicyMocks.readControlMutationReplay.mockResolvedValue({
      kind: "absent",
    });
    counterPolicyMocks.recordCommerceMutationReceipt.mockResolvedValue({
      ok: true,
      value: null,
    });
    counterPolicyMocks.publishPointOfSaleConfiguration.mockResolvedValue({
      ok: true,
      value: policy(),
    });
  });

  it("publishes under the organisation and merchant of the session, not the body", async function scoped() {
    const response = await handleControlRequest(
      publicationRequest({
        expectedRevision: null,
        configuration: policy({
          // A body claiming another organisation's identity must not reach Commerce
          // with that claim intact.
          organisationId: "organisation_someone_else",
          merchantId: "merchant_someone_else",
        }),
      }),
      env(),
    );
    expect(response.status).toBe(200);
    const [command] =
      counterPolicyMocks.publishPointOfSaleConfiguration.mock.calls[0] ?? [];
    expect(command.merchantId).toBe(MERCHANT_ID);
    expect(command.configuration.organisationId).toBe(ORGANISATION_ID);
    expect(command.configuration.merchantId).toBe(MERCHANT_ID);
    expect(command.publishedBy).toBe(
      "user_7585a72f-b277-50a2-8525-d876e77d83f8",
    );
    expect(
      counterPolicyMocks.recordCommerceMutationReceipt,
    ).toHaveBeenCalledTimes(1);
  });

  it("refuses a revision that is not one Commerce could have issued", async function badRevision() {
    const response = await handleControlRequest(
      publicationRequest({ expectedRevision: 0, configuration: policy() }),
      env(),
    );
    expect(response.status).toBe(422);
    expect(
      counterPolicyMocks.publishPointOfSaleConfiguration,
    ).not.toHaveBeenCalled();
  });
});
