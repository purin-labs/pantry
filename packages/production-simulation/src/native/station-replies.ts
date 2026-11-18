/**
 * The replies of the two station cells (espresso and pour-over), as the Rust
 * engine types them in `crates/bakery-native/src/station_reply.rs`,
 * `espresso_cell.rs` and `pour_over_cell.rs`. A station reply crosses inside
 * its namespace envelope (`{ kind: "espresso", reply }`). The cell adapter
 * checks each one with this contract before it reads it; the readers after it
 * check only what depends on the request, such as steps and identities.
 *
 * An object may carry fields that no reader here uses (the appliance
 * controller state, the brew report): the schemas name what the Portal reads.
 */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const Hex = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Count = Type.Integer({ minimum: 0 });
const Finite = Type.Number();
const Vector = (length: number) =>
  Type.Array(Finite, { minItems: length, maxItems: length });
const Pose = Vector(7);
const Nullable = <T extends TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);

const CheckpointRef = Type.Object({
  digest: Hex,
  byteLength: Count,
  step: Count,
});

/** An appliance world's sample: body poses and its controller state. */
const applianceSample = (controller: string) =>
  Type.Object({
    bodies: Type.Record(Type.String(), Pose),
    controller: Type.Object({ kind: Type.Literal(controller) }),
  });

const EspressoApplianceSample = applianceSample("espresso");
const GrinderSample = applianceSample("motor");

const EspressoSample = Type.Object({
  step: Count,
  appliance: EspressoApplianceSample,
  grinder: Type.Optional(GrinderSample),
});

const PourOverWater = Type.Object({
  kettleG: Finite,
  kettleC: Finite,
  airborneG: Finite,
  absorbedG: Finite,
  freeG: Finite,
  bedC: Finite,
  serverG: Finite,
  serverC: Finite,
  spillG: Finite,
  evaporatedG: Finite,
  pouredG: Finite,
  offBedG: Finite,
  wetRadiusM: Finite,
  flowGS: Finite,
});

/** Arm, kettle, vessels, scale and water: every value the display reads. */
const PourOverSample = Type.Object({
  step: Count,
  joints: Vector(6),
  fingers: Vector(2),
  gripper: Pose,
  kettle: Pose,
  dripper: Pose,
  server: Pose,
  scale: Type.Object({
    readingG: Nullable(Finite),
    tared: Type.Boolean(),
    stable: Type.Boolean(),
    loadKg: Finite,
  }),
  water: PourOverWater,
  stream: Nullable(
    Type.Object({ outlet: Vector(3), velocity: Vector(3), landing: Vector(3) }),
  ),
  control: Type.Object({
    phase: Type.String(),
    stage: Nullable(Type.String()),
    brewS: Nullable(Finite),
    nextTargetG: Nullable(Finite),
    deviations: Type.Array(Type.Object({ kind: Type.String() })),
  }),
  grinder: Type.Optional(GrinderSample),
  report: Type.Optional(Type.Object({ outcome: Type.Object({}) })),
});

/** The fields every station recording names. */
const header = (kind: string) => ({
  schemaVersion: Type.Literal(1),
  kind: Type.Literal(kind),
  cellId: Type.String(),
  runId: Type.String(),
  modelHash: Hex,
  runnerSha256: Hex,
  runtimeSha256: Hex,
  predecessor: Hex,
  checkpoint: Hex,
});

const Contacts = Type.Object({
  kind: Type.Literal("dense"),
  observations: Type.Array(
    Type.Object({ step: Count, pairs: Type.Array(Type.Object({})) }),
  ),
});

const espressoInterval = {
  ...header("espresso-physics-recording"),
  startStep: Count,
  endStep: Count,
  samples: Type.Array(EspressoSample),
};
const EspressoRecording = Type.Object(espressoInterval);
const EspressoSegment = Type.Object({
  ...espressoInterval,
  attemptId: Type.String(),
  sequence: Count,
  events: Type.Array(Type.Never(), { maxItems: 0 }),
  digest: Hex,
});

const PourOverRecording = Type.Object({
  ...header("pour-over-physics-recording"),
  motion: Type.Object({
    kind: Type.Literal("idle"),
    startStep: Count,
    endStep: Count,
    sampleStride: Type.Literal(1),
    samples: Type.Array(PourOverSample),
    contacts: Contacts,
  }),
});
const PourOverSegment = Type.Object({
  ...header("pour-over-physics-recording"),
  attemptId: Type.String(),
  sequence: Count,
  startStep: Count,
  endStep: Count,
  samples: Type.Array(PourOverSample),
  contacts: Contacts,
  events: Type.Array(
    Type.Union([
      Type.Object({
        kind: Type.Literal("phase"),
        step: Count,
        label: Type.String(),
      }),
      Type.Object({ kind: Type.Literal("failure"), step: Count }),
    ]),
  ),
  digest: Hex,
});

const EspressoOutcome = Type.Object({ kind: Type.Literal("completed") });
const PourOverOutcome = Type.Union([
  Type.Object({
    kind: Type.Literal("completed"),
    measurements: Type.Object({}),
    deviations: Type.Array(Type.Object({ kind: Type.String() })),
  }),
  Type.Object({
    kind: Type.Literal("failed"),
    reason: Type.String(),
    disposition: Type.Union([
      Type.Literal("source"),
      Type.Literal("gripped"),
      Type.Literal("unknown"),
    ]),
  }),
]);

/** The reply union of one station, by its segment, recording, outcome and sample. */
function stationReply(
  segment: TSchema,
  recording: TSchema,
  outcome: TSchema,
  sample: TSchema,
) {
  return Type.Union([
    Type.Object({
      kind: Type.Literal("opened"),
      checkpoint: CheckpointRef,
      slot: Type.Object({
        kind: Type.Literal("inactive"),
        generation: Type.Literal(0),
      }),
      operation: Nullable(
        Type.Object({ attemptId: Type.String(), step: Count, sequence: Count }),
      ),
    }),
    Type.Object({
      kind: Type.Literal("started"),
      attemptId: Type.String(),
      plan: Type.Array(Type.String()),
    }),
    Type.Object({
      kind: Type.Literal("advanced"),
      stop: Type.Union([Type.Literal("allowance"), Type.Literal("terminal")]),
      segment,
      checkpoint: CheckpointRef,
      outcome: Nullable(outcome),
      hold: Type.Null(),
    }),
    Type.Object({
      kind: Type.Literal("advanced"),
      stop: Type.Literal("idle"),
      recording,
      checkpoint: CheckpointRef,
      hold: Type.Null(),
    }),
    Type.Object({
      kind: Type.Literal("observed"),
      modelHash: Hex,
      sample,
      grinderSample: Type.Optional(GrinderSample),
    }),
    Type.Object({
      kind: Type.Literal("exported"),
      content: Type.String(),
      checkpoint: CheckpointRef,
      sequence: Count,
    }),
    Type.Object({ kind: Type.Literal("disposed") }),
  ]);
}

const EspressoReply = stationReply(
  EspressoSegment,
  EspressoRecording,
  EspressoOutcome,
  EspressoApplianceSample,
);
const PourOverReply = stationReply(
  PourOverSegment,
  PourOverRecording,
  PourOverOutcome,
  PourOverSample,
);

export type EspressoReply = Static<typeof EspressoReply>;
export type PourOverReply = Static<typeof PourOverReply>;

/** The variant of a reply union that `raw` claims by its kind and stop. */
function variantOf(union: TSchema, raw: unknown): TSchema {
  if (typeof raw !== "object" || raw === null) return union;
  const { kind, stop } = raw as { kind?: unknown; stop?: unknown };
  for (const variant of (union as { anyOf: TSchema[] }).anyOf) {
    const properties = (variant as { properties: Record<string, TSchema> })
      .properties;
    const claims = (property: string, value: unknown) =>
      Value.Check(properties[property] ?? Type.Never(), value);
    if (claims("kind", kind) && (kind !== "advanced" || claims("stop", stop)))
      return variant;
  }
  return union;
}

/**
 * The reply of a station namespace, checked against its contract. The error
 * names the first field of the claimed reply kind that differs.
 */
export function parseStationReply(
  namespace: "espresso" | "pour-over",
  raw: unknown,
):
  | Readonly<{ ok: true; value: EspressoReply | PourOverReply; error?: never }>
  | Readonly<{ ok: false; error: string; value?: never }> {
  const schema = namespace === "espresso" ? EspressoReply : PourOverReply;
  if (Value.Check(schema, raw)) return { ok: true, value: raw };
  const [first] = Value.Errors(variantOf(schema, raw), raw);
  return {
    ok: false,
    error: `A ${namespace} reply differs from its contract${
      first === undefined
        ? ""
        : `: ${first.instancePath || "/"} ${first.message}`
    }`,
  };
}
