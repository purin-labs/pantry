import { Type, type Static } from "typebox";

import { shortText, sourceKey, strict } from "./device-shapes.ts";

/**
 * The cobot task protocol between Pantry and a shop gateway (Plan 24 S3). The
 * gateway's `cobot` adapter (crates/shop-gateway/src/cobot.rs) translates it
 * to the controller protocol; Pantry never talks to a controller. Pantry
 * sends named tasks only, never joint angles, speeds or safety settings.
 */

/** The dispatch identity that Pantry writes before the gateway sends a task. */
const dispatchIdSchema = Type.String({ pattern: "^dsp_[a-f0-9]{24}$" });
const reasonCode = Type.String({
  minLength: 1,
  maxLength: 40,
  pattern: "^[a-z0-9_]+$",
});

export const cobotStationSchema = Type.Union([
  Type.Literal("cold_rack"),
  Type.Literal("oven"),
  Type.Literal("cooling_rack"),
]);
export type CobotStation = Static<typeof cobotStationSchema>;

const cobotPlaceSchema = Type.Object(
  {
    station: cobotStationSchema,
    shelf: Type.Integer({ minimum: 1, maximum: 12 }),
  },
  strict,
);
export type CobotPlace = Static<typeof cobotPlaceSchema>;

export const cobotTaskSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("move_mould_group"),
      mouldGroup: Type.Integer({ minimum: 1, maximum: 32 }),
      from: cobotPlaceSchema,
      to: cobotPlaceSchema,
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("bake"),
      programSeconds: Type.Integer({ minimum: 1, maximum: 7200 }),
      temperatureC: Type.Integer({ minimum: 50, maximum: 300 }),
    },
    strict,
  ),
]);
export type CobotTask = Static<typeof cobotTaskSchema>;

export const cobotTaskStateSchema = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("rejected"),
  Type.Literal("indeterminate"),
]);
export type CobotTaskState = Static<typeof cobotTaskStateSchema>;

const carrierAtSchema = Type.Union([
  Type.Literal("source"),
  Type.Literal("tool"),
  Type.Literal("destination"),
  Type.Literal("unknown"),
]);
/** Where the controller evidences the mould group. */
export type CarrierAt = Static<typeof carrierAtSchema>;

const deviceRunStateSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("busy"),
  Type.Literal("paused"),
  Type.Literal("stopped"),
  Type.Literal("estop"),
]);
export type DeviceRunState = Static<typeof deviceRunStateSchema>;

const counter = Type.Integer({ minimum: 0 });

/** Pantry -> gateway: one task for one cobot or the oven. */
export const cobotTaskMessageSchema = Type.Object(
  {
    type: Type.Literal("cobot_task"),
    requestId: dispatchIdSchema,
    sourceKey,
    runId: shortText,
    taskId: shortText,
    task: cobotTaskSchema,
  },
  strict,
);
export type CobotTaskMessage = Static<typeof cobotTaskMessageSchema>;

/** Pantry -> gateway: the state of a task, from the controller. */
export const cobotInquireMessageSchema = Type.Object(
  {
    type: Type.Literal("cobot_inquire"),
    requestId: dispatchIdSchema,
    sourceKey,
  },
  strict,
);

/**
 * Pantry -> gateway: the clock of each cobot and oven now, before a run's
 * first task. The gateway answers at once with `cobot_clock` and the same
 * `requestId`, from the last clock line of each controller.
 */
export const cobotClockReadMessageSchema = Type.Object(
  { type: Type.Literal("cobot_clock_read"), requestId: shortText },
  strict,
);

/** Pantry -> gateway: stop a device. The existing `ack` answers it. */
export const deviceStopMessageSchema = Type.Object(
  { type: Type.Literal("stop"), requestId: shortText, sourceKey },
  strict,
);

/**
 * Gateway -> Pantry: what the controller reported about one task. `sequence`
 * and `deviceClockMs` are the controller's own; they are evidence, not
 * authority. `replayed` says that the gateway answered from its journal and
 * sent nothing to the controller.
 */
export const cobotReportMessageSchema = Type.Object(
  {
    type: Type.Literal("cobot_report"),
    requestId: dispatchIdSchema,
    sourceKey,
    state: cobotTaskStateSchema,
    sequence: counter,
    deviceClockMs: counter,
    progress: Type.Union([
      Type.Null(),
      Type.Number({ minimum: 0, maximum: 1 }),
    ]),
    phase: Type.Union([Type.Null(), shortText]),
    carrierAt: Type.Union([Type.Null(), carrierAtSchema]),
    reason: Type.Union([Type.Null(), reasonCode]),
    observedSeconds: Type.Union([Type.Null(), Type.Number({ minimum: 0 })]),
    replayed: Type.Boolean(),
  },
  strict,
);
export type CobotReport = Static<typeof cobotReportMessageSchema>;

const cobotClockEntrySchema = Type.Object(
  {
    sourceKey,
    sequence: counter,
    deviceClockMs: counter,
    state: deviceRunStateSchema,
  },
  strict,
);
export type CobotClockEntry = Static<typeof cobotClockEntrySchema>;

/**
 * Gateway -> Pantry: the clock of each cobot and oven, at most one message a
 * second, only while the gateway's journal holds an open task. The answer to
 * `cobot_clock_read` has its `requestId`; the periodic message has none.
 */
export const cobotClockMessageSchema = Type.Object(
  {
    type: Type.Literal("cobot_clock"),
    requestId: Type.Optional(shortText),
    clocks: Type.Array(cobotClockEntrySchema, { minItems: 1, maxItems: 64 }),
  },
  strict,
);
export type CobotClock = Static<typeof cobotClockMessageSchema>;

/** Gateway -> Pantry: a move that the controller ran from its own script (S5). */
export const cobotObservedMessageSchema = Type.Object(
  {
    type: Type.Literal("cobot_observed"),
    sourceKey,
    observationId: shortText,
    task: cobotTaskSchema,
    state: Type.Union([
      Type.Literal("started"),
      Type.Literal("completed"),
      Type.Literal("failed"),
    ]),
    sequence: counter,
    deviceClockMs: counter,
    carrierAt: Type.Union([Type.Null(), carrierAtSchema]),
    reason: Type.Union([Type.Null(), reasonCode]),
  },
  strict,
);
export type CobotObserved = Static<typeof cobotObservedMessageSchema>;

/**
 * What the device fleet Actor gives a run's Durable Object about the run's
 * devices (Plan 24 S4), in the order that the gateway sent it. A fault is the
 * `health` report of a watched device; `connection_lost` names the open
 * dispatches that a lost gateway socket left with an unknown result;
 * `device_revoked` says that a person revoked the device on the Devices page
 * (Plan 24 S6).
 */
export type CobotRunSignal =
  | Readonly<{ kind: "report"; report: CobotReport }>
  | Readonly<{ kind: "clock"; clock: CobotClock }>
  | Readonly<{ kind: "observed"; observed: CobotObserved }>
  | Readonly<{
      kind: "fault";
      sourceKey: string;
      faultCode: string | null;
      at: number;
    }>
  | Readonly<{
      kind: "connection_lost";
      requestIds: readonly string[];
      at: number;
    }>
  | Readonly<{ kind: "device_revoked"; sourceKey: string; at: number }>;
