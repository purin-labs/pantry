// Plan 24 S6 exit: no move without an approval. Through the real gateway
// relay and the controller simulator, a proposal that is open, one that a
// person rejected and a run that ended dispatch nothing: not from the Bakes
// page, not from a replayed request, not from a viewer and not from a forged
// call to the device fleet Actor. The simulator's `state` counts every move
// that a Platform task started; only the one approved run moves, once for
// each task.
import { expect, it } from "vitest";
import type { CobotTaskMessage } from "@purin-labs/control-api";

import {
  closeCobotKitchen,
  controllerState,
  equipCobotKitchen,
  firstProposal,
  kitchenFleet,
  runAction,
  runActorIdOf,
  runUntil,
  sentTasks,
} from "./bake-run-support";
import {
  decide,
  onlyProposal,
  productOf,
  proposalOf,
  readBoard,
  reconcileFeed,
  writeArtifact,
} from "./bake-support";
import {
  controlBase,
  deviceShop,
  readDeviceList,
  requireKitchenDevice,
  send,
} from "./device-fleet-support";

const HOME = "bake-approval-gate";

function forgedTask(): CobotTaskMessage {
  const hex = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
  return {
    type: "cobot_task",
    requestId: `dsp_${hex}`,
    sourceKey: "cobot-1",
    runId: "forged",
    taskId: "forged-load",
    task: {
      kind: "move_mould_group",
      mouldGroup: 1,
      from: { station: "cold_rack", shelf: 1 },
      to: { station: "oven", shelf: 1 },
    },
  };
}

it(
  "S6 exit: an open, a rejected and an ended proposal dispatch nothing, from the Portal, a replay, a viewer or a forged fleet call; only the approved run moves, once for each task",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const { owner, staff, viewer, organisationId, merchantId } =
      await deviceShop("gate");
    const kitchen = await equipCobotKitchen({
      organisationId,
      owner: owner.session,
      ownerUserId: owner.identity.userId,
      merchantId,
      home: HOME,
      timeScale: 10,
      mode: "approval",
      bakeSeconds: 120,
    });
    const fleet = await kitchenFleet(organisationId);
    const cobot1 = requireKitchenDevice(
      await readDeviceList(organisationId, owner.session),
      "cobot-1",
    );
    const forge = (runActorId: string) =>
      fleet.dispatchCobotTask({
        gatewayId: kitchen.gatewayId,
        deviceId: cobot1.deviceId,
        runActorId,
        message: forgedTask(),
        approval: { by: "forged", role: "owner", via: "portal", at: 0 },
      });
    const moves = async () => (await controllerState(HOME)).submitted.length;
    const refusals: Record<string, unknown> = {};

    // 1. An open proposal: a start is refused, a viewer cannot approve it,
    //    and a forged fleet call for no run sends nothing.
    const open = await firstProposal(kitchen);
    const start = await runAction(
      organisationId,
      staff.session,
      open.proposalId,
      {
        action: "start",
      },
    );
    expect(start.status).toBe(409);
    refusals.openStart = start.body;
    const byViewer = await decide(organisationId, viewer.session, open, {
      decision: "approve",
    });
    expect(byViewer.status).toBeGreaterThanOrEqual(403);
    refusals.viewerApproval = byViewer.body;
    expect((await proposalOf(organisationId, owner.session, open)).state).toBe(
      "open",
    );
    const forgedOpen = await forge("forged-run");
    expect(forgedOpen).toEqual({ state: "refused", replayed: false });

    // 2. A rejected proposal: a start and a replay of the start are refused.
    const rejected = await decide(organisationId, staff.session, open, {
      decision: "reject",
      reason: "The oven is cleaned this morning.",
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const key = crypto.randomUUID();
    const url = `${controlBase(organisationId)}/bakes/proposals/${open.proposalId}/run`;
    const rejectedStart = await send(
      url,
      staff.session,
      "POST",
      { action: "start" },
      key,
    );
    const replayedStart = await send(
      url,
      staff.session,
      "POST",
      { action: "start" },
      key,
    );
    expect(rejectedStart.status).toBe(409);
    expect(replayedStart.status).toBe(409);
    refusals.rejectedStart = rejectedStart.body;
    expect(sentTasks(kitchen.sentToGateway)).toEqual([]);
    expect(await moves()).toBe(0);

    // 3. The stock falls again; an operator approves the new proposal, and
    //    the run bakes with one move for each task.
    await kitchen.shop.runUntil("second_fall");
    const approved = (
      await readBoard(organisationId, owner.session)
    ).proposals.find((item) => item.state === "open");
    if (approved === undefined) throw new Error("No second proposal");
    const approvalKey = crypto.randomUUID();
    const approveUrl = `${controlBase(organisationId)}/bakes/proposals/${approved.proposalId}/decision`;
    const approval = await send(
      approveUrl,
      staff.session,
      "POST",
      { decision: "approve" },
      approvalKey,
    );
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    await runUntil(
      kitchen,
      approved.proposalId,
      (read) => read.run.state === "completed",
    );
    const checked = await runAction(
      organisationId,
      staff.session,
      approved.proposalId,
      { action: "check", goodPieces: 8 },
    );
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    await reconcileFeed();
    expect(
      (await proposalOf(organisationId, owner.session, approved)).state,
    ).toBe("ended");
    const afterRun = sentTasks(kitchen.sentToGateway).length;
    expect(afterRun).toBe(3);
    expect(await moves()).toBe(3);

    // 4. The ended run: a replayed approval, a second approval, a start and
    //    a forged fleet call with the run's own Durable Object send nothing.
    const replayedApproval = await send(
      approveUrl,
      staff.session,
      "POST",
      { decision: "approve" },
      approvalKey,
    );
    expect(replayedApproval.status).toBe(200);
    const secondApproval = await decide(
      organisationId,
      staff.session,
      approved,
      {
        decision: "approve",
      },
    );
    expect(secondApproval.body).toMatchObject({ changed: false });
    const endedStart = await runAction(
      organisationId,
      staff.session,
      approved.proposalId,
      { action: "start" },
    );
    expect(endedStart.status).toBe(200);
    const forgedEnded = await forge(
      await runActorIdOf(organisationId, approved.proposalId),
    );
    expect(forgedEnded).toEqual({ state: "refused", replayed: false });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(sentTasks(kitchen.sentToGateway)).toHaveLength(afterRun);
    const controller = await controllerState(HOME);
    expect(controller.submitted).toHaveLength(3);
    expect(
      productOf(await readBoard(organisationId, owner.session)).counterPieces,
    ).toBe(8 + 3 + 8);
    expect(await onlyOpen(organisationId, owner.session)).toBe(0);
    await closeCobotKitchen(kitchen);
    await writeArtifact("plan-24/bake-approval-gate.json", {
      refusals,
      forged: { open: forgedOpen, ended: forgedEnded },
      replays: {
        approval: replayedApproval.body,
        secondApproval: secondApproval.body,
        endedStart: endedStart.body,
      },
      tasksSent: sentTasks(kitchen.sentToGateway),
      controller: controller.state,
    });
  },
);

async function onlyOpen(
  organisationId: string,
  session: Parameters<typeof onlyProposal>[1],
): Promise<number> {
  return (await readBoard(organisationId, session)).proposals.filter(
    (item) => item.state === "open" || item.state === "approved",
  ).length;
}
