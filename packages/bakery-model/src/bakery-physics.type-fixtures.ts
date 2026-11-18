import type {
  PhysicsImport,
  PhysicsRackSequence,
  PhysicsOutcome,
  PhysicsRecording,
  PhysicsRequest,
  PhysicsFixture,
  PhysicsPose,
  PhysicsExecutionIdentity,
  PersistentPhysicsMotion,
  PersistentPhysicsScene,
} from "./bakery-physics.ts";
import type { VariantBy } from "@seams/type-utils";

// @ts-expect-error A failure cannot carry success evidence.
const mixed: PhysicsOutcome = {
  kind: "failed",
  step: 0,
  reason: "collision",
  trayDisposition: "unknown",
  evidence: {
    positionErrorM: 0,
    orientationErrorRad: 0,
    linearSpeedMps: 0,
    angularSpeedRadps: 0,
    settledSeconds: 1,
  },
};
declare const acceptedRecording: PhysicsRecording;
// @ts-expect-error Rejected imports cannot contain an accepted recording.
const rejected: PhysicsImport = {
  kind: "rejected",
  message: "invalid",
  recording: acceptedRecording,
};
type UnvalidatedRecording = Omit<PhysicsRecording, symbol>;
declare const external: UnvalidatedRecording;
// @ts-expect-error Only the boundary parser supplies the private validation brand.
const forged: PhysicsRecording = { ...external };
declare const rawPersistentMotion: Omit<PersistentPhysicsMotion, symbol>;
// @ts-expect-error Raw samples and geometry need the persistent scene parser.
const forgedPersistentMotion: PersistentPhysicsMotion = {
  ...rawPersistentMotion,
};
// @ts-expect-error Persistent progress cannot become terminal evidence by a cast.
const forgedTerminal = rawPersistentMotion as PhysicsRecording;
void [forgedPersistentMotion, forgedTerminal];
declare const rawPersistentScene: Omit<PersistentPhysicsScene, symbol>;
// @ts-expect-error Scene mappings require validation of the retained visual identity.
const forgedPersistentScene: PersistentPhysicsScene = { ...rawPersistentScene };
void forgedPersistentScene;
declare const ovenRequest: VariantBy<
  PhysicsRequest,
  "bakeryTaskId",
  "table-to-oven"
>;
// @ts-expect-error A rack transfer cannot have a closed-door case.
const invalidTask: PhysicsRequest = {
  ...ovenRequest,
  bakeryTaskId: "table-to-rack",
  case: "closed-door",
};
const ovenPose: PhysicsPose = [0, 0, 0, 1, 0, 0, 0];
// @ts-expect-error Rack fixtures cannot carry oven pose data.
const invalidFixture: PhysicsFixture = {
  kind: "rack",
  pose: ovenPose,
};
// @ts-expect-error Oven fixtures require a fixed door angle and visual fingerprint.
const incompleteOven: PhysicsFixture = {
  kind: "maruzen-oven",
  pose: [0, 0, 0, 1, 0, 0, 0],
};
void [mixed, rejected, forged, invalidTask, invalidFixture, incompleteOven];

// @ts-expect-error Native requests require a runtime hash as well as the controller hash.
const incompleteRuntime: PhysicsExecutionIdentity = {
  controller: "bakery-native",
  controllerHash: "controller",
};
declare const nativeIdentity: VariantBy<
  PhysicsExecutionIdentity,
  "controller",
  "bakery-native"
>;
// @ts-expect-error A spread cannot attach native hashes to reference provenance.
const mixedProvenance: PhysicsExecutionIdentity = {
  ...nativeIdentity,
  controller: "python-reference",
};
// @ts-expect-error Incompatible controller branches cannot be directly cast.
const castReference = nativeIdentity as VariantBy<
  PhysicsExecutionIdentity,
  "controller",
  "python-reference"
>;
void [incompleteRuntime, mixedProvenance, castReference];

// @ts-expect-error Combined fixtures require oven pose, door angle and visual identity.
const incompleteCombined: PhysicsFixture = { kind: "oven-and-rack" };
declare const rawRackSequence: Omit<PhysicsRackSequence, symbol>;
// @ts-expect-error A spread cannot bypass continuation validation.
const forgedRackSequence: PhysicsRackSequence = { ...rawRackSequence };
void [incompleteCombined, forgedRackSequence];

// Selection is required after the import boundary, including broad spreads.
declare const requestWithoutRobot: Omit<PhysicsRequest, "robot">;
// @ts-expect-error A validated request must identify its robot.
const missingRobot: PhysicsRequest = { ...requestWithoutRobot };
// @ts-expect-error Unknown robot models cannot enter the execution domain.
const unknownRobot: PhysicsRequest = { ...ovenRequest, robot: "new-cobot" };
void [missingRobot, unknownRobot];

const { ingredients: omittedIngredients, ...withoutIngredients } = ovenRequest;
// @ts-expect-error Every current request requires its ingredient load.
const missingIngredients: PhysicsRequest = withoutIngredients;
const { clampForceN: omittedClamp, ...withoutClamp } = ovenRequest;
// @ts-expect-error Every current request requires its clamp force assumption.
const missingClamp: PhysicsRequest = withoutClamp;
void [omittedIngredients, omittedClamp, missingIngredients, missingClamp];

const missingIngredientPosition: PhysicsRequest = {
  ...ovenRequest,
  // @ts-expect-error A spread cannot omit the ingredient position.
  ingredients: { massKg: 1 },
};
const textIngredientMass: PhysicsRequest = {
  ...ovenRequest,
  // @ts-expect-error Ingredient mass must be numeric at the execution boundary.
  ingredients: { massKg: "1", forwardMm: 0, lateralMm: 0 },
};
void [missingIngredientPosition, textIngredientMass];
