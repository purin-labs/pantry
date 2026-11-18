import {
  deviceGatewayVersionIsCurrent,
  type DeviceConnection,
  type DeviceStationId,
  type GatewayDeviceView,
  type KitchenDeviceView,
} from "@seams/control-api";

import { deviceFleetStub } from "../actors/device-fleet";
import type { Env } from "../env";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  deviceConnection,
  deviceReadiness,
  gatewayConnection,
  readinessNeedsAttention,
  type GatewayPresence,
} from "./readiness";
import {
  listDevices,
  listGateways,
  type DeviceEventRecord,
  type DeviceRecord,
  type GatewayRecord,
} from "./store";

/** A revoked row stays visible for a week, so that its end can be read. */
const REVOKED_VISIBLE_MS = 7 * 24 * 60 * 60_000;
/** A pending gateway whose code has long ended leaves the list after a day. */
const PENDING_VISIBLE_MS = 24 * 60 * 60_000;

type KitchenDeviceViews = Readonly<{
  gateways: readonly GatewayDeviceView[];
  devices: readonly KitchenDeviceView[];
}>;

/** The gateways and devices of an Organisation, with their live connection. */
export async function readKitchenDeviceViews(
  env: Env,
  scope: OrganisationExecutionScope,
  input: Readonly<{ mayReadFaultText: boolean; now: number }>,
): Promise<KitchenDeviceViews> {
  const { now } = input;
  const db = scope.database;
  const [gateways, devices] = await Promise.all([
    listGateways(db, scope.organisationId),
    listDevices(db, scope.organisationId),
  ]);
  const presence = await readPresence(env, scope, gateways);
  const connections = new Map<string, DeviceConnection>(
    gateways.map((gateway) => [
      gateway.gatewayId,
      connectionOfGateway(
        gateway,
        presence.get(gateway.gatewayId) ?? null,
        now,
      ),
    ]),
  );
  const names = new Map(gateways.map((g) => [g.gatewayId, g.name]));
  return {
    gateways: gateways
      .filter(
        (gateway) =>
          !(
            gateway.state === "revoked" &&
            now - (gateway.revokedAt ?? 0) > REVOKED_VISIBLE_MS
          ) &&
          !(
            gateway.state === "pending" &&
            now - gateway.createdAt > PENDING_VISIBLE_MS
          ),
      )
      .map((gateway) =>
        gatewayView(
          gateway,
          connections.get(gateway.gatewayId) ?? { state: "never_connected" },
          devices.filter(
            (device) =>
              device.gatewayId === gateway.gatewayId &&
              device.enrollment !== "revoked",
          ).length,
        ),
      ),
    devices: devices
      .filter(
        (device) =>
          !(
            device.enrollment === "revoked" &&
            device.work.state !== "result_unknown" &&
            now - (device.revokedAt ?? 0) > REVOKED_VISIBLE_MS
          ),
      )
      .map((device) =>
        kitchenDeviceView(
          device,
          names.get(device.gatewayId) ?? device.gatewayId,
          connections.get(device.gatewayId) ?? { state: "never_connected" },
          input.mayReadFaultText,
        ),
      ),
  };
}

export async function readKitchenDeviceView(
  env: Env,
  scope: OrganisationExecutionScope,
  deviceId: string,
  now: number,
): Promise<KitchenDeviceView | null> {
  const { devices } = await readKitchenDeviceViews(env, scope, {
    mayReadFaultText: true,
    now,
  });
  return devices.find((device) => device.deviceId === deviceId) ?? null;
}

async function readPresence(
  env: Env,
  scope: OrganisationExecutionScope,
  gateways: readonly GatewayRecord[],
): Promise<ReadonlyMap<string, GatewayPresence>> {
  const locations = [
    ...new Set(
      gateways
        .filter((gateway) => gateway.state === "active")
        .map((gateway) => gateway.locationId),
    ),
  ];
  const reads = await Promise.all(
    locations.map(async (locationId) => {
      const stub = deviceFleetStub(env, scope, locationId);
      if (stub === null) return [];
      return (await stub.presence()) as readonly GatewayPresence[];
    }),
  );
  return new Map(reads.flat().map((row) => [row.gatewayId, row]));
}

function connectionOfGateway(
  gateway: GatewayRecord,
  presence: GatewayPresence | null,
  now: number,
): DeviceConnection {
  if (gateway.state === "revoked") return { state: "closed" };
  if (gateway.state === "pending") return { state: "never_connected" };
  return gatewayConnection(
    presence ?? {
      gatewayId: gateway.gatewayId,
      lastHeardAt: gateway.lastHeardAt,
      socketOpen: false,
    },
    now,
  );
}

function gatewayView(
  gateway: GatewayRecord,
  connection: DeviceConnection,
  deviceCount: number,
): GatewayDeviceView {
  const versionIsCurrent =
    gateway.serviceVersion === null ||
    deviceGatewayVersionIsCurrent(gateway.serviceVersion);
  return {
    kind: "gateway",
    deviceId: gateway.gatewayId,
    name: gateway.name,
    connection,
    needsAttention:
      gateway.state === "active" &&
      (connection.state !== "connected" || !versionIsCurrent),
    locationId: gateway.locationId,
    enrollment: gateway.state,
    serviceVersion: gateway.serviceVersion,
    versionIsCurrent,
    deviceCount,
  };
}

function kitchenDeviceView(
  device: DeviceRecord,
  gatewayName: string,
  gateway: DeviceConnection,
  mayReadFaultText: boolean,
): KitchenDeviceView {
  const connection = deviceConnection(gateway, device.enrollment);
  const readiness = deviceReadiness({
    enrollment: device.enrollment,
    connection,
    health: device.health,
    paused: device.paused,
    work: device.work,
    takesTasks: device.capabilities.length > 0 && device.hardware !== "camera",
  });
  return {
    kind: "kitchen_device",
    deviceId: device.deviceId,
    name: device.name,
    connection,
    needsAttention: readinessNeedsAttention(readiness),
    hardware: device.hardware,
    gatewayId: device.gatewayId,
    gatewayName,
    stationId: device.stationId as DeviceStationId | null,
    model: device.model,
    serial: device.serial,
    firmwareVersion: device.firmwareVersion,
    capabilities: [...device.capabilities],
    revision: device.revision,
    enrollment: device.enrollment,
    restrictReason: device.restrictReason,
    health: device.health,
    faultCode: device.faultCode,
    faultText: mayReadFaultText ? device.faultText : null,
    paused: device.paused,
    pauseConfirmed: device.pauseConfirmed,
    work: device.work,
    readiness,
  };
}

/** The sentence for one event. A device's own words stay in quotation marks. */
export function describeDeviceEvent(event: DeviceEventRecord): string {
  const who =
    event.actorKind === "person"
      ? "a person"
      : event.actorKind === "agent"
        ? "an agent"
        : event.actorKind === "gateway"
          ? "the gateway"
          : "Seams Pantry";
  const detail = (key: string): string =>
    typeof event.detail[key] === "string" ? event.detail[key] : "";
  switch (event.kind) {
    case "gateway_enrollment_started":
      return `Enrollment started by ${who}.`;
    case "gateway_enrolled":
      return "The gateway enrolled with its one-time code.";
    case "device_found":
      return "The gateway found this device.";
    case "capabilities_changed":
      return "The gateway reported new capabilities. A new revision started.";
    case "confirmed":
      return `Confirmed by ${who}.`;
    case "renamed":
      return `Renamed to ${detail("name")} by ${who}.`;
    case "moved":
      return `Moved by ${who}.`;
    case "restricted":
      return `Restricted by ${who}. Reason: ${detail("reason")}.`;
    case "restriction_lifted":
      return `Restriction lifted by ${who}.`;
    case "pause_requested":
      return `Pause requested by ${who}. New work stopped.`;
    case "resumed":
      return `Resumed by ${who}.`;
    case "result_checked":
      return `Task result checked by ${who}.`;
    case "revoked":
      return `Access revoked by ${who}.`;
    case "gateway_done":
      return "The gateway confirmed the request.";
    case "gateway_refused":
      return "The gateway refused the request.";
    case "task_reserved":
      return `Task reserved: ${detail("label")}.`;
    case "snapshot_requested":
      return detail("reason") === "fault"
        ? "A fault at this station asked for a snapshot."
        : `Snapshot requested by ${who}.`;
    case "snapshot_stored":
      return "The camera sent a snapshot. It is deleted after seven days.";
    case "connection_connected":
      return "The gateway connected.";
    case "connection_quiet":
      return "The gateway went quiet.";
    case "connection_offline":
      return "The gateway went offline.";
    case "health_ok":
      return "The device reports no fault.";
    case "health_warning":
      return `The device reports a warning. It said: "${detail("faultText")}"`;
    case "health_fault":
      return `The device reports fault ${detail("faultCode")}. It said: "${detail("faultText")}"`;
    case "health_not_reported":
      return "The device stopped reporting its health.";
    default:
      return "A change was recorded.";
  }
}
