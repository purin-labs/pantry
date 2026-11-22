import type { BrowserPhysicsTask } from "@purin-labs/production-simulation/simulator/browser-physics-task";
import type {
  PreparedRecordingAcceptance,
  RecordingAcceptanceTarget,
} from "./simulator-state";
import type {
  ProductionStart,
  ProductionSource,
  ProductionWorkcells,
} from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import type {
  ProductionAssignment,
  ProductionScenario,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import type {
  NativeBakeryTask,
  NativeHold,
  NativeReservation,
  ResolvedRunInput,
  WorkcellCapability,
  TaskEvent,
  TaskSnapshot,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import type { WaitingAttempt } from "@purin-labs/production-simulation/recipes/bakery/workcell-attempt";
import type { ProductionMaterialState } from "@purin-labs/production-simulation/recipes/bakery/production-material";
import type { Variant } from "@purin-labs/type-utils";

declare const plan: ProductionWorkcells;
declare const scenario: ProductionScenario;
declare const task: NativeBakeryTask;
declare const pending: WaitingAttempt;
declare const hold: NativeHold;
declare const reservation: NativeReservation;
declare const input: ResolvedRunInput;
declare const capability: WorkcellCapability;
declare const failure: Variant<NativeHold, "failed">["failure"];
// @ts-expect-error Held material cannot release its clamp reservation.
const releasedFailure: ProductionMaterialState = {
  kind: "recovery-required",
  location: "unknown",
  tool: "released",
};
// @ts-expect-error Manual material custody requires the assigned baker.
const unownedStaging: ProductionMaterialState = {
  kind: "staging",
  location: "baker",
  tool: "reserved",
};
const missingMaterial = {
  ...plan.operations[0]!,
  material: undefined,
};
// @ts-expect-error A spread cannot remove a compiled operation's material contract.
const unboundOperation: ProductionWorkcells["operations"][number] =
  missingMaterial;
const missingManualTasks: ProductionWorkcells = {
  ...plan,
  // @ts-expect-error Spreading a compiled plan cannot erase authored task constraints.
  manualTasks: undefined,
};
const missingProcedure: ProductionWorkcells = {
  ...plan,
  // @ts-expect-error Procedure identity is explicit, including local plans with null identity.
  procedureFingerprint: undefined,
};
// @ts-expect-error External production definitions require compilation and a fingerprint.
const raw: ProductionWorkcells = {
  settings: plan.settings,
  variant: "normal",
  fingerprint: plan.fingerprint,
  operations: plan.operations,
};
// @ts-expect-error Production scenarios must pass boundary validation.
const forgedScenario: ProductionScenario = {
  id: "raw",
  name: "Raw",
  note: "Assumed",
  procedureId: "procedure",
  sourceFingerprint: "source",
  definitionFingerprint: "definition",
  settings: plan.settings,
  variant: "normal",
  assignments: [],
};
// @ts-expect-error A native task cannot be cast into a compiled production plan.
const castPlan = task as ProductionWorkcells;
// @ts-expect-error Local production cannot claim a shared definition.
const localWithDefinition: ProductionSource = {
  kind: "local",
  definition: scenario,
};
// @ts-expect-error Shared production requires a validated definition.
const sharedWithoutDefinition: ProductionSource = { kind: "shared" };
// @ts-expect-error Shared task timing must be explicit in normalized assignments.
const missingStart: ProductionAssignment = {
  batchId: "A",
  tray: 1,
  workerId: "human-1",
  dependsOn: [],
};
const premature: NativeBakeryTask = {
  ...task,
  // @ts-expect-error A pending reservation cannot manufacture a timed native task.
  operation: { ...task.operation, attempt: pending },
};
// @ts-expect-error Native completion cannot carry assumed simulation evidence.
const fabricated: TaskEvent = {
  kind: "completed",
  time: task.end,
  task,
  evidence: {
    source: "assumed-simulation",
    bakeryTaskId: task.id,
    time: task.end,
  },
};
// @ts-expect-error A native completed projection requires native evidence.
const projected: TaskSnapshot = {
  kind: "completed",
  task,
  evidence: {
    source: "assumed-simulation",
    bakeryTaskId: task.id,
    time: task.end,
  },
};
// @ts-expect-error Awaiting evidence has no settlement time.
const inventedSettlement: NativeHold = {
  ...hold,
  kind: "awaiting-evidence",
  settledTime: 30,
};
// @ts-expect-error A human-only run cannot carry a native workcell capability.
const incompatibleRun: ResolvedRunInput = {
  ...input,
  source: "financier",
  workcells: [capability],
};
// @ts-expect-error A released reservation needs a release time.
const unclosedReservation: NativeReservation = {
  ...reservation,
  kind: "released",
  end: undefined,
};
// @ts-expect-error An evidence wait cannot contain a terminal failure.
const prematureFailure: NativeHold = {
  ...hold,
  kind: "awaiting-evidence",
  failure,
};
void [
  releasedFailure,
  unownedStaging,
  unboundOperation,
  missingManualTasks,
  missingProcedure,
  raw,
  scenario,
  forgedScenario,
  castPlan,
  localWithDefinition,
  sharedWithoutDefinition,
  missingStart,
  premature,
  fabricated,
  projected,
  inventedSettlement,
  incompatibleRun,
  unclosedReservation,
  prematureFailure,
];

// @ts-expect-error Human restaging cannot carry integration state from another cell.
const crossCellPhysics: ProductionStart = {
  kind: "restaged",
  predecessorId: "source",
  digest: "digest",
  handoff: plan.operations[0]!.handoff!,
};
// @ts-expect-error Human restaging requires the accepted predecessor's identity.
const unboundHumanTransfer: ProductionStart = {
  kind: "restaged",
  digest: "digest",
};
void crossCellPhysics;
void unboundHumanTransfer;

declare const unpreparedCandidate: RecordingAcceptanceTarget;
// @ts-expect-error Accepting a candidate requires the compiled result and its exact source plan.
const skippedSuccessorBinding: PreparedRecordingAcceptance = {
  ...unpreparedCandidate,
};
void skippedSuccessorBinding;

declare const preparedTask: Variant<
  BrowserPhysicsTask,
  "request" | "prepared-request"
>;
// @ts-expect-error Preparing a request cannot also resume another model's state through a spread.
const mixedPhysicsStart: BrowserPhysicsTask = {
  ...preparedTask,
  handoff: plan.operations[0]!.handoff!,
};
void mixedPhysicsStart;

const { cellRobots: omittedCells, ...withoutCells } = plan;
// @ts-expect-error Every compiled run requires an explicit robot assignment for each cell.
const missingCellRobots: ProductionWorkcells = withoutCells;
// @ts-expect-error An unused cell cannot contain a robot.
const unusedRobot: import("@purin-labs/production-simulation/recipes/bakery/production-workcells").CellRobot =
  {
    kind: "unused",
    robot: plan.operations[0]!.attempt.input.request.robot,
  };
// @ts-expect-error An assigned cell must name its robot.
const unnamedRobot: import("@purin-labs/production-simulation/recipes/bakery/production-workcells").CellRobot =
  {
    kind: "assigned",
  };
void [omittedCells, missingCellRobots, unusedRobot, unnamedRobot];

// Ingredient edits carry a complete load through the same rehearsal edit boundary.
const incompleteIngredientEdit: import("@purin-labs/production-simulation/recipes/bakery/production-workcells").RehearsalEdit =
  {
    kind: "ingredients",
    batchId: "A",
    // @ts-expect-error Position is required when changing ingredient mass.
    ingredients: { massKg: 1 },
  };
const mixedIngredientEdit: import("@purin-labs/production-simulation/recipes/bakery/production-workcells").RehearsalEdit =
  {
    kind: "ingredients",
    batchId: "A",
    ingredients: { massKg: 1, forwardMm: 0, lateralMm: 0 },
    // @ts-expect-error A load edit cannot also reassign the cell.
    cellId: "cold-cell-2",
  };
void [incompleteIngredientEdit, mixedIngredientEdit];
