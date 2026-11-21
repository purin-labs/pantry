import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import {
  parseDeviceList,
  parseDeviceGatewayStart,
  type DeviceList,
  type DeviceView,
  type FoundDevice,
  type GatewayMessage,
  type KitchenDeviceView,
  type PlatformGatewayMessage,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import type { IssuedControlSession } from "../../src/data/control-plane";
import {
  commerceClient,
  commerceHeaders,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import {
  PUBLIC_ORIGIN,
  controlReadHeaders,
} from "./hibernatable-socket-support";
import { fixtureDatabase } from "./organisation-database";
import { activateOrganisation } from "./organisation-fixture";

/**
 * A simulated shop gateway for Plan 85's journeys. It speaks the real protocol
 * over the real socket route, and it only reports and answers. Product code
 * produces every outcome that a journey asserts.
 */

/**
 * A shop for a device journey: an owner, an operator (`staff`) and a viewer,
 * with a commerce fixture and the account platform's members.
 */
export async function deviceShop(label: string) {
  const owner = await commerceClient(`${label}-owner-${crypto.randomUUID()}`);
  const staff = await commerceClient(`${label}-staff-${crypto.randomUUID()}`);
  const viewer = await commerceClient(`${label}-viewer-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, `${label} café`);
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  await fixtureDatabase().batch(
    [
      { user: staff, role: "operator", person: `person_${label}_staff` },
      { user: viewer, role: "viewer", person: `person_${label}_viewer` },
    ].flatMap(({ user, role, person }) => [
      fixtureDatabase()
        .prepare(
          "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
        )
        .bind(organisationId, person, role),
      fixtureDatabase()
        .prepare(
          "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, ?, 'active', ?, NULL)",
        )
        .bind(organisationId, user.identity.userId, person, role, Date.now()),
    ]),
  );
  await activateOrganisation(organisationId);
  return { owner, staff, viewer, organisationId, merchantId };
}

export function controlBase(organisationId: string): string {
  return `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}`;
}

export async function send(
  url: string,
  session: IssuedControlSession,
  method: "GET" | "POST" | "PUT",
  body?: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<Readonly<{ status: number; body: unknown }>> {
  const headers =
    method === "GET"
      ? new Headers(controlReadHeaders(session))
      : commerceHeaders(session);
  if (method !== "GET") {
    headers.set("idempotency-key", idempotencyKey);
    headers.set("x-satyr-configuration-version", "1");
  }
  const response = await exports.default.fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

export async function readDeviceList(
  organisationId: string,
  session: IssuedControlSession,
): Promise<DeviceList> {
  const response = await send(
    `${controlBase(organisationId)}/devices`,
    session,
    "GET",
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const list = parseDeviceList(response.body);
  if (list === null) throw new Error(JSON.stringify(response.body));
  return list;
}

export function requireKitchenDevice(
  list: DeviceList,
  name: string,
): KitchenDeviceView {
  const device = list.devices.find(
    (item): item is KitchenDeviceView =>
      item.kind === "kitchen_device" && item.name === name,
  );
  if (device === undefined)
    throw new Error(`No device ${name}: ${JSON.stringify(list.devices)}`);
  return device;
}

export function requireGatewayRow(
  list: DeviceList,
  gatewayId: string,
): Extract<DeviceView, { kind: "gateway" }> {
  const gateway = list.devices.find(
    (item): item is Extract<DeviceView, { kind: "gateway" }> =>
      item.kind === "gateway" && item.deviceId === gatewayId,
  );
  if (gateway === undefined) throw new Error(`No gateway ${gatewayId}`);
  return gateway;
}

export async function startGateway(
  organisationId: string,
  session: IssuedControlSession,
  name: string,
): Promise<Readonly<{ gatewayId: string; code: string; command: string }>> {
  const response = await send(
    `${controlBase(organisationId)}/devices/gateways`,
    session,
    "POST",
    { name, locationId: "Main shop" },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const started = parseDeviceGatewayStart(response.body);
  if (started === null) throw new Error("No gateway start");
  return {
    gatewayId: started.gatewayId,
    code: started.code,
    command: started.installCommand,
  };
}

export function enrollGateway(
  organisationId: string,
  gatewayId: string,
  code: string,
): Promise<Response> {
  return exports.default.fetch(`${PUBLIC_ORIGIN}/v1/device-gateways/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organisationId, gatewayId, code }),
  });
}

export async function credentialOf(response: Response): Promise<string> {
  expect(response.status, await response.clone().text()).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.credential !== "string")
    throw new Error("No credential");
  return body.credential;
}

export function gatewaySocketResponse(credential: string): Promise<Response> {
  return exports.default.fetch(`${PUBLIC_ORIGIN}/v1/device-gateways/socket`, {
    headers: {
      Upgrade: "websocket",
      authorization: `Bearer ${credential}`,
    },
  });
}

export type SimulatedGateway = Readonly<{
  socket: WebSocket;
  received: PlatformGatewayMessage[];
  send: (message: GatewayMessage) => void;
  raw: (message: string) => void;
  closed: Promise<number>;
  close: () => Promise<void>;
}>;

export async function connectGateway(
  credential: string,
): Promise<SimulatedGateway> {
  const response = await gatewaySocketResponse(credential);
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("socket was not returned");
  socket.accept();
  const received: PlatformGatewayMessage[] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    received.push(JSON.parse(String(event.data)) as PlatformGatewayMessage);
  });
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener(
      "close",
      (event: CloseEvent) => resolve(event.code),
      { once: true },
    );
  });
  return {
    socket,
    received,
    send: (message) => socket.send(JSON.stringify(message)),
    raw: (message) => socket.send(message),
    closed,
    close: async () => {
      if (socket.readyState === WebSocket.OPEN)
        socket.close(1000, "journey drop");
      await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    },
  };
}

export function found(
  sourceKey: string,
  suggestedName: string,
  overrides: Partial<FoundDevice> = {},
): FoundDevice {
  return {
    sourceKey,
    kind: "cobot",
    suggestedName,
    model: "Simulated model",
    serial: `SN-${sourceKey}`,
    firmwareVersion: "1.0.0",
    capabilities: [{ id: "move_tray", label: "Move a tray", revision: 1 }],
    ...overrides,
  };
}

export async function helloAndWait(
  gateway: SimulatedGateway,
  devices: readonly FoundDevice[],
): Promise<void> {
  const before = gateway.received.length;
  gateway.send({
    type: "hello",
    serviceVersion: "0.1.0",
    devices: [...devices],
    health: [],
  });
  await expect
    .poll(() =>
      gateway.received
        .slice(before)
        .some((message) => message.type === "welcome"),
    )
    .toBe(true);
}
