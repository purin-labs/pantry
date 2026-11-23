import { Type, type Static, type TSchema } from "typebox";
import {
  recordParser,
  NonNegativeInteger,
  PositiveInteger,
} from "@purin-labs/contract-schema";

/**
 * Plan 24 S4: one approved bake run with two cobots and the oven, as the
 * Bakes page, the agent and the journeys read it. The canvas, the timeline
 * and the positions of the mould groups all read `view`, so they agree on
 * each task. Every observed value comes from a device receipt; a position
 * that no receipt proves is `unknown`.
 *
 * S6: a hold is the one visible disposition of an uncertain outcome. A person
 * settles it with what they saw (`seen`), and settling never sends a move
 * again. `unloadRisk` is the over-bake risk of a late unload.
 *
 * S5: a run in `shadow` mode sends nothing. The controller runs the bake from
 * its own script, and the run matches each observed move to its planned task
 * (`shadow`). The same `view` shows the observed times of those moves.
 */

const text = Type.String({ minLength: 1 });
const time = NonNegativeInteger;
const seconds = Type.Number();
function nullable<T extends TSchema>(schema: T) {
  return Type.Union([schema, Type.Null()]);
}

const placeSchema = Type.Object({
  station: Type.Union([
    Type.Literal("cold_rack"),
    Type.Literal("oven"),
    Type.Literal("cooling_rack"),
  ]),
  shelf: PositiveInteger,
});

const taskSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("move_mould_group"),
    mouldGroup: PositiveInteger,
    from: placeSchema,
    to: placeSchema,
  }),
  Type.Object({
    kind: Type.Literal("bake"),
    programSeconds: PositiveInteger,
    temperatureC: PositiveInteger,
  }),
]);

const carrierAt = Type.Union([
  Type.Literal("source"),
  Type.Literal("tool"),
  Type.Literal("destination"),
  Type.Literal("unknown"),
]);

const stepKind = Type.Union([
  Type.Literal("load"),
  Type.Literal("bake"),
  Type.Literal("unload"),
]);

const taskViewSchema = Type.Object({
  key: text,
  kind: stepKind,
  mouldGroup: nullable(PositiveInteger),
  sourceKey: text,
  task: taskSchema,
  requestId: nullable(text),
  state: Type.Union([
    Type.Literal("planned"),
    Type.Literal("ready"),
    Type.Literal("dispatched"),
    Type.Literal("accepted"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("rejected"),
    Type.Literal("failed"),
  ]),
  planned: Type.Object({ startSeconds: seconds, endSeconds: seconds }),
  observed: Type.Object({
    startSeconds: nullable(seconds),
    endSeconds: nullable(seconds),
    observedSeconds: nullable(seconds),
  }),
  phase: nullable(Type.String()),
  progress: nullable(Type.Number()),
  carrierAt: nullable(carrierAt),
  reason: nullable(Type.String()),
});
export type BakeRunTaskView = Static<typeof taskViewSchema>;

const positionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("place"), place: placeSchema }),
  Type.Object({ kind: Type.Literal("tool"), sourceKey: text }),
  Type.Object({ kind: Type.Literal("unknown") }),
]);

const viewSchema = Type.Object({
  runId: text,
  status: text,
  logicalSeconds: seconds,
  tasks: Type.Array(taskViewSchema),
  groups: Type.Array(
    Type.Object({
      mouldGroup: PositiveInteger,
      position: positionSchema,
      basis: Type.Union([
        Type.Literal("declared"),
        Type.Literal("receipt"),
        Type.Literal("observed"),
      ]),
    }),
  ),
  disposition: nullable(
    Type.Object({
      kind: Type.Literal("disposition"),
      step: text,
      requestId: Type.String(),
      sourceKey: text,
      carrierAt,
      reason: text,
    }),
  ),
});
export type BakeRunView = Static<typeof viewSchema>;

const shadowMatchSchema = Type.Object({
  observationId: text,
  sourceKey: text,
  task: taskSchema,
  state: nullable(
    Type.Union([
      Type.Literal("started"),
      Type.Literal("completed"),
      Type.Literal("failed"),
    ]),
  ),
  carrierAt: nullable(carrierAt),
  reason: nullable(Type.String()),
  observed: Type.Object({
    startSeconds: nullable(seconds),
    endSeconds: nullable(seconds),
  }),
  /** The planned task with the same move, or null for a move outside the plan. */
  planned: nullable(
    Type.Object({
      key: text,
      sourceKey: text,
      startSeconds: seconds,
      endSeconds: seconds,
    }),
  ),
  sameCobot: nullable(Type.Boolean()),
  /** Observed minus planned, in seconds. */
  difference: Type.Object({
    startSeconds: nullable(seconds),
    endSeconds: nullable(seconds),
  }),
});
export type BakeShadowMatch = Static<typeof shadowMatchSchema>;

const modeSchema = Type.Union([
  Type.Literal("shadow"),
  Type.Literal("approval"),
]);

const holdSchema = Type.Object({
  code: Type.Union([
    Type.Literal("failed_attempt"),
    Type.Literal("result_unknown"),
    Type.Literal("stale_evidence"),
    Type.Literal("evidence_lost"),
    Type.Literal("device_fault"),
    Type.Literal("device_not_ready"),
    Type.Literal("dispatch_unsent"),
    Type.Literal("dispatch_refused"),
    Type.Literal("device_revoked"),
    Type.Literal("engine_stop"),
  ]),
  message: text,
  step: nullable(text),
  requestId: nullable(text),
  sourceKey: nullable(text),
  at: time,
});
export type BakeRunHold = Static<typeof holdSchema>;

/** Where a person saw the mould group of a held task. */
const seenSchema = Type.Union([
  Type.Literal("source"),
  Type.Literal("tool"),
  Type.Literal("destination"),
  Type.Literal("lost"),
]);
export type BakeRunSeen = Static<typeof seenSchema>;

const settlementSchema = Type.Object({
  holdCode: holdSchema.properties.code,
  step: nullable(text),
  decision: Type.Union([Type.Literal("continue"), Type.Literal("stop")]),
  seen: nullable(seenSchema),
  by: text,
  at: time,
});
export type BakeRunSettlement = Static<typeof settlementSchema>;

const role = Type.Union([
  Type.Literal("owner"),
  Type.Literal("admin"),
  Type.Literal("operator"),
]);

const runStateSchema = Type.Union([
  Type.Literal("not_started"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("held"),
  Type.Literal("completed"),
  Type.Literal("stopped"),
  Type.Literal("checked"),
]);
export type BakeRunState = Static<typeof runStateSchema>;

const runSchema = Type.Object({
  runId: text,
  proposalId: Type.String({ pattern: "^bake_[a-f0-9]{24}$" }),
  productName: text,
  /** `shadow`: the run watches and sends nothing (S5). */
  mode: modeSchema,
  state: runStateSchema,
  /** Why the run did not start, while it has not started. */
  problem: nullable(Type.Object({ code: text, message: text })),
  hold: nullable(holdSchema),
  approval: nullable(
    Type.Object({
      by: text,
      role,
      via: Type.Union([Type.Literal("portal"), Type.Literal("slack")]),
      at: time,
    }),
  ),
  devices: Type.Array(
    Type.Object({
      deviceId: text,
      sourceKey: text,
      name: text,
      role: Type.Union([Type.Literal("cobot"), Type.Literal("oven")]),
    }),
  ),
  oven: nullable(
    Type.Object({
      programSeconds: PositiveInteger,
      temperatureC: PositiveInteger,
    }),
  ),
  startedAt: nullable(time),
  endedAt: nullable(time),
  check: nullable(
    Type.Object({
      by: text,
      role,
      at: time,
      goodPieces: NonNegativeInteger,
      receiptId: text,
    }),
  ),
  /** The dispatch record of each task the run sent, oldest first. */
  dispatches: Type.Array(
    Type.Object({
      requestId: text,
      step: text,
      deviceId: text,
      sourceKey: text,
      task: taskSchema,
      state: Type.Union([
        Type.Literal("written"),
        Type.Literal("refused"),
        Type.Literal("sent"),
        Type.Literal("unsent"),
      ]),
      writtenAt: time,
      sentAt: nullable(time),
    }),
  ),
  /**
   * An unload that did not start within the recipe's grace time after the
   * bake ended: the pieces can over-bake in the hot oven.
   */
  unloadRisk: nullable(
    Type.Object({
      step: text,
      lateSeconds: Type.Number({ minimum: 0 }),
      graceSeconds: Type.Number({ minimum: 0 }),
      /** When the person on shift was told in Slack, or null. */
      notifiedAt: nullable(time),
    }),
  ),
  /** Each hold that a person settled, oldest first. */
  settlements: Type.Array(settlementSchema),
  view: nullable(viewSchema),
  /** A shadow run's observed moves, each matched to its planned task. */
  shadow: nullable(
    Type.Object({
      matches: Type.Array(shadowMatchSchema),
      /** Planned tasks that no observed move made yet. */
      unobserved: Type.Array(text),
    }),
  ),
});
export type BakeRunRecord = Static<typeof runSchema>;

const readSchema = Type.Object({
  ok: Type.Literal(true),
  run: runSchema,
  access: Type.Object({ mayOperate: Type.Boolean() }),
});
export type BakeRunRead = Static<typeof readSchema>;

const actionInputSchema = Type.Union([
  Type.Object(
    {
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("stop"),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("settle"),
      decision: Type.Union([Type.Literal("continue"), Type.Literal("stop")]),
      /** Where the person saw the mould group; a failed task needs it. */
      seen: Type.Optional(seenSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("check"),
      goodPieces: Type.Integer({ minimum: 0, maximum: 10_000 }),
    },
    { additionalProperties: false },
  ),
]);
export type BakeRunActionInput = Static<typeof actionInputSchema>;

const decodeRead = recordParser(readSchema);
const decodeAction = recordParser(actionInputSchema);

export function parseBakeRunRead(value: unknown): BakeRunRead {
  const result = decodeRead(value);
  if (!result.ok) throw new Error("The bake run answer is not valid.");
  return result.value;
}

/** Null when the body is not a run action. */
export function parseBakeRunActionInput(
  value: unknown,
): BakeRunActionInput | null {
  const result = decodeAction(value);
  return result.ok ? result.value : null;
}
