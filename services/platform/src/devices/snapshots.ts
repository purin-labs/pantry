import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { deviceFleetStub } from "./contract/fleet-stub";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  eventStatement,
  listDevices,
  listGateways,
  readGateway,
  type DeviceActorRef,
  type DeviceRecord,
} from "./store";

/**
 * Camera snapshots (Plan 85 Phase 5, D5). They are off for each Organisation
 * until an admin turns them on, because a picture of staff is personal data.
 * A camera sends one still image on a fault or when a person asks. Pantry holds
 * no live video and no recording, and it deletes each image after seven days.
 * The image stays in the Portal: it never reaches a model.
 */

const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A gateway has this long to send the image that Pantry asked for. */
const SNAPSHOT_UPLOAD_WINDOW_MS = 2 * 60_000;
export const SNAPSHOT_BYTE_LIMIT = 1024 * 1024;

type DeviceSnapshot = Readonly<{
  snapshotId: string;
  deviceId: string;
  reason: "fault" | "request";
  state: "pending" | "stored";
  objectKey: string;
  createdAt: number;
  storedAt: number | null;
  expiresAt: number;
}>;

type SnapshotRow = Readonly<{
  snapshot_id: string;
  device_id: string;
  reason: DeviceSnapshot["reason"];
  state: DeviceSnapshot["state"];
  object_key: string;
  created_at: number;
  stored_at: number | null;
  expires_at: number;
}>;

const COLUMNS = `snapshot_id, device_id, reason, state, object_key, created_at,
  stored_at, expires_at`;

function fromRow(row: SnapshotRow): DeviceSnapshot {
  return {
    snapshotId: row.snapshot_id,
    deviceId: row.device_id,
    reason: row.reason,
    state: row.state,
    objectKey: row.object_key,
    createdAt: row.created_at,
    storedAt: row.stored_at,
    expiresAt: row.expires_at,
  };
}

export async function snapshotsAreEnabled(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT enabled FROM device_camera_policy WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ enabled: number }>();
  return row?.enabled === 1;
}

export async function setSnapshotsEnabled(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    enabled: boolean;
    actor: DeviceActorRef;
    now: number;
  }>,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO device_camera_policy (
           organisation_id, enabled, changed_by, changed_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT (organisation_id) DO UPDATE SET
           enabled = excluded.enabled,
           changed_by = excluded.changed_by,
           changed_at = excluded.changed_at`,
      )
      .bind(
        input.organisationId,
        input.enabled ? 1 : 0,
        input.actor.id,
        input.now,
      ),
    eventStatement(db, {
      organisationId: input.organisationId,
      subjectId: "camera_policy",
      kind: input.enabled ? "snapshots_on" : "snapshots_off",
      actor: input.actor,
      detail: {},
      idempotencyKey: null,
      now: input.now,
    }),
  ]);
}

type SnapshotRequestResult =
  | Readonly<{ ok: true; snapshotId: string }>
  | Readonly<{
      ok: false;
      code: "device_snapshots_off" | "device_not_camera" | "gateway_offline";
    }>;

type SendToGateway = (
  gatewayId: string,
  message: Readonly<{
    type: "snapshot";
    requestId: string;
    sourceKey: string;
  }>,
) => Promise<boolean> | boolean;

/** Asks one camera for one still image. Each request goes on the record. */
async function requestSnapshot(
  scope: OrganisationExecutionScope,
  input: Readonly<{
    device: DeviceRecord;
    reason: DeviceSnapshot["reason"];
    actor: DeviceActorRef;
    now: number;
    send: SendToGateway;
  }>,
): Promise<SnapshotRequestResult> {
  const db = scope.database;
  const organisationId = scope.organisationId;
  if (!(await snapshotsAreEnabled(db, organisationId)))
    return { ok: false, code: "device_snapshots_off" };
  const { device, now } = input;
  if (device.hardware !== "camera" || device.enrollment !== "active")
    return { ok: false, code: "device_not_camera" };
  const snapshotId = `dsn_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO device_snapshot (
           snapshot_id, organisation_id, device_id, reason, requested_by, state,
           object_key, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        snapshotId,
        organisationId,
        device.deviceId,
        input.reason,
        input.actor.id,
        `device-snapshots/${organisationId}/${snapshotId}.jpg`,
        now,
        now + SNAPSHOT_RETENTION_MS,
      ),
    eventStatement(db, {
      organisationId,
      subjectId: device.deviceId,
      kind: "snapshot_requested",
      actor: input.actor,
      detail: { reason: input.reason },
      idempotencyKey: null,
      now,
    }),
  ]);
  const sent = await input.send(device.gatewayId, {
    type: "snapshot",
    requestId: `${snapshotId}:${device.deviceId}`,
    sourceKey: device.sourceKey,
  });
  if (sent) return { ok: true, snapshotId };
  await db
    .prepare("DELETE FROM device_snapshot WHERE snapshot_id = ?")
    .bind(snapshotId)
    .run();
  return { ok: false, code: "gateway_offline" };
}

export async function requestSnapshotFromPage(
  env: Env,
  scope: OrganisationExecutionScope,
  input: Readonly<{ device: DeviceRecord; actor: DeviceActorRef; now: number }>,
): Promise<SnapshotRequestResult> {
  const gateway = await readGateway(
    scope.database,
    scope.organisationId,
    input.device.gatewayId,
  );
  const stub =
    gateway === null ? null : deviceFleetStub(env, scope, gateway.locationId);
  return requestSnapshot(scope, {
    ...input,
    reason: "request",
    send: async (gatewayId, message) =>
      stub === null
        ? false
        : await stub.sendToGateway(gatewayId, message).catch(() => false),
  });
}

/**
 * A fault at a station asks the cameras that this Actor's gateways hold at the
 * same station for one still image each, so that a person can look at once.
 */
export async function requestFaultSnapshots(
  scope: OrganisationExecutionScope,
  input: Readonly<{
    device: DeviceRecord;
    locationId: string;
    now: number;
    send: SendToGateway;
  }>,
): Promise<void> {
  const { device, now } = input;
  if (device.hardware === "camera" || device.stationId === null) return;
  const db = scope.database;
  if (!(await snapshotsAreEnabled(db, scope.organisationId))) return;
  const [devices, gateways] = await Promise.all([
    listDevices(db, scope.organisationId),
    listGateways(db, scope.organisationId),
  ]);
  const here = new Set(
    gateways
      .filter((gateway) => gateway.locationId === input.locationId)
      .map((gateway) => gateway.gatewayId),
  );
  for (const camera of devices)
    if (
      camera.hardware === "camera" &&
      camera.stationId === device.stationId &&
      here.has(camera.gatewayId)
    )
      await requestSnapshot(scope, {
        device: camera,
        reason: "fault",
        actor: { kind: "platform", id: null },
        now,
        send: input.send,
      });
}

export async function readPendingSnapshot(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  snapshotId: string,
  now: number,
): Promise<DeviceSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM device_snapshot
        WHERE snapshot_id = ? AND organisation_id = ? AND state = 'pending'
          AND created_at > ?`,
    )
    .bind(snapshotId, organisationId, now - SNAPSHOT_UPLOAD_WINDOW_MS)
    .first<SnapshotRow>();
  return row === null ? null : fromRow(row);
}

export async function recordStoredSnapshot(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  snapshot: DeviceSnapshot,
  bytes: number,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE device_snapshot
            SET state = 'stored', stored_at = ?, content_bytes = ?
          WHERE snapshot_id = ? AND organisation_id = ?`,
      )
      .bind(now, bytes, snapshot.snapshotId, organisationId),
    eventStatement(db, {
      organisationId,
      subjectId: snapshot.deviceId,
      kind: "snapshot_stored",
      actor: { kind: "gateway", id: null },
      detail: { reason: snapshot.reason },
      idempotencyKey: null,
      now,
    }),
  ]);
}

/** The images of one device that have not reached their end, newest first. */
export async function listStoredSnapshots(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  deviceId: string | null,
  now: number,
): Promise<readonly DeviceSnapshot[]> {
  const rows = await db
    .prepare(
      `SELECT ${COLUMNS} FROM device_snapshot
        WHERE organisation_id = ? AND state = 'stored' AND expires_at > ?
          AND device_id = coalesce(?, device_id)
        ORDER BY stored_at DESC LIMIT 30`,
    )
    .bind(organisationId, now, deviceId)
    .all<SnapshotRow>();
  return rows.results.map(fromRow);
}

export async function readStoredSnapshot(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  snapshotId: string,
  now: number,
): Promise<DeviceSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM device_snapshot
        WHERE snapshot_id = ? AND organisation_id = ? AND state = 'stored'
          AND expires_at > ?`,
    )
    .bind(snapshotId, organisationId, now)
    .first<SnapshotRow>();
  return row === null ? null : fromRow(row);
}

/** Deletes each image past its end, and each request that no image answered. */
export async function pruneDeviceSnapshots(
  env: Pick<Env, "ARCHIVE">,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  now: number,
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT ${COLUMNS} FROM device_snapshot
        WHERE organisation_id = ?
          AND (expires_at <= ? OR (state = 'pending' AND created_at <= ?))
        LIMIT 500`,
    )
    .bind(organisationId, now, now - SNAPSHOT_UPLOAD_WINDOW_MS)
    .all<SnapshotRow>();
  if (rows.results.length === 0) return;
  await env.ARCHIVE.delete(rows.results.map((row) => row.object_key));
  await db.batch(
    rows.results.map((row) =>
      db
        .prepare("DELETE FROM device_snapshot WHERE snapshot_id = ?")
        .bind(row.snapshot_id),
    ),
  );
}

/** Each image of an Organisation that ends. Its D1 rows go in the same purge. */
export async function eraseOrganisationSnapshots(
  env: Pick<Env, "ARCHIVE">,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<void> {
  for (;;) {
    const rows = await db
      .prepare(
        "SELECT snapshot_id, object_key FROM device_snapshot WHERE organisation_id = ? LIMIT 500",
      )
      .bind(organisationId)
      .all<{ snapshot_id: string; object_key: string }>();
    if (rows.results.length === 0) return;
    await env.ARCHIVE.delete(rows.results.map((row) => row.object_key));
    await db.batch(
      rows.results.map((row) =>
        db
          .prepare("DELETE FROM device_snapshot WHERE snapshot_id = ?")
          .bind(row.snapshot_id),
      ),
    );
  }
}
