import {
  parseBakeryProductionSnapshotSurface,
  type BakeryProductionSnapshotSurface,
} from "./bakery-persistent-surface.ts";
import {
  parseBakeryPersistentSurface,
  parseBakeryProductionControl,
  parseBakeryProductionTarget,
  type BakeryPersistentSurface,
  type BakeryProductionControl,
  type BakeryProductionTarget,
} from "./bakery-persistent-surface.ts";
export * from "./bakery-persistent-surface.ts";
export {
  parseBakeryWorkspaceViewAction,
  type BakeryCameraView,
  type BakeryDoorInspection,
  type BakeryRecordingCameraView,
  type BakeryShiftDock,
  type BakeryShiftView,
  type BakeryWorkspaceViewAction,
} from "./bakery-surface-view.ts";
import {
  doorDegrees,
  parseBakeryWorkspaceViewAction,
  parseRecordingCameraView,
  parseShiftView,
  recordingCamera,
  type BakeryWorkspaceViewAction,
  type BakeryCameraView,
  type BakeryDoorInspection,
  type BakeryRecordingCameraView,
  type BakeryShiftView,
} from "./bakery-surface-view.ts";
import { parseIngredientLoad, type IngredientLoad } from "./bakery-physics.ts";
import {
  parseBakeryBrowserBinding,
  type BakeryBrowserBinding,
  type BakeryContextPreparationCommand,
} from "./bakery-context.ts";
import type { SettingsField } from "./bakery";
import {
  parseBakeryWorkcellPreparation,
  type BakeryWorkcellPreparation,
} from "./bakery-workcell-preparation.ts";
export {
  parseBakeryWorkcellPreparation,
  type BakeryWorkcellPreparation,
  type BakeryRehearsalExample,
} from "./bakery-workcell-preparation.ts";
import {
  parseBakeryPlaybackAction,
  type BakeryPlaybackAction,
} from "./bakery-playback.ts";
export {
  parseBakeryPlaybackAction,
  type BakeryPlaybackAction,
} from "./bakery-playback.ts";
import {
  MAX_RUN_SNAPSHOT_BYTES,
  isRunSnapshotId,
  isRunSnapshotCursor,
  parseRunSnapshotPage,
  type RunSnapshotPage,
} from "./bakery-run-snapshot.ts";
import type { AgentScenarioSaveManifest } from "./bakery-agent-scenario-save.ts";
import {
  parseSimulationOutput,
  type BakerySimulationOutput,
} from "./bakery-simulation-output.ts";
import type { StrictUnion, Variant, VariantBy } from "@seams/type-utils";
import {
  parseSurfaceObservation,
  parseSurfacePageCommand,
  type SurfaceObservationV2,
  type SurfacePageCommandV1,
} from "@seams/control-api";
import {
  hasExactKeys,
  isNonNegativeInteger,
  isRecord,
  sha256Hex,
  sha256HexSync,
} from "@seams/std";

const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_EFFECT_BYTES = 20 * 1024;
/** A page command's receipt carries a fresh observation of up to 24 KiB. */
const MAX_PAGE_RECEIPT_BYTES = 28 * 1024;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_LABEL_LENGTH = 160;
const MAX_SUMMARIES = 16;
const MAX_EQUIPMENT = 40;
// A production draft stores at most 60 manual tasks; each links to tasks of
// at most six batches.
const MAX_MANUAL_TASKS = 60;
const MAX_TASK_LINKS = 160;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ENCODER = new TextEncoder();
const SETTINGS_FIELDS = [
  "batchCount",
  "workerCount",
  "rackTrays",
  "ovenTrays",
  "traysPerBatch",
  "piecesPerTray",
  "loadWindow",
  "loadSeconds",
  "unloadSeconds",
  "stage",
  "portion",
  "bake",
  "cool",
  "demould",
  "finishCooling",
  "pack",
  "horizonMinutes",
  "outageStart",
  "outageEnd",
] as const satisfies readonly SettingsField[];

export type BakerySurfaceCommandName =
  | "prepare_workcell"
  | "inspect_surface"
  | "read_draft"
  | "query_tasks"
  | "set_view"
  | "control_baseline"
  | "show_production_panel"
  | "control_workspace_view"
  | "control_playback"
  | "prepare_layout"
  | "prepare_production_control"
  | "prepare_edit"
  | "run_shift"
  | "select_item"
  | "rotate_equipment"
  | "set_equipment_angle"
  | "move_equipment"
  | "toggle_opening"
  | "select_floor_plan"
  | "configure_interior"
  | "reset_floor_plan"
  | "compare_shift"
  | "start_production"
  | "prepare_run_save"
  | "file_action"
  | "inspect_scenario_save"
  | "inspect_run_save"
  | "list_saved_runs"
  | "prepare_run_open"
  | "prepare_scenario_save"
  | "stop_simulation"
  | "simulate_workcell"
  | "accept_candidate"
  | "discard_candidate"
  | "edit_rehearsal"
  | "edit_production"
  | "preview_production"
  | "apply_production"
  | "apply_reviewed_edit";

export type BakerySurfaceToolCommandName = Exclude<
  BakerySurfaceCommandName,
  "apply_reviewed_edit"
>;

export type BakerySurfaceDraftReference = Readonly<{
  revision: number;
  digest: string;
}>;

type RecordingReferenceIdentity = Readonly<{
  surfaceSessionId: string;
  surfaceEpoch: number;
  recordingDigest: string;
}>;

export type BakeryRecordingAcceptanceReference =
  | (RecordingReferenceIdentity &
      Readonly<{
        kind: "workcell";
        inputFingerprint: string;
        operationId?: never;
        runFingerprint?: never;
        planFingerprint?: never;
      }>)
  | (RecordingReferenceIdentity &
      Readonly<{
        kind: "trays";
        operationId: string;
        runFingerprint: string;
        inputFingerprint?: never;
        planFingerprint?: never;
      }>)
  | (RecordingReferenceIdentity &
      Readonly<{
        kind: "production";
        operationId: string;
        planFingerprint: string;
        inputFingerprint?: never;
        runFingerprint?: never;
      }>);

export type BakerySurfaceEditOperation = Readonly<{
  kind: "set_assumption";
  field: SettingsField;
  value: number;
}>;

export type BakerySurfaceEditProposalV1 = Readonly<{
  proposalDigest: string;
  baseDraft: BakerySurfaceDraftReference;
  edits: readonly BakerySurfaceEditOperation[];
  summary: readonly string[];
  preview: Readonly<{
    before: BakerySurfaceRunPreview;
    after: BakerySurfaceRunPreview;
  }>;
}>;

export type BakerySurfaceRunSaveManifest = Readonly<{
  kind: "rehearsal";
  id: string;
  name: string;
  bytes: number;
}>;

export type BakerySurfaceScenarioSaveManifest = AgentScenarioSaveManifest;

export type BakerySurfaceRunPreview = Readonly<{
  state: "complete" | "blocked" | "horizon";
  endSeconds: number;
  lateBatches: number;
  unfinishedBatches: number;
}>;

export type BakerySurfaceSelection = Readonly<{
  kind: "batch" | "station" | "task" | "resource" | "operation";
  id: string;
  label: string;
}>;

export type BakerySurfacePlayback = Readonly<{
  cursorSeconds: number;
  playback: "paused" | "playing";
  speed: number;
}>;

export type BakeryProductionPanel =
  "workflow" | "timeline" | "files" | "details" | "author";

export function parseBakeryProductionPanel(
  raw: unknown,
): BakeryProductionPanel | null {
  switch (raw) {
    case "workflow":
    case "timeline":
    case "files":
    case "details":
    case "author":
      return raw;
    default:
      return null;
  }
}

export type BakerySurfaceSummary = Readonly<{
  id: string;
  label: string;
  state: string;
}>;

export type BakerySurfaceTaskDetail = Readonly<{
  id: string;
  name: string;
  kind: "process" | "transfer" | "handoff" | "native";
  status: "pending" | "running" | "complete";
  startSeconds: number;
  endSeconds: number;
  batchId: string;
  dependencies: readonly string[];
  resources: readonly string[];
  constraints: readonly string[];
}>;

export type BakerySurfaceDraftSnapshot = Readonly<{
  reference: BakerySurfaceDraftReference;
  values: Readonly<Record<SettingsField, number>>;
}>;

export type BakerySurfaceRackLayout = Readonly<{
  modelHash: string;
  xMm: number;
  yMm: number;
  editable: boolean;
  checks: string;
  proposal: Readonly<{
    baseModelHash: string;
    xMm: number;
    yMm: number;
    status: "blocked" | "unchecked";
  }> | null;
}>;

export type BakerySimulationMode = "transfer" | "oven-cycle" | "rack-cycle";

// The native step a scheduled rehearsal awaits and can run in the browser.
export type BakerySurfacePendingOperation = Readonly<{
  operationId: string;
  label: string;
  mode: BakerySimulationMode;
}>;

// A scheduled rehearsal names the tray whose first request the layout moves.
export type BakerySurfaceTrayLayout = BakerySurfaceRackLayout &
  Readonly<{ operationId: string }>;

export type BakerySimulationReference = Readonly<{
  generation: number;
  operationId: string;
}>;

export type BakeryRunOpenReview = Readonly<{
  id: string;
  name: string;
  runKind: "rehearsal" | "production";
  sourceFingerprint: string;
  proposedFingerprint: string;
  currentResults: number;
  proposedResults: number;
}>;

// An appliance on the open floor plan, with its yaw in whole degrees and optional mm coordinates.
export type BakerySurfaceEquipment = Readonly<{
  id: string;
  label: string;
  rotationDegrees: number;
  xMm?: number;
  zMm?: number;
}>;

export type BakerySurfaceOpening = Readonly<{
  id: string;
  label: string;
  kind: "door" | "window";
  open: boolean;
  progress: number;
}>;

export type BakeryStoreInteriorPresetId =
  | "kuramae-artisan"
  | "noix-parisien"
  | "kiyosumi-minimal"
  | "kyoto-machiya";

export type BakeryFloorMaterialId =
  | "herringbone-oak"
  | "terrazzo-stone"
  | "limestone-checker"
  | "quarry-terracotta"
  | "smoked-cedar";

export type BakeryWallMaterialId =
  | "limewash-hinoki"
  | "parisian-boiserie"
  | "board-concrete"
  | "juraku-lattice";

export type BakeryFixtureFinishId =
  | "blackened-steel"
  | "aged-brass"
  | "natural-oak";

export type BakeryLightingStyleId =
  | "brass-pendants"
  | "atelier-track"
  | "washi-lanterns";

export type BakeryWallHeightMode = "cutaway" | "smart-cutaway" | "full";

export type BakerySurfaceStoreInterior = Readonly<{
  preset: BakeryStoreInteriorPresetId | "custom";
  floorMaterial: BakeryFloorMaterialId;
  wallMaterial: BakeryWallMaterialId;
  fixtureFinish: BakeryFixtureFinishId;
  lightingStyle: BakeryLightingStyleId;
  wallHeightMode: BakeryWallHeightMode;
  showFurnishings: boolean;
}>;

export type BakeryStoreInteriorAction = StrictUnion<
  | Readonly<{ kind: "apply_preset"; preset: BakeryStoreInteriorPresetId }>
  | Readonly<{ kind: "set_floor_material"; floorMaterial: BakeryFloorMaterialId }>
  | Readonly<{ kind: "set_wall_material"; wallMaterial: BakeryWallMaterialId }>
  | Readonly<{ kind: "set_fixture_finish"; fixtureFinish: BakeryFixtureFinishId }>
  | Readonly<{ kind: "set_lighting_style"; lightingStyle: BakeryLightingStyleId }>
  | Readonly<{ kind: "set_wall_height"; wallHeightMode: BakeryWallHeightMode }>
  | Readonly<{ kind: "set_furnishings"; showFurnishings: boolean }>
>;

export type BakeryFloorPlanResetAction =
  | "undo"
  | "redo"
  | "reset_appliances"
  | "reset_initial";

export type BakerySurfaceFloorPlanHistory = Readonly<{
  canUndo: boolean;
  canRedo: boolean;
  hasCustomLayout: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}>;

export type BakerySurfaceShiftLayout = Readonly<{
  floorPlan: string;
  equipment: readonly BakerySurfaceEquipment[];
  openings?: readonly BakerySurfaceOpening[];
  interior?: BakerySurfaceStoreInterior;
  history?: BakerySurfaceFloorPlanHistory;
}>;

export type BakerySurfaceContextV1 = Readonly<{
  schemaVersion: 1;
  kind: "bakery-workspace";
  surfaceSessionId: string;
  surfaceEpoch: number;
  capturedAt: number;
  comparison: BakeryRunComparison | null;
  simulation: BakerySimulationReference | null;
  runOpenReview: BakeryRunOpenReview | null;
  supportedCommands: readonly BakerySurfaceToolCommandName[];
  active:
    | BakeryPersistentSurface
    | BakeryProductionSnapshotSurface
    | Readonly<{
        kind: "shift";
        view: BakeryShiftView;
        source: "sample" | "procedure";
        sourceIdentity:
          | Readonly<{ kind: "sample"; id: "financier-sample" }>
          | Readonly<{
              kind: "procedure";
              id: string;
              revision: string;
              snapshotRevision: string;
            }>;
        variant: "normal" | "outage";
        selection: BakerySurfaceSelection;
        selectedTask: BakerySurfaceTaskDetail | null;
        playback: BakerySurfacePlayback;
        draft: BakerySurfaceDraftReference;
        pendingEdit: BakerySurfaceEditProposalV1 | null;
        scenarioSaveProposal: BakerySurfaceScenarioSaveManifest | null;
        run: Readonly<{
          state: "complete" | "blocked" | "horizon";
          endSeconds: number;
          lateBatches: number;
          unfinishedBatches: number;
        }>;
        // Contexts saved before the floor plan was attached carry none.
        layout?: BakerySurfaceShiftLayout;
      }>
    | Readonly<{
        kind: "rehearsal";
        view: BakeryRecordingCameraView &
          Readonly<{ doorInspection: BakeryDoorInspection }>;
        rehearsalKind: "standalone" | "trays";
        rackLayout: BakerySurfaceRackLayout | null;
        readiness: "empty" | "setup" | "ready";
        selection: BakerySurfaceSelection | null;
        playback: BakerySurfacePlayback;
        runId: string | null;
        attemptId: string | null;
        tasks: readonly BakerySurfaceSummary[];
        resources: readonly BakerySurfaceSummary[];
        candidate: BakeryRecordingAcceptanceReference | null;
        runSaveProposal: BakerySurfaceRunSaveManifest | null;
        planFingerprint?: never;
        pendingOperation?: never;
      }>
    // A rehearsal on the production scheduler: tray chains whose native steps
    // run one at a time, each result reviewed before it is accepted.
    | Readonly<{
        kind: "rehearsal";
        view: BakeryCameraView;
        rehearsalKind: "scheduled";
        panel: BakeryProductionPanel;
        rackLayout: BakerySurfaceTrayLayout | null;
        readiness: "empty" | "ready";
        selection: BakerySurfaceSelection | null;
        playback: BakerySurfacePlayback;
        runId: null;
        attemptId: null;
        planFingerprint: string | null;
        pendingOperation: BakerySurfacePendingOperation | null;
        tasks: readonly BakerySurfaceSummary[];
        resources: readonly BakerySurfaceSummary[];
        faults: BakeryRehearsalFaults;
        editReview: BakeryRehearsalReview | null;
        // Each tray's baker, prerequisites and earliest staging, and the
        // bakers a tray may be given.
        trays: readonly BakerySurfaceRehearsalTray[];
        bakerCount: number;
        candidate: BakeryRecordingAcceptanceReference | null;
        runSaveProposal: BakerySurfaceRunSaveManifest | null;
      }>
    | Readonly<{
        kind: "production";
        view: BakeryCameraView;
        readiness: "loading" | "failed";
        panel: BakeryProductionPanel;
        pendingOperation: null;
        planFingerprint: null;
        variant: null;
        operationCount: 0;
        operations: readonly [];
        selection: null;
        playback: null;
        candidate: null;
        scenarioSaveProposal: BakerySurfaceScenarioSaveManifest | null;
        draft: null;
      }>
    | Readonly<{
        kind: "production";
        view: BakeryCameraView;
        readiness: "ready";
        planFingerprint: string;
        panel: BakeryProductionPanel;
        pendingOperation: BakerySurfacePendingOperation | null;
        variant: "normal" | "outage";
        operationCount: number;
        operations: readonly BakerySurfaceSummary[];
        selection: BakerySurfaceSelection;
        playback: BakerySurfacePlayback;
        candidate: BakeryRecordingAcceptanceReference | null;
        scenarioSaveProposal: BakerySurfaceScenarioSaveManifest | null;
        // A financier run's draft; a rehearsal has none.
        draft: BakerySurfaceProductionDraft | null;
      }>;
}>;

export type BakerySurfaceScheduledRehearsal = VariantBy<
  Variant<BakerySurfaceContextV1["active"], "rehearsal">,
  "rehearsalKind",
  "scheduled"
>;

export type BakerySurfaceRehearsalTray = Readonly<{
  // Display context can omit loads from older saved surface snapshots.
  ingredients?: IngredientLoad;
  batchId: string;
  cellId: "cold-cell-1" | "cold-cell-2";
  baker: number;
  // Steps of other trays that must finish before this tray is staged.
  dependsOn: readonly string[];
  earliestStartSeconds: number;
}>;

// Simulation assumptions only; these never certify a physical failure or recovery.
export type BakeryRehearsalFaults = Readonly<{
  outage: Readonly<{ resource: string; start: number; end: number }> | null;
  failure: Readonly<{ bakeryTaskId: string; afterSeconds: number }> | null;
  recovery: Readonly<{ bakeryTaskId: string; seconds: number }> | null;
}>;

// Direct edits preserve accepted results. Destructive changes prepare a review
// that only the operator can apply.
export type BakeryRehearsalPreset =
  | "two-trays"
  | "table-to-rack"
  | "table-to-oven"
  | "oven-cycle"
  | "oven-table-rack";
export type BakeryRehearsalChange = StrictUnion<
  | Readonly<{
      kind: "set_ingredients";
      batchId: string;
      ingredients: IngredientLoad;
    }>
  | Readonly<{ kind: "add_human_transfer"; batchId: string }>
  | Readonly<{
      kind: "set_cell";
      batchId: string;
      cellId: "cold-cell-1" | "cold-cell-2";
    }>
  | Readonly<{ kind: "replace_preset"; preset: BakeryRehearsalPreset }>
  | Readonly<{ kind: "clear_results"; batchId: string }>
  | Readonly<{ kind: "remove_tray"; batchId: string }>
>;
export type BakeryRehearsalReview = Readonly<{
  change: BakeryRehearsalChange;
  sourceFingerprint: string;
  proposedFingerprint: string;
  currentResults: number;
  proposedResults: number;
}>;

export type BakeryRehearsalEdit = StrictUnion<
  | BakeryRehearsalChange
  | Readonly<{ kind: "set_faults"; faults: BakeryRehearsalFaults }>
  | Readonly<{ kind: "add_tray_chain"; rackCase: "nominal" | "slip" }>
  | Readonly<{ kind: "set_baker"; batchId: string; baker: number }>
  | Readonly<{
      kind: "set_start";
      operationId: string;
      earliestStartSeconds: number;
    }>
  | Readonly<{
      kind: "set_prerequisites";
      batchId: string;
      dependsOn: readonly string[];
    }>
>;

// A financier production draft as Edit production shows it. The digest
// binds edits, previews and applies to the draft they were made against.
export type BakeryProductionReplacementSource =
  "preview" | "procedure" | "one-batch";
export type BakeryProductionReplacement = Readonly<{
  source: BakeryProductionReplacementSource;
  sourceFingerprint: string;
  proposedFingerprint: string;
  currentResults: number;
  proposedOperations: number;
}>;

export type BakerySurfaceProductionDraft = Readonly<{
  digest: string;
  batchCount: number;
  traysPerBatch: number;
  bakerCount: number;
  variant: "normal" | "outage";
  assignments: readonly BakerySurfaceProductionAssignment[];
  manualTasks: readonly BakerySurfaceManualTask[];
  preview: BakerySurfaceProductionPreview | null;
  replacement: BakeryProductionReplacement | null;
}>;

export type BakerySurfaceProductionAssignment = Readonly<{
  batchId: string;
  tray: number;
  baker: number;
  // Tasks that must finish before this tray is staged.
  dependsOn: readonly string[];
  earliestStartSeconds: number;
}>;

// A manual operation or transfer with a baker, prerequisites or a start.
export type BakerySurfaceManualTask = Readonly<{
  bakeryTaskId: string;
  baker: number | null;
  dependsOn: readonly string[];
  earliestStartSeconds: number;
}>;

// The compiled draft. Applying it starts a run with this fingerprint.
export type BakerySurfaceProductionPreview = Readonly<{
  planFingerprint: string;
  operationCount: number;
  run: BakerySurfaceRunPreview;
}>;

// Draft edits keep the applied run. Applying a preview replaces the run's
// native requests and is its own command.
export type BakeryProductionEdit = StrictUnion<
  | Readonly<{
      kind: "prepare_replacement";
      source: BakeryProductionReplacementSource;
    }>
  | Readonly<{
      kind: "assign_tray" | "unassign_tray";
      batchId: string;
      tray: number;
    }>
  | Readonly<{
      kind: "set_baker";
      batchId: string;
      tray: number;
      baker: number;
    }>
  | Readonly<{
      kind: "set_prerequisites";
      batchId: string;
      tray: number;
      dependsOn: readonly string[];
    }>
  | Readonly<{
      kind: "set_start";
      batchId: string;
      tray: number;
      earliestStartSeconds: number;
    }>
  | Readonly<{
      kind: "set_manual_task";
      bakeryTaskId: string;
      baker: number | null;
      dependsOn: readonly string[];
      earliestStartSeconds: number;
    }>
  | Readonly<{ kind: "set_variant"; variant: "normal" | "outage" }>
  | Readonly<{ kind: "discard_draft" }>
>;

export type BakerySurfaceAttachmentV1 = Readonly<{
  kind: "bakery-surface-context";
  digest: string;
  context: BakerySurfaceContextV1;
}>;

export type BakerySurfaceReference = Readonly<{
  surfaceSessionId: string;
  surfaceEpoch: number;
}>;

export type BakerySurfaceSelectionTarget =
  | Readonly<{ kind: "batch"; id: string }>
  | Readonly<{ kind: "station"; id: string }>
  | Readonly<{ kind: "task"; id: string }>
  | Readonly<{ kind: "resource"; id: string }>
  | Readonly<{ kind: "operation"; id: string }>;

export type BakeryRunSummary = Readonly<{
  kind: "complete" | "blocked" | "horizon";
  end: number;
  completed: number;
  unfinished: number;
  failed: number;
  waiting: number;
}>;

export type BakeryRunComparison = Readonly<{
  digest: string;
  current: BakeryRunSummary;
  baseline: BakeryRunSummary | null;
}>;

export type BakeryFileAction =
  | Readonly<{ kind: "import"; digest: string; format?: never }>
  | Readonly<{
      kind: "export";
      format: "run" | "request" | "recording" | "handoff";
      digest?: never;
    }>;
export type BakeryFileManifest = Readonly<{
  name: string;
  digest: string;
  bytes: number;
}>;

export type BakeryScenarioSaveInspection =
  | Readonly<{ kind: "idle"; manifest?: never; readback?: never }>
  | Readonly<{
      kind: "prepared" | "saving" | "failed-before-save" | "verified";
      manifest: AgentScenarioSaveManifest;
      readback?: never;
    }>
  | Readonly<{
      kind: "outcome-unknown" | "saved-readback-failed";
      manifest: AgentScenarioSaveManifest;
      readback: "verified" | "unavailable";
    }>;

export type BakeryRunSaveInspection =
  | Readonly<{ kind: "idle"; reference?: never; readback?: never }>
  | Readonly<{
      kind: "saving" | "verified" | "readback-confirmed";
      reference: BakeryRunSaveReference;
      readback?: never;
    }>
  | Readonly<{
      kind: "outcome-unknown" | "saved-readback-failed" | "not-found";
      reference: BakeryRunSaveReference;
      readback: "verified" | "missing" | "unavailable";
    }>;

type BakeryRunSaveReference = Readonly<{
  id: string;
  name: string;
  requestId: string;
  origin: "operator" | "agent";
}>;

export type BakerySurfaceCommandV1 =
  | Readonly<{
      schemaVersion: 1;
      kind: "prepare_production_control";
      target: BakerySurfaceReference;
      production: BakeryProductionTarget;
      control: BakeryProductionControl;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "file_action";
      target: BakerySurfaceReference;
      action: BakeryFileAction;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "inspect_scenario_save";
      target: BakerySurfaceReference;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "inspect_run_save";
      target: BakerySurfaceReference;
      runKind: "rehearsal" | "production";
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "list_saved_runs";
      target: BakerySurfaceReference;
      runKind: "rehearsal" | "production";
      cursor: string | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "prepare_run_open";
      target: BakerySurfaceReference;
      runKind: "rehearsal" | "production";
      id: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "stop_simulation";
      target: BakerySurfaceReference;
      simulation: BakerySimulationReference;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "control_workspace_view";
      target: BakerySurfaceReference;
      action: BakeryWorkspaceViewAction;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "show_production_panel";
      target: BakerySurfaceReference;
      panel: BakeryProductionPanel;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "control_baseline";
      target: BakerySurfaceReference;
      comparison: BakeryRunComparison;
      action: "pin" | "clear";
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "prepare_workcell";
      target: BakerySurfaceReference;
      preparation: BakeryWorkcellPreparation;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "control_playback";
      target: BakerySurfaceReference;
      action: BakeryPlaybackAction;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "prepare_layout";
      target: BakerySurfaceReference;
      baseModelHash: string;
      xMm: number;
      yMm: number;
      operationId?: never;
    }>
  // Version 2 targets a scheduled rehearsal tray by its first operation.
  | Readonly<{
      schemaVersion: 2;
      kind: "prepare_layout";
      target: BakerySurfaceReference;
      operationId: string;
      baseModelHash: string;
      xMm: number;
      yMm: number;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "inspect_surface";
      target: BakerySurfaceReference;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "set_view";
      target: BakerySurfaceReference;
      view: Readonly<{
        selection: BakerySurfaceSelectionTarget;
        cursorSeconds: number;
        playback: "paused";
      }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "read_draft";
      target: BakerySurfaceReference;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "query_tasks";
      target: BakerySurfaceReference;
      filter: Readonly<{ text: string; limit: number }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "prepare_edit";
      target: BakerySurfaceReference;
      baseDraft: BakerySurfaceDraftReference;
      edits: readonly BakerySurfaceEditOperation[];
    }>
  // Runs the shift as Apply changes does: the applied inputs with these
  // edits, recalculated from 06:00 with playback reset. No edits re-runs it.
  | Readonly<{
      schemaVersion: 1;
      kind: "run_shift";
      target: BakerySurfaceReference;
      baseDraft: BakerySurfaceDraftReference;
      edits: readonly BakerySurfaceEditOperation[];
    }>
  // A Details chip or a 3D click: select an item, keep the playback time.
  | Readonly<{
      schemaVersion: 1;
      kind: "select_item";
      target: BakerySurfaceReference;
      selection: Exclude<BakerySurfaceSelectionTarget, { kind: "operation" }>;
    }>
  // Rotate 90° (R) on the appliance, from the rotation the agent saw.
  | Readonly<{
      schemaVersion: 1;
      kind: "rotate_equipment";
      target: BakerySurfaceReference;
      applianceId: string;
      rotationDegrees: number;
    }>
  // Move one appliance on the open floor plan to (xMm, zMm) with collision resolution.
  | Readonly<{
      schemaVersion: 1;
      kind: "move_equipment";
      target: BakerySurfaceReference;
      applianceId: string;
      xMm: number;
      zMm: number;
    }>
  // Open or close a door or window on the open floor plan.
  | Readonly<{
      schemaVersion: 1;
      kind: "toggle_opening";
      target: BakerySurfaceReference;
      openingId: string;
      open: boolean;
    }>
  // Switch the active floor plan room.
  | Readonly<{
      schemaVersion: 1;
      kind: "select_floor_plan";
      target: BakerySurfaceReference;
      floorPlan: string;
    }>
  // Set one appliance's free yaw in whole degrees (-179..180) on the open floor plan.
  | Readonly<{
      schemaVersion: 1;
      kind: "set_equipment_angle";
      target: BakerySurfaceReference;
      applianceId: string;
      yawDegrees: number;
    }>
  // Configure the store interior preset, material palette, wall height or furnishings.
  | Readonly<{
      schemaVersion: 1;
      kind: "configure_interior";
      target: BakerySurfaceReference;
      action: BakeryStoreInteriorAction;
    }>
  // Undo, redo, reset appliances on the active floor plan, or reset to the initial layout.
  | Readonly<{
      schemaVersion: 1;
      kind: "reset_floor_plan";
      target: BakerySurfaceReference;
      action: BakeryFloorPlanResetAction;
    }>
  // Compare shifts: replay the normal shift or compare an oven outage.
  | Readonly<{
      schemaVersion: 1;
      kind: "compare_shift";
      target: BakerySurfaceReference;
      mode: "normal" | "outage";
    }>
  // The recipe catalog's financier production run, opened from the shift.
  | Readonly<{
      schemaVersion: 1;
      kind: "start_production";
      target: BakerySurfaceReference;
      preset: "procedure" | "one-batch";
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "prepare_run_save";
      target: BakerySurfaceReference;
      name: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "prepare_scenario_save";
      target: BakerySurfaceReference;
      name: string;
      note: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "apply_reviewed_edit";
      target: BakerySurfaceReference;
      baseDraft: BakerySurfaceDraftReference;
      proposalDigest: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "simulate_workcell";
      target: BakerySurfaceReference;
      attemptId: string;
      mode: BakerySimulationMode;
      operationId?: never;
      planFingerprint?: never;
    }>
  // Version 2 runs the step a scheduled rehearsal awaits.
  | Readonly<{
      schemaVersion: 2;
      kind: "simulate_workcell";
      target: BakerySurfaceReference;
      operationId: string;
      planFingerprint: string;
      mode: BakerySimulationMode;
      attemptId?: never;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "accept_candidate";
      target: BakerySurfaceReference;
      candidate: BakeryRecordingAcceptanceReference;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "discard_candidate";
      target: BakerySurfaceReference;
      candidate: Variant<BakeryRecordingAcceptanceReference, "production">;
    }>
  // Edits the trays of the scheduled rehearsal the fingerprint names.
  | Readonly<{
      schemaVersion: 1;
      kind: "edit_rehearsal";
      target: BakerySurfaceReference;
      planFingerprint: string;
      edit: BakeryRehearsalEdit;
    }>
  // Financier production authoring against the draft the digest names:
  // edit it, compile a preview, or apply the preview with that fingerprint.
  | Readonly<{
      schemaVersion: 1;
      kind: "edit_production";
      target: BakerySurfaceReference;
      draftDigest: string;
      edit: BakeryProductionEdit;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "preview_production";
      target: BakerySurfaceReference;
      draftDigest: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "apply_production";
      target: BakerySurfaceReference;
      draftDigest: string;
      planFingerprint: string;
    }>;

export type BakerySurfaceCommandResultV1 =
  | Readonly<{
      kind: "succeeded";
      command: "file_action";
      surface: BakerySurfaceAttachmentV1;
      output: Readonly<{
        kind: "file";
        action: "import" | "export";
        manifest: BakeryFileManifest;
      }>;
    }>
  | Readonly<{
      kind: "succeeded";
      command: "inspect_scenario_save";
      surface: BakerySurfaceAttachmentV1;
      output: Readonly<{
        kind: "scenario_save_inspection";
        save: BakeryScenarioSaveInspection;
      }>;
    }>
  | Readonly<{
      kind: "succeeded";
      command: "inspect_run_save";
      surface: BakerySurfaceAttachmentV1;
      output: Readonly<{
        kind: "run_save_inspection";
        runKind: "rehearsal" | "production";
        save: BakeryRunSaveInspection;
      }>;
    }>
  | Readonly<{
      kind: "succeeded";
      command: "list_saved_runs";
      surface: BakerySurfaceAttachmentV1;
      output: Readonly<{
        kind: "saved_runs";
        runKind: "rehearsal" | "production";
        cursor: string | null;
        page: RunSnapshotPage;
      }>;
    }>
  | Readonly<{
      kind: "succeeded";
      command:
        | "prepare_workcell"
        | "prepare_run_open"
        | "inspect_surface"
        | "set_view"
        | "control_baseline"
        | "show_production_panel"
        | "control_workspace_view"
        | "stop_simulation"
        | "control_playback"
        | "prepare_layout"
        | "prepare_production_control"
        | "prepare_edit"
        | "run_shift"
        | "select_item"
        | "rotate_equipment"
        | "set_equipment_angle"
        | "move_equipment"
        | "toggle_opening"
        | "select_floor_plan"
        | "configure_interior"
        | "reset_floor_plan"
        | "compare_shift"
        | "start_production"
        | "apply_reviewed_edit"
        | "accept_candidate"
        | "discard_candidate"
        | "edit_rehearsal"
        | "edit_production"
        | "preview_production"
        | "apply_production";
      surface: BakerySurfaceAttachmentV1;
      output: Readonly<{ kind: "surface" }>;
    }>
  | Readonly<{
      kind: "succeeded";
      command: "simulate_workcell";
      surface: BakerySurfaceAttachmentV1;
      output: BakerySimulationOutput;
    }>
  | Readonly<{
      kind: "succeeded";
      command: "read_draft";
      surface: BakerySurfaceAttachmentV1;
      output: Readonly<{
        kind: "draft";
        draft: BakerySurfaceDraftSnapshot;
      }>;
    }>
  | Readonly<{
      kind: "succeeded";
      command: "query_tasks";
      surface: BakerySurfaceAttachmentV1;
      output: Readonly<{
        kind: "task_query";
        tasks: readonly BakerySurfaceTaskDetail[];
      }>;
    }>
  | Readonly<{
      kind: "succeeded";
      command: "prepare_run_save";
      surface: BakerySurfaceAttachmentV1;
      output: Readonly<{
        kind: "run_save_proposal";
        manifest: BakerySurfaceRunSaveManifest;
      }>;
    }>
  | Readonly<{
      kind: "succeeded";
      command: "prepare_scenario_save";
      surface: BakerySurfaceAttachmentV1;
      output: Readonly<{
        kind: "scenario_save_proposal";
        manifest: BakerySurfaceScenarioSaveManifest;
      }>;
    }>
  | Readonly<{
      kind: "rejected";
      command: BakerySurfaceCommandName;
      code:
        | "stale_surface"
        | "stale_draft"
        | "unsupported_command"
        | "target_not_found"
        | "invalid_edit"
        | "proposal_missing"
        | "simulation_failed";
      message: string;
    }>;

export type RejectedBakerySurfaceCommandResultV1 = Variant<
  BakerySurfaceCommandResultV1,
  "rejected"
>;

export type ExecutableBakerySurfaceEffectV1 = BakerySurfaceEffectV1 &
  Readonly<{ command: BakerySurfaceCommandV1 }>;

export type BakerySurfaceEffectV1 = Readonly<{
  schemaVersion: 1;
  kind: "bakery-surface-effect";
  effectId: string;
  dispatchId: string;
  commandDigest: string;
  deadlineAt: number;
  /** A `page_command` runs on another Portal page (Plan 87 phase 4). */
  command:
    | BakerySurfaceCommandV1
    | BakeryContextPreparationCommand
    | SurfacePageCommandV1;
}>;

export type BakerySurfaceEffectOutcomeV1 =
  | Readonly<{
      kind: "prepared";
      binding: BakeryBrowserBinding;
      surface: BakerySurfaceAttachmentV1;
      result?: never;
    }>
  | Readonly<{
      kind: "completed";
      result: BakerySurfaceCommandResultV1;
      binding?: never;
      surface?: never;
    }>
  /** A page command ran; the page now shows this observation. */
  | Readonly<{
      kind: "page_completed";
      observation: SurfaceObservationV2;
      binding?: never;
      surface?: never;
      result?: never;
    }>
  /** The page could not run the command, such as for a product it lacks. */
  | Readonly<{
      kind: "page_rejected";
      message: string;
      binding?: never;
      surface?: never;
      result?: never;
    }>
  | Readonly<{
      kind: "delivery_failed";
      code:
        | "effect_invalid"
        | "effect_expired"
        | "effect_cancelled"
        | "effect_indeterminate"
        | "effect_conflict"
        | "surface_unavailable"
        | "ledger_full";
      message: string;
      binding?: never;
      surface?: never;
      result?: never;
    }>;

export type BakerySurfaceReceiptV1 = Readonly<{
  schemaVersion: 1;
  kind: "bakery-surface-receipt";
  effectId: string;
  dispatchId: string;
  commandDigest: string;
  resultDigest: string;
  outcome: BakerySurfaceEffectOutcomeV1;
}>;

export type BakerySurfaceCommandParseResult =
  | Readonly<{ kind: "valid"; value: BakerySurfaceCommandV1 }>
  | Readonly<{ kind: "invalid"; message: string }>;

export type BakerySurfaceEffectParseResult =
  | Readonly<{ kind: "valid"; value: BakerySurfaceEffectV1 }>
  | Readonly<{ kind: "invalid"; message: string }>;

export type BakerySurfaceReceiptParseResult =
  | Readonly<{ kind: "valid"; value: BakerySurfaceReceiptV1 }>
  | Readonly<{ kind: "invalid"; message: string }>;

export type BakerySurfaceParseResult =
  | Readonly<{ kind: "valid"; value: BakerySurfaceAttachmentV1 }>
  | Readonly<{ kind: "invalid"; message: string }>;

export async function createBakerySurfaceAttachment(
  context: BakerySurfaceContextV1,
): Promise<BakerySurfaceAttachmentV1> {
  const normalized = parseContext(context);
  if (normalized === null)
    throw new Error("Invalid Kitchen surface context.");
  const serialized = JSON.stringify(normalized);
  if (ENCODER.encode(serialized).byteLength > MAX_CONTEXT_BYTES)
    throw new Error("The Kitchen context exceeds the 16 KiB limit.");
  return {
    kind: "bakery-surface-context",
    digest: await sha256Hex(serialized),
    context: normalized,
  };
}

export async function createBakerySurfaceEffect(input: {
  readonly effectId: string;
  readonly dispatchId: string;
  readonly deadlineAt: number;
  readonly command: BakerySurfaceEffectV1["command"];
}): Promise<BakerySurfaceEffectV1> {
  const command = parseBakeryEffectCommand(input.command);
  if (command.kind === "invalid") throw new Error(command.message);
  return {
    schemaVersion: 1,
    kind: "bakery-surface-effect",
    effectId: input.effectId,
    dispatchId: input.dispatchId,
    commandDigest: await sha256Hex(JSON.stringify(command.value)),
    deadlineAt: input.deadlineAt,
    command: command.value,
  };
}

export async function createBakerySurfaceReceipt(
  effect: BakerySurfaceEffectV1,
  outcome: BakerySurfaceEffectOutcomeV1,
): Promise<BakerySurfaceReceiptV1> {
  return {
    schemaVersion: 1,
    kind: "bakery-surface-receipt",
    effectId: effect.effectId,
    dispatchId: effect.dispatchId,
    commandDigest: effect.commandDigest,
    resultDigest: await sha256Hex(JSON.stringify(outcome)),
    outcome,
  };
}

export function parseBakerySurfaceAttachment(
  raw: unknown,
): BakerySurfaceParseResult {
  if (!isRecord(raw) || !hasExactKeys(raw, ["kind", "digest", "context"]))
    return invalid("The Kitchen context envelope is invalid.");
  if (
    raw.kind !== "bakery-surface-context" ||
    typeof raw.digest !== "string" ||
    !SHA256_PATTERN.test(raw.digest)
  )
    return invalid("The Kitchen context identity is invalid.");
  const context = parseContext(raw.context);
  if (context === null)
    return invalid("The Kitchen context payload is invalid.");
  if (ENCODER.encode(JSON.stringify(context)).byteLength > MAX_CONTEXT_BYTES)
    return invalid("The Kitchen context exceeds the 16 KiB limit.");
  return {
    kind: "valid",
    value: { kind: "bakery-surface-context", digest: raw.digest, context },
  };
}

/**
 * The attachment of a Kitchen state that a screen observation carries
 * (Plan 87 phase 2). The server computes the digest, so the browser sends
 * none; it is the digest that `createBakerySurfaceAttachment` gives. Null
 * when the state is not a valid Kitchen context of at most 16 KiB.
 */
export function bakerySurfaceAttachmentFromState(
  raw: unknown,
): BakerySurfaceAttachmentV1 | null {
  const context = parseContext(raw);
  if (context === null) return null;
  const serialized = JSON.stringify(context);
  if (ENCODER.encode(serialized).byteLength > MAX_CONTEXT_BYTES) return null;
  return {
    kind: "bakery-surface-context",
    digest: sha256HexSync(serialized),
    context,
  };
}

export function parseBakerySurfaceCommand(
  raw: unknown,
): BakerySurfaceCommandParseResult {
  if (!isRecord(raw) || typeof raw.kind !== "string")
    return invalidCommand("The Kitchen surface command is invalid.");
  if (raw.kind === "file_action") {
    const target = parseSurfaceReference(raw.target);
    const action = parseBakeryFileAction(raw.action);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "action"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      action === null
    )
      return invalidCommand(
        "Choose an attached Kitchen file or an available export.",
      );
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "file_action", target, action },
    };
  }
  if (raw.kind === "inspect_scenario_save") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target"]) ||
      raw.schemaVersion !== 1 ||
      target === null
    )
      return invalidCommand("The scenario save inspection is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "inspect_scenario_save", target },
    };
  }
  if (raw.kind === "inspect_run_save") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "runKind"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      (raw.runKind !== "rehearsal" && raw.runKind !== "production")
    )
      return invalidCommand(
        "Inspect a rehearsal or production save in the attached workspace.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "inspect_run_save",
        target,
        runKind: raw.runKind,
      },
    };
  }
  if (raw.kind === "list_saved_runs") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "runKind",
        "cursor",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      (raw.runKind !== "rehearsal" && raw.runKind !== "production") ||
      !isRunSnapshotCursor(raw.cursor)
    )
      return invalidCommand(
        "Listing saved runs requires a run kind and an explicit page cursor (null for the first page).",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "list_saved_runs",
        target,
        runKind: raw.runKind,
        cursor: raw.cursor,
      },
    };
  }
  if (raw.kind === "prepare_run_open") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "runKind",
        "id",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      (raw.runKind !== "rehearsal" && raw.runKind !== "production") ||
      !isRunSnapshotId(raw.id)
    )
      return invalidCommand(
        "Opening a saved run requires its exact content ID and kind.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_run_open",
        target,
        runKind: raw.runKind,
        id: raw.id,
      },
    };
  }
  if (raw.kind === "inspect_surface") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target"]))
      return invalidCommand("The Kitchen inspect command is invalid.");
    const target = parseSurfaceReference(raw.target);
    if (raw.schemaVersion !== 1 || target === null)
      return invalidCommand("The Kitchen inspect target is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "inspect_surface", target },
    };
  }
  if (raw.kind === "read_draft") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target"]))
      return invalidCommand("The Kitchen draft read command is invalid.");
    const target = parseSurfaceReference(raw.target);
    if (raw.schemaVersion !== 1 || target === null)
      return invalidCommand("The Kitchen draft read target is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "read_draft", target },
    };
  }
  if (raw.kind === "query_tasks") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "filter"]))
      return invalidCommand("The Kitchen task query is invalid.");
    const target = parseSurfaceReference(raw.target);
    const filter = parseTaskFilter(raw.filter);
    if (raw.schemaVersion !== 1 || target === null || filter === null)
      return invalidCommand("The Kitchen task query is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "query_tasks", target, filter },
    };
  }
  if (raw.kind === "stop_simulation") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "simulation"]))
      return invalidCommand("The simulation stop command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const simulation = parseSimulationReference(raw.simulation);
    if (raw.schemaVersion !== 1 || target === null || simulation === null)
      return invalidCommand("Stopping requires the exact running simulation.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "stop_simulation",
        target,
        simulation,
      },
    };
  }
  if (raw.kind === "control_workspace_view") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "action"]))
      return invalidCommand("The workspace view command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const action = parseBakeryWorkspaceViewAction(raw.action);
    if (raw.schemaVersion !== 1 || target === null || action === null)
      return invalidCommand("The workspace view command is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "control_workspace_view",
        target,
        action,
      },
    };
  }
  if (raw.kind === "show_production_panel") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "panel"]))
      return invalidCommand("The production panel command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const panel = parseBakeryProductionPanel(raw.panel);
    if (raw.schemaVersion !== 1 || target === null || panel === null)
      return invalidCommand("The production panel command is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "show_production_panel",
        target,
        panel,
      },
    };
  }
  if (raw.kind === "control_baseline") {
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "comparison",
        "action",
      ])
    )
      return invalidCommand("The baseline command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const comparison = parseRunComparison(raw.comparison);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      comparison === null ||
      (raw.action !== "pin" && raw.action !== "clear")
    )
      return invalidCommand("The baseline command is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "control_baseline",
        target,
        comparison,
        action: raw.action,
      },
    };
  }
  if (raw.kind === "control_playback") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "action"]))
      return invalidCommand("The Kitchen playback command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const action = parseBakeryPlaybackAction(raw.action);
    if (raw.schemaVersion !== 1 || target === null || action === null)
      return invalidCommand("The Kitchen playback command is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "control_playback", target, action },
    };
  }
  if (raw.kind === "prepare_workcell") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "preparation"]))
      return invalidCommand("The workcell preparation command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const preparation = parseBakeryWorkcellPreparation(raw.preparation);
    if (raw.schemaVersion !== 1 || target === null || preparation === null)
      return invalidCommand("The workcell preparation command is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_workcell",
        target,
        preparation,
      },
    };
  }
  if (raw.kind === "set_view") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "view"]))
      return invalidCommand("The Kitchen view command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const view = parseView(raw.view);
    if (raw.schemaVersion !== 1 || target === null || view === null)
      return invalidCommand("The Kitchen view command is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "set_view", target, view },
    };
  }
  if (raw.kind === "simulate_workcell" && raw.schemaVersion === 2) {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "operationId",
        "planFingerprint",
        "mode",
      ]) ||
      target === null ||
      !identifier(raw.operationId) ||
      !identifier(raw.planFingerprint) ||
      !simulationMode(raw.mode)
    )
      return invalidCommand("The Kitchen simulation target is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 2,
        kind: "simulate_workcell",
        target,
        operationId: raw.operationId,
        planFingerprint: raw.planFingerprint,
        mode: raw.mode,
      },
    };
  }
  if (raw.kind === "simulate_workcell") {
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "attemptId",
        "mode",
      ])
    )
      return invalidCommand("The Kitchen simulation command is invalid.");
    const target = parseSurfaceReference(raw.target);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      !identifier(raw.attemptId) ||
      !simulationMode(raw.mode)
    )
      return invalidCommand("The Kitchen simulation target is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "simulate_workcell",
        target,
        attemptId: raw.attemptId,
        mode: raw.mode,
      },
    };
  }
  if (raw.kind === "accept_candidate" || raw.kind === "discard_candidate") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "candidate"]))
      return invalidCommand("The Kitchen candidate command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const candidate = parseRecordingAcceptanceReference(raw.candidate);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      candidate === null ||
      target.surfaceSessionId !== candidate.surfaceSessionId ||
      target.surfaceEpoch !== candidate.surfaceEpoch
    )
      return invalidCommand(
        "The Kitchen candidate reference is invalid.",
      );
    if (raw.kind === "discard_candidate")
      return candidate.kind === "production"
        ? {
            kind: "valid",
            value: {
              schemaVersion: 1,
              kind: "discard_candidate",
              target,
              candidate,
            },
          }
        : invalidCommand(
            "Only a production or rehearsal candidate can be discarded.",
          );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "accept_candidate",
        target,
        candidate,
      },
    };
  }
  if (raw.kind === "prepare_layout" && raw.schemaVersion === 2) {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "operationId",
        "baseModelHash",
        "xMm",
        "yMm",
      ]) ||
      target === null ||
      !identifier(raw.operationId) ||
      typeof raw.baseModelHash !== "string" ||
      !SHA256_PATTERN.test(raw.baseModelHash) ||
      !layoutOffset(raw.xMm) ||
      !layoutOffset(raw.yMm)
    )
      return invalidCommand(
        "Rack placement requires a tray, a model hash and whole X/Y offsets within ±600 mm.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 2,
        kind: "prepare_layout",
        target,
        operationId: raw.operationId,
        baseModelHash: raw.baseModelHash,
        xMm: raw.xMm,
        yMm: raw.yMm,
      },
    };
  }
  if (raw.kind === "prepare_layout") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "baseModelHash",
        "xMm",
        "yMm",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      typeof raw.baseModelHash !== "string" ||
      !SHA256_PATTERN.test(raw.baseModelHash) ||
      !layoutOffset(raw.xMm) ||
      !layoutOffset(raw.yMm)
    )
      return invalidCommand(
        "Rack placement requires a model hash and whole X/Y offsets within ±600 mm.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_layout",
        target,
        baseModelHash: raw.baseModelHash,
        xMm: raw.xMm,
        yMm: raw.yMm,
      },
    };
  }
  if (raw.kind === "prepare_production_control") {
    const target = parseSurfaceReference(raw.target);
    const production = parseBakeryProductionTarget(raw.production);
    const control = parseBakeryProductionControl(raw.control);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "production",
        "control",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      production === null ||
      control === null
    )
      return invalidCommand("The persistent production control is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_production_control",
        target,
        production,
        control,
      },
    };
  }
  if (raw.kind === "prepare_edit") {
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "baseDraft",
        "edits",
      ])
    )
      return invalidCommand("The Kitchen edit proposal is invalid.");
    const target = parseSurfaceReference(raw.target);
    const baseDraft = parseDraftReference(raw.baseDraft);
    const edits = parseEditOperations(raw.edits);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      baseDraft === null ||
      edits === null
    )
      return invalidCommand("The Kitchen edit proposal is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_edit",
        target,
        baseDraft,
        edits,
      },
    };
  }
  if (raw.kind === "select_item") {
    const target = parseSurfaceReference(raw.target);
    const selection = parseSelectionTarget(raw.selection);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "selection"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      selection === null ||
      selection.kind === "operation"
    )
      return invalidCommand("The Kitchen selection is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "select_item", target, selection },
    };
  }
  if (raw.kind === "rotate_equipment") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "applianceId",
        "rotationDegrees",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !identifier(raw.applianceId) ||
      !rotationDegrees(raw.rotationDegrees)
    )
      return invalidCommand("The Kitchen equipment rotation is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "rotate_equipment",
        target,
        applianceId: raw.applianceId,
        rotationDegrees: raw.rotationDegrees,
      },
    };
  }
  if (raw.kind === "move_equipment") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "applianceId",
        "xMm",
        "zMm",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !identifier(raw.applianceId) ||
      !floorPlanCoordinateMm(raw.xMm) ||
      !floorPlanCoordinateMm(raw.zMm)
    )
      return invalidCommand("The Kitchen equipment move is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "move_equipment",
        target,
        applianceId: raw.applianceId,
        xMm: raw.xMm,
        zMm: raw.zMm,
      },
    };
  }
  if (raw.kind === "toggle_opening") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "openingId",
        "open",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !identifier(raw.openingId) ||
      typeof raw.open !== "boolean"
    )
      return invalidCommand("The Kitchen opening toggle is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "toggle_opening",
        target,
        openingId: raw.openingId,
        open: raw.open,
      },
    };
  }
  if (raw.kind === "select_floor_plan") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "floorPlan"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !floorPlanId(raw.floorPlan)
    )
      return invalidCommand(
        "The Kitchen floor plan selection is invalid.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "select_floor_plan",
        target,
        floorPlan: raw.floorPlan,
      },
    };
  }
  if (raw.kind === "set_equipment_angle") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "applianceId",
        "yawDegrees",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !identifier(raw.applianceId) ||
      !rotationDegrees(raw.yawDegrees)
    )
      return invalidCommand(
        "The Kitchen equipment angle is invalid.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "set_equipment_angle",
        target,
        applianceId: raw.applianceId,
        yawDegrees: raw.yawDegrees,
      },
    };
  }
  if (raw.kind === "configure_interior") {
    const target = parseSurfaceReference(raw.target);
    const action = parseBakeryStoreInteriorAction(raw.action);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "action"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      action === null
    )
      return invalidCommand(
        "The Kitchen store interior action is invalid.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "configure_interior",
        target,
        action,
      },
    };
  }
  if (raw.kind === "reset_floor_plan") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "action"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !isBakeryFloorPlanResetAction(raw.action)
    )
      return invalidCommand(
        "The Kitchen floor plan reset action is invalid.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "reset_floor_plan",
        target,
        action: raw.action,
      },
    };
  }
  if (raw.kind === "start_production") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "preset"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      (raw.preset !== "procedure" && raw.preset !== "one-batch")
    )
      return invalidCommand("The Kitchen production start is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "start_production",
        target,
        preset: raw.preset,
      },
    };
  }
  if (raw.kind === "compare_shift") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "mode"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      (raw.mode !== "normal" && raw.mode !== "outage")
    )
      return invalidCommand("The Kitchen shift comparison is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "compare_shift",
        target,
        mode: raw.mode,
      },
    };
  }
  if (raw.kind === "run_shift") {
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "baseDraft",
        "edits",
      ])
    )
      return invalidCommand("The Kitchen shift run is invalid.");
    const target = parseSurfaceReference(raw.target);
    const baseDraft = parseDraftReference(raw.baseDraft);
    const edits =
      Array.isArray(raw.edits) && raw.edits.length === 0
        ? []
        : parseEditOperations(raw.edits);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      baseDraft === null ||
      edits === null
    )
      return invalidCommand("The Kitchen shift run is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "run_shift", target, baseDraft, edits },
    };
  }
  if (raw.kind === "prepare_run_save") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "name"]))
      return invalidCommand("The Kitchen run-save proposal is invalid.");
    const target = parseSurfaceReference(raw.target);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      typeof raw.name !== "string" ||
      raw.name.trim().length === 0 ||
      raw.name.length > 80
    )
      return invalidCommand("The Kitchen run-save proposal is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_run_save",
        target,
        name: raw.name.trim(),
      },
    };
  }
  if (raw.kind === "prepare_scenario_save") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "name", "note"]))
      return invalidCommand(
        "The Kitchen scenario-save proposal is invalid.",
      );
    const target = parseSurfaceReference(raw.target);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      typeof raw.name !== "string" ||
      raw.name.trim().length === 0 ||
      raw.name.length > 80 ||
      typeof raw.note !== "string" ||
      raw.note.trim().length === 0 ||
      raw.note.length > 2000
    )
      return invalidCommand(
        "The Kitchen scenario-save proposal is invalid.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_scenario_save",
        target,
        name: raw.name.trim(),
        note: raw.note.trim(),
      },
    };
  }
  if (raw.kind === "apply_reviewed_edit") {
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "baseDraft",
        "proposalDigest",
      ])
    )
      return invalidCommand("The reviewed Kitchen edit is invalid.");
    const target = parseSurfaceReference(raw.target);
    const baseDraft = parseDraftReference(raw.baseDraft);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      baseDraft === null ||
      typeof raw.proposalDigest !== "string" ||
      !SHA256_PATTERN.test(raw.proposalDigest)
    )
      return invalidCommand("The reviewed Kitchen edit is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "apply_reviewed_edit",
        target,
        baseDraft,
        proposalDigest: raw.proposalDigest,
      },
    };
  }
  if (raw.kind === "edit_rehearsal") {
    const target = parseSurfaceReference(raw.target);
    const edit = parseRehearsalEdit(raw.edit);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "planFingerprint",
        "edit",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !identifier(raw.planFingerprint) ||
      edit === null
    )
      return invalidCommand(
        "A rehearsal edit names its plan and one tray chain, baker, start or prerequisite change.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "edit_rehearsal",
        target,
        planFingerprint: raw.planFingerprint,
        edit,
      },
    };
  }
  if (
    raw.kind === "edit_production" ||
    raw.kind === "preview_production" ||
    raw.kind === "apply_production"
  )
    return parseProductionCommand(raw, raw.kind);
  return invalidCommand("The Kitchen surface command is unsupported.");
}

function parseProductionCommand(
  raw: Readonly<Record<string, unknown>>,
  kind: "edit_production" | "preview_production" | "apply_production",
): BakerySurfaceCommandParseResult {
  const target = parseSurfaceReference(raw.target);
  const keys = ["schemaVersion", "kind", "target", "draftDigest"];
  if (
    !hasExactKeys(
      raw,
      kind === "edit_production"
        ? [...keys, "edit"]
        : kind === "apply_production"
          ? [...keys, "planFingerprint"]
          : keys,
    ) ||
    raw.schemaVersion !== 1 ||
    target === null ||
    typeof raw.draftDigest !== "string" ||
    !SHA256_PATTERN.test(raw.draftDigest)
  )
    return invalidCommand(
      "A production command names the draft it was prepared against.",
    );
  const draftDigest = raw.draftDigest;
  if (kind === "preview_production")
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind, target, draftDigest },
    };
  if (kind === "apply_production")
    return identifier(raw.planFingerprint)
      ? {
          kind: "valid",
          value: {
            schemaVersion: 1,
            kind,
            target,
            draftDigest,
            planFingerprint: raw.planFingerprint,
          },
        }
      : invalidCommand("A production apply names the previewed plan.");
  const edit = parseProductionEdit(raw.edit);
  return edit === null
    ? invalidCommand(
        "A production edit changes one tray, manual task or the oven variant, or discards the draft.",
      )
    : {
        kind: "valid",
        value: { schemaVersion: 1, kind, target, draftDigest, edit },
      };
}

function parseProductionReplacement(
  raw: unknown,
): BakeryProductionReplacement | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "source",
      "sourceFingerprint",
      "proposedFingerprint",
      "currentResults",
      "proposedOperations",
    ]) ||
    (raw.source !== "preview" &&
      raw.source !== "procedure" &&
      raw.source !== "one-batch") ||
    !identifier(raw.sourceFingerprint) ||
    !identifier(raw.proposedFingerprint) ||
    !isNonNegativeInteger(raw.currentResults) ||
    !isNonNegativeInteger(raw.proposedOperations)
  )
    return null;
  return {
    source: raw.source,
    sourceFingerprint: raw.sourceFingerprint,
    proposedFingerprint: raw.proposedFingerprint,
    currentResults: raw.currentResults,
    proposedOperations: raw.proposedOperations,
  };
}

function parseProductionEdit(raw: unknown): BakeryProductionEdit | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "prepare_replacement":
      return hasExactKeys(raw, ["kind", "source"]) &&
        (raw.source === "preview" ||
          raw.source === "procedure" ||
          raw.source === "one-batch")
        ? { kind: "prepare_replacement", source: raw.source }
        : null;
    case "assign_tray":
    case "unassign_tray":
      return hasExactKeys(raw, ["kind", "batchId", "tray"]) &&
        identifier(raw.batchId) &&
        smallCount(raw.tray)
        ? { kind: raw.kind, batchId: raw.batchId, tray: raw.tray }
        : null;
    case "set_baker":
      return hasExactKeys(raw, ["kind", "batchId", "tray", "baker"]) &&
        identifier(raw.batchId) &&
        smallCount(raw.tray) &&
        baker(raw.baker)
        ? {
            kind: "set_baker",
            batchId: raw.batchId,
            tray: raw.tray,
            baker: raw.baker,
          }
        : null;
    case "set_prerequisites": {
      const dependsOn = taskLinks(raw.dependsOn);
      return hasExactKeys(raw, ["kind", "batchId", "tray", "dependsOn"]) &&
        identifier(raw.batchId) &&
        smallCount(raw.tray) &&
        dependsOn !== null
        ? {
            kind: "set_prerequisites",
            batchId: raw.batchId,
            tray: raw.tray,
            dependsOn,
          }
        : null;
    }
    case "set_start":
      return hasExactKeys(raw, [
        "kind",
        "batchId",
        "tray",
        "earliestStartSeconds",
      ]) &&
        identifier(raw.batchId) &&
        smallCount(raw.tray) &&
        wholeSeconds(raw.earliestStartSeconds)
        ? {
            kind: "set_start",
            batchId: raw.batchId,
            tray: raw.tray,
            earliestStartSeconds: raw.earliestStartSeconds,
          }
        : null;
    case "set_manual_task": {
      const task = parseManualTask(raw, true);
      return task === null ? null : { kind: "set_manual_task", ...task };
    }
    case "set_variant":
      return hasExactKeys(raw, ["kind", "variant"]) &&
        (raw.variant === "normal" || raw.variant === "outage")
        ? { kind: "set_variant", variant: raw.variant }
        : null;
    case "discard_draft":
      return hasExactKeys(raw, ["kind"]) ? { kind: "discard_draft" } : null;
    default:
      return null;
  }
}

function parseManualTask(
  raw: Readonly<Record<string, unknown>>,
  edit: boolean,
): BakerySurfaceManualTask | null {
  const dependsOn = taskLinks(raw.dependsOn);
  const keys = ["bakeryTaskId", "baker", "dependsOn", "earliestStartSeconds"];
  if (
    !hasExactKeys(raw, edit ? ["kind", ...keys] : keys) ||
    !identifier(raw.bakeryTaskId) ||
    (raw.baker !== null && !baker(raw.baker)) ||
    dependsOn === null ||
    !wholeSeconds(raw.earliestStartSeconds)
  )
    return null;
  return {
    bakeryTaskId: raw.bakeryTaskId,
    baker: raw.baker,
    dependsOn,
    earliestStartSeconds: raw.earliestStartSeconds,
  };
}

// Production tasks a tray or manual task waits for, each named once.
function taskLinks(raw: unknown): string[] | null {
  return Array.isArray(raw) &&
    raw.length <= MAX_TASK_LINKS &&
    raw.every(identifier) &&
    new Set(raw).size === raw.length
    ? [...raw]
    : null;
}

function parseProductionDraft(
  raw: unknown,
): BakerySurfaceProductionDraft | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "digest",
      "batchCount",
      "traysPerBatch",
      "bakerCount",
      "variant",
      "assignments",
      "manualTasks",
      "preview",
      "replacement",
    ]) ||
    typeof raw.digest !== "string" ||
    !SHA256_PATTERN.test(raw.digest) ||
    !smallCount(raw.batchCount) ||
    !smallCount(raw.traysPerBatch) ||
    !baker(raw.bakerCount) ||
    (raw.variant !== "normal" && raw.variant !== "outage") ||
    !Array.isArray(raw.assignments) ||
    raw.assignments.length > MAX_SUMMARIES ||
    !Array.isArray(raw.manualTasks) ||
    raw.manualTasks.length > MAX_MANUAL_TASKS
  )
    return null;
  const replacement =
    raw.replacement === null
      ? null
      : parseProductionReplacement(raw.replacement);
  if (raw.replacement !== null && replacement === null) return null;
  const assignments: BakerySurfaceProductionAssignment[] = [];
  for (const assignment of raw.assignments) {
    const dependsOn = isRecord(assignment)
      ? taskLinks(assignment.dependsOn)
      : null;
    if (
      !isRecord(assignment) ||
      !hasExactKeys(assignment, [
        "batchId",
        "tray",
        "baker",
        "dependsOn",
        "earliestStartSeconds",
      ]) ||
      !identifier(assignment.batchId) ||
      !smallCount(assignment.tray) ||
      !baker(assignment.baker) ||
      dependsOn === null ||
      !wholeSeconds(assignment.earliestStartSeconds)
    )
      return null;
    assignments.push({
      batchId: assignment.batchId,
      tray: assignment.tray,
      baker: assignment.baker,
      dependsOn,
      earliestStartSeconds: assignment.earliestStartSeconds,
    });
  }
  const manualTasks: BakerySurfaceManualTask[] = [];
  for (const task of raw.manualTasks) {
    const parsed = isRecord(task) ? parseManualTask(task, false) : null;
    if (parsed === null) return null;
    manualTasks.push(parsed);
  }
  let preview: BakerySurfaceProductionPreview | null = null;
  if (raw.preview !== null) {
    const run = isRecord(raw.preview) ? parseRunPreview(raw.preview.run) : null;
    if (
      !isRecord(raw.preview) ||
      !hasExactKeys(raw.preview, [
        "planFingerprint",
        "operationCount",
        "run",
      ]) ||
      !identifier(raw.preview.planFingerprint) ||
      !smallCount(raw.preview.operationCount) ||
      run === null
    )
      return null;
    preview = {
      planFingerprint: raw.preview.planFingerprint,
      operationCount: raw.preview.operationCount,
      run,
    };
  }
  return {
    digest: raw.digest,
    batchCount: raw.batchCount,
    traysPerBatch: raw.traysPerBatch,
    bakerCount: raw.bakerCount,
    variant: raw.variant,
    assignments,
    manualTasks,
    replacement,
    preview,
  };
}

function parseRehearsalFaults(raw: unknown): BakeryRehearsalFaults | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["outage", "failure", "recovery"]))
    return null;
  let outage: BakeryRehearsalFaults["outage"] = null;
  if (raw.outage !== null) {
    const value = raw.outage;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["resource", "start", "end"]) ||
      !identifier(value.resource) ||
      !wholeSeconds(value.start) ||
      !wholeSeconds(value.end) ||
      value.end <= value.start
    )
      return null;
    outage = {
      resource: value.resource,
      start: value.start,
      end: value.end,
    };
  }
  let failure: BakeryRehearsalFaults["failure"] = null;
  if (raw.failure !== null) {
    const value = raw.failure;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["bakeryTaskId", "afterSeconds"]) ||
      !identifier(value.bakeryTaskId) ||
      !wholeSeconds(value.afterSeconds) ||
      value.afterSeconds < 1 ||
      value.afterSeconds > 600
    )
      return null;
    failure = {
      bakeryTaskId: value.bakeryTaskId,
      afterSeconds: value.afterSeconds,
    };
  }
  let recovery: BakeryRehearsalFaults["recovery"] = null;
  if (raw.recovery !== null) {
    const value = raw.recovery;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["bakeryTaskId", "seconds"]) ||
      !identifier(value.bakeryTaskId) ||
      !wholeSeconds(value.seconds) ||
      value.seconds < 1 ||
      value.seconds > 3600
    )
      return null;
    recovery = { bakeryTaskId: value.bakeryTaskId, seconds: value.seconds };
  }
  return { outage, failure, recovery };
}

export function isRehearsalChange(
  edit: BakeryRehearsalEdit,
): edit is BakeryRehearsalChange {
  return (
    edit.kind === "add_human_transfer" ||
    edit.kind === "set_cell" ||
    edit.kind === "set_ingredients" ||
    edit.kind === "replace_preset" ||
    edit.kind === "clear_results" ||
    edit.kind === "remove_tray"
  );
}

function parseRehearsalChange(raw: unknown): BakeryRehearsalChange | null {
  if (!isRecord(raw)) return null;
  if (
    raw.kind === "set_ingredients" &&
    hasExactKeys(raw, ["kind", "batchId", "ingredients"]) &&
    identifier(raw.batchId)
  ) {
    try {
      return {
        kind: "set_ingredients",
        batchId: raw.batchId,
        ingredients: parseIngredientLoad(raw.ingredients),
      };
    } catch {
      return null;
    }
  }
  if (
    raw.kind === "set_cell" &&
    hasExactKeys(raw, ["kind", "batchId", "cellId"]) &&
    identifier(raw.batchId) &&
    (raw.cellId === "cold-cell-1" || raw.cellId === "cold-cell-2")
  )
    return { kind: "set_cell", batchId: raw.batchId, cellId: raw.cellId };
  if (
    raw.kind === "replace_preset" &&
    hasExactKeys(raw, ["kind", "preset"]) &&
    (raw.preset === "two-trays" ||
      raw.preset === "table-to-rack" ||
      raw.preset === "table-to-oven" ||
      raw.preset === "oven-cycle" ||
      raw.preset === "oven-table-rack")
  )
    return { kind: "replace_preset", preset: raw.preset };
  if (
    (raw.kind === "clear_results" ||
      raw.kind === "remove_tray" ||
      raw.kind === "add_human_transfer") &&
    hasExactKeys(raw, ["kind", "batchId"]) &&
    identifier(raw.batchId)
  )
    return { kind: raw.kind, batchId: raw.batchId };
  return null;
}

function parseRehearsalReview(raw: unknown): BakeryRehearsalReview | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "change",
      "sourceFingerprint",
      "proposedFingerprint",
      "currentResults",
      "proposedResults",
    ]) ||
    !identifier(raw.sourceFingerprint) ||
    !identifier(raw.proposedFingerprint) ||
    !isNonNegativeInteger(raw.currentResults) ||
    !isNonNegativeInteger(raw.proposedResults)
  )
    return null;
  const change = parseRehearsalChange(raw.change);
  return change === null
    ? null
    : {
        change,
        sourceFingerprint: raw.sourceFingerprint,
        proposedFingerprint: raw.proposedFingerprint,
        currentResults: raw.currentResults,
        proposedResults: raw.proposedResults,
      };
}

function parseRehearsalEdit(raw: unknown): BakeryRehearsalEdit | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "add_human_transfer":
    case "set_ingredients":
    case "set_cell":
    case "replace_preset":
    case "clear_results":
    case "remove_tray":
      return parseRehearsalChange(raw);
    case "set_faults": {
      if (!hasExactKeys(raw, ["kind", "faults"])) return null;
      const faults = parseRehearsalFaults(raw.faults);
      return faults === null ? null : { kind: "set_faults", faults };
    }
    case "add_tray_chain":
      return hasExactKeys(raw, ["kind", "rackCase"]) &&
        (raw.rackCase === "nominal" || raw.rackCase === "slip")
        ? { kind: "add_tray_chain", rackCase: raw.rackCase }
        : null;
    case "set_baker":
      return hasExactKeys(raw, ["kind", "batchId", "baker"]) &&
        identifier(raw.batchId) &&
        baker(raw.baker)
        ? { kind: "set_baker", batchId: raw.batchId, baker: raw.baker }
        : null;
    case "set_start":
      return hasExactKeys(raw, [
        "kind",
        "operationId",
        "earliestStartSeconds",
      ]) &&
        identifier(raw.operationId) &&
        wholeSeconds(raw.earliestStartSeconds)
        ? {
            kind: "set_start",
            operationId: raw.operationId,
            earliestStartSeconds: raw.earliestStartSeconds,
          }
        : null;
    case "set_prerequisites": {
      if (
        !hasExactKeys(raw, ["kind", "batchId", "dependsOn"]) ||
        !identifier(raw.batchId) ||
        !Array.isArray(raw.dependsOn) ||
        raw.dependsOn.length > MAX_SUMMARIES * 3 ||
        !raw.dependsOn.every(identifier) ||
        new Set(raw.dependsOn).size !== raw.dependsOn.length
      )
        return null;
      return {
        kind: "set_prerequisites",
        batchId: raw.batchId,
        dependsOn: [...raw.dependsOn],
      };
    }
    default:
      return null;
  }
}

function parseRehearsalTrays(
  raw: unknown,
): BakerySurfaceRehearsalTray[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_SUMMARIES) return null;
  const trays: BakerySurfaceRehearsalTray[] = [];
  for (const tray of raw) {
    if (
      !isRecord(tray) ||
      !hasExactKeys(tray, [
        ...(Object.hasOwn(tray, "ingredients") ? ["ingredients"] : []),
        "batchId",
        "cellId",
        "baker",
        "dependsOn",
        "earliestStartSeconds",
      ]) ||
      !identifier(tray.batchId) ||
      (tray.cellId !== "cold-cell-1" && tray.cellId !== "cold-cell-2") ||
      !baker(tray.baker) ||
      !Array.isArray(tray.dependsOn) ||
      tray.dependsOn.length > MAX_SUMMARIES * 3 ||
      !tray.dependsOn.every(identifier) ||
      !wholeSeconds(tray.earliestStartSeconds)
    )
      return null;
    let load: { ingredients: IngredientLoad } | Record<string, never> = {};
    if (Object.hasOwn(tray, "ingredients")) {
      try {
        load = { ingredients: parseIngredientLoad(tray.ingredients) };
      } catch {
        return null;
      }
    }
    trays.push({
      ...load,
      batchId: tray.batchId,
      cellId: tray.cellId,
      baker: tray.baker,
      dependsOn: [...tray.dependsOn],
      earliestStartSeconds: tray.earliestStartSeconds,
    });
  }
  return trays;
}

function baker(value: unknown): value is number {
  return smallCount(value);
}

// Trays, batches, bakers and operations each number from 1 to 16.
function smallCount(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 16
  );
}

function wholeSeconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseBakerySurfaceEffect(
  raw: unknown,
): BakerySurfaceEffectParseResult {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "schemaVersion",
      "kind",
      "effectId",
      "dispatchId",
      "commandDigest",
      "deadlineAt",
      "command",
    ]) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== "bakery-surface-effect" ||
    !identifier(raw.effectId) ||
    !identifier(raw.dispatchId) ||
    typeof raw.commandDigest !== "string" ||
    !SHA256_PATTERN.test(raw.commandDigest) ||
    !isNonNegativeInteger(raw.deadlineAt)
  )
    return invalidEffect("The Kitchen surface effect is invalid.");
  const command = parseBakeryEffectCommand(raw.command);
  if (command.kind === "invalid") return invalidEffect(command.message);
  const value: BakerySurfaceEffectV1 = {
    schemaVersion: 1,
    kind: "bakery-surface-effect",
    effectId: raw.effectId,
    dispatchId: raw.dispatchId,
    commandDigest: raw.commandDigest,
    deadlineAt: raw.deadlineAt,
    command: command.value,
  };
  return ENCODER.encode(JSON.stringify(value)).byteLength <= MAX_EFFECT_BYTES
    ? { kind: "valid", value }
    : invalidEffect("The Kitchen surface effect exceeds the size limit.");
}

export async function verifyBakerySurfaceEffect(
  effect: BakerySurfaceEffectV1,
): Promise<boolean> {
  return (
    effect.commandDigest === (await sha256Hex(JSON.stringify(effect.command)))
  );
}

export function parseBakerySurfaceReceipt(
  raw: unknown,
): BakerySurfaceReceiptParseResult {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "schemaVersion",
      "kind",
      "effectId",
      "dispatchId",
      "commandDigest",
      "resultDigest",
      "outcome",
    ]) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== "bakery-surface-receipt" ||
    !identifier(raw.effectId) ||
    !identifier(raw.dispatchId) ||
    typeof raw.commandDigest !== "string" ||
    !SHA256_PATTERN.test(raw.commandDigest) ||
    typeof raw.resultDigest !== "string" ||
    !SHA256_PATTERN.test(raw.resultDigest)
  )
    return invalidReceipt("The Kitchen surface receipt is invalid.");
  const outcome = parseEffectOutcome(raw.outcome);
  if (outcome === null)
    return invalidReceipt(
      "The Kitchen surface receipt outcome is invalid.",
    );
  const value: BakerySurfaceReceiptV1 = {
    schemaVersion: 1,
    kind: "bakery-surface-receipt",
    effectId: raw.effectId,
    dispatchId: raw.dispatchId,
    commandDigest: raw.commandDigest,
    resultDigest: raw.resultDigest,
    outcome,
  };
  const limit =
    outcome.kind === "page_completed"
      ? MAX_PAGE_RECEIPT_BYTES
      : MAX_EFFECT_BYTES;
  return ENCODER.encode(JSON.stringify(value)).byteLength <= limit
    ? { kind: "valid", value }
    : invalidReceipt(
        "The Kitchen surface receipt exceeds the size limit.",
      );
}

export async function verifyBakerySurfaceReceipt(
  receipt: BakerySurfaceReceiptV1,
): Promise<boolean> {
  return (
    receipt.resultDigest === (await sha256Hex(JSON.stringify(receipt.outcome)))
  );
}

export async function verifyBakerySurfaceAttachment(
  attachment: BakerySurfaceAttachmentV1,
): Promise<boolean> {
  return (
    attachment.digest === (await sha256Hex(JSON.stringify(attachment.context)))
  );
}

function parseRunSummary(raw: unknown): BakeryRunSummary | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "kind",
      "end",
      "completed",
      "unfinished",
      "failed",
      "waiting",
    ]) ||
    (raw.kind !== "complete" &&
      raw.kind !== "blocked" &&
      raw.kind !== "horizon") ||
    typeof raw.end !== "number" ||
    !Number.isFinite(raw.end) ||
    raw.end < 0 ||
    typeof raw.waiting !== "number" ||
    !Number.isFinite(raw.waiting) ||
    raw.waiting < 0 ||
    !isNonNegativeInteger(raw.completed) ||
    !isNonNegativeInteger(raw.unfinished) ||
    !isNonNegativeInteger(raw.failed)
  )
    return null;
  return {
    kind: raw.kind,
    end: raw.end,
    completed: raw.completed,
    unfinished: raw.unfinished,
    failed: raw.failed,
    waiting: raw.waiting,
  };
}

function parseRunComparison(raw: unknown): BakeryRunComparison | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["digest", "current", "baseline"]) ||
    typeof raw.digest !== "string" ||
    !SHA256_PATTERN.test(raw.digest)
  )
    return null;
  const current = parseRunSummary(raw.current);
  const baseline = raw.baseline === null ? null : parseRunSummary(raw.baseline);
  if (current === null || (raw.baseline !== null && baseline === null))
    return null;
  return { digest: raw.digest, current, baseline };
}

function parseSimulationReference(
  raw: unknown,
): BakerySimulationReference | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["generation", "operationId"]) ||
    !isNonNegativeInteger(raw.generation) ||
    !identifier(raw.operationId)
  )
    return null;
  return { generation: raw.generation, operationId: raw.operationId };
}

function parseRunOpenReview(raw: unknown): BakeryRunOpenReview | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "id",
      "name",
      "runKind",
      "sourceFingerprint",
      "proposedFingerprint",
      "currentResults",
      "proposedResults",
    ]) ||
    !isRunSnapshotId(raw.id) ||
    typeof raw.name !== "string" ||
    raw.name.trim().length === 0 ||
    raw.name.length > 80 ||
    (raw.runKind !== "rehearsal" && raw.runKind !== "production") ||
    typeof raw.sourceFingerprint !== "string" ||
    !SHA256_PATTERN.test(raw.sourceFingerprint) ||
    typeof raw.proposedFingerprint !== "string" ||
    !SHA256_PATTERN.test(raw.proposedFingerprint) ||
    !isNonNegativeInteger(raw.currentResults) ||
    !isNonNegativeInteger(raw.proposedResults)
  )
    return null;
  return {
    id: raw.id,
    name: raw.name,
    runKind: raw.runKind,
    sourceFingerprint: raw.sourceFingerprint,
    proposedFingerprint: raw.proposedFingerprint,
    currentResults: raw.currentResults,
    proposedResults: raw.proposedResults,
  };
}

function parseContext(raw: unknown): BakerySurfaceContextV1 | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "schemaVersion",
      "kind",
      "surfaceSessionId",
      "surfaceEpoch",
      "capturedAt",
      "comparison",
      "simulation",
      "runOpenReview",
      "supportedCommands",
      "active",
    ]) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== "bakery-workspace" ||
    !identifier(raw.surfaceSessionId) ||
    !isNonNegativeInteger(raw.surfaceEpoch) ||
    !isNonNegativeInteger(raw.capturedAt) ||
    !Array.isArray(raw.supportedCommands)
  )
    return null;
  const supportedCommands = parseCommands(raw.supportedCommands);
  const comparison =
    raw.comparison === null ? null : parseRunComparison(raw.comparison);
  if (raw.comparison !== null && comparison === null) return null;
  const simulation =
    raw.simulation === null ? null : parseSimulationReference(raw.simulation);
  if (raw.simulation !== null && simulation === null) return null;
  const active = parseActive(raw.active);
  if (supportedCommands === null || active === null) return null;
  const runOpenReview =
    raw.runOpenReview === null ? null : parseRunOpenReview(raw.runOpenReview);
  if (
    raw.runOpenReview !== null &&
    (runOpenReview === null ||
      (active.kind !== "production" &&
        !(
          active.kind === "rehearsal" && active.rehearsalKind === "scheduled"
        )) ||
      active.planFingerprint !== runOpenReview.sourceFingerprint ||
      active.kind !== runOpenReview.runKind)
  )
    return null;
  if (
    active.kind !== "shift" &&
    active.kind !== "persistent" &&
    active.kind !== "persistent-snapshot" &&
    active.candidate !== null &&
    (active.candidate.surfaceSessionId !== raw.surfaceSessionId ||
      active.candidate.surfaceEpoch !== raw.surfaceEpoch)
  )
    return null;
  return {
    schemaVersion: 1,
    kind: "bakery-workspace",
    surfaceSessionId: raw.surfaceSessionId,
    surfaceEpoch: raw.surfaceEpoch,
    capturedAt: raw.capturedAt,
    comparison,
    simulation,
    runOpenReview,
    supportedCommands,
    active,
  };
}

function parseCommands(
  raw: readonly unknown[],
): BakerySurfaceToolCommandName[] | null {
  if (raw.length > 32) return null;
  const commands: BakerySurfaceToolCommandName[] = [];
  for (const value of raw) {
    if (
      value !== "inspect_surface" &&
      value !== "read_draft" &&
      value !== "query_tasks" &&
      value !== "set_view" &&
      value !== "control_baseline" &&
      value !== "show_production_panel" &&
      value !== "control_workspace_view" &&
      value !== "control_playback" &&
      value !== "prepare_workcell" &&
      value !== "prepare_layout" &&
      value !== "prepare_production_control" &&
      value !== "prepare_edit" &&
      value !== "run_shift" &&
      value !== "select_item" &&
      value !== "rotate_equipment" &&
      value !== "set_equipment_angle" &&
      value !== "move_equipment" &&
      value !== "toggle_opening" &&
      value !== "select_floor_plan" &&
      value !== "configure_interior" &&
      value !== "reset_floor_plan" &&
      value !== "compare_shift" &&
      value !== "start_production" &&
      value !== "prepare_run_save" &&
      value !== "file_action" &&
      value !== "inspect_scenario_save" &&
      value !== "inspect_run_save" &&
      value !== "list_saved_runs" &&
      value !== "prepare_run_open" &&
      value !== "prepare_scenario_save" &&
      value !== "stop_simulation" &&
      value !== "simulate_workcell" &&
      value !== "accept_candidate" &&
      value !== "discard_candidate" &&
      value !== "edit_rehearsal" &&
      value !== "edit_production" &&
      value !== "preview_production" &&
      value !== "apply_production"
    )
      return null;
    if (commands.includes(value)) return null;
    commands.push(value);
  }
  return commands;
}

function parseActive(raw: unknown): BakerySurfaceContextV1["active"] | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  switch (raw.kind) {
    case "persistent":
      return parseBakeryPersistentSurface(raw);
    case "persistent-snapshot":
      return parseBakeryProductionSnapshotSurface(raw);
    case "shift":
      return parseShift(raw);
    case "rehearsal":
      return parseRehearsal(raw);
    case "production":
      return parseProduction(raw);
    default:
      return null;
  }
}

function parseRecordingView(
  raw: unknown,
):
  | (BakeryRecordingCameraView &
      Readonly<{ doorInspection: BakeryDoorInspection }>)
  | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["camera", "doorInspection"]) ||
    !recordingCamera(raw.camera) ||
    !isRecord(raw.doorInspection)
  )
    return null;
  const door = raw.doorInspection;
  if (
    (door.kind === "unavailable" || door.kind === "recorded") &&
    hasExactKeys(door, ["kind"])
  )
    return { camera: raw.camera, doorInspection: { kind: door.kind } };
  if (
    door.kind === "preview" &&
    hasExactKeys(door, ["kind", "degrees"]) &&
    doorDegrees(door.degrees)
  )
    return {
      camera: raw.camera,
      doorInspection: { kind: "preview", degrees: door.degrees },
    };
  return null;
}

function parseCameraView(raw: unknown): BakeryCameraView | null {
  const view = parseRecordingCameraView(raw);
  if (
    view === null ||
    (view.camera !== "perspective" && view.camera !== "overhead")
  )
    return null;
  return { camera: view.camera };
}

function parseShift(
  raw: Readonly<Record<string, unknown>>,
): Variant<BakerySurfaceContextV1["active"], "shift"> | null {
  const view = parseShiftView(raw.view);
  if (
    view === null ||
    !hasExactKeys(raw, [
      "kind",
      "view",
      "source",
      "sourceIdentity",
      "variant",
      "selection",
      "selectedTask",
      "playback",
      "draft",
      "pendingEdit",
      "scenarioSaveProposal",
      "run",
      ...(raw.layout === undefined ? [] : ["layout"]),
    ]) ||
    (raw.source !== "sample" && raw.source !== "procedure") ||
    (raw.variant !== "normal" && raw.variant !== "outage")
  )
    return null;
  const selection = parseSelection(raw.selection);
  const sourceIdentity = parseSourceIdentity(raw.sourceIdentity);
  const selectedTask =
    raw.selectedTask === null ? null : parseTaskDetail(raw.selectedTask);
  const playback = parsePlayback(raw.playback);
  const draft = parseDraftReference(raw.draft);
  const pendingEdit =
    raw.pendingEdit === null ? null : parseEditProposal(raw.pendingEdit);
  const scenarioSaveProposal =
    raw.scenarioSaveProposal === null
      ? null
      : parseScenarioSaveManifest(raw.scenarioSaveProposal);
  const layout =
    raw.layout === undefined ? undefined : parseShiftLayout(raw.layout);
  if (
    !isRecord(raw.run) ||
    layout === null ||
    selection === null ||
    sourceIdentity === null ||
    sourceIdentity.kind !== raw.source ||
    (raw.selectedTask !== null && selectedTask === null) ||
    playback === null ||
    draft === null ||
    (raw.pendingEdit !== null && pendingEdit === null) ||
    (raw.scenarioSaveProposal !== null && scenarioSaveProposal === null)
  )
    return null;
  if (
    !hasExactKeys(raw.run, [
      "state",
      "endSeconds",
      "lateBatches",
      "unfinishedBatches",
    ]) ||
    (raw.run.state !== "complete" &&
      raw.run.state !== "blocked" &&
      raw.run.state !== "horizon") ||
    !seconds(raw.run.endSeconds) ||
    !isNonNegativeInteger(raw.run.lateBatches) ||
    !isNonNegativeInteger(raw.run.unfinishedBatches)
  )
    return null;
  return {
    kind: "shift",
    view,
    source: raw.source,
    sourceIdentity,
    variant: raw.variant,
    selection,
    selectedTask,
    playback,
    draft,
    pendingEdit,
    scenarioSaveProposal,
    run: {
      state: raw.run.state,
      endSeconds: raw.run.endSeconds,
      lateBatches: raw.run.lateBatches,
      unfinishedBatches: raw.run.unfinishedBatches,
    },
    ...(layout === undefined ? {} : { layout }),
  };
}

function parseShiftLayout(raw: unknown): BakerySurfaceShiftLayout | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "floorPlan",
      "equipment",
      ...(raw.openings === undefined ? [] : ["openings"]),
      ...(raw.interior === undefined ? [] : ["interior"]),
      ...(raw.history === undefined ? [] : ["history"]),
    ]) ||
    !identifier(raw.floorPlan) ||
    !Array.isArray(raw.equipment) ||
    raw.equipment.length > MAX_EQUIPMENT
  )
    return null;
  const equipment: BakerySurfaceEquipment[] = [];
  for (const item of raw.equipment) {
    const hasCoords =
      isRecord(item) && item.xMm !== undefined && item.zMm !== undefined;
    if (
      !isRecord(item) ||
      !hasExactKeys(
        item,
        hasCoords
          ? ["id", "label", "rotationDegrees", "xMm", "zMm"]
          : ["id", "label", "rotationDegrees"],
      ) ||
      !identifier(item.id) ||
      !label(item.label) ||
      !rotationDegrees(item.rotationDegrees) ||
      (hasCoords &&
        (!floorPlanCoordinateMm(item.xMm) ||
          !floorPlanCoordinateMm(item.zMm))) ||
      equipment.some(sameEquipmentId.bind(null, item.id))
    )
      return null;
    equipment.push({
      id: item.id,
      label: item.label,
      rotationDegrees: item.rotationDegrees,
      ...(hasCoords
        ? { xMm: item.xMm as number, zMm: item.zMm as number }
        : {}),
    });
  }
  const interior =
    raw.interior === undefined ? undefined : parseStoreInterior(raw.interior);
  if (raw.interior !== undefined && interior === null) return null;
  const history =
    raw.history === undefined ? undefined : parseFloorPlanHistory(raw.history);
  if (raw.history !== undefined && history === null) return null;
  let openings: BakerySurfaceOpening[] | undefined;
  if (raw.openings !== undefined) {
    if (!Array.isArray(raw.openings) || raw.openings.length > 24) {
      return null;
    }
    openings = [];
    for (const entry of raw.openings) {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ["id", "label", "kind", "open", "progress"]) ||
        !identifier(entry.id) ||
        !label(entry.label) ||
        (entry.kind !== "door" && entry.kind !== "window") ||
        typeof entry.open !== "boolean" ||
        typeof entry.progress !== "number" ||
        !Number.isFinite(entry.progress) ||
        entry.progress < 0 ||
        entry.progress > 1 ||
        openings.some((existing) => existing.id === entry.id)
      )
        return null;
      openings.push({
        id: entry.id,
        label: entry.label,
        kind: entry.kind,
        open: entry.open,
        progress: entry.progress,
      });
    }
  }
  return {
    floorPlan: raw.floorPlan,
    equipment,
    ...(openings === undefined ? {} : { openings }),
    ...(interior === undefined || interior === null ? {} : { interior }),
    ...(history === undefined || history === null ? {} : { history }),
  };
}

function storeInteriorPresetId(
  value: unknown,
): value is BakeryStoreInteriorPresetId {
  return (
    value === "kuramae-artisan" ||
    value === "noix-parisien" ||
    value === "kiyosumi-minimal" ||
    value === "kyoto-machiya"
  );
}

function floorMaterialId(value: unknown): value is BakeryFloorMaterialId {
  return (
    value === "herringbone-oak" ||
    value === "terrazzo-stone" ||
    value === "limestone-checker" ||
    value === "quarry-terracotta" ||
    value === "smoked-cedar"
  );
}

function wallMaterialId(value: unknown): value is BakeryWallMaterialId {
  return (
    value === "limewash-hinoki" ||
    value === "parisian-boiserie" ||
    value === "board-concrete" ||
    value === "juraku-lattice"
  );
}

function fixtureFinishId(value: unknown): value is BakeryFixtureFinishId {
  return (
    value === "blackened-steel" ||
    value === "aged-brass" ||
    value === "natural-oak"
  );
}

function lightingStyleId(value: unknown): value is BakeryLightingStyleId {
  return (
    value === "brass-pendants" ||
    value === "atelier-track" ||
    value === "washi-lanterns"
  );
}

function wallHeightMode(value: unknown): value is BakeryWallHeightMode {
  return (
    value === "cutaway" || value === "smart-cutaway" || value === "full"
  );
}

function parseStoreInterior(raw: unknown): BakerySurfaceStoreInterior | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "preset",
      "floorMaterial",
      "wallMaterial",
      "fixtureFinish",
      "lightingStyle",
      "wallHeightMode",
      "showFurnishings",
    ]) ||
    (raw.preset !== "custom" && !storeInteriorPresetId(raw.preset)) ||
    !floorMaterialId(raw.floorMaterial) ||
    !wallMaterialId(raw.wallMaterial) ||
    !fixtureFinishId(raw.fixtureFinish) ||
    !lightingStyleId(raw.lightingStyle) ||
    !wallHeightMode(raw.wallHeightMode) ||
    typeof raw.showFurnishings !== "boolean"
  )
    return null;
  return {
    preset: raw.preset,
    floorMaterial: raw.floorMaterial,
    wallMaterial: raw.wallMaterial,
    fixtureFinish: raw.fixtureFinish,
    lightingStyle: raw.lightingStyle,
    wallHeightMode: raw.wallHeightMode,
    showFurnishings: raw.showFurnishings,
  };
}

function parseFloorPlanHistory(
  raw: unknown,
): BakerySurfaceFloorPlanHistory | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "canUndo",
      "canRedo",
      "hasCustomLayout",
      "undoLabel",
      "redoLabel",
    ]) ||
    typeof raw.canUndo !== "boolean" ||
    typeof raw.canRedo !== "boolean" ||
    typeof raw.hasCustomLayout !== "boolean" ||
    (raw.undoLabel !== null && !label(raw.undoLabel)) ||
    (raw.redoLabel !== null && !label(raw.redoLabel))
  )
    return null;
  return {
    canUndo: raw.canUndo,
    canRedo: raw.canRedo,
    hasCustomLayout: raw.hasCustomLayout,
    undoLabel: raw.undoLabel,
    redoLabel: raw.redoLabel,
  };
}

export function parseBakeryStoreInteriorAction(
  raw: unknown,
): BakeryStoreInteriorAction | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  switch (raw.kind) {
    case "apply_preset":
      return hasExactKeys(raw, ["kind", "preset"]) &&
        storeInteriorPresetId(raw.preset)
        ? { kind: "apply_preset", preset: raw.preset }
        : null;
    case "set_floor_material":
      return hasExactKeys(raw, ["kind", "floorMaterial"]) &&
        floorMaterialId(raw.floorMaterial)
        ? { kind: "set_floor_material", floorMaterial: raw.floorMaterial }
        : null;
    case "set_wall_material":
      return hasExactKeys(raw, ["kind", "wallMaterial"]) &&
        wallMaterialId(raw.wallMaterial)
        ? { kind: "set_wall_material", wallMaterial: raw.wallMaterial }
        : null;
    case "set_fixture_finish":
      return hasExactKeys(raw, ["kind", "fixtureFinish"]) &&
        fixtureFinishId(raw.fixtureFinish)
        ? { kind: "set_fixture_finish", fixtureFinish: raw.fixtureFinish }
        : null;
    case "set_lighting_style":
      return hasExactKeys(raw, ["kind", "lightingStyle"]) &&
        lightingStyleId(raw.lightingStyle)
        ? { kind: "set_lighting_style", lightingStyle: raw.lightingStyle }
        : null;
    case "set_wall_height":
      return hasExactKeys(raw, ["kind", "wallHeightMode"]) &&
        wallHeightMode(raw.wallHeightMode)
        ? { kind: "set_wall_height", wallHeightMode: raw.wallHeightMode }
        : null;
    case "set_furnishings":
      return hasExactKeys(raw, ["kind", "showFurnishings"]) &&
        typeof raw.showFurnishings === "boolean"
        ? { kind: "set_furnishings", showFurnishings: raw.showFurnishings }
        : null;
    default:
      return null;
  }
}

export function isBakeryFloorPlanResetAction(
  value: unknown,
): value is BakeryFloorPlanResetAction {
  return (
    value === "undo" ||
    value === "redo" ||
    value === "reset_appliances" ||
    value === "reset_initial"
  );
}

export function normalizeYawDegrees(degrees: number): number {
  const normalized =
    ((((Math.round(degrees) + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 ? 180 : normalized;
}

function floorPlanCoordinateMm(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -20_000 &&
    value <= 20_000
  );
}

const FLOOR_PLAN_IDS: ReadonlySet<unknown> = new Set([
  "asakusabashi-t101940",
  "kinshicho-6992842011",
  "machiya-sun-reve",
  "hongo-8257562",
  "reference",
]);
const floorPlanId = (v: unknown): v is string => FLOOR_PLAN_IDS.has(v);

function sameEquipmentId(id: string, item: BakerySurfaceEquipment): boolean {
  return item.id === id;
}

// A yaw in whole degrees, from -180 (exclusive) to 180.
function rotationDegrees(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > -180 &&
    value <= 180
  );
}

// The yaw after Rotate 90°: snapped to a quarter turn, then turned once more.
export function quarterTurnDegrees(rotationDegrees: number): number {
  const turned = Math.round(rotationDegrees / 90) * 90 + 90;
  const normalized = ((((turned + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 ? 180 : normalized;
}

function parseRehearsal(
  raw: Readonly<Record<string, unknown>>,
): Variant<BakerySurfaceContextV1["active"], "rehearsal"> | null {
  if (raw.rehearsalKind === "scheduled") return parseScheduledRehearsal(raw);
  const view = parseRecordingView(raw.view);
  if (view === null) return null;
  if (
    !hasExactKeys(raw, [
      "kind",
      "view",
      "rehearsalKind",
      "readiness",
      "selection",
      "playback",
      "runId",
      "attemptId",
      "tasks",
      "resources",
      "candidate",
      "runSaveProposal",
      ...(raw.rackLayout === undefined ? [] : ["rackLayout"]),
    ]) ||
    (raw.rehearsalKind !== "standalone" && raw.rehearsalKind !== "trays") ||
    (raw.readiness !== "empty" &&
      raw.readiness !== "setup" &&
      raw.readiness !== "ready") ||
    (raw.runId !== null && !identifier(raw.runId)) ||
    (raw.attemptId !== null && !identifier(raw.attemptId)) ||
    !Array.isArray(raw.tasks) ||
    !Array.isArray(raw.resources)
  )
    return null;
  const rackLayout =
    raw.rackLayout == null ? null : parseRackLayoutContext(raw.rackLayout);
  if (raw.rackLayout != null && rackLayout === null) return null;
  const selection =
    raw.selection === null ? null : parseSelection(raw.selection);
  const playback = parsePlayback(raw.playback);
  const tasks = parseSummaries(raw.tasks);
  const resources = parseSummaries(raw.resources);
  const candidate =
    raw.candidate === null
      ? null
      : parseRecordingAcceptanceReference(raw.candidate);
  const runSaveProposal =
    raw.runSaveProposal === null
      ? null
      : parseRunSaveManifest(raw.runSaveProposal);
  if (
    (raw.selection !== null && selection === null) ||
    playback === null ||
    tasks === null ||
    resources === null ||
    (raw.candidate !== null && candidate === null) ||
    (raw.runSaveProposal !== null && runSaveProposal === null) ||
    (candidate !== null &&
      candidate.kind !== (raw.rehearsalKind === "trays" ? "trays" : "workcell"))
  )
    return null;
  return {
    kind: "rehearsal",
    view,
    rackLayout,
    rehearsalKind: raw.rehearsalKind,
    readiness: raw.readiness,
    selection,
    playback,
    runId: raw.runId,
    attemptId: raw.attemptId,
    tasks,
    resources,
    candidate,
    runSaveProposal,
  };
}

function parseScheduledRehearsal(
  raw: Readonly<Record<string, unknown>>,
): BakerySurfaceScheduledRehearsal | null {
  const view = parseCameraView(raw.view);
  if (view === null) return null;
  const panel = parseBakeryProductionPanel(raw.panel);
  if (
    panel === null ||
    !hasExactKeys(raw, [
      "kind",
      "view",
      "panel",
      "rehearsalKind",
      "rackLayout",
      "readiness",
      "selection",
      "playback",
      "runId",
      "attemptId",
      "planFingerprint",
      "pendingOperation",
      "tasks",
      "resources",
      "trays",
      "bakerCount",
      "faults",
      "editReview",
      "candidate",
      "runSaveProposal",
    ]) ||
    (raw.readiness !== "empty" && raw.readiness !== "ready") ||
    !Number.isInteger(raw.bakerCount) ||
    (raw.bakerCount as number) < 0 ||
    (raw.bakerCount as number) > 16 ||
    raw.runId !== null ||
    raw.attemptId !== null ||
    (raw.planFingerprint !== null && !identifier(raw.planFingerprint)) ||
    (raw.readiness === "ready") !== (raw.planFingerprint !== null) ||
    !Array.isArray(raw.tasks) ||
    !Array.isArray(raw.resources)
  )
    return null;
  let rackLayout: BakerySurfaceTrayLayout | null = null;
  if (raw.rackLayout !== null) {
    if (!isRecord(raw.rackLayout) || !identifier(raw.rackLayout.operationId))
      return null;
    const { operationId, ...layout } = raw.rackLayout;
    const parsed = parseRackLayoutContext(layout);
    if (parsed === null) return null;
    rackLayout = { ...parsed, operationId };
  }
  const pendingOperation = parsePendingOperation(raw.pendingOperation);
  if (raw.pendingOperation !== null && pendingOperation === null) return null;
  const selection =
    raw.selection === null ? null : parseSelection(raw.selection);
  const playback = parsePlayback(raw.playback);
  const tasks = parseSummaries(raw.tasks);
  const resources = parseSummaries(raw.resources);
  const trays = parseRehearsalTrays(raw.trays);
  const faults = parseRehearsalFaults(raw.faults);
  const editReview =
    raw.editReview === null ? null : parseRehearsalReview(raw.editReview);
  if (raw.editReview !== null && editReview === null) return null;
  const candidate =
    raw.candidate === null
      ? null
      : parseRecordingAcceptanceReference(raw.candidate);
  const runSaveProposal =
    raw.runSaveProposal === null
      ? null
      : parseRunSaveManifest(raw.runSaveProposal);
  if (
    (raw.selection !== null && selection === null) ||
    playback === null ||
    tasks === null ||
    resources === null ||
    trays === null ||
    faults === null ||
    (raw.candidate !== null && candidate === null) ||
    (candidate !== null && candidate.kind !== "production") ||
    (raw.runSaveProposal !== null && runSaveProposal === null)
  )
    return null;
  return {
    kind: "rehearsal",
    view,
    rehearsalKind: "scheduled",
    panel,
    rackLayout,
    readiness: raw.readiness,
    selection,
    playback,
    runId: null,
    attemptId: null,
    planFingerprint: raw.planFingerprint,
    pendingOperation,
    tasks,
    resources,
    trays,
    faults,
    editReview,
    bakerCount: raw.bakerCount as number,
    candidate,
    runSaveProposal,
  };
}

function parsePendingOperation(
  raw: unknown,
): BakerySurfacePendingOperation | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["operationId", "label", "mode"]) ||
    !identifier(raw.operationId) ||
    !label(raw.label) ||
    !simulationMode(raw.mode)
  )
    return null;
  return { operationId: raw.operationId, label: raw.label, mode: raw.mode };
}

function parseProduction(
  raw: Readonly<Record<string, unknown>>,
): Variant<BakerySurfaceContextV1["active"], "production"> | null {
  const view = parseCameraView(raw.view);
  if (view === null) return null;
  const panel = parseBakeryProductionPanel(raw.panel);
  if (
    panel === null ||
    !hasExactKeys(raw, [
      "kind",
      "view",
      "panel",
      "pendingOperation",
      "readiness",
      "planFingerprint",
      "variant",
      "operationCount",
      "operations",
      "selection",
      "playback",
      "candidate",
      "scenarioSaveProposal",
      "draft",
    ]) ||
    (raw.readiness !== "loading" &&
      raw.readiness !== "failed" &&
      raw.readiness !== "ready") ||
    (raw.planFingerprint !== null && !identifier(raw.planFingerprint)) ||
    (raw.variant !== null &&
      raw.variant !== "normal" &&
      raw.variant !== "outage") ||
    !isNonNegativeInteger(raw.operationCount) ||
    !Array.isArray(raw.operations)
  )
    return null;
  const pendingOperation = parsePendingOperation(raw.pendingOperation);
  if (raw.pendingOperation !== null && pendingOperation === null) return null;
  const operations = parseSummaries(raw.operations);
  const candidate =
    raw.candidate === null
      ? null
      : parseRecordingAcceptanceReference(raw.candidate);
  const scenarioSaveProposal =
    raw.scenarioSaveProposal === null
      ? null
      : parseScenarioSaveManifest(raw.scenarioSaveProposal);
  if (raw.scenarioSaveProposal !== null && scenarioSaveProposal === null)
    return null;
  if (raw.candidate !== null && candidate === null) return null;
  if (candidate !== null && candidate.kind !== "production") return null;
  if (operations === null || operations.length !== raw.operationCount)
    return null;
  if (raw.readiness === "loading" || raw.readiness === "failed") {
    if (
      pendingOperation !== null ||
      raw.planFingerprint !== null ||
      raw.variant !== null ||
      raw.operationCount !== 0 ||
      operations.length !== 0 ||
      raw.selection !== null ||
      raw.playback !== null ||
      candidate !== null ||
      raw.draft !== null
    )
      return null;
    return {
      kind: "production",
      view,
      panel,
      pendingOperation: null,
      readiness: raw.readiness,
      planFingerprint: null,
      variant: null,
      operationCount: 0,
      operations: [],
      selection: null,
      playback: null,
      candidate: null,
      scenarioSaveProposal,
      draft: null,
    };
  }
  if (raw.planFingerprint === null || raw.variant === null) return null;
  const selection = parseSelection(raw.selection);
  const playback = parsePlayback(raw.playback);
  const draft = raw.draft === null ? null : parseProductionDraft(raw.draft);
  if (
    selection === null ||
    playback === null ||
    (raw.draft !== null && draft === null)
  )
    return null;
  return {
    kind: "production",
    view,
    panel,
    pendingOperation,
    readiness: "ready",
    planFingerprint: raw.planFingerprint,
    variant: raw.variant,
    operationCount: raw.operationCount,
    operations,
    selection,
    playback,
    candidate,
    scenarioSaveProposal,
    draft,
  };
}

function parseSelection(raw: unknown): BakerySurfaceSelection | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "id", "label"]) ||
    (raw.kind !== "batch" &&
      raw.kind !== "station" &&
      raw.kind !== "task" &&
      raw.kind !== "resource" &&
      raw.kind !== "operation") ||
    !identifier(raw.id) ||
    !label(raw.label)
  )
    return null;
  return { kind: raw.kind, id: raw.id, label: raw.label };
}

function parseSourceIdentity(
  raw: unknown,
): Variant<BakerySurfaceContextV1["active"], "shift">["sourceIdentity"] | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  if (raw.kind === "sample")
    return hasExactKeys(raw, ["kind", "id"]) && raw.id === "financier-sample"
      ? { kind: "sample", id: "financier-sample" }
      : null;
  if (
    raw.kind !== "procedure" ||
    !hasExactKeys(raw, ["kind", "id", "revision", "snapshotRevision"]) ||
    !identifier(raw.id) ||
    !identifier(raw.revision) ||
    !identifier(raw.snapshotRevision)
  )
    return null;
  return {
    kind: "procedure",
    id: raw.id,
    revision: raw.revision,
    snapshotRevision: raw.snapshotRevision,
  };
}

function parseTaskDetail(raw: unknown): BakerySurfaceTaskDetail | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "id",
      "name",
      "kind",
      "status",
      "startSeconds",
      "endSeconds",
      "batchId",
      "dependencies",
      "resources",
      "constraints",
    ]) ||
    !identifier(raw.id) ||
    !label(raw.name) ||
    (raw.kind !== "process" &&
      raw.kind !== "transfer" &&
      raw.kind !== "handoff" &&
      raw.kind !== "native") ||
    (raw.status !== "pending" &&
      raw.status !== "running" &&
      raw.status !== "complete") ||
    !seconds(raw.startSeconds) ||
    !seconds(raw.endSeconds) ||
    raw.endSeconds < raw.startSeconds ||
    !identifier(raw.batchId)
  )
    return null;
  const dependencies = parseLabels(raw.dependencies, 8);
  const resources = parseLabels(raw.resources, 8);
  const constraints = parseLabels(raw.constraints, 8);
  if (dependencies === null || resources === null || constraints === null)
    return null;
  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind,
    status: raw.status,
    startSeconds: raw.startSeconds,
    endSeconds: raw.endSeconds,
    batchId: raw.batchId,
    dependencies,
    resources,
    constraints,
  };
}

function parseDraftSnapshot(raw: unknown): BakerySurfaceDraftSnapshot | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "draft"]) ||
    raw.kind !== "draft" ||
    !isRecord(raw.draft) ||
    !hasExactKeys(raw.draft, ["reference", "values"]) ||
    !isRecord(raw.draft.values)
  )
    return null;
  const reference = parseDraftReference(raw.draft.reference);
  if (reference === null || !hasExactKeys(raw.draft.values, SETTINGS_FIELDS))
    return null;
  const values = {} as Record<SettingsField, number>;
  for (const field of SETTINGS_FIELDS) {
    const value = raw.draft.values[field];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    values[field] = value;
  }
  return { reference, values };
}

function parseLabels(raw: unknown, limit: number): readonly string[] | null {
  if (!Array.isArray(raw) || raw.length > limit || !raw.every(label))
    return null;
  return raw;
}

function parseEffectOutcome(raw: unknown): BakerySurfaceEffectOutcomeV1 | null {
  if (
    isRecord(raw) &&
    raw.kind === "prepared" &&
    hasExactKeys(raw, ["kind", "binding", "surface"])
  ) {
    const binding = parseBakeryBrowserBinding(raw.binding);
    const surface = parseBakerySurfaceAttachment(raw.surface);
    return binding !== null && surface.kind === "valid"
      ? { kind: "prepared", binding, surface: surface.value }
      : null;
  }
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  if (raw.kind === "completed") {
    if (!hasExactKeys(raw, ["kind", "result"])) return null;
    const result = parseCommandResult(raw.result);
    return result === null ? null : { kind: "completed", result };
  }
  if (raw.kind === "page_completed") {
    if (!hasExactKeys(raw, ["kind", "observation"])) return null;
    const observation = parseSurfaceObservation(raw.observation);
    return observation === null
      ? null
      : { kind: "page_completed", observation };
  }
  if (raw.kind === "page_rejected")
    return hasExactKeys(raw, ["kind", "message"]) && label(raw.message)
      ? { kind: "page_rejected", message: raw.message }
      : null;
  if (
    raw.kind !== "delivery_failed" ||
    !hasExactKeys(raw, ["kind", "code", "message"]) ||
    (raw.code !== "effect_invalid" &&
      raw.code !== "effect_expired" &&
      raw.code !== "effect_cancelled" &&
      raw.code !== "effect_indeterminate" &&
      raw.code !== "effect_conflict" &&
      raw.code !== "surface_unavailable" &&
      raw.code !== "ledger_full") ||
    !label(raw.message)
  )
    return null;
  return { kind: "delivery_failed", code: raw.code, message: raw.message };
}

function parseCommandResult(raw: unknown): BakerySurfaceCommandResultV1 | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  if (raw.kind === "succeeded") {
    if (
      !hasExactKeys(raw, ["kind", "command", "surface", "output"]) ||
      !surfaceCommandName(raw.command)
    )
      return null;
    const surface = parseBakerySurfaceAttachment(raw.surface);
    if (surface.kind === "invalid" || !isRecord(raw.output)) return null;
    if (raw.command === "file_action") {
      if (
        !hasExactKeys(raw.output, ["kind", "action", "manifest"]) ||
        raw.output.kind !== "file" ||
        (raw.output.action !== "import" && raw.output.action !== "export")
      )
        return null;
      const manifest = parseBakeryFileManifest(raw.output.manifest);
      return manifest === null
        ? null
        : {
            kind: "succeeded",
            command: "file_action",
            surface: surface.value,
            output: { kind: "file", action: raw.output.action, manifest },
          };
    }
    if (raw.command === "inspect_scenario_save") {
      if (
        !hasExactKeys(raw.output, ["kind", "save"]) ||
        raw.output.kind !== "scenario_save_inspection"
      )
        return null;
      const save = parseScenarioSaveInspection(raw.output.save);
      return save === null
        ? null
        : {
            kind: "succeeded",
            command: "inspect_scenario_save",
            surface: surface.value,
            output: { kind: "scenario_save_inspection", save },
          };
    }
    if (raw.command === "inspect_run_save") {
      if (
        !hasExactKeys(raw.output, ["kind", "runKind", "save"]) ||
        raw.output.kind !== "run_save_inspection" ||
        (raw.output.runKind !== "rehearsal" &&
          raw.output.runKind !== "production")
      )
        return null;
      const save = parseRunSaveInspection(raw.output.save);
      return save === null
        ? null
        : {
            kind: "succeeded",
            command: "inspect_run_save",
            surface: surface.value,
            output: {
              kind: "run_save_inspection",
              runKind: raw.output.runKind,
              save,
            },
          };
    }
    if (raw.command === "list_saved_runs") {
      if (
        !hasExactKeys(raw.output, ["kind", "runKind", "cursor", "page"]) ||
        raw.output.kind !== "saved_runs" ||
        !isRunSnapshotCursor(raw.output.cursor) ||
        (raw.output.runKind !== "rehearsal" &&
          raw.output.runKind !== "production")
      )
        return null;
      const page = parseRunSnapshotPage(raw.output.page);
      if (page === null) return null;
      for (const snapshot of page.snapshots)
        if (snapshot.kind !== raw.output.runKind) return null;
      return {
        kind: "succeeded",
        command: "list_saved_runs",
        surface: surface.value,
        output: {
          kind: "saved_runs",
          runKind: raw.output.runKind,
          cursor: raw.output.cursor,
          page,
        },
      };
    }
    if (raw.command === "read_draft") {
      const draft = parseDraftSnapshot(raw.output);
      return draft === null
        ? null
        : {
            kind: "succeeded",
            command: "read_draft",
            surface: surface.value,
            output: { kind: "draft", draft },
          };
    }
    if (raw.command === "query_tasks") {
      if (
        !hasExactKeys(raw.output, ["kind", "tasks"]) ||
        raw.output.kind !== "task_query" ||
        !Array.isArray(raw.output.tasks) ||
        raw.output.tasks.length > MAX_SUMMARIES
      )
        return null;
      const tasks: BakerySurfaceTaskDetail[] = [];
      for (const candidate of raw.output.tasks) {
        const task = parseTaskDetail(candidate);
        if (task === null) return null;
        tasks.push(task);
      }
      return {
        kind: "succeeded",
        command: "query_tasks",
        surface: surface.value,
        output: { kind: "task_query", tasks },
      };
    }
    if (raw.command === "prepare_run_save") {
      if (
        !hasExactKeys(raw.output, ["kind", "manifest"]) ||
        raw.output.kind !== "run_save_proposal"
      )
        return null;
      const manifest = parseRunSaveManifest(raw.output.manifest);
      return manifest === null
        ? null
        : {
            kind: "succeeded",
            command: "prepare_run_save",
            surface: surface.value,
            output: { kind: "run_save_proposal", manifest },
          };
    }
    if (raw.command === "prepare_scenario_save") {
      if (
        !hasExactKeys(raw.output, ["kind", "manifest"]) ||
        raw.output.kind !== "scenario_save_proposal"
      )
        return null;
      const manifest = parseScenarioSaveManifest(raw.output.manifest);
      return manifest === null
        ? null
        : {
            kind: "succeeded",
            command: "prepare_scenario_save",
            surface: surface.value,
            output: { kind: "scenario_save_proposal", manifest },
          };
    }
    if (raw.command === "simulate_workcell") {
      const output = parseSimulationOutput(raw.output);
      return output === null
        ? null
        : {
            kind: "succeeded",
            command: "simulate_workcell",
            surface: surface.value,
            output,
          };
    }
    if (!hasExactKeys(raw.output, ["kind"]) || raw.output.kind !== "surface")
      return null;
    return {
      kind: "succeeded",
      command: raw.command,
      surface: surface.value,
      output: { kind: "surface" },
    };
  }
  if (
    raw.kind !== "rejected" ||
    !hasExactKeys(raw, ["kind", "command", "code", "message"]) ||
    !surfaceCommandName(raw.command) ||
    (raw.code !== "stale_surface" &&
      raw.code !== "stale_draft" &&
      raw.code !== "unsupported_command" &&
      raw.code !== "target_not_found" &&
      raw.code !== "invalid_edit" &&
      raw.code !== "proposal_missing" &&
      raw.code !== "simulation_failed") ||
    !label(raw.message)
  )
    return null;
  return {
    kind: "rejected",
    command: raw.command,
    code: raw.code,
    message: raw.message,
  };
}

function parseSurfaceReference(raw: unknown): BakerySurfaceReference | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["surfaceSessionId", "surfaceEpoch"]) ||
    !identifier(raw.surfaceSessionId) ||
    !isNonNegativeInteger(raw.surfaceEpoch)
  )
    return null;
  return {
    surfaceSessionId: raw.surfaceSessionId,
    surfaceEpoch: raw.surfaceEpoch,
  };
}

export function parseRecordingAcceptanceReference(
  raw: unknown,
): BakeryRecordingAcceptanceReference | null {
  if (
    !isRecord(raw) ||
    !identifier(raw.surfaceSessionId) ||
    !isNonNegativeInteger(raw.surfaceEpoch) ||
    typeof raw.recordingDigest !== "string" ||
    !SHA256_PATTERN.test(raw.recordingDigest)
  )
    return null;
  const identity = {
    surfaceSessionId: raw.surfaceSessionId,
    surfaceEpoch: raw.surfaceEpoch,
    recordingDigest: raw.recordingDigest,
  };
  if (raw.kind === "workcell") {
    if (
      !hasExactKeys(raw, [
        "kind",
        "surfaceSessionId",
        "surfaceEpoch",
        "recordingDigest",
        "inputFingerprint",
      ]) ||
      typeof raw.inputFingerprint !== "string" ||
      !SHA256_PATTERN.test(raw.inputFingerprint)
    )
      return null;
    return {
      ...identity,
      kind: "workcell",
      inputFingerprint: raw.inputFingerprint,
    };
  }
  if (raw.kind === "trays") {
    if (
      !hasExactKeys(raw, [
        "kind",
        "surfaceSessionId",
        "surfaceEpoch",
        "recordingDigest",
        "operationId",
        "runFingerprint",
      ]) ||
      !identifier(raw.operationId) ||
      typeof raw.runFingerprint !== "string" ||
      !SHA256_PATTERN.test(raw.runFingerprint)
    )
      return null;
    return {
      ...identity,
      kind: "trays",
      operationId: raw.operationId,
      runFingerprint: raw.runFingerprint,
    };
  }
  if (raw.kind === "production") {
    if (
      !hasExactKeys(raw, [
        "kind",
        "surfaceSessionId",
        "surfaceEpoch",
        "recordingDigest",
        "operationId",
        "planFingerprint",
      ]) ||
      !identifier(raw.operationId) ||
      !identifier(raw.planFingerprint)
    )
      return null;
    return {
      ...identity,
      kind: "production",
      operationId: raw.operationId,
      planFingerprint: raw.planFingerprint,
    };
  }
  return null;
}

function parseDraftReference(raw: unknown): BakerySurfaceDraftReference | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["revision", "digest"]) ||
    !isNonNegativeInteger(raw.revision) ||
    typeof raw.digest !== "string" ||
    !SHA256_PATTERN.test(raw.digest)
  )
    return null;
  return { revision: raw.revision, digest: raw.digest };
}

function parseEditOperations(
  raw: unknown,
): BakerySurfaceEditOperation[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return null;
  const edits: BakerySurfaceEditOperation[] = [];
  const fields = new Set<SettingsField>();
  for (const value of raw) {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["kind", "field", "value"]) ||
      value.kind !== "set_assumption" ||
      !settingsField(value.field) ||
      typeof value.value !== "number" ||
      !Number.isFinite(value.value) ||
      fields.has(value.field)
    )
      return null;
    fields.add(value.field);
    edits.push({
      kind: "set_assumption",
      field: value.field,
      value: value.value,
    });
  }
  return edits;
}

function parseEditProposal(raw: unknown): BakerySurfaceEditProposalV1 | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "proposalDigest",
      "baseDraft",
      "edits",
      "summary",
      "preview",
    ]) ||
    typeof raw.proposalDigest !== "string" ||
    !SHA256_PATTERN.test(raw.proposalDigest) ||
    !Array.isArray(raw.summary) ||
    raw.summary.length === 0 ||
    raw.summary.length > 8
  )
    return null;
  const baseDraft = parseDraftReference(raw.baseDraft);
  const edits = parseEditOperations(raw.edits);
  if (
    baseDraft === null ||
    edits === null ||
    !raw.summary.every(label) ||
    !isRecord(raw.preview) ||
    !hasExactKeys(raw.preview, ["before", "after"])
  )
    return null;
  const before = parseRunPreview(raw.preview.before);
  const after = parseRunPreview(raw.preview.after);
  if (before === null || after === null) return null;
  return {
    proposalDigest: raw.proposalDigest,
    baseDraft,
    edits,
    summary: raw.summary,
    preview: { before, after },
  };
}

function parseRunPreview(raw: unknown): BakerySurfaceRunPreview | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "state",
      "endSeconds",
      "lateBatches",
      "unfinishedBatches",
    ]) ||
    (raw.state !== "complete" &&
      raw.state !== "blocked" &&
      raw.state !== "horizon") ||
    !seconds(raw.endSeconds) ||
    !isNonNegativeInteger(raw.lateBatches) ||
    !isNonNegativeInteger(raw.unfinishedBatches)
  )
    return null;
  return {
    state: raw.state,
    endSeconds: raw.endSeconds,
    lateBatches: raw.lateBatches,
    unfinishedBatches: raw.unfinishedBatches,
  };
}

function parseRunSaveManifest(
  raw: unknown,
): BakerySurfaceRunSaveManifest | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "id", "name", "bytes"]) ||
    raw.kind !== "rehearsal" ||
    typeof raw.id !== "string" ||
    !SHA256_PATTERN.test(raw.id) ||
    typeof raw.name !== "string" ||
    raw.name.trim().length === 0 ||
    raw.name.length > 80 ||
    !isNonNegativeInteger(raw.bytes) ||
    raw.bytes > MAX_RUN_SNAPSHOT_BYTES
  )
    return null;
  return {
    kind: "rehearsal",
    id: raw.id,
    name: raw.name,
    bytes: raw.bytes,
  };
}

export function parseScenarioSaveManifest(
  raw: unknown,
): BakerySurfaceScenarioSaveManifest | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "kind",
      "id",
      "name",
      "sourceFingerprint",
      "digest",
      "bytes",
    ]) ||
    (raw.kind !== "scenario" && raw.kind !== "production-scenario") ||
    !identifier(raw.id) ||
    typeof raw.name !== "string" ||
    raw.name.trim().length === 0 ||
    raw.name.length > 80 ||
    typeof raw.sourceFingerprint !== "string" ||
    !SHA256_PATTERN.test(raw.sourceFingerprint) ||
    typeof raw.digest !== "string" ||
    !SHA256_PATTERN.test(raw.digest) ||
    !isNonNegativeInteger(raw.bytes) ||
    raw.bytes > 64 * 1024
  )
    return null;
  return {
    kind: raw.kind,
    id: raw.id,
    name: raw.name,
    sourceFingerprint: raw.sourceFingerprint,
    digest: raw.digest,
    bytes: raw.bytes,
  };
}

export function surfaceCommandName(
  value: unknown,
): value is BakerySurfaceCommandName {
  return (
    value === "inspect_surface" ||
    value === "read_draft" ||
    value === "query_tasks" ||
    value === "set_view" ||
    value === "control_baseline" ||
    value === "show_production_panel" ||
    value === "control_workspace_view" ||
    value === "control_playback" ||
    value === "prepare_workcell" ||
    value === "prepare_layout" ||
    value === "prepare_production_control" ||
    value === "prepare_edit" ||
    value === "run_shift" ||
    value === "select_item" ||
    value === "rotate_equipment" ||
    value === "set_equipment_angle" ||
    value === "move_equipment" ||
    value === "toggle_opening" ||
    value === "select_floor_plan" ||
    value === "configure_interior" ||
    value === "reset_floor_plan" ||
    value === "compare_shift" ||
    value === "start_production" ||
    value === "prepare_run_save" ||
    value === "file_action" ||
    value === "inspect_scenario_save" ||
    value === "inspect_run_save" ||
    value === "list_saved_runs" ||
    value === "prepare_run_open" ||
    value === "prepare_scenario_save" ||
    value === "stop_simulation" ||
    value === "simulate_workcell" ||
    value === "accept_candidate" ||
    value === "discard_candidate" ||
    value === "edit_rehearsal" ||
    value === "edit_production" ||
    value === "preview_production" ||
    value === "apply_production" ||
    value === "apply_reviewed_edit"
  );
}

function simulationMode(value: unknown): value is BakerySimulationMode {
  return (
    value === "transfer" || value === "oven-cycle" || value === "rack-cycle"
  );
}

function parseTaskFilter(
  raw: unknown,
): Variant<BakerySurfaceCommandV1, "query_tasks">["filter"] | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["text", "limit"]) ||
    typeof raw.text !== "string" ||
    raw.text.trim().length === 0 ||
    raw.text.length > MAX_LABEL_LENGTH ||
    typeof raw.limit !== "number" ||
    !Number.isSafeInteger(raw.limit) ||
    raw.limit < 1 ||
    raw.limit > 8
  )
    return null;
  return { text: raw.text.trim(), limit: raw.limit };
}

function settingsField(value: unknown): value is SettingsField {
  switch (value) {
    case "batchCount":
    case "workerCount":
    case "rackTrays":
    case "ovenTrays":
    case "traysPerBatch":
    case "piecesPerTray":
    case "loadWindow":
    case "loadSeconds":
    case "unloadSeconds":
    case "stage":
    case "portion":
    case "bake":
    case "cool":
    case "demould":
    case "finishCooling":
    case "pack":
    case "horizonMinutes":
    case "outageStart":
    case "outageEnd":
      return true;
    default:
      return false;
  }
}

function parseView(
  raw: unknown,
): Variant<BakerySurfaceCommandV1, "set_view">["view"] | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["selection", "cursorSeconds", "playback"]) ||
    raw.playback !== "paused" ||
    !seconds(raw.cursorSeconds)
  )
    return null;
  const selection = parseSelectionTarget(raw.selection);
  return selection === null
    ? null
    : {
        selection,
        cursorSeconds: raw.cursorSeconds,
        playback: "paused",
      };
}

function parseSelectionTarget(
  raw: unknown,
): BakerySurfaceSelectionTarget | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "id"]) ||
    (raw.kind !== "batch" &&
      raw.kind !== "station" &&
      raw.kind !== "task" &&
      raw.kind !== "resource" &&
      raw.kind !== "operation") ||
    !identifier(raw.id)
  )
    return null;
  return { kind: raw.kind, id: raw.id };
}

function parsePlayback(raw: unknown): BakerySurfacePlayback | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["cursorSeconds", "playback", "speed"]) ||
    !seconds(raw.cursorSeconds) ||
    (raw.playback !== "paused" && raw.playback !== "playing") ||
    typeof raw.speed !== "number" ||
    !Number.isFinite(raw.speed) ||
    raw.speed <= 0 ||
    raw.speed > 1000
  )
    return null;
  return {
    cursorSeconds: raw.cursorSeconds,
    playback: raw.playback,
    speed: raw.speed,
  };
}

function parseSummaries(
  raw: readonly unknown[],
): BakerySurfaceSummary[] | null {
  if (raw.length > MAX_SUMMARIES) return null;
  const summaries: BakerySurfaceSummary[] = [];
  for (const value of raw) {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["id", "label", "state"]) ||
      !identifier(value.id) ||
      !label(value.label) ||
      !label(value.state)
    )
      return null;
    summaries.push({
      id: value.id,
      label: value.label,
      state: value.state,
    });
  }
  return summaries;
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH
  );
}

function label(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LABEL_LENGTH
  );
}

function seconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function invalid(message: string): BakerySurfaceParseResult {
  return { kind: "invalid", message };
}

function invalidCommand(message: string): BakerySurfaceCommandParseResult {
  return { kind: "invalid", message };
}

function invalidEffect(message: string): BakerySurfaceEffectParseResult {
  return { kind: "invalid", message };
}

function invalidReceipt(message: string): BakerySurfaceReceiptParseResult {
  return { kind: "invalid", message };
}

function layoutOffset(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -600 &&
    value <= 600
  );
}

function parseRackLayoutContext(
  value: unknown,
): BakerySurfaceRackLayout | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "modelHash",
      "xMm",
      "yMm",
      "editable",
      "checks",
      "proposal",
    ]) ||
    typeof value.modelHash !== "string" ||
    !SHA256_PATTERN.test(value.modelHash) ||
    !layoutOffset(value.xMm) ||
    !layoutOffset(value.yMm) ||
    typeof value.editable !== "boolean" ||
    !label(value.checks)
  )
    return null;
  let proposal: BakerySurfaceRackLayout["proposal"] = null;
  if (value.proposal !== null) {
    const raw = value.proposal;
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["baseModelHash", "xMm", "yMm", "status"]) ||
      typeof raw.baseModelHash !== "string" ||
      !SHA256_PATTERN.test(raw.baseModelHash) ||
      !layoutOffset(raw.xMm) ||
      !layoutOffset(raw.yMm) ||
      (raw.status !== "blocked" && raw.status !== "unchecked")
    )
      return null;
    proposal = {
      baseModelHash: raw.baseModelHash,
      xMm: raw.xMm,
      yMm: raw.yMm,
      status: raw.status,
    };
  }
  return {
    modelHash: value.modelHash,
    xMm: value.xMm,
    yMm: value.yMm,
    editable: value.editable,
    checks: value.checks,
    proposal,
  };
}

function parseRunSaveInspection(raw: unknown): BakeryRunSaveInspection | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "idle")
    return hasExactKeys(raw, ["kind"]) ? { kind: "idle" } : null;
  const ref = raw.reference;
  if (
    !isRecord(ref) ||
    !hasExactKeys(ref, ["id", "name", "requestId", "origin"]) ||
    !isRunSnapshotId(ref.id) ||
    typeof ref.name !== "string" ||
    ref.name.length === 0 ||
    ref.name.length > 80 ||
    !identifier(ref.requestId) ||
    (ref.origin !== "operator" && ref.origin !== "agent")
  )
    return null;
  const reference: BakeryRunSaveReference = {
    id: ref.id,
    name: ref.name,
    requestId: ref.requestId,
    origin: ref.origin,
  };
  switch (raw.kind) {
    case "saving":
    case "verified":
    case "readback-confirmed":
      return hasExactKeys(raw, ["kind", "reference"])
        ? { kind: raw.kind, reference }
        : null;
    case "outcome-unknown":
    case "saved-readback-failed":
    case "not-found":
      return hasExactKeys(raw, ["kind", "reference", "readback"]) &&
        (raw.readback === "verified" ||
          raw.readback === "missing" ||
          raw.readback === "unavailable")
        ? { kind: raw.kind, reference, readback: raw.readback }
        : null;
    default:
      return null;
  }
}

function parseScenarioSaveInspection(
  raw: unknown,
): BakeryScenarioSaveInspection | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "idle")
    return hasExactKeys(raw, ["kind"]) ? { kind: "idle" } : null;
  const manifest = parseScenarioSaveManifest(raw.manifest);
  if (manifest === null) return null;
  switch (raw.kind) {
    case "prepared":
    case "saving":
    case "failed-before-save":
    case "verified":
      return hasExactKeys(raw, ["kind", "manifest"])
        ? { kind: raw.kind, manifest }
        : null;
    case "outcome-unknown":
    case "saved-readback-failed":
      return hasExactKeys(raw, ["kind", "manifest", "readback"]) &&
        (raw.readback === "verified" || raw.readback === "unavailable")
        ? { kind: raw.kind, manifest, readback: raw.readback }
        : null;
    default:
      return null;
  }
}

export function parseBakeryFileAction(raw: unknown): BakeryFileAction | null {
  if (!isRecord(raw)) return null;
  if (
    raw.kind === "import" &&
    hasExactKeys(raw, ["kind", "digest"]) &&
    typeof raw.digest === "string" &&
    SHA256_PATTERN.test(raw.digest)
  )
    return { kind: "import", digest: raw.digest };
  if (
    raw.kind === "export" &&
    hasExactKeys(raw, ["kind", "format"]) &&
    (raw.format === "run" ||
      raw.format === "request" ||
      raw.format === "recording" ||
      raw.format === "handoff")
  )
    return { kind: "export", format: raw.format };
  return null;
}
function parseBakeryFileManifest(raw: unknown): BakeryFileManifest | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["name", "digest", "bytes"]) ||
    !identifier(raw.name) ||
    typeof raw.digest !== "string" ||
    !SHA256_PATTERN.test(raw.digest) ||
    !isNonNegativeInteger(raw.bytes) ||
    raw.bytes > MAX_RUN_SNAPSHOT_BYTES
  )
    return null;
  return { name: raw.name, digest: raw.digest, bytes: raw.bytes };
}

function parseBakeryEffectCommand(
  raw: unknown,
):
  | Readonly<{ kind: "valid"; value: BakerySurfaceEffectV1["command"] }>
  | Readonly<{ kind: "invalid"; message: string }> {
  if (isRecord(raw) && raw.kind === "page_command") {
    const command = parseSurfacePageCommand(raw);
    return command === null
      ? { kind: "invalid", message: "Invalid Portal page command." }
      : { kind: "valid", value: command };
  }
  if (!isRecord(raw) || raw.kind !== "prepare_context")
    return parseBakerySurfaceCommand(raw);
  const binding = parseBakeryBrowserBinding(raw.binding);
  if (
    !hasExactKeys(raw, [
      "kind",
      "schemaVersion",
      "binding",
      "requiredCommand",
    ]) ||
    raw.schemaVersion !== 1 ||
    binding === null ||
    !surfaceCommandName(raw.requiredCommand) ||
    raw.requiredCommand === "apply_reviewed_edit"
  ) {
    return {
      kind: "invalid",
      message: "Invalid Kitchen preparation binding.",
    };
  }
  return {
    kind: "valid",
    value: {
      kind: "prepare_context",
      schemaVersion: 1,
      binding,
      requiredCommand: raw.requiredCommand,
    },
  };
}

export function isExecutableBakerySurfaceEffect(
  effect: BakerySurfaceEffectV1,
): effect is ExecutableBakerySurfaceEffectV1 {
  return (
    effect.command.kind !== "prepare_context" &&
    effect.command.kind !== "page_command"
  );
}

/** An effect that a Portal page other than the Kitchen runs. */
export type PageCommandEffectV1 = BakerySurfaceEffectV1 &
  Readonly<{ command: SurfacePageCommandV1 }>;

export function isPageCommandEffect(
  effect: BakerySurfaceEffectV1,
): effect is PageCommandEffectV1 {
  return effect.command.kind === "page_command";
}

export function bakeryEffectDeliveryTarget(
  effect: BakerySurfaceEffectV1,
): Readonly<{ surfaceSessionId: string; surfaceEpoch: number }> {
  // A page command goes to the browser of the request, as a preparation does.
  if (effect.command.kind === "page_command")
    return {
      surfaceSessionId: `browser:${effect.command.binding.browserInstanceId}`,
      surfaceEpoch: 0,
    };
  return effect.command.kind === "prepare_context"
    ? {
        surfaceSessionId: `browser:${effect.command.binding.browserInstanceId}`,
        surfaceEpoch: 0,
      }
    : effect.command.target;
}
