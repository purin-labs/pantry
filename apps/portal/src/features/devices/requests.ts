import {
  parseDeviceActivity,
  parseDeviceAlertSetting,
  parseDeviceGatewayStart,
  parseDeviceList,
  parseDeviceSnapshotList,
  type DeviceActivity,
  type DeviceAlertSetting,
  type DeviceGatewayStart,
  type DeviceList,
  type DeviceSnapshotList,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "../../control-client";
import { controlPath } from "../menu-boards/menu-board-requests";

/** The Devices page's calls to the Platform. */

export async function readDevices(
  organisationId: string,
): Promise<DeviceList | null> {
  try {
    return parseDeviceList(
      await controlRead(controlPath(organisationId, "devices")),
    );
  } catch {
    return null;
  }
}

/** What a device write got back: its status and JSON body, or null without an answer. */
type Sent = Readonly<{ ok: boolean; status: number; body: unknown }> | null;

async function send(
  organisationId: string,
  suffix: string,
  method: "POST" | "PUT",
  body: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<Sent> {
  try {
    const answer = await controlMutation(
      controlPath(organisationId, suffix),
      method,
      body,
      undefined,
      { kind: "prepared", idempotencyKey },
    );
    return { ok: true, status: 200, body: answer };
  } catch (error) {
    return error instanceof ControlApiError && error.status !== null
      ? { ok: false, status: error.status, body: error.details }
      : null;
  }
}

export async function sendDeviceCommand(
  organisationId: string,
  subjectId: string,
  command: string,
  body: Readonly<Record<string, unknown>> = {},
): Promise<boolean> {
  const response = await send(
    organisationId,
    `devices/${encodeURIComponent(subjectId)}/${command}`,
    "POST",
    body,
  );
  return response?.ok === true;
}

/** A gateway start: the code, a refusal with its error code, or no answer. */
export type GatewayStartResult =
  | Readonly<{ kind: "started"; start: DeviceGatewayStart }>
  | Readonly<{ kind: "refused"; error: string | null }>
  | Readonly<{ kind: "unanswered" }>;

/**
 * Starts a gateway enrollment. The caller keeps `idempotencyKey` for one
 * attempt, so that a retry after a lost answer sends the same key.
 */
export async function startGateway(
  organisationId: string,
  name: string,
  locationId: string,
  idempotencyKey: string,
): Promise<GatewayStartResult> {
  const response = await send(
    organisationId,
    "devices/gateways",
    "POST",
    { name, locationId },
    idempotencyKey,
  );
  if (response === null) return { kind: "unanswered" };
  if (!response.ok)
    return {
      kind: "refused",
      error:
        isRecord(response.body) && typeof response.body.error === "string"
          ? response.body.error
          : null,
    };
  const start = parseDeviceGatewayStart(response.body);
  return start === null
    ? { kind: "refused", error: null }
    : { kind: "started", start };
}

export async function readDeviceActivity(
  organisationId: string,
  subjectId: string,
): Promise<DeviceActivity | null> {
  const raw = await controlRead(
    controlPath(
      organisationId,
      `devices/${encodeURIComponent(subjectId)}/activity`,
    ),
  ).catch(() => null);
  return raw === null ? null : parseDeviceActivity(raw);
}

export async function readAlertSetting(
  organisationId: string,
): Promise<DeviceAlertSetting | null> {
  const raw = await controlRead(
    controlPath(organisationId, "devices/alert-settings"),
  ).catch(() => null);
  return isRecord(raw) ? parseDeviceAlertSetting(raw.setting) : null;
}

export async function writeAlertSetting(
  organisationId: string,
  setting: DeviceAlertSetting,
): Promise<boolean> {
  const response = await send(
    organisationId,
    "devices/alert-settings",
    "PUT",
    setting,
  );
  return response?.ok === true;
}

export type SnapshotRead =
  | Readonly<{ kind: "read"; snapshots: DeviceSnapshotList["snapshots"] }>
  | Readonly<{ kind: "no_access" }>
  | Readonly<{ kind: "failed" }>;

export async function readDeviceSnapshots(
  organisationId: string,
  deviceId: string,
): Promise<SnapshotRead> {
  let raw: unknown;
  try {
    raw = await controlRead(
      controlPath(
        organisationId,
        `devices/${encodeURIComponent(deviceId)}/snapshots`,
      ),
    );
  } catch (error) {
    return error instanceof ControlApiError && error.status === 403
      ? { kind: "no_access" }
      : { kind: "failed" };
  }
  const list = parseDeviceSnapshotList(raw);
  return list === null
    ? { kind: "failed" }
    : { kind: "read", snapshots: list.snapshots };
}

export function snapshotImagePath(
  organisationId: string,
  snapshotId: string,
): string {
  return controlPath(
    organisationId,
    `devices/snapshots/${encodeURIComponent(snapshotId)}`,
  );
}

export async function takeDeviceSnapshot(
  organisationId: string,
  deviceId: string,
): Promise<"asked" | "no_access" | "failed"> {
  const response = await send(
    organisationId,
    `devices/${encodeURIComponent(deviceId)}/snapshot`,
    "POST",
    {},
  );
  if (response?.status === 403) return "no_access";
  return response?.ok === true ? "asked" : "failed";
}

export async function writeSnapshotsEnabled(
  organisationId: string,
  enabled: boolean,
): Promise<boolean> {
  const response = await send(organisationId, "devices/camera-policy", "PUT", {
    enabled,
  });
  return response?.ok === true;
}
