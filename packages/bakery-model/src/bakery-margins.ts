/**
 * The margins of one robot operation against the robot's rated limits, as
 * the Rust engine reports them in a terminal outcome
 * (`crates/bakery-native/src/limits.rs`, Refactor 16 step 7): the peak
 * speed of each joint against its rated speed, the time at each motor's
 * torque clamp, the deepest contact of the tray or the tool, and the slip
 * of the grip on the carried tray.
 *
 * The rated values, their source file and the warning bounds come only
 * from the engine's reply; this module keeps no copy of them. An engine
 * before that release reports no margins, and a plan that fails before its
 * first step has none: a reader then shows "not measured".
 */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { textLimit } from "@purin-labs/contract-schema";

const Closed = { additionalProperties: false } as const;
const Measure = Type.Number({ minimum: 0 });
const Joint = textLimit(Type.String({ minLength: 1, maxLength: 80 }));
/** The two geometries of a contact, by their model names. */
const ContactPair = Type.Array(
  textLimit(Type.String({ minLength: 1, maxLength: 120 })),
  {
    minItems: 2,
    maxItems: 2,
  },
);
const Nullable = <T extends TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);

const Rating = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("rated"),
      value: Type.Number({ exclusiveMinimum: 0 }),
    },
    Closed,
  ),
  Type.Object({ kind: Type.Literal("no-rated-value") }, Closed),
]);

const JointMargin = Type.Object(
  {
    joint: Joint,
    peakSpeedRadS: Measure,
    ratedSpeed: Rating,
    torqueClampNm: Measure,
    ratedTorque: Rating,
    clampSeconds: Measure,
    longestClampSeconds: Measure,
  },
  Closed,
);

const MarginWarning = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("torque-clamp"),
      joint: Joint,
      seconds: Measure,
      boundSeconds: Measure,
    },
    Closed,
  ),
  Type.Object(
    { kind: Type.Literal("penetration"), valueM: Measure, boundM: Measure },
    Closed,
  ),
  Type.Object(
    { kind: Type.Literal("slip"), valueM: Measure, boundM: Measure },
    Closed,
  ),
]);

const Overspeed = Type.Object(
  { joint: Joint, peakRadS: Measure, ratedRadS: Measure },
  Closed,
);

/** The `margins` of a completed, failed or recovered outcome. */
export const OperationMargins = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    ratingSource: textLimit(Type.String({ minLength: 1, maxLength: 200 })),
    measuredSeconds: Measure,
    joints: Type.Array(JointMargin, { minItems: 6, maxItems: 6 }),
    peakPenetrationM: Measure,
    deepestContact: Nullable(ContactPair),
    peakSlipM: Measure,
    warnings: Type.Array(MarginWarning, { maxItems: 8 }),
    speedRatingScale: Type.Optional(
      Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }),
    ),
    overspeed: Nullable(Overspeed),
  },
  Closed,
);
export type OperationMargins = Static<typeof OperationMargins>;
type MarginWarning = Static<typeof MarginWarning>;

/** The margins of an outcome, or an error that names the first bad field. */
export function parseOperationMargins(value: unknown): OperationMargins {
  if (Value.Check(OperationMargins, value)) return value;
  const [first] = Value.Errors(OperationMargins, value);
  throw new Error(
    `Invalid operation margins${first === undefined ? "" : `: ${first.instancePath || "/"} ${first.message}`}`,
  );
}

/**
 * What the robot comparison and the agent show for one operation: the joint
 * with the least speed margin, the longest time at a torque clamp, the
 * deepest contact, the slip, and one plain line for each warning or failure.
 */
export const MarginSummary = Type.Union([
  Type.Object({ kind: Type.Literal("not-measured") }, Closed),
  Type.Object(
    {
      kind: Type.Literal("measured"),
      verdict: Type.Union([
        Type.Literal("within"),
        Type.Literal("warning"),
        Type.Literal("failed"),
      ]),
      tightestJoint: Type.Object(
        {
          joint: Joint,
          peakSpeedRadS: Measure,
          ratedSpeedRadS: Nullable(Measure),
        },
        Closed,
      ),
      longestClamp: Type.Object(
        {
          joint: Joint,
          seconds: Measure,
          clampNm: Measure,
          ratedTorqueNm: Nullable(Measure),
        },
        Closed,
      ),
      peakPenetrationM: Measure,
      deepestContact: Nullable(ContactPair),
      peakSlipM: Measure,
      // One speed failure, a clamp warning for each of six joints, one
      // penetration and one slip warning.
      lines: Type.Array(textLimit(Type.String({ maxLength: 400 })), {
        maxItems: 9,
      }),
    },
    Closed,
  ),
]);
export type MarginSummary = Static<typeof MarginSummary>;

/** The operations of one simulation and the margins of each. */
export const OperationMarginSummaries = Type.Array(
  Type.Object(
    {
      operation: Type.Union([
        Type.Literal("transfer"),
        Type.Literal("loading"),
        Type.Literal("unloading"),
        Type.Literal("racking"),
      ]),
      margins: MarginSummary,
    },
    Closed,
  ),
  { minItems: 1, maxItems: 3 },
);
export type OperationMarginSummaries = Static<typeof OperationMarginSummaries>;

function rated(rating: Static<typeof Rating>): number | null {
  return rating.kind === "rated" ? rating.value : null;
}

function share(joint: Static<typeof JointMargin>): number {
  const rating = rated(joint.ratedSpeed);
  return rating === null ? -1 : joint.peakSpeedRadS / rating;
}

function millimetres(metres: number): string {
  return (metres * 1000).toFixed(1);
}

function warningLine(
  warning: MarginWarning,
  contact: readonly string[] | null,
): string {
  switch (warning.kind) {
    case "torque-clamp":
      return `${warning.joint} stayed at its torque limit for ${Math.round(warning.seconds * 1000)} ms. The bound is ${Math.round(warning.boundSeconds * 1000)} ms.`;
    case "penetration":
      return `A contact of the tray or the tool went ${millimetres(warning.valueM)} mm deep${contact === null ? "" : ` (${contact.join(" on ")})`}. The bound is ${millimetres(warning.boundM)} mm.`;
    case "slip":
      return `The tray slid ${millimetres(warning.valueM)} mm in the gripper. The bound is ${millimetres(warning.boundM)} mm.`;
  }
}

/** The summary of an outcome's margins; `undefined` is "not measured". */
export function summarizeMargins(
  margins: OperationMargins | undefined,
): MarginSummary {
  // The contract holds six joints, so a measured outcome has a first one.
  const first = margins?.joints[0];
  if (margins === undefined || first === undefined)
    return { kind: "not-measured" };
  let tightest = first;
  let clamped = first;
  for (const joint of margins.joints) {
    if (
      share(joint) > share(tightest) ||
      (share(tightest) < 0 && joint.peakSpeedRadS > tightest.peakSpeedRadS)
    )
      tightest = joint;
    if (joint.longestClampSeconds > clamped.longestClampSeconds)
      clamped = joint;
  }
  const lines: string[] = [];
  const overspeed = margins.overspeed;
  if (overspeed !== null)
    lines.push(
      `${overspeed.joint} reached ${overspeed.peakRadS.toFixed(2)} rad/s, over its limit of ${overspeed.ratedRadS.toFixed(2)} rad/s${margins.speedRatingScale === undefined ? "" : ` (a test scale of ${margins.speedRatingScale} on its rating)`}. The move failed.`,
    );
  for (const warning of margins.warnings)
    lines.push(warningLine(warning, margins.deepestContact));
  return {
    kind: "measured",
    verdict:
      overspeed !== null
        ? "failed"
        : margins.warnings.length > 0
          ? "warning"
          : "within",
    tightestJoint: {
      joint: tightest.joint,
      peakSpeedRadS: tightest.peakSpeedRadS,
      ratedSpeedRadS: rated(tightest.ratedSpeed),
    },
    longestClamp: {
      joint: clamped.joint,
      seconds: clamped.longestClampSeconds,
      clampNm: clamped.torqueClampNm,
      ratedTorqueNm: rated(clamped.ratedTorque),
    },
    peakPenetrationM: margins.peakPenetrationM,
    deepestContact: margins.deepestContact,
    peakSlipM: margins.peakSlipM,
    lines,
  };
}
