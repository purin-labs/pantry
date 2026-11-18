import type {
  BakeryRunSaveInspection,
  BakeryWorkspaceViewAction,
  BakeryStoreInteriorAction,
  BakeryCameraView,
  BakeryDoorInspection,
  BakeryRehearsalEdit,
  BakeryProductionEdit,
  BakerySurfaceCommandV1,
  BakerySurfaceContextV1,
} from "./bakery-surface.ts";
import type { Variant } from "@seams/type-utils";

declare function acceptWorkspaceView(action: BakeryWorkspaceViewAction): void;
acceptWorkspaceView({ kind: "setCamera", camera: "overhead" });
acceptWorkspaceView({ kind: "setCamera", camera: "operator" });
acceptWorkspaceView({ kind: "setDoorPreview", degrees: 90 });
acceptWorkspaceView({ kind: "setDoorPreview", degrees: null });
// @ts-expect-error A door preview has no camera branch fields.
acceptWorkspaceView({ kind: "setDoorPreview", degrees: 90, camera: "cell" });
const doorAngle = { degrees: 90 };
// @ts-expect-error An angle cannot enter a camera command through a spread.
acceptWorkspaceView({ ...doorAngle, kind: "setCamera", camera: "cell" });
declare function acceptDoor(door: BakeryDoorInspection): void;
// @ts-expect-error An unavailable door has no preview pose.
acceptDoor({ kind: "unavailable", degrees: 90 });
declare function acceptSceneCamera(view: BakeryCameraView): void;
// @ts-expect-error Operator-height framing requires a recording scene.
acceptSceneCamera({ camera: "operator" });
// @ts-expect-error Unknown camera names cannot enter workspace state.
acceptWorkspaceView({ kind: "setCamera", camera: "freeform" });
// @ts-expect-error Camera commands require an explicit desired state.
acceptWorkspaceView({ kind: "setCamera" });
// @ts-expect-error Reset cannot also select a camera.
acceptWorkspaceView({ kind: "resetCamera", camera: "overhead" });
const cameraChoice = { camera: "overhead" as const };
// @ts-expect-error Spreads cannot combine camera selection and reset branches.
acceptWorkspaceView({ ...cameraChoice, kind: "resetCamera" });

const shared = {
  schemaVersion: 1,
  kind: "bakery-workspace",
  surfaceSessionId: "surface-1",
  surfaceEpoch: 1,
  capturedAt: 1,
  comparison: null,
  runOpenReview: null,
  simulation: null,
  supportedCommands: ["inspect_surface", "set_view"],
} as const;

const loadingProduction: BakerySurfaceContextV1 = {
  ...shared,
  active: {
    kind: "production",
    view: { camera: "perspective" },
    pendingOperation: null,
    readiness: "loading",
    panel: "workflow",
    planFingerprint: null,
    variant: null,
    operationCount: 0,
    operations: [],
    selection: null,
    playback: null,
    candidate: null,
    scenarioSaveProposal: null,
    draft: null,
  },
};
void loadingProduction;

declare function discardCandidate(
  command: Variant<BakerySurfaceCommandV1, "discard_candidate">,
): void;
// @ts-expect-error Discard requires the exact candidate reference, including its epoch.
discardCandidate({
  schemaVersion: 1,
  kind: "discard_candidate",
  target: { surfaceSessionId: "surface-1", surfaceEpoch: 1 },
});

const invalidLoadingProduction: BakerySurfaceContextV1 = {
  ...shared,
  active: {
    kind: "production",
    view: { camera: "perspective" },
    pendingOperation: null,
    readiness: "loading",
    // @ts-expect-error loading production cannot claim a ready plan identity
    planFingerprint: "a".repeat(64),
    // @ts-expect-error loading production cannot claim a ready variant
    variant: "normal",
    operationCount: 0,
    operations: [],
    selection: null,
    playback: null,
    candidate: null,
    scenarioSaveProposal: null,
    draft: null,
  },
};
void invalidLoadingProduction;

const invalidMode: BakerySurfaceContextV1 = {
  ...shared,
  active: {
    // @ts-expect-error unknown active workspace modes are rejected
    kind: "robot",
  },
};
void invalidMode;

const missingCursor: BakerySurfaceContextV1 = {
  ...shared,
  // @ts-expect-error shift observations require a playback cursor
  active: {
    kind: "shift",
    source: "sample",
    view: {
      dock: "closed",
      camera: "perspective",
      labels: "auto",
      minimap: false,
      chrome: "shown",
    },
    sourceIdentity: { kind: "sample", id: "financier-sample" },
    variant: "normal",
    selection: { kind: "batch", id: "A", label: "Batch A" },
    selectedTask: null,
    run: {
      state: "complete",
      endSeconds: 60,
      lateBatches: 0,
      unfinishedBatches: 0,
    },
  },
};
void missingCursor;

const invalidPlayingView: BakerySurfaceCommandV1 = {
  schemaVersion: 1,
  kind: "set_view",
  target: { surfaceSessionId: "surface-1", surfaceEpoch: 1 },
  view: {
    selection: { kind: "batch", id: "A" },
    cursorSeconds: 0,
    // @ts-expect-error view commands settle on an exact paused cursor
    playback: "playing",
  },
};
void invalidPlayingView;

const reviewedEditWithoutBase: BakerySurfaceCommandV1 = {
  schemaVersion: 1,
  kind: "apply_reviewed_edit",
  target: { surfaceSessionId: "surface-1", surfaceEpoch: 1 },
  proposalDigest: "a".repeat(64),
  // @ts-expect-error reviewed edits require the exact draft they were prepared against.
  baseDraft: undefined,
};
void reviewedEditWithoutBase;

const candidateWithoutRun: BakerySurfaceCommandV1 = {
  schemaVersion: 1,
  kind: "accept_candidate",
  target: { surfaceSessionId: "surface-1", surfaceEpoch: 1 },
  // @ts-expect-error tray acceptance requires its exact source-run fingerprint.
  candidate: {
    kind: "trays",
    surfaceSessionId: "surface-1",
    surfaceEpoch: 1,
    recordingDigest: "a".repeat(64),
    operationId: "operation-1",
    runFingerprint: undefined,
  },
};
void candidateWithoutRun;

const simulationWithoutMode: BakerySurfaceCommandV1 = {
  schemaVersion: 1,
  kind: "simulate_workcell",
  target: { surfaceSessionId: "surface-1", surfaceEpoch: 1 },
  attemptId: "attempt-1",
  // @ts-expect-error the governed simulation must name its execution mode.
  mode: undefined,
};
void simulationWithoutMode;

const simulationWithoutAttempt: BakerySurfaceCommandV1 = {
  schemaVersion: 1,
  kind: "simulate_workcell",
  target: { surfaceSessionId: "surface-1", surfaceEpoch: 1 },
  mode: "rack-cycle",
  // @ts-expect-error the governed simulation must target an exact attempt.
  attemptId: undefined,
};
void simulationWithoutAttempt;

declare function acceptEdit(edit: BakeryRehearsalEdit): void;

const faults = { outage: null, failure: null, recovery: null };
acceptEdit({ kind: "set_faults", faults });

// A full replacement declares which assumptions it clears.
// @ts-expect-error Missing recovery is not an explicit clear.
acceptEdit({ kind: "set_faults", faults: { outage: null, failure: null } });

// @ts-expect-error Fault edits cannot carry tray-assignment authority.
acceptEdit({ kind: "set_faults", faults, batchId: "A", baker: 2 });

const assignment = { batchId: "A", baker: 2 };
// @ts-expect-error Spreading another branch cannot bypass the command shape.
acceptEdit({ ...assignment, kind: "set_faults", faults });

acceptEdit({ kind: "replace_preset", preset: "two-trays" });
// @ts-expect-error Preset replacement cannot smuggle tray removal fields.
acceptEdit({ kind: "replace_preset", preset: "two-trays", batchId: "A" });
// @ts-expect-error Clearing results requires an exact tray identity.
acceptEdit({ kind: "clear_results" });
const presetChoice = { preset: "two-trays" as const };
// @ts-expect-error Spreading preset fields cannot change a removal command.
acceptEdit({ ...presetChoice, kind: "remove_tray", batchId: "A" });

declare function acceptProductionEdit(edit: BakeryProductionEdit): void;
acceptProductionEdit({ kind: "prepare_replacement", source: "preview" });
// @ts-expect-error Replacement requires its exact source.
acceptProductionEdit({ kind: "prepare_replacement" });
acceptProductionEdit({
  kind: "prepare_replacement",
  source: "preview",
  // @ts-expect-error Replacement proposals carry no approval authority.
  approve: true,
});
const productionAssignment = { batchId: "A", tray: 1 };
// @ts-expect-error Assignment fields cannot enter a replacement through a spread.
acceptProductionEdit({
  ...productionAssignment,
  kind: "prepare_replacement",
  source: "one-batch",
});

const stopWithoutGeneration: BakerySurfaceCommandV1 = {
  schemaVersion: 1,
  kind: "stop_simulation",
  target: { surfaceSessionId: "surface-1", surfaceEpoch: 1 },
  // @ts-expect-error An operation name alone cannot cancel a later execution.
  simulation: { operationId: "batch:A:native:1" },
};
void stopWithoutGeneration;

const runOpenTarget = { surfaceSessionId: "surface-1", surfaceEpoch: 1 };
// @ts-expect-error Opening a saved run requires its exact content ID.
const missingRunId: BakerySurfaceCommandV1 = {
  schemaVersion: 1,
  kind: "prepare_run_open",
  target: runOpenTarget,
  runKind: "production",
};
const selfApprovedRun: BakerySurfaceCommandV1 = {
  schemaVersion: 1,
  kind: "prepare_run_open",
  target: runOpenTarget,
  runKind: "production",
  id: "a".repeat(64),
  // @ts-expect-error Preparing a review cannot approve replacement.
  approve: true,
};
void missingRunId;
void selfApprovedRun;

// @ts-expect-error The first catalogue page requires an explicit null cursor.
const implicitSavedRunPage: BakerySurfaceCommandV1 = {
  schemaVersion: 1,
  kind: "list_saved_runs",
  target: runOpenTarget,
  runKind: "production",
};
void implicitSavedRunPage;

const saveReference = {
  id: "a".repeat(64),
  name: "Saved run",
  requestId: "save-1",
  origin: "agent" as const,
};
// @ts-expect-error Idle inspection has no save identity, including through spreads.
const idleWithSave: BakeryRunSaveInspection = {
  kind: "idle",
  ...{ reference: saveReference },
};
const savingWithReadback: BakeryRunSaveInspection = {
  kind: "saving",
  reference: saveReference,
  // @ts-expect-error A save still in progress cannot carry completed readback.
  readback: "verified",
};
void idleWithSave;
void savingWithReadback;

// @ts-expect-error Export requests cannot carry an import digest.
const invalidExport: import("./bakery-surface.ts").BakeryFileAction = {
  kind: "export",
  format: "run",
  digest: "a".repeat(64),
};
const invalidScenarioInspection: import("./bakery-surface.ts").BakeryScenarioSaveInspection =
  {
    kind: "idle",
    // @ts-expect-error Idle scenario inspection cannot claim successful readback.
    readback: "verified",
  };
void invalidExport;
void invalidScenarioInspection;

acceptEdit({
  kind: "set_ingredients",
  batchId: "A",
  // @ts-expect-error Agent load edits require both offsets.
  ingredients: { massKg: 1 },
});
acceptEdit({
  kind: "set_ingredients",
  batchId: "A",
  ingredients: { massKg: 1, forwardMm: 0, lateralMm: 0 },
  // @ts-expect-error Ingredient edits cannot also reassign a cell.
  cellId: "cold-cell-2",
});

declare function acceptInteriorAction(action: BakeryStoreInteriorAction): void;
acceptInteriorAction({ kind: "apply_preset", preset: "noix-parisien" });
acceptInteriorAction({
  kind: "set_floor_material",
  floorMaterial: "terrazzo-stone",
});
// @ts-expect-error Preset selection cannot also smuggle a floor material override.
acceptInteriorAction({ kind: "apply_preset", preset: "noix-parisien", floorMaterial: "terrazzo-stone" });
const floorChoice = { floorMaterial: "terrazzo-stone" as const };
// @ts-expect-error Spreading another interior branch cannot bypass StrictUnion.
acceptInteriorAction({ ...floorChoice, kind: "apply_preset", preset: "noix-parisien" });

// @ts-expect-error Free equipment rotation requires an explicit yaw angle.
const angleWithoutDegrees: BakerySurfaceCommandV1 = {
  schemaVersion: 1,
  kind: "set_equipment_angle",
  target: runOpenTarget,
  applianceId: "oven",
};
void angleWithoutDegrees;

const invalidResetAction: BakerySurfaceCommandV1 = {
  schemaVersion: 1,
  kind: "reset_floor_plan",
  target: runOpenTarget,
  // @ts-expect-error Only governed undo, redo and layout resets are accepted.
  action: "clear_storage",
};
void invalidResetAction;
