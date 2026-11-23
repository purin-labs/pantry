import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  parseDeviceActivity,
  type KitchenDeviceView,
} from "@purin-labs/control-api";

import { ensureCreatedOrganisationActor } from "@purin-labs/agent/control/organisation-runtime";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import {
  commerceClient,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import {
  connectGateway,
  controlBase,
  credentialOf,
  enrollGateway,
  found,
  helloAndWait,
  readDeviceList,
  requireGatewayRow,
  requireKitchenDevice,
  send,
  startGateway,
  type SimulatedGateway,
} from "./device-fleet-support";
import { activateOrganisation } from "./organisation-fixture";

/**
 * Refactor 15, refactor 6: the pauses that Pantry sends to a shop gateway.
 * The simulated gateway speaks the real protocol and only answers. A pause is
 * confirmed only by the gateway's `done` answer to that pause, and a pause
 * sent while the gateway is away reaches it when it connects again.
 */
it(
  "a refused snapshot of a paused camera leaves the pause unconfirmed, and the pause's own answer confirms it",
  { timeout: 180_000 },
  refusedSnapshotJourney,
);
it(
  "a pause sent while the gateway is offline reaches it when it connects again",
  { timeout: 180_000 },
  offlinePauseJourney,
);

async function shop(): Promise<
  Readonly<{ owner: IssuedControlSession; organisationId: string }>
> {
  const owner = await commerceClient(`command-owner-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Command café");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    `merchant_command_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  await activateOrganisation(organisationId);
  return { owner: owner.session, organisationId };
}

async function enrolled(
  organisationId: string,
  owner: IssuedControlSession,
): Promise<Readonly<{ gatewayId: string; credential: string }>> {
  const started = await startGateway(organisationId, owner, "Bakery gateway");
  const credential = await credentialOf(
    await enrollGateway(organisationId, started.gatewayId, started.code),
  );
  return { gatewayId: started.gatewayId, credential };
}

async function confirmDevice(
  organisationId: string,
  owner: IssuedControlSession,
  name: string,
): Promise<KitchenDeviceView> {
  const device = requireKitchenDevice(
    await readDeviceList(organisationId, owner),
    name,
  );
  const result = await send(
    `${controlBase(organisationId)}/devices/${device.deviceId}/confirm`,
    owner,
    "POST",
    { name, stationId: "station_bakery" },
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return device;
}

async function deviceView(
  organisationId: string,
  owner: IssuedControlSession,
  name: string,
): Promise<KitchenDeviceView> {
  return requireKitchenDevice(
    await readDeviceList(organisationId, owner),
    name,
  );
}

async function nextMessage<Type extends "pause" | "snapshot">(
  gateway: SimulatedGateway,
  before: number,
  type: Type,
): Promise<Readonly<{ requestId: string; sourceKey: string }>> {
  await expect
    .poll(() =>
      gateway.received.slice(before).some((message) => message.type === type),
    )
    .toBe(true);
  const message = gateway.received
    .slice(before)
    .find((item) => item.type === type);
  if (
    message === undefined ||
    !("requestId" in message) ||
    !("sourceKey" in message)
  )
    throw new Error(`No ${type}`);
  return { requestId: message.requestId, sourceKey: message.sourceKey };
}

async function activityKinds(
  organisationId: string,
  owner: IssuedControlSession,
  deviceId: string,
): Promise<readonly string[]> {
  const response = await send(
    `${controlBase(organisationId)}/devices/${deviceId}/activity`,
    owner,
    "GET",
  );
  return (
    parseDeviceActivity(response.body)?.events.map((event) => event.kind) ?? []
  );
}

async function refusedSnapshotJourney(): Promise<void> {
  const { owner, organisationId } = await shop();
  const base = controlBase(organisationId);
  const { credential } = await enrolled(organisationId, owner);
  const gateway = await connectGateway(credential);
  await helloAndWait(gateway, [
    found("camera-1", "Bench camera", { kind: "camera", capabilities: [] }),
  ]);
  const camera = await confirmDevice(organisationId, owner, "Bench camera");
  expect(
    (
      await send(`${base}/devices/camera-policy`, owner, "PUT", {
        enabled: true,
      })
    ).status,
  ).toBe(200);

  // 1. A person pauses the camera. The gateway has not answered yet.
  let before = gateway.received.length;
  const paused = await send(
    `${base}/devices/${camera.deviceId}/pause`,
    owner,
    "POST",
    {},
  );
  expect(paused.status, JSON.stringify(paused.body)).toBe(200);
  const pause = await nextMessage(gateway, before, "pause");
  expect(pause.sourceKey).toBe("camera-1");

  // 2. The person asks for an image, and the gateway refuses that request.
  before = gateway.received.length;
  const asked = await send(
    `${base}/devices/${camera.deviceId}/snapshot`,
    owner,
    "POST",
    {},
  );
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  const snapshot = await nextMessage(gateway, before, "snapshot");
  gateway.send({
    type: "ack",
    requestId: snapshot.requestId,
    outcome: "refused",
  });
  await expect
    .poll(() => activityKinds(organisationId, owner, camera.deviceId))
    .toContain("gateway_refused");

  // 3. The refused image does not confirm the pause.
  expect(await deviceView(organisationId, owner, "Bench camera")).toMatchObject(
    { paused: true, pauseConfirmed: false },
  );

  // 4. The gateway's own answer to the pause confirms it.
  gateway.send({ type: "ack", requestId: pause.requestId, outcome: "done" });
  await expect
    .poll(
      async () =>
        (await deviceView(organisationId, owner, "Bench camera"))
          .pauseConfirmed,
    )
    .toBe(true);
  await gateway.close();
}

async function offlinePauseJourney(): Promise<void> {
  const { owner, organisationId } = await shop();
  const base = controlBase(organisationId);
  const { gatewayId, credential } = await enrolled(organisationId, owner);
  const devices = [found("cobot-1", "Tray cobot")];
  const first = await connectGateway(credential);
  await helloAndWait(first, devices);
  const cobot = await confirmDevice(organisationId, owner, "Tray cobot");

  // 1. The gateway goes away. Pantry sees no open socket.
  await first.close();
  await expect
    .poll(
      async () =>
        requireGatewayRow(
          await readDeviceList(organisationId, owner),
          gatewayId,
        ).connection.state,
    )
    .not.toBe("connected");

  // 2. A person pauses the cobot while the gateway is away. The pause waits
  //    for the gateway.
  const paused = await send(
    `${base}/devices/${cobot.deviceId}/pause`,
    owner,
    "POST",
    {},
  );
  expect(paused.status, JSON.stringify(paused.body)).toBe(200);
  expect(await deviceView(organisationId, owner, "Tray cobot")).toMatchObject({
    paused: true,
    pauseConfirmed: false,
  });

  // 3. The gateway connects again. Its hello brings the pause, and its answer
  //    confirms it.
  const second = await connectGateway(credential);
  await helloAndWait(second, devices);
  const pause = await nextMessage(second, 0, "pause");
  expect(pause.sourceKey).toBe("cobot-1");
  second.send({ type: "ack", requestId: pause.requestId, outcome: "done" });
  await expect
    .poll(
      async () =>
        (await deviceView(organisationId, owner, "Tray cobot")).pauseConfirmed,
    )
    .toBe(true);

  // 4. A later hello does not send the answered pause again.
  await helloAndWait(second, devices);
  expect(
    second.received.filter((message) => message.type === "pause"),
  ).toHaveLength(1);
  await second.close();
}
