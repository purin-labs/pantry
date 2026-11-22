import { runInDurableObject } from "cloudflare:test";
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { isRecord } from "@purin-labs/std";

import { deviceFleetStub } from "../../src/devices/contract/fleet-stub";
import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import {
  archiveOrganisation,
  deleteArchivedOrganisation,
} from "@purin-labs/tenancy/data/organisation-lifecycle";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  connectGateway,
  controlBase,
  credentialOf,
  enrollGateway,
  found,
  gatewaySocketResponse,
  helloAndWait,
  readDeviceList,
  requireKitchenDevice,
  send,
  startGateway,
} from "./device-fleet-support";
import { PUBLIC_ORIGIN } from "./hibernatable-socket-support";
import { installMemoryFixture } from "./memory-support";

/**
 * Plan 85: an Organisation ends. Its gateway's credential stops at archive, and
 * the purge leaves no device row and no sample in the fleet Actor.
 */
it(
  "stops a gateway when its Organisation is archived, and the purge erases its records",
  { timeout: 180_000 },
  async (): Promise<void> => {
    const fixture = await installMemoryFixture();
    const owner = fixture.author;
    const organisationId = owner.organisationId;
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
      found("cobot-1", "Tray cobot"),
      found("camera-1", "Bench camera", { kind: "camera", capabilities: [] }),
    ]);
    // A camera image, which the purge must delete from the store.
    const base = controlBase(organisationId);
    const camera = requireKitchenDevice(
      await readDeviceList(organisationId, owner.session),
      "Bench camera",
    );
    await send(
      `${base}/devices/${camera.deviceId}/confirm`,
      owner.session,
      "POST",
      {
        name: "Bench camera",
        stationId: "station_bakery",
      },
    );
    await send(`${base}/devices/camera-policy`, owner.session, "PUT", {
      enabled: true,
    });
    const asked = await send(
      `${base}/devices/${camera.deviceId}/snapshot`,
      owner.session,
      "POST",
      {},
    );
    if (!isRecord(asked.body) || typeof asked.body.snapshotId !== "string")
      throw new Error("No snapshot request");
    const stored = await exports.default.fetch(
      `${PUBLIC_ORIGIN}/v1/device-gateways/snapshots/${asked.body.snapshotId}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${credential}` },
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]),
      },
    );
    expect(stored.status).toBe(200);
    const images = async () =>
      (
        await env.ARCHIVE.list({
          prefix: `device-snapshots/${organisationId}/`,
        })
      ).objects.length;
    expect(await images()).toBe(1);
    gateway.send({
      type: "samples",
      samples: [{ sourceKey: "cobot-1", name: "load", value: 12, unit: "%" }],
    });
    const scope = await requireOrganisationExecutionScope(env, organisationId);
    const stub = deviceFleetStub(env, scope, "Main shop");
    if (stub === null) throw new Error("No fleet Actor");
    const samples = () =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ tables: number }>(
            "SELECT COUNT(*) AS tables FROM sqlite_master WHERE name = 'device_sample'",
          )
          .one().tables === 0
          ? 0
          : state.storage.sql
              .exec<{ count: number }>(
                "SELECT COUNT(*) AS count FROM device_sample",
              )
              .one().count,
      );
    await expect.poll(samples).toBe(1);
    const rows = async () => {
      const counts = await Promise.all(
        [
          "device_gateway",
          "device_enrollment",
          "device_event",
          "device_snapshot",
          "device_camera_policy",
        ].map((table) =>
          fixtureDatabase()
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE organisation_id = ?`,
            )
            .bind(organisationId)
            .first<number>("count"),
        ),
      );
      return counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
    };
    expect(await rows()).toBeGreaterThanOrEqual(3);

    const mutation = async (operation: "archive" | "delete") => {
      const version = await fixtureDatabase()
        .prepare(
          "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
        )
        .bind(organisationId)
        .first<number>("configuration_version");
      if (version === null) throw new Error("Missing configuration version");
      return {
        boundary: {
          kind: "configuration_versioned" as const,
          idempotencyKey: `device-end-${operation}`,
          requestHash: `device-end-${operation}-request`,
          expectedConfigurationVersion: version,
        },
        scope: {
          userId: owner.userId,
          organisationScope: organisationId,
          route: `/v1/control/organisations/${organisationId}${operation === "archive" ? "/archive" : ""}`,
          operation: `organisation.${operation}`,
        },
        identity: newControlMutationIdentity({
          portalSubjectHash: "device-end-owner",
          causationId: `device-end-${operation}`,
          now: Date.now(),
        }),
      };
    };

    // 1. The archive stops the credential.
    const archived = await archiveOrganisation({
      identityDatabase: env.DB,
      execution: await requireOrganisationExecutionScope(env, organisationId),
      actorUserId: owner.userId,
      authority: { kind: "organisation_owner" },
      reasonCode: "merchant_archived",
      now: Date.now(),
      mutation: await mutation("archive"),
    });
    if (!archived.ok) throw new Error(archived.error.code);
    await runScheduledOnboardingReconciliation(env, Date.now());
    expect((await gatewaySocketResponse(credential)).status).toBe(401);

    // 2. The purge erases each row, the samples and the open socket.
    const deleted = await deleteArchivedOrganisation({
      directory: env.DB,
      execution: await requireOrganisationExecutionScope(env, organisationId),
      actorUserId: owner.userId,
      now: Date.now(),
      mutation: await mutation("delete"),
    });
    if (!deleted.ok) throw new Error(deleted.error.code);
    await runScheduledOnboardingReconciliation(env, Date.now() + 1_000);
    expect(await rows()).toBe(0);
    expect(await samples()).toBe(0);
    expect(await images()).toBe(0);
    expect(await gateway.closed).toBe(4403);
  },
);
