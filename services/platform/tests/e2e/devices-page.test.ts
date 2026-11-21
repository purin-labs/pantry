import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  parseDeviceList,
  type DeviceList,
  type DeviceView,
} from "@purin-labs/control-api";
import {
  parseMenuBoardSummaries,
  parseMenuScreenPairing,
} from "@purin-labs/cafe-control-api";
import {
  parseTerminalAssignment,
  type TerminalAssignment,
} from "@purin-labs/commerce-contracts";
import { isRecord } from "@purin-labs/std";

import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { activateTerminalAssignment } from "../../src/data/terminal-assignment-store";
import { MAC_HEARTBEAT_FRESH_MS } from "../../src/voice/store";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
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
import {
  enrollVoiceMac,
  installAnsweringVoiceDns,
  voiceMacRequest,
} from "./voice-mac-support";

/**
 * Plan 85 Phase 1, journey J1. A shop has a menu screen, a shop Mac and a Square
 * Terminal, each made through its own product path. All three show in one
 * list. The list says which need attention, and a viewer does not learn where
 * the Mac is on the network. A person outside the Organisation sees nothing,
 * and a revoked Mac leaves the list.
 */
it(
  "shows a shop's screen, Mac and terminal in one list, with the Mac's address for admins only",
  { timeout: 180_000 },
  devicesJourney,
);

// The fake DNS API only answers. The Mac's name is not part of this journey.
let removeVoiceDns: () => void = () => {};
beforeEach(() => {
  removeVoiceDns = installAnsweringVoiceDns(
    "zone_devices",
    "voice-devices.test",
  );
});
afterEach(() => removeVoiceDns());

async function devicesJourney(): Promise<void> {
  const owner = await commerceClient(`devices-owner-${crypto.randomUUID()}`);
  const viewer = await commerceClient(`devices-viewer-${crypto.randomUUID()}`);
  const outsider = await commerceClient(`devices-other-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Devices café");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    `merchant_devices_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  const personId = "person_devices_viewer";
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisationId, personId, "viewer"),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'viewer', 'active', ?, NULL)",
      )
      .bind(organisationId, viewer.identity.userId, personId, Date.now()),
  ]);
  const base = `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}`;

  // 1. A shop with no device has an empty list and no missing kind.
  const empty = await readList(base, owner.session);
  expect(empty.devices).toEqual([]);
  expect(empty.unavailableKinds).toEqual([]);

  // 2. The owner pairs a screen. It has never connected, so it needs attention.
  const board = await send(`${base}/menu-boards`, owner.session, "POST", {
    title: "Drinks",
    layout: "three_columns",
  });
  expect(board.status, JSON.stringify(board.body)).toBe(201);
  const boards = await send(`${base}/menu-boards`, owner.session, "GET");
  const boardId = isRecord(boards.body)
    ? parseMenuBoardSummaries(boards.body.boards)?.[0]?.boardId
    : undefined;
  if (boardId === undefined) throw new Error("No board");
  const started = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/screens/pairings`,
    { method: "POST" },
  );
  const pairing = parseMenuScreenPairing(await started.json());
  if (pairing === null) throw new Error("No pairing");
  const paired = await send(`${base}/menu-screens`, owner.session, "POST", {
    code: pairing.code,
    name: "Counter TV",
    boardId,
  });
  expect(paired.status, JSON.stringify(paired.body)).toBe(201);

  // 3. The owner starts a Mac. Until it enrolls, it does not need attention.
  const macStart = await send(`${base}/voice/macs`, owner.session, "POST", {});
  expect(macStart.status, JSON.stringify(macStart.body)).toBeLessThan(300);
  if (!isRecord(macStart.body)) throw new Error("No Mac");
  const macId = String(macStart.body.macId);
  const code = String(macStart.body.code);
  const pending = requireDevice(await readList(base, owner.session), macId);
  expect(pending).toMatchObject({
    kind: "shop_mac",
    enrollment: "pending",
    needsAttention: false,
    connection: { state: "never_connected" },
  });

  // 4. The Mac enrolls and sends a heartbeat through its own routes.
  const credential = await enrollVoiceMac(organisationId, macId, code);
  const heartbeat = await voiceMacRequest(credential, "heartbeat", "POST", {
    privateAddress: "192.168.1.20",
    serviceVersion: "0.2.0",
    modelState: "loaded",
  });
  expect(heartbeat.status, await heartbeat.clone().text()).toBeLessThan(300);

  // 5. A Square Terminal has an active assignment for its counter.
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  await activateTerminalAssignment({
    db: scope.database,
    organisationId: scope.organisationId,
    assignment: terminalAssignment(String(organisationId)),
    now: Date.now(),
  });

  // 6. The owner sees all three kinds in one list, and reads the Mac's address.
  const full = await readList(base, owner.session);
  expect(full.unavailableKinds).toEqual([]);
  expect(full.devices.map((device) => device.kind).sort()).toEqual([
    "menu_screen",
    "payment_terminal",
    "shop_mac",
  ]);
  expect(requireKind(full, "menu_screen")).toMatchObject({
    name: "Counter TV",
    needsAttention: true,
    connection: { state: "never_connected" },
  });
  const ownerMac = requireDevice(full, macId);
  expect(ownerMac).toMatchObject({
    enrollment: "enrolled",
    needsAttention: false,
    serviceVersion: "0.2.0",
    modelState: "loaded",
    connection: { state: "connected" },
  });
  if (ownerMac.kind !== "shop_mac") throw new Error("Not a Mac");
  expect(ownerMac.network?.privateAddress).toBe("192.168.1.20");
  expect(requireKind(full, "payment_terminal")).toMatchObject({
    name: "counter-main",
    needsAttention: true,
    connection: { state: "managed_by_provider" },
    simulated: false,
  });

  // 7. A viewer sees the same list, without the Mac's place on the network.
  const asViewer = await send(`${base}/devices`, viewer.session, "GET");
  expect(asViewer.status).toBe(200);
  expect(JSON.stringify(asViewer.body)).not.toContain("192.168.1.20");
  const viewerList = parseDeviceList(asViewer.body);
  if (viewerList === null) throw new Error("No viewer list");
  expect(viewerList.devices).toHaveLength(3);
  expect(requireDevice(viewerList, macId)).toMatchObject({ network: null });

  // 8. A person outside this Organisation cannot read its list.
  const refused = await send(`${base}/devices`, outsider.session, "GET");
  expect(refused.status).toBe(404);

  // 9. A silent Mac becomes offline and needs attention.
  await scope.database
    .prepare("UPDATE voice_mac SET last_heartbeat_at = ? WHERE mac_id = ?")
    .bind(Date.now() - MAC_HEARTBEAT_FRESH_MS - 1_000, macId)
    .run();
  expect(
    requireDevice(await readList(base, owner.session), macId),
  ).toMatchObject({
    needsAttention: true,
    connection: { state: "offline" },
  });

  // 10. A revoked Mac leaves the list.
  const revoked = await send(
    `${base}/voice/macs/${macId}/revoke`,
    owner.session,
    "POST",
    {},
  );
  expect(revoked.status, JSON.stringify(revoked.body)).toBeLessThan(300);
  const afterRevoke = await readList(base, owner.session);
  expect(afterRevoke.devices.map((device) => device.deviceId)).not.toContain(
    macId,
  );
  expect(afterRevoke.devices).toHaveLength(2);

  // 11. The list only reads.
  const write = await send(`${base}/devices`, owner.session, "POST", {});
  expect(write.status).toBe(405);
}

function terminalAssignment(organisationId: string): TerminalAssignment {
  const parsed = parseTerminalAssignment({
    assignmentId: "terminal_assignment_devices",
    organisationId,
    merchantId: "merchant_devices",
    pantryLocationId: "counter-main",
    account: {
      integrationAccountId: "integration_square_devices",
      providerAccountId: "merchant_square_devices",
      environment: "production",
      capabilityRevision: 1,
      country: "JP",
      currency: "JPY",
    },
    providerLocationId: "provider_location_devices",
    target: { kind: "paired_physical", providerDeviceId: "device_devices" },
    transport: "server_terminal",
    adapterVersion: "square_terminal@2026-08-19",
    revision: 1,
    state: { kind: "active" },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  return parsed.value;
}

function requireDevice(list: DeviceList, deviceId: string): DeviceView {
  const device = list.devices.find((item) => item.deviceId === deviceId);
  if (device === undefined) throw new Error(`No device ${deviceId}`);
  return device;
}

function requireKind(list: DeviceList, kind: DeviceView["kind"]): DeviceView {
  const device = list.devices.find((item) => item.kind === kind);
  if (device === undefined) throw new Error(`No device of kind ${kind}`);
  return device;
}

async function readList(
  base: string,
  session: IssuedControlSession,
): Promise<DeviceList> {
  const response = await send(`${base}/devices`, session, "GET");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const list = parseDeviceList(response.body);
  if (list === null) throw new Error(JSON.stringify(response.body));
  return list;
}

async function send(
  url: string,
  session: IssuedControlSession,
  method: "GET" | "POST",
  body?: unknown,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const headers =
    method === "GET"
      ? new Headers(controlReadHeaders(session))
      : commerceHeaders(session);
  if (method !== "GET") {
    headers.set("idempotency-key", crypto.randomUUID());
    headers.set("x-pantry-configuration-version", "1");
  }
  const response = await exports.default.fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
