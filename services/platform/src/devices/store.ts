import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";
import {
  DEVICE_GATEWAY_CODE_TTL_MS,
  type DeviceAlertSetting,
  type DeviceCapability,
  type DeviceHardwareKind,
  type DeviceHealth,
  type DeviceHealthReport,
  type DeviceStationId,
  type FoundDevice,
} from "@seams/control-api";
import { encodeBase64Url, sha256Hex } from "@seams/std";

import type { OrganisationId } from "../ids";
import type { DeviceEnrollmentState, DeviceWorkState } from "./readiness";

/**
 * The records of shop gateways and the devices behind them (Plan 85). A found
 * device stays pending until a person confirms it. Each text that a gateway
 * sends is untrusted: it enters through this store with its control characters
 * removed, and it stays data everywhere after that.
 */

export type DeviceActorRef = Readonly<{
  kind: "person" | "agent" | "gateway" | "platform";
  id: string | null;
}>;

export type GatewayRecord = Readonly<{
  gatewayId: string;
  locationId: string;
  name: string;
  state: "pending" | "active" | "revoked";
  serviceVersion: string | null;
  lastHeardAt: number | null;
  createdAt: number;
  revokedAt: number | null;
}>;

export type DeviceRecord = Readonly<{
  deviceId: string;
  gatewayId: string;
  sourceKey: string;
  name: string;
  hardware: DeviceHardwareKind;
  model: string;
  serial: string | null;
  firmwareVersion: string | null;
  stationId: DeviceStationId | null;
  capabilities: readonly DeviceCapability[];
  revision: number;
  enrollment: DeviceEnrollmentState;
  restrictReason: string | null;
  revokedAt: number | null;
  health: DeviceHealth;
  faultCode: string | null;
  faultText: string | null;
  paused: boolean;
  /** The gateway answered the device's current pause with `done`. */
  pauseConfirmed: boolean;
  work: DeviceWorkState;
}>;

type GatewayRow = Readonly<{
  gateway_id: string;
  location_id: string;
  name: string;
  state: GatewayRecord["state"];
  service_version: string | null;
  last_heard_at: number | null;
  created_at: number;
  revoked_at: number | null;
}>;

type DeviceRow = Readonly<{
  device_id: string;
  gateway_id: string;
  source_key: string;
  name: string;
  device_kind: DeviceHardwareKind;
  model: string;
  serial: string | null;
  firmware_version: string | null;
  station_id: DeviceStationId | null;
  capabilities_json: string;
  revision: number;
  state: DeviceEnrollmentState;
  restrict_reason: string | null;
  revoked_at: number | null;
  health: DeviceHealth;
  fault_code: string | null;
  fault_text: string | null;
  paused_at: number | null;
  pause_acknowledged_at: number | null;
  work_state: DeviceWorkState["state"];
  work_task_ref: string | null;
  work_run_ref: string | null;
  work_label: string | null;
}>;

const GATEWAY_COLUMNS = `gateway_id, location_id, name, state, service_version,
  last_heard_at, created_at, revoked_at`;
const DEVICE_COLUMNS = `device_id, gateway_id, source_key, name, device_kind,
  model, serial, firmware_version, station_id, capabilities_json, revision,
  state, restrict_reason, revoked_at, health, fault_code, fault_text, paused_at,
  pause_acknowledged_at, work_state, work_task_ref, work_run_ref, work_label`;

function gatewayFromRow(row: GatewayRow): GatewayRecord {
  return {
    gatewayId: row.gateway_id,
    locationId: row.location_id,
    name: row.name,
    state: row.state,
    serviceVersion: row.service_version,
    lastHeardAt: row.last_heard_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function deviceFromRow(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.device_id,
    gatewayId: row.gateway_id,
    sourceKey: row.source_key,
    name: row.name,
    hardware: row.device_kind,
    model: row.model,
    serial: row.serial,
    firmwareVersion: row.firmware_version,
    stationId: row.station_id,
    capabilities: JSON.parse(row.capabilities_json) as DeviceCapability[],
    revision: row.revision,
    enrollment: row.state,
    restrictReason: row.restrict_reason,
    revokedAt: row.revoked_at,
    health: row.health,
    faultCode: row.fault_code,
    faultText: row.fault_text,
    paused: row.paused_at !== null,
    pauseConfirmed:
      row.paused_at !== null && row.pause_acknowledged_at !== null,
    work:
      row.work_state === "idle" || row.work_task_ref === null
        ? { state: "idle" }
        : {
            state: row.work_state,
            taskRef: row.work_task_ref,
            runRef: row.work_run_ref,
            label: row.work_label ?? row.work_task_ref,
          },
  };
}

/** Removes control characters and the marks of a Slack or Markdown link. */
export function cleanGatewayText(value: string): string {
  return value
    .replaceAll(/\p{Cc}/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function randomSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function randomHex(length: number): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, length);
}

export async function startGatewayEnrollment(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    locationId: string;
    name: string;
    userId: string;
    now: number;
  }>,
): Promise<Readonly<{ gatewayId: string; code: string; expiresAt: number }>> {
  const gatewayId = `dgw_${randomHex(24)}`;
  const code = randomSecret();
  const expiresAt = input.now + DEVICE_GATEWAY_CODE_TTL_MS;
  await db.batch([
    db
      .prepare(
        `INSERT INTO device_gateway (
           gateway_id, organisation_id, location_id, name, state, code_sha256,
           code_expires_at, created_by_user_id, created_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .bind(
        gatewayId,
        input.organisationId,
        input.locationId,
        input.name,
        await sha256Hex(code),
        expiresAt,
        input.userId,
        input.now,
      ),
    eventStatement(db, {
      organisationId: input.organisationId,
      subjectId: gatewayId,
      kind: "gateway_enrollment_started",
      actor: { kind: "person", id: input.userId },
      detail: { locationId: input.locationId },
      idempotencyKey: null,
      now: input.now,
    }),
  ]);
  return { gatewayId, code, expiresAt };
}

/** The code works one time. It returns the credential's secret. */
export async function completeGatewayEnrollment(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    gatewayId: string;
    code: string;
    now: number;
  }>,
): Promise<string | null> {
  const secret = randomSecret();
  const row = await db
    .prepare(
      `UPDATE device_gateway
          SET state = 'active', credential_sha256 = ?, enrolled_at = ?,
              code_sha256 = NULL, code_expires_at = NULL
        WHERE gateway_id = ? AND organisation_id = ? AND state = 'pending'
          AND code_sha256 = ? AND code_expires_at > ?
        RETURNING gateway_id`,
    )
    .bind(
      await sha256Hex(secret),
      input.now,
      input.gatewayId,
      input.organisationId,
      await sha256Hex(input.code),
      input.now,
    )
    .first<{ gateway_id: string }>();
  if (row === null) return null;
  await recordDeviceEvent(db, {
    organisationId: input.organisationId,
    subjectId: input.gatewayId,
    kind: "gateway_enrolled",
    actor: { kind: "gateway", id: input.gatewayId },
    detail: {},
    idempotencyKey: null,
    now: input.now,
  });
  return secret;
}

export async function readGatewayByCredential(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    gatewayId: string;
    secret: string;
  }>,
): Promise<GatewayRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${GATEWAY_COLUMNS} FROM device_gateway
        WHERE gateway_id = ? AND organisation_id = ? AND state = 'active'
          AND credential_sha256 = ?`,
    )
    .bind(input.gatewayId, input.organisationId, await sha256Hex(input.secret))
    .first<GatewayRow>();
  return row === null ? null : gatewayFromRow(row);
}

export async function readGateway(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  gatewayId: string,
): Promise<GatewayRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${GATEWAY_COLUMNS} FROM device_gateway
        WHERE gateway_id = ? AND organisation_id = ?`,
    )
    .bind(gatewayId, organisationId)
    .first<GatewayRow>();
  return row === null ? null : gatewayFromRow(row);
}

export async function listGateways(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly GatewayRecord[]> {
  const rows = await db
    .prepare(
      `SELECT ${GATEWAY_COLUMNS} FROM device_gateway
        WHERE organisation_id = ? ORDER BY created_at, gateway_id`,
    )
    .bind(organisationId)
    .all<GatewayRow>();
  return rows.results.map(gatewayFromRow);
}

export async function listDevices(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly DeviceRecord[]> {
  const rows = await db
    .prepare(
      `SELECT ${DEVICE_COLUMNS} FROM device_enrollment
        WHERE organisation_id = ? ORDER BY created_at, device_id`,
    )
    .bind(organisationId)
    .all<DeviceRow>();
  return rows.results.map(deviceFromRow);
}

export async function listGatewayDevices(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  gatewayId: string,
): Promise<readonly DeviceRecord[]> {
  const rows = await db
    .prepare(
      `SELECT ${DEVICE_COLUMNS} FROM device_enrollment
        WHERE organisation_id = ? AND gateway_id = ?
        ORDER BY created_at, device_id`,
    )
    .bind(organisationId, gatewayId)
    .all<DeviceRow>();
  return rows.results.map(deviceFromRow);
}

export async function readDevice(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  deviceId: string,
): Promise<DeviceRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${DEVICE_COLUMNS} FROM device_enrollment
        WHERE device_id = ? AND organisation_id = ?`,
    )
    .bind(deviceId, organisationId)
    .first<DeviceRow>();
  return row === null ? null : deviceFromRow(row);
}

/**
 * Records what a gateway found. A new device stays pending, and a change of
 * capabilities on a known device starts a new revision.
 */
export async function applyGatewayHello(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    gatewayId: string;
    serviceVersion: string;
    devices: readonly FoundDevice[];
    now: number;
  }>,
): Promise<void> {
  const known = await listGatewayDevices(
    db,
    input.organisationId,
    input.gatewayId,
  );
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE device_gateway SET service_version = ?, last_heard_at = ?
          WHERE gateway_id = ? AND organisation_id = ?`,
      )
      .bind(
        cleanGatewayText(input.serviceVersion),
        input.now,
        input.gatewayId,
        input.organisationId,
      ),
  ];
  for (const found of input.devices) {
    const capabilities = JSON.stringify(
      found.capabilities.map((capability) => ({
        id: cleanGatewayText(capability.id),
        label: cleanGatewayText(capability.label),
        revision: capability.revision,
      })),
    );
    const model = cleanGatewayText(found.model);
    const serial =
      found.serial === null ? null : cleanGatewayText(found.serial);
    const firmware =
      found.firmwareVersion === null
        ? null
        : cleanGatewayText(found.firmwareVersion);
    const existing = known.find(
      (device) => device.sourceKey === found.sourceKey,
    );
    if (existing === undefined) {
      const deviceId = `dev_${randomHex(24)}`;
      statements.push(
        db
          .prepare(
            `INSERT INTO device_enrollment (
               device_id, organisation_id, gateway_id, source_key, name,
               device_kind, model, serial, firmware_version, capabilities_json,
               revision, state, health, work_state, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending',
                       'not_reported', 'idle', ?)`,
          )
          .bind(
            deviceId,
            input.organisationId,
            input.gatewayId,
            found.sourceKey,
            cleanGatewayText(found.suggestedName),
            found.kind,
            model,
            serial,
            firmware,
            capabilities,
            input.now,
          ),
        eventStatement(db, {
          organisationId: input.organisationId,
          subjectId: deviceId,
          kind: "device_found",
          actor: { kind: "gateway", id: input.gatewayId },
          detail: {},
          idempotencyKey: null,
          now: input.now,
        }),
      );
      continue;
    }
    if (existing.enrollment === "revoked") continue;
    const changed = JSON.stringify(existing.capabilities) !== capabilities;
    statements.push(
      db
        .prepare(
          `UPDATE device_enrollment
              SET model = ?, serial = ?, firmware_version = ?,
                  capabilities_json = ?, revision = revision + ?
            WHERE device_id = ? AND organisation_id = ?`,
        )
        .bind(
          model,
          serial,
          firmware,
          capabilities,
          changed ? 1 : 0,
          existing.deviceId,
          input.organisationId,
        ),
    );
    if (changed)
      statements.push(
        eventStatement(db, {
          organisationId: input.organisationId,
          subjectId: existing.deviceId,
          kind: "capabilities_changed",
          actor: { kind: "gateway", id: input.gatewayId },
          detail: {},
          idempotencyKey: null,
          now: input.now,
        }),
      );
  }
  await db.batch(statements);
}

export type HealthChange = Readonly<{
  device: DeviceRecord;
  previous: DeviceHealth;
}>;

/**
 * Records a health report only when it changes something. A key that this
 * gateway does not hold changes nothing, and the caller refuses it.
 */
export async function applyHealthReports(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    gatewayId: string;
    reports: readonly DeviceHealthReport[];
    now: number;
  }>,
): Promise<
  Readonly<{ changes: readonly HealthChange[]; refused: readonly string[] }>
> {
  const known = await listGatewayDevices(
    db,
    input.organisationId,
    input.gatewayId,
  );
  const changes: HealthChange[] = [];
  const refused: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const report of input.reports) {
    const device = known.find((item) => item.sourceKey === report.sourceKey);
    if (device === undefined) {
      refused.push(report.sourceKey);
      continue;
    }
    const faultText =
      report.faultText === null ? null : cleanGatewayText(report.faultText);
    if (
      device.enrollment === "revoked" ||
      (device.health === report.health &&
        device.faultCode === report.faultCode &&
        device.faultText === faultText)
    )
      continue;
    statements.push(
      db
        .prepare(
          `UPDATE device_enrollment
              SET health = ?, fault_code = ?, fault_text = ?, health_at = ?
            WHERE device_id = ? AND organisation_id = ?`,
        )
        .bind(
          report.health,
          report.faultCode,
          faultText,
          input.now,
          device.deviceId,
          input.organisationId,
        ),
      eventStatement(db, {
        organisationId: input.organisationId,
        subjectId: device.deviceId,
        kind: `health_${report.health}`,
        actor: { kind: "gateway", id: input.gatewayId },
        detail: { faultCode: report.faultCode, faultText },
        idempotencyKey: null,
        now: input.now,
      }),
    );
    changes.push({
      device: {
        ...device,
        health: report.health,
        faultCode: report.faultCode,
        faultText,
      },
      previous: device.health,
    });
  }
  if (statements.length > 0) await db.batch(statements);
  return { changes, refused };
}

export async function recordGatewayHeard(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    gatewayId: string;
    now: number;
  }>,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE device_gateway SET last_heard_at = ?
        WHERE gateway_id = ? AND organisation_id = ? AND state = 'active'
        RETURNING gateway_id`,
    )
    .bind(input.now, input.gatewayId, input.organisationId)
    .first<{ gateway_id: string }>();
  return row !== null;
}

export type DeviceEventInput = Readonly<{
  organisationId: OrganisationId;
  subjectId: string;
  kind: string;
  actor: DeviceActorRef;
  detail: Readonly<Record<string, unknown>>;
  idempotencyKey: string | null;
  now: number;
  eventId?: string;
}>;

export function eventStatement(
  db: OrganisationDatabase,
  input: DeviceEventInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO device_event (
         event_id, organisation_id, subject_id, kind, actor_kind, actor_id,
         detail_json, idempotency_key, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.eventId ?? `devt_${randomHex(24)}`,
      input.organisationId,
      input.subjectId,
      input.kind,
      input.actor.kind,
      input.actor.id,
      JSON.stringify(input.detail),
      input.idempotencyKey,
      input.now,
    );
}

export async function recordDeviceEvent(
  db: OrganisationDatabase,
  input: DeviceEventInput,
): Promise<void> {
  await eventStatement(db, input).run();
}

export type DeviceEventRecord = Readonly<{
  eventId: string;
  subjectId: string;
  kind: string;
  actorKind: DeviceActorRef["kind"];
  detail: Readonly<Record<string, unknown>>;
  createdAt: number;
}>;

export async function readEventByIdempotencyKey(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  idempotencyKey: string,
): Promise<DeviceEventRecord | null> {
  const row = await db
    .prepare(
      `SELECT event_id, subject_id, kind, actor_kind, detail_json, created_at
         FROM device_event WHERE organisation_id = ? AND idempotency_key = ?`,
    )
    .bind(organisationId, idempotencyKey)
    .first<EventRow>();
  return row === null ? null : eventFromRow(row);
}

type EventRow = Readonly<{
  event_id: string;
  subject_id: string;
  kind: string;
  actor_kind: DeviceActorRef["kind"];
  detail_json: string;
  created_at: number;
}>;

function eventFromRow(row: EventRow): DeviceEventRecord {
  return {
    eventId: row.event_id,
    subjectId: row.subject_id,
    kind: row.kind,
    actorKind: row.actor_kind,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export async function listDeviceEvents(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  subjectId: string,
  limit: number,
): Promise<readonly DeviceEventRecord[]> {
  const rows = await db
    .prepare(
      `SELECT event_id, subject_id, kind, actor_kind, detail_json, created_at
         FROM device_event WHERE organisation_id = ? AND subject_id = ?
        ORDER BY created_at DESC, event_id DESC LIMIT ?`,
    )
    .bind(organisationId, subjectId, limit)
    .all<EventRow>();
  return rows.results.map(eventFromRow);
}

/** State changes and faults stay for 90 days. Receipts stay in the ledger. */
export const DEVICE_EVENT_RETENTION_MS = 90 * 24 * 60 * 60_000;

export async function pruneDeviceEvents(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  now: number,
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM device_event WHERE organisation_id = ? AND created_at < ?",
    )
    .bind(organisationId, now - DEVICE_EVENT_RETENTION_MS)
    .run();
}

export async function readDeviceAlertSetting(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<DeviceAlertSetting | null> {
  const row = await db
    .prepare(
      `SELECT time_zone, opens_at_minute, closes_at_minute,
              offline_delay_minutes
         FROM device_alert_setting WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      time_zone: string;
      opens_at_minute: number;
      closes_at_minute: number;
      offline_delay_minutes: number;
    }>();
  return row === null
    ? null
    : {
        timeZone: row.time_zone,
        opensAtMinute: row.opens_at_minute,
        closesAtMinute: row.closes_at_minute,
        offlineDelayMinutes: row.offline_delay_minutes,
      };
}

export async function writeDeviceAlertSetting(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  setting: DeviceAlertSetting,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO device_alert_setting (
         organisation_id, time_zone, opens_at_minute, closes_at_minute,
         offline_delay_minutes, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (organisation_id) DO UPDATE SET
         time_zone = excluded.time_zone,
         opens_at_minute = excluded.opens_at_minute,
         closes_at_minute = excluded.closes_at_minute,
         offline_delay_minutes = excluded.offline_delay_minutes,
         updated_at = excluded.updated_at`,
    )
    .bind(
      organisationId,
      setting.timeZone,
      setting.opensAtMinute,
      setting.closesAtMinute,
      setting.offlineDelayMinutes,
      now,
    )
    .run();
}

/** Stops every gateway and device of an Organisation that ends. */
export function revokeOrganisationDevicesStatements(
  session: OrganisationDatabaseSession,
  organisationId: OrganisationId,
  now: number,
): readonly D1PreparedStatement[] {
  return [
    session
      .prepare(
        `UPDATE device_gateway
            SET state = 'revoked', credential_sha256 = NULL, code_sha256 = NULL,
                code_expires_at = NULL, revoked_at = ?, revoked_by = 'platform'
          WHERE organisation_id = ? AND state != 'revoked'`,
      )
      .bind(now, organisationId),
  ];
}
