// Plan 24 S5: shadow mode. A kitchen starts in shadow mode, so an approved
// bake starts a run that only watches. The controller simulator runs the bake
// from its own script on both cobots and the oven, as a person at the teach
// pendant would, behind the real gateway relay. The run matches each observed
// move to its planned task with the difference of the times; a move outside
// the plan stays unmatched. Pantry sends the gateway no task, pause or stop,
// and the counter stock does not change. The simulator and the relay decide
// every move and every time; the asserted outcomes come from product code.
import { expect, it } from "vitest";
import {
  parseDeviceActivity,
  type CobotStation,
  type CobotTask,
} from "@purin-labs/control-api";

import {
  DEVICES,
  KITCHEN,
  closeCobotKitchen,
  controllerState,
  equipCobotKitchen,
  firstProposal,
  readRun,
  runAction,
  runUntil,
  setAuthority,
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

const HOME = "bake-shadow";
const TIME_SCALE = 60;
const BAKE_SECONDS = 900;

function move(group: number, from: CobotStation, to: CobotStation): CobotTask {
  return {
    kind: "move_mould_group",
    mouldGroup: group,
    from: { station: from, shelf: group },
    to: { station: to, shelf: group },
  };
}

it(
  "S5: a shadow run watches a bake that the controller runs from its own script, matches each move to its planned task with the time difference, shows a move outside the plan as unmatched, sends the cobots nothing and changes no stock",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const { owner, staff, viewer, organisationId, merchantId } =
      await deviceShop("shadow");
    const kitchen = await equipCobotKitchen({
      organisationId,
      owner: owner.session,
      ownerUserId: owner.identity.userId,
      merchantId,
      home: HOME,
      timeScale: TIME_SCALE,
      mode: "shadow",
      bakeSeconds: BAKE_SECONDS,
    });

    // 1. The kitchen is in shadow mode until an admin changes it. An
    //    operator and a viewer cannot change it.
    const board = await readBoard(organisationId, owner.session);
    expect(board.authority).toEqual([
      {
        kitchenLocation: KITCHEN,
        mode: "shadow",
        revision: null,
        setBy: null,
        setAt: null,
      },
    ]);
    const byOperator = await setAuthority(
      organisationId,
      staff.session,
      "approval",
      null,
    );
    const byViewer = await setAuthority(
      organisationId,
      viewer.session,
      "approval",
      null,
    );
    // The account authority refuses a member without the admin role.
    expect(byOperator.status).toBeGreaterThanOrEqual(403);
    expect(byViewer.status).toBeGreaterThanOrEqual(403);
    expect(
      (await readBoard(organisationId, owner.session)).authority[0]?.mode,
    ).toBe("shadow");

    // 2. The counter falls below its level; an operator approves the
    //    proposal. The approval starts a shadow run, which sends nothing.
    const proposal = await firstProposal(kitchen);
    const stockBefore = productOf(
      await readBoard(organisationId, owner.session),
    ).counterPieces;
    const approved = await decide(organisationId, staff.session, proposal, {
      decision: "approve",
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const started = await readRun(
      organisationId,
      owner.session,
      proposal.proposalId,
    );
    expect(started.run).toMatchObject({
      mode: "shadow",
      state: "running",
      dispatches: [],
    });
    const planned = started.run.view?.tasks ?? [];
    expect(
      planned.map((task) => [task.key, task.sourceKey, task.state]),
    ).toEqual([
      ["load-1", "cobot-1", "planned"],
      ["bake", "oven-1", "planned"],
      ["unload-1", "cobot-2", "planned"],
    ]);
    // A shadow run cannot pause the cobots: Pantry sends them nothing.
    const pause = await runAction(
      organisationId,
      staff.session,
      proposal.proposalId,
      { action: "pause" },
    );
    expect(pause.status).toBe(409);
    expect(pause.body).toMatchObject({ error: "bake_run_refused" });

    // 3. A person at the teach pendant runs the bake from the controller's
    //    script: cobot-2 first makes a move that the plan does not have,
    //    then cobot-1 loads group 1, the oven bakes and cobot-2 unloads.
    const scripts = [
      {
        device: "cobot-2",
        moves: [
          {
            moveId: "pendant-extra",
            task: move(2, "cold_rack", "oven"),
            afterMs: 0,
          },
          {
            moveId: "pendant-unload-1",
            task: move(1, "oven", "cooling_rack"),
            afterMs: 1_000_000,
          },
        ],
      },
      {
        device: "cobot-1",
        moves: [
          {
            moveId: "pendant-load-1",
            task: move(1, "cold_rack", "oven"),
            afterMs: 45_000,
          },
        ],
      },
      {
        device: "oven-1",
        moves: [
          {
            moveId: "pendant-bake",
            task: {
              kind: "bake",
              programSeconds: BAKE_SECONDS,
              temperatureC: 180,
            },
            afterMs: 90_000,
          },
        ],
      },
    ];
    for (const script of scripts)
      expect(
        await controllerControl(HOME, { op: "script", ...script }),
      ).toMatchObject({ ok: true, scheduled: script.moves.length });
    const done = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.state === "completed",
      180_000,
    );

    // 4. Each observed move matches its planned task, on the planned cobot,
    //    with the difference of the times. The move outside the plan has no
    //    match.
    const shadow = done.run.shadow;
    if (shadow === null) throw new Error("The run has no shadow record");
    expect(shadow.unobserved).toEqual([]);
    const byMove = new Map(
      shadow.matches.map((match) => [match.observationId, match]),
    );
    expect(byMove.get("pendant-extra")).toMatchObject({
      sourceKey: "cobot-2",
      state: "completed",
      planned: null,
      sameCobot: null,
      difference: { startSeconds: null, endSeconds: null },
    });
    for (const [moveId, key, sourceKey] of [
      ["pendant-load-1", "load-1", "cobot-1"],
      ["pendant-bake", "bake", "oven-1"],
      ["pendant-unload-1", "unload-1", "cobot-2"],
    ] as const) {
      const match = byMove.get(moveId);
      if (match === undefined || match.planned === null)
        throw new Error(`No match for ${moveId}`);
      expect(match).toMatchObject({
        sourceKey,
        state: "completed",
        sameCobot: true,
        planned: { key, sourceKey },
      });
      const { startSeconds, endSeconds } = match.observed;
      if (startSeconds === null || endSeconds === null)
        throw new Error(`${moveId} has no times`);
      expect(match.difference.startSeconds).toBeCloseTo(
        startSeconds - match.planned.startSeconds,
        2,
      );
      expect(match.difference.endSeconds).toBeCloseTo(
        endSeconds - match.planned.endSeconds,
        2,
      );
      // The canvas and the timeline show the same observed times.
      const task = done.run.view?.tasks.find((item) => item.key === key);
      expect(task).toMatchObject({
        state: "completed",
        observed: { startSeconds, endSeconds },
      });
    }
    // The script ran later than the plan, so each start differs from it.
    expect(
      byMove.get("pendant-load-1")?.difference.startSeconds,
    ).toBeGreaterThan(0);
    expect(done.run.view?.groups).toEqual([
      {
        mouldGroup: 1,
        basis: "observed",
        position: {
          kind: "place",
          place: { station: "cooling_rack", shelf: 1 },
        },
      },
    ]);

    // 5. Zero commands: the Platform sent the gateway no task, pause, resume,
    //    stop or inquiry, and the controller started no move that a Platform
    //    task asked for.
    const toGateway = kitchen.sentToGateway.map((message) => message.type);
    for (const kind of [
      "cobot_task",
      "cobot_inquire",
      "pause",
      "resume",
      "stop",
    ])
      expect(toGateway).not.toContain(kind);
    const controller = await controllerState(HOME);
    expect(controller.submitted).toEqual([]);
    for (const sourceKey of DEVICES) {
      const operations = controller.device(sourceKey).operations;
      expect(operations.submit ?? 0).toBe(0);
      expect(operations.pause ?? 0).toBe(0);
      expect(operations.stop ?? 0).toBe(0);
    }
    expect(controller.tasks.filter((task) => task.scripted)).toHaveLength(4);

    // 6. Zero stock changes: the counter stock stayed, the proposal ended
    //    with the shadow run, and a check of the pieces is refused.
    expect(
      productOf(await readBoard(organisationId, owner.session)).counterPieces,
    ).toBe(stockBefore);
    const ended = await proposalOf(organisationId, owner.session, proposal);
    expect(ended.state).toBe("ended");
    expect(ended.endReason).toContain("Pantry sent nothing");
    const check = await runAction(
      organisationId,
      staff.session,
      proposal.proposalId,
      { action: "check", goodPieces: 8 },
    );
    expect(check.status).toBe(409);
    expect(check.body).toMatchObject({ error: "bake_run_shadow" });
    expect(
      productOf(await readBoard(organisationId, owner.session)).counterPieces,
    ).toBe(stockBefore);
    // The Devices page reserved no device for the run.
    const devices = await readDeviceList(organisationId, owner.session);
    const activity = parseDeviceActivity(
      (
        await send(
          `${controlBase(organisationId)}/devices/${requireKitchenDevice(devices, "cobot-1").deviceId}/activity`,
          owner.session,
          "GET",
        )
      ).body,
    );
    expect(activity?.events.map((event) => event.kind) ?? []).not.toContain(
      "task_reserved",
    );
    for (const sourceKey of DEVICES)
      expect(requireKitchenDevice(devices, sourceKey).work).toEqual({
        state: "idle",
      });

    await closeCobotKitchen(kitchen);
    await writeArtifact("plan-24/bake-shadow-journey.json", {
      authority: board.authority,
      refusedAuthority: { operator: byOperator.body, viewer: byViewer.body },
      planned,
      scripts,
      run: done.run,
      proposal: ended,
      messagesToGateway: toGateway,
      controller: controller.state,
      stock: { before: stockBefore, after: stockBefore },
      refusedPause: pause.body,
      refusedCheck: check.body,
    });
  },
);
