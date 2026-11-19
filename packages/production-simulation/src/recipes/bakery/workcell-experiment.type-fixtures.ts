import type {
  WorkcellExperiment,
  ExperimentImport,
} from "./workcell-experiment.ts";
import {
  compileCycleInput,
  type WorkcellInput,
  type TransferInput,
} from "./workcell-input.ts";
import type {
  PhysicsRecording,
  PhysicsCyclePlan,
  PhysicsRackPlan,
  PhysicsRackSequence,
} from "@purin-labs/bakery-model/bakery-physics";
import type { Variant, VariantBy } from "@purin-labs/type-utils";

declare const input: WorkcellInput;
declare const recording: PhysicsRecording;
declare const experiment: WorkcellExperiment;
declare const recorded: Variant<WorkcellExperiment, "recorded">;
declare const cycle: VariantBy<WorkcellExperiment, "mode", "oven-cycle">;
declare const failedLoad: VariantBy<
  WorkcellExperiment,
  "mode",
  "cycle-loading-failed"
>;
declare const transfer: TransferInput;
declare const plan: PhysicsCyclePlan;
declare const rackPlan: PhysicsRackPlan;
declare const rackSequence: PhysicsRackSequence;
declare const rackExperiment: VariantBy<
  WorkcellExperiment,
  "mode",
  "rack-cycle"
>;

// @ts-expect-error A raw request tuple requires the rack-plan boundary parser.
const rawRackPlan: PhysicsRackPlan = {
  cycle: rackPlan.cycle,
  rackRequest: rackPlan.rackRequest,
  rackHandoffDigest: rackPlan.rackHandoffDigest,
};
// @ts-expect-error A transfer cannot be cast into a validated three-operation plan.
const castRackPlan = transfer as PhysicsRackPlan;
// @ts-expect-error A two-leg cycle cannot carry a three-leg recording through a spread.
const mixedRackRecording: WorkcellExperiment = {
  ...cycle,
  recording: rackSequence,
};
// @ts-expect-error A rack run cannot inherit an unrelated transfer input.
const mixedRackInput: WorkcellExperiment = {
  ...rackExperiment,
  input: transfer,
};
// @ts-expect-error A complete rack sequence cannot be replaced with its last leg.
const lostRackPredecessors: WorkcellExperiment = {
  ...rackExperiment,
  recording: rackSequence.racking,
};

// @ts-expect-error Raw input cannot construct a validated experiment.
const forged: WorkcellExperiment = { kind: "pending", input };
// @ts-expect-error Recorded evidence cannot disappear through a lifecycle spread.
const missingEvidence: WorkcellExperiment = {
  ...recorded,
  kind: "pending",
};
// @ts-expect-error A pending experiment cannot carry a recording.
const pendingEvidence: WorkcellExperiment = {
  ...experiment,
  kind: "pending",
  recording,
};
// @ts-expect-error A rejected parse cannot carry an executable experiment.
const rejected: ExperimentImport = {
  kind: "rejected",
  message: "Invalid",
  experiment,
};

// @ts-expect-error A saved cycle cannot inherit a single-transfer input.
const mixedInput: WorkcellExperiment = { ...cycle, input: transfer };
// @ts-expect-error A saved cycle requires both recordings, not an arbitrary outbound recording.
const partialCycle: WorkcellExperiment = { ...cycle, recording };
// @ts-expect-error Failed loading cannot acquire a successful loading recording through a spread.
const contradictoryFailure: WorkcellExperiment = {
  ...failedLoad,
  recording: cycle.recording.loading,
};
// @ts-expect-error A raw pair must cross the cycle-plan parser or sequence builder.
const rawPlan: PhysicsCyclePlan = {
  request: plan.request,
  returnRequest: plan.returnRequest,
  handoffDigest: plan.handoffDigest,
};
// @ts-expect-error A single transfer cannot be cast into a validated cycle plan.
const castPlan = transfer as PhysicsCyclePlan;
// @ts-expect-error Cycle compilation requires the validated pair, beyond one loading request.
compileCycleInput(plan.request, "60", "cold-cell-1");

void [
  rawRackPlan,
  castRackPlan,
  mixedRackRecording,
  mixedRackInput,
  lostRackPredecessors,
  forged,
  missingEvidence,
  pendingEvidence,
  rejected,
  mixedInput,
  partialCycle,
  contradictoryFailure,
  rawPlan,
  castPlan,
];

const missingPresentation: WorkcellExperiment = {
  ...experiment,
  // @ts-expect-error Every normalized saved run carries a canvas presentation.
  positions: undefined,
};
void missingPresentation;
