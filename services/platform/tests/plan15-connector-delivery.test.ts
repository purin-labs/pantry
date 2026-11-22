/// <reference types="@cloudflare/workers-types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@purin-labs/tenancy/data/organisation", organisationModuleMock);
vi.mock("../src/credential-vault", credentialVaultMock);
vi.mock("../src/slack/installation-store", slackRoutingMock);

import { ConnectorDO } from "../src/actors/connector";
import { activateConnectorFixture } from "./fixtures/connector-activation";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { createMigratedDatabase } from "./sqlite-d1";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { requireConnectorId, requireOrganisationId } from "./test-ids";
import { platformEnv } from "./worker-fakes";

const SLACK_RESPONSES: Response[] = [];
const SLACK_REQUESTS: RequestInit[] = [];
const CREDENTIAL_RESULTS: object[] = [];
const LIVE_FETCH = globalThis.fetch;

describe("Plan 15 Connector Slack delivery", connectorDeliverySuite);

function connectorDeliverySuite(): void {
  beforeEach(resetSlack);
  it(
    "deduplicates record messages and rejects changed or foreign record locators",
    acceptsRecordMessage,
  );
  it(
    "retries once and delivers from the immutable address snapshot",
    retriesThenDeliversSnapshot,
  );
  it(
    "retries malformed Slack responses as unavailable",
    retriesMalformedSlackResponse,
  );
  it(
    "retries HTTP 500 before trusting a successful-looking Slack body",
    retriesSlackHttp500,
  );
  it("rejects a valid Slack auth error on HTTP 400", rejectsSlackAuthError);
  it(
    "does not retry a retryable-looking Slack error on HTTP 400",
    rejectsSlackHttp400InternalError,
  );
  it(
    "retries a successful-looking response without a timestamp",
    retriesMissingSlackTimestamp,
  );
  it(
    "delivers a channel address without a Slack thread timestamp",
    deliversChannelSnapshot,
  );
  it.skipIf(process.env.PANTRY_CAFE_LIVE_SLACK !== "1")(
    "delivers one live Café receipt after an injected Vault outage",
    deliversLiveCafeReceiptAfterVaultOutage,
  );
}

async function acceptsRecordMessage(): Promise<void> {
  const actor = await connectorActor();
  const request = {
    identity: {
      organisationId: "organisation_plan15",
      connectorId: "connector_plan15",
    },
    ingress: {
      ingressId: "ingress_record",
      connectorId: "connector_plan15",
      nativeEventId: "event_record",
      nativeCursor: "1",
      caseId: "case_record",
      receivedAt: 1000,
      content: {
        kind: "record_message",
        message: {
          firstPart: { kind: "text", text: "What is its status?" },
          remainingParts: [],
        },
        provenance: {
          organisationId: "organisation_plan15",
          integrationAccountId: "integration_lab",
          source: "lab",
          resourceType: "commerce_order",
          resourceId: "order_1",
          revision: 1,
          occurredAt: "2026-08-04T00:00:00.000Z",
          observedAt: "2026-08-04T00:00:00.000Z",
        },
      },
    },
    attachments: [],
  };
  expect(await actor.acceptIngress(request)).toMatchObject({
    ok: true,
    value: { kind: "accepted" },
  });
  expect(await actor.acceptIngress(request)).toMatchObject({
    ok: true,
    value: { kind: "duplicate" },
  });
  request.ingress.content.provenance.revision = 2;
  expect(await actor.acceptIngress(request)).toMatchObject({
    ok: false,
    error: { code: "connector_ingress_conflict" },
  });
  request.ingress.content.provenance.organisationId = "organisation_foreign";
  expect(await actor.acceptIngress(request)).toMatchObject({
    ok: false,
    error: { code: "connector_ingress_invalid" },
  });
}

async function retriesThenDeliversSnapshot(): Promise<void> {
  SLACK_RESPONSES.push(
    new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
      status: 429,
      headers: { "retry-after": "1" },
    }),
    new Response(JSON.stringify({ ok: true, ts: "1785700000.000777" }), {
      status: 200,
    }),
  );
  const actor = await connectorActor();
  const request = deliveryRequest(1_000);
  const first = await actor.deliver(request);
  expect(first).toEqual({
    ok: true,
    value: { kind: "retry", reason: "slack_http_429", retryAt: 2_000 },
  });
  const second = await actor.deliver(deliveryRequest(2_000));
  expect(second).toMatchObject({
    ok: true,
    value: {
      kind: "delivered",
      receipt: {
        nativeReceiptId: "1785700000.000777",
      },
    },
  });
  const replay = await actor.deliver(deliveryRequest(2_001));
  expect(replay).toMatchObject({
    ok: true,
    value: {
      kind: "already_delivered",
      receipt: {
        nativeReceiptId: "1785700000.000777",
      },
    },
  });
  expect(SLACK_REQUESTS).toHaveLength(2);
  expect(JSON.parse(String(SLACK_REQUESTS[1]?.body))).toMatchObject({
    channel: "C_plan15",
    thread_ts: "1785700000.000001",
    markdown_text: "Catalog is ready.",
  });
  const snapshot = await actor.inspect();
  expect(snapshot).toMatchObject({
    ok: true,
    value: {
      deliveries: [
        {
          address: {
            kind: "slack",
            workspaceId: "T_plan15",
            channelId: "C_plan15",
            threadTs: "1785700000.000001",
          },
        },
      ],
      receipts: [{ nativeReceiptId: "1785700000.000777" }],
    },
  });
}

async function retriesMalformedSlackResponse(): Promise<void> {
  SLACK_RESPONSES.push(new Response("{", { status: 200 }));
  const actor = await connectorActor();

  expect(await actor.deliver(deliveryRequest(1_000))).toEqual({
    ok: true,
    value: {
      kind: "retry",
      reason: "slack_delivery_unavailable",
      retryAt: 6_000,
    },
  });
  expect(SLACK_REQUESTS).toHaveLength(1);
}

async function retriesSlackHttp500(): Promise<void> {
  SLACK_RESPONSES.push(
    new Response(JSON.stringify({ ok: true, ts: "1785700000.000780" }), {
      status: 500,
    }),
  );
  const actor = await connectorActor();

  expect(await actor.deliver(deliveryRequest(1_000))).toEqual({
    ok: true,
    value: { kind: "retry", reason: "slack_http_500", retryAt: 6_000 },
  });
  expect(SLACK_REQUESTS).toHaveLength(1);
}

async function rejectsSlackAuthError(): Promise<void> {
  SLACK_RESPONSES.push(
    new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
      status: 400,
    }),
  );
  const actor = await connectorActor();

  expect(await actor.deliver(deliveryRequest(1_000))).toEqual({
    ok: true,
    value: { kind: "rejected", reason: "invalid_auth" },
  });
  expect(SLACK_REQUESTS).toHaveLength(1);
}

async function rejectsSlackHttp400InternalError(): Promise<void> {
  SLACK_RESPONSES.push(
    new Response(JSON.stringify({ ok: false, error: "internal_error" }), {
      status: 400,
    }),
  );
  const actor = await connectorActor();

  expect(await actor.deliver(deliveryRequest(1_000))).toEqual({
    ok: true,
    value: { kind: "rejected", reason: "internal_error" },
  });
  expect(SLACK_REQUESTS).toHaveLength(1);
}

async function retriesMissingSlackTimestamp(): Promise<void> {
  SLACK_RESPONSES.push(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const actor = await connectorActor();

  expect(await actor.deliver(deliveryRequest(1_000))).toEqual({
    ok: true,
    value: {
      kind: "retry",
      reason: "slack_delivery_unavailable",
      retryAt: 6_000,
    },
  });
  expect(SLACK_REQUESTS).toHaveLength(1);
}

async function deliversChannelSnapshot(): Promise<void> {
  SLACK_RESPONSES.push(
    new Response(JSON.stringify({ ok: true, ts: "1785700000.000778" }), {
      status: 200,
    }),
  );
  const actor = await connectorActor();
  const delivered = await actor.deliver(channelDeliveryRequest());
  expect(delivered).toMatchObject({
    ok: true,
    value: {
      kind: "delivered",
      receipt: { nativeReceiptId: "1785700000.000778" },
    },
  });
  const body = JSON.parse(String(SLACK_REQUESTS[0]?.body));
  expect(body).toMatchObject({
    channel: "C_plan15",
    markdown_text: "Inventory is low.",
  });
  expect(body).not.toHaveProperty("thread_ts");
  expect(await actor.inspect()).toMatchObject({
    ok: true,
    value: {
      deliveries: [
        {
          address: {
            kind: "slack_channel",
            workspaceId: "T_plan15",
            channelId: "C_plan15",
          },
        },
      ],
    },
  });
  expect(await actor.deliver(invalidChannelDeliveryRequest())).toEqual({
    ok: false,
    error: { code: "connector_delivery_invalid" },
  });
}

async function deliversLiveCafeReceiptAfterVaultOutage(): Promise<void> {
  const config = liveSlackConfig();
  const identity = crypto.randomUUID().replaceAll("-", "");
  const requestedAt = Date.now();
  CREDENTIAL_RESULTS.push(
    { ok: false, error: { code: "vault_root_unavailable" } },
    { ok: true, value: { kind: "bearer", value: config.botToken } },
  );
  vi.stubGlobal("fetch", liveSlackFetch);
  const actor = await connectorActor(
    requireOrganisationId(`organisation_${config.workspaceId}`),
    requireConnectorId(`connector_cafe_acceptance_${identity}`),
  );
  const first = await actor.deliver(
    liveCafeReceiptRequest(config, identity, requestedAt),
  );
  expect(first).toEqual({
    ok: true,
    value: {
      kind: "retry",
      reason: "connector_credential_unavailable",
      retryAt: requestedAt + 5_000,
    },
  });
  const second = await actor.deliver(
    liveCafeReceiptRequest(config, identity, requestedAt + 5_000),
  );
  expect(second).toMatchObject({
    ok: true,
    value: {
      kind: "delivered",
      receipt: {
        nativeReceiptId: expect.stringMatching(/^\d+\.\d+$/u),
      },
    },
  });
  const replay = await actor.deliver(
    liveCafeReceiptRequest(config, identity, requestedAt + 5_001),
  );
  expect(replay).toMatchObject({
    ok: true,
    value: {
      kind: "already_delivered",
      receipt: {
        nativeReceiptId:
          second.ok && second.value.kind === "delivered"
            ? second.value.receipt.nativeReceiptId
            : "receipt_missing",
      },
    },
  });
  expect(SLACK_REQUESTS).toHaveLength(1);
}

function deliveryRequest(requestedAt: number): unknown {
  return {
    identity: {
      organisationId: "organisation_plan15",
      connectorId: "connector_plan15",
    },
    delivery: {
      deliveryId: "delivery_plan15",
      bindingId: "binding_plan15",
      address: {
        kind: "slack",
        workspaceId: "T_plan15",
        channelId: "C_plan15",
        threadTs: "1785700000.000001",
      },
      caseId: "case_plan15",
      caseRevision: 2,
      content: { kind: "text", text: "Catalog is ready." },
      idempotencyKey: "case_output_plan15",
      addressedAt: 1_000,
    },
    requestedAt,
  };
}

function liveCafeReceiptRequest(
  config: LiveSlackConfig,
  identity: string,
  requestedAt: number,
): unknown {
  return {
    identity: {
      organisationId: `organisation_${config.workspaceId}`,
      connectorId: `connector_cafe_acceptance_${identity}`,
    },
    delivery: {
      deliveryId: `delivery_cafe_acceptance_${identity}`,
      bindingId: `binding_cafe_acceptance_${identity}`,
      address: {
        kind: "slack_channel",
        workspaceId: config.workspaceId,
        channelId: config.channelId,
      },
      caseId: `case_cafe_acceptance_${identity}`,
      caseRevision: 1,
      content: {
        kind: "text",
        text: `Café acceptance receipt ${identity}: payment captured for order order_${identity}; fulfillment fulfillment_${identity} created; Vault retry recovered.`,
      },
      idempotencyKey: `case_output_cafe_acceptance_${identity}`,
      addressedAt: 1_000,
    },
    requestedAt,
  };
}

function channelDeliveryRequest(): unknown {
  return {
    identity: {
      organisationId: "organisation_plan15",
      connectorId: "connector_plan15",
    },
    delivery: {
      deliveryId: "delivery_plan15_channel",
      bindingId: "binding_plan15_channel",
      address: {
        kind: "slack_channel",
        workspaceId: "T_plan15",
        channelId: "C_plan15",
      },
      caseId: "case_plan15_channel",
      caseRevision: 2,
      content: { kind: "text", text: "Inventory is low." },
      idempotencyKey: "case_output_plan15_channel",
      addressedAt: 1_000,
    },
    requestedAt: 1_000,
  };
}

function invalidChannelDeliveryRequest(): unknown {
  return {
    identity: {
      organisationId: "organisation_plan15",
      connectorId: "connector_plan15",
    },
    delivery: {
      deliveryId: "delivery_plan15_channel_invalid",
      bindingId: "binding_plan15_channel_invalid",
      address: {
        kind: "slack_channel",
        workspaceId: "T_plan15",
        channelId: "C_plan15",
        threadTs: "1785700000.000001",
      },
      caseId: "case_plan15_channel",
      caseRevision: 2,
      content: { kind: "text", text: "Inventory is low." },
      idempotencyKey: "case_output_plan15_channel_invalid",
      addressedAt: 1_000,
    },
    requestedAt: 1_000,
  };
}

async function connectorActor(
  organisationId = requireOrganisationId("organisation_plan15"),
  connectorId = requireConnectorId("connector_plan15"),
): Promise<ConnectorDO> {
  const fixture = emptySqliteFixture();
  const storage = new TestStorage(
    fixture.database,
    sqlStorage(fixture.storage),
  );
  const state = { storage } as unknown as DurableObjectState;
  const db = createMigratedDatabase();
  await db.batch([
    db
      .prepare(
        "INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES (?, 'Plan 15', 'beta', 1, 'active')",
      )
      .bind(organisationId),
    db
      .prepare(
        `INSERT INTO organisation_placement (
      organisation_id, placement_epoch, placement_kind, placement_cell_id,
      location_hint, residency_jurisdiction, status, fence_token, created_at, activated_at
    ) VALUES (?, 1, 'affinity', ?, ?, NULL, 'active', 'tpf_plan15', 1, 1)`,
      )
      .bind(
        organisationId,
        TEST_INITIAL_ORGANISATION_PLACEMENT.placementCellId,
        TEST_INITIAL_ORGANISATION_PLACEMENT.locationHint,
      ),
  ]);
  const env = platformEnv({
    DB: db,
    SLACK_APP_ID: "A_PLAN15",
    PANTRY_DEPLOYMENT_PROFILE: "local",
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
  const actor = new ConnectorDO(state, env);
  await activateConnectorFixture(actor, env, organisationId, connectorId);
  return actor;
}

function resetSlack(): void {
  SLACK_RESPONSES.length = 0;
  SLACK_REQUESTS.length = 0;
  CREDENTIAL_RESULTS.length = 0;
  vi.stubGlobal("fetch", slackFetch);
}

async function slackFetch(
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  SLACK_REQUESTS.push(init ?? {});
  const response = SLACK_RESPONSES.shift();
  if (response === undefined) throw new Error("unexpected Slack request");
  return response;
}

async function liveSlackFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  SLACK_REQUESTS.push(init ?? {});
  return LIVE_FETCH(input, init);
}

type LiveSlackConfig = Readonly<{
  botToken: string;
  workspaceId: string;
  channelId: string;
}>;

function liveSlackConfig(): LiveSlackConfig {
  return {
    botToken: requireLiveSlackEnvironment("SLACK_BOT_TOKEN", "xoxb-"),
    workspaceId: requireLiveSlackEnvironment("SLACK_TEAM_ID", "T"),
    channelId: requireLiveSlackEnvironment("PANTRY_SLACK_CHANNEL_ID", "C"),
  };
}

function requireLiveSlackEnvironment(name: string, prefix: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value.startsWith(prefix) || value.length <= prefix.length) {
    throw new Error(`PANTRY_CAFE_LIVE_SLACK=1 requires ${name}`);
  }
  return value;
}

function organisationModuleMock(): object {
  return { resolveInstallOrganisation: resolveInstallOrganisationMock };
}

async function resolveInstallOrganisationMock(): Promise<object> {
  return {
    ok: true,
    value: {
      integrationAccountId: "integration_plan15",
      organisationId: "organisation_plan15",
      name: "Plan 15",
      plan: "beta",
      organisationStatus: "active",
      surfaceKind: "slack",
      workspaceId: "T_plan15",
      installModel: "organisation_app",
      botTokenRef: "vault:slack:plan15",
      scopes: ["chat:write"],
      installedAt: 1,
      installStatus: "active",
      lastEventReceivedAt: 1,
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    },
  };
}

function credentialVaultMock(): object {
  return {
    resolveActiveSlackOrganisationCredential: resolveCredentialMock,
    resolveActiveSlackThreadCredential: resolveCredentialMock,
    readSlackThreadCredentialRoute: readCredentialRouteMock,
    resolveRoutedSlackThreadCredential: resolveCredentialMock,
    slackThreadCredentialIsAtScope: credentialIsAtScopeMock,
  };
}

async function readCredentialRouteMock(): Promise<object> {
  return {
    ok: true,
    value: {
      credentialOrganisationId: "organisation_plan15",
      botTokenRef: "vault:slack:plan15",
      integrationAccountId: "integration_plan15",
    },
  };
}

function credentialIsAtScopeMock(): boolean {
  return true;
}

function slackRoutingMock(): object {
  return {
    resolveActiveSlackDestinationConnection:
      async function resolveActiveSlackDestinationConnectionMock() {
        return {
          ok: true,
          value: {
            installationId: "slack_installation_plan15",
            connectionId: "slack_connection_plan15",
            integrationAccountId: "integration_plan15",
          },
        };
      },
  };
}

async function resolveCredentialMock(): Promise<object> {
  return (
    CREDENTIAL_RESULTS.shift() ?? {
      ok: true,
      value: { kind: "bearer", value: "xoxb-plan15" },
    }
  );
}

class TestStorage {
  constructor(
    private readonly database: ReturnType<
      typeof emptySqliteFixture
    >["database"],
    readonly sql: SqlStorage,
  ) {}
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
  transactionSync<Value>(callback: () => Value): Value {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
