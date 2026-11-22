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

import { env } from "cloudflare:workers";

import { deviceFleetStub } from "../../src/devices/contract/fleet-stub";
import type { IssuedControlSession } from "../../src/data/control-plane";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import { organisationDatabase } from "./organisation-database";
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
    /** The level's pieces and the pieces in one mould group, if not the day's. */
    level?: Readonly<{ levelPieces: number; piecesPerGroup: number }>;
    /** The café day's events, if not the declared morning. */
    day?: Parameters<typeof openCounterShop>[3];
  }>,
): Promise<CobotKitchen> {
  const { organisationId, owner, home } = input;
  const base = controlBase(organisationId);
  const shop = await openCounterShop(
    organisationId,
    input.ownerUserId,
    input.merchantId,
    input.day,
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
  const level = {
    ...levelOf(
      productOf(await readBoard(organisationId, owner)).inventoryItemId,
    ),
    ...input.level,
  };
  const levelSet = await putLevel(organisationId, owner, level);
  expect(levelSet.status, JSON.stringify(levelSet.body)).toBe(200);
  return kitchen;
}

/**
 * The gateway's socket drops: the relay hears that the Platform side went
 * away, and its controllers go on. `reconnect` opens a new socket with the
 * same credential, and the relay says hello again.
 */
export async function dropGateway(kitchen: CobotKitchen): Promise<void> {
  await kitchen.pump.stop();
  await kitchen.pump.toRelay({ relay: "disconnected" });
  await kitchen.gateway.close();
}

export async function reconnectGateway(kitchen: CobotKitchen): Promise<void> {
  const gateway = await connectGateway(kitchen.credential);
  gateway.socket.addEventListener("message", (event: MessageEvent) => {
    kitchen.sentToGateway.push(
      JSON.parse(String(event.data)) as PlatformGatewayMessage,
    );
  });
  kitchen.gateway = gateway;
  kitchen.pump = new CobotGatewayPump(gateway, kitchen.home);
  await kitchen.pump.toRelay({ relay: "connected" });
}

export async function closeCobotKitchen(kitchen: CobotKitchen): Promise<void> {
  await kitchen.pump.stop();
  await kitchen.gateway.close();
  await cobotSession("stop", kitchen.home);
}

/** The id string of the run's Durable Object, from its summary row. */
export async function runActorIdOf(
  organisationId: string,
  proposalId: string,
): Promise<string> {
  const row = await organisationDatabase(organisationId)
    .prepare(
      "SELECT actor_id AS actorId FROM bake_run WHERE organisation_id = ? AND run_id = ?",
    )
    .bind(organisationId, proposalId)
    .first<{ actorId: string | null }>();
  const actorId = row?.actorId ?? null;
  if (actorId === null) throw new Error("The run has no Durable Object");
  return actorId;
}

/** The device fleet Actor of the kitchen, as the Platform calls it. */
export async function kitchenFleet(organisationId: string) {
  const scope = await OrganisationExecutionScope.resolve(
    env,
    organisationId as OrganisationId,
  );
  if (!scope.ok) throw new Error("No scope");
  const fleet = deviceFleetStub(env, scope.value, KITCHEN);
  if (fleet === null) throw new Error("No device fleet");
  return fleet;
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
  const until = Date.now() + timeout;
  let last: BakeRunRead | null = null;
  while (Date.now() < until) {
    // An approval from Slack starts the run after Pantry answers Slack.
    const response = await send(
      `${controlBase(kitchen.organisationId)}/bakes/proposals/${proposalId}/run`,
      kitchen.owner,
      "GET",
    );
    if (response.status === 200) {
      last = parseBakeRunRead(response.body);
      if (done(last)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // The run as it was, so that a failure names where it stood.
  const run = last?.run;
  throw new Error(
    `The run did not get there: ${JSON.stringify({
      state: run?.state,
      hold: run?.hold,
      tasks: run?.view?.tasks.map((task) => [
        task.key,
        task.state,
        task.reason,
      ]),
      dispatches: run?.dispatches.map((item) => [item.step, item.state]),
    })}`,
  );
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
