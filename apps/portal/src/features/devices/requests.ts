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
  controlAnswer,
  controlMutation,
  controlRead,
} from "@purin-labs/control/portal/control-client";
import { controlPath } from "@purin-labs/control/portal/control-paths";

/**
 * The Devices page's calls to the Platform. A read for `useLatestRead` and a
 * write for `useMutation` fail with an error. The other writes give their
 * outcome as a value.
 */

export async function readDevices(
  organisationId: string,
  signal: AbortSignal,
): Promise<DeviceList> {
  const list = parseDeviceList(
    await controlRead(controlPath(organisationId, "devices"), signal),
  );
  if (list === null) throw new Error("The devices answer is not valid.");
  return list;
}

function write(
  organisationId: string,
  suffix: string,
  method: "POST" | "PUT",
  body: unknown,
  idempotencyKey: string,
): Promise<unknown> {
  return controlMutation(
    controlPath(organisationId, suffix),
    method,
    body,
    undefined,
    { kind: "prepared", idempotencyKey },
  );
}

/** A command for one device or gateway, such as `rename`. It fails when refused. */
export async function sendDeviceCommand(
  organisationId: string,
  subjectId: string,
  command: string,
  body: Readonly<Record<string, unknown>> = {},
  idempotencyKey: string = crypto.randomUUID(),
): Promise<void> {
  await write(
    organisationId,
    `devices/${encodeURIComponent(subjectId)}/${command}`,
    "POST",
    body,
    idempotencyKey,
  );
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
  const response = await controlAnswer(
    write(
      organisationId,
      "devices/gateways",
      "POST",
      { name, locationId },
      idempotencyKey,
    ),
  );
  if (!response.ok && response.status === null) return { kind: "unanswered" };
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
  signal: AbortSignal,
): Promise<DeviceActivity> {
  const activity = parseDeviceActivity(
    await controlRead(
      controlPath(
        organisationId,
        `devices/${encodeURIComponent(subjectId)}/activity`,
      ),
      signal,
    ),
  );
  if (activity === null) throw new Error("The activity answer is not valid.");
  return activity;
}

/** The saved alert times, or null when the workspace has saved none. */
export async function readAlertSetting(
  organisationId: string,
  signal: AbortSignal,
): Promise<DeviceAlertSetting | null> {
  const raw = await controlRead(
    controlPath(organisationId, "devices/alert-settings"),
    signal,
  );
  return isRecord(raw) ? parseDeviceAlertSetting(raw.setting) : null;
}

export async function writeAlertSetting(
  organisationId: string,
  setting: DeviceAlertSetting,
  idempotencyKey: string,
): Promise<void> {
  await write(
    organisationId,
    "devices/alert-settings",
    "PUT",
    setting,
    idempotencyKey,
  );
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
  const response = await controlAnswer(
    write(
      organisationId,
      `devices/${encodeURIComponent(deviceId)}/snapshot`,
      "POST",
      {},
      crypto.randomUUID(),
    ),
  );
  if (response.status === 403) return "no_access";
  return response.ok ? "asked" : "failed";
}

export async function writeSnapshotsEnabled(
  organisationId: string,
  enabled: boolean,
): Promise<boolean> {
  const response = await controlAnswer(
    write(
      organisationId,
      "devices/camera-policy",
      "PUT",
      { enabled },
      crypto.randomUUID(),
    ),
  );
  return response.ok;
}
