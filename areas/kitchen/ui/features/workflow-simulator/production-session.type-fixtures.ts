import type { SimulatorState } from "./simulator-state";
import type { ProductionScenario } from "@purin-labs/bakery-model/bakery-production-scenario";
import type { PhysicsReplay } from "@purin-labs/bakery-model/bakery-physics";
import type { ProductionWorkcells } from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import type {
  ProductionData,
  ProductionDraftIdentity,
  ProductionPending,
} from "./production-session";

declare const plan: ProductionWorkcells;
declare const recording: PhysicsReplay;
declare const definition: ProductionScenario;

// @ts-expect-error Saved-run review requires the source-bound review builder.
const unreviewedRun: ProductionPending = { kind: "run", review: { plan } };
// @ts-expect-error A saved-run review cannot omit its source-bound review.
const missingRunReview: ProductionPending = { kind: "run" };
void unreviewedRun;
void missingRunReview;

// @ts-expect-error A loading session cannot carry an applied run.
const loadingWithRun: ProductionData = { kind: "loading", plan };

const recordingWithRun: ProductionPending = {
  kind: "recording",
  operationId: "batch:A:native:1",
  fingerprint: "fingerprint",
  recording,
  handoff: null,
  // @ts-expect-error A recording candidate cannot also be a saved run.
  plan,
};

const pendingRecording: ProductionPending = {
  kind: "recording",
  operationId: "batch:A:native:1",
  fingerprint: "fingerprint",
  recording,
  handoff: null,
};

// @ts-expect-error Broad spreads cannot smuggle a run into recording review.
const spreadRecordingWithRun: ProductionPending = { ...pendingRecording, plan };

// @ts-expect-error A saved identity has no mutable copy ID.
const savedWithDraftId: ProductionDraftIdentity = {
  kind: "saved",
  definition,
  id: "copy-id",
};

void loadingWithRun;
void recordingWithRun;
void spreadRecordingWithRun;
void savedWithDraftId;

const runningBrowserJob: SimulatorState["browserJob"] = {
  kind: "running",
  generation: 3,
  operationId: "batch:A:native:1",
};
// @ts-expect-error A stopped job carries no execution identity.
const idleWithExecution: SimulatorState["browserJob"] = {
  ...runningBrowserJob,
  kind: "idle",
};
// @ts-expect-error A running job must identify its exact execution generation.
const runningWithoutGeneration: SimulatorState["browserJob"] = {
  kind: "running",
  operationId: "batch:A:native:1",
};
void idleWithExecution;
void runningWithoutGeneration;
