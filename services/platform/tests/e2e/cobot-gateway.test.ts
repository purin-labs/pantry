import { expect, it } from "vitest";
import {
  parseDeviceActivity,
  type CobotTask,
  type GatewayMessage,
} from "@purin-labs/control-api";

import {
  CobotGatewayPump,
  cobotSession,
  controllerControl,
} from "./cobot-gateway-support";
import {
  connectGateway,
  controlBase,
  credentialOf,
  deviceShop,
  enrollGateway,
  readDeviceList,
  requireKitchenDevice,
  send,
  startGateway,
} from "./device-fleet-support";

/**
 * Plan 24 S3, the exit journey: the Plan 85 gateway journey with two
 * simulated FR10 cobots and the oven behind the real `cobot` adapter. The
 * controller simulator (`cobot-controller`) and `shop-gateway relay` run on
 * the node side (tests/shop-gateway-adapters.ts); the socket only carries the
 * relay's messages. The relay and the controller decide every answer.
 *
 * The artifact is output/plan-24/cobot-gateway-journey.json. It needs the
 * account Worker, `cargo`, and PANTRY_COBOT_CONTROLLER_BINARY or MUJOCO_DIR.
 */

const HOME = "cobot-gateway";
const TIME_SCALE = 5;
const DEVICES = ["cobot-1", "cobot-2", "oven-1"] as const;

it(
  "S3: two cobots and the oven enroll behind the adapter, a pause and a resume reach the controller, the relay replays a duplicate task, asks status after a restart, and a revoke closes the socket",
  { timeout: 300_000 },
  cobotGatewayJourney,
);

function dispatchId(): string {
  return `dsp_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function load(group: number, shelf: number): CobotTask {
  return {
    kind: "move_mould_group",
    mouldGroup: group,
    from: { station: "cold_rack", shelf: group },
    to: { station: "oven", shelf },
  };
}

type ControllerDevice = Readonly<{
  sourceKey: string;
  state: string;
  operations: Readonly<Record<string, number>>;
  tasksStarted: number;
}>;

async function controllerState() {
  const state = await controllerControl(HOME, { op: "state" });
  const devices = state.devices as readonly ControllerDevice[];
  const device = (sourceKey: string) => {
    const found = devices.find((item) => item.sourceKey === sourceKey);
    if (found === undefined) throw new Error(`No controller ${sourceKey}`);
    return found;
  };
  return { state, device };
}

async function cobotGatewayJourney(): Promise<void> {
  const { owner, staff, viewer, organisationId } = await deviceShop("cobots");
  const base = controlBase(organisationId);
  const started = await cobotSession("start", HOME, { timeScale: TIME_SCALE });
  const evidence: Record<string, unknown> = {
    controllerReady: started.ready,
  };

  // 1. The owner enrolls a gateway with a one-time code. The relay's hello
  //    holds the three devices that the adapter found on the controllers.
  const gatewayStart = await startGateway(
    organisationId,
    owner.session,
    "Bakery gateway",
  );
  const credential = await credentialOf(
    await enrollGateway(
      organisationId,
      gatewayStart.gatewayId,
      gatewayStart.code,
    ),
  );
  let gateway = await connectGateway(credential);
  let pump = new CobotGatewayPump(gateway, HOME);
  await expect
    .poll(
      () => gateway.received.some((message) => message.type === "welcome"),
      {
        timeout: 20_000,
      },
    )
    .toBe(true);
  const hello = pump.fromRelay.find((message) => message.type === "hello");
  expect(
    hello?.type === "hello"
      ? hello.devices.map((device) => device.sourceKey)
      : [],
  ).toEqual([...DEVICES]);

  // 2. The three found devices stay pending until a person confirms them.
  const pending = await readDeviceList(organisationId, viewer.session);
  for (const sourceKey of DEVICES)
    expect(requireKitchenDevice(pending, sourceKey)).toMatchObject({
      enrollment: "pending",
      hardware: sourceKey === "oven-1" ? "appliance" : "cobot",
      readiness: { kind: "blocked", reason: "pending" },
    });
  expect(
    (
      await send(
        `${base}/devices/${requireKitchenDevice(pending, "cobot-1").deviceId}/confirm`,
        staff.session,
        "POST",
        { name: "cobot-1", stationId: "station_bakery" },
      )
    ).status,
  ).toBeGreaterThanOrEqual(403);
  for (const sourceKey of DEVICES) {
    const confirmed = await send(
      `${base}/devices/${requireKitchenDevice(pending, sourceKey).deviceId}/confirm`,
      owner.session,
      "POST",
      { name: sourceKey, stationId: "station_bakery" },
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  }
  const confirmed = await readDeviceList(organisationId, owner.session);
  for (const sourceKey of DEVICES)
    expect(requireKitchenDevice(confirmed, sourceKey).readiness).toEqual({
      kind: "ready",
    });
  evidence.confirmedDevices = DEVICES.map((sourceKey) =>
    requireKitchenDevice(confirmed, sourceKey),
  );

  // 3. A pause reaches the controller, and its ack confirms it only after the
  //    controller answered. A resume does the same.
  const cobot = requireKitchenDevice(confirmed, "cobot-1");
  const device = `${base}/devices/${cobot.deviceId}`;
  expect(
    (await send(`${device}/pause`, staff.session, "POST", {})).status,
  ).toBe(200);
  await expect
    .poll(
      async () =>
        parseDeviceActivity(
          (await send(`${device}/activity`, staff.session, "GET")).body,
        )?.events.filter((event) => event.kind === "gateway_done").length,
      { timeout: 20_000 },
    )
    .toBe(1);
  expect((await controllerState()).device("cobot-1").state).toBe("paused");
  expect(
    requireKitchenDevice(
      await readDeviceList(organisationId, viewer.session),
      "cobot-1",
    ).readiness,
  ).toEqual({ kind: "blocked", reason: "paused" });
  expect(
    (await send(`${device}/resume`, staff.session, "POST", {})).status,
  ).toBe(200);
  await expect
    .poll(
      async () =>
        parseDeviceActivity(
          (await send(`${device}/activity`, staff.session, "GET")).body,
        )?.events.filter((event) => event.kind === "gateway_done").length,
      { timeout: 20_000 },
    )
    .toBe(2);
  await expect
    .poll(async () => (await controllerState()).device("cobot-1").state)
    .toBe("idle");
  evidence.pauseAndResume = parseDeviceActivity(
    (await send(`${device}/activity`, staff.session, "GET")).body,
  )?.events;

  // 4. A cobot task through the adapter: accepted, running and completed,
  //    with the time of the physics run.
  const first = dispatchId();
  const firstTask = {
    type: "cobot_task",
    requestId: first,
    sourceKey: "cobot-1",
    runId: "run-s3",
    taskId: "load-group-1",
    task: load(1, 1),
  } as const;
  await pump.toRelay(firstTask);
  await expect
    .poll(() => pump.reports(first).at(-1)?.state, { timeout: 60_000 })
    .toBe("completed");
  const firstStates = pump.reports(first).map((report) => report.state);
  expect(firstStates[0]).toBe("accepted");
  expect(firstStates).toContain("running");
  const firstEnd = pump.reports(first).at(-1)!;
  expect(firstEnd).toMatchObject({
    carrierAt: "destination",
    observedSeconds: 38.5,
    replayed: false,
  });
  const sequences = pump.reports(first).map((report) => report.sequence);
  expect(sequences).toEqual([...sequences].sort((left, right) => left - right));

  // 5. A second delivery of the same requestId answers from the journal, and
  //    the controller ran one task.
  const before = pump.reports(first).length;
  await pump.toRelay(firstTask);
  await expect
    .poll(() => pump.reports(first).slice(before))
    .toEqual([expect.objectContaining({ state: "completed", replayed: true })]);
  const afterDuplicate = (await controllerState()).device("cobot-1");
  expect(afterDuplicate.operations.submit).toBe(1);
  expect(afterDuplicate.tasksStarted).toBe(1);
  // An inquiry asks the controller, which still holds the task.
  await pump.toRelay({
    type: "cobot_inquire",
    requestId: first,
    sourceKey: "cobot-1",
  });
  await expect
    .poll(() => pump.reports(first).slice(before + 1))
    .toEqual([
      expect.objectContaining({ state: "completed", replayed: false }),
    ]);

  // 6. The relay restarts during a move. The new relay reads its journal and
  //    asks the controller for the task's status; it never submits again.
  const second = dispatchId();
  await pump.toRelay({
    type: "cobot_task",
    requestId: second,
    sourceKey: "cobot-2",
    runId: "run-s3",
    taskId: "load-group-2",
    task: load(2, 2),
  });
  await expect
    .poll(() => pump.reports(second).at(-1)?.state, { timeout: 20_000 })
    .toBe("running");
  const clock = pump.fromRelay.find(
    (message): message is Extract<GatewayMessage, { type: "cobot_clock" }> =>
      message.type === "cobot_clock",
  );
  await pump.stop();
  const firstRelay = pump;
  await gateway.close();
  await cobotSession("restart-relay", HOME);
  const duringRestart = (await controllerState()).state
    .tasks as readonly Readonly<{
    taskId: string;
    state: string;
  }>[];
  expect(duringRestart.find((task) => task.taskId === second)?.state).toBe(
    "running",
  );
  gateway = await connectGateway(credential);
  pump = new CobotGatewayPump(gateway, HOME);
  await expect
    .poll(() => pump.reports(second).at(-1)?.state, { timeout: 60_000 })
    .toBe("completed");
  const cobot2 = (await controllerState()).device("cobot-2");
  expect(cobot2.operations.submit).toBe(1);
  expect(cobot2.operations.status).toBeGreaterThanOrEqual(1);
  expect(cobot2.tasksStarted).toBe(1);
  expect(pump.reports(second).every((report) => !report.replayed)).toBe(true);

  // 7. While a task was open, the adapter sent the clock of each device.
  expect(clock?.clocks.map((entry) => entry.sourceKey).sort()).toEqual([
    ...DEVICES,
  ]);

  // 8. A stop gets its own receipt, and a controller that does not answer in
  //    5 s gives `ack refused`.
  await pump.toRelay({
    type: "stop",
    requestId: "stop-cobot-2",
    sourceKey: "cobot-2",
  });
  await pump.toRelay({
    type: "resume",
    requestId: "resume-cobot-2",
    sourceKey: "cobot-2",
  });
  await controllerControl(HOME, { op: "freeze", device: "oven-1" });
  await pump.toRelay({
    type: "pause",
    requestId: "pause-frozen-oven",
    sourceKey: "oven-1",
  });
  const acks = () =>
    pump.fromRelay.filter(
      (message): message is Extract<GatewayMessage, { type: "ack" }> =>
        message.type === "ack",
    );
  await expect
    .poll(() => acks().map((ack) => [ack.requestId, ack.outcome]), {
      timeout: 15_000,
    })
    .toEqual([
      ["stop-cobot-2", "done"],
      ["resume-cobot-2", "done"],
      ["pause-frozen-oven", "refused"],
    ]);
  await controllerControl(HOME, { op: "clear", device: "oven-1" });

  // 9. A fault on the controller reaches the Devices page as health, and a
  //    person's clear at the machine ends it.
  await controllerControl(HOME, {
    op: "inject",
    device: "cobot-1",
    fault: "arm_stop",
  });
  await expect
    .poll(
      async () =>
        requireKitchenDevice(
          await readDeviceList(organisationId, owner.session),
          "cobot-1",
        ),
      { timeout: 20_000 },
    )
    .toMatchObject({ health: "fault", faultCode: "ARM_STOP" });
  await controllerControl(HOME, { op: "clear", device: "cobot-1" });
  await expect
    .poll(
      async () =>
        requireKitchenDevice(
          await readDeviceList(organisationId, owner.session),
          "cobot-1",
        ),
      { timeout: 20_000 },
    )
    .toMatchObject({ health: "ok", faultCode: null });

  // 10. Each relay message parsed on the Platform: the socket is still open.
  //     A revoke closes it.
  expect(gateway.socket.readyState).toBe(WebSocket.OPEN);
  const revoked = await send(
    `${base}/devices/${gatewayStart.gatewayId}/revoke`,
    owner.session,
    "POST",
    {},
  );
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  expect(await gateway.closed).toBe(4403);
  await pump.stop();

  // Each relay's reports, the first relay's before the restart.
  evidence.reports = {
    [first]: [...firstRelay.reports(first), ...pump.reports(first)],
    [second]: {
      beforeRestart: firstRelay.reports(second),
      afterRestart: pump.reports(second),
    },
  };
  evidence.acks = acks();
  evidence.clock = clock;
  evidence.controller = (await controllerState()).state;
  const artifact = await cobotSession("artifact", HOME, {
    name: "cobot-gateway-journey",
    artifact: evidence,
  });
  await cobotSession("stop", HOME);
  console.log(
    "COBOT_GATEWAY_EVIDENCE",
    JSON.stringify({ file: artifact.file }),
  );
}
