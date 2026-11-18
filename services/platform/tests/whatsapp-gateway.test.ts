import { createOrganisationExecutionFixture } from "./organisation-execution-fixture";
import { createMigratedDatabase } from "./sqlite-d1";
import { requireOrganisationId } from "./test-ids";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
/// <reference types="@cloudflare/workers-types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", cloudflareWorkersMock);
vi.mock("../src/data/whatsapp", whatsappDataMockFactory);
vi.mock("../src/actors/actor-router", actorRouterMockFactory);

const gatewayMocks = vi.hoisted(createGatewayMocks);

import gateway from "../src/integration-gateway";
import {
  FIXTURE_APP_SECRET,
  FIXTURE_VERIFY_TOKEN,
  canonicalBody,
  invalidSignature,
  signFixtureBody,
  statusPayload,
  textMessagePayload,
} from "./whatsapp/fixtures";
import {
  platformEnv,
  testExecutionContext,
  type UnitTestEnv,
} from "./worker-fakes";

/**
 * The public Meta callback. Meta is acknowledged only after the Connector has
 * durably admitted the event, so an admission failure has to become a Meta
 * retry rather than a silently dropped customer message.
 */

describe("whatsapp webhook route", whatsappGatewaySuite);

function whatsappGatewaySuite(): void {
  beforeEach(resetGatewayMocks);

  it("answers the subscription challenge with the exact echo", challengeTest);
  it("rejects an unsigned or wrongly signed delivery", signatureTest);
  it("admits a routed text message before acknowledging Meta", admissionTest);
  it("returns an error so Meta retries when admission fails", retryTest);
  it("acknowledges an unroutable event without creating work", unroutableTest);
  it("admits status events through the same durable path", statusTest);
}

function resetGatewayMocks(): void {
  vi.resetAllMocks();
  gatewayMocks.routeWhatsAppWebhookAccount.mockResolvedValue({
    organisationId: "organisation_whatsapp_dev",
    integrationAccountId: "integration_account_whatsapp",
    credentialGeneration: 1,
  });
  gatewayMocks.whatsappConnectorIdValue.mockImplementation(
    (accountId: string) => `connector_whatsapp_${accountId}`,
  );
  gatewayMocks.acceptWhatsAppEvent.mockResolvedValue({
    ok: true,
    value: { kind: "admitted" },
  });
  gatewayMocks.resolveActiveConnectorActorAtPlacement.mockResolvedValue({
    ok: true,
    value: { acceptWhatsAppEvent: gatewayMocks.acceptWhatsAppEvent },
  });
}

async function challengeTest(): Promise<void> {
  const response = await gateway.fetch(
    new Request(
      `https://edge.test/hook/whatsapp?hub.mode=subscribe&hub.verify_token=${FIXTURE_VERIFY_TOKEN}&hub.challenge=98765`,
    ),
    await testEnv(),
    executionContext(),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("98765");

  const wrong = await gateway.fetch(
    new Request(
      "https://edge.test/hook/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=98765",
    ),
    await testEnv(),
    executionContext(),
  );
  expect(wrong.status).toBe(403);
}

async function signatureTest(): Promise<void> {
  const rawBody = canonicalBody(textMessagePayload());
  const unsigned = await gateway.fetch(
    new Request("https://edge.test/hook/whatsapp", {
      method: "POST",
      body: rawBody,
    }),
    await testEnv(),
    executionContext(),
  );
  expect(unsigned.status).toBe(401);

  const wrongSignature = await gateway.fetch(
    new Request("https://edge.test/hook/whatsapp", {
      method: "POST",
      body: rawBody,
      headers: { "x-hub-signature-256": invalidSignature() },
    }),
    await testEnv(),
    executionContext(),
  );
  expect(wrongSignature.status).toBe(401);
  expect(gatewayMocks.acceptWhatsAppEvent).not.toHaveBeenCalled();
}

async function admissionTest(): Promise<void> {
  const rawBody = canonicalBody(
    textMessagePayload({
      providerMessageId: "wamid.GATEWAY1",
      body: "Are you open today?",
    }),
  );
  const response = await gateway.fetch(
    await signedRequest(rawBody),
    await testEnv(),
    executionContext(),
  );
  expect(response.status).toBe(200);
  expect(gatewayMocks.acceptWhatsAppEvent).toHaveBeenCalledTimes(1);
  const call = gatewayMocks.acceptWhatsAppEvent.mock.calls[0]?.[0] as {
    readonly event: { readonly kind: string; readonly body: string };
  };
  expect(call.event).toMatchObject({
    kind: "text_message",
    providerMessageId: "wamid.GATEWAY1",
    body: "Are you open today?",
  });
}

async function retryTest(): Promise<void> {
  gatewayMocks.acceptWhatsAppEvent.mockResolvedValue({
    ok: false,
    error: { code: "connector_whatsapp_runtime_missing" },
  });
  const response = await gateway.fetch(
    await signedRequest(canonicalBody(textMessagePayload())),
    await testEnv(),
    executionContext(),
  );
  expect(response.status).toBe(503);
}

async function unroutableTest(): Promise<void> {
  gatewayMocks.routeWhatsAppWebhookAccount.mockResolvedValue(null);
  const response = await gateway.fetch(
    await signedRequest(canonicalBody(textMessagePayload())),
    await testEnv(),
    executionContext(),
  );
  expect(response.status).toBe(200);
  expect(gatewayMocks.acceptWhatsAppEvent).not.toHaveBeenCalled();
}

async function statusTest(): Promise<void> {
  const response = await gateway.fetch(
    await signedRequest(canonicalBody(statusPayload({ status: "delivered" }))),
    await testEnv(),
    executionContext(),
  );
  expect(response.status).toBe(200);
  const call = gatewayMocks.acceptWhatsAppEvent.mock.calls[0]?.[0] as {
    readonly event: { readonly kind: string; readonly status: string };
  };
  expect(call.event).toMatchObject({ kind: "status", status: "delivered" });
}

async function signedRequest(rawBody: string): Promise<Request> {
  return new Request("https://edge.test/hook/whatsapp", {
    method: "POST",
    body: rawBody,
    headers: {
      "x-hub-signature-256": await signFixtureBody(rawBody),
      "content-type": "application/json",
    },
  });
}

function executionContext(): ExecutionContext {
  return testExecutionContext({
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  });
}

async function testEnv(): Promise<UnitTestEnv> {
  const db = createMigratedDatabase();
  await createOrganisationExecutionFixture(db, requireOrganisationId("organisation_whatsapp_dev"));
  return platformEnv({
    DB: db,
    SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    CONNECTOR: {} as unknown as UnitTestEnv["CONNECTOR"],
    WHATSAPP_APP_SECRET: FIXTURE_APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: FIXTURE_VERIFY_TOKEN,
  });
}

function createGatewayMocks(): {
  readonly routeWhatsAppWebhookAccount: ReturnType<typeof vi.fn>;
  readonly whatsappConnectorIdValue: ReturnType<typeof vi.fn>;
  readonly resolveActiveConnectorActorAtPlacement: ReturnType<typeof vi.fn>;
  readonly acceptWhatsAppEvent: ReturnType<typeof vi.fn>;
} {
  return {
    routeWhatsAppWebhookAccount: vi.fn(),
    whatsappConnectorIdValue: vi.fn(),
    resolveActiveConnectorActorAtPlacement: vi.fn(),
    acceptWhatsAppEvent: vi.fn(),
  };
}

function whatsappDataMockFactory(): Record<string, unknown> {
  return {
    routeWhatsAppWebhookAccount: gatewayMocks.routeWhatsAppWebhookAccount,
    whatsappConnectorIdValue: gatewayMocks.whatsappConnectorIdValue,
  };
}

async function actorRouterMockFactory(): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../src/actors/actor-router",
  );
  return {
    ...actual,
    resolveActiveConnectorActorAtPlacement:
      gatewayMocks.resolveActiveConnectorActorAtPlacement,
  };
}

async function cloudflareWorkersMock(): Promise<Record<string, unknown>> {
  return vi.importActual<Record<string, unknown>>(
    "./cloudflare-workers-module",
  );
}
