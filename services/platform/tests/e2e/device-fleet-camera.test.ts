import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  parseDeviceSnapshotList,
  type KitchenDeviceView,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { deviceFleetStub } from "../../src/devices/contract/fleet-stub";
import { CAPABILITY_KEYS } from "../../src/authorization/capability-catalogue";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  accessControlPath,
  createGrant,
  enableCapability,
} from "./access-route-support";
import {
  commerceClient,
  commerceHeaders,
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
  requireKitchenDevice,
  send,
  startGateway,
  type SimulatedGateway,
} from "./device-fleet-support";
import { PUBLIC_ORIGIN } from "./hibernatable-socket-support";
import {
  activateSharedAccountNativeTenant,
  attachSharedAccountNativeOrganisation,
} from "./shared-account-platform-fixture";

/**
 * Plan 85 Phase 5, journey J6: camera snapshots. They are off until an admin
 * turns them on, an operator needs a grant, a gateway sends only the image that
 * Pantry asked of its own camera, a fault asks for one, and each image ends after
 * seven days. The simulated gateway speaks the real protocol and only answers.
 */

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

async function shop() {
  const owner = await commerceClient(`camera-owner-${crypto.randomUUID()}`);
  const staff = await commerceClient(`camera-staff-${crypto.randomUUID()}`);
  const viewer = await commerceClient(`camera-viewer-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Camera café");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    `merchant_camera_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  await fixtureDatabase().batch(
    [
      { user: staff, role: "operator", person: "person_camera_staff" },
      { user: viewer, role: "viewer", person: "person_camera_viewer" },
    ].flatMap(({ user, role, person }) => [
      fixtureDatabase()
        .prepare(
          "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
        )
        .bind(organisationId, person, role),
      fixtureDatabase()
        .prepare(
          "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, ?, 'active', ?, NULL)",
        )
        .bind(organisationId, user.identity.userId, person, role, Date.now()),
    ]),
  );
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: { operator: staff, privateMember: viewer },
  });
  await activateSharedAccountNativeTenant(organisationId);
  return { owner, staff, viewer, organisationId };
}

async function operatorRoleSubject(
  organisationId: string,
  session: IssuedControlSession,
): Promise<Readonly<{ subjectRefId: string; revision: number }>> {
  const response = await exports.default.fetch(
    `${accessControlPath(organisationId)}/options?kind=subjects&query=operator`,
    { headers: commerceHeaders(session) },
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const items =
    isRecord(body) &&
    isRecord(body.options) &&
    Array.isArray(body.options.items)
      ? body.options.items
      : [];
  const option: unknown = items.find(
    (item: unknown) =>
      isRecord(item) &&
      typeof item.label === "string" &&
      /operator|staff/iu.test(item.label) &&
      /role/iu.test(item.label),
  );
  if (
    !isRecord(option) ||
    typeof option.refId !== "string" ||
    typeof option.revision !== "number"
  )
    throw new Error("Operator role subject missing");
  return { subjectRefId: option.refId, revision: option.revision };
}

function upload(
  credential: string,
  snapshotId: string,
  body: Uint8Array,
): Promise<Response> {
  return exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/device-gateways/snapshots/${snapshotId}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "image/jpeg",
      },
      body,
    },
  );
}

/** The id of the next image that Pantry asks this gateway for. */
async function nextAsked(
  gateway: SimulatedGateway,
  before: number,
): Promise<Readonly<{ snapshotId: string; sourceKey: string }>> {
  await expect
    .poll(() =>
      gateway.received.slice(before).some((item) => item.type === "snapshot"),
    )
    .toBe(true);
  const message = gateway.received
    .slice(before)
    .find((item) => item.type === "snapshot");
  if (message?.type !== "snapshot") throw new Error("No snapshot message");
  return {
    snapshotId: message.requestId.split(":")[0] ?? "",
    sourceKey: message.sourceKey,
  };
}

async function confirmed(
  organisationId: string,
  session: IssuedControlSession,
  name: string,
): Promise<KitchenDeviceView> {
  const device = requireKitchenDevice(
    await readDeviceList(organisationId, session),
    name,
  );
  const result = await send(
    `${controlBase(organisationId)}/devices/${device.deviceId}/confirm`,
    session,
    "POST",
    { name, stationId: "station_bakery" },
  );
  expect(result.status).toBe(200);
  return requireKitchenDevice(
    await readDeviceList(organisationId, session),
    name,
  );
}

it(
  "J6: a camera sends an image only when an admin has turned snapshots on and a person with access asks or a fault asks, and the image ends after seven days",
  { timeout: 240_000 },
  async (): Promise<void> => {
    const { owner, staff, viewer, organisationId } = await shop();
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
    await helloAndWait(gateway, [
      found("camera-1", "Bench camera", { kind: "camera", capabilities: [] }),
      found("cobot-1", "Tray cobot"),
    ]);
    const camera = await confirmed(
      organisationId,
      owner.session,
      "Bench camera",
    );
    const cobot = await confirmed(organisationId, owner.session, "Tray cobot");
    expect(camera.readiness).toEqual({ kind: "not_applicable" });
    const ask = `${base}/devices/${camera.deviceId}/snapshot`;
    const list = `${base}/devices/${camera.deviceId}/snapshots`;
    const policy = `${base}/devices/camera-policy`;

    // 1. Snapshots start off. Nothing reaches the gateway, and a fault asks for
    //    nothing.
    expect(
      (await readDeviceList(organisationId, owner.session)).snapshotsEnabled,
    ).toBe(false);
    const off = await send(ask, owner.session, "POST", {});
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({ error: "device_snapshots_off" });
    gateway.send({
      type: "health",
      reports: [
        {
          sourceKey: "cobot-1",
          health: "fault",
          faultCode: "E1",
          faultText: "Stuck",
        },
      ],
    });
    await expect
      .poll(
        async () =>
          requireKitchenDevice(
            await readDeviceList(organisationId, owner.session),
            "Tray cobot",
          ).health,
      )
      .toBe("fault");
    gateway.send({
      type: "health",
      reports: [
        {
          sourceKey: "cobot-1",
          health: "ok",
          faultCode: null,
          faultText: null,
        },
      ],
    });
    await expect
      .poll(
        async () =>
          requireKitchenDevice(
            await readDeviceList(organisationId, owner.session),
            "Tray cobot",
          ).health,
      )
      .toBe("ok");
    expect(gateway.received.some((item) => item.type === "snapshot")).toBe(
      false,
    );

    // 2. Only an admin or an owner turns them on.
    for (const member of [viewer, staff])
      expect(
        (await send(policy, member.session, "PUT", { enabled: true })).status,
      ).toBeGreaterThanOrEqual(403);
    expect(
      (await send(policy, owner.session, "PUT", { enabled: true })).status,
    ).toBe(200);
    expect(
      (await readDeviceList(organisationId, viewer.session)).snapshotsEnabled,
    ).toBe(true);

    // 3. A viewer has no access, and an operator needs a grant.
    expect(
      (await send(ask, viewer.session, "POST", {})).status,
    ).toBeGreaterThanOrEqual(403);
    expect(
      (await send(list, viewer.session, "GET")).status,
    ).toBeGreaterThanOrEqual(403);
    const noGrant = await send(ask, staff.session, "POST", {});
    expect(noGrant.status).toBe(403);
    expect(noGrant.body).toMatchObject({
      error: "device_camera_access_needed",
    });
    expect((await send(list, staff.session, "GET")).status).toBe(403);

    // 4. The owner asks. The gateway receives one request for this camera, and
    //    the list stays empty until an image arrives.
    let before = gateway.received.length;
    const asked = await send(ask, owner.session, "POST", {});
    expect(asked.status).toBe(202);
    const request = await nextAsked(gateway, before);
    expect(request.sourceKey).toBe("camera-1");
    const empty = parseDeviceSnapshotList(
      (await send(list, owner.session, "GET")).body,
    );
    expect(empty?.snapshots).toEqual([]);

    // 5. Another gateway cannot answer. Only a real JPEG of a sane size enters.
    const other = await startGateway(
      organisationId,
      owner.session,
      "Bar gateway",
    );
    const otherCredential = await credentialOf(
      await enrollGateway(organisationId, other.gatewayId, other.code),
    );
    expect(
      (await upload(otherCredential, request.snapshotId, JPEG)).status,
    ).toBe(404);
    expect((await upload("sgw1.bad", request.snapshotId, JPEG)).status).toBe(
      401,
    );
    expect(
      (await upload(credential, request.snapshotId, new Uint8Array([1, 2, 3])))
        .status,
    ).toBe(415);
    const huge = new Uint8Array(1024 * 1024 + 1);
    huge.set(JPEG);
    expect((await upload(credential, request.snapshotId, huge)).status).toBe(
      413,
    );
    expect(
      (
        await env.ARCHIVE.list({
          prefix: `device-snapshots/${organisationId}/`,
        })
      ).objects,
    ).toEqual([]);

    // 6. The right image is stored, reads back the same and stays out of caches.
    //    A second upload of the same request is refused.
    expect((await upload(credential, request.snapshotId, JPEG)).status).toBe(
      200,
    );
    expect((await upload(credential, request.snapshotId, JPEG)).status).toBe(
      404,
    );
    const stored = parseDeviceSnapshotList(
      (await send(list, owner.session, "GET")).body,
    );
    expect(stored?.snapshots).toHaveLength(1);
    expect(stored?.snapshots[0]).toMatchObject({
      snapshotId: request.snapshotId,
      reason: "request",
    });
    const image = await exports.default.fetch(
      `${base}/devices/snapshots/${request.snapshotId}`,
      { headers: commerceHeaders(owner.session) },
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(image.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(JPEG);
    const viewerImage = await exports.default.fetch(
      `${base}/devices/snapshots/${request.snapshotId}`,
      { headers: commerceHeaders(viewer.session) },
    );
    expect(viewerImage.status).toBeGreaterThanOrEqual(403);

    // 7. With a grant, an operator reads the image and asks for another.
    await enableCapability(
      organisationId,
      owner.session,
      CAPABILITY_KEYS.deviceCameraRead,
    );
    await createGrant(organisationId, owner.session, {
      subjectRef: await operatorRoleSubject(organisationId, owner.session),
      target: {
        kind: "platform",
        capabilityRef: {
          capabilityId: CAPABILITY_KEYS.deviceCameraRead,
          capabilityVersion: 1,
        },
      },
    });
    const granted = await send(list, staff.session, "GET");
    expect(granted.status).toBe(200);
    expect(parseDeviceSnapshotList(granted.body)?.snapshots).toHaveLength(1);
    before = gateway.received.length;
    expect((await send(ask, staff.session, "POST", {})).status).toBe(202);
    await nextAsked(gateway, before);

    // 7b. An admin ends that access by turning the capability off.
    await enableCapability(
      organisationId,
      owner.session,
      CAPABILITY_KEYS.deviceCameraRead,
      "disabled",
    );
    expect((await send(list, staff.session, "GET")).status).toBe(403);
    await enableCapability(
      organisationId,
      owner.session,
      CAPABILITY_KEYS.deviceCameraRead,
      "enabled",
    );
    expect((await send(list, staff.session, "GET")).status).toBe(200);

    // 8. A fault at the camera's station asks for one image, with the reason.
    before = gateway.received.length;
    gateway.send({
      type: "health",
      reports: [
        {
          sourceKey: "cobot-1",
          health: "fault",
          faultCode: "E2",
          faultText: "Stuck",
        },
      ],
    });
    const faulted = await nextAsked(gateway, before);
    expect(faulted.sourceKey).toBe("camera-1");
    expect((await upload(credential, faulted.snapshotId, JPEG)).status).toBe(
      200,
    );
    const both = parseDeviceSnapshotList(
      (await send(list, owner.session, "GET")).body,
    );
    expect(both?.snapshots.map((item) => item.reason).sort()).toEqual([
      "fault",
      "request",
    ]);
    const activity = await send(
      `${base}/devices/${camera.deviceId}/activity`,
      owner.session,
      "GET",
    );
    expect(JSON.stringify(activity.body)).toContain("snapshot");
    expect(cobot.stationId).toBe(camera.stationId);

    // 9. An image past its seven days leaves the list, the store and the rows.
    const scope = await requireOrganisationExecutionScope(env, organisationId);
    const stub = deviceFleetStub(env, scope, "Main shop");
    if (stub === null) throw new Error("No fleet Actor");
    await fixtureDatabase()
      .prepare(
        "UPDATE device_snapshot SET expires_at = ? WHERE snapshot_id = ?",
      )
      .bind(Date.now() - 1, request.snapshotId)
      .run();
    const gone = parseDeviceSnapshotList(
      (await send(list, owner.session, "GET")).body,
    );
    expect(gone?.snapshots.map((item) => item.reason)).toEqual(["fault"]);
    const expiredImage = await exports.default.fetch(
      `${base}/devices/snapshots/${request.snapshotId}`,
      { headers: commerceHeaders(owner.session) },
    );
    expect(expiredImage.status).toBe(404);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE fleet_upkeep SET pruned_at = 0");
    });
    await runDurableObjectAlarm(stub);
    await expect
      .poll(async () =>
        fixtureDatabase()
          .prepare(
            "SELECT COUNT(*) AS count FROM device_snapshot WHERE snapshot_id = ?",
          )
          .bind(request.snapshotId)
          .first<number>("count"),
      )
      .toBe(0);
    expect(
      await env.ARCHIVE.head(
        `device-snapshots/${organisationId}/${request.snapshotId}.jpg`,
      ),
    ).toBeNull();
    expect(
      await env.ARCHIVE.head(
        `device-snapshots/${organisationId}/${faulted.snapshotId}.jpg`,
      ),
    ).not.toBeNull();

    // 10. Off again refuses a new image and an image that was on its way.
    before = gateway.received.length;
    expect((await send(ask, owner.session, "POST", {})).status).toBe(202);
    const late = await nextAsked(gateway, before);
    expect(
      (await send(policy, owner.session, "PUT", { enabled: false })).status,
    ).toBe(200);
    expect((await send(ask, owner.session, "POST", {})).status).toBe(409);
    expect((await upload(credential, late.snapshotId, JPEG)).status).toBe(404);
    gateway.close();
  },
);
