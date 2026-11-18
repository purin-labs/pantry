import {
  DEVICE_CONNECTION_OFFLINE_MS,
  DEVICE_CONNECTION_QUIET_MS,
  type DeviceConnection,
  type DeviceHealth,
  type DeviceReadiness,
} from "@seams/control-api";
import type { Variant } from "@seams/type-utils";

/**
 * The one answer to "can this device take the next task?" (Plan 85). The
 * Devices page and Plan 24 dispatch both call this function, so they cannot
 * disagree. Telemetry can block work. It can never complete a task.
 */

export type GatewayPresence = Readonly<{
  gatewayId: string;
  lastHeardAt: number | null;
  socketOpen: boolean;
}>;

/** The state of a gateway's connection, from its last message. */
export function gatewayConnection(
  presence: GatewayPresence | null,
  now: number,
): DeviceConnection {
  if (presence === null || presence.lastHeardAt === null)
    return { state: "never_connected" };
  const { lastHeardAt } = presence;
  const silent = now - lastHeardAt;
  if (silent > DEVICE_CONNECTION_OFFLINE_MS)
    return { state: "offline", lastHeardAt };
  if (!presence.socketOpen || silent > DEVICE_CONNECTION_QUIET_MS)
    return { state: "quiet", lastHeardAt };
  return { state: "connected", lastHeardAt };
}

/**
 * Pantry hears a device only through its gateway. A device behind a lost
 * gateway is unknown, and it may still be on.
 */
export function deviceConnection(
  gateway: DeviceConnection,
  enrollment: DeviceEnrollmentState,
): DeviceConnection {
  if (enrollment === "revoked") return { state: "closed" };
  switch (gateway.state) {
    case "quiet":
    case "offline":
      return { state: "unknown", lastHeardAt: gateway.lastHeardAt };
    default:
      return gateway;
  }
}

export type DeviceEnrollmentState =
  "pending" | "active" | "restricted" | "revoked";

export type DeviceWorkState =
  | Readonly<{ state: "idle" }>
  | Readonly<{
      state: "reserved" | "running" | "result_unknown";
      taskRef: string;
      runRef: string | null;
      label: string;
    }>;

type DeviceReadinessFacts = Readonly<{
  enrollment: DeviceEnrollmentState;
  connection: DeviceConnection;
  health: DeviceHealth;
  paused: boolean;
  work: DeviceWorkState;
  takesTasks: boolean;
}>;

export function deviceReadiness(facts: DeviceReadinessFacts): DeviceReadiness {
  const { enrollment, connection, health, paused, work } = facts;
  if (work.state === "result_unknown") return blocked("result_unknown");
  if (enrollment === "revoked") return blocked("revoked");
  if (enrollment === "pending") return blocked("pending");
  if (enrollment === "restricted") return blocked("restricted");
  if (connection.state !== "connected") return blocked("connection_lost");
  if (health === "fault") return blocked("fault");
  if (paused) return blocked("paused");
  if (work.state !== "idle")
    return { kind: "busy", taskRef: work.taskRef, runRef: work.runRef };
  return facts.takesTasks ? { kind: "ready" } : { kind: "not_applicable" };
}

function blocked(
  reason: Variant<DeviceReadiness, "blocked">["reason"],
): DeviceReadiness {
  return { kind: "blocked", reason };
}

/** A blocked device needs a person, unless a person already revoked it. */
export function readinessNeedsAttention(readiness: DeviceReadiness): boolean {
  return readiness.kind === "blocked" && readiness.reason !== "revoked";
}
