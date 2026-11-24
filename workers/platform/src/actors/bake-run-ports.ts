import {
  createCommerceClient,
  createCommerceEntityPlaneClient,
} from "@purin-labs/area-commerce-contract/server/client";
import { readWorkflowDocument } from "@purin-labs/area-kitchen/server/bakery/workflow-revisions";
import { commerceProviderResourceId } from "@purin-labs/area-commerce-contract/server/resource-ids";
import { createCommerceOutboxReconcileQueueMessage } from "@purin-labs/area-commerce-contract/server/queue-messages";
import { executeStockOperation } from "@purin-labs/area-kitchen-contract/server/stock-action-execution";
import { resolveCurrentOrganisationCommerceMerchantBinding } from "@purin-labs/connections/data/commerce-merchant-binding";
import { runDeviceCommand } from "@purin-labs/area-devices/server/commands";
import { listDevices, listGateways } from "@purin-labs/area-devices/server/store";
import { readKitchenDeviceViews } from "@purin-labs/area-devices/server/views";
import { changeDeviceWork, reserveDeviceWork } from "@purin-labs/area-devices/server/work";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import type { BakeKitchenPorts } from "@purin-labs/area-kitchen/server/bakes/commands";
import type { BakeProposal } from "@purin-labs/area-kitchen/server/bakes/records";
import type { BakeRunDevicePorts, BakeRunNotices } from "@purin-labs/area-kitchen/server/bakes/run";
import type { BakeRunLaunchPorts } from "@purin-labs/area-kitchen/server/bakes/run-start";
import type { BakeRunDevice } from "@purin-labs/area-kitchen/server/bakes/run-store";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  announceBakeRun,
  tellBakeRunOverBake,
} from "@purin-labs/surface-slack/server/bake-run-announce";
import type { BakeRunActor } from "./bake-run";
import { deviceFleetStub } from "@purin-labs/area-devices-contract/server/fleet-stub";

/**
 * The Worker's side of a bake run (Plan 24 S4). Kitchen owns the run and
 * imports no file of the devices area or of Commerce; this file gives it the
 * ports: the Plan 85 readiness, reserve, pause and settle, the device fleet
 * Actor's dispatch ledger, the recipe's oven program, the run's Durable
 * Object and the commerce authority that raises the counter stock.
 */

export function bakeRunStub(
  env: Env,
  scope: OrganisationExecutionScope,
  runId: string,
): DurableObjectStub<BakeRunActor> | null {
  const namespace = env.BAKE_RUN;
  if (namespace === undefined) return null;
  const { placement } = scope;
  const placed =
    placement.kind === "residency"
      ? namespace.jurisdiction(placement.residencyJurisdiction)
      : namespace;
  return placed.get(
    placed.idFromName(`bake_run:${scope.organisationId}:${runId}`),
    { locationHint: placement.locationHint },
  );
}

function fleetOf(
  env: Env,
  scope: OrganisationExecutionScope,
  device: BakeRunDevice,
) {
  const stub = deviceFleetStub(env, scope, device.locationId);
  if (stub === null) throw new Error("The device fleet is not bound.");
  return stub;
}

export function bakeRunDevicePorts(
  env: Env,
  scope: OrganisationExecutionScope,
): BakeRunDevicePorts {
  const command = (
    device: BakeRunDevice,
    kind: "pause" | "resume" | "settle",
    actor: Readonly<{ kind: "person" | "agent"; id: string }>,
  ) =>
    runDeviceCommand({
      env,
      scope,
      subjectId: device.deviceId,
      command: { kind },
      actor,
      idempotencyKey: null,
      now: Date.now(),
    }).then((result) => result.ok);
  return {
    reserve: async (device, input) =>
      (
        await reserveDeviceWork(env, scope, {
          deviceId: device.deviceId,
          ...input,
          now: Date.now(),
        })
      ).ok,
    dispatch: async (device, input) => {
      const result = await fleetOf(env, scope, device).dispatchCobotTask({
        gatewayId: device.gatewayId,
        deviceId: device.deviceId,
        runActorId: input.runActorId,
        message: input.message,
        approval: input.approval,
      });
      if (result.state === "unsent" || result.state === "refused")
        return result.state;
      return result.replayed ? "known" : "sent";
    },
    readClocks: (device) =>
      fleetOf(env, scope, device).readCobotClocks(device.gatewayId),
    watch: (runActorId, devices) =>
      perFleet(env, scope, devices, (fleet, at) =>
        fleet.watchCobotRun(runActorId, at),
      ),
    unwatch: (runActorId, devices) =>
      perFleet(env, scope, devices, (fleet) =>
        fleet.unwatchCobotRun(runActorId),
      ),
    pause: (device, actor) => command(device, "pause", actor),
    resume: (device, actor) => command(device, "resume", actor),
    settle: (device, actor) => command(device, "settle", actor),
    stop: (device, requestId) =>
      fleetOf(env, scope, device).sendToGateway(device.gatewayId, {
        type: "stop",
        requestId: `${requestId}:${device.deviceId}`,
        sourceKey: device.sourceKey,
      }),
    release: async (device, taskRef) => {
      await changeDeviceWork(env, scope, {
        deviceId: device.deviceId,
        taskRef,
        to: "idle",
        now: Date.now(),
      });
    },
  };
}

/** The run's card and its over-bake message in the proposal's thread. */
export function bakeRunNotices(
  env: Env,
  scope: OrganisationExecutionScope,
): BakeRunNotices {
  return {
    card: (record, revision) =>
      announceBakeRun(env, scope, record, revision, Date.now()),
    overBake: (record, risk) =>
      tellBakeRunOverBake(env, scope, record, risk, Date.now()),
  };
}

async function perFleet(
  env: Env,
  scope: OrganisationExecutionScope,
  devices: readonly BakeRunDevice[],
  call: (
    fleet: ReturnType<typeof fleetOf>,
    devices: readonly Readonly<{ gatewayId: string; sourceKey: string }>[],
  ) => Promise<void> | void,
): Promise<void> {
  const byLocation = new Map<string, BakeRunDevice[]>();
  for (const device of devices)
    byLocation.set(device.locationId, [
      ...(byLocation.get(device.locationId) ?? []),
      device,
    ]);
  for (const located of byLocation.values()) {
    const [first] = located;
    if (first === undefined) continue;
    await call(
      fleetOf(env, scope, first),
      located.map(({ gatewayId, sourceKey }) => ({ gatewayId, sourceKey })),
    );
  }
}

/** The devices, the recipe and the run's Durable Object, for a run start. */
function bakeRunLaunchPorts(
  env: Env,
  scope: OrganisationExecutionScope,
): BakeRunLaunchPorts {
  return {
    kitchenDevices: async (location) => {
      const now = Date.now();
      const db = scope.database;
      const [gateways, records, views] = await Promise.all([
        listGateways(db, scope.organisationId),
        listDevices(db, scope.organisationId),
        readKitchenDeviceViews(env, scope, { mayReadFaultText: false, now }),
      ]);
      const located = new Map(
        gateways
          .filter(
            (gateway) =>
              gateway.state === "active" && gateway.locationId === location,
          )
          .map((gateway) => [gateway.gatewayId, gateway.locationId]),
      );
      return records.flatMap((record) => {
        const locationId = located.get(record.gatewayId);
        const view = views.devices.find(
          (device) => device.deviceId === record.deviceId,
        );
        if (
          locationId === undefined ||
          view === undefined ||
          record.enrollment !== "active"
        )
          return [];
        return [
          {
            deviceId: record.deviceId,
            gatewayId: record.gatewayId,
            locationId,
            sourceKey: record.sourceKey,
            name: record.name,
            capabilities: record.capabilities.map(
              (capability) => capability.id,
            ),
            readiness: view.readiness,
          },
        ];
      });
    },
    recipeTimes: (proposal) =>
      recipeTimesOf(env, scope.organisationId, proposal),
    launch: async (start) => {
      const stub = bakeRunStub(env, scope, start.runId);
      if (stub === null)
        return {
          ok: false,
          error: {
            code: "bake_run_missing",
            message: "Bake runs are not available in this deployment.",
          },
        };
      return stub.start({ organisationId: scope.organisationId, start });
    },
  };
}

/**
 * The recipe revision's times: its `bake` step gives the oven program, and
 * its `examine-bake` step, the person's look into the oven before the unload,
 * gives the over-bake grace (S6). Each in whole seconds.
 */
async function recipeTimesOf(
  env: Env,
  organisationId: OrganisationId,
  proposal: BakeProposal,
): Promise<Readonly<{
  bakeSeconds: number;
  unloadGraceSeconds: number | null;
}> | null> {
  const document = await readWorkflowDocument(
    env,
    organisationId,
    proposal.workflowDigest,
  );
  const seconds = (id: string): number | null => {
    for (const workflow of document?.workflows ?? [])
      for (const node of workflow.nodes) {
        if (node.kind !== "step" || node.id !== id) continue;
        const executor = (node.body as { executor?: unknown }).executor;
        if (
          typeof executor === "object" &&
          executor !== null &&
          "kind" in executor &&
          (executor.kind === "declared" || executor.kind === "attended") &&
          "duration" in executor &&
          typeof executor.duration === "number"
        )
          return Math.max(1, Math.round(executor.duration / 1_000_000));
      }
    return null;
  };
  const bakeSeconds = seconds("bake");
  return bakeSeconds === null
    ? null
    : { bakeSeconds, unloadGraceSeconds: seconds("examine-bake") };
}

/**
 * The bake run ports of the Organisation Actor's bake commands: the run
 * start, the run's actions, and the check's raise of the counter stock.
 */
export function bakeRunKitchenPorts(
  env: Env,
  scope: OrganisationExecutionScope,
): Pick<BakeKitchenPorts, "launchRun" | "controlRun" | "raiseCounterStock"> {
  return {
    launchRun: bakeRunLaunchPorts(env, scope),
    controlRun: async (runId, action, actor) => {
      const stub = bakeRunStub(env, scope, runId);
      if (stub === null)
        return {
          ok: false,
          error: {
            code: "bake_run_missing",
            message: "Bake runs are not available in this deployment.",
          },
        };
      return stub.control({ action, actor });
    },
    raiseCounterStock: (proposal, input) =>
      raiseCounterStock(env, scope, proposal, input),
  };
}

/**
 * The check's one stock change: an increase of the counter position by the
 * checked pieces, through the same commerce command as the Stock page's
 * count, under the member who checked. The key makes a repeat one change.
 */
async function raiseCounterStock(
  env: Env,
  scope: OrganisationExecutionScope,
  proposal: BakeProposal,
  input: Readonly<{ pieces: number; key: string; checkedBy: string }>,
): ReturnType<BakeKitchenPorts["raiseCounterStock"]> {
  const unavailable = (message: string) =>
    ({
      ok: false,
      error: { code: "bake_stock_unavailable", message },
    }) as const;
  const organisationId = scope.organisationId;
  const binding = await resolveCurrentOrganisationCommerceMerchantBinding({
    db: scope.database,
    organisationId,
  });
  if (!binding.ok)
    return unavailable("The shop has no commerce connection for its stock.");
  const caller = {
    kind: "organisation",
    organisationId,
    actor: input.checkedBy,
  } as const;
  const admin = createCommerceClient(env, undefined, caller);
  const plane = createCommerceEntityPlaneClient(env, undefined, caller);
  if (admin === null || plane === null)
    return unavailable("Commerce is not configured.");
  const merchantId = binding.value.merchantId;
  const snapshot = await admin.readStockSnapshot(merchantId);
  if (!snapshot.ok) return unavailable("Commerce did not answer. Try again.");
  // The proposal names the Portal's ids; Commerce names its own.
  const itemId = commerceProviderResourceId(
    merchantId,
    proposal.inventoryItemId,
  );
  const locationId =
    proposal.stockLocationId === null
      ? null
      : commerceProviderResourceId(merchantId, proposal.stockLocationId);
  const position = snapshot.value.commerce.resources.inventoryPositions.find(
    (candidate) =>
      candidate.inventoryItemId === itemId &&
      (locationId === null || candidate.locationId === locationId),
  );
  if (position === undefined)
    return unavailable(
      `${proposal.productName} has no counter stock position.`,
    );
  const reason = `Bake ${proposal.proposalId}: ${input.pieces} checked pieces of ${proposal.productName} reached the counter.`;
  const executed = await executeStockOperation({
    admin,
    plane,
    organisationId,
    merchantId,
    actor: input.checkedBy,
    idempotencyKey: input.key,
    nonce: input.key,
    action: {
      kind: "stock_operation",
      reason,
      operation: {
        kind: "count_stock",
        inventoryPositionId: position.id,
        expectedPositionRevision: position.revision,
        itemName: proposal.productName,
        locationName: position.locationId,
        onHandAtProposal: null,
        target: { kind: "aggregate" },
        change: {
          kind: "adjustment",
          direction: "increase",
          quantity: { amount: input.pieces, scale: 0, unit: "each" },
          reason: "correction",
        },
      },
    },
    now: Date.now(),
  });
  if (executed.kind !== "settled")
    return unavailable("Commerce did not take the stock change. Try again.");
  try {
    await env.EVENT_Q.send(
      createCommerceOutboxReconcileQueueMessage({
        requestId: newRequestId(),
        receivedAt: Date.now(),
        organisationId,
        integrationAccountId: binding.value.integrationAccountId,
      }),
      { contentType: "json" },
    );
  } catch {
    // The scheduled reconciliation reads the change later.
  }
  return { ok: true, value: { receiptId: executed.receipt.receiptId } };
}
