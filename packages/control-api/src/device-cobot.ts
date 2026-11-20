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

const cobotPlaceSchema = Type.Object(
  {
    station: Type.Union([
      Type.Literal("cold_rack"),
      Type.Literal("oven"),
      Type.Literal("cooling_rack"),
    ]),
    shelf: Type.Integer({ minimum: 1, maximum: 12 }),
  },
  strict,
);

const cobotTaskSchema = Type.Union([
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

const cobotTaskStateSchema = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("rejected"),
  Type.Literal("indeterminate"),
]);

const carrierAtSchema = Type.Union([
  Type.Literal("source"),
  Type.Literal("tool"),
  Type.Literal("destination"),
  Type.Literal("unknown"),
]);

const deviceRunStateSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("busy"),
  Type.Literal("paused"),
  Type.Literal("stopped"),
  Type.Literal("estop"),
]);

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

/** Pantry -> gateway: the state of a task, from the controller. */
export const cobotInquireMessageSchema = Type.Object(
  {
    type: Type.Literal("cobot_inquire"),
    requestId: dispatchIdSchema,
    sourceKey,
  },
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

/**
 * Gateway -> Pantry: the clock of each cobot and oven, at most one message a
 * second, only while the gateway's journal holds an open task.
 */
export const cobotClockMessageSchema = Type.Object(
  {
    type: Type.Literal("cobot_clock"),
    clocks: Type.Array(
      Type.Object(
        {
          sourceKey,
          sequence: counter,
          deviceClockMs: counter,
          state: deviceRunStateSchema,
        },
        strict,
      ),
      { minItems: 1, maxItems: 64 },
    ),
  },
  strict,
);

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
