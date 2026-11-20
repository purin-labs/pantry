import { expect } from "vitest";
import type {
  CobotTaskMessage,
  PlatformGatewayMessage,
} from "@purin-labs/control-api";
import {
  parseBakeRunRead,
  type BakeAuthorityMode,
  type BakeRunRead,
  type BakeRunTaskView,
} from "@purin-labs/kitchen-control-api";

import type { IssuedControlSession } from "../../src/data/control-plane";
import {
  applyFinancierWorkflow,
  levelOf,
  onlyProposal,
  openCounterShop,
  productOf,
  putLevel,
  readBoard,
} from "./bake-support";
import {
  CobotGatewayPump,
  cobotSession,
  controllerControl,
} from "./cobot-gateway-support";
import {
  connectGateway,
  controlBase,
  credentialOf,
  enrollGateway,
  readDeviceList,
  requireKitchenDevice,
  send,
  startGateway,
  type SimulatedGateway,
} from "./device-fleet-support";

/**
 * Plan 24 S4 to S6: the cobot kitchen of the bake run journeys. A café with
 * its counter (bake-support.ts), the controller simulator with two FR10
 * cobots and the oven, and the real `shop-gateway relay` behind a journey
 * socket (cobot-gateway-support.ts). The owner confirms the three devices on
 * the Devices page, sets the kitchen's authority and the financier's level.
 * The simulator and the relay decide every receipt.
 */

export const DEVICES = ["cobot-1", "cobot-2", "oven-1"] as const;
export const KITCHEN = "Main shop";

export type CobotKitchen = {
  readonly organisationId: string;
  readonly owner: IssuedControlSession;
  readonly home: string;
  readonly gatewayId: string;
  readonly credential: string;
  readonly shop: Awaited<ReturnType<typeof openCounterShop>>;
  /** The socket and its pump change when the gateway connects again. */
  gateway: SimulatedGateway;
  pump: CobotGatewayPump;
  /** Every message that the Platform sent to the gateway, on every socket. */
  readonly sentToGateway: PlatformGatewayMessage[];
};

export async function equipCobotKitchen(
  input: Readonly<{
    organisationId: string;
    owner: IssuedControlSession;
    ownerUserId: string;
    /** The merchant that the shop's fixture connected, if any. */
    merchantId: string | null;
    home: string;
    timeScale: number;
    mode: BakeAuthorityMode;
    bakeSeconds: number;
  }>,
): Promise<CobotKitchen> {
  const { organisationId, owner, home } = input;
  const base = controlBase(organisationId);
  const shop = await openCounterShop(
    organisationId,
    input.ownerUserId,
    input.merchantId,
  );
  await applyFinancierWorkflow(organisationId, owner, input.bakeSeconds);
  await cobotSession("start", home, { timeScale: input.timeScale });
  const started = await startGateway(organisationId, owner, "Bakery gateway");
  const credential = await credentialOf(
    await enrollGateway(organisationId, started.gatewayId, started.code),
  );
  const gateway = await connectGateway(credential);
  const kitchen: CobotKitchen = {
    organisationId,
    owner,
    home,
    gatewayId: started.gatewayId,
    credential,
    shop,
    gateway,
    pump: new CobotGatewayPump(gateway, home),
    sentToGateway: gateway.received,
  };
  await expect
    .poll(() => gateway.received.some((item) => item.type === "welcome"), {
      timeout: 20_000,
    })
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await readDeviceList(organisationId, owner)).devices.filter(
          (device) => device.kind === "kitchen_device",
        ).length,
      { timeout: 20_000 },
    )
    .toBe(3);
  const pending = await readDeviceList(organisationId, owner);
  for (const sourceKey of DEVICES) {
    const confirmed = await send(
      `${base}/devices/${requireKitchenDevice(pending, sourceKey).deviceId}/confirm`,
      owner,
      "POST",
      { name: sourceKey, stationId: "station_bakery" },
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  }
  if (input.mode === "approval") {
    const set = await setAuthority(organisationId, owner, "approval", null);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
  }
  const level = levelOf(
    productOf(await readBoard(organisationId, owner)).inventoryItemId,
  );
  const levelSet = await putLevel(organisationId, owner, level);
  expect(levelSet.status, JSON.stringify(levelSet.body)).toBe(200);
  return kitchen;
}

export async function closeCobotKitchen(kitchen: CobotKitchen): Promise<void> {
  await kitchen.pump.stop();
  await kitchen.gateway.close();
  await cobotSession("stop", kitchen.home);
}

/** The first fall below the level opens one proposal. */
export async function firstProposal(kitchen: CobotKitchen) {
  await kitchen.shop.runUntil("first_fall");
  return onlyProposal(kitchen.organisationId, kitchen.owner);
}

export function setAuthority(
  organisationId: string,
  session: IssuedControlSession,
  mode: BakeAuthorityMode,
  expectedRevision: number | null,
) {
  return send(
    `${controlBase(organisationId)}/bakes/authority`,
    session,
    "PUT",
    { kitchenLocation: KITCHEN, mode, expectedRevision },
  );
}

export async function readRun(
  organisationId: string,
  session: IssuedControlSession,
  proposalId: string,
): Promise<BakeRunRead> {
  const response = await send(
    `${controlBase(organisationId)}/bakes/proposals/${proposalId}/run`,
    session,
    "GET",
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return parseBakeRunRead(response.body);
}

export function runAction(
  organisationId: string,
  session: IssuedControlSession,
  proposalId: string,
  body: Record<string, unknown>,
) {
  return send(
    `${controlBase(organisationId)}/bakes/proposals/${proposalId}/run`,
    session,
    "POST",
    body,
  );
}

/** Polls the run until `done` holds for it, and returns that read. */
export async function runUntil(
  kitchen: Pick<CobotKitchen, "organisationId" | "owner">,
  proposalId: string,
  done: (read: BakeRunRead) => boolean,
  timeout = 120_000,
): Promise<BakeRunRead> {
  let last: BakeRunRead | null = null;
  await expect
    .poll(
      async () => {
        last = await readRun(kitchen.organisationId, kitchen.owner, proposalId);
        return done(last);
      },
      { timeout, interval: 500 },
    )
    .toBe(true);
  if (last === null) throw new Error("No run read");
  return last;
}

export type ControllerDevice = Readonly<{
  sourceKey: string;
  state: string;
  fault: unknown;
  operations: Readonly<Record<string, number>>;
  tasksStarted: number;
}>;

type ControllerTask = Readonly<{
  taskId: string;
  sourceKey: string;
  scripted: boolean;
  state: string;
  reason: string | null;
  carrierAt: string | null;
}>;

/** The simulator's own record: the evidence of every move it made. */
export async function controllerState(home: string) {
  const state = await controllerControl(home, { op: "state" });
  const devices = state.devices as readonly ControllerDevice[];
  const tasks = state.tasks as readonly ControllerTask[];
  const device = (sourceKey: string): ControllerDevice => {
    const found = devices.find((item) => item.sourceKey === sourceKey);
    if (found === undefined) throw new Error(`No controller ${sourceKey}`);
    return found;
  };
  /** The moves that a Platform task started, on every device. */
  const submitted = tasks.filter((task) => !task.scripted);
  return { state, device, tasks, submitted };
}

export function taskOf(read: BakeRunRead, key: string): BakeRunTaskView {
  const task = read.run.view?.tasks.find((item) => item.key === key);
  if (task === undefined) throw new Error(`No task ${key}`);
  return task;
}

/** The cobot tasks that the Platform sent to the gateway, in order. */
export function sentTasks(
  messages: readonly PlatformGatewayMessage[],
): CobotTaskMessage[] {
  return messages.filter(
    (message): message is Extract<PlatformGatewayMessage, CobotTaskMessage> =>
      message.type === "cobot_task",
  );
}
