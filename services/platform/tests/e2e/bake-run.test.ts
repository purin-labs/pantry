// Plan 24 S4: one approved bake runs on the server with two cobots and the
// oven, through the real shop gateway relay and the controller simulator
// (tests/shop-gateway-adapters.ts runs both). The run's Durable Object
// reserves each device through Plan 85, writes the dispatch record and then
// sends; only the receipts move the run. The run changes no stock: a person's
// check of the released pieces raises the counter stock through Commerce.
// The relay and the simulator decide every receipt; the asserted outcomes
// come from product code.
import { env } from "cloudflare:workers";
import { http } from "msw";
import { expect, it } from "vitest";
import {
  newConversationId,
  parseDeviceActivity,
  type PlatformGatewayMessage,
} from "@purin-labs/control-api";

import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { deviceFleetStub } from "../../src/actors/device-fleet";
import type { IssuedControlSession } from "../../src/data/control-plane";
import type { OrganisationId } from "../../src/ids";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import {
  DEVICES,
  controllerState,
  equipCobotKitchen,
  firstProposal,
  readRun,
  runAction,
  sentTasks,
  setAuthority,
  taskOf,
} from "./bake-run-support";
import {
  applyFinancierWorkflow,
  chatThrough,
  day,
  decide,
  levelOf,
  onlyProposal,
  openCounterShop,
  productOf,
  putLevel,
  readBoard,
  reconcileFeed,
  replyToModel,
  toolValue,
  writeArtifact,
  type Journey,
  type Script,
} from "./bake-support";
import { organisationDatabase } from "./organisation-database";
import { cobotSession } from "./cobot-gateway-support";
import {
  connectGateway,
  controlBase,
  credentialOf,
  deviceShop,
  enrollGateway,
  found,
  helloAndWait,
  readDeviceList,
  requireKitchenDevice,
  send,
  startGateway,
  type SimulatedGateway,
} from "./device-fleet-support";

import { installMemoryFixture, post } from "./memory-support";
import { network } from "./network";

const HOME = "bake-run";
/** The simulator's clock runs this much faster than the wall. */
const TIME_SCALE = 60;

it(
  "S4: an approved bake loads, bakes and unloads with two cobots through the real gateway; the read agrees with the receipts, the stock waits for an operator's check, and a second delivery makes no second move",
  { timeout: 420_000 },
  bakeRunJourney,
);

it(
  "S4: the Portal chat agent reads a bake run and requests its pause for the person who asked; a viewer's request is refused and the run goes on",
  { timeout: 300_000 },
  agentPauseJourney,
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
  const scope = await OrganisationExecutionScope.resolve(
    env,
    organisationId as OrganisationId,
  );
  if (!scope.ok) throw new Error("No scope");
  const fleet = deviceFleetStub(env, scope.value, "Main shop");
  const firstTask = sent[0];
  if (fleet === null || firstTask === undefined) throw new Error("No fleet");
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
    (await readActorId(organisationId, proposal.proposalId)) ?? "",
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

async function readActorId(
  organisationId: string,
  proposalId: string,
): Promise<string | null> {
  const row = await organisationDatabase(organisationId)
    .prepare(
      "SELECT actor_id AS actorId FROM bake_run WHERE organisation_id = ? AND run_id = ?",
    )
    .bind(organisationId, proposalId)
    .first<{ actorId: string | null }>();
  return row?.actorId ?? null;
}

/**
 * A gateway that only answers: the clock read, an `accepted` report for each
 * task, and each device's clock every two seconds while it is connected.
 */
async function answeringGateway(
  organisationId: string,
  session: IssuedControlSession,
): Promise<Readonly<{ gateway: SimulatedGateway; stop: () => Promise<void> }>> {
  const started = await startGateway(
    organisationId,
    session,
    "Kitchen gateway",
  );
  const gateway = await connectGateway(
    await credentialOf(
      await enrollGateway(organisationId, started.gatewayId, started.code),
    ),
  );
  await helloAndWait(gateway, [
    ...["cobot-1", "cobot-2"].map((key) =>
      found(key, key, {
        capabilities: [
          { id: "move_mould_group", label: "Move a mould group", revision: 1 },
        ],
      }),
    ),
    found("oven-1", "oven-1", {
      kind: "appliance",
      capabilities: [{ id: "bake", label: "Bake a program", revision: 1 }],
    }),
  ]);
  const zero = Date.now();
  const sequence = new Map<string, number>();
  const stamp = (sourceKey: string) => {
    const next = (sequence.get(sourceKey) ?? 0) + 1;
    sequence.set(sourceKey, next);
    return { sequence: next, deviceClockMs: Date.now() - zero };
  };
  const clocks = () =>
    DEVICES.map((sourceKey) => ({
      sourceKey,
      ...stamp(sourceKey),
      state: "idle" as const,
    }));
  gateway.socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as PlatformGatewayMessage;
    if (message.type === "cobot_clock_read")
      gateway.send({
        type: "cobot_clock",
        requestId: message.requestId,
        clocks: clocks(),
      });
    if (message.type === "cobot_task")
      gateway.send({
        type: "cobot_report",
        requestId: message.requestId,
        sourceKey: message.sourceKey,
        state: "accepted",
        ...stamp(message.sourceKey),
        progress: 0,
        phase: "accepted",
        carrierAt: "source",
        reason: null,
        observedSeconds: null,
        replayed: false,
      });
  });
  const ticker = setInterval(() => {
    if (gateway.socket.readyState === WebSocket.OPEN)
      gateway.send({
        type: "cobot_clock",
        clocks: clocks().map((entry) =>
          entry.sourceKey === "cobot-1" ? { ...entry, state: "busy" } : entry,
        ),
      });
  }, 2_000);
  const devices = await readDeviceList(organisationId, session);
  for (const sourceKey of DEVICES) {
    const confirmed = await send(
      `${controlBase(organisationId)}/devices/${requireKitchenDevice(devices, sourceKey).deviceId}/confirm`,
      session,
      "POST",
      { name: sourceKey, stationId: "station_bakery" },
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  }
  return {
    gateway,
    stop: async () => {
      clearInterval(ticker);
      await gateway.close();
    },
  };
}

function agentScripts(journey: Journey): Readonly<Record<string, Script>> {
  return {
    READRUN: {
      tool: "bake_run_read",
      args: () => ({ proposalId: journey.proposalId }),
      ask: ["kitchen.bake.read"],
    },
    PAUSERUN: {
      tool: "bake_run_pause",
      args: () => ({ proposalId: journey.proposalId }),
      ask: ["kitchen.bake_run.pause"],
    },
  };
}

async function agentPauseJourney(): Promise<void> {
  const fixture = await installMemoryFixture();
  const { author, viewer, organisationId } = fixture;
  const journey: Journey = {
    outputs: {},
    offered: new Set(),
    inventoryItemId: "",
    proposalId: "",
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, journey, agentScripts),
    ),
  );
  const shop = await openCounterShop(organisationId, author.userId);
  await applyFinancierWorkflow(organisationId, author.session);
  const { gateway, stop } = await answeringGateway(
    organisationId,
    author.session,
  );
  expect(
    (await setAuthority(organisationId, author.session, "approval", null))
      .status,
  ).toBe(200);
  const opening = await readBoard(organisationId, author.session);
  expect(
    (
      await putLevel(
        organisationId,
        author.session,
        levelOf(productOf(opening).inventoryItemId),
      )
    ).status,
  ).toBe(200);
  await shop.runUntil("first_fall");
  const proposal = await onlyProposal(organisationId, author.session);
  journey.proposalId = proposal.proposalId;
  expect(
    (
      await decide(organisationId, author.session, proposal, {
        decision: "approve",
      })
    ).status,
  ).toBe(200);
  // The run sent its first task, and the gateway accepted it.
  await expect
    .poll(
      async () =>
        (await readRun(organisationId, author.session, proposal.proposalId)).run
          .view?.tasks[0]?.state,
      { timeout: 20_000 },
    )
    .toBe("accepted");

  // 1. The agent reads the run for the person.
  await chatThrough(fixture, author, "READRUN");
  const read = toolValue(journey.outputs.READRUN?.at(-1) ?? "");
  expect(read).toMatchObject({
    state: "running",
    proposalId: proposal.proposalId,
  });

  // 2. A viewer asks the agent for a pause: the Organisation Actor refuses
  //    the viewer's role, and the run goes on.
  //    The viewer's role has no Portal chat, so the chat refuses the
  //    message, and the Bakes page refuses the viewer's own pause.
  const pausesBefore = gateway.received.filter(
    (m) => m.type === "pause",
  ).length;
  const viewerChat = await post(viewer, fixture.paths.chat, {
    kind: "message",
    conversationId: newConversationId(),
    requestId: "request_viewer_pause",
    model: fixture.route.model,
    text: "PAUSERUN now.",
    surfaceContext: null,
    browserContext: { kind: "unavailable" },
  });
  expect(viewerChat.status).toBeGreaterThanOrEqual(403);
  const viewerOutcome: Record<string, unknown> = {
    chat: await viewerChat.json(),
  };
  expect(viewerOutcome.chat).toMatchObject({ ok: false });
  const viewerPause = await runAction(
    organisationId,
    viewer.session,
    proposal.proposalId,
    { action: "pause" },
  );
  expect(viewerPause.status).toBeGreaterThanOrEqual(403);
  viewerOutcome.portal = viewerPause.body;
  expect(journey.outputs.PAUSERUN ?? []).toEqual([]);
  expect(
    (await readRun(organisationId, author.session, proposal.proposalId)).run
      .state,
  ).toBe("running");
  expect(gateway.received.filter((m) => m.type === "pause").length).toBe(
    pausesBefore,
  );

  // 3. The owner asks for a pause: no next task, and each cobot of the run
  //    gets the Devices page's own pause with its receipt.
  await chatThrough(fixture, author, "PAUSERUN");
  const paused = toolValue(journey.outputs.PAUSERUN?.at(-1) ?? "");
  expect(JSON.stringify(paused)).toContain("bakepause_");
  const after = await readRun(
    organisationId,
    author.session,
    proposal.proposalId,
  );
  expect(after.run.state).toBe("paused");
  expect(after.run.dispatches).toHaveLength(1);
  const pauses = gateway.received.filter(
    (m): m is Extract<PlatformGatewayMessage, { type: "pause" }> =>
      m.type === "pause",
  );
  expect(pauses.map((m) => m.sourceKey).sort()).toEqual(["cobot-1", "cobot-2"]);
  for (const name of journey.offered)
    expect(name).not.toMatch(/bake.*(approve|dispatch|settle|resume|stop)/u);
  await stop();
  await writeArtifact("plan-24/bake-run-agent.json", {
    agentRead: read,
    viewerPause: viewerOutcome,
    ownerPause: paused,
    run: after.run,
    pausesSent: pauses,
    offeredTools: [...journey.offered].sort(),
  });
}
