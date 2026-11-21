import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type {
  DeviceActivity,
  DeviceList,
  DeviceSnapshotList,
  KitchenDeviceView,
} from "@purin-labs/control-api";
import "../styles.css";
import { DevicesRoute } from "../features/devices/route";

// The Devices page with a stand-in list. `?role=viewer` removes the network
// facts, `?list=empty` shows no device, `?list=partial` leaves out a kind and
// `?theme=dark` sets the dark appearance.
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Devices preview is development-only.");
const params = new URL(window.location.href).searchParams;
if (params.get("theme") === "dark")
  document.documentElement.dataset.portalTheme = "dark";
const role = params.get("role") === "viewer" ? "viewer" : "admin";
const admin = role === "admin";
const now = Date.now();
const kitchen = (
  deviceId: string,
  name: string,
  stationId: "station_bakery" | "station_bar" | null,
  overrides: Partial<KitchenDeviceView>,
): KitchenDeviceView => ({
  kind: "kitchen_device",
  deviceId,
  name,
  connection: { state: "connected", lastHeardAt: now - 12_000 },
  needsAttention: false,
  hardware: "cobot",
  gatewayId: "dgw_bakery",
  gatewayName: "Bakery gateway",
  stationId,
  model: "Simulated model",
  serial: `SN-${deviceId}`,
  firmwareVersion: "1.0.0",
  capabilities: [{ id: "move", label: "Move a cold tray", revision: 3 }],
  revision: 1,
  enrollment: "active",
  restrictReason: null,
  health: "ok",
  faultCode: null,
  faultText: null,
  paused: false,
  pauseConfirmed: false,
  work: { state: "idle" },
  readiness: { kind: "ready" },
  ...overrides,
});
let devices: DeviceList["devices"] = [
  {
    kind: "gateway",
    deviceId: "dgw_bakery",
    name: "Bakery gateway",
    connection: { state: "connected", lastHeardAt: now - 12_000 },
    needsAttention: false,
    locationId: "Main shop",
    enrollment: "active",
    serviceVersion: "0.1.0",
    versionIsCurrent: true,
    deviceCount: 4,
  },
  {
    kind: "gateway",
    deviceId: "dgw_bar",
    name: "Bar gateway",
    connection: { state: "offline", lastHeardAt: now - 7 * 60_000 },
    needsAttention: true,
    locationId: "Main shop",
    enrollment: "active",
    serviceVersion: "0.1.0",
    versionIsCurrent: true,
    deviceCount: 1,
  },
  kitchen("dev_cobot", "Tray cobot", "station_bakery", {
    work: {
      state: "running",
      taskRef: "task_1",
      runRef: "Financier batch 14",
      label: "Move tray to oven",
    },
    readiness: {
      kind: "busy",
      taskRef: "task_1",
      runRef: "Financier batch 14",
    },
  }),
  kitchen("dev_door", "Oven door servo", "station_bakery", {
    hardware: "servo",
  }),
  kitchen("dev_hob", "Hob dial servo", "station_bakery", {
    hardware: "servo",
    needsAttention: true,
    health: "fault",
    faultCode: "E07",
    faultText: admin ? "The dial position does not match the command." : null,
    readiness: { kind: "blocked", reason: "fault" },
  }),
  kitchen("dev_mixer", "Mixer relay", "station_bakery", {
    hardware: "relay",
    needsAttention: true,
    enrollment: "restricted",
    restrictReason: "Bowl guard check",
    readiness: { kind: "blocked", reason: "restricted" },
  }),
  kitchen("dev_arm", "Pour-over arm", "station_bar", {
    gatewayId: "dgw_bar",
    gatewayName: "Bar gateway",
    connection: { state: "unknown", lastHeardAt: now - 7 * 60_000 },
    needsAttention: true,
    readiness: { kind: "blocked", reason: "connection_lost" },
  }),
  kitchen("dev_camera", "Bench camera", "station_bakery", {
    hardware: "camera",
    capabilities: [],
    readiness: { kind: "not_applicable" },
  }),
  kitchen("dev_new", "Found relay", null, {
    hardware: "relay",
    needsAttention: true,
    enrollment: "pending",
    readiness: { kind: "blocked", reason: "pending" },
  }),
  {
    kind: "menu_screen",
    deviceId: "screen_drinks",
    name: "Drinks board",
    connection: { state: "connected", lastHeardAt: now - 8_000 },
    needsAttention: false,
    pairedAt: now - 40 * 86_400_000,
  },
  {
    kind: "shop_mac",
    deviceId: "vmac_09040d6b8e664a59943bd001",
    name: "Shop Mac d001",
    connection: { state: "connected", lastHeardAt: now - 40_000 },
    needsAttention: false,
    enrollment: "enrolled",
    serviceVersion: "0.2.0",
    modelState: "loaded",
    engine: "whisper-large-v3-turbo",
    network: admin
      ? {
          hostname: "dd8267f68371.voice.example.test",
          privateAddress: "192.168.1.20",
        }
      : null,
  },
  {
    kind: "payment_terminal",
    deviceId: "terminal_assignment_1",
    name: "main-counter",
    connection: { state: "managed_by_provider" },
    needsAttention: false,
    simulated: false,
    blocked: false,
    credentialHealth: "active",
  },
];
if (params.get("list") === "empty") devices = [];
if (params.get("list") === "partial")
  devices = devices.filter((device) => device.kind !== "menu_screen");
const activity: DeviceActivity = {
  ok: true,
  events: [
    {
      eventId: "devt_1",
      kind: "health_fault",
      actorKind: "gateway",
      text: 'The device reports fault E07. It said: "The dial position does not match the command."',
      createdAt: now - 20 * 60_000,
    },
    {
      eventId: "devt_2",
      kind: "confirmed",
      actorKind: "person",
      text: "Confirmed by a person.",
      createdAt: now - 3 * 86_400_000,
    },
  ],
  samples: [{ name: "load", value: 41, unit: "%", at: now - 60_000 }],
};
let snapshotsEnabled = false;
let snapshots: DeviceSnapshotList["snapshots"] = [];
// controlMutation reads the session's CSRF cookie before it sends.
document.cookie = "pantry_csrf=preview";
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const path = String(input);
  if (path.endsWith("/devices/camera-policy")) {
    snapshotsEnabled = (JSON.parse(String(init?.body)) as { enabled: boolean })
      .enabled;
    return Response.json({ ok: true, enabled: snapshotsEnabled });
  }
  if (path.endsWith("/snapshots"))
    return Response.json({ ok: true, snapshots });
  if (path.endsWith("/snapshot")) {
    setTimeout(() => {
      snapshots = [
        {
          snapshotId: `dsn_${snapshots.length}`,
          reason: "request",
          takenAt: Date.now(),
          expiresAt: Date.now() + 7 * 86_400_000,
        },
        ...snapshots,
      ];
    }, 1_500);
    return Response.json({ ok: true, snapshotId: "dsn_x" }, { status: 202 });
  }
  if (path.endsWith("/devices/alert-settings"))
    return Response.json({ ok: true, setting: null });
  if (path.endsWith("/devices/gateways")) {
    const gatewayId = "dgw_new";
    // The gateway connects a moment after the install command appears.
    setTimeout(() => {
      devices = devices.map((device) =>
        device.deviceId === gatewayId
          ? {
              ...device,
              connection: { state: "connected", lastHeardAt: Date.now() },
            }
          : device,
      );
    }, 7_000);
    devices = [
      {
        kind: "gateway",
        deviceId: gatewayId,
        name: "New gateway",
        connection: { state: "never_connected" },
        needsAttention: false,
        locationId: "Main shop",
        enrollment: "active",
        serviceVersion: "0.1.0",
        versionIsCurrent: true,
        deviceCount: 1,
      },
      kitchen("dev_sealer", "Box sealer relay", null, {
        gatewayId,
        gatewayName: "New gateway",
        hardware: "relay",
        needsAttention: true,
        enrollment: "pending",
        readiness: { kind: "blocked", reason: "pending" },
      }),
      ...devices,
    ];
    return Response.json(
      {
        ok: true,
        gatewayId,
        code: "preview-code",
        expiresAt: Date.now() + 15 * 60_000,
        installCommand:
          "curl -fsSL https://portal.example/shop-gateway/install.sh | sh -s -- --code preview-code",
      },
      { status: 201 },
    );
  }
  if (path.endsWith("/activity")) return Response.json(activity);
  if (path.endsWith("/devices")) {
    const list: DeviceList = {
      ok: true,
      devices,
      unavailableKinds: params.get("list") === "partial" ? ["menu_screen"] : [],
      locations: ["Main shop"],
      snapshotsEnabled,
    };
    return Response.json(list);
  }
  if (path.includes("/devices/") && init?.method === "POST") {
    const [, id = "", verb = ""] =
      /\/devices\/([^/]+)\/([a-z]+)$/u.exec(path) ?? [];
    const body = JSON.parse(String(init.body)) as {
      name?: string;
      stationId?: "station_bakery" | "station_bar";
      reason?: string;
    };
    devices = devices.map((device) => {
      if (device.deviceId !== id || device.kind !== "kitchen_device")
        return device;
      if (verb === "confirm")
        return {
          ...device,
          name: body.name ?? device.name,
          stationId: body.stationId ?? null,
          enrollment: "active",
          needsAttention: false,
          readiness: { kind: "ready" },
        };
      if (verb === "restrict")
        return {
          ...device,
          enrollment: "restricted",
          restrictReason: body.reason ?? "",
          needsAttention: true,
          readiness: { kind: "blocked", reason: "restricted" },
        };
      if (verb === "pause")
        return {
          ...device,
          paused: true,
          needsAttention: true,
          readiness: { kind: "blocked", reason: "paused" },
        };
      return device;
    });
    return Response.json({ ok: true, receiptId: "devt_x", replayed: false });
  }
  return realFetch(input, init);
};
createRoot(root).render(
  <React.StrictMode>
    <MemoryRouter>
      <main style={{ padding: 24 }}>
        <DevicesRoute
          organisationId="organisation_devices_preview"
          role={role}
          pagePaths={{
            menus: "/menus",
            terminals: "/terminals",
            chat: "/chat",
          }}
        />
      </main>
    </MemoryRouter>
  </React.StrictMode>,
);
