import type { OrganisationDatabase } from "../database-handles";
import type { DeviceAlertSetting, DeviceConnection } from "@seams/control-api";
import type { ConnectorDelivery } from "@seams/contracts";

import { resolveActiveConnectorActorAtPlacement } from "../actors/actor-router";
import type { Env } from "../env";
import { newRequestId, parseConnectorId, type OrganisationId } from "../ids";
import { traceWarn } from "../observability";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  deviceAlertNoticeDeliveryId,
  deviceAlertUpdateDeliveryId,
} from "../slack/device-alert-card";
import {
  listGatewayDevices,
  readDeviceAlertSetting,
  type DeviceRecord,
  type GatewayRecord,
} from "./store";

/**
 * Device alerts (Plan 85). One incident makes one Slack card, and the end of
 * the incident updates that card. The record here is the incident. The
 * Connector keeps the delivery receipts; no agent turn takes part, so the
 * delivery names the incident as its Case identity, as the paid placement
 * receipt does.
 */

export type DeviceAlertKind =
  | "gateway_offline"
  | "task_connection_lost"
  | "task_device_fault"
  | "task_result_unknown";

const DEFAULT_OFFLINE_DELAY_MINUTES = 5;

function randomAlertId(): string {
  return `dalert_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

/** Whether an offline gateway should reach Slack at `now`. */
export function isWithinShopHours(
  setting: DeviceAlertSetting | null,
  now: number,
): boolean {
  if (setting === null || setting.opensAtMinute === setting.closesAtMinute)
    return true;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: setting.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(
    parts.find((part) => part.type === "minute")?.value ?? 0,
  );
  const at = hour * 60 + minute;
  return setting.opensAtMinute < setting.closesAtMinute
    ? at >= setting.opensAtMinute && at < setting.closesAtMinute
    : at >= setting.opensAtMinute || at < setting.closesAtMinute;
}

export function offlineDelayMs(setting: DeviceAlertSetting | null): number {
  return (
    (setting?.offlineDelayMinutes ?? DEFAULT_OFFLINE_DELAY_MINUTES) * 60_000
  );
}

async function openAlert(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    subjectId: string;
    kind: DeviceAlertKind;
    text: string;
    closedText: string;
    now: number;
  }>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO device_alert (
         alert_id, organisation_id, subject_id, kind, text, closed_text,
         opened_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organisation_id, subject_id, kind)
         WHERE closed_at IS NULL DO NOTHING`,
    )
    .bind(
      randomAlertId(),
      input.organisationId,
      input.subjectId,
      input.kind,
      input.text,
      input.closedText,
      input.now,
    )
    .run();
}

async function closeAlert(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    subjectId: string;
    kind: DeviceAlertKind;
    now: number;
  }>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE device_alert SET closed_at = ?
        WHERE organisation_id = ? AND subject_id = ? AND kind = ?
          AND closed_at IS NULL`,
    )
    .bind(input.now, input.organisationId, input.subjectId, input.kind)
    .run();
}

/**
 * Opens or closes the alerts of one gateway from its connection. A lost
 * connection during a task reaches Slack at once. An offline gateway with no
 * task reaches Slack after the delay, and only during shop hours.
 */
export async function syncGatewayAlerts(
  env: Env,
  scope: OrganisationExecutionScope,
  gateway: GatewayRecord,
  connection: DeviceConnection,
  now: number,
): Promise<void> {
  const db = scope.database;
  const organisationId = scope.organisationId;
  if (connection.state === "connected") {
    for (const kind of ["task_connection_lost", "gateway_offline"] as const)
      await closeAlert(db, {
        organisationId,
        subjectId: gateway.gatewayId,
        kind,
        now,
      });
  } else if (connection.state === "quiet" || connection.state === "offline") {
    const devices = await listGatewayDevices(
      db,
      organisationId,
      gateway.gatewayId,
    );
    const tasks = devices.filter(hasAssignedTask);
    if (tasks.length > 0)
      await openAlert(db, {
        organisationId,
        subjectId: gateway.gatewayId,
        kind: "task_connection_lost",
        text: `Seams Pantry cannot hear ${gateway.name}, and ${taskCountText(tasks.length)} on it. New work on it has stopped. Check the machines in the shop.`,
        closedText: `${gateway.name} is connected again. Check the task result in the run.`,
        now,
      });
    const setting = await readDeviceAlertSetting(db, organisationId);
    if (
      connection.state === "offline" &&
      isWithinShopHours(setting, now) &&
      now - connection.lastHeardAt >= offlineDelayMs(setting)
    )
      await openAlert(db, {
        organisationId,
        subjectId: gateway.gatewayId,
        kind: "gateway_offline",
        text: `${gateway.name} is offline. Its devices take no new work. Check its power and network.`,
        closedText: `${gateway.name} is connected again.`,
        now,
      });
  }
  await deliverDeviceAlerts(env, scope, now);
}

function hasAssignedTask(device: DeviceRecord): boolean {
  return device.work.state === "reserved" || device.work.state === "running";
}

function taskCountText(count: number): string {
  return count === 1 ? "1 device has a task" : `${count} devices have tasks`;
}

/** A fault reaches Slack at once only when the device has an assigned task. */
export async function syncDeviceFaultAlert(
  env: Env,
  scope: OrganisationExecutionScope,
  device: DeviceRecord,
  now: number,
): Promise<void> {
  const organisationId = scope.organisationId;
  if (device.health === "fault" && hasAssignedTask(device)) {
    const code = device.faultCode === null ? "" : ` (${device.faultCode})`;
    await openAlert(scope.database, {
      organisationId,
      subjectId: device.deviceId,
      kind: "task_device_fault",
      text: `${device.name} reports a fault${code} during a task. New work on it has stopped. Check the machine in the shop.`,
      closedText: `${device.name} no longer reports a fault.`,
      now,
    });
  } else if (device.health !== "fault") {
    await closeAlert(scope.database, {
      organisationId,
      subjectId: device.deviceId,
      kind: "task_device_fault",
      now,
    });
  }
  await deliverDeviceAlerts(env, scope, now);
}

export async function openResultUnknownAlert(
  env: Env,
  scope: OrganisationExecutionScope,
  device: DeviceRecord,
  now: number,
): Promise<void> {
  await openAlert(scope.database, {
    organisationId: scope.organisationId,
    subjectId: device.deviceId,
    kind: "task_result_unknown",
    text: `Seams Pantry does not know if the last task of ${device.name} finished. Do not repeat it until a person checks the machine.`,
    closedText: `The last task of ${device.name} is settled.`,
    now,
  });
  await deliverDeviceAlerts(env, scope, now);
}

export async function closeResultUnknownAlert(
  env: Env,
  scope: OrganisationExecutionScope,
  device: DeviceRecord,
  now: number,
): Promise<void> {
  await closeAlert(scope.database, {
    organisationId: scope.organisationId,
    subjectId: device.deviceId,
    kind: "task_result_unknown",
    now,
  });
  await deliverDeviceAlerts(env, scope, now);
}

type AlertRow = Readonly<{
  alert_id: string;
  text: string;
  closed_text: string | null;
  opened_at: number;
  closed_at: number | null;
  notice_delivered_at: number | null;
  update_delivered_at: number | null;
}>;

/**
 * Sends each notice and update that is due. Returns true while work remains,
 * so that the caller tries again. A notice comes first: an update with no
 * delivered notice would post a second card.
 */
export async function deliverDeviceAlerts(
  env: Env,
  scope: OrganisationExecutionScope,
  now: number,
): Promise<boolean> {
  const db = scope.database;
  const organisationId = scope.organisationId;
  const rows = await db
    .prepare(
      `SELECT alert_id, text, closed_text, opened_at, closed_at,
              notice_delivered_at, update_delivered_at
         FROM device_alert
        WHERE organisation_id = ?
          AND (notice_delivered_at IS NULL
               OR (closed_at IS NOT NULL AND update_delivered_at IS NULL))
        ORDER BY opened_at LIMIT 20`,
    )
    .bind(organisationId)
    .all<AlertRow>();
  if (rows.results.length === 0) return false;
  const destination = await db
    .prepare(
      `SELECT integration_account_id, workspace_id, channel_id
         FROM organisation_communication_destination
        WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      integration_account_id: string;
      workspace_id: string;
      channel_id: string;
    }>();
  let remaining = false;
  for (const alert of rows.results) {
    // An incident that ended before its card went out needs no card. A shop
    // with no Slack channel has no one to tell; its people see the page.
    if (
      destination === null ||
      (alert.notice_delivered_at === null && alert.closed_at !== null)
    ) {
      await markDelivered(db, alert.alert_id, "both", now);
      continue;
    }
    const delivered =
      alert.notice_delivered_at === null
        ? await deliver(env, scope, destination, {
            deliveryId: deviceAlertNoticeDeliveryId(alert.alert_id),
            alertId: alert.alert_id,
            text: alert.text,
            revision: 1,
            now,
          })
        : await deliver(env, scope, destination, {
            deliveryId: deviceAlertUpdateDeliveryId(alert.alert_id),
            alertId: alert.alert_id,
            text: alert.closed_text ?? alert.text,
            revision: 2,
            now,
          });
    if (!delivered) {
      remaining = true;
      continue;
    }
    await markDelivered(
      db,
      alert.alert_id,
      alert.notice_delivered_at === null ? "notice" : "update",
      now,
    );
    if (alert.notice_delivered_at === null && alert.closed_at !== null)
      remaining = true;
  }
  return remaining;
}

async function markDelivered(
  db: D1Database,
  alertId: string,
  part: "notice" | "update" | "both",
  now: number,
): Promise<void> {
  const columns = {
    notice: "notice_delivered_at = ?",
    update: "update_delivered_at = ?",
    both: "notice_delivered_at = ?1, update_delivered_at = ?1",
  }[part];
  await db
    .prepare(
      part === "both"
        ? `UPDATE device_alert SET ${columns} WHERE alert_id = ?2`
        : `UPDATE device_alert SET ${columns} WHERE alert_id = ?`,
    )
    .bind(now, alertId)
    .run();
}

async function deliver(
  env: Env,
  scope: OrganisationExecutionScope,
  destination: Readonly<{
    integration_account_id: string;
    workspace_id: string;
    channel_id: string;
  }>,
  input: Readonly<{
    deliveryId: string;
    alertId: string;
    text: string;
    revision: number;
    now: number;
  }>,
): Promise<boolean> {
  const connectorId = parseConnectorId(
    `connector_slack_${destination.integration_account_id}`,
  );
  if (!connectorId.ok) return false;
  const delivery = {
    deliveryId: input.deliveryId,
    bindingId: `device_alert_binding_${input.alertId}`,
    address: {
      kind: "slack_channel",
      workspaceId: destination.workspace_id,
      channelId: destination.channel_id,
    },
    caseId: `device_alert_case_${input.alertId}`,
    caseRevision: input.revision,
    content: { kind: "text", text: input.text },
    idempotencyKey: `device_alert:${input.deliveryId}`,
    addressedAt: input.now,
  } as ConnectorDelivery;
  try {
    const connector = await resolveActiveConnectorActorAtPlacement({
      env,
      namespace: env.CONNECTOR,
      organisationId: scope.organisationId,
      connectorId: connectorId.value,
      placement: scope.placement,
      now: input.now,
    });
    if (!connector.ok) return false;
    const result = await connector.value.deliver({
      identity: {
        organisationId: scope.organisationId,
        connectorId: connectorId.value,
      },
      delivery,
      requestedAt: input.now,
    });
    if (
      result.ok &&
      (result.value.kind === "delivered" ||
        result.value.kind === "already_delivered")
    )
      return true;
    traceWarn("devices.alert_delivery_held", {
      requestId: newRequestId(),
      organisationId: scope.organisationId,
      alertId: input.alertId,
      outcome: result.ok ? result.value.kind : result.error.code,
    });
    return false;
  } catch {
    traceWarn("devices.alert_delivery_failed", {
      requestId: newRequestId(),
      organisationId: scope.organisationId,
      alertId: input.alertId,
    });
    return false;
  }
}
