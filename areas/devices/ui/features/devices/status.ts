import {
  DEVICE_STATIONS,
  type DeviceKind,
  type DeviceView,
  type KitchenDeviceView,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";

/** How a device's facts read on the Devices page. */

type Tone = "ok" | "busy" | "warn" | "bad" | "muted";
type DeviceStatus = Readonly<{
  label: string;
  /** A second fact, or null when the label says it all. */
  reason: string | null;
  tone: Tone;
}>;

export function deviceStatus(device: DeviceView): DeviceStatus {
  switch (device.kind) {
    case "menu_screen":
      switch (device.connection.state) {
        case "connected":
          return { label: "Connected", reason: null, tone: "ok" };
        case "offline":
          return {
            label: "Offline",
            reason: "It shows its saved copy",
            tone: "warn",
          };
        default:
          return {
            label: "Not connected yet",
            reason: "Open the screen page on the device",
            tone: "warn",
          };
      }
    case "shop_mac":
      if (device.enrollment === "pending")
        return {
          label: "Waiting for install",
          reason: "The install command has not finished",
          tone: "muted",
        };
      switch (device.connection.state) {
        case "connected":
          return {
            label: "Connected",
            reason: modelLabel(device.modelState),
            tone: "ok",
          };
        default:
          return {
            label: "Offline",
            reason: "Voice commands use the fallback service",
            tone: "warn",
          };
      }
    case "payment_terminal":
      if (device.blocked)
        return {
          label: "Cannot take payments",
          reason: "Its assignment is retired",
          tone: "bad",
        };
      if (device.credentialHealth !== "active")
        return {
          label: "Check the Square connection",
          reason: credentialLabel(device.credentialHealth),
          tone: "bad",
        };
      return {
        label: "Managed by Square",
        reason: device.simulated ? "A simulated terminal for tests" : null,
        tone: "muted",
      };
    case "gateway":
      return gatewayStatus(device);
    case "kitchen_device":
      return kitchenStatus(device);
    default:
      return assertNever(device, "Unexpected device");
  }
}

function gatewayStatus(device: Variant<DeviceView, "gateway">): DeviceStatus {
  if (device.enrollment === "revoked")
    return { label: "Revoked", reason: "Its access is removed", tone: "muted" };
  if (device.enrollment === "pending")
    return {
      label: "Waiting for install",
      reason: "The install command has not finished",
      tone: "muted",
    };
  const count = `${device.deviceCount} ${device.deviceCount === 1 ? "device" : "devices"} behind it`;
  switch (device.connection.state) {
    case "connected":
      return device.versionIsCurrent
        ? { label: "Connected", reason: count, tone: "ok" }
        : {
            label: "Update needed",
            reason: "Its version is below the supported version",
            tone: "warn",
          };
    case "quiet":
      return {
        label: "Quiet",
        reason: "It sent no recent message. New work stopped",
        tone: "warn",
      };
    case "offline":
      return {
        label: "Offline",
        reason: "Check its power and network",
        tone: "bad",
      };
    default:
      return {
        label: "Not connected yet",
        reason: "Check that the gateway is on",
        tone: "warn",
      };
  }
}

function kitchenStatus(device: KitchenDeviceView): DeviceStatus {
  const { readiness } = device;
  switch (readiness.kind) {
    case "ready":
      return { label: "Ready", reason: null, tone: "ok" };
    case "not_applicable":
      return { label: "Connected", reason: null, tone: "muted" };
    case "busy":
      return { label: "Busy", reason: null, tone: "busy" };
    case "blocked":
      switch (readiness.reason) {
        case "pending":
          return { label: "Pending", reason: null, tone: "warn" };
        case "restricted":
          return {
            label: "Restricted",
            reason: device.restrictReason ?? "A person restricted it",
            tone: "warn",
          };
        case "revoked":
          return {
            label: "Revoked",
            reason: "Its access is removed",
            tone: "muted",
          };
        case "fault":
          return {
            label: "Fault",
            reason:
              device.faultCode === null
                ? "The device reports a fault"
                : `The device reports fault ${device.faultCode}`,
            tone: "bad",
          };
        case "paused":
          return {
            label: "Paused",
            reason: device.pauseConfirmed
              ? "New work stopped until a person resumes it"
              : "New work stopped. The gateway has not confirmed the pause yet",
            tone: "warn",
          };
        case "connection_lost":
          return device.work.state === "idle"
            ? {
                label: "Unknown",
                reason: `Cannot hear ${device.gatewayName}`,
                tone: "warn",
              }
            : {
                label: "Result unknown",
                reason: `Cannot hear ${device.gatewayName}`,
                tone: "bad",
              };
        case "result_unknown":
          return {
            label: "Result unknown",
            reason: "Do not repeat the task until a person checks it",
            tone: "bad",
          };
        default:
          return assertNever(readiness.reason, "Unexpected value");
      }
    default:
      return assertNever(readiness, "Unexpected value");
  }
}

/** The one sentence that answers "can this device take the next task?". */
export function kitchenAnswer(device: KitchenDeviceView): string {
  const { readiness } = device;
  switch (readiness.kind) {
    case "ready":
      return "This device can take the next task when a physical run names it.";
    case "not_applicable":
      return "This device reports its health. It takes no kitchen tasks.";
    case "busy":
      return "This device has a task now. It can take the next task when this one ends.";
    case "blocked":
      switch (readiness.reason) {
        case "pending":
          return "The gateway found this device. It takes no work until a person confirms it.";
        case "restricted":
          return "A person restricted this device. Purin Pantry sends it no new task until an admin lifts this.";
        case "revoked":
          return "This device has no access, and Purin Pantry sends it no task.";
        case "fault":
          return "This device reports a fault, so Purin Pantry sends it no new task. Check the machine in the shop.";
        case "paused":
          return "Purin Pantry stopped new work on this device until a person resumes it.";
        case "connection_lost":
          return "Purin Pantry cannot hear this device, so it sends no new task. The device may still be on.";
        case "result_unknown":
          return "Purin Pantry does not know if the last task finished. Check the machine, then mark the result as checked.";
        default:
          return assertNever(readiness.reason, "Unexpected value");
      }
    default:
      return assertNever(readiness, "Unexpected value");
  }
}

export function currentWork(device: DeviceView): string {
  if (device.kind !== "kitchen_device" || device.work.state === "idle")
    return "";
  return device.work.runRef === null
    ? device.work.label
    : `${device.work.label}, ${device.work.runRef}`;
}

export function credentialLabel(
  health: Variant<DeviceView, "payment_terminal">["credentialHealth"],
): string {
  switch (health) {
    case "active":
      return "Active";
    case "degraded":
      return "Square reports a problem";
    case "reauth_required":
      return "Square needs a new sign-in";
    case "disabled":
      return "The connection is off";
    case "revoked":
      return "Square access is removed";
    case "unavailable":
      return "Purin Pantry cannot read the connection";
    default:
      return assertNever(health, "Unexpected value");
  }
}

export function modelLabel(
  state: Variant<DeviceView, "shop_mac">["modelState"],
): string {
  switch (state) {
    case "loaded":
      return "Speech model loaded";
    case "loading":
      return "Speech model loading";
    case "downloading":
      return "Speech model downloading";
    case "unloaded":
      return "Speech model not in memory";
    case "none":
      return "No speech model";
    case null:
      return "Speech model not reported";
    default:
      return assertNever(state, "Unexpected value");
  }
}

export function lastHeard(device: DeviceView): string {
  const { connection } = device;
  switch (connection.state) {
    case "connected":
    case "quiet":
    case "offline":
      return elapsed(connection.lastHeardAt);
    case "unknown":
      return connection.lastHeardAt === null
        ? "Never"
        : elapsed(connection.lastHeardAt);
    case "closed":
      return "Closed";
    case "never_connected":
      return "Never";
    case "managed_by_provider":
      return "Not tracked";
    default:
      return assertNever(connection, "Unexpected value");
  }
}

function elapsed(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return dateTime(at);
}

export function dateTime(at: number): string {
  return new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function kindLabel(kind: DeviceKind): string {
  switch (kind) {
    case "menu_screen":
      return "Menu screen";
    case "shop_mac":
      return "Shop Mac";
    case "payment_terminal":
      return "Payment terminal";
    case "gateway":
      return "Gateway";
    case "kitchen_device":
      return "Kitchen device";
    default:
      return assertNever(kind, "Unexpected value");
  }
}

export function hardwareLabel(device: KitchenDeviceView): string {
  switch (device.hardware) {
    case "cobot":
      return "Cobot";
    case "appliance":
      return "Appliance";
    case "servo":
      return "Servo";
    case "relay":
      return "Relay";
    case "camera":
      return "Camera";
    case "payment_terminal":
      return "Payment terminal";
    case "receipt_printer":
      return "Receipt printer";
    case "other":
      return "Device";
    default:
      return assertNever(device.hardware, "Unexpected value");
  }
}

export function stationLabel(stationId: string | null): string {
  return (
    DEVICE_STATIONS.find((station) => station.stationId === stationId)?.label ??
    "No station yet"
  );
}
