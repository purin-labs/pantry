import type { JobProgress } from "../production-run/job-progress";
import type {
  BakeryWorkspaceViewAction,
  BakeryRecordingCameraView,
  BakeryShiftDock,
} from "@purin-labs/bakery-model/bakery-surface";
import type { ProductionNavigation } from "./production-navigation.ts";
import {
  workspaceRunReviewCurrent,
  workspaceRunReviewPatch,
  type WorkspaceRunReview,
} from "./workspace-run-review.ts";
import {
  productionReplacementCurrent,
  acceptedProductionResults,
  newDraftIdentity,
  type PreparedProductionReplacement,
} from "./production-draft.ts";
import type { PreparedRehearsalReview } from "./rehearsal-edits.ts";
import { summarizeRun, type RunSummary } from "@purin-labs/production-simulation/simulator/run-comparison";
export type SceneLabelMode = "auto" | "all" | "off";
import { sessionPlaybackSnapshot } from "@purin-labs/production-simulation/simulator/playback-state";
import type { PlaybackSnapshot } from "@purin-labs/production-simulation/simulator/playback-state";
import {
  sampleSettings,
  type Settings,
  type SettingsField,
  type SettingsResult,
} from "@purin-labs/bakery-model/bakery";

import { runProcedure, type ProcedureRun } from "@purin-labs/production-simulation/simulator/procedure";
import {
  simulate,
  simulateProduction,
  type Run,
  type ScheduleSpatialLayout,
  type ScheduleVariant,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import {
  selectionExists,
  selectionForRun,
  type Selection,
} from "@purin-labs/production-simulation/simulator/selection";
import type { CommerceMutationTransport } from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";
import type {
  RunSnapshotKind,
  RunSnapshotSummary,
} from "@purin-labs/bakery-model/bakery-run-snapshot";
import type {
  PreparedWorkspaceRun,
  WorkspaceRunSave,
} from "./workspace-runs-api.ts";
import type { PhysicsReplay } from "@purin-labs/bakery-model/bakery-physics";
import { rehearsalSessionPatch } from "./scheduled-rehearsal.ts";
import type { PreparedRehearsalEdit } from "./rehearsal-edits.ts";
import {
  appliedRunPatch,
  editProductionDraft,
  previewPatch,
  type PreparedProductionPreview,
  type ProductionDraftEdit,
} from "./production-draft.ts";
import {
  initialProductionSession,
  type FinancierPreset,
  type ProductionPending,
  type ProductionReady,
  type ProductionSession,
} from "./production-session.ts";
import type {
  ProductionProcedure,
  ProductionWorkcell,
  ProductionWorkcells,
} from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import type { BakerySurfaceEditProposalV1 } from "@purin-labs/bakery-model/bakery-surface";
import type {
  AgentScenarioSaveManifest,
  AgentScenarioSavePayload,
} from "@purin-labs/bakery-model/bakery-agent-scenario-save";
import {
  changePlaybackSpeed,
  closePhysicsReplay,
  initialPlaybackSession,
  loadPhysicsReplay,
  navigateRecording,
  previewRecordingDoor,
  type RecordingNavigation,
  openPhysicsReplay,
  recordingReplayView,
  resetWorkflowPlayback,
  seekActivePlayback,
  updateActivePlayback,
  workflowReplay,
  type PlaybackSession,
  type RecordingReplayView,
  type ReplayState,
} from "@purin-labs/production-simulation/simulator/playback-state";
import type { Variant, StrictUnion } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

type BakeryWorkspaceIdentity = Readonly<{
  surfaceSessionId: string;
  surfaceEpoch: number;
  production: ProductionSession;
  // The other procedure's session, kept while the operator switches examples.
  parkedProduction: ProductionSession | null;
  runSaves: Readonly<Record<RunSnapshotKind, WorkspaceRunSaveStatus>>;
  runSaveProposal:
    | Readonly<{ kind: "none"; prepared?: never }>
    | (Readonly<{ kind: "prepared" }> & AgentRunSaveProposal);
  scenarioSaveProposal:
    | Readonly<{
        kind: "none";
        payload?: never;
        manifest?: never;
        effectId?: never;
      }>
    | Readonly<{
        kind: "prepared";
        payload: AgentScenarioSavePayload;
        manifest: AgentScenarioSaveManifest;
        effectId: string;
        message?: never;
      }>
    | Readonly<{
        kind:
          | "saving"
          | "outcome-unknown"
          | "saved-readback-failed"
          | "failed-before-save"
          | "verified";
        payload: AgentScenarioSavePayload;
        manifest: AgentScenarioSaveManifest;
        effectId: string;
        message: string;
      }>;
}>;

export type AgentRunSaveProposal = Readonly<{
  prepared: PreparedWorkspaceRun;
  effectId: string;
}>;

export type WorkspaceRunSaveStatus =
  | Readonly<{
      kind: "idle";
      organisationId?: never;
      requestId?: never;
      id?: never;
      snapshot?: never;
    }>
  | Readonly<{
      kind: "saving";
      organisationId: string;
      requestId: string;
      id: string;
      name: string;
      agentEffectId: string | null;
      snapshot?: never;
      message?: never;
    }>
  | Readonly<{
      kind: "verified";
      organisationId: string;
      requestId: string;
      snapshot: RunSnapshotSummary;
      agentEffectId: string | null;
      id?: never;
      name?: never;
      message?: never;
    }>
  | Readonly<{
      kind: "saved-readback-failed";
      organisationId: string;
      requestId: string;
      snapshot: RunSnapshotSummary;
      message: string;
      agentEffectId: string | null;
      id?: never;
      name?: never;
    }>
  | Readonly<{
      kind: "outcome-unknown";
      organisationId: string;
      requestId: string;
      id: string;
      name: string;
      message: string;
      agentEffectId: string | null;
      snapshot?: never;
    }>
  | Readonly<{
      kind: "readback-confirmed";
      organisationId: string;
      requestId: string;
      id: string;
      name: string;
      agentEffectId: string | null;
      snapshot?: never;
      message?: never;
    }>
  | Readonly<{
      kind: "not-found";
      organisationId: string;
      requestId: string;
      id: string;
      name: string;
      agentEffectId: string | null;
      snapshot?: never;
      message?: never;
    }>;

export type BakeryWorkspaceState = BakeryWorkspaceIdentity &
  (
    | Readonly<{ kind: "shift" }>
    | Readonly<{ kind: "rehearsal" }>
    | Readonly<{ kind: "production" }>
  );

export type BakeryWorkspaceAction =
  | Readonly<{ kind: "workspaceRunOpenPrepared"; review: WorkspaceRunReview }>
  | Readonly<{
      kind: "workspaceRunOpenResolved";
      review: WorkspaceRunReview;
      decision: "apply" | "discard";
    }>
  | Readonly<{ kind: "activeRunChanged" }>
  | Readonly<{ kind: "openRehearsal" }>
  | Readonly<{ kind: "closeRehearsal" }>
  | Readonly<{
      kind: "openProduction";
      procedure?: ProductionProcedure;
      financierPreset?: FinancierPreset;
    }>
  | Readonly<{ kind: "closeProduction" }>
  // Opens a prepared rehearsal run; an open financier run is kept parked.
  | Readonly<{
      kind: "openRehearsalRun";
      plan: ProductionWorkcells;
      notice: string;
    }>
  | Readonly<{
      kind: "productionSessionChanged";
      patch: Partial<ProductionSession>;
    }>
  // A prepared tray edit, applied only to the plan it was prepared from.
  | Readonly<{
      kind: "productionBaselineChanged";
      action: "pin" | "clear";
      source: Run;
      baseline: RunSummary | null;
    }>
  | Readonly<{
      kind: "rehearsalReviewPrepared";
      review: PreparedRehearsalReview;
    }>
  | Readonly<{
      kind: "rehearsalReviewResolved";
      review: PreparedRehearsalReview;
      decision: "apply" | "discard";
    }>
  | Readonly<{
      kind: "productionCandidateDiscarded";
      candidate: Variant<ProductionPending, "recording">;
    }>
  | Readonly<{ kind: "productionNavigated"; navigation: ProductionNavigation }>
  | Readonly<{
      kind: "productionPanelShown";
      from: ProductionReady;
      panel: ProductionSession["panel"];
    }>
  | Readonly<{ kind: "rehearsalEdited"; edit: PreparedRehearsalEdit }>
  // Financier production authoring: a draft edit, a compiled preview of the
  // draft it was prepared from, and applying that preview as a fresh run.
  | Readonly<{ kind: "productionDraftEdited"; edit: ProductionDraftEdit }>
  | Readonly<{
      kind: "productionPreviewed";
      preview: PreparedProductionPreview;
    }>
  | Readonly<{
      kind: "productionReplacementPrepared";
      review: PreparedProductionReplacement;
    }>
  | Readonly<{
      kind: "productionReplacementResolved";
      review: PreparedProductionReplacement;
      decision: "apply" | "discard";
    }>
  | Readonly<{ kind: "productionPreviewApplied"; preview: ProductionReady }>
  | Readonly<{
      kind: "acceptRecording";
      target: PreparedRecordingAcceptance;
    }>
  | Readonly<{
      kind: "productionBrowserCommitted";
      previous: ProductionWorkcells;
      next: ProductionWorkcells;
      operationId: string;
    }>
  | Readonly<{
      kind: "workspaceRunSaveStarted";
      runKind: RunSnapshotKind;
      organisationId: string;
      requestId: string;
      id: string;
      name: string;
      agentEffectId: string | null;
    }>
  | Readonly<{
      kind: "workspaceRunSaveProposed";
      prepared: PreparedWorkspaceRun;
      effectId: string;
    }>
  | Readonly<{
      kind: "scenarioSaveProposed";
      payload: AgentScenarioSavePayload;
      manifest: AgentScenarioSaveManifest;
      effectId: string;
    }>
  | Readonly<{
      kind: "scenarioSaveProposalCleared";
      effectId: string;
    }>
  | Readonly<{
      kind: "scenarioSaveStarted";
      effectId: string;
    }>
  | Readonly<{
      kind: "scenarioSaveSettled";
      effectId: string;
      outcome: Readonly<{
        kind:
          | "outcome-unknown"
          | "saved-readback-failed"
          | "failed-before-save"
          | "verified";
        message: string;
      }>;
    }>
  | Readonly<{
      kind: "workspaceRunSaveProposalCleared";
      id: string;
      effectId: string;
    }>
  | Readonly<{
      kind: "workspaceRunSaveAbandoned";
      organisationId: string;
      requestId: string;
      id: string;
      effectId: string;
    }>
  | Readonly<{
      kind: "workspaceRunSaveSettled";
      runKind: RunSnapshotKind;
      organisationId: string;
      requestId: string;
      outcome: WorkspaceRunSave;
    }>
  | Readonly<{
      kind: "workspaceRunSaveRecovered";
      runKind: RunSnapshotKind;
      organisationId: string;
      requestId: string;
      id: string;
      name: string;
    }>
  | Readonly<{
      kind: "workspaceRunSaveMissing";
      runKind: RunSnapshotKind;
      organisationId: string;
      requestId: string;
      id: string;
      name: string;
    }>;

export type RecordingAcceptanceTarget = Readonly<{
  kind: "production";
  candidate: Variant<ProductionPending, "recording">;
}>;

export type PreparedRecordingAcceptance = RecordingAcceptanceTarget &
  Readonly<{
    accepted: Readonly<{
      from: ProductionWorkcells;
      plan: ProductionWorkcells;
    }>;
  }>;

export type SimulatorConnection =
  | Readonly<{
      kind: "workspace";
      organisationId: string;
      canManage: boolean;
      mutate: CommerceMutationTransport;
      /** The chat page, where Ask the agent starts. */
      chatPath?: string;
    }>
  | Readonly<{
      kind: "preview";
      organisationId?: never;
      canManage?: never;
      mutate?: never;
    }>;

export type SimulatorShift =
  | Readonly<{ kind: "sample"; normal: Run; outage: Run }>
  | Readonly<{
      kind: "procedure";
      normal: ProcedureRun;
      outage: ProcedureRun;
    }>;

export type SimulatorDock = BakeryShiftDock;

type RunSourceState = Readonly<{
  baseline: Run;
  shift: SimulatorShift;
  variant: ScheduleVariant;
  /** The floor layout of every run of this state; null is the built-in one. */
  layout: ScheduleSpatialLayout | null;
}>;

export type SceneLoadState = Readonly<{
  status: "loading" | "ready" | "unavailable";
}>;

export type ProcedureLoadState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>;

type ScenarioDraftState = Readonly<{
  assumptionDraft: ReadonlyMap<SettingsField, string>;
  draftRevision: number;
  surfaceEditProposal: BakerySurfaceEditProposalV1 | null;
  surfaceEditUndo: ReadonlyMap<SettingsField, string> | null;
  error: Variant<SettingsResult, "invalid"> | null;
  notice: string;
  copyId: string;
  copyName: string;
  copyNote: string;
}>;

export type SimulatorViewState = Readonly<{
  dock: SimulatorDock;
  selection: Selection;
  camera: BakeryRecordingCameraView["camera"];
  /** The 3D camera has left its home view, so Recenter has work to do. */
  cameraMoved: boolean;
  cameraResetRevision: number;
  labels: SceneLabelMode;
  /** The corner floor-plan overview, shown while no panel covers it. */
  minimap: boolean;
  /** The scene reports whether its layout has room for the overview. */
  overviewFits: boolean;
  /** Hidden chrome leaves only the playback bar over the 3D view. */
  chrome: "shown" | "hidden";
}>;

/** View choices a person keeps between visits. */
type SimulatorViewPreferences = Pick<
  SimulatorViewState,
  "labels" | "minimap"
>;

export const defaultViewPreferences: SimulatorViewPreferences = {
  labels: "auto",
  minimap: false,
};

export type SimulatorState = Readonly<{
  workspace: BakeryWorkspaceState;
  run: RunSourceState;
  replay: PlaybackSession;
  scene: SceneLoadState;
  procedureLoad: ProcedureLoadState;
  scenario: ScenarioDraftState;
  view: SimulatorViewState;
  // Browser MuJoCo runs of the open production or rehearsal run.
  workcellNotice: string;
  browserJob: StrictUnion<
    | Readonly<{ kind: "idle" }>
    | Readonly<{
        kind: "loading" | "running";
        generation: number;
        operationId: string;
        /** The step of the running operation, and its expected length. */
        steps?: Readonly<{ step: number; planned: number }>;
      }>
    | Readonly<{ kind: "failed"; message: string }>
  >;
}>;

/** The browser job of a production run as one engine job reports it. */
export function jobState(
  generation: number,
  operationId: string,
  progress: JobProgress,
): SimulatorState["browserJob"] {
  return progress.stage === "loading"
    ? { kind: "loading", generation, operationId }
    : {
        kind: "running",
        generation,
        operationId,
        steps: { step: progress.step, planned: progress.planned },
      };
}

export type WorkflowInputView = Pick<RunSourceState, "shift" | "variant"> &
  Pick<ReplayState, "time"> &
  Pick<SimulatorViewState, "selection"> &
  Readonly<{
    procedureLoad: ProcedureLoadState;
    assumptionDraft: ScenarioDraftState["assumptionDraft"];
    error: ScenarioDraftState["error"];
  }>;

export type ScenarioView = Pick<RunSourceState, "shift" | "layout"> &
  Pick<ScenarioDraftState, "notice" | "copyName" | "copyNote"> &
  Readonly<{ procedureLoad: ProcedureLoadState }>;

export type InspectorView = Pick<RunSourceState, "shift" | "variant"> &
  Pick<ReplayState, "time"> &
  Pick<SimulatorViewState, "selection">;

export type ComparisonView = Pick<RunSourceState, "baseline"> &
  Pick<ScenarioDraftState, "assumptionDraft">;

export type PlaybackView = Pick<ReplayState, "time" | "playback" | "speed"> &
  Pick<SimulatorViewState, "selection"> &
  Pick<ScenarioDraftState, "notice"> &
  Readonly<{ scene: SceneLoadState["status"] }>;

export type WorkspaceCameraView = Pick<
  SimulatorViewState,
  "camera" | "cameraResetRevision"
>;

export type SceneControlsView = Pick<
  SimulatorViewState,
  "cameraMoved" | "labels" | "minimap" | "chrome"
> &
  Readonly<{
    top: boolean;
    scene: SceneLoadState["status"];
    /** The overview fits and no panel covers its corner. */
    overviewAvailable: boolean;
  }>;

export type SimulatorShellView = Readonly<{
  workspace: BakeryWorkspaceState;
  dock: SimulatorDock;
  run: Run;
  sourceKind: SimulatorShift["kind"];
  hasAssumptionDraft: boolean;
  surfaceEditProposal: BakerySurfaceEditProposalV1 | null;
  canUndoSurfaceEdit: boolean;
  workflowInput: WorkflowInputView;
  scenario: ScenarioView;
  inspector: InspectorView;
  comparison: ComparisonView;
  playback: PlaybackView;
  sceneView: SceneControlsView;
  recording: RecordingReplayView;
  workcellNotice: string;
  browserJob: SimulatorState["browserJob"];
}>;

type SimulatorReplayAction =
  | Readonly<{ kind: "openRecording" }>
  | Readonly<{ kind: "closeRecording" }>
  | Readonly<{ kind: "recordingLoaded"; recording: PhysicsReplay }>
  | Readonly<{ kind: "recordingNavigated"; navigation: RecordingNavigation }>
  | Readonly<{
      kind: "frameUpdated";
      time: number;
      playback: "paused" | "playing";
    }>
  | Readonly<{ kind: "goTo"; time: number }>
  | Readonly<{ kind: "chooseVariant"; variant: ScheduleVariant }>
  | Readonly<{ kind: "chooseSpeed"; speed: number }>
  | Readonly<{ kind: "compareOutage" }>
  | Readonly<{ kind: "pinBaseline" }>;

export type SimulatorViewAction =
  | BakeryWorkspaceViewAction
  | Readonly<{ kind: "select"; selection: Selection }>
  | Readonly<{ kind: "selectTimeline"; selection: Selection }>
  | Readonly<{
      kind: "navigate";
      selection: Selection;
      time: number;
      focus: "inspector" | "unchanged";
    }>
  | Readonly<{ kind: "cameraMoved"; moved: boolean }>
  | Readonly<{ kind: "overviewFits"; fits: boolean }>;

export type SimulatorExperimentAction =
  | Readonly<{
      kind: "workspaceProcedureLoaded";
      shift: Variant<SimulatorShift, "procedure">;
      copyId: string;
      notice: string;
    }>
  | Readonly<{
      kind: "localSampleSelected";
      shift: Variant<SimulatorShift, "sample">;
      copyId: string;
      notice: string;
    }>
  | Readonly<{
      kind: "demoSelected";
      shift: Variant<SimulatorShift, "sample">;
      variant: ScheduleVariant;
      notice: string;
    }>
  | Readonly<{
      kind: "experimentApplied";
      shift: SimulatorShift;
      copyId: string;
      notice: string;
    }>
  | Readonly<{
      kind: "spatialLayoutRecalculated";
      shift: SimulatorShift;
      layout: ScheduleSpatialLayout | null;
      notice: string;
    }>
  | Readonly<{
      // The layout moved without a change of walk times; runs stay.
      kind: "spatialLayoutChanged";
      layout: ScheduleSpatialLayout | null;
    }>
  | Readonly<{
      kind: "assumptionDraftChanged";
      draft: ReadonlyMap<SettingsField, string>;
    }>
  | Readonly<{ kind: "assumptionDraftDiscarded" }>
  | Readonly<{
      kind: "surfaceEditPrepared";
      proposal: BakerySurfaceEditProposalV1;
    }>
  | Readonly<{ kind: "surfaceEditDiscarded" }>
  | Readonly<{
      kind: "surfaceEditApplied";
      proposal: BakerySurfaceEditProposalV1;
    }>
  | Readonly<{ kind: "surfaceEditUndone" }>
  | Readonly<{
      kind: "assumptionsInvalid";
      error: Variant<SettingsResult, "invalid">;
    }>;

type SimulatorWorkspaceAction =
  | Readonly<{ kind: "operationStarted" }>
  | Readonly<{ kind: "operationFailed"; message: string }>
  | Readonly<{
      kind: "copyNameChanged";
      name: string;
      copyId: string;
    }>
  | Readonly<{
      kind: "copyNoteChanged";
      note: string;
      copyId: string;
    }>
  | Readonly<{ kind: "noticeChanged"; notice: string }>;

export function initialSimulatorState(
  dock: SimulatorDock,
  preferences: SimulatorViewPreferences = defaultViewPreferences,
  layout: ScheduleSpatialLayout | null = null,
): SimulatorState {
  const settings = sampleSettings();
  const normal = simulate(settings, "normal", layout);
  return {
    workspace: {
      kind: "shift",
      surfaceSessionId: crypto.randomUUID(),
      surfaceEpoch: 0,
      production: initialProductionSession(),
      parkedProduction: null,
      runSaves: {
        rehearsal: { kind: "idle" },
        production: { kind: "idle" },
        appliance: { kind: "idle" },
        linea: { kind: "idle" },
        eagle: { kind: "idle" },
        "persistent-production": { kind: "idle" },
      },
      runSaveProposal: { kind: "none" },
      scenarioSaveProposal: { kind: "none" },
    },
    run: {
      baseline: normal,
      shift: {
        kind: "sample",
        normal,
        outage: simulate(settings, "outage", layout),
      },
      variant: "normal",
      layout,
    },
    replay: initialPlaybackSession(),
    workcellNotice: "",
    browserJob: { kind: "idle" },
    scene: { status: "loading" },
    procedureLoad: { kind: "idle" },
    scenario: {
      assumptionDraft: new Map(),
      draftRevision: 0,
      surfaceEditProposal: null,
      surfaceEditUndo: null,
      error: null,
      notice: "Shift ready",
      copyId: `scenario-${crypto.randomUUID()}`,
      copyName: "",
      copyNote: "",
    },
    view: {
      dock,
      selection: { kind: "batch", id: "A" },
      camera: "perspective",
      cameraMoved: false,
      cameraResetRevision: 0,
      labels: preferences.labels,
      minimap: preferences.minimap,
      overviewFits: false,
      chrome: "shown",
    },
  };
}

export function normalRun(state: SimulatorState): Run {
  return state.run.shift.kind === "sample"
    ? state.run.shift.normal
    : state.run.shift.normal.schedule;
}

function outageRun(state: SimulatorState): Run {
  return state.run.shift.kind === "sample"
    ? state.run.shift.outage
    : state.run.shift.outage.schedule;
}

export function activeRun(state: SimulatorState): Run {
  return state.run.variant === "normal" ? normalRun(state) : outageRun(state);
}

export function procedureShift(
  procedure: Parameters<typeof runProcedure>[0],
  layout: ScheduleSpatialLayout | null,
): Variant<SimulatorShift, "procedure"> {
  return {
    kind: "procedure",
    normal: runProcedure(procedure, "normal", layout),
    outage: runProcedure(procedure, "outage", layout),
  };
}

/** The compiled procedure of the shift; null for the local sample. */
export function shiftProcedure(
  state: SimulatorState,
): ProcedureRun["source"] | null {
  return state.run.shift.kind === "procedure"
    ? state.run.shift.normal.source
    : null;
}

export function sampleShift(
  settings: Settings,
  layout: ScheduleSpatialLayout | null,
): Variant<SimulatorShift, "sample"> {
  return {
    kind: "sample",
    normal: simulate(settings, "normal", layout),
    outage: simulate(settings, "outage", layout),
  };
}

/** Run a shift again on `layout`, with new settings when they are given. */
export function rerunShift(
  shift: SimulatorShift,
  layout: ScheduleSpatialLayout | null,
  settings?: Settings,
): SimulatorShift {
  if (shift.kind === "sample")
    return sampleShift(settings ?? shift.normal.settings, layout);
  const source = shift.normal.source;
  return procedureShift(
    settings === undefined ? source : { ...source, settings },
    layout,
  );
}

export function simulatorShellView(state: SimulatorState): SimulatorShellView {
  const replay = workflowReplay(state.replay);
  return {
    workspace: state.workspace,
    dock: state.view.dock,
    run: activeRun(state),
    sourceKind: state.run.shift.kind,
    hasAssumptionDraft: state.scenario.assumptionDraft.size > 0,
    surfaceEditProposal: state.scenario.surfaceEditProposal,
    canUndoSurfaceEdit: state.scenario.surfaceEditUndo !== null,
    workflowInput: {
      shift: state.run.shift,
      procedureLoad: state.procedureLoad,
      assumptionDraft: state.scenario.assumptionDraft,
      error: state.scenario.error,
      selection: state.view.selection,
      time: replay.time,
      variant: state.run.variant,
    },
    scenario: {
      shift: state.run.shift,
      layout: state.run.layout,
      procedureLoad: state.procedureLoad,
      notice: state.scenario.notice,
      copyName: state.scenario.copyName,
      copyNote: state.scenario.copyNote,
    },
    inspector: {
      selection: state.view.selection,
      time: replay.time,
      shift: state.run.shift,
      variant: state.run.variant,
    },
    comparison: {
      baseline: state.run.baseline,
      assumptionDraft: state.scenario.assumptionDraft,
    },
    playback: {
      time: replay.time,
      playback: replay.playback,
      speed: replay.speed,
      scene: state.scene.status,
      notice: state.scenario.notice,
      selection: state.view.selection,
    },
    sceneView: {
      top: state.view.camera === "overhead",
      cameraMoved: state.view.cameraMoved,
      labels: state.view.labels,
      minimap: state.view.minimap,
      chrome: state.view.chrome,
      scene: state.scene.status,
      overviewAvailable: overviewAvailable(state.view),
    },
    recording: recordingReplayView(state.replay),
    workcellNotice: state.workcellNotice,
    browserJob: state.browserJob,
  };
}

export function applyBakeryWorkspaceAction(
  action: BakeryWorkspaceAction,
  state: SimulatorState,
): SimulatorState {
  switch (action.kind) {
    case "activeRunChanged":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          surfaceEpoch: state.workspace.surfaceEpoch + 1,
        },
      };
    case "openRehearsal":
      return {
        ...state,
        workspace: {
          kind: "rehearsal",
          surfaceSessionId: state.workspace.surfaceSessionId,
          surfaceEpoch: state.workspace.surfaceEpoch + 1,
          production: state.workspace.production,
          parkedProduction: state.workspace.parkedProduction,
          runSaves: state.workspace.runSaves,
          runSaveProposal: state.workspace.runSaveProposal,
          scenarioSaveProposal: state.workspace.scenarioSaveProposal,
        },
      };
    case "closeRehearsal":
      return {
        ...state,
        view: {
          ...state.view,
          camera: state.view.camera === "overhead" ? "overhead" : "perspective",
        },
        workspace: {
          kind: "shift",
          surfaceSessionId: state.workspace.surfaceSessionId,
          surfaceEpoch: state.workspace.surfaceEpoch + 1,
          production: state.workspace.production,
          parkedProduction: state.workspace.parkedProduction,
          runSaves: state.workspace.runSaves,
          runSaveProposal: state.workspace.runSaveProposal,
          scenarioSaveProposal: state.workspace.scenarioSaveProposal,
        },
      };
    case "openProduction": {
      if (state.workspace.kind !== "rehearsal") return state;
      const procedure = action.procedure ?? "financier";
      const current = presetSession(
        state.workspace.production,
        action.financierPreset,
      );
      const parked =
        state.workspace.parkedProduction === null
          ? null
          : presetSession(
              state.workspace.parkedProduction,
              action.financierPreset,
            );
      const switched = current.procedure !== procedure;
      return {
        ...state,
        view: {
          ...state.view,
          camera: state.view.camera === "overhead" ? "overhead" : "perspective",
        },
        workspace: {
          kind: "production",
          surfaceSessionId: state.workspace.surfaceSessionId,
          surfaceEpoch: state.workspace.surfaceEpoch + 1,
          production: !switched
            ? current
            : parked?.procedure === procedure
              ? parked
              : initialProductionSession(procedure, action.financierPreset),
          parkedProduction: switched ? current : parked,
          runSaves: state.workspace.runSaves,
          runSaveProposal: state.workspace.runSaveProposal,
          scenarioSaveProposal: state.workspace.scenarioSaveProposal,
        },
      };
    }
    case "closeProduction":
      if (state.workspace.kind !== "production") return state;
      return {
        ...state,
        workspace: {
          kind: "rehearsal",
          surfaceSessionId: state.workspace.surfaceSessionId,
          surfaceEpoch: state.workspace.surfaceEpoch + 1,
          production: {
            ...state.workspace.production,
            savingDefinition: false,
            openingDefinition: false,
            reading: false,
            identity:
              state.workspace.production.savingDefinition &&
              state.workspace.production.identity.kind === "new"
                ? {
                    kind: "uncertain",
                    id: state.workspace.production.identity.id,
                  }
                : state.workspace.production.identity,
            cursor: {
              ...state.workspace.production.cursor,
              playback: "paused",
            },
          },
          parkedProduction: state.workspace.parkedProduction,
          runSaves: state.workspace.runSaves,
          runSaveProposal: state.workspace.runSaveProposal,
          scenarioSaveProposal: state.workspace.scenarioSaveProposal,
        },
      };
    case "openRehearsalRun": {
      if (action.plan.procedure !== "rehearsal") return state;
      const financier =
        [state.workspace.production, state.workspace.parkedProduction].find(
          isFinancierSession,
        ) ?? null;
      const initial = initialProductionSession("rehearsal");
      return {
        ...state,
        view: {
          ...state.view,
          camera: state.view.camera === "overhead" ? "overhead" : "perspective",
        },
        workspace: {
          kind: "production",
          surfaceSessionId: state.workspace.surfaceSessionId,
          surfaceEpoch: state.workspace.surfaceEpoch + 1,
          production: {
            ...initial,
            ...rehearsalSessionPatch(
              initial,
              action.plan,
              action.notice,
              false,
              state.run.layout,
            ),
          },
          parkedProduction: financier,
          runSaves: state.workspace.runSaves,
          runSaveProposal: state.workspace.runSaveProposal,
          scenarioSaveProposal: state.workspace.scenarioSaveProposal,
        },
      };
    }
    case "productionSessionChanged": {
      if (state.workspace.kind !== "production") return state;
      const candidate: ProductionSession = {
        ...state.workspace.production,
        ...action.patch,
      };
      let merged =
        candidate.replacement !== null &&
        !productionReplacementCurrent(candidate, candidate.replacement)
          ? { ...candidate, replacement: null }
          : candidate;
      if (
        merged.pending.kind === "run" &&
        !workspaceRunReviewCurrent(merged, merged.pending.review)
      )
        merged = { ...merged, pending: { kind: "none" } };
      // Reviews belong to the plan they were prepared from.
      const session: ProductionSession = productionRunIdentityChanged(
        state.workspace.production,
        merged,
      )
        ? {
            ...merged,
            layout: "layout" in action.patch ? merged.layout : null,
            rehearsalReview: null,
          }
        : merged;
      const changed =
        productionRunIdentityChanged(state.workspace.production, session) ||
        state.workspace.production.pending !== session.pending;
      const observed: SimulatorState = {
        ...state,
        workspace: {
          kind: "production",
          surfaceSessionId: state.workspace.surfaceSessionId,
          surfaceEpoch: state.workspace.surfaceEpoch,
          production: session,
          parkedProduction: state.workspace.parkedProduction,
          runSaves: state.workspace.runSaves,
          runSaveProposal: state.workspace.runSaveProposal,
          scenarioSaveProposal: state.workspace.scenarioSaveProposal,
        },
      };
      return changed
        ? applyBakeryWorkspaceAction({ kind: "activeRunChanged" }, observed)
        : observed;
    }
    case "workspaceRunOpenPrepared": {
      if (
        !canOpenWorkspaceRun(state) ||
        state.workspace.kind !== "production" ||
        state.workspace.production.pending.kind !== "none" ||
        !workspaceRunReviewCurrent(state.workspace.production, action.review)
      )
        return state;
      const session = state.workspace.production;
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: {
            pending: { kind: "run", review: action.review },
            panel: "files",
            cursor: { time: session.cursor.time, playback: "paused" },
            notice:
              "Saved run checked. Review its setup and recorded results before replacing the current run.",
          },
        },
        state,
      );
    }
    case "workspaceRunOpenResolved": {
      if (state.workspace.kind !== "production") return state;
      const session = state.workspace.production;
      if (
        session.pending.kind !== "run" ||
        session.pending.review !== action.review
      )
        return state;
      if (action.decision === "discard")
        return applyBakeryWorkspaceAction(
          {
            kind: "productionSessionChanged",
            patch: {
              pending: { kind: "none" },
              notice: "Saved run review discarded. The current run is kept.",
            },
          },
          state,
        );
      if (
        !canOpenWorkspaceRun(state) ||
        !workspaceRunReviewCurrent(session, action.review)
      )
        return state;
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: workspaceRunReviewPatch(
            session,
            action.review,
            state.run.layout,
          ),
        },
        state,
      );
    }
    case "productionPanelShown": {
      if (
        state.workspace.kind !== "production" ||
        state.workspace.production.data !== action.from
      )
        return state;
      return applyBakeryWorkspaceAction(
        { kind: "productionSessionChanged", patch: { panel: action.panel } },
        state,
      );
    }
    case "productionNavigated": {
      if (
        state.workspace.kind !== "production" ||
        state.workspace.production.reading ||
        state.workspace.production.data !== action.navigation.from
      )
        return state;
      const { from, time, target } = action.navigation;
      if (!Number.isFinite(time) || time < 0 || time > from.run.end)
        return state;
      if (target.kind === "operation") {
        if (!from.plan.operations.includes(target.operation)) return state;
        return applyBakeryWorkspaceAction(
          {
            kind: "productionSessionChanged",
            patch: {
              operationId: target.operation.id,
              panel: "files",
              cursor: { time, playback: "paused" },
            },
          },
          state,
        );
      }
      if (!selectionExists(from.run, target.selection)) return state;
      let operationId = state.workspace.production.operationId;
      if (target.selection.kind === "task") {
        const operation = from.plan.operations.find(
          productionOperationHasId.bind(null, target.selection.id),
        );
        if (operation !== undefined) operationId = operation.id;
      }
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: {
            selection: target.selection,
            operationId,
            panel: "details",
            cursor: { time, playback: "paused" },
          },
        },
        state,
      );
    }
    case "productionBaselineChanged": {
      if (state.workspace.kind !== "production") return state;
      const session = state.workspace.production;
      if (
        session.data.kind !== "ready" ||
        session.reading ||
        (session.preview?.run ?? session.data.run) !== action.source ||
        session.baseline !== action.baseline
      )
        return state;
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: {
            baseline:
              action.action === "pin" ? summarizeRun(action.source) : null,
            notice:
              action.action === "pin"
                ? "Current run pinned as the comparison baseline."
                : "Baseline cleared.",
          },
        },
        state,
      );
    }
    case "rehearsalReviewPrepared": {
      if (
        !canReviewRehearsal(state) ||
        state.workspace.kind !== "production" ||
        state.workspace.production.data.kind !== "ready" ||
        state.workspace.production.data.plan !== action.review.edit.from ||
        state.workspace.production.rehearsalReview !== null
      )
        return state;
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: {
            rehearsalReview: action.review,
            panel: "author",
            notice: "Review this change before replacing trays or results.",
          },
        },
        state,
      );
    }
    case "rehearsalReviewResolved": {
      if (
        state.workspace.kind !== "production" ||
        state.workspace.production.rehearsalReview !== action.review ||
        state.workspace.production.data.kind !== "ready" ||
        state.workspace.production.data.plan !== action.review.edit.from
      )
        return state;
      if (action.decision === "discard")
        return applyBakeryWorkspaceAction(
          {
            kind: "productionSessionChanged",
            patch: {
              rehearsalReview: null,
              notice: "Change discarded. The rehearsal is unchanged.",
            },
          },
          state,
        );
      if (!canReviewRehearsal(state)) return state;
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: rehearsalSessionPatch(
            state.workspace.production,
            action.review.edit.plan,
            action.review.edit.notice,
            false,
            state.run.layout,
          ),
        },
        state,
      );
    }
    case "rehearsalEdited": {
      if (state.workspace.kind !== "production") return state;
      if (
        state.browserJob.kind === "loading" ||
        state.browserJob.kind === "running"
      )
        return state;
      const session = state.workspace.production;
      if (
        session.procedure !== "rehearsal" ||
        session.readOnly.length > 0 ||
        session.data.kind !== "ready" ||
        session.data.plan !== action.edit.from
      )
        return state;
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: {
            ...rehearsalSessionPatch(
              session,
              action.edit.plan,
              action.edit.notice,
              true,
              state.run.layout,
            ),
            cursor: { time: session.cursor.time, playback: "paused" },
          },
        },
        state,
      );
    }
    case "productionDraftEdited": {
      if (state.workspace.kind !== "production") return state;
      const session = state.workspace.production;
      if (session.procedure !== "financier" || session.data.kind !== "ready")
        return state;
      const result = editProductionDraft(session, action.edit);
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch:
            result.kind === "ready" ? result.patch : { notice: result.message },
        },
        state,
      );
    }
    case "productionPreviewed": {
      if (state.workspace.kind !== "production") return state;
      const patch = previewPatch(state.workspace.production, action.preview);
      return patch === null
        ? state
        : applyBakeryWorkspaceAction(
            { kind: "productionSessionChanged", patch },
            state,
          );
    }
    case "productionReplacementPrepared": {
      if (
        !canReplaceProduction(state) ||
        state.workspace.kind !== "production" ||
        state.workspace.production.replacement !== null ||
        !productionReplacementCurrent(state.workspace.production, action.review)
      )
        return state;
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: {
            replacement: action.review,
            panel: "author",
            notice: "Review the production replacement before applying it.",
          },
        },
        state,
      );
    }
    case "productionReplacementResolved": {
      if (
        state.workspace.kind !== "production" ||
        state.workspace.production.replacement !== action.review
      )
        return state;
      if (action.decision === "discard")
        return applyBakeryWorkspaceAction(
          {
            kind: "productionSessionChanged",
            patch: {
              replacement: null,
              notice: "Replacement discarded. The production run is unchanged.",
            },
          },
          state,
        );
      if (
        !canReplaceProduction(state) ||
        !productionReplacementCurrent(state.workspace.production, action.review)
      )
        return state;
      const session = state.workspace.production;
      const preset = action.review.summary.source;
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: {
            ...appliedRunPatch(
              session,
              action.review.proposed,
              "Replacement applied. New native requests are ready in Files.",
            ),
            replacement: null,
            ...(preset === "preview"
              ? {}
              : {
                  identity: newDraftIdentity(),
                  sourceProcedure: null,
                  financierPreset: preset,
                }),
          },
        },
        state,
      );
    }
    case "productionPreviewApplied": {
      if (state.workspace.kind !== "production") return state;
      const session = state.workspace.production;
      if (
        !canReplaceProduction(state) ||
        session.data.kind !== "ready" ||
        acceptedProductionResults(session.data.plan) > 0 ||
        session.replacement !== null ||
        session.procedure !== "financier" ||
        session.preview === null ||
        session.preview !== action.preview
      )
        return state;
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: appliedRunPatch(
            session,
            action.preview,
            "Preview applied. New native requests are ready in Files.",
          ),
        },
        state,
      );
    }
    case "productionCandidateDiscarded": {
      if (
        state.workspace.kind !== "production" ||
        state.workspace.production.pending !== action.candidate
      )
        return state;
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: {
            pending: { kind: "none" },
            notice:
              "Current production run kept. The native result was not accepted.",
          },
        },
        state,
      );
    }
    case "acceptRecording": {
      const target = action.target;
      if (state.workspace.kind !== "production") return state;
      const session = state.workspace.production;
      if (session.data.kind !== "ready" || session.pending !== target.candidate)
        return state;
      const result =
        target.accepted.from === session.data.plan
          ? { kind: "ready" as const, plan: target.accepted.plan }
          : {
              kind: "rejected" as const,
              message: "The run changed before acceptance.",
            };
      if (result.kind === "rejected")
        return applyBakeryWorkspaceAction(
          {
            kind: "productionSessionChanged",
            patch: { pending: { kind: "none" }, notice: result.message },
          },
          state,
        );
      const operation = result.plan.operations.find(
        productionOperationHasId.bind(null, target.candidate.operationId),
      );
      if (operation === undefined) return state;
      const accepted: ProductionReady = {
        kind: "ready",
        plan: result.plan,
        run: simulateProduction(result.plan, state.run.layout),
      };
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: {
            data: accepted,
            preview: accepted,
            cursor: { time: 0, playback: "paused" },
            pending: { kind: "none" },
            operationId: operation.id,
            selection: { kind: "batch", id: operation.batchId },
            notice:
              "Matching native evidence accepted. Production recomputed through the same scheduler.",
          },
        },
        state,
      );
    }
    case "productionBrowserCommitted": {
      // Run in browser authorizes its own results. A changed run rejects them.
      if (state.workspace.kind !== "production") return state;
      const session = state.workspace.production;
      if (
        session.data.kind !== "ready" ||
        session.data.plan !== action.previous
      )
        return state;
      const operation = action.next.operations.find(
        productionOperationHasId.bind(null, action.operationId),
      );
      if (operation === undefined) return state;
      const run = simulateProduction(action.next, state.run.layout);
      const committed: ProductionReady = {
        kind: "ready",
        plan: action.next,
        run,
      };
      return applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: {
            data: committed,
            // Only a preview of the running plan follows its results. A draft
            // stays unchanged; applying it replaces this run.
            preview:
              session.preview !== null &&
              session.preview.plan === action.previous
                ? committed
                : session.preview,
            cursor: {
              time: Math.min(session.cursor.time, run.end),
              playback: "paused",
            },
            pending: { kind: "none" },
            operationId: operation.id,
            selection: { kind: "batch", id: operation.batchId },
            notice:
              operation.attempt.kind === "awaiting-evidence"
                ? `Running ${operation.id} in this browser.`
                : `Browser result accepted for ${operation.id}. Production recomputed through the same scheduler.`,
          },
        },
        state,
      );
    }
    case "workspaceRunSaveProposed": {
      if (
        !(
          state.workspace.kind === "rehearsal" ||
          (state.workspace.kind === "production" &&
            state.workspace.production.procedure === "rehearsal")
        ) ||
        action.prepared.snapshot.kind !== "rehearsal"
      )
        return state;
      const save = state.workspace.runSaves.rehearsal;
      if (
        save.kind !== "idle" &&
        save.agentEffectId !== null &&
        (save.kind === "saving" ||
          save.kind === "outcome-unknown" ||
          save.kind === "saved-readback-failed" ||
          save.kind === "not-found")
      )
        return state;
      return {
        ...state,
        workspace: {
          ...state.workspace,
          runSaveProposal: {
            kind: "prepared",
            prepared: action.prepared,
            effectId: action.effectId,
          },
        },
      };
    }
    case "scenarioSaveProposed": {
      if (state.workspace.scenarioSaveProposal.kind !== "none") return state;
      if (
        (action.payload.kind === "scenario" &&
          state.workspace.kind !== "shift") ||
        (action.payload.kind === "production-scenario" &&
          state.workspace.kind !== "production")
      )
        return state;
      return {
        ...state,
        workspace: {
          ...state.workspace,
          scenarioSaveProposal: {
            kind: "prepared",
            payload: action.payload,
            manifest: action.manifest,
            effectId: action.effectId,
          },
        },
      };
    }
    case "scenarioSaveProposalCleared": {
      if (
        (state.workspace.scenarioSaveProposal.kind !== "prepared" &&
          state.workspace.scenarioSaveProposal.kind !== "failed-before-save" &&
          state.workspace.scenarioSaveProposal.kind !== "verified") ||
        state.workspace.scenarioSaveProposal.effectId !== action.effectId
      )
        return state;
      return {
        ...state,
        workspace: {
          ...state.workspace,
          scenarioSaveProposal: { kind: "none" },
        },
      };
    }
    case "scenarioSaveStarted": {
      const proposal = state.workspace.scenarioSaveProposal;
      if (
        (proposal.kind !== "prepared" &&
          proposal.kind !== "outcome-unknown" &&
          proposal.kind !== "saved-readback-failed") ||
        proposal.effectId !== action.effectId
      )
        return state;
      return {
        ...state,
        workspace: {
          ...state.workspace,
          scenarioSaveProposal: {
            kind: "saving",
            payload: proposal.payload,
            manifest: proposal.manifest,
            effectId: proposal.effectId,
            message: "Saving the reviewed copy…",
          },
        },
      };
    }
    case "scenarioSaveSettled": {
      const proposal = state.workspace.scenarioSaveProposal;
      if (proposal.kind !== "saving" || proposal.effectId !== action.effectId)
        return state;
      return {
        ...state,
        workspace: {
          ...state.workspace,
          scenarioSaveProposal: {
            kind: action.outcome.kind,
            payload: proposal.payload,
            manifest: proposal.manifest,
            effectId: proposal.effectId,
            message: action.outcome.message,
          },
        },
      };
    }
    case "workspaceRunSaveProposalCleared": {
      const proposal = state.workspace.runSaveProposal;
      if (
        proposal.kind !== "prepared" ||
        proposal.prepared.id !== action.id ||
        proposal.effectId !== action.effectId
      )
        return state;
      return {
        ...state,
        workspace: { ...state.workspace, runSaveProposal: { kind: "none" } },
      };
    }
    case "workspaceRunSaveAbandoned": {
      const save = state.workspace.runSaves.rehearsal;
      if (
        save.kind !== "not-found" ||
        save.organisationId !== action.organisationId ||
        save.requestId !== action.requestId ||
        save.id !== action.id ||
        save.agentEffectId !== action.effectId
      )
        return state;
      const reset = withWorkspaceRunSave(state, "rehearsal", {
        kind: "idle",
      });
      return applyBakeryWorkspaceAction(
        {
          kind: "workspaceRunSaveProposalCleared",
          id: action.id,
          effectId: action.effectId,
        },
        reset,
      );
    }
    case "workspaceRunSaveStarted": {
      const current = state.workspace.runSaves[action.runKind];
      if (
        current.kind !== "idle" &&
        current.organisationId === action.organisationId &&
        (current.kind === "saving" ||
          current.kind === "outcome-unknown" ||
          current.kind === "saved-readback-failed")
      )
        return state;
      if (
        current.kind === "not-found" &&
        current.organisationId === action.organisationId &&
        (current.id !== action.id ||
          current.name !== action.name ||
          current.agentEffectId !== action.agentEffectId)
      )
        return state;
      const saving: WorkspaceRunSaveStatus = {
        kind: "saving",
        organisationId: action.organisationId,
        requestId: action.requestId,
        id: action.id,
        name: action.name,
        agentEffectId: action.agentEffectId,
      };
      return withWorkspaceRunSave(state, action.runKind, saving);
    }
    case "workspaceRunSaveSettled": {
      const current = state.workspace.runSaves[action.runKind];
      if (
        current.kind !== "saving" ||
        current.organisationId !== action.organisationId ||
        current.requestId !== action.requestId
      )
        return state;
      const settled = settledWorkspaceRunSave(
        current,
        action.runKind,
        action.outcome,
      );
      const updated = withWorkspaceRunSave(state, action.runKind, settled);
      if (settled.kind === "verified" && current.agentEffectId !== null)
        return applyBakeryWorkspaceAction(
          {
            kind: "workspaceRunSaveProposalCleared",
            id: settled.snapshot.id,
            effectId: current.agentEffectId,
          },
          updated,
        );
      return updated;
    }
    case "workspaceRunSaveRecovered": {
      const current = state.workspace.runSaves[action.runKind];
      if (
        (current.kind !== "outcome-unknown" &&
          current.kind !== "saved-readback-failed" &&
          current.kind !== "not-found") ||
        current.organisationId !== action.organisationId ||
        current.requestId !== action.requestId
      )
        return state;
      const id =
        current.kind === "saved-readback-failed"
          ? current.snapshot.id
          : current.id;
      const name =
        current.kind === "saved-readback-failed"
          ? current.snapshot.name
          : current.name;
      if (id !== action.id || name !== action.name) return state;
      const updated = withWorkspaceRunSave(state, action.runKind, {
        kind: "readback-confirmed",
        organisationId: current.organisationId,
        requestId: current.requestId,
        id,
        name,
        agentEffectId: current.agentEffectId,
      });
      if (current.agentEffectId !== null)
        return applyBakeryWorkspaceAction(
          {
            kind: "workspaceRunSaveProposalCleared",
            id,
            effectId: current.agentEffectId,
          },
          updated,
        );
      return updated;
    }
    case "workspaceRunSaveMissing": {
      const current = state.workspace.runSaves[action.runKind];
      if (
        (current.kind !== "outcome-unknown" &&
          current.kind !== "saved-readback-failed" &&
          current.kind !== "not-found") ||
        current.organisationId !== action.organisationId ||
        current.requestId !== action.requestId
      )
        return state;
      const id =
        current.kind === "saved-readback-failed"
          ? current.snapshot.id
          : current.id;
      const name =
        current.kind === "saved-readback-failed"
          ? current.snapshot.name
          : current.name;
      if (id !== action.id || name !== action.name) return state;
      return withWorkspaceRunSave(state, action.runKind, {
        kind: "not-found",
        organisationId: current.organisationId,
        requestId: current.requestId,
        id,
        name,
        agentEffectId: current.agentEffectId,
      });
    }
    default:
      return assertNever(action, "Unexpected simulator action");
  }
}

function withWorkspaceRunSave(
  state: SimulatorState,
  runKind: RunSnapshotKind,
  save: WorkspaceRunSaveStatus,
): SimulatorState {
  return {
    ...state,
    workspace: {
      ...state.workspace,
      runSaves: { ...state.workspace.runSaves, [runKind]: save },
    },
  };
}

function settledWorkspaceRunSave(
  started: Variant<WorkspaceRunSaveStatus, "saving">,
  runKind: RunSnapshotKind,
  outcome: WorkspaceRunSave,
): WorkspaceRunSaveStatus {
  switch (outcome.kind) {
    case "verified":
      if (
        outcome.snapshot.id !== started.id ||
        outcome.snapshot.kind !== runKind
      )
        return unknownWorkspaceRunSave(started);
      return {
        kind: "verified",
        organisationId: started.organisationId,
        requestId: started.requestId,
        snapshot: outcome.snapshot,
        agentEffectId: started.agentEffectId,
      };
    case "saved-readback-failed":
      if (
        outcome.snapshot.id !== started.id ||
        outcome.snapshot.kind !== runKind
      )
        return unknownWorkspaceRunSave(started);
      return {
        kind: "saved-readback-failed",
        organisationId: started.organisationId,
        requestId: started.requestId,
        snapshot: outcome.snapshot,
        message: outcome.message,
        agentEffectId: started.agentEffectId,
      };
    case "outcome-unknown":
      return {
        kind: "outcome-unknown",
        organisationId: started.organisationId,
        requestId: started.requestId,
        id: started.id,
        name: started.name,
        message: outcome.message,
        agentEffectId: started.agentEffectId,
      };
    default:
      return assertNever(outcome, "Unexpected simulator action");
  }
}

function unknownWorkspaceRunSave(
  started: Variant<WorkspaceRunSaveStatus, "saving">,
): WorkspaceRunSaveStatus {
  return {
    kind: "outcome-unknown",
    organisationId: started.organisationId,
    requestId: started.requestId,
    id: started.id,
    name: started.name,
    message: `The save outcome for ${started.id} is uncertain. Check that run before another save.`,
    agentEffectId: started.agentEffectId,
  };
}

// A recording opened in the rehearsal workspace replaces what chat observed.
function activateRehearsalRun(
  previous: SimulatorState,
  next: SimulatorState,
): SimulatorState {
  return previous.workspace.kind === "rehearsal"
    ? applyBakeryWorkspaceAction({ kind: "activeRunChanged" }, next)
    : next;
}

export function applySimulatorReplayAction(
  action: SimulatorReplayAction,
  state: SimulatorState,
): SimulatorState {
  switch (action.kind) {
    case "openRecording":
      return { ...state, replay: openPhysicsReplay(state.replay) };
    case "closeRecording":
      return {
        ...state,
        view: {
          ...state.view,
          camera: state.view.camera === "overhead" ? "overhead" : "perspective",
        },
        replay: closePhysicsReplay(state.replay),
      };
    case "recordingLoaded":
      return activateRehearsalRun(state, {
        ...state,
        view: {
          ...state.view,
          camera: state.view.camera === "overhead" ? "overhead" : "perspective",
        },
        replay: loadPhysicsReplay(state.replay, action.recording),
      });
    case "recordingNavigated": {
      if (
        state.workspace.kind !== "rehearsal" ||
        state.replay.kind !== "recording"
      )
        return state;
      const replay = navigateRecording(state.replay, action.navigation);
      return replay === state.replay ? state : { ...state, replay };
    }
    case "frameUpdated":
      if (state.workspace.kind === "production")
        return applyBakeryWorkspaceAction(
          {
            kind: "productionSessionChanged",
            patch: { cursor: { time: action.time, playback: action.playback } },
          },
          state,
        );
      return {
        ...state,
        replay: updateActivePlayback(state.replay, action),
      };
    case "goTo":
      if (state.workspace.kind === "production") {
        if (!Number.isFinite(action.time)) return state;
        return applyBakeryWorkspaceAction(
          {
            kind: "productionSessionChanged",
            patch: {
              cursor: {
                time: Math.max(
                  0,
                  Math.min(simulatorPlaybackSnapshot(state).end, action.time),
                ),
                playback: "paused",
              },
            },
          },
          state,
        );
      }
      return {
        ...state,
        replay: seekActivePlayback(
          state.replay,
          action.time,
          activeRun(state).end,
        ),
      };
    case "chooseVariant":
      if (action.variant === state.run.variant) return state;
      return applyBakeryWorkspaceAction(
        { kind: "activeRunChanged" },
        {
          ...state,
          run: { ...state.run, variant: action.variant },
          view: {
            ...state.view,
            selection: selectionForRun(
              action.variant === "normal" ? normalRun(state) : outageRun(state),
              state.view.selection,
            ),
          },
          replay: resetWorkflowPlayback(state.replay),
        },
      );
    case "chooseSpeed":
      if (state.workspace.kind === "production") return state;
      return {
        ...state,
        replay: changePlaybackSpeed(state.replay, action.speed),
      };
    case "compareOutage": {
      const compared: SimulatorState = {
        ...state,
        view: {
          ...state.view,
          selection: selectionForRun(outageRun(state), state.view.selection),
        },
        run: {
          ...state.run,
          baseline: normalRun(state),
          variant: "outage",
        },
        replay: resetWorkflowPlayback(state.replay),
      };
      return state.run.variant === "outage"
        ? compared
        : applyBakeryWorkspaceAction({ kind: "activeRunChanged" }, compared);
    }
    case "pinBaseline":
      return {
        ...state,
        run: { ...state.run, baseline: activeRun(state) },
      };
    default:
      return assertNever(action, "Unexpected simulator action");
  }
}

export function applySimulatorViewAction(
  action: SimulatorViewAction,
  state: SimulatorState,
): SimulatorState {
  switch (action.kind) {
    case "openDock":
      return { ...state, view: { ...state.view, dock: action.dock } };
    case "resetView":
      return {
        ...state,
        view: {
          ...state.view,
          dock: "closed",
          camera: "perspective",
          cameraMoved: false,
          cameraResetRevision: state.view.cameraResetRevision + 1,
        },
      };
    case "select":
      if (!selectionExists(activeRun(state), action.selection)) return state;
      return {
        ...state,
        view: {
          ...state.view,
          selection: action.selection,
          dock: "inspector",
        },
      };
    case "selectTimeline":
      if (!selectionExists(activeRun(state), action.selection)) return state;
      return {
        ...state,
        view: { ...state.view, selection: action.selection },
      };
    case "navigate": {
      if (state.workspace.kind !== "shift") return state;
      const run = activeRun(state);
      if (
        !selectionExists(run, action.selection) ||
        !Number.isFinite(action.time) ||
        action.time < 0 ||
        action.time > run.end
      )
        return state;
      return {
        ...state,
        view: {
          ...state.view,
          selection: action.selection,
          dock: action.focus === "inspector" ? "inspector" : state.view.dock,
        },
        replay: seekActivePlayback(state.replay, action.time, run.end),
      };
    }
    case "setCamera":
      if (
        action.camera !== "perspective" &&
        action.camera !== "overhead" &&
        (state.workspace.kind !== "rehearsal" ||
          state.replay.kind !== "recording")
      )
        return state;
      return {
        ...state,
        view: {
          ...state.view,
          camera: action.camera,
          cameraResetRevision:
            action.camera === "perspective" || action.camera === "overhead"
              ? state.view.cameraResetRevision
              : state.view.cameraResetRevision + 1,
        },
      };
    case "setDoorPreview":
      if (
        state.workspace.kind !== "rehearsal" ||
        state.replay.kind !== "recording"
      )
        return state;
      return {
        ...state,
        replay: previewRecordingDoor(state.replay, action.degrees),
      };
    case "resetCamera":
      return {
        ...state,
        view: {
          ...state.view,
          camera: "perspective",
          cameraMoved: false,
          cameraResetRevision: state.view.cameraResetRevision + 1,
        },
      };
    case "cameraMoved":
      return { ...state, view: { ...state.view, cameraMoved: action.moved } };
    case "setLabels":
      return { ...state, view: { ...state.view, labels: action.labels } };
    case "setMinimap":
      return { ...state, view: { ...state.view, minimap: action.visible } };
    case "overviewFits":
      return { ...state, view: { ...state.view, overviewFits: action.fits } };
    case "setChrome":
      return {
        ...state,
        view: {
          ...state.view,
          chrome: action.chrome,
        },
      };
    default:
      return assertNever(action, "Unexpected simulator action");
  }
}

/**
 * The corner overview can show while the interface is up, the layout has room
 * and no panel covers the corner.
 */
function overviewAvailable(view: SimulatorViewState): boolean {
  return (
    view.chrome === "shown" && view.overviewFits && leavesCornerClear(view.dock)
  );
}

export function overviewShown(view: SimulatorViewState): boolean {
  return view.minimap && overviewAvailable(view);
}

/** Panels on the right or along the bottom cover the corner overview. */
function leavesCornerClear(dock: SimulatorDock): boolean {
  switch (dock) {
    case "closed":
    case "workflow":
    case "inputs":
    case "scenarios":
    case "timeline":
      return true;
    case "inspector":
    case "comparison":
    case "floorPlan":
      return false;
    default:
      return assertNever(dock, "Unexpected simulator action");
  }
}

export function applySimulatorSceneStatus(
  status: SceneLoadState["status"],
  state: SimulatorState,
): SimulatorState {
  switch (status) {
    case "loading":
    case "ready":
    case "unavailable":
      return { ...state, scene: { status } };
    default:
      return assertNever(status, "Unexpected simulator action");
  }
}

export function applySimulatorExperimentAction(
  action: SimulatorExperimentAction,
  state: SimulatorState,
): SimulatorState {
  switch (action.kind) {
    case "workspaceProcedureLoaded":
      return resetForNewExperiment(
        state,
        action.shift,
        "normal",
        action.copyId,
        action.notice,
      );
    case "localSampleSelected":
      return resetForNewExperiment(
        state,
        action.shift,
        "normal",
        action.copyId,
        action.notice,
      );
    case "demoSelected":
      return resetForNewExperiment(
        state,
        action.shift,
        action.variant,
        state.scenario.copyId,
        action.notice,
      );
    case "experimentApplied":
      return resetForNewExperiment(
        state,
        action.shift,
        "normal",
        action.copyId,
        action.notice,
      );
    case "spatialLayoutChanged":
      return { ...state, run: { ...state.run, layout: action.layout } };
    case "spatialLayoutRecalculated": {
      const nextState: SimulatorState = {
        ...state,
        run: {
          ...state.run,
          shift: action.shift,
          layout: action.layout,
        },
        scenario: {
          ...state.scenario,
          notice: action.notice,
        },
      };
      const nextRun = activeRun(nextState);
      const currentWorkflowReplay = workflowReplay(state.replay);
      const clampedTime = Math.max(
        0,
        Math.min(nextRun.end, currentWorkflowReplay.time),
      );
      return applyBakeryWorkspaceAction(
        { kind: "activeRunChanged" },
        {
          ...nextState,
          view: {
            ...nextState.view,
            selection: selectionForRun(nextRun, state.view.selection),
          },
          replay: updateActivePlayback(state.replay, {
            time: clampedTime,
            playback: currentWorkflowReplay.playback,
          }),
        },
      );
    }
    case "assumptionDraftChanged":
      return {
        ...state,
        scenario: {
          ...state.scenario,
          assumptionDraft: action.draft,
          draftRevision: state.scenario.draftRevision + 1,
          surfaceEditProposal: null,
          surfaceEditUndo: null,
          error: null,
        },
      };
    case "assumptionDraftDiscarded":
      return {
        ...state,
        procedureLoad: { kind: "idle" },
        scenario: {
          ...state.scenario,
          assumptionDraft: new Map(),
          draftRevision: state.scenario.draftRevision + 1,
          surfaceEditProposal: null,
          surfaceEditUndo: null,
          error: null,
        },
      };
    case "surfaceEditPrepared":
      return {
        ...state,
        scenario: {
          ...state.scenario,
          surfaceEditProposal: action.proposal,
        },
      };
    case "surfaceEditDiscarded":
      return {
        ...state,
        scenario: { ...state.scenario, surfaceEditProposal: null },
      };
    case "surfaceEditApplied": {
      const draft = new Map(state.scenario.assumptionDraft);
      for (const edit of action.proposal.edits)
        draft.set(edit.field, String(edit.value));
      return {
        ...state,
        scenario: {
          ...state.scenario,
          assumptionDraft: draft,
          draftRevision: state.scenario.draftRevision + 1,
          surfaceEditProposal: null,
          surfaceEditUndo: state.scenario.assumptionDraft,
          error: null,
          notice: "Reviewed agent changes are in the assumption draft.",
        },
      };
    }
    case "surfaceEditUndone":
      if (state.scenario.surfaceEditUndo === null) return state;
      return {
        ...state,
        scenario: {
          ...state.scenario,
          assumptionDraft: state.scenario.surfaceEditUndo,
          draftRevision: state.scenario.draftRevision + 1,
          surfaceEditProposal: null,
          surfaceEditUndo: null,
          error: null,
          notice: "Reviewed agent changes were undone.",
        },
      };
    case "assumptionsInvalid":
      return {
        ...state,
        scenario: { ...state.scenario, error: action.error },
      };
    default:
      return assertNever(action, "Unexpected simulator action");
  }
}

export function applySimulatorWorkspaceAction(
  action: SimulatorWorkspaceAction,
  state: SimulatorState,
): SimulatorState {
  switch (action.kind) {
    case "operationStarted":
      return { ...state, procedureLoad: { kind: "loading" } };
    case "operationFailed":
      return {
        ...state,
        procedureLoad: { kind: "failed", message: action.message },
      };
    case "copyNameChanged":
      return {
        ...state,
        scenario: {
          ...state.scenario,
          copyName: action.name,
          copyId: action.copyId,
        },
      };
    case "copyNoteChanged":
      return {
        ...state,
        scenario: {
          ...state.scenario,
          copyNote: action.note,
          copyId: action.copyId,
        },
      };
    case "noticeChanged":
      return {
        ...state,
        scenario: { ...state.scenario, notice: action.notice },
      };
    default:
      return assertNever(action, "Unexpected simulator action");
  }
}

function resetForShift(
  state: SimulatorState,
  shift: SimulatorShift,
  variant: ScheduleVariant,
  copyId: string,
  notice: string,
): SimulatorState {
  return applyBakeryWorkspaceAction(
    { kind: "activeRunChanged" },
    {
      ...state,
      run: { ...state.run, shift, variant },
      replay: resetWorkflowPlayback(state.replay),
      scenario: {
        ...state.scenario,
        copyId,
        notice,
        draftRevision: state.scenario.draftRevision + 1,
        surfaceEditProposal: null,
        surfaceEditUndo: null,
      },
      view: { ...state.view, selection: { kind: "batch", id: "A" } },
    },
  );
}

function isFinancierSession(session: ProductionSession | null): boolean {
  return session?.procedure === "financier";
}

function productionRunIdentityChanged(
  previous: ProductionSession,
  next: ProductionSession,
): boolean {
  if (previous.data.kind !== next.data.kind) return true;
  return (
    previous.data.kind === "ready" &&
    next.data.kind === "ready" &&
    previous.data.plan !== next.data.plan
  );
}

function productionOperationHasId(
  id: string,
  operation: ProductionWorkcell,
): boolean {
  return operation.id === id;
}

function resetForNewExperiment(
  state: SimulatorState,
  shift: SimulatorShift,
  variant: ScheduleVariant,
  copyId: string,
  notice: string,
): SimulatorState {
  const reset = resetForShift(state, shift, variant, copyId, notice);
  return {
    ...reset,
    procedureLoad: { kind: "idle" },
    scenario: {
      ...reset.scenario,
      assumptionDraft: new Map(),
      error: null,
    },
  };
}

// Financier + robot reopens an existing financier run with the preset chosen,
// so the operator replaces the run explicitly.
function presetSession(
  session: ProductionSession,
  preset: FinancierPreset | undefined,
): ProductionSession {
  if (
    preset === undefined ||
    session.procedure !== "financier" ||
    session.financierPreset === preset
  )
    return session;
  return {
    ...session,
    financierPreset: preset,
    notice:
      "Your production run is still open. Use Replace with preset in Edit scenario to start from this preset.",
  };
}

export function simulatorPlaybackSnapshot(
  state: SimulatorState,
): PlaybackSnapshot {
  if (state.workspace.kind === "production") {
    const session = state.workspace.production;
    return {
      ...session.cursor,
      speed: 120,
      end: session.data.kind === "ready" ? session.data.run.end : 0,
    };
  }
  return sessionPlaybackSnapshot(state.replay, activeRun(state).end);
}

export function canOpenWorkspaceRun(state: SimulatorState): boolean {
  if (state.workspace.kind !== "production") return false;
  const session = state.workspace.production;
  const save =
    state.workspace.runSaves[
      session.procedure === "rehearsal" ? "rehearsal" : "production"
    ];
  return (
    session.data.kind === "ready" &&
    !session.reading &&
    !session.openingDefinition &&
    !session.savingDefinition &&
    session.pending.kind !== "recording" &&
    session.rehearsalReview === null &&
    session.replacement === null &&
    state.browserJob.kind !== "loading" &&
    state.browserJob.kind !== "running" &&
    state.workspace.runSaveProposal.kind === "none" &&
    state.workspace.scenarioSaveProposal.kind === "none" &&
    save.kind !== "saving" &&
    save.kind !== "outcome-unknown" &&
    save.kind !== "saved-readback-failed"
  );
}

export function canReviewRehearsal(state: SimulatorState): boolean {
  if (state.workspace.kind !== "production") return false;
  const session = state.workspace.production;
  const save = state.workspace.runSaves.rehearsal;
  return (
    session.procedure === "rehearsal" &&
    session.data.kind === "ready" &&
    session.readOnly.length === 0 &&
    !session.reading &&
    session.pending.kind === "none" &&
    state.browserJob.kind !== "loading" &&
    state.browserJob.kind !== "running" &&
    state.workspace.runSaveProposal.kind === "none" &&
    save.kind !== "saving" &&
    save.kind !== "outcome-unknown" &&
    save.kind !== "saved-readback-failed"
  );
}

export function canReplaceProduction(state: SimulatorState): boolean {
  if (state.workspace.kind !== "production") return false;
  const session = state.workspace.production;
  const save = state.workspace.runSaves.production;
  return (
    session.procedure === "financier" &&
    session.data.kind === "ready" &&
    session.pending.kind === "none" &&
    !session.reading &&
    !session.openingDefinition &&
    !session.savingDefinition &&
    state.browserJob.kind !== "loading" &&
    state.browserJob.kind !== "running" &&
    state.workspace.runSaveProposal.kind === "none" &&
    state.workspace.scenarioSaveProposal.kind === "none" &&
    save.kind !== "saving" &&
    save.kind !== "outcome-unknown" &&
    save.kind !== "saved-readback-failed"
  );
}

export function applySimulatorBrowserStop(
  wasRunning: boolean,
  state: SimulatorState,
): SimulatorState {
  const message = wasRunning
    ? "Browser simulation stopped. Completed tasks are preserved; run again to continue."
    : "";
  const stopped: SimulatorState = {
    ...state,
    browserJob: { kind: "idle" },
    workcellNotice: message,
  };
  return wasRunning && state.workspace.kind === "production"
    ? applyBakeryWorkspaceAction(
        { kind: "productionSessionChanged", patch: { notice: message } },
        stopped,
      )
    : stopped;
}
