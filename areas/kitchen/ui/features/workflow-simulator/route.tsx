import { floorPlanWorkspace } from "./floor-plan-workspace";
import { UserPreferencesContext } from "@purin-labs/ui/preferences/context";
import { downloadBakeryFile } from "./file-download";
import { type BakeryExportFile } from "./production-files";
import { MAX_EXPERIMENT_BYTES } from "@purin-labs/production-simulation/recipes/bakery/workcell-experiment";
import type { BakeryWorkspaceViewAction } from "@purin-labs/bakery-model/bakery-surface";
import { controlRead } from "@purin-labs/control/portal/control-client";
import { readProductionScenario } from "./production-scenario-api";
import { assertNever, sha256Hex } from "@purin-labs/std";
import {
  BrowserProductionRun,
  type ProductionStepResult,
} from "./browser-production-run";
import { pendingSimulation } from "./scheduled-rehearsal";
import type { ProductionWorkcells } from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import {
  applyWorkcellPreparation,
  canPrepareWorkcell,
  type PreparedWorkcell,
} from "./workcell-preparation";
import { rehearsalFromRecording, rehearsalSettings } from "@purin-labs/production-simulation/simulator/rehearsal-presets";
import { applyPlaybackAction } from "./playback-actions";
import type { BakeryPlaybackAction } from "@purin-labs/bakery-model/bakery-surface";
import type { CompiledProcedure } from "@purin-labs/bakery-model/bakery-procedure";
import {
  type Settings,
  type SettingsField,
  type Operation,
  type StationId,
} from "@purin-labs/bakery-model/bakery";
import {
  demoPreset,
  type DemoPreset,
} from "@purin-labs/production-simulation/simulator/demo";
import { shiftFloorPlanLayout } from "./shift-layout";
import { runShiftInputs, SHIFT_RUN_NOTICE } from "./shift-run";
import { readScenario } from "./scenario-api.ts";
import React from "react";
import type { PhysicsReplay } from "@purin-labs/bakery-model/bakery-physics";
import type {
  BakerySurfaceCommandResultV1,
  RejectedBakerySurfaceCommandResultV1,
  BakerySurfaceCommandV1,
  BakerySurfaceEffectV1,
  ExecutableBakerySurfaceEffectV1,
} from "@purin-labs/bakery-model/bakery-surface";
import { EngineJobs, type JobProgress } from "../production-run/engine-jobs";
import {
  recordingReplayView,
  workflowReplay,
  type RecordingNavigation,
} from "@purin-labs/production-simulation/simulator/playback-state";
import {
  VITRINE_RUSH_PRESETS,
  getActiveVitrineRushPreset,
  recommendedCapacityForRushPreset,
  shouldApplyVitrineCapacity,
  subscribeVitrineRushPreset,
  type Interval,
  type ScheduleVariant,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import {
  buildLiveScheduleSpatialLayout,
  getLiveStationWalkLegs,
  moveApplianceWithCollisions,
  rotateApplianceWithCollisions,
  setApplianceRotationWithCollisions,
} from "./bakery-appliance-layout";
import { BAKERY_FLOOR_PLAN_ORDER } from "@purin-labs/production-simulation/floor/bakery-room";
import { findFloorPlanOpening } from "@purin-labs/production-simulation/floor/openings";
import {
  REHEARSAL_APPLIANCE_IDS,
  isApplianceId,
} from "@purin-labs/production-simulation/floor/appliance-catalogue";
import {
  applyStoreInteriorPreset,
  subscribeStoreInteriorDesign,
  updateStoreInteriorDesign,
} from "./store-interior-design";

import type { SceneFrame, SceneViewChange } from "./scene";
import type { SceneLabelMode } from "./simulator-state";
import { nextLabelMode, overviewToggleId } from "./docks/scene-view";
import {
  operationTask,
  selectionForInterval,
  type Selection,
} from "@purin-labs/production-simulation/simulator/selection";
import { PlaybackTimeContext, SimulatorPlayback } from "./simulator-playback";
import {
  focusChromeRestore,
  focusElement,
  focusRevealedChrome,
  readDock,
  rememberDock,
  shortcutTarget,
  undoRedoTarget,
} from "./simulator-chrome";
import type { PlaybackUpdate } from "@purin-labs/production-simulation/simulator/playback-state";
import type { Run } from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { SceneController } from "./scene-controller";
import {
  activeRun,
  applyBakeryWorkspaceAction,
  simulatorPlaybackSnapshot,
  type BakeryWorkspaceAction,
  type PreparedRecordingAcceptance,
  applySimulatorExperimentAction,
  applySimulatorReplayAction,
  applySimulatorSceneStatus,
  applySimulatorViewAction,
  applySimulatorBrowserStop,
  applySimulatorWorkspaceAction,
  defaultViewPreferences,
  initialSimulatorState,
  jobState,
  normalRun,
  overviewShown,
  procedureShift,
  rerunShift,
  simulatorShellView,
  type SimulatorConnection,
  type SimulatorDock as Dock,
  type SimulatorState as State,
} from "./simulator-state";
import {
  createWorkspaceSample,
  loadScenarioCopy,
  loadWorkspaceProcedure,
  saveScenarioCopy,
  savePreparedScenarioCopy,
} from "./workspace-commands";
import { savePreparedProductionScenario } from "./production-scenario-api";
import { WorkflowSimulatorShell } from "./simulator-shell";
import { measuredSettingFields } from "@purin-labs/production-simulation/simulator/measured-shift";
import type { WorkflowSimulatorActionGroups } from "./simulator-actions";
import {
  bakerySurfaceCommandSucceeded,
  captureBakerySurface,
  commitBakerySurfaceCommand,
  prepareBakerySurfaceCommand,
  provideShiftFloorPlan,
  validatePreparedBakerySurfaceRead,
  type BakerySurfaceCommandTransition,
  type BakerySurfaceCommandOrigin,
  type PreparedBakerySurfaceCommand,
} from "./bakery-surface";
import {
  recordingAcceptanceReference,
  resolveRecordingAcceptanceReference,
} from "./recording-acceptance";
import {
  registerBakerySurface,
  notifySurfaceListeners,
  type MountedBakerySurface,
} from "@purin-labs/area-kitchen-contract/ui/features/bakery-surface-registry";
import { bakerySurfaceEffectIsPending } from "../bakery-surface-effect-bridge";
import { simulationResult } from "./simulation-result";

import "./styles.css";
import type { Variant } from "@purin-labs/type-utils";

type Props = {
  readonly connection: SimulatorConnection;
};

type SurfaceCommit = {
  transition: BakerySurfaceCommandTransition | null;
};

type SurfaceSimulation = Readonly<{
  resolve(result: BakerySurfaceCommandResultV1): void;
  command: Variant<BakerySurfaceCommandV1, "simulate_workcell">;
  effect: BakerySurfaceEffectV1;
}>;

type SurfaceInvocation =
  | Readonly<{
      kind: "local";
      command: Variant<
        BakerySurfaceCommandV1,
        "apply_reviewed_edit" | "prepare_run_open"
      >;
    }>
  | Readonly<{ kind: "agent_effect"; effect: ExecutableBakerySurfaceEffectV1 }>;

function commitPreparedSurfaceCommand(
  prepared: Exclude<
    PreparedBakerySurfaceCommand,
    { kind: "read" | "saved_runs" | "save_inspection" | "scenario_inspection" }
  >,
  origin: BakerySurfaceCommandOrigin,
  commit: SurfaceCommit,
  cancelledEffects: ReadonlyMap<string, number>,
  state: State,
): State | null {
  if (origin.kind === "agent_effect" && cancelledEffects.has(origin.effectId)) {
    commit.transition = {
      kind: "rejected",
      command: prepared.command.kind,
      code: "stale_surface",
      message: "The command was cancelled before it could be applied.",
    };
    return state;
  }
  const transition = commitBakerySurfaceCommand(state, prepared, origin);
  commit.transition = transition;
  return transition.kind === "applied" ? transition.state : state;
}

function commitPlaybackAction(
  action: BakeryPlaybackAction,
  state: State,
): State | null {
  const result = applyPlaybackAction(action, state);
  return result.kind === "applied" ? result.state : null;
}

// The rehearsal opens only while the same recording is still open.
function rehearsedRecording(
  recording: PhysicsReplay,
  prepared: PreparedWorkcell,
  state: State,
): State {
  const document = recordingReplayView(state.replay).document;
  return document.kind === "ready" && document.recording === recording
    ? applyWorkcellPreparation(state, prepared)
    : state;
}

export default class WorkflowSimulatorRoute extends React.Component<
  Props,
  State
> {
  static contextType = UserPreferencesContext;
  declare context: React.ContextType<typeof UserPreferencesContext>;
  private unsubscribePreferences: (() => void) | null = null;
  private unsubscribeAppliances: (() => void) | null = null;
  private unsubscribeFloorPlan: (() => void) | null = null;
  private unsubscribeOpenings: (() => void) | null = null;
  private unsubscribeVitrineRush: (() => void) | null = null;
  private unsubscribeInterior: (() => void) | null = null;
  private unsubscribeHistory: (() => void) | null = null;
  private deferSpatialRecalc = false;
  private lastWalkLegKey = "";
  state: State;
  private readonly host = React.createRef<HTMLDivElement>();
  private readonly shell = React.createRef<WorkflowSimulatorShell>();
  /** The Inspector's place for the floor plan's selection and fit details. */
  private readonly layoutDetails = React.createRef<HTMLDivElement>();
  private readonly form = React.createRef<HTMLFormElement>();
  private readonly sceneController = new SceneController();
  private readonly browserPhysics = new EngineJobs();
  private readonly browserProduction = new BrowserProductionRun(
    this.browserPhysics,
  );
  private browserRunGeneration = 0;
  private surfaceSimulation: SurfaceSimulation | null = null;
  private readonly cancelledSurfaceEffects = new Map<string, number>();
  private scenarioSaveInFlight: string | null = null;
  private readonly playback: SimulatorPlayback;
  private unsubscribeTime: (() => void) | null = null;
  private readonly actions: WorkflowSimulatorActionGroups;
  private mounted = false;
  private generation = 0;
  private unregisterSurface: (() => void) | null = null;
  private releaseFloorPlan: (() => void) | null = null;
  private ovenVisible = false;
  private readonly surface: MountedBakerySurface;
  private attachedFile: Readonly<{
    digest: string;
    file: BakeryExportFile;
  }> | null = null;
  private attachmentGeneration = 0;
  constructor(props: Props) {
    super(props);
    this.state = initialSimulatorState(
      readDock(),
      defaultViewPreferences,
      buildLiveScheduleSpatialLayout(floorPlanWorkspace.getActivePlan()),
    );
    this.surface = {
      organisationId:
        props.connection.kind === "workspace"
          ? props.connection.organisationId
          : "preview",
      capture: this.captureSurface.bind(this),
      attachFile: this.attachFile.bind(this),
      execute: this.executeSurfaceEffect.bind(this),
      cancel: this.cancelSurfaceEffect.bind(this),
      surfaceSessionId: this.surfaceSessionId.bind(this),
      surfaceEpoch: this.surfaceEpoch.bind(this),
    };
    this.playback = new SimulatorPlayback({
      snapshot: () => simulatorPlaybackSnapshot(this.state),
      run: this.playingRun.bind(this),
      commit: this.applyPlaybackUpdate.bind(this),
      coarse: () =>
        this.state.workspace.kind === "production" ||
        this.state.replay.kind === "workflow",
    });
    this.runShift = this.runShift.bind(this);
    this.discardAssumptions = this.discardAssumptions.bind(this);
    this.beforeUnload = this.beforeUnload.bind(this);
    this.select = this.select.bind(this);
    this.togglePlay = this.togglePlay.bind(this);
    this.nextEvent = this.nextEvent.bind(this);
    this.restart = this.restart.bind(this);
    this.seek = this.seek.bind(this);
    this.toggleCamera = this.toggleCamera.bind(this);
    this.toggleMinimap = this.toggleMinimap.bind(this);
    this.shortcut = this.shortcut.bind(this);
    this.persistViewPreferences = this.persistViewPreferences.bind(this);
    this.visibility = this.visibility.bind(this);
    this.loadProcedureId = this.loadProcedureId.bind(this);
    this.useSample = this.useSample.bind(this);
    this.createSample = this.createSample.bind(this);
    this.observeOperation = this.observeOperation.bind(this);
    this.saveScenario = this.saveScenario.bind(this);
    this.confirmAgentScenarioSave = this.confirmAgentScenarioSave.bind(this);
    this.dismissAgentScenarioSave = this.dismissAgentScenarioSave.bind(this);
    this.changeCopyName = this.changeCopyName.bind(this);
    this.changeCopyNote = this.changeCopyNote.bind(this);
    this.loadScenarioId = this.loadScenarioId.bind(this);
    this.pinBaseline = this.pinBaseline.bind(this);
    this.inspectInterval = this.inspectInterval.bind(this);
    this.seekInterval = this.seekInterval.bind(this);
    this.recalculateLiveSpatialSchedule =
      this.recalculateLiveSpatialSchedule.bind(this);
    this.syncCustomerRushBatchScaling =
      this.syncCustomerRushBatchScaling.bind(this);
    this.actions = this.createViewActions();
  }
  componentDidMount(): void {
    this.unsubscribePreferences =
      this.context?.subscribe(this.syncViewPreferences.bind(this)) ?? null;
    this.syncViewPreferences();
    void this.context?.load("kitchen");
    this.mounted = true;
    this.playback.synced();
    this.unsubscribeTime = this.playback.time.subscribe(
      this.followTime.bind(this),
    );
    this.generation++;
    this.unsubscribeAppliances = floorPlanWorkspace.subscribePlacements(
      this.recalculateLiveSpatialSchedule,
    );
    this.unsubscribeFloorPlan = floorPlanWorkspace.subscribePlan(
      this.recalculateLiveSpatialSchedule,
    );
    this.lastWalkLegKey = JSON.stringify(
      getLiveStationWalkLegs(floorPlanWorkspace.getActivePlan()),
    );
    this.unsubscribeOpenings = floorPlanWorkspace.subscribeOpenings(
      (planId) => {
        if (
          planId !== floorPlanWorkspace.getActivePlan() ||
          floorPlanWorkspace.isAnimating()
        ) {
          return;
        }
        const nextWalkLegKey = JSON.stringify(getLiveStationWalkLegs(planId));
        if (nextWalkLegKey !== this.lastWalkLegKey) {
          this.lastWalkLegKey = nextWalkLegKey;
          this.recalculateLiveSpatialSchedule();
        } else
          this.setState(
            applySimulatorExperimentAction.bind(null, {
              kind: "spatialLayoutChanged",
              layout: buildLiveScheduleSpatialLayout(planId),
            }),
          );
      },
    );
    this.unsubscribeVitrineRush = subscribeVitrineRushPreset(
      this.syncCustomerRushBatchScaling,
    );
    this.unsubscribeInterior = subscribeStoreInteriorDesign(() => {
      if (this.mounted) notifySurfaceListeners();
    });
    this.unsubscribeHistory = floorPlanWorkspace.subscribeHistory(() => {
      if (this.mounted && !this.deferSpatialRecalc) notifySurfaceListeners();
    });
    this.syncCustomerRushBatchScaling();
    if (this.props.connection.kind === "workspace")
      this.unregisterSurface = registerBakerySurface(this.surface);
    this.releaseFloorPlan = provideShiftFloorPlan(shiftFloorPlanLayout);
    document.addEventListener("visibilitychange", this.visibility);
    document.addEventListener("keydown", this.shortcut);
    window.addEventListener("beforeunload", this.beforeUnload);
    if (this.host.current !== null) {
      this.sceneController.mount(
        this.host.current,
        this.sceneFrame(),
        this.selectScene.bind(this),
        this.sceneStatus.bind(this),
        this.sceneView.bind(this),
        this.layoutDetails.current ?? undefined,
      );
    }
  }
  componentDidUpdate(_previous: Props, previousState: State): void {
    this.playback.synced();
    if (this.state.replay.kind === "workflow") {
      this.sceneController.update(this.sceneFrame());
    }
    if (
      previousState.workspace.surfaceEpoch !== this.state.workspace.surfaceEpoch
    )
      notifySurfaceListeners();
  }
  componentWillUnmount(): void {
    this.unsubscribeTime?.();
    this.unsubscribePreferences?.();
    this.unsubscribeAppliances?.();
    this.unsubscribeAppliances = null;
    this.unsubscribeFloorPlan?.();
    this.unsubscribeFloorPlan = null;
    this.unsubscribeOpenings?.();
    this.unsubscribeOpenings = null;
    this.unsubscribeVitrineRush?.();
    this.unsubscribeVitrineRush = null;
    this.unsubscribeInterior?.();
    this.unsubscribeInterior = null;
    this.unsubscribeHistory?.();
    this.unsubscribeHistory = null;
    this.mounted = false;
    this.attachedFile = null;
    this.attachmentGeneration++;
    this.stopBrowserPhysics();
    this.generation++;
    this.stopFrame();
    this.sceneController.dispose();
    this.unregisterSurface?.();
    this.unregisterSurface = null;
    this.releaseFloorPlan?.();
    this.releaseFloorPlan = null;
    document.removeEventListener("visibilitychange", this.visibility);
    document.removeEventListener("keydown", this.shortcut);
    window.removeEventListener("beforeunload", this.beforeUnload);
  }
  private recalculateLiveSpatialSchedule(): void {
    if (!this.mounted || this.deferSpatialRecalc) return;
    const activePlan = floorPlanWorkspace.getActivePlan();
    this.lastWalkLegKey = JSON.stringify(getLiveStationWalkLegs(activePlan));
    const layout = buildLiveScheduleSpatialLayout(activePlan);
    const shift = rerunShift(this.state.run.shift, layout);
    this.setState(
      applySimulatorExperimentAction.bind(null, {
        kind: "spatialLayoutRecalculated",
        shift,
        layout,
        notice:
          "Walk times and shift schedule recalculated from live 3D station positions.",
      }),
    );
  }
  private syncCustomerRushBatchScaling(): void {
    if (!this.mounted || !shouldApplyVitrineCapacity()) return;
    const rec = recommendedCapacityForRushPreset();
    const currentShift = this.state.run.shift;
    const currentSettings =
      currentShift.kind === "procedure"
        ? currentShift.normal.source.settings
        : currentShift.normal.settings;
    const nextOvenTrays =
      currentShift.kind === "procedure"
        ? currentSettings.ovenTrays
        : Math.max(rec.ovenTrays, currentSettings.traysPerBatch);
    const nextHorizonMinutes = Math.max(
      rec.horizonMinutes,
      currentSettings.outageEnd,
    );
    if (
      currentSettings.batchCount === rec.batchCount &&
      currentSettings.workerCount === rec.workerCount &&
      currentSettings.ovenTrays === nextOvenTrays &&
      currentSettings.horizonMinutes === nextHorizonMinutes
    ) {
      return;
    }
    const nextSettings: Settings = {
      ...currentSettings,
      batchCount: rec.batchCount,
      workerCount: rec.workerCount,
      ovenTrays: nextOvenTrays,
      horizonMinutes: nextHorizonMinutes,
    };
    const shift = rerunShift(currentShift, this.state.run.layout, nextSettings);
    const presetSpec = VITRINE_RUSH_PRESETS.find(
      (p) => p.id === getActiveVitrineRushPreset(),
    );
    const notice = `Scaled shift to ${rec.batchCount} batches, ${rec.workerCount} workers, and ${nextOvenTrays} oven trays for ${presetSpec?.shortLabel ?? "customer demand"} (${presetSpec?.orderCount ?? 8} orders).`;
    this.setState((prev) => {
      let next = prev;
      if (
        prev.scenario.assumptionDraft.has("batchCount") ||
        prev.scenario.assumptionDraft.has("workerCount") ||
        prev.scenario.assumptionDraft.has("ovenTrays") ||
        prev.scenario.assumptionDraft.has("horizonMinutes")
      ) {
        const draft = new Map(prev.scenario.assumptionDraft);
        draft.delete("batchCount");
        draft.delete("workerCount");
        draft.delete("ovenTrays");
        draft.delete("horizonMinutes");
        next = applySimulatorExperimentAction(
          { kind: "assumptionDraftChanged", draft },
          next,
        );
      }
      return applySimulatorExperimentAction(
        {
          kind: "spatialLayoutRecalculated",
          shift,
          layout: this.state.run.layout,
          notice,
        },
        next,
      );
    });
  }
  private async attachFile(file: File) {
    if (!this.mounted || this.state.workspace.kind !== "production")
      throw new Error(
        "Open a production or rehearsal workspace before attaching a file.",
      );
    if (
      !file.name.endsWith(".json") ||
      file.name.length > 160 ||
      file.size > MAX_EXPERIMENT_BYTES
    )
      throw new Error(
        "Choose a Kitchen JSON file within the recording size limit.",
      );
    const generation = ++this.attachmentGeneration;
    const text = await file.text();
    const digest = await sha256Hex(text);
    if (!this.mounted || generation !== this.attachmentGeneration)
      throw new Error(
        "The workspace or attachment changed. Attach the file again.",
      );
    this.attachedFile = { digest, file: { name: file.name, text } };
    return {
      name: file.name,
      digest,
      bytes: new TextEncoder().encode(text).length,
    };
  }
  private readAttachment(digest: string): BakeryExportFile {
    if (this.attachedFile === null || this.attachedFile.digest !== digest)
      throw new Error(
        "Attach this exact file in the current workspace before importing it.",
      );
    return this.attachedFile.file;
  }
  private captureSurface() {
    if (this.ovenVisible)
      return Promise.reject(
        new Error("The persistent oven workspace has no agent surface yet."),
      );
    return captureBakerySurface(this.state);
  }
  private persistentOvenVisible(visible: boolean): void {
    if (!this.mounted || visible === this.ovenVisible) return;
    this.ovenVisible = visible;
    this.workspace({ kind: "activeRunChanged" });
    this.unregisterSurface?.();
    this.unregisterSurface = null;
    if (!visible && this.props.connection.kind === "workspace")
      this.unregisterSurface = registerBakerySurface(this.surface);
  }
  private async prepareRunOpen(id: string): Promise<void> {
    if (this.state.workspace.kind !== "production") return;
    const result = await this.executeSurface({
      kind: "local",
      command: {
        schemaVersion: 1,
        kind: "prepare_run_open",
        id,
        runKind:
          this.state.workspace.production.procedure === "rehearsal"
            ? "rehearsal"
            : "production",
        target: {
          surfaceSessionId: this.state.workspace.surfaceSessionId,
          surfaceEpoch: this.state.workspace.surfaceEpoch,
        },
      },
    });
    if (result.kind === "rejected") throw new Error(result.message);
  }
  private surfaceEpoch(): number {
    return this.state.workspace.surfaceEpoch;
  }
  private surfaceSessionId(): string {
    return this.state.workspace.surfaceSessionId;
  }
  private cancelSurfaceEffect(effect: BakerySurfaceEffectV1): void {
    for (const [effectId, deadline] of this.cancelledSurfaceEffects)
      if (deadline <= Date.now()) this.cancelledSurfaceEffects.delete(effectId);
    this.cancelledSurfaceEffects.set(effect.effectId, effect.deadlineAt);
    const pending = this.surfaceSimulation;
    if (
      pending !== null &&
      pending.effect.effectId === effect.effectId &&
      pending.effect.dispatchId === effect.dispatchId &&
      pending.effect.commandDigest === effect.commandDigest
    )
      this.stopBrowserPhysics();
  }

  private executeSurfaceEffect(
    effect: ExecutableBakerySurfaceEffectV1,
  ): Promise<BakerySurfaceCommandResultV1> {
    return this.executeSurface({ kind: "agent_effect", effect });
  }
  private async executeSurface(
    invocation: SurfaceInvocation,
  ): Promise<BakerySurfaceCommandResultV1> {
    if (this.ovenVisible)
      return {
        kind: "rejected",
        command:
          invocation.kind === "agent_effect"
            ? invocation.effect.command.kind
            : invocation.command.kind,
        code: "unsupported_command",
        message: "The persistent oven workspace has no agent controls yet.",
      };
    if (invocation.kind === "agent_effect") {
      if (!(await this.surfaceEffectIsPending(invocation.effect)))
        return {
          kind: "rejected",
          command: invocation.effect.command.kind,
          code: "stale_surface",
          message:
            "Workspace access could not be verified. The command was not applied. Check your connection and workspace access before trying again.",
        };
      if (invocation.effect.command.kind === "simulate_workcell")
        return this.executeSurfaceSimulation(
          invocation.effect.command,
          invocation.effect,
        );
    }
    const command =
      invocation.kind === "agent_effect"
        ? invocation.effect.command
        : invocation.command;
    const preparationState = this.state;
    const connection = this.props.connection;
    const prepared = await prepareBakerySurfaceCommand(
      preparationState,
      command,
      sha256Hex,
      this.props.connection.kind === "workspace"
        ? {
            organisationId: this.props.connection.organisationId,
            read: controlRead,
            readDefinition: readProductionScenario,
            readScenario,
            readAttachment: this.readAttachment.bind(this),
          }
        : null,
    );
    if (prepared.kind === "rejected") return prepared;
    if (
      (prepared.kind === "file" ||
        prepared.kind === "run_open" ||
        prepared.kind === "saved_runs" ||
        prepared.kind === "save_inspection" ||
        prepared.kind === "scenario_inspection") &&
      (connection.kind !== "workspace" ||
        this.props.connection.kind !== "workspace" ||
        connection.organisationId !== this.props.connection.organisationId)
    )
      return {
        kind: "rejected",
        command: command.kind,
        code: "stale_surface",
        message:
          "The workspace connection changed. Retry the saved-run request.",
      };
    if (
      invocation.kind === "agent_effect" &&
      !(await this.surfaceEffectIsPending(invocation.effect))
    )
      return {
        kind: "rejected",
        command: command.kind,
        code: "stale_surface",
        message:
          "Workspace access could not be verified. The command was not applied. Check your connection and workspace access before trying again.",
      };
    if (
      prepared.kind === "read" ||
      prepared.kind === "saved_runs" ||
      prepared.kind === "save_inspection" ||
      prepared.kind === "scenario_inspection"
    ) {
      const rejected = validatePreparedBakerySurfaceRead(this.state, prepared);
      return (
        rejected ?? bakerySurfaceCommandSucceeded(preparationState, prepared)
      );
    }
    if (
      prepared.kind === "workspace_view" &&
      (prepared.command.action.kind === "setCamera" ||
        prepared.command.action.kind === "resetCamera")
    ) {
      const camera =
        prepared.command.action.kind === "setCamera"
          ? prepared.command.action.camera
          : "perspective";
      const ready =
        this.state.workspace.kind === "shift"
          ? this.state.scene.status === "ready"
          : this.shell.current?.cameraAvailable(camera) === true;
      if (!ready)
        return {
          kind: "rejected",
          command: command.kind,
          code: "unsupported_command",
          message:
            "The requested camera is unavailable. Wait for the 3D scene to load; selection focus also requires selected equipment.",
        };
    }
    if (
      prepared.kind === "workspace_view" &&
      prepared.command.action.kind === "setDoorPreview"
    ) {
      if (this.shell.current?.doorInspectionAvailable !== true)
        return {
          kind: "rejected",
          command: command.kind,
          code: "unsupported_command",
          message:
            "Wait for the recording's verified oven hinge geometry before inspecting its door.",
        };
      if (prepared.command.action.degrees !== null) this.stopFrame();
    }
    if (
      command.kind === "set_view" ||
      command.kind === "compare_shift" ||
      command.kind === "start_production" ||
      prepared.kind === "run_open" ||
      prepared.kind === "shift_run"
    )
      this.stopFrame();
    const origin: BakerySurfaceCommandOrigin =
      invocation.kind === "agent_effect"
        ? { kind: "agent_effect", effectId: invocation.effect.effectId }
        : { kind: "local" };
    return new Promise(this.startSurfaceCommit.bind(this, prepared, origin));
  }
  private executeSurfaceSimulation(
    command: Variant<BakerySurfaceCommandV1, "simulate_workcell">,
    effect: BakerySurfaceEffectV1,
  ): Promise<BakerySurfaceCommandResultV1> {
    if (command.schemaVersion === 2)
      return this.executeScheduledSimulation(command, effect);
    // Browser simulations run steps of a scheduled rehearsal.
    return Promise.resolve(
      this.simulationRejected(
        "unsupported_command",
        "Prepare a rehearsal, then simulate its awaited step.",
      ),
    );
  }
  // A scheduled rehearsal runs its awaited step in review mode. The result
  // waits as a production candidate until accept_candidate or the operator
  // accepts it.
  private executeScheduledSimulation(
    command: Extract<
      BakerySurfaceCommandV1,
      { kind: "simulate_workcell"; schemaVersion: 2 }
    >,
    effect: BakerySurfaceEffectV1,
  ): Promise<BakerySurfaceCommandResultV1> {
    const workspace = this.state.workspace;
    const session =
      workspace.kind === "production" ? workspace.production : null;
    if (
      command.target.surfaceSessionId !== workspace.surfaceSessionId ||
      command.target.surfaceEpoch !== workspace.surfaceEpoch ||
      session === null ||
      session.data.kind !== "ready" ||
      session.readOnly.length > 0 ||
      session.pending.kind !== "none" ||
      session.rehearsalReview !== null ||
      session.replacement !== null ||
      session.reading ||
      session.data.plan.fingerprint !== command.planFingerprint
    )
      return Promise.resolve(
        this.simulationRejected(
          "stale_surface",
          "The run changed before execution.",
        ),
      );
    const plan = session.data.plan;
    const pending = pendingSimulation(plan, session.data.run);
    if (pending === null || pending.operation.id !== command.operationId)
      return Promise.resolve(
        this.simulationRejected(
          "stale_surface",
          "The run awaits a different step.",
        ),
      );
    if (pending.mode !== command.mode)
      return Promise.resolve(
        this.simulationRejected(
          "unsupported_command",
          `${pending.label} runs in ${pending.mode} mode.`,
        ),
      );
    if (
      this.surfaceSimulation !== null ||
      this.browserPhysics.running ||
      this.browserProduction.running
    )
      return Promise.resolve(
        this.simulationRejected(
          "unsupported_command",
          "A browser simulation is already running.",
        ),
      );
    return new Promise(
      this.startScheduledSimulation.bind(this, command, effect, plan),
    );
  }
  private startScheduledSimulation(
    command: Extract<
      BakerySurfaceCommandV1,
      { kind: "simulate_workcell"; schemaVersion: 2 }
    >,
    effect: BakerySurfaceEffectV1,
    plan: ProductionWorkcells,
    resolve: (result: BakerySurfaceCommandResultV1) => void,
  ): void {
    this.surfaceSimulation = { command, effect, resolve };
    const generation = ++this.browserRunGeneration;
    this.browserProduction.start(
      plan,
      this.state.run.layout,
      {
        commit: this.commitBrowserProductionRun.bind(this, generation),
        progress: this.browserProgress.bind(this, generation),
        finished: this.browserRunFinished.bind(this),
        failed: this.scheduledSimulationFailed.bind(this),
        reviewed: this.scheduledSimulationReviewed.bind(this, generation),
      },
      command.operationId,
    );
  }
  private scheduledSimulationFailed(message: string): void {
    if (this.mounted)
      this.setState({
        browserJob: { kind: "failed", message },
        workcellNotice: message,
      });
    this.finishSurfaceSimulation(
      this.simulationRejected("simulation_failed", message),
    );
  }
  private async scheduledSimulationReviewed(
    generation: number,
    step: ProductionStepResult,
  ): Promise<void> {
    const pending = this.surfaceSimulation;
    if (
      pending === null ||
      pending.command.schemaVersion !== 2 ||
      generation !== this.browserRunGeneration ||
      !(await this.verifySurfaceSimulationAccess())
    )
      return;
    const workspace = this.state.workspace;
    if (
      !this.mounted ||
      workspace.kind !== "production" ||
      workspace.production.data.kind !== "ready" ||
      workspace.production.data.plan !== step.plan ||
      workspace.production.pending.kind !== "none" ||
      workspace.production.rehearsalReview !== null
    ) {
      this.finishSurfaceSimulation(
        this.simulationRejected(
          "stale_surface",
          "The run changed during execution.",
        ),
      );
      return;
    }
    this.setState(
      applyBakeryWorkspaceAction.bind(null, {
        kind: "productionSessionChanged",
        patch: {
          pending: {
            kind: "recording",
            operationId: step.operationId,
            fingerprint: step.plan.fingerprint,
            recording: step.outcome.recording,
            handoff: step.handoff,
          },
          panel: "files",
          notice:
            "Browser result ready. Review it below before accepting it; the run is unchanged.",
        },
      }),
      this.scheduledCandidateShown.bind(this, step),
    );
  }
  private async scheduledCandidateShown(
    step: ProductionStepResult,
  ): Promise<void> {
    const pending = this.surfaceSimulation;
    if (pending === null || pending.command.schemaVersion !== 2) return;
    try {
      const surface = await this.captureSurface();
      const active = surface.context.active;
      if (
        !(
          (active.kind === "production" && active.readiness === "ready") ||
          (active.kind === "rehearsal" && active.rehearsalKind === "scheduled")
        ) ||
        active.candidate?.kind !== "production" ||
        active.candidate.operationId !== step.operationId
      ) {
        this.finishSurfaceSimulation(
          this.simulationRejected(
            "stale_surface",
            "The browser result was not available for review.",
          ),
        );
        return;
      }
      this.setState({
        browserJob: { kind: "idle" },
        workcellNotice: `Browser simulation complete in ${(step.outcome.elapsedMs / 1000).toFixed(1)} s. Review the result before accepting it.`,
      });
      this.finishSurfaceSimulation({
        kind: "succeeded",
        command: "simulate_workcell",
        surface,
        output: {
          kind: "simulation",
          mode: pending.command.mode,
          recordingDigest: active.candidate.recordingDigest,
          bytes: step.outcome.bytes,
          elapsedMs: step.outcome.elapsedMs,
          ...simulationResult(step.outcome.recording),
        },
      });
    } catch (error) {
      this.finishSurfaceSimulation(
        this.simulationRejected(
          "simulation_failed",
          error instanceof Error
            ? error.message
            : "The browser result could not be verified.",
        ),
      );
    }
  }
  private async surfaceEffectIsPending(
    effect: BakerySurfaceEffectV1,
  ): Promise<boolean> {
    if (
      !this.mounted ||
      this.props.connection.kind !== "workspace" ||
      this.cancelledSurfaceEffects.has(effect.effectId)
    )
      return false;
    const organisationId = this.props.connection.organisationId;
    const pending = await bakerySurfaceEffectIsPending(organisationId, effect);
    return (
      pending &&
      !this.cancelledSurfaceEffects.has(effect.effectId) &&
      this.mounted &&
      this.props.connection.kind === "workspace" &&
      this.props.connection.organisationId === organisationId
    );
  }
  private async verifySurfaceSimulationAccess(): Promise<boolean> {
    // Worker output can arrive after workspace access or the effect expires.
    const pending = this.surfaceSimulation;
    if (pending === null) return true;
    const authorized = await this.surfaceEffectIsPending(pending.effect);
    if (this.surfaceSimulation !== pending) return false;
    if (authorized) return true;
    const message =
      "Workspace access could not be verified. The simulation result was not applied. Check your connection and workspace access before trying again.";
    if (this.mounted)
      this.setState({
        browserJob: { kind: "failed", message },
        workcellNotice: message,
      });
    this.finishSurfaceSimulation(
      this.simulationRejected("stale_surface", message),
    );
    return false;
  }
  private simulationRejected(
    code: RejectedBakerySurfaceCommandResultV1["code"],
    message: string,
  ): RejectedBakerySurfaceCommandResultV1 {
    return { kind: "rejected", command: "simulate_workcell", code, message };
  }
  private startSurfaceCommit(
    prepared: Exclude<
      PreparedBakerySurfaceCommand,
      {
        kind: "read" | "saved_runs" | "save_inspection" | "scenario_inspection";
      }
    >,
    origin: BakerySurfaceCommandOrigin,
    resolve: (result: BakerySurfaceCommandResultV1) => void,
    reject: (reason?: unknown) => void,
  ): void {
    const commit: SurfaceCommit = { transition: null };
    if (this.ovenVisible) {
      resolve({
        kind: "rejected",
        command: prepared.command.kind,
        code: "stale_surface",
        message: "The operator opened a persistent oven run.",
      });
      return;
    }
    this.setState(
      commitPreparedSurfaceCommand.bind(
        null,
        prepared,
        origin,
        commit,
        this.cancelledSurfaceEffects,
      ),
      this.finishSurfaceCommit.bind(this, prepared, commit, resolve, reject),
    );
  }
  private finishSurfaceCommit(
    prepared: Exclude<
      PreparedBakerySurfaceCommand,
      {
        kind: "read" | "saved_runs" | "save_inspection" | "scenario_inspection";
      }
    >,
    commit: SurfaceCommit,
    resolve: (result: BakerySurfaceCommandResultV1) => void,
    reject: (reason?: unknown) => void,
  ): void {
    const transition = commit.transition;
    if (transition === null) throw new Error("bakery_surface_commit_missing");
    if (transition.kind === "rejected") {
      resolve(transition);
      return;
    }
    if (
      prepared.kind === "workspace_view" &&
      this.state.workspace.kind === "shift"
    )
      this.finishWorkspaceViewAction(prepared.command.action);
    if (prepared.kind === "simulation_stop") this.stopBrowserPhysics();
    if (prepared.kind === "equipment_rotation") {
      if (!isApplianceId(prepared.command.applianceId)) {
        resolve({
          kind: "rejected",
          command: prepared.command.kind,
          code: "target_not_found",
          message: "That appliance is not in this floor plan.",
        });
        return;
      }
      this.deferSpatialRecalc = true;
      let rotation: ReturnType<typeof rotateApplianceWithCollisions>;
      try {
        rotation = rotateApplianceWithCollisions(
          floorPlanWorkspace.getActivePlan(),
          prepared.command.applianceId,
          REHEARSAL_APPLIANCE_IDS,
        );
      } finally {
        this.deferSpatialRecalc = false;
      }
      if (rotation.kind === "blocked") {
        resolve({
          kind: "rejected",
          command: prepared.command.kind,
          code: "invalid_edit",
          message:
            "There is not enough room to rotate this appliance. Its position stays unchanged.",
        });
        return;
      }
      this.recalculateLiveSpatialSchedule();
      this.setState(
        null,
        this.reportSurfaceCommit.bind(this, prepared, resolve, reject),
      );
      return;
    }
    if (prepared.kind === "equipment_angle") {
      if (!isApplianceId(prepared.command.applianceId)) {
        resolve({
          kind: "rejected",
          command: prepared.command.kind,
          code: "target_not_found",
          message: "That appliance is not in this floor plan.",
        });
        return;
      }
      this.deferSpatialRecalc = true;
      let rotation: ReturnType<typeof setApplianceRotationWithCollisions>;
      try {
        rotation = setApplianceRotationWithCollisions(
          floorPlanWorkspace.getActivePlan(),
          prepared.command.applianceId,
          (prepared.command.yawDegrees * Math.PI) / 180,
          REHEARSAL_APPLIANCE_IDS,
          false,
        );
      } finally {
        this.deferSpatialRecalc = false;
      }
      if (rotation.kind === "blocked") {
        resolve({
          kind: "rejected",
          command: prepared.command.kind,
          code: "invalid_edit",
          message:
            "There is not enough room to rotate this appliance to that angle. Its position stays unchanged.",
        });
        return;
      }
      this.recalculateLiveSpatialSchedule();
      this.setState(
        null,
        this.reportSurfaceCommit.bind(this, prepared, resolve, reject),
      );
      return;
    }
    if (prepared.kind === "equipment_move") {
      if (!isApplianceId(prepared.command.applianceId)) {
        resolve({
          kind: "rejected",
          command: prepared.command.kind,
          code: "target_not_found",
          message: "That appliance is not in this floor plan.",
        });
        return;
      }
      this.deferSpatialRecalc = true;
      let move: ReturnType<typeof moveApplianceWithCollisions>;
      try {
        move = moveApplianceWithCollisions(
          floorPlanWorkspace.getActivePlan(),
          prepared.command.applianceId,
          prepared.command.xMm / 1000,
          prepared.command.zMm / 1000,
          REHEARSAL_APPLIANCE_IDS,
        );
      } finally {
        this.deferSpatialRecalc = false;
      }
      if (move.kind === "blocked") {
        resolve({
          kind: "rejected",
          command: prepared.command.kind,
          code: "invalid_edit",
          message:
            "There is not enough room to place this appliance there. Its position stays unchanged.",
        });
        return;
      }
      this.recalculateLiveSpatialSchedule();
      this.setState(
        null,
        this.reportSurfaceCommit.bind(this, prepared, resolve, reject),
      );
      return;
    }
    if (prepared.kind === "opening_toggle") {
      const planId = floorPlanWorkspace.getActivePlan();
      const opening = findFloorPlanOpening(planId, prepared.command.openingId);
      if (opening === null) {
        resolve({
          kind: "rejected",
          command: prepared.command.kind,
          code: "target_not_found",
          message: "That door or window is not in this floor plan.",
        });
        return;
      }
      const beforeHistoryVersion = floorPlanWorkspace.getHistoryVersion();
      this.deferSpatialRecalc = true;
      try {
        floorPlanWorkspace.setOpeningTarget(
          opening,
          prepared.command.open ? 1 : 0,
        );
        const afterProgress = floorPlanWorkspace.progress(opening);
        if (prepared.command.open ? afterProgress <= 0 : afterProgress >= 1) {
          if (floorPlanWorkspace.getHistoryVersion() !== beforeHistoryVersion) {
            floorPlanWorkspace.undo();
          }
          resolve({
            kind: "rejected",
            command: prepared.command.kind,
            code: "invalid_edit",
            message: "An appliance is blocking that opening.",
          });
          return;
        }
      } finally {
        this.deferSpatialRecalc = false;
      }
      this.recalculateLiveSpatialSchedule();
      this.setState(
        null,
        this.reportSurfaceCommit.bind(this, prepared, resolve, reject),
      );
      return;
    }
    if (prepared.kind === "floor_plan_select") {
      const targetPlan = BAKERY_FLOOR_PLAN_ORDER.find(
        (id) => id === prepared.command.floorPlan,
      );
      if (targetPlan === undefined) {
        resolve({
          kind: "rejected",
          command: prepared.command.kind,
          code: "invalid_edit",
          message: "That floor plan is not available.",
        });
        return;
      }
      this.deferSpatialRecalc = true;
      try {
        floorPlanWorkspace.setActivePlan(targetPlan);
      } finally {
        this.deferSpatialRecalc = false;
      }
      this.recalculateLiveSpatialSchedule();
      this.setState(
        null,
        this.reportSurfaceCommit.bind(this, prepared, resolve, reject),
      );
      return;
    }
    if (prepared.kind === "interior_configure") {
      const action = prepared.command.action;
      switch (action.kind) {
        case "apply_preset":
          applyStoreInteriorPreset(action.preset);
          break;
        case "set_floor_material":
          updateStoreInteriorDesign({ floorMaterial: action.floorMaterial });
          break;
        case "set_wall_material":
          updateStoreInteriorDesign({ wallMaterial: action.wallMaterial });
          break;
        case "set_fixture_finish":
          updateStoreInteriorDesign({ fixtureFinish: action.fixtureFinish });
          break;
        case "set_lighting_style":
          updateStoreInteriorDesign({ lightingStyle: action.lightingStyle });
          break;
        case "set_wall_height":
          updateStoreInteriorDesign({ wallHeightMode: action.wallHeightMode });
          break;
        case "set_furnishings":
          updateStoreInteriorDesign({
            showFurnishings: action.showFurnishings,
          });
          break;
        default:
          assertNever(action);
      }
      this.setState(
        null,
        this.reportSurfaceCommit.bind(this, prepared, resolve, reject),
      );
      return;
    }
    if (prepared.kind === "floor_plan_reset") {
      const action = prepared.command.action;
      this.deferSpatialRecalc = true;
      try {
        if (action === "undo") {
          if (!floorPlanWorkspace.undo()) {
            resolve({
              kind: "rejected",
              command: prepared.command.kind,
              code: "invalid_edit",
              message: "There is no floor plan action to undo.",
            });
            return;
          }
        } else if (action === "redo") {
          if (!floorPlanWorkspace.redo()) {
            resolve({
              kind: "rejected",
              command: prepared.command.kind,
              code: "invalid_edit",
              message: "There is no floor plan action to redo.",
            });
            return;
          }
        } else if (action === "reset_appliances") {
          const activePlan = floorPlanWorkspace.getActivePlan();
          const beforeVersion = floorPlanWorkspace.getPlacementVersion();
          floorPlanWorkspace.resetPlacements(activePlan);
          if (floorPlanWorkspace.getPlacementVersion() === beforeVersion) {
            resolve({
              kind: "rejected",
              command: prepared.command.kind,
              code: "invalid_edit",
              message:
                "Appliance placements are already at their room defaults.",
            });
            return;
          }
        } else if (action === "reset_initial") {
          const history = floorPlanWorkspace.getHistorySnapshot();
          if (
            !history.canUndo &&
            !history.canRedo &&
            !history.hasCustomLayout
          ) {
            resolve({
              kind: "rejected",
              command: prepared.command.kind,
              code: "invalid_edit",
              message: "The floor plan is already at its initial layout.",
            });
            return;
          }
          floorPlanWorkspace.resetToInitialLayout();
        } else {
          assertNever(action);
        }
      } finally {
        this.deferSpatialRecalc = false;
      }
      this.recalculateLiveSpatialSchedule();
      this.setState(
        null,
        this.reportSurfaceCommit.bind(this, prepared, resolve, reject),
      );
      return;
    }
    if (prepared.kind === "file" && prepared.prepared.kind === "export") {
      try {
        downloadBakeryFile(
          prepared.prepared.file.name,
          prepared.prepared.file.text,
        );
      } catch (error) {
        reject(error);
        return;
      }
    }
    void bakerySurfaceCommandSucceeded(transition.state, prepared).then(
      resolve,
      reject,
    );
  }
  private reportSurfaceCommit(
    prepared: Parameters<typeof bakerySurfaceCommandSucceeded>[1],
    resolve: (result: BakerySurfaceCommandResultV1) => void,
    reject: (reason?: unknown) => void,
  ): void {
    void bakerySurfaceCommandSucceeded(this.state, prepared).then(
      resolve,
      reject,
    );
  }
  private sceneStatus(scene: State["scene"]["status"]): void {
    if (this.mounted) {
      this.setState(applySimulatorSceneStatus.bind(null, scene));
    }
  }
  private sceneFrame(): SceneFrame {
    const view = this.state.view;
    const shown = view.chrome === "shown";
    return {
      run: activeRun(this.state),
      time: this.playback.time.get(),
      selection: view.selection,
      top: view.camera === "overhead",
      labels: view.labels,
      floorPlan: {
        open: shown && view.dock === "floorPlan",
        minimap: overviewShown(view),
      },
    };
  }
  private sceneView(change: SceneViewChange): void {
    if (!this.mounted) return;
    switch (change.kind) {
      case "floorPlan":
        if (change.open) this.openDock("floorPlan");
        else if (this.state.view.dock === "floorPlan") this.closeDock();
        return;
      case "minimap":
        this.setState(
          applySimulatorViewAction.bind(null, {
            kind: "setMinimap",
            visible: change.visible,
          }),
          change.visible
            ? this.persistViewPreferences
            : this.minimapHidden.bind(this),
        );
        return;
      case "overviewRoom":
        this.setState(
          applySimulatorViewAction.bind(null, {
            kind: "overviewFits",
            fits: change.fits,
          }),
        );
        return;
      case "camera":
        this.setState(
          applySimulatorViewAction.bind(null, {
            kind: "cameraMoved",
            moved: change.moved,
          }),
        );
        return;
      default:
        return assertNever(change, "Unexpected simulation state");
    }
  }
  /** The overview's own hide button vanishes with it; focus its toggle. */
  private minimapHidden(): void {
    this.persistViewPreferences();
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      active.closest(".spatial-minimap") !== null
    )
      document.getElementById(overviewToggleId)?.focus();
  }
  private observeOperation(operation: Operation): void {
    const task = operationTask(
      activeRun(this.state),
      this.state.view.selection,
      workflowReplay(this.state.replay).time,
      operation,
    );
    if (task !== null) {
      this.inspectInterval(task);
      return;
    }
    this.setState(
      applySimulatorWorkspaceAction.bind(null, {
        kind: "noticeChanged",
        notice:
          "This step does not start for the selected batch within this shift. Extend the horizon or inspect its waits.",
      }),
    );
  }
  private pinBaseline(): void {
    this.setState(
      applySimulatorReplayAction.bind(null, { kind: "pinBaseline" }),
    );
  }
  private applyWorkspaceViewAction(action: BakeryWorkspaceViewAction): void {
    if (action.kind === "setDoorPreview" && action.degrees !== null)
      this.stopFrame();
    this.setState(
      applySimulatorViewAction.bind(null, action),
      this.finishWorkspaceViewAction.bind(this, action),
    );
  }
  private finishWorkspaceViewAction(action: BakeryWorkspaceViewAction): void {
    switch (action.kind) {
      case "resetView":
        rememberDock("closed");
        this.sceneController.resetView();
        break;
      case "resetCamera":
        this.sceneController.resetView();
        break;
      case "openDock":
        rememberDock(action.dock);
        break;
      case "setLabels":
      case "setMinimap":
        this.persistViewPreferences();
        break;
      case "setChrome":
        if (action.chrome === "hidden") focusChromeRestore();
        else focusRevealedChrome();
        break;
      case "setCamera":
      case "setDoorPreview":
        break;
      default:
        assertNever(action);
    }
  }
  private openDock(dock: Dock): void {
    this.applyWorkspaceViewAction({ kind: "openDock", dock });
  }
  private toggleDock(dock: Exclude<Dock, "closed">): void {
    this.openDock(this.state.view.dock === dock ? "closed" : dock);
  }
  private closeDock(): void {
    const dock = this.state.view.dock;
    this.openDock("closed");
    const trigger =
      document.getElementById(`workflow-toggle-${dock}`) ??
      document.getElementById("workflow-more");
    trigger?.focus();
  }
  private dockKeyDown(event: React.KeyboardEvent): void {
    // Escape in a drawer of the panel closes the drawer, not the panel.
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      this.state.view.dock !== "closed" &&
      !(event.target instanceof Element && event.target.closest("dialog"))
    ) {
      event.preventDefault();
      this.closeDock();
    }
  }
  private resetView(): void {
    this.applyWorkspaceViewAction({ kind: "resetView" });
  }
  private compareOutage(): void {
    const prevVariant = this.state.run.variant;
    const prevDock = this.state.view.dock;
    this.stopFrame();
    this.setState(
      applySimulatorReplayAction.bind(null, { kind: "compareOutage" }),
    );
    floorPlanWorkspace.recordHistory({
      label: "Compare outage shift",
      undo: () => {
        if (!this.mounted) return;
        this.stopFrame();
        this.setState((prev) => ({
          ...applySimulatorReplayAction(
            { kind: "chooseVariant", variant: prevVariant },
            prev,
          ),
          view: { ...prev.view, dock: prevDock },
        }));
      },
      redo: () => {
        if (!this.mounted) return;
        this.stopFrame();
        this.setState(
          applySimulatorReplayAction.bind(null, { kind: "compareOutage" }),
        );
      },
    });
  }
  private changeCopyName(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState(
      applySimulatorWorkspaceAction.bind(null, {
        kind: "copyNameChanged",
        name: event.currentTarget.value,
        copyId: `scenario-${crypto.randomUUID()}`,
      }),
    );
  }
  private changeCopyNote(event: React.ChangeEvent<HTMLTextAreaElement>): void {
    this.setState(
      applySimulatorWorkspaceAction.bind(null, {
        kind: "copyNoteChanged",
        note: event.currentTarget.value,
        copyId: `scenario-${crypto.randomUUID()}`,
      }),
    );
  }
  private startWorkspaceOperation(): void {
    this.setState(
      applySimulatorWorkspaceAction.bind(null, { kind: "operationStarted" }),
    );
  }
  private failWorkspaceOperation(message: string): void {
    this.setState(
      applySimulatorWorkspaceAction.bind(null, {
        kind: "operationFailed",
        message,
      }),
    );
  }
  private workspaceProcedureLoaded(
    procedure: CompiledProcedure,
    notice: string,
  ): void {
    this.stopFrame();
    this.setState(
      applySimulatorExperimentAction.bind(null, {
        kind: "workspaceProcedureLoaded",
        shift: procedureShift(procedure, this.state.run.layout),
        copyId: `scenario-${crypto.randomUUID()}`,
        notice,
      }),
    );
  }
  private async saveScenario(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const connection = this.props.connection;
    const shift = this.state.run.shift;
    if (
      connection.kind !== "workspace" ||
      !connection.canManage ||
      shift.kind !== "procedure" ||
      this.state.procedureLoad.kind === "loading"
    ) {
      return;
    }
    if (this.state.scenario.assumptionDraft.size > 0) {
      this.failWorkspaceOperation(
        "Run or discard the assumption draft before saving a scenario copy. The displayed runs still use the applied inputs.",
      );
      return;
    }
    const name = this.state.scenario.copyName.trim();
    const note = this.state.scenario.copyNote.trim();
    const id = this.state.scenario.copyId;
    if (!name || !note) {
      this.failWorkspaceOperation(
        "Enter a scenario name and timing note with at least one non-space character.",
      );
      const input = event.currentTarget.elements.namedItem(
        !name ? "copyName" : "copyNote",
      );
      if (input instanceof HTMLElement) {
        input.focus();
      }
      return;
    }
    const generation = this.generation;
    this.startWorkspaceOperation();
    const result = await saveScenarioCopy(connection, {
      id,
      name,
      note,
      procedureRun: shift.normal,
    });
    if (!this.mounted || generation !== this.generation) {
      return;
    }
    if (result.kind !== "verified") {
      this.failWorkspaceOperation(result.message);
      return;
    }
    this.workspaceProcedureLoaded(result.scenario.procedure, result.notice);
  }
  private async loadScenarioId(id: string): Promise<void> {
    const connection = this.props.connection;
    if (
      connection.kind !== "workspace" ||
      this.state.procedureLoad.kind === "loading"
    ) {
      return;
    }
    if (
      this.state.scenario.assumptionDraft.size > 0 &&
      !window.confirm("Discard unrun assumptions and load the saved scenario?")
    ) {
      return;
    }
    const generation = this.generation;
    this.startWorkspaceOperation();
    const result = await loadScenarioCopy(connection.organisationId, id);
    if (!this.mounted || generation !== this.generation) {
      return;
    }
    if (result.kind !== "ready") {
      this.failWorkspaceOperation(result.message);
      return;
    }
    this.workspaceProcedureLoaded(
      result.procedure,
      `Loaded “${result.copy.name}”. Scenario entity ID: ${result.copy.id}. Timing note: ${result.copy.note}`,
    );
  }
  private async createSample(): Promise<void> {
    const connection = this.props.connection;
    if (
      connection.kind !== "workspace" ||
      !connection.canManage ||
      this.state.procedureLoad.kind === "loading"
    ) {
      return;
    }
    if (
      this.state.scenario.assumptionDraft.size > 0 &&
      !window.confirm(
        "Discard unrun assumptions and load the workspace sample?",
      )
    ) {
      return;
    }
    const generation = this.generation;
    this.startWorkspaceOperation();
    const result = await createWorkspaceSample(connection);
    if (!this.mounted || generation !== this.generation) {
      return;
    }
    if (result.kind === "failed") {
      this.failWorkspaceOperation(result.message);
      return;
    }
    this.workspaceProcedureLoaded(
      result.procedure,
      "Sample loaded · timings need calibration.",
    );
  }
  private async loadProcedureId(value: string): Promise<void> {
    if (
      this.props.connection.kind !== "workspace" ||
      this.state.procedureLoad.kind === "loading"
    ) {
      return;
    }
    if (
      this.state.scenario.assumptionDraft.size > 0 &&
      !window.confirm("Discard unrun assumptions and load the saved procedure?")
    ) {
      return;
    }
    const generation = this.generation;
    this.startWorkspaceOperation();
    const result = await loadWorkspaceProcedure(
      this.props.connection.organisationId,
      value,
      normalRun(this.state).settings,
    );
    if (!this.mounted || generation !== this.generation) {
      return;
    }
    if (result.kind === "failed") {
      this.failWorkspaceOperation(result.message);
      return;
    }
    this.workspaceProcedureLoaded(
      result.procedure,
      "Procedure loaded. Both simulations use the pinned entity snapshot.",
    );
  }
  private useSample(): void {
    if (this.state.procedureLoad.kind === "loading") {
      return;
    }
    if (
      this.state.scenario.assumptionDraft.size > 0 &&
      !window.confirm("Discard unrun assumptions and use the local sample?")
    ) {
      return;
    }
    this.stopFrame();
    const initial = initialSimulatorState(
      this.state.view.dock,
      defaultViewPreferences,
      this.state.run.layout,
    );
    if (initial.run.shift.kind !== "sample") {
      throw new Error("The simulator must initialize with a sample shift.");
    }
    this.setState(
      applySimulatorExperimentAction.bind(null, {
        kind: "localSampleSelected",
        shift: initial.run.shift,
        copyId: initial.scenario.copyId,
        notice: initial.scenario.notice,
      }),
    );
  }
  private selectScene(
    selection: Selection,
    focus: "inspector" | "unchanged",
  ): void {
    if (focus === "inspector") {
      this.select(selection);
      return;
    }
    this.setState(
      applySimulatorViewAction.bind(null, {
        kind: "selectTimeline",
        selection,
      }),
    );
  }
  private select(selection: Selection): void {
    const opening =
      this.state.view.dock !== "inspector" ||
      this.state.view.selection.kind !== selection.kind;
    this.setState(
      applySimulatorViewAction.bind(null, { kind: "select", selection }),
      opening ? this.focusInspector : undefined,
    );
    rememberDock("inspector");
  }
  private focusInspector(): void {
    document.getElementById("workflow-heading-Inspector")?.focus();
  }
  private chooseDemo(preset: DemoPreset): void {
    if (this.state.procedureLoad.kind === "loading") {
      return;
    }
    if (
      this.state.scenario.assumptionDraft.size > 0 &&
      !window.confirm("Discard unrun assumptions and start this demo?")
    ) {
      return;
    }
    const prevRun = this.state.run;
    const prevScenario = this.state.scenario;
    const demo = demoPreset(preset, this.state.run.layout);
    const nextAction = {
      kind: "demoSelected" as const,
      shift: {
        kind: "sample" as const,
        normal: demo.normal,
        outage: demo.outage,
      },
      variant: demo.variant,
      notice:
        "Demo ready. Select Play shift or a workflow step. Workspace records are unchanged.",
    };
    this.stopFrame();
    this.setState(applySimulatorExperimentAction.bind(null, nextAction));
    floorPlanWorkspace.recordHistory({
      label: `Load ${preset} demo`,
      undo: () => {
        if (!this.mounted) return;
        this.stopFrame();
        this.setState((prev) => ({
          ...prev,
          run: prevRun,
          scenario: prevScenario,
        }));
      },
      redo: () => {
        if (!this.mounted) return;
        this.stopFrame();
        this.setState(applySimulatorExperimentAction.bind(null, nextAction));
      },
    });
  }
  private changeAssumption(
    field: SettingsField,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    const prevDraft = new Map(this.state.scenario.assumptionDraft);
    const draft = new Map(this.state.scenario.assumptionDraft);
    const value = event.currentTarget.value;
    if (value === String(normalRun(this.state).settings[field])) {
      draft.delete(field);
    } else {
      draft.set(field, value);
    }
    this.setState(
      applySimulatorExperimentAction.bind(null, {
        kind: "assumptionDraftChanged",
        draft,
      }),
    );
    if (prevDraft.get(field) !== draft.get(field)) {
      const nextDraft = new Map(draft);
      floorPlanWorkspace.recordHistory({
        label: `Edit ${field} assumption`,
        coalesceKey: `assumption-draft:${field}`,
        coalesceWindowMs: 800,
        undo: () => {
          if (!this.mounted) return;
          this.setState(
            applySimulatorExperimentAction.bind(null, {
              kind: "assumptionDraftChanged",
              draft: new Map(prevDraft),
            }),
          );
        },
        redo: () => {
          if (!this.mounted) return;
          this.setState(
            applySimulatorExperimentAction.bind(null, {
              kind: "assumptionDraftChanged",
              draft: new Map(nextDraft),
            }),
          );
        },
      });
    }
  }
  private stageMeasuredSettings(settings: Settings): void {
    if (this.state.run.shift.kind !== "sample") return;
    const prevDraft = new Map(this.state.scenario.assumptionDraft);
    const current = normalRun(this.state).settings;
    const draft = new Map(this.state.scenario.assumptionDraft);
    for (const field of measuredSettingFields) {
      if (settings[field] === current[field]) draft.delete(field);
      else draft.set(field, String(settings[field]));
    }
    this.setState(
      applySimulatorExperimentAction.bind(null, {
        kind: "assumptionDraftChanged",
        draft,
      }),
    );
    const nextDraft = new Map(draft);
    floorPlanWorkspace.recordHistory({
      label: "Stage measured settings",
      undo: () => {
        if (!this.mounted) return;
        this.setState(
          applySimulatorExperimentAction.bind(null, {
            kind: "assumptionDraftChanged",
            draft: new Map(prevDraft),
          }),
        );
      },
      redo: () => {
        if (!this.mounted) return;
        this.setState(
          applySimulatorExperimentAction.bind(null, {
            kind: "assumptionDraftChanged",
            draft: new Map(nextDraft),
          }),
        );
      },
    });
  }
  private discardAssumptions(): void {
    const prevDraft = new Map(this.state.scenario.assumptionDraft);
    this.setState(
      applySimulatorExperimentAction.bind(null, {
        kind: "assumptionDraftDiscarded",
      }),
    );
    if (prevDraft.size > 0) {
      floorPlanWorkspace.recordHistory({
        label: "Discard assumption draft",
        undo: () => {
          if (!this.mounted) return;
          this.setState(
            applySimulatorExperimentAction.bind(null, {
              kind: "assumptionDraftChanged",
              draft: new Map(prevDraft),
            }),
          );
        },
        redo: () => {
          if (!this.mounted) return;
          this.setState(
            applySimulatorExperimentAction.bind(null, {
              kind: "assumptionDraftDiscarded",
            }),
          );
        },
      });
    }
  }
  private async applySurfaceEdit(): Promise<void> {
    const proposal = this.state.scenario.surfaceEditProposal;
    if (proposal === null) return;
    const result = await this.executeSurface({
      kind: "local",
      command: {
        schemaVersion: 1,
        kind: "apply_reviewed_edit",
        target: {
          surfaceSessionId: this.state.workspace.surfaceSessionId,
          surfaceEpoch: this.state.workspace.surfaceEpoch,
        },
        baseDraft: proposal.baseDraft,
        proposalDigest: proposal.proposalDigest,
      },
    });
    if (!this.mounted) return;
    if (result.kind === "rejected") {
      this.setState(
        applySimulatorWorkspaceAction.bind(null, {
          kind: "operationFailed",
          message: result.message,
        }),
      );
    }
  }
  private discardSurfaceEdit(): void {
    this.setState(
      applySimulatorExperimentAction.bind(null, {
        kind: "surfaceEditDiscarded",
      }),
    );
  }
  private undoSurfaceEdit(): void {
    this.setState(
      applySimulatorExperimentAction.bind(null, { kind: "surfaceEditUndone" }),
    );
  }
  private beforeUnload(event: BeforeUnloadEvent): void {
    if (this.state.scenario.assumptionDraft.size > 0) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  private runShift(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (this.state.procedureLoad.kind === "loading") {
      return;
    }
    const result = runShiftInputs(
      this.state,
      this.state.scenario.assumptionDraft,
    );
    if (result.kind === "invalid") {
      this.setState(
        applySimulatorExperimentAction.bind(null, {
          kind: "assumptionsInvalid",
          error: result,
        }),
        this.focusError,
      );
      return;
    }
    const prevRun = this.state.run;
    const prevScenario = this.state.scenario;
    const copyId = `scenario-${crypto.randomUUID()}`;
    const nextAction = {
      kind: "experimentApplied" as const,
      shift: result.shift,
      copyId,
      notice: SHIFT_RUN_NOTICE,
    };
    this.stopFrame();
    this.setState(applySimulatorExperimentAction.bind(null, nextAction));
    floorPlanWorkspace.recordHistory({
      label: "Run shift assumptions",
      undo: () => {
        if (!this.mounted) return;
        this.stopFrame();
        this.setState((prev) => ({
          ...prev,
          run: prevRun,
          scenario: prevScenario,
        }));
      },
      redo: () => {
        if (!this.mounted) return;
        this.stopFrame();
        this.setState(applySimulatorExperimentAction.bind(null, nextAction));
      },
    });
  }
  private focusError(): void {
    if (this.state.scenario.error) {
      this.openDock("inputs");
      const input = document.getElementById(
        `workflow-field-${this.state.scenario.error.field}`,
      );
      const details = input?.closest("details");
      if (details) {
        details.open = true;
      }
      requestAnimationFrame(focusElement.bind(null, input));
    }
  }
  private stopFrame(): void {
    this.playback.stop();
  }
  private togglePlay(): void {
    this.controlPlayback({
      kind: this.playback.snapshot().playback === "playing" ? "pause" : "play",
    });
  }
  private controlPlayback(action: BakeryPlaybackAction): void {
    this.setState(commitPlaybackAction.bind(null, action));
  }
  private visibility(): void {
    if (document.hidden) this.playback.pause();
  }
  /** The run whose events step the coarse playback time. */
  private playingRun(): Run | null {
    const workspace = this.state.workspace;
    if (workspace.kind !== "production") return activeRun(this.state);
    const data = workspace.production.data;
    return data.kind === "ready" ? data.run : null;
  }
  /** The bakery scene follows the live time of the shift replay. */
  private followTime(): void {
    if (this.state.replay.kind === "workflow")
      this.sceneController.update(this.sceneFrame());
  }
  private applyPlaybackUpdate(update: PlaybackUpdate): void {
    if (this.mounted) {
      this.setState(
        applySimulatorReplayAction.bind(null, {
          kind: "frameUpdated",
          time: update.time,
          playback: update.playback,
        }),
      );
    }
  }
  private goTo(time: number): void {
    this.controlPlayback({ kind: "seek", seconds: time });
  }
  private navigateRecording(navigation: RecordingNavigation): void {
    this.stopFrame();
    this.setState(
      applySimulatorReplayAction.bind(null, {
        kind: "recordingNavigated",
        navigation,
      }),
    );
  }
  private openRecording(): void {
    this.stopFrame();
    this.setState(openRecordingWorkspace);
  }
  private closeRecording(): void {
    this.stopBrowserPhysics();
    this.stopFrame();
    this.setState(closeRecordingWorkspace);
  }
  private workspace(action: BakeryWorkspaceAction): void {
    if (action.kind === "acceptRecording") {
      void this.acceptRecording(action.target);
      return;
    }
    if (
      action.kind === "openRehearsal" ||
      action.kind === "closeRehearsal" ||
      action.kind === "openProduction" ||
      action.kind === "closeProduction"
    )
      this.pausePlayback();
    if (
      action.kind === "closeRehearsal" ||
      action.kind === "openProduction" ||
      action.kind === "closeProduction"
    )
      this.stopBrowserPhysics();
    if (
      (action.kind === "productionSessionChanged" &&
        action.patch.data !== undefined) ||
      action.kind === "rehearsalEdited" ||
      (action.kind === "rehearsalReviewResolved" &&
        action.decision === "apply") ||
      (action.kind === "productionReplacementResolved" &&
        action.decision === "apply") ||
      action.kind === "productionPreviewApplied"
    )
      this.productionRunReplaced();
    this.setState(applyBakeryWorkspaceAction.bind(null, action));
  }
  private async acceptRecording(
    target: PreparedRecordingAcceptance,
  ): Promise<void> {
    try {
      const reference = await recordingAcceptanceReference(this.state, target);
      if (reference === null) return;
      const current = await resolveRecordingAcceptanceReference(
        this.state,
        reference,
      );
      if (
        current === null ||
        !this.mounted ||
        this.state.workspace.surfaceSessionId !== reference.surfaceSessionId ||
        this.state.workspace.surfaceEpoch !== reference.surfaceEpoch
      )
        return;
      this.pausePlayback();
      this.setState(
        applyBakeryWorkspaceAction.bind(null, {
          kind: "acceptRecording",
          target: { ...current, accepted: target.accepted },
        }),
      );
    } catch (error) {
      console.error("Unable to verify the recording candidate.", error);
    }
  }
  private recordingLoaded(
    recording: PhysicsReplay,
    completed?: () => void,
  ): void {
    if (this.state.replay.kind === "workflow") return;
    this.stopFrame();
    this.setState(
      applySimulatorReplayAction.bind(null, {
        kind: "recordingLoaded",
        recording,
      }),
      completed,
    );
  }
  private pausePlayback(): void {
    this.controlPlayback({ kind: "pause" });
  }
  private async rehearseRecording(
    recording: PhysicsReplay,
  ): Promise<string | null> {
    if (!canPrepareWorkcell(this.state))
      return "Finish or preserve the current run and its save outcome before preparing another rehearsal.";
    const result = await rehearsalFromRecording(
      rehearsalSettings(activeRun(this.state).settings),
      recording,
    );
    if (result.kind === "rejected") return result.message;
    if (!this.mounted) return null;
    this.pausePlayback();
    return new Promise(
      this.openRehearsedRecording.bind(this, recording, {
        plan: result.plan,
        notice:
          "Tray A opened from the recording with its result accepted. Clear its results to run it in browser MuJoCo.",
      }),
    );
  }
  private openRehearsedRecording(
    recording: PhysicsReplay,
    prepared: PreparedWorkcell,
    resolve: (message: string | null) => void,
  ): void {
    this.setState(
      rehearsedRecording.bind(null, recording, prepared),
      this.rehearsalOpened.bind(this, prepared, resolve),
    );
  }
  private rehearsalOpened(
    prepared: PreparedWorkcell,
    resolve: (message: string | null) => void,
  ): void {
    const workspace = this.state.workspace;
    resolve(
      workspace.kind === "production" &&
        workspace.production.data.kind === "ready" &&
        workspace.production.data.plan === prepared.plan
        ? null
        : "The open recording or run changed. Your rehearsal was not opened.",
    );
  }

  // Opening, applying or failing a production run replaces the one a browser
  // run was executing. Its late results are rejected by the commit check.
  private productionRunReplaced(): void {
    const running = this.browserProduction.running;
    if (running) {
      this.browserRunGeneration++;
      this.browserProduction.stop();
      this.browserPhysics.stop();
      this.finishSurfaceSimulation(
        this.simulationRejected(
          "stale_surface",
          "The run changed during execution.",
        ),
      );
    }
    if (
      this.mounted &&
      (running ||
        this.state.browserJob.kind !== "idle" ||
        this.state.workcellNotice !== "")
    )
      this.setState({
        browserJob: { kind: "idle" },
        workcellNotice: running
          ? "Browser simulation stopped because the production run changed. Run in browser executes the new requests."
          : "",
      });
  }
  private runProductionInBrowser(): void {
    const workspace = this.state.workspace;
    if (
      workspace.kind !== "production" ||
      workspace.production.data.kind !== "ready" ||
      workspace.production.pending.kind !== "none" ||
      workspace.production.rehearsalReview !== null ||
      workspace.production.replacement !== null ||
      workspace.production.reading
    )
      return;
    if (this.browserProduction.running || this.browserPhysics.running) return;
    const generation = ++this.browserRunGeneration;
    this.browserProduction.start(
      workspace.production.data.plan,
      this.state.run.layout,
      {
        commit: this.commitBrowserProductionRun.bind(this, generation),
        progress: this.browserProgress.bind(this, generation),
        finished: this.browserRunFinished.bind(this),
        failed: this.browserFailed.bind(this),
      },
    );
  }
  private async commitBrowserProductionRun(
    generation: number,
    previous: ProductionWorkcells,
    next: ProductionWorkcells,
    operationId: string,
  ): Promise<boolean> {
    if (!this.mounted || !(await this.verifySurfaceSimulationAccess()))
      return false;
    return new Promise(
      this.applyBrowserProductionRun.bind(
        this,
        generation,
        previous,
        next,
        operationId,
      ),
    );
  }
  private applyBrowserProductionRun(
    generation: number,
    previous: ProductionWorkcells,
    next: ProductionWorkcells,
    operationId: string,
    resolve: (accepted: boolean) => void,
  ): void {
    this.setState(
      this.updateBrowserProductionRun.bind(
        this,
        generation,
        previous,
        next,
        operationId,
      ),
      this.browserProductionCommitted.bind(this, next, resolve),
    );
  }
  private updateBrowserProductionRun(
    generation: number,
    previous: ProductionWorkcells,
    next: ProductionWorkcells,
    operationId: string,
    state: State,
  ): State {
    const job = state.browserJob;
    if (
      !this.mounted ||
      generation !== this.browserRunGeneration ||
      (job.kind !== "loading" && job.kind !== "running") ||
      job.generation !== generation ||
      job.operationId !== operationId ||
      !this.browserProduction.running
    )
      return state;
    return applyBakeryWorkspaceAction(
      { kind: "productionBrowserCommitted", previous, next, operationId },
      state,
    );
  }
  private browserProductionCommitted(
    next: ProductionWorkcells,
    resolve: (accepted: boolean) => void,
  ): void {
    resolve(
      this.mounted &&
        this.state.workspace.kind === "production" &&
        this.state.workspace.production.data.kind === "ready" &&
        this.state.workspace.production.data.plan === next,
    );
  }
  private browserRunFinished(message: string): void {
    if (this.mounted)
      this.setState({ browserJob: { kind: "idle" }, workcellNotice: message });
  }
  private finishSurfaceSimulation(result: BakerySurfaceCommandResultV1): void {
    const pending = this.surfaceSimulation;
    this.surfaceSimulation = null;
    pending?.resolve(result);
  }
  private browserProgress(
    generation: number,
    operationId: string,
    progress: JobProgress,
  ): void {
    const job = jobState(generation, operationId, progress);
    if (this.mounted)
      this.setState(this.updateBrowserProgress.bind(this, generation, job));
  }
  private updateBrowserProgress(
    generation: number,
    browserJob: State["browserJob"],
    state: State,
  ): State | null {
    return this.mounted && generation === this.browserRunGeneration
      ? { ...state, browserJob }
      : null;
  }
  private browserFailed(message: string): void {
    if (this.mounted)
      this.setState({ browserJob: { kind: "failed", message } });
    this.finishSurfaceSimulation(
      this.simulationRejected("simulation_failed", message),
    );
  }
  private stopBrowserPhysics(): void {
    this.browserRunGeneration++;
    const wasRunning =
      this.browserPhysics.running || this.browserProduction.running;
    this.browserProduction.stop();
    this.browserPhysics.stop();
    if (this.mounted)
      this.setState(applySimulatorBrowserStop.bind(null, wasRunning));
    this.finishSurfaceSimulation(
      this.simulationRejected(
        "stale_surface",
        "The browser simulation was stopped.",
      ),
    );
  }
  private seek(event: React.ChangeEvent<HTMLInputElement>): void {
    this.goTo(Number(event.currentTarget.value));
  }
  private restart(): void {
    this.controlPlayback({ kind: "restart" });
  }
  private nextEvent(): void {
    this.controlPlayback({ kind: "next_event" });
  }
  private chooseVariant(variant: ScheduleVariant): void {
    const prevVariant = this.state.run.variant;
    this.stopFrame();
    this.setState(
      applySimulatorReplayAction.bind(null, { kind: "chooseVariant", variant }),
    );
    if (prevVariant !== variant) {
      floorPlanWorkspace.recordHistory({
        label: `Switch to ${variant} shift`,
        undo: () => {
          if (!this.mounted) return;
          this.stopFrame();
          this.setState(
            applySimulatorReplayAction.bind(null, {
              kind: "chooseVariant",
              variant: prevVariant,
            }),
          );
        },
        redo: () => {
          if (!this.mounted) return;
          this.stopFrame();
          this.setState(
            applySimulatorReplayAction.bind(null, {
              kind: "chooseVariant",
              variant,
            }),
          );
        },
      });
    }
  }
  private chooseSpeed(speed: number): void {
    this.controlPlayback({ kind: "speed", speed });
  }
  private toggleCamera(): void {
    this.applyWorkspaceViewAction({
      kind: "setCamera",
      camera:
        this.state.view.camera === "overhead" ? "perspective" : "overhead",
    });
  }
  private resetCamera(): void {
    this.applyWorkspaceViewAction({ kind: "resetCamera" });
  }
  private setLabels(labels: SceneLabelMode): void {
    this.applyWorkspaceViewAction({ kind: "setLabels", labels });
  }
  private toggleMinimap(): void {
    this.applyWorkspaceViewAction({
      kind: "setMinimap",
      visible: !this.state.view.minimap,
    });
  }
  private toggleChrome(): void {
    this.applyWorkspaceViewAction({
      kind: "setChrome",
      chrome: this.state.view.chrome === "shown" ? "hidden" : "shown",
    });
  }
  private persistViewPreferences(): void {
    const owner = this.context;
    const document = owner?.document("kitchen");
    if (document?.area !== "kitchen" || owner === null) return;
    if (document.values.scene.labels !== this.state.view.labels)
      owner.edit({
        area: "kitchen",
        command: { kind: "set_scene_labels", labels: this.state.view.labels },
      });
    if (document.values.scene.minimap !== this.state.view.minimap)
      owner.edit({
        area: "kitchen",
        command: { kind: "set_minimap", visible: this.state.view.minimap },
      });
  }
  private syncViewPreferences(): void {
    const document = this.context?.document("kitchen");
    if (document?.area !== "kitchen") return;
    const scene = document.values.scene;
    if (
      scene.labels === this.state.view.labels &&
      scene.minimap === this.state.view.minimap
    )
      return;
    this.setState(
      applyPersonalScenePreferences.bind(null, scene.labels, scene.minimap),
    );
  }
  /** H hides the interface, L cycles label detail, and Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y undo and redo simulator edits. */
  private shortcut(event: KeyboardEvent): void {
    if (
      !event.defaultPrevented &&
      !event.altKey &&
      (event.metaKey || event.ctrlKey) &&
      undoRedoTarget(event.target)
    ) {
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        floorPlanWorkspace.undo();
        return;
      }
      if ((key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey)) {
        event.preventDefault();
        floorPlanWorkspace.redo();
        return;
      }
    }
    if (
      this.ovenVisible ||
      event.defaultPrevented ||
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      this.state.replay.kind !== "workflow" ||
      !shortcutTarget(event.target)
    )
      return;
    switch (event.key) {
      case "h":
      case "H":
        event.preventDefault();
        this.toggleChrome();
        return;
      case "l":
      case "L":
        event.preventDefault();
        this.setLabels(nextLabelMode(this.state.view.labels));
        return;
      default:
        return;
    }
  }
  render(): React.ReactNode {
    const proposal = this.state.workspace.scenarioSaveProposal;
    const canConfirmScenarioSave =
      this.props.connection.kind === "workspace" &&
      this.props.connection.canManage;
    return (
      <PlaybackTimeContext.Provider value={this.playback.time}>
        <WorkflowSimulatorShell
          robotRunner={this.browserPhysics}
          ref={this.shell}
          connection={this.props.connection}
          view={simulatorShellView(this.state)}
          host={this.host}
          layoutDetails={this.layoutDetails}
          form={this.form}
          cameraView={this.state.view}
          controlView={this.applyWorkspaceViewAction.bind(this)}
          prepareRunOpen={this.prepareRunOpen.bind(this)}
          actions={this.actions}
        />
        {proposal.kind !== "none" && (
          <section
            className="bakery-agent-scenario-save"
            role="dialog"
            aria-label="Review agent scenario save"
          >
            <p className="bakery-agent-scenario-save__eyebrow">
              Agent prepared copy
            </p>
            <h2>Review and save this scenario</h2>
            <p>
              <strong>{proposal.manifest.name}</strong> ·{" "}
              {proposal.manifest.kind === "scenario"
                ? "Shift scenario"
                : "Production scenario"}
            </p>
            <p>{proposal.payload.copy.note}</p>
            <dl>
              <dt>Copy ID</dt>
              <dd>{proposal.manifest.id}</dd>
              <dt>Source fingerprint</dt>
              <dd>
                <code>{proposal.manifest.sourceFingerprint}</code>
              </dd>
              <dt>Frozen payload</dt>
              <dd>
                {proposal.manifest.bytes} bytes ·{" "}
                <code>{proposal.manifest.digest}</code>
              </dd>
            </dl>
            {(proposal.kind === "outcome-unknown" ||
              proposal.kind === "saving" ||
              proposal.kind === "saved-readback-failed" ||
              proposal.kind === "failed-before-save" ||
              proposal.kind === "verified") && (
              <p role="status">{proposal.message}</p>
            )}
            {!canConfirmScenarioSave && (
              <p>Workspace admin access is required to confirm this save.</p>
            )}
            <div className="bakery-agent-scenario-save__actions">
              <button
                type="button"
                className="bakery-agent-scenario-save__confirm"
                disabled={
                  proposal.kind === "saving" ||
                  proposal.kind === "failed-before-save" ||
                  proposal.kind === "verified" ||
                  !canConfirmScenarioSave
                }
                onClick={this.confirmAgentScenarioSave}
              >
                {scenarioSaveButtonLabel(proposal.kind)}
              </button>
              <button
                type="button"
                disabled={
                  proposal.kind === "saving" ||
                  proposal.kind === "outcome-unknown" ||
                  proposal.kind === "saved-readback-failed"
                }
                onClick={this.dismissAgentScenarioSave}
              >
                Dismiss
              </button>
            </div>
          </section>
        )}
      </PlaybackTimeContext.Provider>
    );
  }

  private async confirmAgentScenarioSave(): Promise<void> {
    const proposal = this.state.workspace.scenarioSaveProposal;
    const connection = this.props.connection;
    if (
      proposal.kind === "none" ||
      proposal.kind === "saving" ||
      proposal.kind === "failed-before-save" ||
      proposal.kind === "verified" ||
      this.scenarioSaveInFlight !== null ||
      connection.kind !== "workspace" ||
      !connection.canManage
    )
      return;
    this.scenarioSaveInFlight = proposal.effectId;
    this.setState(
      applyBakeryWorkspaceAction.bind(null, {
        kind: "scenarioSaveStarted",
        effectId: proposal.effectId,
      }),
    );
    const origin = {
      kind: "agent_effect",
      effectId: proposal.effectId,
    } as const;
    let result;
    try {
      if (proposal.payload.kind === "scenario") {
        result = await savePreparedScenarioCopy(
          connection,
          proposal.payload.copy,
          origin,
        );
      } else {
        result = await savePreparedProductionScenario(
          connection.organisationId,
          connection.mutate,
          proposal.payload.copy,
          origin,
        );
      }
    } catch {
      this.scenarioSaveInFlight = null;
      if (this.mounted)
        this.setState(
          applyBakeryWorkspaceAction.bind(null, {
            kind: "scenarioSaveSettled",
            effectId: proposal.effectId,
            outcome: {
              kind: "outcome-unknown",
              message:
                "The save response was interrupted. Resume the same exact copy to reconcile it.",
            },
          }),
        );
      return;
    }
    this.scenarioSaveInFlight = null;
    if (!this.mounted) return;
    if (result.kind === "failed-before-save" && proposal.kind !== "prepared") {
      this.setState(
        applyBakeryWorkspaceAction.bind(null, {
          kind: "scenarioSaveSettled",
          effectId: proposal.effectId,
          outcome: {
            kind: proposal.kind,
            message: `${result.message} The earlier save still needs reconciliation; its original copy is retained.`,
          },
        }),
      );
      return;
    }
    if (result.kind === "verified") {
      this.setState(
        applyBakeryWorkspaceAction.bind(null, {
          kind: "scenarioSaveSettled",
          effectId: proposal.effectId,
          outcome: {
            kind: "verified",
            message: "The exact scenario copy was saved and verified.",
          },
        }),
      );
      const notice = `Saved and verified “${proposal.manifest.name}” as ${proposal.manifest.id}. Your current edits remain in the workspace.`;
      if (this.state.workspace.kind === "shift")
        this.setState(
          applySimulatorWorkspaceAction.bind(null, {
            kind: "noticeChanged",
            notice,
          }),
        );
      if (this.state.workspace.kind === "production")
        this.setState(
          applyBakeryWorkspaceAction.bind(null, {
            kind: "productionSessionChanged",
            patch: { notice },
          }),
        );
      return;
    }
    this.setState(
      applyBakeryWorkspaceAction.bind(null, {
        kind: "scenarioSaveSettled",
        effectId: proposal.effectId,
        outcome: { kind: result.kind, message: result.message },
      }),
    );
  }

  private dismissAgentScenarioSave(): void {
    const proposal = this.state.workspace.scenarioSaveProposal;
    if (
      proposal.kind !== "prepared" &&
      proposal.kind !== "failed-before-save" &&
      proposal.kind !== "verified"
    )
      return;
    this.setState(
      applyBakeryWorkspaceAction.bind(null, {
        kind: "scenarioSaveProposalCleared",
        effectId: proposal.effectId,
      }),
    );
  }

  private createViewActions(): WorkflowSimulatorActionGroups {
    return {
      shell: {
        toggleDock: this.toggleDock.bind(this),
        dockKeyDown: this.dockKeyDown.bind(this),
        resetView: this.resetView.bind(this),
        openDock: this.openDock.bind(this),
        openRecording: this.openRecording.bind(this),
        toggleChrome: this.toggleChrome.bind(this),
      },
      sceneView: {
        toggleCamera: this.toggleCamera,
        resetCamera: this.resetCamera.bind(this),
        setLabels: this.setLabels.bind(this),
        toggleMinimap: this.toggleMinimap,
      },
      workflowInput: {
        closeDock: this.closeDock.bind(this),
        observeOperation: this.observeOperation,
        chooseDemo: this.chooseDemo.bind(this),
        discardAssumptions: this.discardAssumptions,
        runShift: this.runShift,
        changeAssumption: this.changeAssumption.bind(this),
        stageMeasuredSettings: this.stageMeasuredSettings.bind(this),
      },
      surfaceEdit: {
        apply: this.applySurfaceEdit.bind(this),
        discard: this.discardSurfaceEdit.bind(this),
        undo: this.undoSurfaceEdit.bind(this),
      },
      scenario: {
        closeDock: this.closeDock.bind(this),
        createSample: this.createSample,
        loadProcedureId: this.loadProcedureId,
        loadScenarioId: this.loadScenarioId,
        saveScenario: this.saveScenario,
        changeCopyName: this.changeCopyName,
        changeCopyNote: this.changeCopyNote,
        useSample: this.useSample,
      },
      inspector: {
        closeDock: this.closeDock.bind(this),
        select: this.select,
        observeOperation: this.observeOperation,
        goTo: this.goTo.bind(this),
        inspectInterval: this.inspectInterval,
      },
      comparison: {
        closeDock: this.closeDock.bind(this),
        compareOutage: this.compareOutage.bind(this),
        chooseVariant: this.chooseVariant.bind(this),
        pinBaseline: this.pinBaseline,
        inspectInterval: this.inspectInterval,
      },
      playback: {
        togglePlay: this.togglePlay,
        nextEvent: this.nextEvent,
        restart: this.restart,
        changeSpeed: this.chooseSpeed.bind(this),
        toggleDock: this.toggleDock.bind(this),
        seek: this.seek,
        select: this.select,
        seekInterval: this.seekInterval,
        seekStation: this.seekStation.bind(this),
        inspectInterval: this.inspectInterval,
      },
      recording: {
        nextEvent: this.nextEvent,
        close: this.closeRecording.bind(this),
        pause: this.pausePlayback.bind(this),
        toggle: this.togglePlay,
        seek: this.goTo.bind(this),
        changeSpeed: this.chooseSpeed.bind(this),
        loaded: this.recordingLoaded.bind(this),
        navigate: this.navigateRecording.bind(this),
        rehearse: this.rehearseRecording.bind(this),
      },
      workspace: this.workspace.bind(this),
      browser: {
        runProductionInBrowser: this.runProductionInBrowser.bind(this),
        stopSimulation: this.stopBrowserPhysics.bind(this),
        persistentOvenVisible: this.persistentOvenVisible.bind(this),
      },
    };
  }
  private inspectInterval(interval: Interval): void {
    const selection = selectionForInterval(interval);
    const opening =
      this.state.view.dock !== "inspector" ||
      this.state.view.selection.kind !== selection.kind;
    this.stopFrame();
    this.setState(
      applySimulatorViewAction.bind(null, {
        kind: "navigate",
        selection,
        time: interval.start,
        focus: "inspector",
      }),
      opening ? this.focusInspector : undefined,
    );
    rememberDock("inspector");
  }
  private seekInterval(interval: Interval): void {
    this.stopFrame();
    this.setState(
      applySimulatorViewAction.bind(null, {
        kind: "navigate",
        selection: selectionForInterval(interval),
        time: interval.start,
        focus: "unchanged",
      }),
    );
  }
  private seekStation(station: StationId, time: number): void {
    this.stopFrame();
    this.setState(
      applySimulatorViewAction.bind(null, {
        kind: "navigate",
        selection: { kind: "station", id: station },
        time,
        focus: "unchanged",
      }),
    );
  }
}

function scenarioSaveButtonLabel(
  kind: State["workspace"]["scenarioSaveProposal"]["kind"],
): string {
  switch (kind) {
    case "none":
    case "prepared":
      return "Confirm save";
    case "saving":
      return "Saving…";
    case "outcome-unknown":
    case "saved-readback-failed":
      return "Resume exact save";
    case "failed-before-save":
      return "Save unavailable";
    case "verified":
      return "Saved and verified";
  }
}

function openRecordingWorkspace(state: State): State {
  return applyBakeryWorkspaceAction(
    { kind: "openRehearsal" },
    applySimulatorReplayAction({ kind: "openRecording" }, state),
  );
}

function closeRecordingWorkspace(state: State): State {
  return applyBakeryWorkspaceAction(
    { kind: "closeRehearsal" },
    applySimulatorReplayAction({ kind: "closeRecording" }, state),
  );
}

function applyPersonalScenePreferences(
  labels: SceneLabelMode,
  minimap: boolean,
  state: State,
): State {
  const labelled = applySimulatorViewAction(
    { kind: "setLabels", labels },
    state,
  );
  return applySimulatorViewAction(
    { kind: "setMinimap", visible: minimap },
    labelled,
  );
}
