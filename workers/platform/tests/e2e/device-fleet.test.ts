import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  parseDeviceActivity,
  type DeviceAlertSetting,
} from "@purin-labs/control-api";

import { deviceFleetStub } from "@purin-labs/area-devices/server/contract/fleet-stub";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  connectGateway,
  controlBase,
  credentialOf,
  deviceShop,
  enrollGateway,
  found,
  gatewaySocketResponse,
  helloAndWait,
  readDeviceList,
  requireGatewayRow,
  requireKitchenDevice,
  send,
  startGateway,
} from "./device-fleet-support";
import { network } from "./network";
import {
  ORGANISATION_ID,
  installSlackActorFixture,
} from "./slack-journey-support";
import { sideCaseSlack } from "./slack-side-case-support";
import { runAlarmHandler } from "./durable-object-alarm-support";

/**
 * Plan 85, journeys J2, J3 and J4, with a simulated gateway that speaks the real
 * protocol over the real socket route. The fake Slack only records and answers.
 */
it(
  "J2: enrolls a gateway with a one-time code, and a found device waits for a person",
  { timeout: 180_000 },
  enrollmentJourney,
);
it(
  "J3: samples and a fault reach the page, and a silent gateway makes one Slack card only during shop hours",
  { timeout: 180_000 },
  faultJourney,
);
it(
  "J4: revoking a gateway closes its socket and refuses its credential",
  { timeout: 180_000 },
  revokeJourney,
);

async function enrollmentJourney(): Promise<void> {
  const { owner, staff, viewer, organisationId } = await deviceShop("fleet");
  const base = controlBase(organisationId);

  // 1. Only an admin or an owner starts an enrollment.
  const refused = await send(
    `${base}/devices/gateways`,
    staff.session,
    "POST",
    {
      name: "Bakery gateway",
      locationId: "Main shop",
    },
  );
  expect(refused.status).toBeGreaterThanOrEqual(403);
  const first = await startGateway(
    organisationId,
    owner.session,
    "Bakery gateway",
  );
  expect(first.command).toContain(first.code);

  // 2. A wrong code and an expired code are refused. The right code works one
  //    time.
  expect(
    (await enrollGateway(organisationId, first.gatewayId, "x".repeat(43)))
      .status,
  ).toBe(401);
  const expired = await startGateway(
    organisationId,
    owner.session,
    "Old gateway",
  );
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  await scope.database
    .prepare(
      "UPDATE device_gateway SET code_expires_at = ? WHERE gateway_id = ?",
    )
    .bind(Date.now() - 1_000, expired.gatewayId)
    .run();
  expect(
    (await enrollGateway(organisationId, expired.gatewayId, expired.code))
      .status,
  ).toBe(401);
  const credential = await credentialOf(
    await enrollGateway(organisationId, first.gatewayId, first.code),
  );
  expect(
    (await enrollGateway(organisationId, first.gatewayId, first.code)).status,
  ).toBe(401);
  expect(credential.startsWith(`sgw1.${organisationId}.`)).toBe(true);

  // 3. A socket needs the true credential.
  expect((await gatewaySocketResponse(`${credential}x`)).status).toBe(401);
  const gateway = await connectGateway(credential);

  // 4. What the gateway finds stays pending.
  await helloAndWait(gateway, [
    found("cobot-1", "Tray cobot"),
    found("oven-1", "Oven", { kind: "appliance" }),
  ]);
  const listed = await readDeviceList(organisationId, viewer.session);
  expect(requireGatewayRow(listed, first.gatewayId)).toMatchObject({
    enrollment: "active",
    serviceVersion: "0.1.0",
    deviceCount: 2,
    needsAttention: false,
    connection: { state: "connected" },
  });
  const cobot = requireKitchenDevice(listed, "Tray cobot");
  expect(cobot).toMatchObject({
    enrollment: "pending",
    needsAttention: true,
    readiness: { kind: "blocked", reason: "pending" },
  });

  // 5. A viewer and an operator cannot confirm. The owner confirms, and the
  //    same request again gives the same receipt.
  const confirm = `${base}/devices/${cobot.deviceId}/confirm`;
  const body = { name: "Tray cobot", stationId: "station_bakery" };
  for (const member of [viewer, staff])
    expect(
      (await send(confirm, member.session, "POST", body)).status,
    ).toBeGreaterThanOrEqual(403);
  const key = crypto.randomUUID();
  const confirmed = await send(confirm, owner.session, "POST", body, key);
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  const replay = await send(confirm, owner.session, "POST", body, key);
  expect(replay.body).toMatchObject({
    replayed: true,
    receiptId: (confirmed.body as { receiptId: string }).receiptId,
  });
  expect(
    requireKitchenDevice(
      await readDeviceList(organisationId, owner.session),
      "Tray cobot",
    ),
  ).toMatchObject({
    enrollment: "active",
    stationId: "station_bakery",
    needsAttention: false,
    readiness: { kind: "ready" },
  });

  // 6. A second gateway cannot report on the first gateway's device.
  const second = await startGateway(
    organisationId,
    owner.session,
    "Bar gateway",
  );
  const secondCredential = await credentialOf(
    await enrollGateway(organisationId, second.gatewayId, second.code),
  );
  const intruder = await connectGateway(secondCredential);
  await helloAndWait(intruder, []);
  intruder.send({
    type: "health",
    reports: [
      {
        sourceKey: "cobot-1",
        health: "fault",
        faultCode: "E1",
        faultText: "false report",
      },
    ],
  });
  await expect
    .poll(() => intruder.received.map((message) => message.type))
    .toContain("refused");
  expect(
    requireKitchenDevice(
      await readDeviceList(organisationId, owner.session),
      "Tray cobot",
    ).health,
  ).toBe("not_reported");

  // 7. The same hello adds nothing. New capabilities start a new revision.
  await helloAndWait(gateway, [
    found("cobot-1", "Other name", {
      capabilities: [{ id: "move_tray", label: "Move a tray", revision: 2 }],
    }),
    found("oven-1", "Oven", { kind: "appliance" }),
  ]);
  const after = await readDeviceList(organisationId, owner.session);
  expect(requireKitchenDevice(after, "Tray cobot")).toMatchObject({
    revision: 2,
    enrollment: "active",
  });
  expect(
    after.devices.filter((device) => device.kind === "kitchen_device"),
  ).toHaveLength(2);

  // 8. An operator restricts. Only an admin lifts it. Rename stays open to
  //    the operator, and a move is not.
  const device = `${base}/devices/${cobot.deviceId}`;
  expect(
    (
      await send(`${device}/restrict`, staff.session, "POST", {
        reason: "Guard check",
      })
    ).status,
  ).toBe(200);
  expect(
    requireKitchenDevice(
      await readDeviceList(organisationId, owner.session),
      "Tray cobot",
    ),
  ).toMatchObject({
    restrictReason: "Guard check",
    readiness: { kind: "blocked", reason: "restricted" },
  });
  expect(
    (await send(`${device}/lift`, staff.session, "POST", {})).status,
  ).toBeGreaterThanOrEqual(403);
  expect((await send(`${device}/lift`, owner.session, "POST", {})).status).toBe(
    200,
  );
  expect(
    (
      await send(`${device}/move`, staff.session, "POST", {
        stationId: "station_bar",
      })
    ).status,
  ).toBeGreaterThanOrEqual(403);

  // 9. A pause reaches the gateway, and its answer goes on the record.
  const paused = await send(`${device}/pause`, staff.session, "POST", {});
  expect(paused.status).toBe(200);
  await expect
    .poll(() => gateway.received.find((message) => message.type === "pause"))
    .toMatchObject({ sourceKey: "cobot-1" });
  const pause = gateway.received.find((message) => message.type === "pause");
  if (pause?.type !== "pause") throw new Error("No pause");
  gateway.send({ type: "ack", requestId: pause.requestId, outcome: "done" });
  const activity = `${device}/activity`;
  await expect
    .poll(async () =>
      parseDeviceActivity(
        (await send(activity, staff.session, "GET")).body,
      )?.events.map((event) => event.kind),
    )
    .toContain("gateway_done");
  expect(
    requireKitchenDevice(
      await readDeviceList(organisationId, viewer.session),
      "Tray cobot",
    ).readiness,
  ).toEqual({ kind: "blocked", reason: "paused" });
  expect(
    (await send(activity, viewer.session, "GET")).status,
  ).toBeGreaterThanOrEqual(403);
  expect(
    (await send(`${device}/resume`, staff.session, "POST", {})).status,
  ).toBe(200);

  // 10. A message that the protocol does not hold ends the connection.
  gateway.raw(JSON.stringify({ type: "shell", command: "ls" }));
  expect(await gateway.closed).toBe(1008);
  await intruder.close();
}

async function faultJourney(): Promise<void> {
  const fixture = await installSlackActorFixture();
  const slack = sideCaseSlack();
  network.use(...slack.handlers);
  const organisationId = ORGANISATION_ID;
  const session = fixture.ownerSession;
  const base = controlBase(organisationId);
  const scope = await requireOrganisationExecutionScope(env, organisationId);

  const bakery = await startGateway(organisationId, session, "Bakery gateway");
  const credential = await credentialOf(
    await enrollGateway(organisationId, bakery.gatewayId, bakery.code),
  );
  const gateway = await connectGateway(credential);
  const devices = [
    found("cobot-1", "Tray cobot"),
    found("door-1", "Door servo", { kind: "servo" }),
  ];
  await helloAndWait(gateway, devices);
  const pending = await readDeviceList(organisationId, session);
  for (const name of ["Tray cobot", "Door servo"]) {
    const confirmed = await send(
      `${base}/devices/${requireKitchenDevice(pending, name).deviceId}/confirm`,
      session,
      "POST",
      { name, stationId: "station_bakery" },
    );
    expect(confirmed.status).toBe(200);
  }
  const cobotId = requireKitchenDevice(pending, "Tray cobot").deviceId;

  // 1. A samples report keeps one value a minute, for this gateway's devices.
  gateway.send({
    type: "samples",
    samples: [
      { sourceKey: "cobot-1", name: "load", value: 12, unit: "%" },
      { sourceKey: "cobot-1", name: "load", value: 41, unit: "%" },
    ],
  });
  const activity = `${base}/devices/${cobotId}/activity`;
  await expect
    .poll(async () => {
      const read = parseDeviceActivity(
        (await send(activity, session, "GET")).body,
      );
      return read?.samples.map((sample) => sample.value);
    })
    .toEqual([41]);

  // 2. A device fault with no task reaches only the page.
  gateway.send({
    type: "health",
    reports: [
      {
        sourceKey: "door-1",
        health: "fault",
        faultCode: "E02",
        faultText: null,
      },
    ],
  });
  await expect
    .poll(
      async () =>
        requireKitchenDevice(
          await readDeviceList(organisationId, session),
          "Door servo",
        ).needsAttention,
    )
    .toBe(true);
  expect(slack.posts()).toHaveLength(0);

  // 3. A gateway with no task goes silent outside shop hours: the page shows
  //    it, and Slack stays quiet. Inside shop hours, one card goes out after
  //    the delay.
  const bar = await startGateway(organisationId, session, "Bar gateway");
  const barGateway = await connectGateway(
    await credentialOf(
      await enrollGateway(organisationId, bar.gatewayId, bar.code),
    ),
  );
  await helloAndWait(barGateway, []);
  await barGateway.close();
  const stub = deviceFleetStub(env, scope, "Main shop");
  if (stub === null) throw new Error("No fleet Actor");
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE gateway_presence SET last_heard_at = ? WHERE gateway_id = ?",
      Date.now() - 10 * 60_000,
      bar.gatewayId,
    );
  });
  const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const closed: DeviceAlertSetting = {
    timeZone: "UTC",
    opensAtMinute: (minute + 60) % 1440,
    closesAtMinute: (minute + 120) % 1440,
    offlineDelayMinutes: 5,
  };
  expect(
    (await send(`${base}/devices/alert-settings`, session, "PUT", closed))
      .status,
  ).toBe(200);
  await runAlarmHandler(stub);
  await expect
    .poll(async () =>
      requireGatewayRow(
        await readDeviceList(organisationId, session),
        bar.gatewayId,
      ),
    )
    .toMatchObject({ needsAttention: true, connection: { state: "offline" } });
  expect(slack.posts()).toHaveLength(0);
  const open: DeviceAlertSetting = {
    ...closed,
    opensAtMinute: minute,
    closesAtMinute: (minute + 120) % 1440,
  };
  await send(`${base}/devices/alert-settings`, session, "PUT", open);
  await runInDurableObject(stub, () => undefined);
  await runAlarmHandler(stub);
  await expect
    .poll(() => slack.posts().map((post) => post.text), { timeout: 20_000 })
    .toHaveLength(1);
  expect(slack.posts()[0]?.text).toContain("Bar gateway");
  await gateway.close();
}

async function revokeJourney(): Promise<void> {
  const { owner, staff, viewer, organisationId } = await deviceShop("fleet");
  const base = controlBase(organisationId);
  const started = await startGateway(
    organisationId,
    owner.session,
    "Bakery gateway",
  );
  const credential = await credentialOf(
    await enrollGateway(organisationId, started.gatewayId, started.code),
  );
  const gateway = await connectGateway(credential);
  await helloAndWait(gateway, [found("cobot-1", "Tray cobot")]);
  const cobot = requireKitchenDevice(
    await readDeviceList(organisationId, owner.session),
    "Tray cobot",
  );
  await send(
    `${base}/devices/${cobot.deviceId}/confirm`,
    owner.session,
    "POST",
    {
      name: "Tray cobot",
      stationId: "station_bakery",
    },
  );

  // 1. An operator and a viewer cannot revoke.
  const revoke = `${base}/devices/${started.gatewayId}/revoke`;
  for (const member of [staff, viewer])
    expect(
      (await send(revoke, member.session, "POST", {})).status,
    ).toBeGreaterThanOrEqual(403);
  expect(gateway.socket.readyState).toBe(WebSocket.OPEN);

  // 2. The owner revokes. The socket closes within 5 s, and the credential is
  //    refused.
  const at = Date.now();
  const revoked = await send(revoke, owner.session, "POST", {});
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  expect(await gateway.closed).toBe(4403);
  expect(Date.now() - at).toBeLessThan(5_000);
  expect((await gatewaySocketResponse(credential)).status).toBe(401);

  // 3. The page shows the gateway and its device as revoked.
  const after = await readDeviceList(organisationId, owner.session);
  expect(requireGatewayRow(after, started.gatewayId)).toMatchObject({
    enrollment: "revoked",
    needsAttention: false,
    connection: { state: "closed" },
  });
  expect(requireKitchenDevice(after, "Tray cobot")).toMatchObject({
    enrollment: "revoked",
    readiness: { kind: "blocked", reason: "revoked" },
  });
}
