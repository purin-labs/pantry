// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

const whatsappRpcMocks = vi.hoisted(createWhatsAppRpcMocks);

vi.mock(
  "@purin-labs/surface-whatsapp/server/actors/connector-whatsapp-rpc",
  connectorWhatsAppRpcMockFactory,
);

import { ConnectorDO } from "../src/actors/connector";
import { parseConnectorId } from "@purin-labs/kernel/ids";
import { activateConnectorFixture } from "./fixtures/connector-activation";
import {
  createWhatsAppWorld,
  whatsappTestEnvBindings,
} from "./whatsapp/environment";
import { platformEnv } from "./worker-fakes";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

describe("Connector WhatsApp alarm admission", connectorWhatsAppAlarmSuite);

function connectorWhatsAppAlarmSuite(): void {
  beforeEach(resetWhatsAppRpcMocks);

  it(
    "returns a retryable error when the admitted event alarm cannot be persisted",
    alarmFailureTest,
  );
}

async function alarmFailureTest(): Promise<void> {
  const fixture = emptySqliteFixture();
  const storage = new AlarmFailureStorage(
    fixture.database,
    sqlStorage(fixture.storage),
  );
  const world = await createWhatsAppWorld();
  const env = platformEnv(whatsappTestEnvBindings(world.db));
  const connectorId = parseConnectorId("connector_whatsapp_alarm_test");
  if (!connectorId.ok) throw new Error(connectorId.error.code);
  const waitUntil = vi.fn();
  const connector = new ConnectorDO(
    { storage, waitUntil } as unknown as DurableObjectState,
    env,
  );

  await activateConnectorFixture(
    connector,
    env,
    world.organisationId,
    connectorId.value,
  );
  const result = await connector.acceptWhatsAppEvent({
    identity: {
      organisationId: world.organisationId,
      connectorId: "connector_whatsapp_alarm_test",
    },
    event: {
      kind: "text_message",
      customerWaId: "61400000000",
      providerMessageId: "wamid.ALARM_FAILURE",
      providerTimestamp: 1_788_133_875_000,
      body: "Please persist the alarm before acknowledging this message.",
    },
    now: 1_788_133_877_271,
  });

  expect(result).toEqual({
    ok: false,
    error: { code: "connector_alarm_failed" },
  });
  expect(storage.deleteAlarm).toHaveBeenCalledOnce();
  expect(waitUntil).not.toHaveBeenCalled();
}

function resetWhatsAppRpcMocks(): void {
  vi.resetAllMocks();
  whatsappRpcMocks.acceptWhatsAppEvent.mockResolvedValue({
    ok: true,
    value: { kind: "duplicate", caseId: "case_whatsapp_alarm_test" },
  });
}

function createWhatsAppRpcMocks(): {
  readonly acceptWhatsAppEvent: ReturnType<typeof vi.fn>;
} {
  return { acceptWhatsAppEvent: vi.fn() };
}

async function connectorWhatsAppRpcMockFactory(
  importOriginal: <T>() => Promise<T>,
): Promise<object> {
  const actual =
    await importOriginal<
      typeof import("@purin-labs/surface-whatsapp/server/actors/connector-whatsapp-rpc")
    >();
  return {
    ...actual,
    acceptWhatsAppEvent: whatsappRpcMocks.acceptWhatsAppEvent,
  };
}

class AlarmFailureStorage {
  readonly deleteAlarm = vi.fn(failAlarmPersistence);

  constructor(
    private readonly database: DatabaseSync,
    readonly sql: SqlStorage,
  ) {}

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

async function failAlarmPersistence(): Promise<void> {
  throw new Error("alarm persistence unavailable");
}
