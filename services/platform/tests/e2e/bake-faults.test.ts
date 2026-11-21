// Plan 24 S6: the fault cases of an approved bake run, each with its own
// outcome, through the real gateway relay and the controller simulator
// (tests/shop-gateway-adapters.ts). The simulator's control port injects
// each fault as the machine would show it: a duplicate delivery, a dropped
// gateway socket, stale data, a revoke on the Devices page, a local emergency
// stop and a move outside the plan in the oven door. The simulator's `state`
// is the evidence of every move: each case counts the moves there. Exit: no
// move without an approval, no duplicate move, and each uncertain outcome
// stops the next dispatch with one visible hold that a person settles.
import { expect, it } from "vitest";
import type { CobotTask } from "@purin-labs/control-api";
import type { BakeRunRead } from "@purin-labs/kitchen-control-api";

import {
  DEVICES,
  closeCobotKitchen,
  controllerState,
  dropGateway,
  equipCobotKitchen,
  firstProposal,
  kitchenFleet,
  readRun,
  reconnectGateway,
  runAction,
  runActorIdOf,
  runUntil,
  sentTasks,
  taskOf,
  type CobotKitchen,
} from "./bake-run-support";
import {
  decide,
  productOf,
  proposalOf,
  readBoard,
  writeArtifact,
} from "./bake-support";
import { controllerControl } from "./cobot-gateway-support";
import {
  controlBase,
  deviceShop,
  readDeviceList,
  requireKitchenDevice,
  send,
} from "./device-fleet-support";

/** Ten times faster than the wall: a load takes about 4 s, the bake 12 s. */
const TIME_SCALE = 10;
const BAKE_SECONDS = 120;

type Shop = Awaited<ReturnType<typeof deviceShop>>;

async function faultKitchen(
  label: string,
  level?: Readonly<{ levelPieces: number; piecesPerGroup: number }>,
): Promise<Readonly<{ shop: Shop; kitchen: CobotKitchen }>> {
  const shop = await deviceShop(label);
  const kitchen = await equipCobotKitchen({
    organisationId: shop.organisationId,
    owner: shop.owner.session,
    ownerUserId: shop.owner.identity.userId,
    merchantId: shop.merchantId,
    home: `bake-${label}`,
    timeScale: TIME_SCALE,
    mode: "approval",
    bakeSeconds: BAKE_SECONDS,
    ...(level === undefined ? {} : { level }),
  });
  return { shop, kitchen };
}

/** An operator approves the first proposal in the Portal; the run starts. */
async function approvedRun(shop: Shop, kitchen: CobotKitchen) {
  const proposal = await firstProposal(kitchen);
  const approved = await decide(
    shop.organisationId,
    shop.staff.session,
    proposal,
    {
      decision: "approve",
    },
  );
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return proposal;
}

function taskIs(key: string, ...states: string[]) {
  return (read: BakeRunRead) => states.includes(taskOf(read, key).state);
}

function settle(
  shop: Shop,
  proposalId: string,
  decision: "continue" | "stop",
  seen?: "source" | "tool" | "destination" | "lost",
) {
  return runAction(shop.organisationId, shop.staff.session, proposalId, {
    action: "settle",
    decision,
    ...(seen === undefined ? {} : { seen }),
  });
}

/** Each Platform task that the controller started, by device. */
async function movesOf(kitchen: CobotKitchen) {
  const controller = await controllerState(kitchen.home);
  const count = (sourceKey: string) =>
    controller.submitted.filter((task) => task.sourceKey === sourceKey).length;
  return {
    controller,
    started: Object.fromEntries(DEVICES.map((key) => [key, count(key)])),
  };
}

function load(group: number, from: number, shelf: number): CobotTask {
  return {
    kind: "move_mould_group",
    mouldGroup: group,
    from: { station: "cold_rack", shelf: from },
    to: { station: "oven", shelf },
  };
}

it(
  "S6.1: a duplicate delivery of a task during its move, from the Platform and on the wire, makes no second move, and the run ends with one move for each task",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const { shop, kitchen } = await faultKitchen("dup");
    const proposal = await approvedRun(shop, kitchen);
    await runUntil(kitchen, proposal.proposalId, taskIs("load-1", "running"));
    const [first] = sentTasks(kitchen.sentToGateway);
    if (first === undefined) throw new Error("No first task");
    const before = kitchen.sentToGateway.length;
    // The Platform sends the same identity again: the fleet's ledger answers.
    const fleet = await kitchenFleet(shop.organisationId);
    const again = await fleet.dispatchCobotTask({
      gatewayId: kitchen.gatewayId,
      deviceId: requireKitchenDevice(
        await readDeviceList(shop.organisationId, shop.owner.session),
        "cobot-1",
      ).deviceId,
      runActorId: await runActorIdOf(shop.organisationId, proposal.proposalId),
      message: first,
      approval: { by: "journey", role: "operator", via: "portal", at: 0 },
    });
    expect(again.replayed).toBe(true);
    expect(sentTasks(kitchen.sentToGateway.slice(before))).toEqual([]);
    // The same task arrives at the gateway a second time, during the move.
    await kitchen.pump.toRelay(first);
    await expect
      .poll(() => kitchen.pump.reports(first.requestId).some((r) => r.replayed))
      .toBe(true);
    const done = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.state === "completed",
    );
    expect(done.run.hold).toBeNull();
    const { controller, started } = await movesOf(kitchen);
    expect(started).toEqual({ "cobot-1": 1, "cobot-2": 1, "oven-1": 1 });
    for (const sourceKey of DEVICES)
      expect(controller.device(sourceKey).tasksStarted).toBe(1);
    await closeCobotKitchen(kitchen);
    await writeArtifact("plan-24/bake-fault-duplicate.json", {
      fleetAnswer: again,
      relayReports: kitchen.pump.reports(first.requestId),
      run: done.run,
      controller: controller.state,
    });
  },
);

it(
  "S6.2: the gateway's socket drops during a move: the run holds with an unknown result and sends nothing, the next hello asks the task's state, and a person's settle goes on with no second move",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const { shop, kitchen } = await faultKitchen("drop");
    const proposal = await approvedRun(shop, kitchen);
    await runUntil(kitchen, proposal.proposalId, taskIs("load-1", "running"));
    const [first] = sentTasks(kitchen.sentToGateway);
    if (first === undefined) throw new Error("No first task");
    await dropGateway(kitchen);
    const heldRead = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.hold !== null,
    );
    expect(heldRead.run).toMatchObject({
      state: "held",
      hold: { code: "result_unknown" },
    });
    // The controller ends the move while Pantry cannot hear it.
    await expect
      .poll(
        async () =>
          (await controllerState(kitchen.home)).tasks.find(
            (task) => task.taskId === first.requestId,
          )?.state,
        { timeout: 30_000 },
      )
      .toBe("completed");
    // A settle before the gateway gave the task's end is refused.
    const early = await settle(shop, proposal.proposalId, "continue");
    expect(early.status).toBe(409);
    await reconnectGateway(kitchen);
    await expect
      .poll(() =>
        kitchen.sentToGateway.some(
          (message) =>
            message.type === "cobot_inquire" &&
            message.requestId === first.requestId,
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        kitchen.pump
          .reports(first.requestId)
          .some((report) => report.state === "completed"),
      )
      .toBe(true);
    // The run has the task's end, still holds and has sent nothing new
    // until a person settles.
    await runUntil(kitchen, proposal.proposalId, taskIs("load-1", "completed"));
    expect(sentTasks(kitchen.sentToGateway)).toHaveLength(1);
    expect(
      (
        await readRun(
          shop.organisationId,
          shop.owner.session,
          proposal.proposalId,
        )
      ).run.state,
    ).toBe("held");
    const settled = await settle(
      shop,
      proposal.proposalId,
      "continue",
      "destination",
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    const done = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.state === "completed",
    );
    expect(done.run.settlements).toEqual([
      expect.objectContaining({
        holdCode: "result_unknown",
        decision: "continue",
        seen: "destination",
      }),
    ]);
    const { controller, started } = await movesOf(kitchen);
    expect(started).toEqual({ "cobot-1": 1, "cobot-2": 1, "oven-1": 1 });
    expect(controller.device("cobot-1").operations.status).toBeGreaterThan(0);
    await closeCobotKitchen(kitchen);
    await writeArtifact("plan-24/bake-fault-disconnect.json", {
      held: heldRead.run.hold,
      earlySettle: early.body,
      inquiry: kitchen.pump.reports(first.requestId),
      run: done.run,
      controller: controller.state,
    });
  },
);

it(
  "S6.3: a cobot sends stale data during a move: an old line again changes nothing, a frozen device holds the run with stale data and no next task goes, and the run goes on only after a person settles",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const { shop, kitchen } = await faultKitchen("stale");
    const proposal = await approvedRun(shop, kitchen);
    await runUntil(kitchen, proposal.proposalId, taskIs("load-1", "running"));
    // The cobot's data stops: its clock and its reports stand still while
    // its socket stays open, and the gateway still sends its last clock.
    expect(
      await controllerControl(kitchen.home, {
        op: "freeze",
        device: "cobot-1",
      }),
    ).toMatchObject({ ok: true });
    // The device also sends an older line again: the run has it already.
    const stale = await controllerControl(kitchen.home, {
      op: "stale",
      device: "cobot-1",
    });
    expect(stale).toMatchObject({ ok: true });
    const heldRead = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.hold !== null,
    );
    expect(heldRead.run.hold).toMatchObject({
      code: "evidence_lost",
      sourceKey: "cobot-1",
    });
    expect(heldRead.run.hold?.message).toContain("stale");
    expect(sentTasks(kitchen.sentToGateway)).toHaveLength(1);
    // A person at the machine clears the cobot; the move ends, and the run
    // sends nothing until the person settles.
    await controllerControl(kitchen.home, { op: "clear", device: "cobot-1" });
    await runUntil(kitchen, proposal.proposalId, taskIs("load-1", "completed"));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(sentTasks(kitchen.sentToGateway)).toHaveLength(1);
    const settled = await settle(shop, proposal.proposalId, "continue");
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    const done = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.state === "completed",
    );
    const { controller, started } = await movesOf(kitchen);
    expect(started).toEqual({ "cobot-1": 1, "cobot-2": 1, "oven-1": 1 });
    await closeCobotKitchen(kitchen);
    await writeArtifact("plan-24/bake-fault-stale.json", {
      staleLine: stale,
      held: heldRead.run.hold,
      run: done.run,
      controller: controller.state,
    });
  },
);

it(
  "S6.4: a cobot is revoked on the Devices page during the run: the run holds at once, the revoked cobot never gets a task, and a person stops the run with no stock change",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const { shop, kitchen } = await faultKitchen("revoke");
    const proposal = await approvedRun(shop, kitchen);
    const stockBefore = productOf(
      await readBoard(shop.organisationId, shop.owner.session),
    ).counterPieces;
    await runUntil(kitchen, proposal.proposalId, taskIs("load-1", "running"));
    const cobot2 = requireKitchenDevice(
      await readDeviceList(shop.organisationId, shop.owner.session),
      "cobot-2",
    );
    const revoked = await send(
      `${controlBase(shop.organisationId)}/devices/${cobot2.deviceId}/revoke`,
      shop.owner.session,
      "POST",
      {},
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const heldRead = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.hold?.code === "device_revoked",
    );
    expect(heldRead.run.hold).toMatchObject({ sourceKey: "cobot-2" });
    // A person checks and goes on with the other devices: the load ends and
    // the oven bakes, but the unload of the revoked cobot holds the run.
    await runUntil(kitchen, proposal.proposalId, taskIs("load-1", "completed"));
    expect((await settle(shop, proposal.proposalId, "continue")).status).toBe(
      200,
    );
    const notReady = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.hold?.code === "device_not_ready",
      120_000,
    );
    expect(notReady.run.hold).toMatchObject({
      step: "unload-1",
      sourceKey: "cobot-2",
    });
    const stopped = await settle(shop, proposal.proposalId, "stop");
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    const end = await readRun(
      shop.organisationId,
      shop.owner.session,
      proposal.proposalId,
    );
    expect(end.run.state).toBe("stopped");
    expect(end.run.settlements.map((item) => item.holdCode)).toEqual([
      "device_revoked",
      "device_not_ready",
    ]);
    const { controller, started } = await movesOf(kitchen);
    expect(started).toEqual({ "cobot-1": 1, "cobot-2": 0, "oven-1": 1 });
    expect(
      sentTasks(kitchen.sentToGateway).filter((m) => m.sourceKey === "cobot-2"),
    ).toEqual([]);
    expect(
      productOf(await readBoard(shop.organisationId, shop.owner.session))
        .counterPieces,
    ).toBe(stockBefore);
    expect(
      (await proposalOf(shop.organisationId, shop.owner.session, proposal))
        .state,
    ).toBe("ended");
    await closeCobotKitchen(kitchen);
    await writeArtifact("plan-24/bake-fault-revoke.json", {
      revoked: revoked.body,
      holds: [heldRead.run.hold, notReady.run.hold],
      run: end.run,
      controller: controller.state,
    });
  },
);

it(
  "S6.6: a local emergency stop during a move stops every device: the run holds with the failed task, refuses to go on, and a person records where the mould group is and stops it; nothing moves again",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const { shop, kitchen } = await faultKitchen("estop");
    const proposal = await approvedRun(shop, kitchen);
    await runUntil(kitchen, proposal.proposalId, taskIs("load-1", "running"));
    expect(
      await controllerControl(kitchen.home, {
        op: "inject",
        device: "cobot-1",
        fault: "estop",
      }),
    ).toMatchObject({ ok: true });
    const heldRead = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.hold !== null && read.run.view?.disposition !== null,
    );
    expect(taskOf(heldRead, "load-1")).toMatchObject({ state: "failed" });
    // The run never sends the move again: continue is refused, and a stop
    // needs the place where the person saw the mould group.
    const cont = await settle(shop, proposal.proposalId, "continue");
    expect(cont.status).toBe(409);
    const blind = await settle(shop, proposal.proposalId, "stop");
    expect(blind.status).toBe(409);
    expect(JSON.stringify(blind.body)).toContain("Say where you saw");
    // A person at the machine clears the emergency stop and looks.
    await controllerControl(kitchen.home, { op: "clear", device: "cobot-1" });
    const stopped = await settle(shop, proposal.proposalId, "stop", "tool");
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    const end = await readRun(
      shop.organisationId,
      shop.owner.session,
      proposal.proposalId,
    );
    expect(end.run).toMatchObject({
      state: "stopped",
      settlements: [
        expect.objectContaining({ decision: "stop", seen: "tool" }),
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const { controller, started } = await movesOf(kitchen);
    expect(started).toEqual({ "cobot-1": 1, "cobot-2": 0, "oven-1": 0 });
    expect(sentTasks(kitchen.sentToGateway)).toHaveLength(1);
    await closeCobotKitchen(kitchen);
    await writeArtifact("plan-24/bake-fault-estop.json", {
      held: heldRead.run.hold,
      refused: { continue: cont.body, stopWithoutPlace: blind.body },
      run: end.run,
      controller: controller.state,
    });
  },
);

it(
  "S6.7: two mould groups need the oven door: Pantry sends the second door move only after the first one's receipt, so no two moves are in the door and the simulator raises no door conflict",
  { timeout: 300_000 },
  async (): Promise<void> => {
    // A level of 14 with two pieces in a group: the first fall to 11 asks
    // for two mould groups.
    const { shop, kitchen } = await faultKitchen("door", {
      levelPieces: 14,
      piecesPerGroup: 2,
    });
    const proposal = await approvedRun(shop, kitchen);
    expect(proposal.mouldGroups).toBe(2);
    const done = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.state === "completed",
      180_000,
    );
    const keys = ["load-1", "load-2", "unload-1", "unload-2"];
    const spans = keys.map((key) => {
      const task = taskOf(done, key);
      return {
        key,
        sourceKey: task.sourceKey,
        start: task.observed.startSeconds ?? -1,
        end: task.observed.endSeconds ?? -1,
      };
    });
    // Each door move started after the one before it ended.
    for (let index = 1; index < spans.length; index += 1)
      expect(spans[index]?.start ?? 0).toBeGreaterThanOrEqual(
        spans[index - 1]?.end ?? 0,
      );
    const { controller, started } = await movesOf(kitchen);
    for (const sourceKey of DEVICES)
      expect(controller.device(sourceKey).fault).toBeNull();
    expect((started["cobot-1"] ?? 0) + (started["cobot-2"] ?? 0)).toBe(4);
    expect(started["oven-1"]).toBe(1);
    await closeCobotKitchen(kitchen);
    await writeArtifact("plan-24/bake-fault-door.json", {
      spans,
      run: done.run,
      controller: controller.state,
    });
  },
);

it(
  "S6.7: a move outside the plan meets the run's move in the oven door: both cobots stop with a door conflict, the run holds with one disposition and sends nothing more",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const { shop, kitchen } = await faultKitchen("conflict");
    const proposal = await approvedRun(shop, kitchen);
    // The approval sent the load of group 1 to cobot-1. At the same time a
    // person at cobot-2's teach pendant loads group 3 into the oven.
    expect(sentTasks(kitchen.sentToGateway)).toHaveLength(1);
    expect(
      await controllerControl(kitchen.home, {
        op: "script",
        device: "cobot-2",
        moves: [{ moveId: "pendant-load-3", task: load(3, 3, 3), afterMs: 0 }],
      }),
    ).toMatchObject({ ok: true });
    const heldRead = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.hold !== null,
    );
    expect(heldRead.run.state).toBe("held");
    const faults = (await controllerState(kitchen.home)).state
      .devices as readonly {
      sourceKey: string;
      fault: string | null;
    }[];
    expect(
      faults
        .filter((device) => device.sourceKey !== "oven-1")
        .map((d) => d.fault),
    ).toEqual(["DOOR_CONFLICT", "DOOR_CONFLICT"]);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(sentTasks(kitchen.sentToGateway)).toHaveLength(1);
    await controllerControl(kitchen.home, { op: "clear", device: "cobot-1" });
    await controllerControl(kitchen.home, { op: "clear", device: "cobot-2" });
    const stopped = await settle(shop, proposal.proposalId, "stop", "lost");
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    const { controller, started } = await movesOf(kitchen);
    expect(started).toEqual({ "cobot-1": 1, "cobot-2": 0, "oven-1": 0 });
    await closeCobotKitchen(kitchen);
    await writeArtifact("plan-24/bake-fault-door-conflict.json", {
      held: heldRead.run.hold,
      run: (
        await readRun(
          shop.organisationId,
          shop.owner.session,
          proposal.proposalId,
        )
      ).run,
      controller: controller.state,
    });
  },
);
