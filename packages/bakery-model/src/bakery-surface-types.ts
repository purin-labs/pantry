import type { BakeryProductionSnapshotSurface } from "./bakery-persistent-surface.ts";
import type {
  BakeryPersistentSurface,
  BakeryProductionControl,
  BakeryProductionTarget,
} from "./bakery-persistent-surface.ts";
import type {
  BakeryFloorPlanResetAction,
  BakeryStoreInteriorAction,
  BakerySurfaceShiftLayout,
} from "./bakery-floor-plan.ts";
import type {
  BakeryWorkspaceViewAction,
  BakeryCameraView,
  BakeryDoorInspection,
  BakeryRecordingCameraView,
  BakeryShiftView,
} from "./bakery-surface-view.ts";
import type { IngredientLoad } from "./bakery-physics.ts";
import type {
  BakeryBrowserBinding,
  BakeryContextPreparationCommand,
} from "./bakery-context.ts";
import type { SettingsField } from "./bakery";
import type { BakeryWorkcellPreparation } from "./bakery-workcell-preparation.ts";
import type { BakeryPlaybackAction } from "./bakery-playback.ts";
import type { RunSnapshotPage } from "./bakery-run-snapshot.ts";
import type { AgentScenarioSaveManifest } from "./bakery-agent-scenario-save.ts";
import type { BakerySimulationOutput } from "./bakery-simulation-output.ts";
import type { StrictUnion, Variant, VariantBy } from "@purin-labs/type-utils";
import type {
  SurfaceObservationV2,
  SurfacePageCommandV1,
} from "@purin-labs/control-api";

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

export type BakeryRunSaveReference = Readonly<{
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

/** An effect that a Portal page other than the Kitchen runs. */
export type PageCommandEffectV1 = BakerySurfaceEffectV1 &
  Readonly<{ command: SurfacePageCommandV1 }>;
