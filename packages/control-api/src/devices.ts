import { Type, type Static } from "typebox";
import {
  NonNegativeInteger,
  PositiveInteger,
  textLimit,
} from "@purin-labs/contract-schema";
import { Value } from "typebox/value";

import { voiceMacModelStateSchema } from "./voice.ts";
import { voiceEngineIdSchema } from "./voice-engines.ts";

import {
  deviceCapabilitySchema,
  deviceHealthSchema,
  deviceKindSchema,
} from "./device-gateway.ts";
import { strict } from "./device-shapes.ts";
import type { Variant } from "@purin-labs/type-utils";

/**
 * The Devices page (Plan 85): one list of the devices in the shop. Each kind
 * keeps its own records. Menu screens, shop Macs and payment terminals keep
 * their own management pages; gateways and the devices behind them are managed
 * here.
 */

export * from "./device-gateway.ts";

const timestamp = NonNegativeInteger;
const text = textLimit(Type.String({ minLength: 1, maxLength: 255 }));

/** The stations that a device can stand at. These ids already exist. */
export const DEVICE_STATIONS = [
  { stationId: "station_bakery", label: "Bakery" },
  { stationId: "station_bar", label: "Bar" },
] as const;

const deviceStationIdSchema = Type.Union([
  Type.Literal("station_bakery"),
  Type.Literal("station_bar"),
]);
export type DeviceStationId = Static<typeof deviceStationIdSchema>;

const deviceConnectionSchema = Type.Union([
  Type.Object(
    { state: Type.Literal("connected"), lastHeardAt: timestamp },
    strict,
  ),
  Type.Object({ state: Type.Literal("quiet"), lastHeardAt: timestamp }, strict),
  Type.Object(
    { state: Type.Literal("offline"), lastHeardAt: timestamp },
    strict,
  ),
  /** Pantry cannot hear this device's gateway, so it knows nothing new. */
  Type.Object(
    {
      state: Type.Literal("unknown"),
      lastHeardAt: Type.Union([Type.Null(), timestamp]),
    },
    strict,
  ),
  Type.Object({ state: Type.Literal("closed") }, strict),
  Type.Object({ state: Type.Literal("never_connected") }, strict),
  /** Square holds this device's state, and Pantry receives no heartbeat. */
  Type.Object({ state: Type.Literal("managed_by_provider") }, strict),
]);
export type DeviceConnection = Static<typeof deviceConnectionSchema>;

const deviceBlockedReasonSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("restricted"),
  Type.Literal("revoked"),
  Type.Literal("fault"),
  Type.Literal("paused"),
  Type.Literal("connection_lost"),
  Type.Literal("result_unknown"),
]);

/** The one answer to "can this device take the next task?". */
const deviceReadinessSchema = Type.Union([
  Type.Object({ kind: Type.Literal("ready") }, strict),
  /** This device takes no kitchen tasks, for example a camera. */
  Type.Object({ kind: Type.Literal("not_applicable") }, strict),
  Type.Object(
    {
      kind: Type.Literal("busy"),
      taskRef: text,
      runRef: Type.Union([Type.Null(), text]),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("blocked"),
      reason: deviceBlockedReasonSchema,
    },
    strict,
  ),
]);
export type DeviceReadiness = Static<typeof deviceReadinessSchema>;

const deviceWorkSchema = Type.Union([
  Type.Object({ state: Type.Literal("idle") }, strict),
  Type.Object(
    {
      state: Type.Union([
        Type.Literal("reserved"),
        Type.Literal("running"),
        Type.Literal("result_unknown"),
      ]),
      taskRef: text,
      runRef: Type.Union([Type.Null(), text]),
      label: text,
    },
    strict,
  ),
]);

const deviceBase = {
  deviceId: text,
  name: text,
  connection: deviceConnectionSchema,
  needsAttention: Type.Boolean(),
};

const deviceViewSchema = Type.Union([
  Type.Object(
    {
      ...deviceBase,
      kind: Type.Literal("menu_screen"),
      pairedAt: timestamp,
    },
    strict,
  ),
  Type.Object(
    {
      ...deviceBase,
      kind: Type.Literal("shop_mac"),
      enrollment: Type.Union([
        Type.Literal("pending"),
        Type.Literal("enrolled"),
      ]),
      serviceVersion: Type.Union([Type.Null(), text]),
      modelState: Type.Union([Type.Null(), voiceMacModelStateSchema]),
      /** The speech engine that the Mac reported (Plan 82C). */
      engine: Type.Union([Type.Null(), voiceEngineIdSchema]),
      /** Only an admin or an owner reads where the Mac is on the network. */
      network: Type.Union([
        Type.Null(),
        Type.Object(
          {
            hostname: text,
            privateAddress: Type.Union([Type.Null(), text]),
          },
          strict,
        ),
      ]),
    },
    strict,
  ),
  Type.Object(
    {
      ...deviceBase,
      kind: Type.Literal("payment_terminal"),
      simulated: Type.Boolean(),
      blocked: Type.Boolean(),
      credentialHealth: Type.Union([
        Type.Literal("active"),
        Type.Literal("degraded"),
        Type.Literal("reauth_required"),
        Type.Literal("disabled"),
        Type.Literal("revoked"),
        Type.Literal("unavailable"),
      ]),
    },
    strict,
  ),
  Type.Object(
    {
      ...deviceBase,
      kind: Type.Literal("gateway"),
      locationId: text,
      enrollment: Type.Union([
        Type.Literal("pending"),
        Type.Literal("active"),
        Type.Literal("revoked"),
      ]),
      serviceVersion: Type.Union([Type.Null(), text]),
      versionIsCurrent: Type.Boolean(),
      deviceCount: NonNegativeInteger,
    },
    strict,
  ),
  Type.Object(
    {
      ...deviceBase,
      kind: Type.Literal("kitchen_device"),
      hardware: deviceKindSchema,
      gatewayId: text,
      gatewayName: text,
      stationId: Type.Union([Type.Null(), deviceStationIdSchema]),
      model: text,
      serial: Type.Union([Type.Null(), text]),
      firmwareVersion: Type.Union([Type.Null(), text]),
      capabilities: Type.Array(deviceCapabilitySchema),
      revision: PositiveInteger,
      enrollment: Type.Union([
        Type.Literal("pending"),
        Type.Literal("active"),
        Type.Literal("restricted"),
        Type.Literal("revoked"),
      ]),
      restrictReason: Type.Union([Type.Null(), text]),
      health: deviceHealthSchema,
      /** A closed code. A viewer never reads the device's own fault text. */
      faultCode: Type.Union([Type.Null(), text]),
      faultText: Type.Union([Type.Null(), text]),
      paused: Type.Boolean(),
      /** The gateway answered the current pause with `done`. */
      pauseConfirmed: Type.Boolean(),
      work: deviceWorkSchema,
      readiness: deviceReadinessSchema,
    },
    strict,
  ),
]);
export type DeviceView = Static<typeof deviceViewSchema>;
export type DeviceKind = DeviceView["kind"];
export type KitchenDeviceView = Variant<DeviceView, "kitchen_device">;
export type GatewayDeviceView = Variant<DeviceView, "gateway">;

const deviceListSchema = Type.Object(
  {
    ok: Type.Literal(true),
    devices: Type.Array(deviceViewSchema),
    /** A kind that the read could not reach, so the list can be incomplete. */
    unavailableKinds: Type.Array(
      Type.Union([
        Type.Literal("menu_screen"),
        Type.Literal("shop_mac"),
        Type.Literal("payment_terminal"),
        Type.Literal("gateway"),
        Type.Literal("kitchen_device"),
      ]),
    ),
    locations: Type.Array(text),
    /** Camera snapshots, which are off until an admin turns them on. */
    snapshotsEnabled: Type.Boolean(),
  },
  strict,
);
export type DeviceList = Static<typeof deviceListSchema>;

const deviceActivitySchema = Type.Object(
  {
    ok: Type.Literal(true),
    events: Type.Array(
      Type.Object(
        {
          eventId: text,
          kind: text,
          actorKind: Type.Union([
            Type.Literal("person"),
            Type.Literal("agent"),
            Type.Literal("gateway"),
            Type.Literal("platform"),
          ]),
          text: text,
          createdAt: timestamp,
        },
        strict,
      ),
    ),
    samples: Type.Array(
      Type.Object(
        {
          name: text,
          value: Type.Number(),
          unit: text,
          at: timestamp,
        },
        strict,
      ),
    ),
  },
  strict,
);
export type DeviceActivity = Static<typeof deviceActivitySchema>;

const deviceGatewayStartSchema = Type.Object(
  {
    ok: Type.Literal(true),
    gatewayId: text,
    code: text,
    expiresAt: timestamp,
    installCommand: Type.String({ minLength: 1 }),
  },
  strict,
);
export type DeviceGatewayStart = Static<typeof deviceGatewayStartSchema>;

const deviceAlertSettingSchema = Type.Object(
  {
    timeZone: text,
    opensAtMinute: Type.Integer({ minimum: 0, maximum: 1439 }),
    closesAtMinute: Type.Integer({ minimum: 0, maximum: 1439 }),
    offlineDelayMinutes: Type.Integer({ minimum: 1, maximum: 120 }),
  },
  strict,
);
export type DeviceAlertSetting = Static<typeof deviceAlertSettingSchema>;

const deviceSnapshotListSchema = Type.Object(
  {
    ok: Type.Literal(true),
    snapshots: Type.Array(
      Type.Object(
        {
          snapshotId: text,
          reason: Type.Union([Type.Literal("fault"), Type.Literal("request")]),
          takenAt: timestamp,
          expiresAt: timestamp,
        },
        strict,
      ),
    ),
  },
  strict,
);
export type DeviceSnapshotList = Static<typeof deviceSnapshotListSchema>;

export function parseDeviceSnapshotList(
  raw: unknown,
): DeviceSnapshotList | null {
  return Value.Check(deviceSnapshotListSchema, raw) ? raw : null;
}

export function parseDeviceStationId(raw: unknown): DeviceStationId | null {
  return Value.Check(deviceStationIdSchema, raw) ? raw : null;
}

export function parseDeviceList(raw: unknown): DeviceList | null {
  return Value.Check(deviceListSchema, raw) ? raw : null;
}

export function parseDeviceActivity(raw: unknown): DeviceActivity | null {
  return Value.Check(deviceActivitySchema, raw) ? raw : null;
}

export function parseDeviceGatewayStart(
  raw: unknown,
): DeviceGatewayStart | null {
  return Value.Check(deviceGatewayStartSchema, raw) ? raw : null;
}

export function parseDeviceAlertSetting(
  raw: unknown,
): DeviceAlertSetting | null {
  return Value.Check(deviceAlertSettingSchema, raw) ? raw : null;
}
