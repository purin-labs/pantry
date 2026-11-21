// Plan 24 S4: one approved bake runs on the server with two cobots and the
// oven, through the real shop gateway relay and the controller simulator
// (tests/shop-gateway-adapters.ts runs both). The run's Durable Object
// reserves each device through Plan 85, writes the dispatch record and then
// sends; only the receipts move the run. The run changes no stock: a person's
// check of the released pieces raises the counter stock through Commerce.
// The relay and the simulator decide every receipt; the asserted outcomes
// come from product code.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { parseDeviceActivity } from "@purin-labs/control-api";

import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import type { OrganisationId } from "../../src/ids";
import {
  DEVICES,
  controllerState,
  equipCobotKitchen,
  firstProposal,
  kitchenFleet,
  readRun,
  runAction,
  runActorIdOf,
  sentTasks,
  taskOf,
} from "./bake-run-support";
import {
  day,
  decide,
  productOf,
  readBoard,
  reconcileFeed,
} from "./bake-support";
import { cobotSession } from "./cobot-gateway-support";
import {
  controlBase,
  deviceShop,
  readDeviceList,
  requireKitchenDevice,
  send,
} from "./device-fleet-support";

const HOME = "bake-run";
/** The simulator's clock runs this much faster than the wall. */
const TIME_SCALE = 60;

it(
  "S4: an approved bake loads, bakes and unloads with two cobots through the real gateway; the read agrees with the receipts, the stock waits for an operator's check, and a second delivery makes no second move",
  { timeout: 420_000 },
  bakeRunJourney,
);

async function bakeRunJourney(): Promise<void> {
  const { owner, staff, viewer, organisationId, merchantId } =
    await deviceShop("bakerun");
  const base = controlBase(organisationId);

  // 1. The gateway enrolls with the two cobots and the oven of the
  //    simulator behind the real adapter, and the owner confirms them. The
  //    owner sets the kitchen to approval mode (S5: shadow is the default).
  const kitchen = await equipCobotKitchen({
    organisationId,
    owner: owner.session,
    ownerUserId: owner.identity.userId,
    merchantId,
    home: HOME,
    timeScale: TIME_SCALE,
    mode: "approval",
    bakeSeconds: 900,
  });
  const { gateway, pump } = kitchen;
  const gatewayStart = { gatewayId: kitchen.gatewayId };
  const evidence: Record<string, unknown> = {};

  // The counter falls below its level, and one proposal opens with the oven.
  const proposal = await firstProposal(kitchen);
  expect(proposal).toMatchObject({
    state: "open",
    mouldGroups: 1,
    oven: { name: "oven-1" },
  });
  const stockBefore = productOf(
    await readBoard(organisationId, owner.session),
  ).counterPieces;
  expect(stockBefore).toBe(8);

  // 2. An operator approves in the Portal. The approval starts the run.
  const approved = await decide(organisationId, staff.session, proposal, {
    decision: "approve",
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const first = await readRun(
    organisationId,
    viewer.session,
    proposal.proposalId,
  );
  expect(first.run.problem).toBeNull();
  expect(first.run.approval).toMatchObject({ role: "operator", via: "portal" });
  expect(first.run.devices.map((device) => device.sourceKey)).toEqual([
    ...DEVICES,
  ]);
  expect(first.access.mayOperate).toBe(false);

  // The run loads, bakes and unloads to the cooling rack. The stock does not
  // move while it runs.
  const stockDuring: (number | null)[] = [];
  await expect
    .poll(
      async () => {
        stockDuring.push(
          productOf(await readBoard(organisationId, owner.session))
            .counterPieces,
        );
        const read = await readRun(
          organisationId,
          owner.session,
          proposal.proposalId,
        );
        if (read.run.hold !== null)
          throw new Error(`The run is held: ${JSON.stringify(read.run.hold)}`);
        return read.run.state;
      },
      { timeout: 240_000, interval: 2_000 },
    )
    .toBe("completed");
  expect(new Set(stockDuring)).toEqual(new Set([8]));
  const done = await readRun(
    organisationId,
    owner.session,
    proposal.proposalId,
  );
  const view = done.run.view;
  if (view === null) throw new Error("The run has no view");
  expect(
    view.tasks.map((task) => [task.key, task.sourceKey, task.state]),
  ).toEqual([
    ["load-1", "cobot-1", "completed"],
    ["bake", "oven-1", "completed"],
    ["unload-1", "cobot-2", "completed"],
  ]);
  expect(view.groups).toEqual([
    {
      mouldGroup: 1,
      position: { kind: "place", place: { station: "cooling_rack", shelf: 1 } },
      basis: "receipt",
    },
  ]);

  // 3. Each task has planned and observed times, and the observed times are
  //    the receipts' device clocks.
  const sent = sentTasks(gateway.received);
  // Load, bake and unload, each sent once: both cobots took a move.
  expect(sent.map((message) => message.sourceKey)).toEqual([
    "cobot-1",
    "oven-1",
    "cobot-2",
  ]);
  const receipts: Record<string, unknown> = {};
  for (const task of view.tasks) {
    const reports = pump.reports(task.requestId ?? "");
    receipts[task.key] = reports;
    const end = reports.find((report) => report.state === "completed");
    const start = reports[0];
    if (start === undefined || end === undefined)
      throw new Error(`No receipts for ${task.key}`);
    expect(task.planned.endSeconds).toBeGreaterThan(task.planned.startSeconds);
    expect(task.observed.startSeconds).not.toBeNull();
    expect(
      (task.observed.endSeconds ?? 0) - (task.observed.startSeconds ?? 0),
    ).toBeCloseTo((end.deviceClockMs - start.deviceClockMs) / 1_000, 6);
    expect(task.observed.observedSeconds).toBe(end.observedSeconds);
  }
  // No two moves held the oven door at the same time.
  const load = taskOf(done, "load-1");
  const unload = taskOf(done, "unload-1");
  expect(load.observed.endSeconds ?? 0).toBeLessThanOrEqual(
    unload.observed.startSeconds ?? 0,
  );
  const controller = await controllerState(HOME);
  for (const sourceKey of DEVICES) {
    expect(controller.device(sourceKey).fault).toBeNull();
    expect(controller.device(sourceKey).operations.submit).toBe(1);
  }
  // Each dispatch has its record, written before the send, and its device
  // activity names the approval.
  expect(done.run.dispatches.map((item) => [item.step, item.state])).toEqual([
    ["load-1", "sent"],
    ["bake", "sent"],
    ["unload-1", "sent"],
  ]);
  for (const dispatch of done.run.dispatches)
    expect(dispatch.writtenAt).toBeLessThanOrEqual(dispatch.sentAt ?? 0);
  const devices = await readDeviceList(organisationId, owner.session);
  const activity = parseDeviceActivity(
    (
      await send(
        `${base}/devices/${requireKitchenDevice(devices, "cobot-1").deviceId}/activity`,
        owner.session,
        "GET",
      )
    ).body,
  );
  const kinds = activity?.events.map((event) => event.kind) ?? [];
  expect(kinds).toEqual(
    expect.arrayContaining([
      "task_reserved",
      "cobot_task_sent",
      "cobot_task_completed",
    ]),
  );
  for (const sourceKey of DEVICES)
    expect(requireKitchenDevice(devices, sourceKey).work).toEqual({
      state: "idle",
    });
  // The canvas, the timeline and the positions read one object: the route
  // gives what the Organisation Actor reads.
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: organisationId as OrganisationId,
    now: Date.now(),
  });
  const direct = await organisation.readBakeRun({
    organisationId: organisationId as OrganisationId,
    proposalId: proposal.proposalId,
  });
  expect(direct.ok && direct.value).toEqual(done.run);

  // 4. The stock did not change during the run. A viewer cannot record the
  //    check; an operator records it, and the counter rises through Commerce.
  expect(
    productOf(await readBoard(organisationId, owner.session)).counterPieces,
  ).toBe(8);
  const byViewer = await runAction(
    organisationId,
    viewer.session,
    proposal.proposalId,
    { action: "check", goodPieces: 8 },
  );
  expect(byViewer.status).toBeGreaterThanOrEqual(403);
  expect(byViewer.body).toMatchObject({ ok: false });
  expect(
    productOf(await readBoard(organisationId, owner.session)).counterPieces,
  ).toBe(8);
  const checked = await runAction(
    organisationId,
    staff.session,
    proposal.proposalId,
    { action: "check", goodPieces: 8 },
  );
  expect(checked.status, JSON.stringify(checked.body)).toBe(200);
  expect(checked.body).toMatchObject({ ok: true, goodPieces: 8 });
  await reconcileFeed();
  const after = await readBoard(organisationId, owner.session);
  expect(productOf(after).counterPieces).toBe(16);
  expect(
    after.proposals.find((item) => item.proposalId === proposal.proposalId),
  ).toMatchObject({ state: "ended" });
  const final = await readRun(
    organisationId,
    owner.session,
    proposal.proposalId,
  );
  expect(final.run).toMatchObject({
    state: "checked",
    check: { goodPieces: 8, role: "operator" },
  });

  // 5. A second dispatch with the same identity sends nothing; a second
  //    delivery of the task on the wire makes no second move.
  const fleet = await kitchenFleet(organisationId);
  const firstTask = sent[0];
  if (firstTask === undefined) throw new Error("No first task");
  const beforeAgain = gateway.received.length;
  const again = await fleet.dispatchCobotTask({
    gatewayId: gatewayStart.gatewayId,
    deviceId: requireKitchenDevice(devices, "cobot-1").deviceId,
    runActorId: "unused",
    message: firstTask,
    approval: { by: "journey", role: "operator", via: "portal", at: 0 },
  });
  expect(again).toEqual({ state: "completed", replayed: true });
  expect(
    gateway.received
      .slice(beforeAgain)
      .filter((message) => message.type === "cobot_task"),
  ).toEqual([]);
  const repliesBefore = pump.reports(firstTask.requestId).length;
  await pump.toRelay(firstTask);
  await expect
    .poll(() => pump.reports(firstTask.requestId).slice(repliesBefore))
    .toEqual([expect.objectContaining({ state: "completed", replayed: true })]);
  const afterDuplicate = (await controllerState(HOME)).device("cobot-1");
  expect(afterDuplicate.operations.submit).toBe(1);
  expect(afterDuplicate.tasksStarted).toBe(1);

  // 6. The artifact: the run read, the dispatch records, the receipts and
  //    the simulator's state.
  const controllerAtEnd = (await controllerState(HOME)).state;
  await pump.stop();
  await gateway.close();
  evidence.run = final.run;
  evidence.dispatches = done.run.dispatches;
  evidence.fleetDispatches = await fleet.cobotDispatches(
    await runActorIdOf(organisationId, proposal.proposalId),
  );
  evidence.receipts = receipts;
  evidence.stock = {
    before: stockBefore,
    during: [...new Set(stockDuring)],
    after: 16,
  };
  evidence.check = checked.body;
  evidence.viewerCheck = byViewer.body;
  evidence.duplicate = {
    fleet: again,
    relay: pump.reports(firstTask.requestId).slice(repliesBefore),
  };
  evidence.controller = controllerAtEnd;
  evidence.day = day.level;
  const artifact = await cobotSession("artifact", HOME, {
    name: "bake-run-journey",
    artifact: evidence,
  });
  await cobotSession("stop", HOME);
  console.log("BAKE_RUN_EVIDENCE", JSON.stringify({ file: artifact.file }));
}
