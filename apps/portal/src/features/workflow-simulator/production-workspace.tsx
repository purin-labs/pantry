import { jobStepLabel } from "../production-run/job-progress";
import type { ScheduleSpatialLayout } from "@purin-labs/production-simulation/recipes/bakery/schedule";
import * as Views from "./workspace-views";
import { Select } from "@purin-labs/ui/select";
import { EspressoRecipeAuthor } from "../production-run/linea/espresso-recipe-author";
import { BakeryAppearanceControl } from "@purin-labs/ui/preferences/appearance-controls";
import { SimulatorHistoryControls } from "./docks/history-controls";
import { LocateFixed, Map as MapIcon } from "lucide-react";
import { SegmentedControl } from "./docks/shared";
import { PRODUCTION_SCENARIO_PICKER, ScenarioPicker } from "./scenario-picker";
import { FinancierBakeRecipeAuthor } from "../production-run/financier-bake/financier-bake-recipe-author";
import {
  buildFinancierHandoffRecovery,
  type FinancierBakeOutcome,
  type FinancierBakeRecipeConfig,
  type FinancierHandoffRecoveryPreset,
} from "@purin-labs/production-simulation/recipes/financier-bake/model";
import { FinancierBatterRecipeAuthor } from "../production-run/financier-batter/financier-batter-recipe-author";
import type {
  FinancierBatterOutcome,
  FinancierBatterRecipeConfig,
} from "@purin-labs/production-simulation/recipes/financier-batter/model";
import { FinancierPackRecipeAuthor } from "../production-run/financier-pack/financier-pack-recipe-author";
import type {
  FinancierPackOutcome,
  FinancierPackRecipeConfig,
} from "@purin-labs/production-simulation/recipes/financier-pack/model";
import { CafeShiftRecipeAuthor } from "../production-run/cafe-shift/cafe-shift-recipe-author";
import type {
  CafeShiftOutcome,
  CafeShiftRecipeConfig,
} from "@purin-labs/production-simulation/recipes/cafe-shift/model";
import { BakeryShiftAuthor } from "../production-run/bakery-shift-author";
import { ColdCellRouteAuthor } from "../production-run/cold-cell-route-author";
import { BlackSesameRecipeAuthor } from "../production-run/black-sesame-recipe-author";
import { BlackSesameCobotRecipeAuthor } from "../production-run/black-sesame/black-sesame-cobot-recipe-author";
import type { BlackSesameCobotRecipeConfig } from "@purin-labs/production-simulation/recipes/black-sesame/model";
import { GingerTeaRecipeAuthor } from "../production-run/ginger-tea-recipe-author";
import { GingerMilkTeaRecipeAuthor } from "../production-run/ginger-milk-tea-recipe-author";
import { GingerTeaCobotRecipeAuthor } from "../production-run/ginger-tea/ginger-tea-cobot-recipe-author";
import type { GingerTeaCobotRecipeConfig } from "@purin-labs/production-simulation/recipes/ginger-tea/model";
import { LatteRecipeAuthor } from "../production-run/latte/latte-recipe-author";
import type { LatteRecipeConfig } from "@purin-labs/production-simulation/recipes/latte/model";
import { PourOverRecipeAuthor } from "../production-run/pour-over/pour-over-recipe-author";
import { PastryBenchRecipeAuthor } from "../production-run/pastry-bench/pastry-bench-recipe-author";
import type { PastryBenchRecipeConfig } from "../production-run/pastry-bench/pastry-bench-model";
import { CompleteRecipeTaskCatalog } from "./complete-recipe-task-catalog";
import {
  batchWorkerFlow,
  calibratedHandoffAssignments,
  compactNativeTrayStatus,
  compactStationWait,
  shortProcessTitle,
  shortStationName,
  stationWaitForStep,
  type BatchWaitSummary,
} from "./production-workspace-helpers";
import { SiphonRecipeAuthor } from "../production-run/siphon/siphon-recipe-author";
import type { SiphonRecipeConfig } from "@purin-labs/production-simulation/recipes/siphon/model";
import { readOvenRunFile } from "../production-run/oven-recipe-file";
import { ROBOTS } from "@purin-labs/bakery-model/bakery-robots";
import {
  HUMAN_CELL_TRANSFER,
  supportsHumanCellTransfer,
} from "@purin-labs/production-simulation/recipes/bakery/human-cell-transfer";
import { downloadBakeryFile } from "./file-download";
import {
  FactoryComparison,
  type FactoryResult,
} from "../production-run/factory-comparison";
import {
  RecipeWorkspaceContext,
  type RecipeWorkspace,
} from "../production-run/recipe-workspace";
import { OvenRouteAuthor } from "../production-run/oven-route-author";
import {
  prepareOvenDefinition,
  type OvenRunSource,
} from "@purin-labs/production-simulation/runs/oven-run-file";
import {
  prepareProductionFile,
  exportProductionFile,
  type BakeryExportKind,
} from "./production-files";
import { type WorkspaceRunReview } from "./workspace-run-review";
import type { BakeryWorkspaceViewAction } from "@purin-labs/bakery-model/bakery-surface";
import type { WorkspaceCameraView } from "./simulator-state";
import { prepareProductionNavigation } from "./production-navigation";
import {
  defaultAssignments,
  financierSettings,
  prepareProductionReplacement,
  acceptedProductionResults,
} from "./production-draft";
import type { BakeryProductionReplacementSource } from "@purin-labs/bakery-model/bakery-surface";
import { prepareRehearsalReview } from "./rehearsal-edits";
import type { BakeryRehearsalChange } from "@purin-labs/bakery-model/bakery-surface";
import React from "react";
import {
  PlaybackScrubber,
  PlaybackTimeContext,
  PlaybackTimeText,
  secondsText,
} from "./playback-cursor";
import {
  productionMaterialAt,
  type ProductionMaterialState,
} from "@purin-labs/production-simulation/recipes/bakery/production-material";
import type { Settings } from "@purin-labs/bakery-model/bakery";
import {
  bakeryFingerprint,
  fields,
  parseSettings,
} from "@purin-labs/bakery-model/bakery";
import type { CompiledProcedure } from "@purin-labs/bakery-model/bakery-procedure";
import {
  parseProductionScenario,
  productionAssignmentId,
  productionDefinitionFingerprint,
  productionTaskChoices,
  type ProductionTaskChoice,
  type ProductionManualTask,
  type ProductionAssignment,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import {
  parsePhysicsReplay,
  parseIngredientLoad,
  type PhysicsReplay,
} from "@purin-labs/bakery-model/bakery-physics";
import {
  attachProductionScenario,
  type PlannedProductionWorkcell,
  type ProductionWorkcells,
  type ProductionWorkcell,
  type RehearsalEdit,
} from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import {
  prepareRehearsalEdit,
  trayChainEdit,
  type PreparedRehearsalEdit,
} from "./rehearsal-edits";
import {
  appliedRunPatch,
  compileProductionDraft,
  editProductionDraft,
  newDraftIdentity,
  prepareProductionPreview,
  type ProductionDraftEdit,
} from "./production-draft";
import {
  describe,
  humanResource,
  taskAt,
  metrics,
  clock,
  workName,
  type Run,
  type Interval,
  type NativeBakeryTask,
  type Batch,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { SceneController } from "./scene-controller";
import type { RecordingReplayActions } from "./simulator-actions";
import {
  TimelineTrack,
  WorkerTimelineTrack,
  NativeTimelineTrack,
} from "./timeline";
import {
  selectionForInterval,
  selectionContext,
  type Selection,
} from "@purin-labs/production-simulation/simulator/selection";
import { MAX_EXPERIMENT_BYTES } from "@purin-labs/production-simulation/recipes/bakery/workcell-experiment";
import "./production-workspace.css";
import type {
  AgentRunSaveProposal,
  BakeryWorkspaceAction,
  SimulatorConnection,
  SimulatorState,
  WorkspaceRunSaveStatus,
} from "./simulator-state";
import { nextProductionExecution } from "@purin-labs/production-simulation/simulator/production-execution";
import type {
  FinancierPreset,
  ProductionDraftIdentity as DraftIdentity,
  ProductionPending as Pending,
  ProductionReady as Ready,
  ProductionSession as State,
} from "./production-session";
import { saveProductionScenario } from "./production-scenario-api";
import { readProductionScenario } from "./production-scenario-api";
import { WorkspaceRunsPanel } from "./workspace-runs-panel";
import { openPersistentWorkspaceRun } from "./shared-production-run";
import { controlRead } from "@purin-labs/control/portal/control-client";
import { RecordingCandidatePreview } from "./recording-candidate-preview";
import {
  handlingChoice,
  outageChoice,
  wholeSeconds,
} from "./production-fault-inputs";
import { readExample } from "./rehearsal-examples";
import {
  acceptProductionCandidate,
  layoutTray,
  readyProduction,
  rehearsalSessionPatch,
  selectedTray,
  stepName,
} from "./scheduled-rehearsal";
import {
  coldCell,
  parseCellId,
  resourceInstance,
} from "@purin-labs/production-simulation/recipes/bakery/workcell-instances";
import { RackLayoutEditor } from "./rack-layout-editor";
import {
  ANY_BAKER,
  AUTHOR_ROUTES,
  COLD_CELLS,
  FINANCIER_PRESETS,
  HANDOFF_PRESETS,
  KEEP_HOLDS,
  NO_FAILURE,
  NO_OUTAGE,
  OVEN_VARIANTS,
  PRESET_CHOICES,
  RACK_CASES,
  renderItem,
  workerChoices,
  type SelectChoice,
} from "./production-workspace-choices";
import {
  evaluateRackLayout,
  prepareRackLayout,
  rackPlacementFit,
  type RackLayoutProposal,
} from "./rack-layout";
import {
  REHEARSAL_PRESETS,
  presetName,
  rehearsalPreset,
  rehearsalSettings,
  type ReadExample,
  type RehearsalPreset,
} from "@purin-labs/production-simulation/simulator/rehearsal-presets";
import {
  NO_FAULTS,
  OUTAGE_WORKCELL_RESOURCES,
  handlingTaskId,
  outageResourceName,
  type OutageResource,
  type RunFaults,
} from "@purin-labs/production-simulation/recipes/bakery/run-faults";
import {
  compareRuns,
  duration,
  summarizeRun,
  type RunSummary,
} from "@purin-labs/production-simulation/simulator/run-comparison";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, errorMessage } from "@purin-labs/std";

type Props = Readonly<{
  cameraView: WorkspaceCameraView;
  controlView(action: BakeryWorkspaceViewAction): void;
  prepareRunOpen(id: string): Promise<void>;
  settings: Settings;
  procedure: CompiledProcedure | null;
  // The floor layout of the open run and of each run that it recomputes.
  layout: ScheduleSpatialLayout | null;
  connection: SimulatorConnection;
  saveStatus: WorkspaceRunSaveStatus;
  persistentSaveStatus: WorkspaceRunSaveStatus;
  saveChanged(
    action: Variant<
      BakeryWorkspaceAction,
      | "workspaceRunSaveStarted"
      | "workspaceRunSaveSettled"
      | "workspaceRunSaveRecovered"
      | "workspaceRunSaveMissing"
      | "workspaceRunSaveAbandoned"
      | "workspaceRunSaveProposalCleared"
    >,
  ): void;
  // An agent-prepared rehearsal save awaiting operator confirmation.
  runSaveProposal: AgentRunSaveProposal | null;
  session: State;
  playback: RecordingReplayActions;
  changed(patch: Partial<State>): void;
  // Commits a prepared tray edit to the plan it was prepared from.
  rehearsalEdited(edit: PreparedRehearsalEdit): void;
  // Financier authoring: a draft edit, a compiled preview, applying it.
  authored(
    action: Variant<
      BakeryWorkspaceAction,
      | "acceptRecording"
      | "rehearsalReviewPrepared"
      | "rehearsalReviewResolved"
      | "productionReplacementPrepared"
      | "productionReplacementResolved"
      | "productionNavigated"
      | "productionPanelShown"
      | "productionCandidateDiscarded"
      | "productionBaselineChanged"
      | "productionDraftEdited"
      | "productionPreviewed"
      | "productionPreviewApplied"
      | "workspaceRunOpenPrepared"
      | "workspaceRunOpenResolved"
    >,
  ): void;
  browserJob: SimulatorState["browserJob"];
  browserNotice: string;
  runInBrowser(): void;
  stopSimulation(): void;
  persistentOvenVisible(visible: boolean): void;
  close(): void;
  initialCatalogSection?: CatalogSection | null;
  openFinancierMorning?: () => void;
  returnToCatalog?: () => void;
}>;

export type CatalogSection =
  | "active-production"
  | "rehearsal-production"
  | "cafe-shift"
  | "siphon"
  | "espresso"
  | "latte"
  | "black-sesame"
  | "ginger-tea"
  | "financier-batter"
  | "financier-bake"
  | "financier-pack"
  | "pastry-bench"
  | "pour-over"
  | "appliance-rehearsals"
  | "shared-runs";

type MenuSnapshot = Readonly<{
  panel: "workflow" | "author" | "details" | "files";
  catalogOpen: boolean;
  catalogSection: CatalogSection | null;
  activeBatchId: string | null;
  authorRoute: "cold-racking" | "oven-rack";
}>;

type RehearsalAuthoring = Readonly<{
  comparisons: readonly FactoryResult[];
  rackCase: "nominal" | "slip";
  preset: RehearsalPreset;
  oven: OvenRunSource | null;
  siphon: SiphonRecipeConfig | null;
  latte: LatteRecipeConfig | null;
  blackSesame: BlackSesameCobotRecipeConfig | null;
  gingerTea: GingerTeaCobotRecipeConfig | null;
  financierBatter: FinancierBatterRecipeConfig | null;
  financierBake: FinancierBakeRecipeConfig | null;
  financierPack: FinancierPackRecipeConfig | null;
  pastryBench: PastryBenchRecipeConfig | null;
  cafeShift: CafeShiftRecipeConfig | null;
  calibratedBatter: Variant<FinancierBatterOutcome, "completed"> | null;
  calibratedBake: Variant<FinancierBakeOutcome, "completed"> | null;
  calibratedPack: Variant<FinancierPackOutcome, "completed"> | null;
  handoffRecoveryPreset: FinancierHandoffRecoveryPreset;
  authorRoute: "cold-racking" | "oven-rack";
  timelineOpen: boolean;
  catalogOpen: boolean;
  catalogSection: CatalogSection | null;
  activeBatchId: string | null;
  panelHidden: boolean;
  panelWidth: number | null;
  panelHeight: number | null;
  menuHistory: readonly MenuSnapshot[];
  transitionDirection: "forward" | "back";
}>;

export class ProductionWorkspace extends React.Component<
  Props,
  RehearsalAuthoring
> {
  state: RehearsalAuthoring = {
    comparisons: [],
    rackCase: "nominal",
    preset: "two-trays",
    oven: null,
    siphon: null,
    latte: null,
    blackSesame: null,
    gingerTea: null,
    financierBatter: null,
    financierBake: null,
    financierPack: null,
    pastryBench: null,
    cafeShift: null,
    calibratedBatter: null,
    calibratedBake: null,
    calibratedPack: null,
    handoffRecoveryPreset: "nominal-handoff",
    authorRoute: "cold-racking",
    timelineOpen: false,
    catalogOpen: false,
    catalogSection: this.props.initialCatalogSection ?? "active-production",
    activeBatchId: null,
    panelHidden: false,
    panelWidth: null,
    panelHeight: null,
    menuHistory: [],
    transitionDirection: "forward",
  };
  private readonly host = React.createRef<HTMLDivElement>();
  private readonly panelBox = React.createRef<HTMLDivElement>();
  private readonly heading = React.createRef<HTMLHeadingElement>();
  private readonly recordingHeading = React.createRef<HTMLHeadingElement>();
  private readonly runReviewHeading = React.createRef<HTMLHeadingElement>();
  private readonly fileInput = React.createRef<HTMLInputElement>();
  private readonly scene = new SceneController();
  private mounted = false;
  static contextType = PlaybackTimeContext;
  declare context: React.ContextType<typeof PlaybackTimeContext>;
  private unsubscribeTime: (() => void) | null = null;
  private sceneMounted = false;
  private generation = 0;
  private restoringMenu = false;

  componentDidMount(): void {
    this.mounted = true;
    this.heading.current?.focus();
    // The scene follows the live playback time, outside React state.
    this.unsubscribeTime = this.context.subscribe(this.updateScene.bind(this));
    this.updateScene();
    if (this.props.session.data.kind === "loading")
      void (this.props.session.procedure === "rehearsal"
        ? this.prepareRehearsal("two-trays")
        : this.prepare());
  }
  componentDidUpdate(previous: Props): void {
    if (
      this.props.initialCatalogSection !== undefined &&
      this.props.initialCatalogSection !== previous.initialCatalogSection
    ) {
      this.setState({
        catalogOpen: false,
        catalogSection: this.props.initialCatalogSection ?? "active-production",
        activeBatchId: null,
        panelHidden: false,
        menuHistory: [],
        transitionDirection: "forward",
      });
    }
    // An agent-prepared save opens Files so the operator can review it.
    if (
      this.props.runSaveProposal !== null &&
      previous.runSaveProposal?.effectId !==
        this.props.runSaveProposal.effectId &&
      this.props.session.panel !== "files"
    )
      this.selectPanel("files");
    if (previous.session.panel !== this.props.session.panel) {
      if (this.props.session.panel === "timeline") {
        this.setState({ timelineOpen: true });
      } else if (this.restoringMenu) {
        this.restoringMenu = false;
      } else {
        const previousPanel =
          previous.session.panel === "timeline"
            ? "workflow"
            : previous.session.panel;
        const nextPanel = this.activePanel();
        if (previousPanel !== nextPanel) {
          this.setState({
            menuHistory: [
              ...this.state.menuHistory,
              this.currentMenuSnapshot(previousPanel),
            ],
            catalogOpen: false,
            panelHidden: false,
            transitionDirection: "forward",
          });
        } else {
          this.setState({ catalogOpen: false, panelHidden: false });
        }
      }
    }
    if (
      previous.session.pending !== this.props.session.pending &&
      this.props.session.pending.kind === "recording"
    )
      this.recordingHeading.current?.focus();
    if (
      previous.session.pending !== this.props.session.pending &&
      this.props.session.pending.kind === "run"
    )
      this.runReviewHeading.current?.focus();
    this.updateScene();
    if (
      previous.cameraView.cameraResetRevision !==
      this.props.cameraView.cameraResetRevision
    )
      this.scene.resetView();
  }
  private activePanel(): "workflow" | "author" | "details" | "files" {
    return this.props.session.panel === "timeline"
      ? "workflow"
      : this.props.session.panel;
  }
  private currentMenuSnapshot(
    panel: "workflow" | "author" | "details" | "files" = this.activePanel(),
  ): MenuSnapshot {
    return {
      panel,
      catalogOpen: this.state.catalogOpen,
      catalogSection: this.state.catalogSection,
      activeBatchId: this.state.activeBatchId,
      authorRoute: this.state.authorRoute,
    };
  }
  private selectPanel(panel: State["panel"]): void {
    const targetPanel = panel === "timeline" ? "workflow" : panel;
    const currentPanel = this.activePanel();
    if (targetPanel === "workflow" && currentPanel === "workflow") {
      this.setState({
        catalogOpen: false,
        catalogSection: null,
        activeBatchId: null,
        panelHidden: false,
        menuHistory: [],
        transitionDirection: "back",
      });
      this.panel(panel);
      return;
    }
    this.setState({
      catalogOpen: false,
      catalogSection: null,
      activeBatchId: null,
      panelHidden: false,
      transitionDirection: "forward",
    });
    this.panel(panel);
  }
  private goBack(): void {
    const history = this.state.menuHistory;
    if (history.length === 0 && this.props.returnToCatalog !== undefined) {
      this.props.returnToCatalog();
      return;
    }
    const target: MenuSnapshot =
      history.length > 0
        ? history[history.length - 1]!
        : {
            panel: "workflow",
            catalogOpen: false,
            catalogSection: null,
            activeBatchId: null,
            authorRoute: "cold-racking",
          };
    const nextHistory = history.slice(0, -1);
    const currentPanel = this.activePanel();
    this.setState({
      menuHistory: nextHistory,
      catalogOpen: target.catalogOpen,
      catalogSection: target.catalogSection,
      activeBatchId: target.activeBatchId,
      authorRoute: target.authorRoute,
      panelHidden: false,
      transitionDirection: "back",
    });
    if (target.panel !== currentPanel) {
      this.restoringMenu = true;
      this.panel(target.panel);
    }
  }
  private toggleTimeline(): void {
    const timelineOpen = !(
      this.state.timelineOpen || this.props.session.panel === "timeline"
    );
    this.setState({ timelineOpen });
    if (!timelineOpen && this.props.session.panel === "timeline")
      this.panel("workflow");
  }
  private openCatalogSection(catalogSection: CatalogSection): void {
    this.setState({
      menuHistory: [...this.state.menuHistory, this.currentMenuSnapshot()],
      catalogOpen: false,
      catalogSection,
      activeBatchId: null,
      panelHidden: false,
      transitionDirection: "forward",
    });
  }
  private openBatch(activeBatchId: string): void {
    this.setState({
      menuHistory: [...this.state.menuHistory, this.currentMenuSnapshot()],
      catalogOpen: false,
      catalogSection: "active-production",
      activeBatchId,
      transitionDirection: "forward",
    });
  }
  private startPanelResize(
    axis: "x" | "y" | "xy",
    event: React.PointerEvent<HTMLDivElement>,
  ): void {
    if (event.button !== 0) return;
    const panelEl = this.panelBox.current;
    if (panelEl === null) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = panelEl.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Synthetic pointer events may not support capture.
    }
    const onMove = (moveEvent: PointerEvent): void => {
      const nextWidth =
        axis === "x" || axis === "xy"
          ? Math.max(
              340,
              Math.min(
                window.innerWidth - 24,
                Math.round(startWidth + (moveEvent.clientX - startX)),
              ),
            )
          : this.state.panelWidth;
      const nextHeight =
        axis === "y" || axis === "xy"
          ? Math.max(
              220,
              Math.min(
                window.innerHeight - 130,
                Math.round(startHeight + (moveEvent.clientY - startY)),
              ),
            )
          : this.state.panelHeight;
      this.setState({ panelWidth: nextWidth, panelHeight: nextHeight });
    };
    const onEnd = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }
  private resetPanelSize(): void {
    this.setState({ panelWidth: null, panelHeight: null });
  }
  private toggleCamera(): void {
    this.props.controlView({
      kind: "setCamera",
      camera:
        this.props.cameraView.camera === "overhead"
          ? "perspective"
          : "overhead",
    });
  }
  private resetCamera(): void {
    this.props.controlView({ kind: "resetCamera" });
  }
  private updateScene(): void {
    if (this.props.session.data.kind !== "ready" || this.host.current === null)
      return;
    const frame = {
      run: this.props.session.data.run,
      time: this.context.get(),
      selection: this.props.session.selection,
      top: this.props.cameraView.camera === "overhead",
    };
    if (!this.sceneMounted) {
      this.sceneMounted = true;
      this.scene.mount(
        this.host.current,
        frame,
        this.select.bind(this),
        this.sceneStatus.bind(this),
      );
    } else this.scene.update(frame);
  }
  componentWillUnmount(): void {
    this.mounted = false;
    this.generation++;
    this.unsubscribeTime?.();
    this.scene.dispose();
    this.props.persistentOvenVisible(false);
  }
  private update(patch: Partial<State>): void {
    this.props.changed(patch);
  }
  private sceneStatus(scene: "ready" | "unavailable"): void {
    if (this.mounted) this.update({ scene });
  }
  private select(selection: Selection): void {
    const data = this.props.session.data;
    if (data.kind !== "ready") return;
    this.props.authored({
      kind: "productionNavigated",
      navigation: {
        from: data,
        time: this.context.get(),
        target: { kind: "selection", selection },
      },
    });
  }
  private inspect(interval: Interval): void {
    const data = this.props.session.data;
    if (data.kind !== "ready") return;
    this.props.authored({
      kind: "productionNavigated",
      navigation: {
        from: data,
        time: interval.start,
        target: {
          kind: "selection",
          selection: selectionForInterval(interval),
        },
      },
    });
  }
  private seek(time: number): void {
    this.props.playback.seek(time);
  }
  private scrub(event: React.ChangeEvent<HTMLInputElement>): void {
    this.seek(Number(event.currentTarget.value));
  }
  private panel(panel: State["panel"]): void {
    const from = this.props.session.data;
    if (from.kind === "ready")
      this.props.authored({ kind: "productionPanelShown", from, panel });
  }
  private operation(value: string | null): void {
    if (value !== null) this.inspectRequest(value);
  }
  private async prepare(
    preset: FinancierPreset = this.props.session.financierPreset,
  ): Promise<void> {
    let settings: Settings;
    try {
      settings = financierSettings(this.props.settings, preset);
    } catch (error) {
      this.update({ notice: message(error) });
      return;
    }
    await this.prepareDefinition(
      settings,
      defaultAssignments(settings),
      preset === "one-batch"
        ? "Financier + robot prepared: one batch of one tray on applied production timings. Its tray awaits a native result."
        : undefined,
    );
  }
  private chooseFinancierPreset(value: string | null): void {
    if (value === "procedure" || value === "one-batch")
      this.update({ financierPreset: value });
  }
  private startFinancierPreset(): void {
    void this.reviewProductionReplacement(this.props.session.financierPreset);
  }
  private async prepareDefinition(
    settings: Settings,
    draft: readonly ProductionAssignment[],
    notice = "Production prepared. Each assigned tray awaits its own native result; export a request from Files.",
  ): Promise<void> {
    const generation = ++this.generation;
    try {
      const procedure =
        this.props.session.sourceProcedure ?? this.props.procedure;
      const plan = await compileProductionDraft(
        settings,
        draft,
        "normal",
        null,
        this.props.session.manualTasks,
        procedure === null
          ? null
          : await bakeryFingerprint(procedure.revisionKey),
      );
      if (!this.mounted || generation !== this.generation) return;
      this.apply(plan, notice);
    } catch (error) {
      if (!this.mounted || generation !== this.generation) return;
      this.update({ data: { kind: "failed" }, notice: message(error) });
    }
  }
  // Chat makes the same edits; the workspace applies them.
  private editDraft(edit: ProductionDraftEdit): void {
    if (editProductionDraft(this.props.session, edit).kind === "ready")
      this.generation++;
    this.props.authored({ kind: "productionDraftEdited", edit });
  }
  private toggleAssignment(
    batchId: string,
    tray: number,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    this.editDraft({
      kind: event.currentTarget.checked ? "assign" : "unassign",
      batchId,
      tray,
    });
  }
  private changeWorker(id: string, value: string | null): void {
    if (value === null) return;
    this.editDraft({ kind: "worker", id, workerId: `human-${Number(value)}` });
  }
  private togglePredecessor(
    id: string,
    predecessorId: string,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    const assignment = this.props.session.draft.find(
      matchesDraftAssignment.bind(null, id),
    );
    if (assignment === undefined) return;
    const dependsOn = new Set(assignment.dependsOn);
    if (event.currentTarget.checked) dependsOn.add(predecessorId);
    else dependsOn.delete(predecessorId);
    this.editDraft({
      kind: "prerequisites",
      id,
      dependsOn: [...dependsOn],
    });
  }
  private predecessorChoice(
    id: string,
    assignment: ProductionAssignment,
    predecessor: ProductionTaskChoice,
  ): React.ReactNode {
    const predecessorId = predecessor.id;
    return (
      <label key={predecessorId}>
        <input
          type="checkbox"
          checked={assignment.dependsOn.includes(predecessorId)}
          onChange={this.togglePredecessor.bind(this, id, predecessorId)}
        />
        {predecessor.label}
      </label>
    );
  }
  private changeEarliestStart(
    id: string,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    this.editDraft({
      kind: "start",
      id,
      earliestStartSeconds: Number(event.currentTarget.value),
    });
  }
  private changeVariant(value: string | null): void {
    if (value === null) return;
    this.editDraft({
      kind: "variant",
      variant: value === "outage" ? "outage" : "normal",
    });
  }
  private changeName(event: React.ChangeEvent<HTMLInputElement>): void {
    this.editDraft({ kind: "name", name: event.currentTarget.value });
  }
  private changeNote(event: React.ChangeEvent<HTMLTextAreaElement>): void {
    this.editDraft({ kind: "note", note: event.currentTarget.value });
  }
  private moveNode(
    id: string,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void {
    const step = event.shiftKey ? 50 : 10;
    let x = 0;
    let y = 0;
    switch (event.key) {
      case "ArrowLeft":
        x = -step;
        break;
      case "ArrowRight":
        x = step;
        break;
      case "ArrowUp":
        y = -step;
        break;
      case "ArrowDown":
        y = step;
        break;
      default:
        return;
    }
    const point = this.props.session.presentation[id];
    if (point === undefined) return;
    event.preventDefault();
    this.editDraft({
      kind: "position",
      id,
      x: point.x + x,
      y: point.y + y,
    });
  }
  private applyDraft(): void {
    const preview = this.props.session.preview;
    if (preview === null) return;
    if (
      this.props.session.data.kind === "ready" &&
      acceptedProductionResults(this.props.session.data.plan) > 0
    ) {
      void this.reviewProductionReplacement("preview");
      return;
    }
    this.generation++;
    this.props.authored({ kind: "productionPreviewApplied", preview });
  }
  private async reviewProductionReplacement(
    source: BakeryProductionReplacementSource,
  ): Promise<void> {
    const generation = ++this.generation;
    const result = await prepareProductionReplacement(
      this.props.session,
      source,
      this.props.settings,
      this.props.session.sourceProcedure ?? this.props.procedure,
      this.props.layout,
    );
    if (!this.mounted || generation !== this.generation) return;
    if (result.kind === "rejected") this.update({ notice: result.message });
    else
      this.props.authored({
        kind: "productionReplacementPrepared",
        review: result.review,
      });
  }
  private resolveProductionReplacement(decision: "apply" | "discard"): void {
    const review = this.props.session.replacement;
    if (review !== null)
      this.props.authored({
        kind: "productionReplacementResolved",
        review,
        decision,
      });
  }
  private productionReplacementReview(): React.ReactNode {
    const review = this.props.session.replacement;
    if (review === null) return null;
    return (
      <section
        className="workcell-save-review"
        aria-label="Review production replacement"
      >
        <h4>Review production replacement</h4>
        <p>
          {productionReplacementLabel(review.summary.source)} as a fresh run.
        </p>
        <p>
          This replaces {review.summary.currentResults} accepted results with{" "}
          {review.summary.proposedOperations} new native requests. Saved runs
          are kept.
        </p>
        <button
          type="button"
          onClick={this.resolveProductionReplacement.bind(this, "apply")}
        >
          Confirm production replacement
        </button>
        <button
          type="button"
          onClick={this.resolveProductionReplacement.bind(this, "discard")}
        >
          Discard production replacement
        </button>
      </section>
    );
  }
  private discardDraft(): void {
    this.editDraft({ kind: "discard" });
  }
  private async previewDraft(): Promise<void> {
    this.generation++;
    const preview = await prepareProductionPreview(
      this.props.session,
      this.props.procedure,
      this.props.layout,
    );
    if (preview !== null)
      this.props.authored({ kind: "productionPreviewed", preview });
  }
  private showOven(source: OvenRunSource): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ oven: source });
  }
  private async openSharedProduction(id: string): Promise<void> {
    const connection = this.props.connection;
    if (connection.kind !== "workspace")
      throw new Error("Open a workspace to read shared production runs.");
    const generation = ++this.generation;
    const source = await openPersistentWorkspaceRun(
      connection.organisationId,
      id,
      controlRead,
    );
    if (
      !this.mounted ||
      generation !== this.generation ||
      this.props.connection.kind !== "workspace" ||
      this.props.connection.organisationId !== connection.organisationId
    )
      return;
    this.showOven(source);
  }
  private closeOven(): void {
    this.props.persistentOvenVisible(false);
    this.setState({ oven: null });
  }
  private showSiphon(recipe: SiphonRecipeConfig): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ siphon: recipe });
  }
  private closeSiphon(): void {
    this.props.persistentOvenVisible(false);
    this.setState({ siphon: null });
  }
  private showLatte(recipe: LatteRecipeConfig): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ latte: recipe });
  }
  private closeLatte(): void {
    this.props.persistentOvenVisible(false);
    this.setState({ latte: null });
  }
  private showBlackSesame(recipe: BlackSesameCobotRecipeConfig): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ blackSesame: recipe });
  }
  private closeBlackSesame(): void {
    this.props.persistentOvenVisible(false);
    this.setState({ blackSesame: null });
  }
  private showGingerTea(recipe: GingerTeaCobotRecipeConfig): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ gingerTea: recipe });
  }
  private closeGingerTea(): void {
    this.props.persistentOvenVisible(false);
    this.setState({ gingerTea: null });
  }
  private showFinancierBatter(recipe: FinancierBatterRecipeConfig): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ financierBatter: recipe });
  }
  private closeFinancierBatter(): void {
    this.props.persistentOvenVisible(false);
    this.setState({ financierBatter: null });
  }
  private showFinancierBake(recipe: FinancierBakeRecipeConfig): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ financierBake: recipe });
  }
  private closeFinancierBake(): void {
    this.props.persistentOvenVisible(false);
    this.setState({ financierBake: null });
  }
  private showFinancierPack(recipe: FinancierPackRecipeConfig): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ financierPack: recipe });
  }
  private closeFinancierPack(): void {
    this.props.persistentOvenVisible(false);
    this.setState({ financierPack: null });
  }
  private showPastryBench(recipe: PastryBenchRecipeConfig): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ pastryBench: recipe });
  }
  private closePastryBench(): void {
    this.props.persistentOvenVisible(false);
    this.setState({ pastryBench: null });
  }
  private showCafeShift(recipe: CafeShiftRecipeConfig): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ cafeShift: recipe });
  }
  private closeCafeShift(): void {
    this.props.persistentOvenVisible(false);
    this.setState({ cafeShift: null });
  }
  private applyCafeShiftToSchedule(
    outcome: Variant<CafeShiftOutcome, "completed">,
  ): void {
    const currentSettings =
      this.props.session.data.kind === "ready"
        ? this.props.session.data.plan.settings
        : this.props.settings;
    const batches = outcome.financierLoads;
    const bakers = outcome.staffing === "two-workers" ? 2 : 1;
    const piecesPerTray = Math.max(7, outcome.packedFinanciers);
    const parsed = parseSettings({
      ...currentSettings,
      batches,
      bakers,
      piecesPerTray,
    });
    this.props.persistentOvenVisible(false);
    this.setState({
      cafeShift: null,
      menuHistory: [
        {
          panel: "workflow",
          catalogOpen: false,
          catalogSection: null,
          activeBatchId: null,
          authorRoute: this.state.authorRoute,
        },
      ],
      catalogOpen: false,
      catalogSection: "active-production",
      activeBatchId: null,
      panelHidden: false,
      transitionDirection: "forward",
    });
    if (parsed.kind === "valid") {
      void this.prepareDefinition(
        parsed.settings,
        defaultAssignments(parsed.settings),
        `Applied Plan 61E Combined Café Shift (${outcome.servedEspressoG.toFixed(1)} g espresso · ${outcome.packedFinanciers} packed financiers · ${bakers} worker${bakers > 1 ? "s" : ""}).`,
      );
    }
  }
  private applyFinancierBatterToSchedule(
    outcome: Variant<FinancierBatterOutcome, "completed">,
  ): void {
    const currentSettings =
      this.props.session.data.kind === "ready"
        ? this.props.session.data.plan.settings
        : this.props.settings;
    const stage = outcome.emulsificationPct >= 95 ? 2 : 3;
    const traysPerBatch = outcome.mouldCavitiesYield >= 24 ? 2 : 1;
    const parsed = parseSettings({
      ...currentSettings,
      stage,
      traysPerBatch,
    });
    this.props.persistentOvenVisible(false);
    this.setState({
      financierBatter: null,
      calibratedBatter: outcome,
      menuHistory: [
        {
          panel: "workflow",
          catalogOpen: false,
          catalogSection: null,
          activeBatchId: null,
          authorRoute: this.state.authorRoute,
        },
      ],
      catalogOpen: false,
      catalogSection: "active-production",
      activeBatchId: null,
      panelHidden: false,
      transitionDirection: "forward",
    });
    if (parsed.kind === "valid") {
      void this.prepareDefinition(
        parsed.settings,
        calibratedHandoffAssignments(
          parsed.settings,
          this.state.handoffRecoveryPreset,
        ),
        `Applied Financier Batter calibration (${outcome.totalBatterG.toFixed(1)} g · ${outcome.mouldCavitiesYield} cavities): Stage ${stage} min · ${traysPerBatch} trays/batch.`,
      );
    }
  }
  private applyFinancierBakeToSchedule(
    outcome: Variant<FinancierBakeOutcome, "completed">,
  ): void {
    const currentSettings =
      this.props.session.data.kind === "ready"
        ? this.props.session.data.plan.settings
        : this.props.settings;
    const piecesPerTray = outcome.acceptedPieces;
    const portion = Math.max(2, outcome.mouldCount * 2);
    const bake = outcome.peakOvenTempC >= 178 ? 14 : 15;
    const handoffPreset = outcome.handoffRecovery.preset;
    const cool = outcome.handoffRecovery.coolingBufferMin;
    const parsed = parseSettings({
      ...currentSettings,
      piecesPerTray,
      portion,
      bake,
      cool,
    });
    this.props.persistentOvenVisible(false);
    this.setState({
      financierBake: null,
      calibratedBake: outcome,
      handoffRecoveryPreset: handoffPreset,
      rackCase: handoffPreset === "nominal-handoff" ? "nominal" : "slip",
      menuHistory: [
        {
          panel: "workflow",
          catalogOpen: false,
          catalogSection: null,
          activeBatchId: null,
          authorRoute: this.state.authorRoute,
        },
      ],
      catalogOpen: false,
      catalogSection: "active-production",
      activeBatchId: null,
      panelHidden: false,
      transitionDirection: "forward",
    });
    if (parsed.kind === "valid") {
      const handoffNote =
        handoffPreset === "nominal-handoff"
          ? "Nominal cell 1 handoff"
          : `${outcome.handoffRecovery.summary}`;
      void this.prepareDefinition(
        parsed.settings,
        calibratedHandoffAssignments(parsed.settings, handoffPreset),
        `Applied Financier Bake calibration (${outcome.acceptedPieces} pcs @ ${outcome.pieceMassG.toFixed(1)} g · ${outcome.bakedFinanciersG.toFixed(1)} g): Portion ${portion} min · Bake ${bake} min · Cool ${cool} min · ${piecesPerTray} pcs/tray · ${handoffNote}.`,
      );
    }
  }
  private applyHandoffRecoveryPreset(
    preset: FinancierHandoffRecoveryPreset,
  ): void {
    const currentSettings =
      this.props.session.data.kind === "ready"
        ? this.props.session.data.plan.settings
        : this.props.settings;
    const recovery = buildFinancierHandoffRecovery(preset);
    const parsed = parseSettings({
      ...currentSettings,
      cool: recovery.coolingBufferMin,
    });
    this.setState({
      handoffRecoveryPreset: preset,
      rackCase: preset === "nominal-handoff" ? "nominal" : "slip",
    });
    if (parsed.kind === "valid") {
      void this.prepareDefinition(
        parsed.settings,
        calibratedHandoffAssignments(parsed.settings, preset),
        `Applied Tier 2 → Tier 3 cell handoff preset (${recovery.preset}): ${recovery.summary}.`,
      );
    }
  }
  private applyFinancierPackToSchedule(
    outcome: Variant<FinancierPackOutcome, "completed">,
  ): void {
    const currentSettings =
      this.props.session.data.kind === "ready"
        ? this.props.session.data.plan.settings
        : this.props.settings;
    const piecesPerTray = outcome.packedPieces;
    const demould = 2;
    const finishCooling = 10;
    const pack = outcome.packedPieces >= 15 ? 6 : 4;
    const parsed = parseSettings({
      ...currentSettings,
      piecesPerTray,
      demould,
      finishCooling,
      pack,
    });
    this.props.persistentOvenVisible(false);
    this.setState({
      financierPack: null,
      calibratedPack: outcome,
      menuHistory: [
        {
          panel: "workflow",
          catalogOpen: false,
          catalogSection: null,
          activeBatchId: null,
          authorRoute: this.state.authorRoute,
        },
      ],
      catalogOpen: false,
      catalogSection: "active-production",
      activeBatchId: null,
      panelHidden: false,
      transitionDirection: "forward",
    });
    if (parsed.kind === "valid") {
      void this.prepareDefinition(
        parsed.settings,
        calibratedHandoffAssignments(
          parsed.settings,
          this.state.handoffRecoveryPreset,
        ),
        `Applied Financier Pack calibration (${outcome.packedPieces} packed · ${outcome.packedNetMassG.toFixed(1)} g net): Demould ${demould} min · Crumb cool ${finishCooling} min · Pack ${pack} min · ${piecesPerTray} pcs/tray.`,
      );
    }
  }
  private chooseAuthorRoute(authorRoute: string | null): void {
    if (
      (authorRoute === "cold-racking" || authorRoute === "oven-rack") &&
      authorRoute !== this.state.authorRoute
    )
      this.setState({
        menuHistory: [...this.state.menuHistory, this.currentMenuSnapshot()],
        authorRoute,
        transitionDirection: "forward",
      });
  }
  private authorRouteChoice(): React.ReactNode {
    return (
      <label>
        Production route
        <Select.Root
          items={AUTHOR_ROUTES}
          value={this.state.authorRoute}
          onValueChange={this.chooseAuthorRoute.bind(this)}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{AUTHOR_ROUTES.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
    );
  }
  private async openOvenFile(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    const generation = ++this.generation;
    this.update({ notice: "Checking the oven route file…" });
    try {
      const source = await readOvenRunFile(file);
      if (!this.mounted || generation !== this.generation) return;
      if (source.ok) this.showOven(source.value);
      else this.update({ notice: source.error });
    } catch (error) {
      if (this.mounted && generation === this.generation)
        this.update({ notice: message(error) });
    }
  }
  private async openDefinition(scenarioId: string): Promise<void> {
    const connection = this.props.connection;
    if (
      connection.kind !== "workspace" ||
      this.props.session.openingDefinition ||
      this.props.session.savingDefinition
    )
      return;
    const id = scenarioId.trim();
    if (id === "") return;
    const generation = ++this.generation;
    this.props.playback.pause();
    this.update({
      openingDefinition: true,
      notice: "Opening production scenario…",
    });
    try {
      const opened = await readProductionScenario(
        connection.organisationId,
        id,
      );
      if (opened.kind !== "ready") throw new Error(opened.message);
      const definition = opened.definition;
      if (definition.route === "oven-rack") {
        const source = await prepareOvenDefinition(definition);
        if (!this.mounted || generation !== this.generation) return;
        if (source.ok) this.showOven(source.value);
        else this.update({ notice: source.error });
        return;
      }
      const plan = await compileProductionDraft(
        definition.settings,
        definition.assignments,
        definition.variant,
        definition,
        definition.manualTasks,
        definition.sourceFingerprint,
      );
      if (!this.mounted || generation !== this.generation) return;
      this.update({
        draft: definition.assignments,
        manualTasks: definition.manualTasks,
        presentation: definition.presentation,
        draftVariant: definition.variant,
        draftName: definition.name,
        draftNote: definition.note,
        identity: { kind: "saved", definition },
        sourceProcedure: opened.procedure,
        preview: readyProduction(plan, this.props.layout),
        notice: `Opened “${definition.name}” for review. Apply the preview to start a fresh run; native evidence remains separate.`,
      });
    } catch (error) {
      if (this.mounted && generation === this.generation)
        this.update({
          notice: `${message(error)} Your current run and draft are unchanged.`,
        });
    } finally {
      if (this.mounted && generation === this.generation)
        this.update({ openingDefinition: false });
    }
  }
  private async saveDefinition(): Promise<void> {
    const { connection } = this.props;
    const procedure =
      this.props.session.sourceProcedure ?? this.props.procedure;
    const preview = this.props.session.preview;
    const { identity, draftName, draftNote, draftVariant, draft } =
      this.props.session;
    if (
      connection.kind !== "workspace" ||
      !connection.canManage ||
      procedure === null ||
      this.props.session.savingDefinition ||
      this.props.session.openingDefinition ||
      identity.kind !== "new" ||
      preview === null
    )
      return;
    if (!settingsMatch(procedure.settings, preview.plan.settings)) {
      this.update({
        notice:
          "The production inputs differ from the loaded procedure. Apply the procedure inputs before saving.",
      });
      return;
    }
    const generation = this.generation;
    this.update({
      savingDefinition: true,
      notice: "Saving production scenario…",
    });
    try {
      const sourceFingerprint = await bakeryFingerprint(procedure.revisionKey);
      if (
        this.props.session.sourceProcedure === null &&
        this.props.session.data.kind === "ready" &&
        this.props.session.data.plan.source.kind === "shared" &&
        (procedure.reference.entityId !==
          this.props.session.data.plan.source.definition.procedureId ||
          sourceFingerprint !==
            this.props.session.data.plan.source.definition.sourceFingerprint)
      ) {
        this.update({
          notice:
            "Open the source scenario before saving edits to this production run.",
        });
        return;
      }
      const definitionFingerprint = await productionDefinitionFingerprint(
        sourceFingerprint,
        preview.plan.settings,
        draftVariant,
        draft,
        this.props.session.manualTasks,
        { route: "cold-racking" },
      );
      const definition = parseProductionScenario({
        id: identity.id,
        name: draftName.trim(),
        note: draftNote.trim(),
        procedureId: procedure.reference.entityId,
        sourceFingerprint,
        definitionFingerprint,
        settings: preview.plan.settings,
        variant: draftVariant,
        assignments: draft,
        manualTasks: this.props.session.manualTasks,
        presentation: this.props.session.presentation,
      });
      if (definition === null) {
        this.update({
          notice:
            "Enter a name and review the assigned trays, bakers and predecessors.",
        });
        return;
      }
      if (generation !== this.generation) return;
      const result = await saveProductionScenario(
        connection.organisationId,
        connection.mutate,
        definition,
      );
      if (!this.mounted) return;
      switch (result.kind) {
        case "verified": {
          if (
            currentDraft(this.props.session.identity, identity.id) &&
            generation === this.generation
          ) {
            const attached = await attachProductionScenario(
              preview.plan,
              result.definition,
            );
            if (attached.kind === "rejected") throw new Error(attached.message);
            if (!this.mounted) break;
            if (generation !== this.generation) {
              this.update({
                identity: identityAfterSave(
                  this.props.session.identity,
                  identity.id,
                  false,
                ),
                notice: `Saved “${definition.name}” as ${definition.id}. Current draft has newer changes.`,
              });
              break;
            }
            const active = this.props.session.data;
            if (
              active.kind === "ready" &&
              active.plan.fingerprint === preview.plan.fingerprint
            ) {
              const current = await attachProductionScenario(
                active.plan,
                result.definition,
              );
              if (current.kind === "rejected") throw new Error(current.message);
              if (!this.mounted) break;
              if (generation !== this.generation) {
                this.update({
                  identity: identityAfterSave(
                    this.props.session.identity,
                    identity.id,
                    false,
                  ),
                  notice: `Saved “${definition.name}” as ${definition.id}. Current draft has newer changes.`,
                });
                break;
              }
              this.update({
                data: readyProduction(current.plan, this.props.layout),
              });
            }
            this.update({
              identity: { kind: "saved", definition: result.definition },
              preview: readyProduction(attached.plan, this.props.layout),
              notice: `Saved and verified “${definition.name}”. Scenario ID: ${definition.id}.`,
            });
          } else {
            this.update({
              identity: identityAfterSave(
                this.props.session.identity,
                identity.id,
                false,
              ),
              notice: `Saved and verified “${definition.name}”. Scenario ID: ${definition.id}. Current draft has newer changes.`,
            });
          }
          break;
        }
        case "saved-readback-failed":
        case "outcome-unknown":
          this.update({
            identity: identityAfterSave(
              this.props.session.identity,
              identity.id,
              generation === this.generation,
            ),
            notice: result.message,
          });
          break;
        case "failed-before-save":
          this.update({ notice: result.message });
          break;
      }
    } catch (error) {
      if (this.mounted)
        this.update({
          identity: identityAfterSave(
            this.props.session.identity,
            identity.id,
            generation === this.generation,
          ),
          notice: message(error),
        });
    } finally {
      if (this.mounted) this.update({ savingDefinition: false });
    }
  }
  // The multi-tray rehearsal starts from two recorded trays on the production
  // scheduler: a cold oven cycle and a table-to-rack transfer. The single-skill
  // examples are presets of one tray.
  private async prepareRehearsal(
    preset: RehearsalPreset = "two-trays",
  ): Promise<void> {
    const generation = ++this.generation;
    this.update({ reading: true });
    try {
      const result = await rehearsalPreset(
        preset,
        rehearsalSettings(this.props.settings),
        readPresetExample,
      );
      if (result.kind === "rejected") throw new Error(result.message);
      if (!this.mounted || generation !== this.generation) return;
      this.applyRehearsal(
        result.plan,
        preset === "two-trays"
          ? "Rehearsal prepared with two recorded trays. Use Edit trays to add a browser chain."
          : `${presetName(preset)} opened from its recorded result. Clear its results to run it in browser MuJoCo.`,
      );
    } catch (error) {
      if (!this.mounted || generation !== this.generation) return;
      if (this.props.session.data.kind === "ready")
        this.update({ notice: message(error) });
      else this.update({ data: { kind: "failed" }, notice: message(error) });
    } finally {
      if (this.mounted) this.update({ reading: false });
    }
  }
  private choosePreset(value: string | null): void {
    const preset = REHEARSAL_PRESETS.find(hasPresetValue.bind(null, value));
    if (preset !== undefined) this.setState({ preset: preset.id });
  }
  private startPreset(): void {
    void this.reviewRehearsalChange({
      kind: "replace_preset",
      preset: this.state.preset,
    });
  }
  private applyRehearsal(
    plan: ProductionWorkcells,
    notice: string,
    keepView = false,
    readOnly: readonly string[] = [],
  ): void {
    this.generation++;
    this.props.playback.pause();
    this.update(
      rehearsalSessionPatch(
        this.props.session,
        plan,
        notice,
        keepView,
        this.props.layout,
        readOnly,
      ),
    );
  }
  // Chat prepares the same edits; the workspace commits them.
  private async editRehearsal(
    edit: RehearsalEdit,
    notice?: string,
  ): Promise<void> {
    if (this.props.session.data.kind !== "ready") return;
    const plan = this.props.session.data.plan;
    const generation = ++this.generation;
    this.update({ reading: true });
    try {
      const result = await prepareRehearsalEdit(plan, edit, notice);
      if (!this.mounted || generation !== this.generation) return;
      if (result.kind === "rejected") this.update({ notice: result.message });
      else this.props.rehearsalEdited(result.edit);
    } finally {
      if (this.mounted) this.update({ reading: false });
    }
  }
  private async addRehearsalChain(): Promise<void> {
    try {
      await this.editRehearsal(await trayChainEdit(this.state.rackCase));
    } catch (error) {
      if (this.mounted) this.update({ notice: message(error) });
    }
  }
  private rackCase(value: string | null): void {
    if (value === "nominal" || value === "slip")
      this.setState({ rackCase: value });
  }
  private rehearsalIngredients(
    batchId: string,
    event: React.FormEvent<HTMLFormElement>,
  ): void {
    event.preventDefault();
    if (this.locked()) return;
    const form = new FormData(event.currentTarget);
    try {
      const ingredients = parseIngredientLoad({
        massKg: Number(form.get("massKg")),
        forwardMm: Number(form.get("forwardMm")),
        lateralMm: Number(form.get("lateralMm")),
      });
      void this.editRehearsal({ kind: "ingredients", batchId, ingredients });
    } catch (error) {
      this.update({ notice: message(error) });
    }
  }
  private ingredientEditor(root: ProductionWorkcell): React.ReactNode {
    if (!browserRoot(root)) return null;
    const load = root.attempt.input.request.ingredients;
    return (
      <form
        key={`${root.attempt.input.request.attemptId}:${load.massKg}:${load.forwardMm}:${load.lateralMm}`}
        aria-label={`Tray ${root.batchId} ingredients`}
        onSubmit={this.rehearsalIngredients.bind(this, root.batchId)}
      >
        <fieldset disabled={this.locked()}>
          <legend>Ingredient load</legend>
          <label>
            Ingredient mass (kg)
            <input
              name="massKg"
              type="number"
              min="0"
              max="4"
              step="any"
              required
              defaultValue={load.massKg}
            />
          </label>
          <label>
            Forward offset (mm)
            <input
              name="forwardMm"
              type="number"
              min="-100"
              max="100"
              step="1"
              required
              defaultValue={load.forwardMm}
            />
          </label>
          <label>
            Lateral offset (mm)
            <input
              name="lateralMm"
              type="number"
              min="-60"
              max="60"
              step="1"
              required
              defaultValue={load.lateralMm}
            />
          </label>
          <p>
            Mass excludes the tray and tool. Positive forward is away from the
            wrist; positive lateral follows the staging Y axis.
          </p>
          <p>
            Applying a changed load clears this tray’s results and continuation
            states. Run the tray again to check the new load.
          </p>
          <button type="submit">
            Apply ingredients to tray {root.batchId}
          </button>
        </fieldset>
      </form>
    );
  }
  private rehearsalWorker(batchId: string, value: string | null): void {
    if (value === null) return;
    void this.editRehearsal({
      kind: "worker",
      batchId,
      workerId: `human-${Number(value)}`,
    });
  }
  private rehearsalCell(batchId: string, value: string | null): void {
    if (value === null) return;
    const cellId = parseCellId(value);
    if (cellId !== null)
      void this.reviewRehearsalChange({
        kind: "set_cell",
        batchId,
        cellId,
      });
  }
  private rehearsalStart(
    operation: ProductionWorkcell | PlannedProductionWorkcell,
    event: React.FocusEvent<HTMLInputElement>,
  ): void {
    const value = Number(event.currentTarget.value);
    if (value === operation.earliestStartSeconds) return;
    if (!Number.isInteger(value) || value < 0) {
      this.update({ notice: "Enter a whole number of seconds." });
      return;
    }
    void this.editRehearsal({
      kind: "start",
      operationId: operation.id,
      earliestStartSeconds: value,
    });
  }
  private rehearsalPrerequisite(
    tray: ProductionWorkcell,
    id: string,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    const dependsOn = event.currentTarget.checked
      ? [...tray.dependsOn, id]
      : tray.dependsOn.filter(otherId.bind(null, id));
    void this.editRehearsal({
      kind: "prerequisites",
      batchId: tray.batchId,
      dependsOn,
    });
  }
  private resetRehearsalTray(batchId: string): void {
    void this.reviewRehearsalChange({ kind: "clear_results", batchId });
  }
  private removeRehearsalTray(batchId: string): void {
    void this.reviewRehearsalChange({ kind: "remove_tray", batchId });
  }
  private async reviewRehearsalChange(
    change: BakeryRehearsalChange,
  ): Promise<void> {
    const data = this.props.session.data;
    if (data.kind !== "ready" || this.locked()) return;
    const generation = ++this.generation;
    this.update({ reading: true });
    try {
      const result = await prepareRehearsalReview(data.plan, change);
      if (!this.mounted || generation !== this.generation) return;
      this.update({ reading: false });
      if (result.kind === "rejected") this.update({ notice: result.message });
      else
        this.props.authored({
          kind: "rehearsalReviewPrepared",
          review: result.review,
        });
    } catch (error) {
      if (this.mounted && generation === this.generation)
        this.update({ reading: false, notice: message(error) });
    }
  }
  private resolveRehearsalReview(decision: "apply" | "discard"): void {
    const review = this.props.session.rehearsalReview;
    if (review !== null)
      this.props.authored({
        kind: "rehearsalReviewResolved",
        review,
        decision,
      });
  }
  private rehearsalChangeReview(): React.ReactNode {
    const review = this.props.session.rehearsalReview;
    if (review === null) return null;
    return (
      <section
        className="workcell-save-review"
        aria-label="Review rehearsal change"
      >
        <h4>Review rehearsal change</h4>
        <p>After applying: {review.edit.notice}</p>
        <p>
          Current run: {review.summary.currentResults} accepted results.
          Proposed run: {review.summary.proposedResults} accepted results.
        </p>
        <p>
          Apply replaces the affected trays or results in this open run. Saved
          runs are kept.
        </p>
        <button
          type="button"
          onClick={this.resolveRehearsalReview.bind(this, "apply")}
        >
          Apply rehearsal change
        </button>
        <button
          type="button"
          onClick={this.resolveRehearsalReview.bind(this, "discard")}
        >
          Discard rehearsal change
        </button>
      </section>
    );
  }
  private locked(): boolean {
    return (
      this.props.session.reading ||
      this.props.session.readOnly.length > 0 ||
      this.props.session.rehearsalReview !== null ||
      this.props.browserJob.kind === "running" ||
      this.props.browserJob.kind === "loading"
    );
  }
  private rehearsalAuthor(data: Ready): React.ReactNode {
    const roots = data.plan.operations.filter(isRoot);
    const steps = [...data.plan.operations, ...data.plan.planned];
    const workers = workerChoices(data.plan.settings.workerCount);
    return (
      <>
        <div className="production-section-header">
          <button
            type="button"
            className="production-menu-back"
            onClick={this.goBack.bind(this)}
          >
            ← Back
          </button>
          <h3>Rehearsal trays</h3>
        </div>
        {this.detailsModeTabs("author")}
        <p aria-label="Workcell robot assignments">
          Robot cell 1: {cellRobotLabel(data.plan.cellRobots["cold-cell-1"])}.{" "}
          Robot cell 2: {cellRobotLabel(data.plan.cellRobots["cold-cell-2"])}.{" "}
          Each cell keeps the same arm throughout this run.
        </p>
        <p>
          Each tray is staged into its assigned Robot cell, runs its skills,
          then is cleared. A tray's prerequisites must finish before it takes
          the cell. Changing cell clears that tray’s results after operator
          review.
        </p>
        {this.props.session.readOnly.length > 0 && (
          <section
            className="workcell-save-review"
            aria-label="Read-only conversion"
          >
            <p>
              This run was converted from an earlier format and is read-only.
            </p>
            <ul>{this.props.session.readOnly.map(reason)}</ul>
            <button type="button" onClick={this.startFromConversion.bind(this)}>
              Start a new rehearsal from this run
            </button>
          </section>
        )}
        <div className="production-rehearsal-preset">
          <label>
            Start from
            <Select.Root
              items={PRESET_CHOICES}
              value={this.state.preset}
              onValueChange={this.choosePreset.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{PRESET_CHOICES.map(renderItem)}</Select.Popup>
            </Select.Root>
          </label>
          <button
            type="button"
            disabled={this.locked()}
            onClick={this.startPreset.bind(this)}
          >
            Replace with preset
          </button>
        </div>
        {this.rehearsalChangeReview()}
        <div className="production-rehearsal-add">
          <label>
            Racking
            <Select.Root
              items={RACK_CASES}
              value={this.state.rackCase}
              onValueChange={this.rackCase.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{RACK_CASES.map(renderItem)}</Select.Popup>
            </Select.Root>
          </label>
          <button
            type="button"
            disabled={this.locked()}
            onClick={this.addRehearsalChain.bind(this)}
          >
            Add browser tray chain
          </button>
        </div>
        {roots.map(this.rehearsalTray.bind(this, steps, workers, roots.length))}
        {this.trayLayout(data)}
        {this.rehearsalFaults(data, roots, steps)}
        {this.baselineComparison(data)}
      </>
    );
  }
  // A rack translation moves one table-to-rack tray's first request.
  private trayLayout(data: Ready): React.ReactNode {
    const tray = layoutTray(data.plan, selectedTray(this.props.session));
    if (tray === null || this.locked()) return null;
    const layout = this.props.session.layout;
    return (
      <RackLayoutEditor
        attempt={tray.attempt}
        review={
          layout?.operationId === tray.id ? layout.review : { kind: "none" }
        }
        actions={{
          previewRackLayout: this.previewTrayLayout.bind(this, tray),
          prepareRackLayout: this.prepareTrayLayout.bind(this, tray),
          discardRackLayout: this.discardTrayLayout.bind(this),
          applyRackLayout: this.applyTrayLayout.bind(this, tray),
        }}
        tray={`Tray ${tray.batchId}`}
      />
    );
  }
  private previewTrayLayout(
    tray: ProductionWorkcell,
    xMm: number,
    yMm: number,
  ): void {
    this.update({
      layout: {
        operationId: tray.id,
        review: evaluateRackLayout(tray.attempt, 0, xMm, yMm),
      },
    });
  }
  private async prepareTrayLayout(
    tray: ProductionWorkcell,
    xMm: number,
    yMm: number,
  ): Promise<void> {
    const draft = evaluateRackLayout(tray.attempt, 0, xMm, yMm);
    if (draft.kind === "invalid") {
      this.update({ layout: { operationId: tray.id, review: draft } });
      return;
    }
    try {
      const proposal = await prepareRackLayout(draft);
      const data = this.props.session.data;
      if (
        !this.mounted ||
        data.kind !== "ready" ||
        !data.plan.operations.includes(tray)
      )
        return;
      this.update({
        layout: {
          operationId: tray.id,
          review: { kind: "prepared", proposal },
        },
      });
    } catch (error) {
      if (this.mounted) this.update({ notice: message(error) });
    }
  }
  private discardTrayLayout(): void {
    this.update({ layout: null });
  }
  private applyTrayLayout(
    tray: ProductionWorkcell,
    proposal: RackLayoutProposal,
  ): void {
    if (
      proposal.kind === "blocked" ||
      proposal.previous !== tray.attempt ||
      rackPlacementFit(proposal.layout).kind === "blocked"
    ) {
      this.update({
        notice: "The layout proposal is blocked or stale. Review it again.",
      });
      return;
    }
    void this.editRehearsal({
      kind: "layout",
      batchId: tray.batchId,
      input: proposal.input,
    });
  }
  private editFaults(faults: RunFaults, notice: string): void {
    void this.editRehearsal({ kind: "faults", faults }, notice);
  }
  private outageResource(faults: RunFaults, value: string | null): void {
    if (value === null) return;
    const resource = outageChoice(value);
    this.editFaults(
      {
        ...faults,
        outage:
          resource === null
            ? null
            : {
                resource,
                start: faults.outage?.start ?? 0,
                end: faults.outage?.end ?? 300,
              },
      },
      resource === null
        ? "Outage removed."
        : `${outageResourceName(resource)} outage applied. Accepted results are kept.`,
    );
  }
  private outageTime(
    faults: RunFaults,
    edge: "start" | "end",
    event: React.FocusEvent<HTMLInputElement>,
  ): void {
    const outage = faults.outage;
    const value = wholeSeconds(event.currentTarget.value);
    if (outage === null || value === outage[edge]) return;
    if (value === null) {
      this.update({ notice: "Enter a whole number of seconds." });
      return;
    }
    this.editFaults(
      { ...faults, outage: { ...outage, [edge]: value } },
      "Outage window changed. Accepted results are kept.",
    );
  }
  private failureTask(faults: RunFaults, value: string | null): void {
    if (value === null) return;
    const bakeryTaskId = handlingChoice(value);
    this.editFaults(
      {
        ...faults,
        failure:
          bakeryTaskId === null
            ? null
            : {
                bakeryTaskId,
                afterSeconds: faults.failure?.afterSeconds ?? 10,
              },
      },
      bakeryTaskId === null ? "Injected failure removed." : "Failure injected.",
    );
  }
  private failureAfter(
    faults: RunFaults,
    event: React.FocusEvent<HTMLInputElement>,
  ): void {
    const failure = faults.failure;
    const value = wholeSeconds(event.currentTarget.value);
    if (failure === null || value === failure.afterSeconds) return;
    if (value === null) {
      this.update({ notice: "Enter a whole number of seconds." });
      return;
    }
    this.editFaults(
      { ...faults, failure: { ...failure, afterSeconds: value } },
      "Failure time changed.",
    );
  }
  private recoveryTask(faults: RunFaults, bakeryTaskId: string | null): void {
    if (bakeryTaskId === null) return;
    this.editFaults(
      {
        ...faults,
        recovery:
          bakeryTaskId === ""
            ? null
            : { bakeryTaskId, seconds: faults.recovery?.seconds ?? 120 },
      },
      bakeryTaskId === ""
        ? "Recovery removed; failures keep their holds."
        : "Recovery assumed for that task if it fails.",
    );
  }
  private recoverySeconds(
    faults: RunFaults,
    event: React.FocusEvent<HTMLInputElement>,
  ): void {
    const recovery = faults.recovery;
    const value = wholeSeconds(event.currentTarget.value);
    if (recovery === null || value === recovery.seconds) return;
    if (value === null) {
      this.update({ notice: "Enter a whole number of seconds." });
      return;
    }
    this.editFaults(
      { ...faults, recovery: { ...recovery, seconds: value } },
      "Recovery duration changed.",
    );
  }
  private rehearsalFaults(
    data: Ready,
    roots: readonly ProductionWorkcell[],
    steps: readonly (ProductionWorkcell | PlannedProductionWorkcell)[],
  ): React.ReactNode {
    const faults = data.plan.faults;
    const resources: OutageResource[] = [];
    for (let worker = 1; worker <= data.plan.settings.workerCount; worker++)
      resources.push(`human-${worker}`);
    resources.push(...OUTAGE_WORKCELL_RESOURCES);
    const outages = [NO_OUTAGE, ...resources.map(resourceChoice)];
    const handling: SelectChoice[] = [NO_FAILURE];
    const recoverable: SelectChoice[] = [KEEP_HOLDS];
    for (const root of roots) {
      const phases: ("stage" | "clear" | "transfer")[] = ["stage", "clear"];
      if (steps.some(isHumanTransferStep.bind(null, root.batchId)))
        phases.push("transfer");
      for (const phase of phases) {
        const id = handlingTaskId(root.batchId, root.tray, phase);
        const label = `Tray ${root.batchId} ${phase === "transfer" ? "human transfer" : phase === "stage" ? "staging" : "clearance"}`;
        handling.push({ value: id, label });
        recoverable.push({ value: id, label });
      }
      for (const step of steps.filter(sameTray.bind(null, root)).sort(byStep))
        recoverable.push({
          value: step.id,
          label: `Tray ${step.batchId} step ${step.step} · ${stepName(step)}`,
        });
    }
    return (
      <fieldset className="production-assignment production-faults">
        <legend>Faults and recovery</legend>
        <p>
          Assumptions to compare against a pinned baseline. An outage postpones
          new work that needs its resource; running work continues. A failed
          staging or clearance holds its baker and the cell. A recovery releases
          them after its duration; the failed tray and work waiting for it stay
          blocked. Native failures come from recordings, such as injected-slip
          racking.
        </p>
        <label>
          Unavailable resource
          <Select.Root
            items={outages}
            value={faults.outage?.resource ?? ""}
            disabled={this.locked()}
            onValueChange={this.outageResource.bind(this, faults)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{outages.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        {faults.outage !== null && (
          <>
            <label key={`start-${faults.outage.start}`}>
              Unavailable from (s)
              <input
                type="number"
                min="0"
                step="1"
                defaultValue={faults.outage.start}
                disabled={this.locked()}
                onBlur={this.outageTime.bind(this, faults, "start")}
              />
            </label>
            <label key={`end-${faults.outage.end}`}>
              Available again (s)
              <input
                type="number"
                min="1"
                step="1"
                defaultValue={faults.outage.end}
                disabled={this.locked()}
                onBlur={this.outageTime.bind(this, faults, "end")}
              />
            </label>
          </>
        )}
        <label>
          Injected failure
          <Select.Root
            items={handling}
            value={faults.failure?.bakeryTaskId ?? ""}
            disabled={this.locked()}
            onValueChange={this.failureTask.bind(this, faults)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{handling.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        {faults.failure !== null && (
          <label key={`after-${faults.failure.afterSeconds}`}>
            Fail after (s into the task)
            <input
              type="number"
              min="1"
              step="1"
              defaultValue={faults.failure.afterSeconds}
              disabled={this.locked()}
              onBlur={this.failureAfter.bind(this, faults)}
            />
          </label>
        )}
        <label>
          Assumed recovery
          <Select.Root
            items={recoverable}
            value={faults.recovery?.bakeryTaskId ?? ""}
            disabled={this.locked()}
            onValueChange={this.recoveryTask.bind(this, faults)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{recoverable.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        {faults.recovery !== null && (
          <label key={`recovery-${faults.recovery.seconds}`}>
            Recovery duration (s)
            <input
              type="number"
              min="1"
              step="1"
              defaultValue={faults.recovery.seconds}
              disabled={this.locked()}
              onBlur={this.recoverySeconds.bind(this, faults)}
            />
          </label>
        )}
        <button
          type="button"
          disabled={this.locked() || faults === NO_FAULTS}
          onClick={this.editFaults.bind(this, NO_FAULTS, "Faults cleared.")}
        >
          Clear faults
        </button>
      </fieldset>
    );
  }
  private pinBaseline(run: Run): void {
    this.props.authored({
      kind: "productionBaselineChanged",
      action: "pin",
      source: run,
      baseline: this.props.session.baseline,
    });
  }
  private clearBaseline(run: Run): void {
    this.props.authored({
      kind: "productionBaselineChanged",
      action: "clear",
      source: run,
      baseline: this.props.session.baseline,
    });
  }
  private baselineComparison(data: Ready): React.ReactNode {
    const run = this.props.session.preview?.run ?? data.run;
    const baseline = this.props.session.baseline;
    const current = summarizeRun(run);
    const unit =
      this.props.session.procedure === "rehearsal" ? "tray" : "batch";
    return (
      <section className="production-baseline" aria-label="Baseline comparison">
        <h4>Compare with a pinned baseline</h4>
        <p>
          Pin the current run, change the workflow or its faults, then compare.
          The baseline stays fixed until you replace it.
        </p>
        <button type="button" onClick={this.pinBaseline.bind(this, run)}>
          Pin current run as baseline
        </button>
        {baseline !== null && (
          <>
            <button type="button" onClick={this.clearBaseline.bind(this, run)}>
              Clear baseline
            </button>
            <table>
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col">Baseline</th>
                  <th scope="col">Current</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Run end</th>
                  <td>{runEnd(baseline)}</td>
                  <td>{runEnd(current)}</td>
                </tr>
                <tr>
                  <th scope="row">Completed tasks</th>
                  <td>{baseline.completed}</td>
                  <td>{current.completed}</td>
                </tr>
                <tr>
                  <th scope="row">Unfinished {unit}s</th>
                  <td>{baseline.unfinished}</td>
                  <td>{current.unfinished}</td>
                </tr>
                <tr>
                  <th scope="row">Failed tasks</th>
                  <td>{baseline.failed}</td>
                  <td>{current.failed}</td>
                </tr>
                <tr>
                  <th scope="row">Total waiting</th>
                  <td>{duration(baseline.waiting)}</td>
                  <td>{duration(current.waiting)}</td>
                </tr>
              </tbody>
            </table>
            <p role="status">{compareRuns(baseline, current, unit)}</p>
            <p>
              Total waiting sums every {unit}'s waits, so parallel waits
              overlap.
            </p>
          </>
        )}
      </section>
    );
  }
  private rehearsalTray(
    steps: readonly (ProductionWorkcell | PlannedProductionWorkcell)[],
    workers: readonly SelectChoice[],
    count: number,
    root: ProductionWorkcell,
  ): React.ReactNode {
    const chain = steps.filter(sameTray.bind(null, root)).sort(byStep);
    const others = steps.filter(otherTray.bind(null, root)).sort(byTrayStep);
    return (
      <fieldset key={root.id} className="production-assignment">
        <legend>
          Tray {root.batchId} · {chain.map(stepName).join(" → ")}
        </legend>
        <label>
          Baker
          <Select.Root
            items={workers}
            value={String(Number(root.workerId.slice(6)))}
            disabled={this.locked()}
            onValueChange={this.rehearsalWorker.bind(this, root.batchId)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{workers.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          Cold cell (assumed independent layout)
          <Select.Root
            items={COLD_CELLS}
            value={root.attempt.input.bindings.cell}
            disabled={this.locked() || !browserRoot(root)}
            onValueChange={this.rehearsalCell.bind(this, root.batchId)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{COLD_CELLS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        {this.ingredientEditor(root)}
        {supportsHumanCellTransfer(root.attempt.input) &&
          chain.length === 1 && (
            <button
              type="button"
              disabled={this.locked()}
              onClick={this.reviewRehearsalChange.bind(this, {
                kind: "add_human_transfer",
                batchId: root.batchId,
              })}
            >
              Add human transfer to cell 2 for tray {root.batchId}
            </button>
          )}
        {chain.some(isHumanTransferStep.bind(null, root.batchId)) && (
          <p>
            Assumed human transfer: cell 1 rack → one-slot buffer → cell 2
            source. Pickup {HUMAN_CELL_TRANSFER.pickupSeconds}s, carry{" "}
            {HUMAN_CELL_TRANSFER.carrySeconds}s, placement{" "}
            {HUMAN_CELL_TRANSFER.placementSeconds}s. Placement uses cell 2’s
            native source pose. Cells use independent model frames; the bakery
            layout is unmeasured.
          </p>
        )}
        {chain.map(this.rehearsalStep.bind(this))}
        {others.length > 0 && (
          <>
            <h4>
              Prerequisites ({root.dependsOn.length}) · must finish before
              staging
            </h4>
            {others.map(this.rehearsalChoice.bind(this, root))}
          </>
        )}
        <button
          type="button"
          disabled={
            this.locked() || !browserRoot(root) || !chain.some(hasResult)
          }
          onClick={this.resetRehearsalTray.bind(this, root.batchId)}
        >
          Clear tray {root.batchId} results
        </button>
        <button
          type="button"
          disabled={this.locked() || count === 1}
          onClick={this.removeRehearsalTray.bind(this, root.batchId)}
        >
          Remove tray {root.batchId}
        </button>
      </fieldset>
    );
  }
  private rehearsalStep(
    operation: ProductionWorkcell | PlannedProductionWorkcell,
  ): React.ReactNode {
    return (
      <label key={`${operation.id}-${operation.earliestStartSeconds}`}>
        {operation.step === 1
          ? "Earliest staging (s)"
          : `Step ${operation.step} · ${stepName(operation)} earliest start (s)`}
        <input
          type="number"
          min="0"
          step="1"
          defaultValue={operation.earliestStartSeconds}
          disabled={this.locked()}
          onBlur={this.rehearsalStart.bind(this, operation)}
        />
      </label>
    );
  }
  private rehearsalChoice(
    tray: ProductionWorkcell,
    operation: ProductionWorkcell | PlannedProductionWorkcell,
  ): React.ReactNode {
    return (
      <label key={operation.id}>
        <input
          type="checkbox"
          checked={tray.dependsOn.includes(operation.id)}
          disabled={this.locked()}
          onChange={this.rehearsalPrerequisite.bind(this, tray, operation.id)}
        />
        Tray {operation.batchId} · step {operation.step} ({stepName(operation)})
      </label>
    );
  }
  private apply(plan: ProductionWorkcells, notice: string): void {
    this.generation++;
    this.props.playback.pause();
    this.update(
      appliedRunPatch(
        this.props.session,
        readyProduction(plan, this.props.layout),
        notice,
      ),
    );
  }
  private selectedOperation(): ProductionWorkcell | null {
    if (this.props.session.data.kind !== "ready") return null;
    return (
      this.props.session.data.plan.operations.find(
        matchesOperation.bind(null, this.props.session.operationId),
      ) ?? null
    );
  }
  private inspectRequest(operationId: string): void {
    const data = this.props.session.data;
    if (data.kind !== "ready" || this.props.session.reading) return;
    const navigation = prepareProductionNavigation(data, {
      selection: { kind: "operation", id: operationId },
      cursorSeconds: this.props.session.cursor.time,
      playback: "paused",
    });
    if (navigation !== null)
      this.props.authored({ kind: "productionNavigated", navigation });
  }
  private chooseNativeOperation(operation: ProductionWorkcell): void {
    if (this.props.session.data.kind !== "ready") return;
    const task = nativeTaskFor(this.props.session.data.run, operation.id);
    if (task !== null) this.inspect(task);
    else this.inspectRequest(operation.id);
  }
  private request(): void {
    this.downloadFile("request");
  }
  private save(): void {
    this.downloadFile("run");
  }
  private downloadFile(kind: BakeryExportKind): void {
    try {
      const file = exportProductionFile(this.props.session, kind);
      downloadBakeryFile(file.name, file.text);
    } catch (error) {
      this.update({ notice: message(error) });
    }
  }
  private async open(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined || this.props.session.data.kind !== "ready") return;
    const session = this.props.session;
    const generation = ++this.generation;
    this.props.playback.pause();
    this.update({
      reading: true,
      pending: { kind: "none" },
      notice: "Reading file…",
    });
    try {
      if (file.size > MAX_EXPERIMENT_BYTES)
        throw new Error("Choose a file within the recording size limit.");
      const text = await file.text();
      const pending = await prepareProductionFile(
        session,
        this.props.settings,
        text,
        this.props.connection.kind === "workspace"
          ? {
              kind: "connected",
              organisationId: this.props.connection.organisationId,
              readDefinition: readProductionScenario,
            }
          : { kind: "local" },
        this.state.rackCase,
      );
      if (this.mounted && generation === this.generation)
        this.update({
          pending,
          notice:
            "File checked. Review and confirm below; the current run is unchanged.",
        });
    } catch (error) {
      if (this.mounted && generation === this.generation)
        this.update({ notice: message(error) });
    } finally {
      if (this.mounted && generation === this.generation)
        this.update({ reading: false });
    }
  }
  // Prepare acceptance and its successor together, then commit against this plan.
  private async acceptResult(
    pending: Variant<Pending, "recording">,
  ): Promise<void> {
    if (this.props.session.data.kind !== "ready") return;
    const plan = this.props.session.data.plan;
    const generation = ++this.generation;
    this.props.playback.pause();
    const bound = await acceptProductionCandidate(plan, pending);
    if (
      !this.mounted ||
      generation !== this.generation ||
      this.props.session.data.kind !== "ready" ||
      this.props.session.data.plan !== plan
    )
      return;
    if (bound.kind === "rejected") {
      this.update({ pending: { kind: "none" }, notice: bound.message });
      return;
    }
    this.props.authored({
      kind: "acceptRecording",
      target: {
        kind: "production",
        candidate: pending,
        accepted: { from: plan, plan: bound.plan },
      },
    });
    this.fileInput.current?.focus();
  }
  private exportHandoff(): void {
    this.downloadFile("handoff");
  }
  private startFromConversion(): void {
    this.update({
      readOnly: [],
      notice:
        "Started a new rehearsal from the converted run. It no longer includes what was not carried forward.",
    });
  }
  private resolveRunOpen(
    review: WorkspaceRunReview,
    decision: "apply" | "discard",
  ): void {
    this.generation++;
    this.props.playback.pause();
    this.props.authored({
      kind: "workspaceRunOpenResolved",
      review,
      decision,
    });
  }
  private accept(): void {
    if (this.props.session.data.kind !== "ready") return;
    const pending = this.props.session.pending;
    if (pending.kind === "none") return;
    if (pending.kind === "run") {
      this.resolveRunOpen(pending.review, "apply");
      return;
    }
    void this.acceptResult(pending);
  }
  private discardRecording(): void {
    if (this.props.session.pending.kind !== "recording") return;
    this.generation++;
    this.props.authored({
      kind: "productionCandidateDiscarded",
      candidate: this.props.session.pending,
    });
    this.fileInput.current?.focus();
  }
  private captureComparison(result: FactoryResult): void {
    const comparisons: FactoryResult[] = [];
    for (const previous of this.state.comparisons)
      if (previous.identity !== result.identity) comparisons.push(previous);
    comparisons.push(result);
    this.setState({ comparisons });
  }
  private clearComparisons(): void {
    this.setState({ comparisons: [] });
  }
  private recipeWorkspaceFor = {
    connection: null as SimulatorConnection | null,
    value: null as RecipeWorkspace | null,
  };
  /** One value for one connection, so the recipe views keep their context. */
  private recipeWorkspace(): RecipeWorkspace | null {
    const { connection } = this.props;
    if (this.recipeWorkspaceFor.connection !== connection)
      this.recipeWorkspaceFor = {
        connection,
        value:
          connection.kind === "workspace"
            ? {
                organisationId: connection.organisationId,
                canManage: connection.canManage,
                mutate: connection.mutate,
                chatPath: connection.chatPath,
              }
            : null,
      };
    return this.recipeWorkspaceFor.value;
  }
  render(): React.ReactNode {
    return (
      <RecipeWorkspaceContext.Provider value={this.recipeWorkspace()}>
        {this.renderSurface()}
      </RecipeWorkspaceContext.Provider>
    );
  }
  private renderSurface(): React.ReactNode {
    if (this.state.siphon !== null)
      return (
        <Views.SiphonWorkspace
          recipe={this.state.siphon}
          close={this.closeSiphon.bind(this)}
        />
      );
    if (this.state.latte !== null)
      return (
        <Views.LatteWorkspace
          recipe={this.state.latte}
          close={this.closeLatte.bind(this)}
        />
      );
    if (this.state.blackSesame !== null)
      return (
        <Views.BlackSesameWorkspace
          recipe={this.state.blackSesame}
          close={this.closeBlackSesame.bind(this)}
        />
      );
    if (this.state.gingerTea !== null)
      return (
        <Views.GingerTeaWorkspace
          recipe={this.state.gingerTea}
          close={this.closeGingerTea.bind(this)}
        />
      );
    if (this.state.financierBatter !== null)
      return (
        <Views.FinancierBatterWorkspace
          recipe={this.state.financierBatter}
          close={this.closeFinancierBatter.bind(this)}
          applyToSchedule={this.applyFinancierBatterToSchedule.bind(this)}
        />
      );
    if (this.state.financierBake !== null)
      return (
        <Views.FinancierBakeWorkspace
          recipe={this.state.financierBake}
          close={this.closeFinancierBake.bind(this)}
          applyToSchedule={this.applyFinancierBakeToSchedule.bind(this)}
        />
      );
    if (this.state.financierPack !== null)
      return (
        <Views.FinancierPackWorkspace
          recipe={this.state.financierPack}
          close={this.closeFinancierPack.bind(this)}
          applyToSchedule={this.applyFinancierPackToSchedule.bind(this)}
        />
      );
    if (this.state.pastryBench !== null)
      return (
        <Views.PastryBenchWorkspace
          organisationId={
            this.props.connection.kind === "workspace"
              ? this.props.connection.organisationId
              : undefined
          }
          recipe={this.state.pastryBench}
          close={this.closePastryBench.bind(this)}
        />
      );
    if (this.state.cafeShift !== null)
      return (
        <Views.CafeShiftWorkspace
          recipe={this.state.cafeShift}
          close={this.closeCafeShift.bind(this)}
          applyToSchedule={this.applyCafeShiftToSchedule.bind(this)}
        />
      );
    if (this.state.oven !== null)
      return (
        <Views.OvenWorkspace
          source={this.state.oven}
          comparisons={this.state.comparisons}
          captureComparison={this.captureComparison.bind(this)}
          clearComparisons={this.clearComparisons.bind(this)}
          connection={this.props.connection}
          saveStatus={this.props.persistentSaveStatus}
          saveChanged={this.props.saveChanged}
          close={this.closeOven.bind(this)}
        />
      );
    const data = this.props.session.data;
    const activePanel =
      this.props.session.panel === "timeline"
        ? "workflow"
        : this.props.session.panel;
    const timelineOpen =
      this.state.timelineOpen || this.props.session.panel === "timeline";
    return (
      <section
        className="production-workspace"
        aria-label={
          this.props.session.procedure === "rehearsal"
            ? "Multi-tray rehearsal"
            : "Multi-batch production"
        }
      >
        <div
          className="production-scene"
          data-scene-status={this.props.session.scene}
          ref={this.host}
        />
        <header className="production-topbar">
          <div className="production-topbar-row">
            <h2 ref={this.heading} tabIndex={-1}>
              {this.props.session.procedure === "rehearsal"
                ? "Multi-tray rehearsal + Robot"
                : "Multi-batch production + Robot"}
            </h2>
            <nav aria-label="Production workcell views">
              <button
                type="button"
                aria-pressed={
                  !this.state.panelHidden && activePanel === "workflow"
                }
                onClick={this.selectPanel.bind(this, "workflow")}
              >
                Workflow
              </button>
              <button
                type="button"
                className="production-sr-alias"
                tabIndex={-1}
                aria-pressed={
                  !this.state.panelHidden && activePanel === "author"
                }
                onClick={this.selectPanel.bind(this, "author")}
              >
                Inputs
              </button>
              <button
                type="button"
                className="production-sr-alias"
                tabIndex={-1}
                onClick={this.selectPanel.bind(this, "author")}
              >
                {this.props.session.procedure === "rehearsal"
                  ? "Edit trays"
                  : "Edit scenario"}
              </button>
              <button
                type="button"
                aria-pressed={
                  !this.state.panelHidden &&
                  (activePanel === "details" || activePanel === "author")
                }
                onClick={this.selectPanel.bind(this, "details")}
              >
                Details
              </button>
              <button
                type="button"
                aria-pressed={
                  !this.state.panelHidden && activePanel === "files"
                }
                onClick={this.selectPanel.bind(this, "files")}
              >
                Files
              </button>
              <button
                type="button"
                className="production-sr-alias"
                tabIndex={-1}
                onClick={this.props.close}
              >
                Back to examples
              </button>
            </nav>
            <SimulatorHistoryControls />
          </div>
        </header>
        <div
          ref={this.panelBox}
          className="production-panel"
          data-panel={activePanel}
          hidden={this.state.panelHidden}
          style={{
            ...(this.state.panelWidth !== null
              ? {
                  width: `${this.state.panelWidth}px`,
                  maxWidth: "calc(100vw - 24px)",
                }
              : null),
            ...(this.state.panelHeight !== null
              ? {
                  height: `${this.state.panelHeight}px`,
                  maxHeight: "calc(100vh - 130px)",
                }
              : null),
          }}
        >
          <div className="production-panel-scroll">
            <p
              role="status"
              className="production-notice"
              data-default={isDefaultProductionNotice(
                this.props.session.notice,
              )}
            >
              {this.props.session.notice}
            </p>
            {this.props.session.scene === "unavailable" && (
              <p>
                3D unavailable. Workflow, Timeline, Details and file controls
                remain usable.
              </p>
            )}
            {!this.state.panelHidden && data.kind === "ready" && (
              <div
                key={`${activePanel}-${this.state.authorRoute}`}
                className="production-panel-stage"
                data-direction={this.state.transitionDirection}
              >
                {this.content(data)}
              </div>
            )}
          </div>
          <div
            className="production-panel-resizer-x"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel width"
            title="Drag to resize width (double-click to reset)"
            onPointerDown={this.startPanelResize.bind(this, "x")}
            onDoubleClick={this.resetPanelSize.bind(this)}
          />
          <div
            className="production-panel-resizer-y"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize panel height"
            title="Drag to resize height (double-click to reset)"
            onPointerDown={this.startPanelResize.bind(this, "y")}
            onDoubleClick={this.resetPanelSize.bind(this)}
          />
          <div
            className="production-panel-resizer-corner"
            aria-hidden="true"
            title="Drag to resize panel (double-click to reset)"
            onPointerDown={this.startPanelResize.bind(this, "xy")}
            onDoubleClick={this.resetPanelSize.bind(this)}
          />
        </div>
        <div className="production-bottom-row">
          {data.kind === "ready" && (
            <footer
              className="production-bottom-bar"
              data-timeline-open={timelineOpen}
            >
              <div
                className="production-timeline-shell"
                data-open={timelineOpen}
              >
                <div className="production-timeline-inner">
                  {this.timelineDrawer(data)}
                </div>
              </div>
              <div className="production-transport-row">
                {this.browserExecution(data)}
                <button
                  type="button"
                  className="production-play-button"
                  onClick={this.props.playback.toggle}
                >
                  {this.props.session.cursor.playback === "playing"
                    ? "Pause"
                    : "Play production"}
                </button>
                <div className="production-scrubber">
                  <strong>
                    <PlaybackTimeText text={secondsText} /> /{" "}
                    {data.run.end.toFixed(2)} s · {metrics(data.run).unfinished}{" "}
                    unfinished
                  </strong>
                  <label>
                    <span className="production-sr-only">Production time</span>
                    <PlaybackScrubber
                      aria-label="Production time"
                      min="0"
                      end={data.run.end}
                      step="any"
                      onChange={this.scrub.bind(this)}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="production-timeline-toggle"
                  aria-expanded={timelineOpen}
                  onClick={this.toggleTimeline.bind(this)}
                >
                  <span>Timeline</span>
                  <span aria-hidden="true">{timelineOpen ? "▾" : "▴"}</span>
                </button>
              </div>
            </footer>
          )}
          <div
            className="production-camera-bar workflow-scene-controls"
            role="group"
            aria-label="Camera controls"
          >
            <button
              type="button"
              aria-label="Recenter camera"
              data-tooltip="Recenter camera"
              disabled={this.props.session.scene !== "ready"}
              onClick={this.resetCamera.bind(this)}
            >
              <LocateFixed aria-hidden="true" />
            </button>
            <div className="workflow-scene-control-group">
              <BakeryAppearanceControl />
              <button
                type="button"
                aria-label="Top view"
                data-tooltip="Top view"
                disabled={this.props.session.scene !== "ready"}
                aria-pressed={this.props.cameraView.camera === "overhead"}
                onClick={this.toggleCamera.bind(this)}
              >
                <MapIcon aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }
  private timelineDrawer(data: Ready): React.ReactNode {
    return (
      <section
        className="production-timeline-drawer"
        aria-label="Shared resource timeline"
      >
        <div className="production-timeline-header">
          <h3>Shared resource timeline</h3>
        </div>
        <div className="production-timeline-tracks">
          {data.run.batches.map(this.track.bind(this, data.run))}
          {data.run.resources.map(this.workerTrack.bind(this, data.run))}
          <NativeTimelineTrack
            run={data.run}
            time={this.props.session.cursor.time}
            selection={this.props.session.selection}
            onSeek={this.inspect.bind(this)}
          />
          {data.run.nativeHolds.map(this.hold.bind(this))}
          {data.run.unresolvedWaits.map(
            this.unresolvedWait.bind(this, data.run),
          )}
        </div>
      </section>
    );
  }
  private executing(): boolean {
    return (
      this.props.browserJob.kind === "loading" ||
      this.props.browserJob.kind === "running"
    );
  }
  private browserExecution(data: Ready): React.ReactNode {
    const next = nextProductionExecution(data.plan, data.run);
    const executing = this.executing();
    const readOnly = this.props.session.readOnly;
    let status: string;
    let idle = false;
    if (readOnly.length > 0)
      status = `Read-only conversion. ${readOnly.join(" ")} Start a new rehearsal from it in Edit trays to run it.`;
    else if (this.props.browserJob.kind === "failed")
      status = this.props.browserJob.message;
    else if (executing)
      status = `Running MuJoCo in this browser${jobStepLabel(this.props.browserJob.steps)}. Each accepted result updates the production run.`;
    else if (this.props.browserNotice !== "") status = this.props.browserNotice;
    else if (next.kind !== "execute") status = next.message;
    else {
      status =
        "Run in browser executes each native operation when the scheduler dispatches it.";
      idle = true;
    }
    return (
      <div className="production-browser-run" aria-label="Browser execution">
        {executing ? (
          <button
            type="button"
            className="production-primary"
            onClick={this.props.stopSimulation}
          >
            Stop simulation
          </button>
        ) : (
          <button
            type="button"
            className="production-primary"
            disabled={
              next.kind !== "execute" ||
              readOnly.length > 0 ||
              this.props.session.reading ||
              this.props.session.pending.kind !== "none" ||
              this.props.session.rehearsalReview !== null ||
              this.props.session.replacement !== null
            }
            onClick={this.runInBrowser.bind(this)}
          >
            Run in browser
          </button>
        )}
        <p role="status" data-idle={idle}>
          {status}
        </p>
      </div>
    );
  }
  private runInBrowser(): void {
    this.props.playback.pause();
    this.props.runInBrowser();
  }
  private catalogSectionContent(): React.ReactNode {
    switch (this.state.catalogSection) {
      case null:
      case "active-production":
      case "rehearsal-production":
        return null;
      case "siphon":
        return <SiphonRecipeAuthor prepared={this.showSiphon.bind(this)} />;
      case "espresso":
        return <EspressoRecipeAuthor prepared={this.showOven.bind(this)} />;
      case "latte":
        return <LatteRecipeAuthor prepared={this.showLatte.bind(this)} />;
      case "black-sesame":
        return (
          <div className="production-subview-stack">
            <BlackSesameCobotRecipeAuthor
              prepared={this.showBlackSesame.bind(this)}
            />
            <BlackSesameRecipeAuthor prepared={this.showOven.bind(this)} />
          </div>
        );
      case "ginger-tea":
        return (
          <div className="production-subview-stack">
            <GingerTeaCobotRecipeAuthor
              prepared={this.showGingerTea.bind(this)}
            />
            <GingerTeaRecipeAuthor prepared={this.showOven.bind(this)} />
            <GingerMilkTeaRecipeAuthor prepared={this.showOven.bind(this)} />
          </div>
        );
      case "financier-batter":
        return (
          <FinancierBatterRecipeAuthor
            prepared={this.showFinancierBatter.bind(this)}
          />
        );
      case "financier-bake":
        return (
          <FinancierBakeRecipeAuthor
            prepared={this.showFinancierBake.bind(this)}
          />
        );
      case "financier-pack":
        return (
          <FinancierPackRecipeAuthor
            prepared={this.showFinancierPack.bind(this)}
          />
        );
      case "pastry-bench":
        return (
          <PastryBenchRecipeAuthor prepared={this.showPastryBench.bind(this)} />
        );
      case "cafe-shift":
        return (
          <div className="production-subview-stack">
            <BakeryShiftAuthor prepared={this.showOven.bind(this)} />
            <CafeShiftRecipeAuthor prepared={this.showCafeShift.bind(this)} />
            <ColdCellRouteAuthor prepared={this.showOven.bind(this)} />
          </div>
        );
      case "pour-over":
        return <PourOverRecipeAuthor prepared={this.showOven.bind(this)} />;
      case "appliance-rehearsals":
        return (
          <div className="production-subview-stack">
            <section aria-label="Café appliance rehearsals">
              <h3>Linea Classic S · two groups</h3>
              <p>
                Rehearse doses, cup handling and recovery with the shared
                Rust/MuJoCo runner. Physical values remain uncalibrated.
              </p>
              <a
                href={
                  this.props.connection.kind === "workspace"
                    ? `/linea-rehearsal.html?organisation=${encodeURIComponent(this.props.connection.organisationId)}`
                    : "/linea-rehearsal.html"
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Linea rehearsal
              </a>
            </section>
            <section aria-label="Eagle One appliance rehearsal">
              <h3>Eagle One · two groups</h3>
              <p>
                Rehearse heating, extraction, guided portafilter handling and
                water-loss recovery. Save locally or to the current workspace.
              </p>
              <a
                href={
                  this.props.connection.kind === "workspace"
                    ? `/eagle-rehearsal.html?organisation=${encodeURIComponent(this.props.connection.organisationId)}`
                    : "/eagle-rehearsal.html"
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Eagle One rehearsal
              </a>
            </section>
          </div>
        );
      case "shared-runs":
        return this.props.connection.kind === "workspace" ? (
          <WorkspaceRunsPanel
            connection={this.props.connection}
            kind="persistent-production"
            source={null}
            proposal={null}
            saveStatus={this.props.persistentSaveStatus}
            saveChanged={this.props.saveChanged}
            open={this.openSharedProduction.bind(this)}
          />
        ) : null;
    }
  }
  private catalogSectionTierLabel(): string {
    switch (this.state.catalogSection) {
      case "appliance-rehearsals":
        return "Isolated action";
      case "siphon":
      case "pour-over":
      case "espresso":
      case "latte":
      case "black-sesame":
      case "ginger-tea":
      case "financier-batter":
      case "financier-bake":
      case "financier-pack":
      case "pastry-bench":
        return "Complete task";
      case "active-production":
      case "rehearsal-production":
        return this.props.session.procedure === "rehearsal"
          ? "Isolated action"
          : "Autonomous loop";
      case "cafe-shift":
      case "shared-runs":
        return "Autonomous loop";
      case null:
        return "Workflow";
    }
  }
  private catalogMenuList(data: Ready): React.ReactNode {
    const batchSummary = data.run.batches
      .map((batch) => workName(data.run, batch.id))
      .join(" → ");
    const processStepCount = data.run.intervals.filter(
      (interval) => interval.kind === "process",
    ).length;
    return (
      <>
        <div className="production-catalog-groups">
          <section className="production-catalog-group">
            <header className="production-catalog-group-header">
              <span className="production-tier-badge" data-tier="action">
                Tier 1 · Action
              </span>
              <h4>Isolated actions &amp; calibration</h4>
              <p>Refine a single robot transfer or appliance cycle.</p>
            </header>
            <div className="production-menu-list">
              {this.props.session.procedure === "rehearsal" && (
                <button
                  type="button"
                  className="production-menu-item production-catalog-card"
                  onClick={this.openCatalogSection.bind(
                    this,
                    "active-production",
                  )}
                >
                  <div className="production-catalog-card-body">
                    <strong>Multi-tray robot rehearsal ({batchSummary})</strong>
                    <small>
                      Active 3D tray rehearsal &amp; rack handoff calibration
                    </small>
                  </div>
                  <span className="production-menu-chevron" aria-hidden="true">
                    ›
                  </span>
                </button>
              )}
              <button
                type="button"
                className="production-menu-item production-catalog-card"
                onClick={this.openCatalogSection.bind(
                  this,
                  "appliance-rehearsals",
                )}
              >
                <div className="production-catalog-card-body">
                  <strong>Standalone appliance rehearsals</strong>
                  <small>
                    Linea Classic S &amp; Eagle One group head calibration
                  </small>
                </div>
                <span className="production-menu-chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            </div>
          </section>

          <CompleteRecipeTaskCatalog
            openCatalogSection={this.openCatalogSection.bind(this)}
          />

          <section className="production-catalog-group">
            <header className="production-catalog-group-header">
              <span className="production-tier-badge" data-tier="loop">
                Tier 3 · Autonomous Loop
              </span>
              <h4>Multi-task factory loops &amp; shifts</h4>
              <p>
                Compositions of tasks that loop to test autonomous throughput.
              </p>
            </header>
            <div className="production-menu-list">
              {this.props.session.procedure !== "rehearsal" && (
                <button
                  type="button"
                  className="production-menu-item production-catalog-card"
                  onClick={this.openCatalogSection.bind(
                    this,
                    "active-production",
                  )}
                >
                  <div className="production-catalog-card-body">
                    <strong>
                      Multi-batch production + Robot ({batchSummary})
                    </strong>
                    <small>
                      3-batch autonomous pipeline · {processStepCount} process
                      steps &amp; robot tray handoffs
                    </small>
                  </div>
                  <span className="production-menu-chevron" aria-hidden="true">
                    ›
                  </span>
                </button>
              )}
              <button
                type="button"
                className="production-menu-item production-catalog-card"
                onClick={this.openCatalogSection.bind(this, "cafe-shift")}
              >
                <div className="production-catalog-card-body">
                  <strong>
                    Combined Café Shift · Financiers &amp; Espresso (Plan 61E)
                  </strong>
                  <small>
                    Baker FR10 #1 + Barista FR10 #2 · Matsunaga 8P loads &amp;
                    Linea / Eagle One service
                  </small>
                </div>
                <span className="production-menu-chevron" aria-hidden="true">
                  ›
                </span>
              </button>
              {this.props.connection.kind === "workspace" && (
                <button
                  type="button"
                  className="production-menu-item production-catalog-card"
                  onClick={this.openCatalogSection.bind(this, "shared-runs")}
                >
                  <div className="production-catalog-card-body">
                    <strong>Shared production runs</strong>
                    <small>
                      Open or compare saved workspace factory recordings
                    </small>
                  </div>
                  <span className="production-menu-chevron" aria-hidden="true">
                    ›
                  </span>
                </button>
              )}
            </div>
          </section>
        </div>
        {this.state.comparisons.length > 0 && (
          <FactoryComparison
            results={this.state.comparisons}
            current={null}
            capture={this.captureComparison.bind(this)}
            clear={this.clearComparisons.bind(this)}
          />
        )}
        <label className="production-file-picker">
          <span className="production-file-picker-title">
            Open recipe, oven route or saved production run
          </span>
          <span className="production-file-picker-hint">
            Import a .json definition or recorded run file
          </span>
          <input
            type="file"
            accept=".json,application/json"
            disabled={
              this.props.session.openingDefinition ||
              this.props.session.savingDefinition
            }
            onChange={this.openOvenFile.bind(this)}
          />
        </label>
      </>
    );
  }
  private content(data: Ready): React.ReactNode {
    switch (this.props.session.panel) {
      case "workflow":
      case "timeline": {
        const activeBatch =
          this.state.activeBatchId === null
            ? undefined
            : data.run.batches.find(
                batchWithId.bind(null, this.state.activeBatchId),
              );
        const depth =
          activeBatch !== undefined
            ? 2
            : this.state.catalogSection !== null
              ? 1
              : 0;
        const showActiveProduction =
          this.state.catalogSection === null ||
          this.state.catalogSection === "active-production" ||
          this.state.catalogSection === "rehearsal-production";
        return (
          <div className="production-menu-viewport">
            <div
              className="production-menu-track production-menu-track-3"
              data-depth={depth}
            >
              <div className="production-menu-page" data-active={depth === 0}>
                <div className="production-section-header">
                  <h3>Workflow</h3>
                  <span className="production-section-hint">
                    Choose a workflow
                  </span>
                </div>
                {this.catalogMenuList(data)}
              </div>
              <div className="production-menu-page" data-active={depth === 1}>
                <div className="production-section-header">
                  <button
                    type="button"
                    className="production-menu-back"
                    onClick={this.goBack.bind(this)}
                  >
                    ← Back
                  </button>
                  <span className="production-tier-badge">
                    {showActiveProduction
                      ? data.run.batches
                          .map((batch) => workName(data.run, batch.id))
                          .join(" → ")
                      : this.catalogSectionTierLabel()}
                  </span>
                </div>
                {showActiveProduction ? (
                  this.hybridBatchChain(data)
                ) : (
                  <div className="production-menu-subview">
                    {this.catalogSectionContent()}
                  </div>
                )}
              </div>
              <div className="production-menu-page" data-active={depth === 2}>
                <div className="production-section-header">
                  <button
                    type="button"
                    className="production-menu-back"
                    onClick={this.goBack.bind(this)}
                  >
                    ← Back
                  </button>
                  {activeBatch !== undefined && (
                    <span className="production-section-hint">
                      {batchTitle(data.run, activeBatch)}
                    </span>
                  )}
                </div>
                {activeBatch !== undefined &&
                  this.batchDetail(data.run, activeBatch)}
              </div>
            </div>
          </div>
        );
      }
      case "author":
        return this.props.session.procedure === "rehearsal"
          ? this.rehearsalAuthor(data)
          : this.author(data);
      case "details":
        return this.details(data.run);
      case "files": {
        const operations = data.plan.operations.map(
          operationChoice.bind(null, data.plan.procedure),
        );
        return (
          <>
            <div className="production-section-header">
              <button
                type="button"
                className="production-menu-back"
                onClick={this.goBack.bind(this)}
              >
                ← Back
              </button>
              <h3>Files</h3>
            </div>
            <fieldset className="production-assignment">
              <legend>Export</legend>
              <label>
                Native operation
                <Select.Root
                  items={operations}
                  value={this.props.session.operationId}
                  disabled={this.props.session.reading}
                  onValueChange={this.operation.bind(this)}
                >
                  <Select.Trigger>
                    <Select.Value placeholder="Choose an operation" />
                  </Select.Trigger>
                  <Select.Popup>{operations.map(renderItem)}</Select.Popup>
                </Select.Root>
              </label>
              <div className="production-author-actions">
                <button type="button" onClick={this.request.bind(this)}>
                  Export native request
                </button>
                {this.selectedOperation()?.start.kind === "continuation" && (
                  <button type="button" onClick={this.exportHandoff.bind(this)}>
                    Export resume handoff
                  </button>
                )}
                <button type="button" onClick={this.save.bind(this)}>
                  Save production run
                </button>
              </div>
            </fieldset>
            <fieldset className="production-assignment">
              <legend>Import</legend>
              <label>
                Open production run or native recording
                <input
                  ref={this.fileInput}
                  type="file"
                  accept=".json,application/json"
                  disabled={this.props.session.reading}
                  onChange={this.open.bind(this)}
                />
              </label>
              {this.props.session.pending.kind === "run" && (
                <section
                  className="workcell-save-review"
                  aria-label="Review saved run"
                >
                  <h4 ref={this.runReviewHeading} tabIndex={-1}>
                    Review saved run
                  </h4>
                  <p>
                    {this.props.session.pending.review.savedRun?.name ??
                      "Imported run"}
                  </p>
                  {this.props.session.pending.review.savedRun !== null && (
                    <code>{this.props.session.pending.review.savedRun.id}</code>
                  )}
                  <p>
                    Replace the current setup and its{" "}
                    {acceptedProductionResults(
                      this.props.session.pending.review.from.plan,
                    )}{" "}
                    accepted results with this saved setup and its{" "}
                    {acceptedProductionResults(
                      this.props.session.pending.review.plan,
                    )}{" "}
                    accepted results?
                  </p>
                  <div className="production-author-actions">
                    <button onClick={this.accept.bind(this)}>
                      Use saved production run
                    </button>
                    <button
                      onClick={this.resolveRunOpen.bind(
                        this,
                        this.props.session.pending.review,
                        "discard",
                      )}
                    >
                      Keep current run
                    </button>
                  </div>
                </section>
              )}
              {this.props.session.pending.kind === "recording" && (
                <section
                  className="workcell-save-review"
                  aria-labelledby="production-recording-review-heading"
                >
                  <h4
                    id="production-recording-review-heading"
                    ref={this.recordingHeading}
                    tabIndex={-1}
                  >
                    Review native result
                  </h4>
                  <p>
                    This result matches operation{" "}
                    {this.props.session.pending.operationId}. The current
                    production run is unchanged until you accept it.
                  </p>
                  <RecordingCandidatePreview
                    recording={this.props.session.pending.recording}
                  />
                  <div className="production-author-actions">
                    <button type="button" onClick={this.accept.bind(this)}>
                      Accept matching native result
                    </button>
                    <button
                      type="button"
                      onClick={this.discardRecording.bind(this)}
                    >
                      Keep current production run
                    </button>
                  </div>
                </section>
              )}
            </fieldset>
            {this.props.session.procedure === "rehearsal" &&
              this.props.connection.kind === "workspace" && (
                <WorkspaceRunsPanel
                  kind="rehearsal-run"
                  connection={this.props.connection}
                  saveStatus={this.props.saveStatus}
                  proposal={this.props.runSaveProposal}
                  saveChanged={this.props.saveChanged}
                  source={
                    this.props.session.readOnly.length > 0 ? null : data.plan
                  }
                  open={this.props.prepareRunOpen}
                />
              )}
            {this.props.session.procedure === "financier" &&
              this.props.connection.kind === "workspace" && (
                <WorkspaceRunsPanel
                  kind="production"
                  connection={this.props.connection}
                  saveStatus={this.props.saveStatus}
                  proposal={null}
                  saveChanged={this.props.saveChanged}
                  source={data.plan}
                  open={this.props.prepareRunOpen}
                />
              )}
          </>
        );
      }
    }
  }
  private hybridBatchChain(data: Ready): React.ReactNode {
    const knownBatchIds = new Set(data.run.batches.map((b) => b.id));
    const orphanOperations = data.plan.operations.filter(
      (op) => !knownBatchIds.has(op.batchId),
    );
    const orphanPlanned = data.plan.planned.filter(
      (op) => !knownBatchIds.has(op.batchId),
    );
    const {
      calibratedBatter,
      calibratedBake,
      calibratedPack,
      handoffRecoveryPreset,
    } = this.state;
    const hasTier2Calibration =
      calibratedBatter !== null ||
      calibratedBake !== null ||
      calibratedPack !== null ||
      handoffRecoveryPreset !== "nominal-handoff";
    const activeSettings = data.plan.settings;
    const activeHandoff = buildFinancierHandoffRecovery(handoffRecoveryPreset);
    const gatedHandoffCount = data.plan.operations.filter(
      (op) => op.dependsOn.length > 0 || op.earliestStartSeconds > 0,
    ).length;
    return (
      <div
        className="production-hybrid-list"
        role="group"
        aria-label="Native task canvas"
      >
        <section
          className="production-hybrid-card"
          aria-label="Tier 2 Financier calibration"
          data-tier2-calibrated={hasTier2Calibration ? "true" : "false"}
          data-handoff-recovery-preset={handoffRecoveryPreset}
        >
          <header className="production-hybrid-card-header">
            <div className="production-hybrid-card-title">
              <span className="production-tier-badge" data-tier="task">
                {hasTier2Calibration
                  ? "Tier 2 → Tier 3 Calibrated"
                  : "Tier 2 ↔ Tier 3 Handoff Preset"}
              </span>
              <span className="production-hybrid-status">
                {activeSettings.traysPerBatch} trays/batch ·{" "}
                {activeSettings.piecesPerTray} pcs/tray · Stage{" "}
                {activeSettings.stage}m · Portion {activeSettings.portion}m ·
                Bake {activeSettings.bake}m · Cool {activeSettings.cool}m · Pack{" "}
                {activeSettings.pack}m
              </span>
            </div>
          </header>
          <dl className="production-details-dl">
            {calibratedBatter !== null && (
              <>
                <dt>Financier Batter</dt>
                <dd>
                  {calibratedBatter.totalBatterG.toFixed(1)} g (
                  {calibratedBatter.mouldCavitiesYield} cavities @ 25 g ·{" "}
                  {calibratedBatter.emulsificationPct}% homogenized)
                </dd>
              </>
            )}
            {calibratedBake !== null && (
              <>
                <dt>Financier Bake</dt>
                <dd>
                  {calibratedBake.bakedFinanciersG.toFixed(1)} g (
                  {calibratedBake.acceptedPieces} pcs @{" "}
                  {calibratedBake.pieceMassG.toFixed(1)} g ·{" "}
                  {calibratedBake.peakOvenTempC.toFixed(0)} °C MBCO-5E)
                </dd>
              </>
            )}
            {calibratedPack !== null && (
              <>
                <dt>Financier Pack</dt>
                <dd>
                  {calibratedPack.packedNetMassG.toFixed(1)} g net (
                  {calibratedPack.packedPieces} packed +{" "}
                  {calibratedPack.crumbSampleG.toFixed(1)} g crumb check)
                </dd>
              </>
            )}
            <dt>Cell Handoff Recovery</dt>
            <dd>
              {activeHandoff.summary} ({gatedHandoffCount} gated robot cell
              handoff{gatedHandoffCount === 1 ? "" : "s"})
            </dd>
          </dl>
          <label className="production-handoff-preset-control">
            Fault-recovery calibration preset (Tier 2 Bake ↔ Tier 3 robot cell
            handoffs)
            <Select.Root
              items={HANDOFF_PRESETS}
              value={handoffRecoveryPreset}
              onValueChange={(v) => {
                if (v === null) return;
                const next: FinancierHandoffRecoveryPreset =
                  v === "carrier-slip-recovery" ||
                  v === "cell-2-restage-recovery"
                    ? v
                    : "nominal-handoff";
                this.applyHandoffRecoveryPreset(next);
              }}
            >
              <Select.Trigger aria-label="Tier 2 to Tier 3 handoff fault-recovery preset">
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{HANDOFF_PRESETS.map(renderItem)}</Select.Popup>
            </Select.Root>
          </label>
        </section>
        {data.run.batches.map((batch, index) => (
          <React.Fragment key={batch.id}>
            {index === 1 && (
              <div className="production-hybrid-connector" aria-hidden="true">
                <span>
                  ↓ Hand-off &amp; shared station queue (Portioning, Oven, Robot
                  cell)
                </span>
              </div>
            )}
            {this.hybridBatchCard(data, batch, index)}
          </React.Fragment>
        ))}
        {(orphanOperations.length > 0 || orphanPlanned.length > 0) && (
          <div className="production-canvas">
            {orphanOperations.map(this.nativeCanvasNode.bind(this, data))}
            {orphanPlanned.map(this.plannedCanvasNode.bind(this))}
          </div>
        )}
      </div>
    );
  }
  private hybridBatchCard(
    data: Ready,
    batch: Batch,
    index: number,
  ): React.ReactNode {
    const run = data.run;
    const allIntervals = run.intervals.filter(batchTask.bind(null, batch.id));
    const primarySteps = allIntervals.filter(
      (interval) => interval.kind === "process",
    );
    const displaySteps = primarySteps.length > 0 ? primarySteps : allIntervals;
    const waits = batchWaits(run, batch.id);
    const totalWaitSeconds = Math.round(
      waits.reduce((sum, item) => sum + item.seconds, 0),
    );
    const batchOperations = data.plan.operations.filter(
      inBatch.bind(null, batch.id),
    );
    const batchPlanned = data.plan.planned.filter(
      (item) => item.batchId === batch.id,
    );
    const states = allIntervals.flatMap((interval) =>
      interval.kind === "wait"
        ? []
        : [taskAt(run, interval, this.props.session.cursor.time).kind],
    );
    const hasRunning = states.includes("running");
    const allCompleted =
      allIntervals.length > 0 && states.every((state) => state === "completed");
    const badgeState = allCompleted
      ? "completed"
      : index === 0 && hasRunning
        ? "running"
        : index === 1 && waits.length > 0
          ? "waiting"
          : "queued";
    const workerFlow = batchWorkerFlow(run, displaySteps);
    const previousBatch = index > 0 ? run.batches[index - 1] : undefined;
    const headerStatus =
      previousBatch !== undefined
        ? `Follows ${workName(run, previousBatch.id)}${workerFlow ? ` · ${workerFlow}` : ""}`
        : `${allCompleted ? "Completed" : hasRunning ? "Running" : "Queued"}${workerFlow ? ` · ${workerFlow}` : ""}`;
    const waitSummaryText =
      waits.length === 0
        ? null
        : waits.length === 1
          ? `1 wait (${totalWaitSeconds} s at ${shortStationName(waits[0]!.first.station)})`
          : `${waits.length} waits (${totalWaitSeconds} s total)`;
    return (
      <section className="production-hybrid-card" data-state={badgeState}>
        <header className="production-hybrid-card-header">
          <div className="production-hybrid-card-title">
            <span className="production-hybrid-badge" data-state={badgeState}>
              {index + 1} · {workName(run, batch.id)}
            </span>
            <span className="production-hybrid-status">{headerStatus}</span>
          </div>
          <div className="production-hybrid-header-meta">
            {waitSummaryText !== null && (
              <span
                className="production-hybrid-wait-summary"
                data-multi={waits.length > 1}
              >
                {waitSummaryText}
              </span>
            )}
            <button
              type="button"
              className="production-hybrid-more"
              onClick={this.openBatch.bind(this, batch.id)}
            >
              <span>All {allIntervals.length} steps</span>
              <span aria-hidden="true">›</span>
            </button>
          </div>
        </header>

        {displaySteps.length > 0 && (
          <div className="production-hybrid-steps">
            {displaySteps.map((interval, stepIndex) =>
              this.hybridStepChip(
                run,
                batch.id,
                displaySteps,
                interval,
                stepIndex,
              ),
            )}
          </div>
        )}

        {(batchOperations.length > 0 || batchPlanned.length > 0) && (
          <div className="production-hybrid-trays">
            {batchOperations.map(this.nativeCanvasNode.bind(this, data))}
            {batchPlanned.map(this.plannedCanvasNode.bind(this))}
          </div>
        )}
      </section>
    );
  }
  private hybridStepChip(
    run: Run,
    batchId: string,
    steps: readonly Interval[],
    interval: Interval,
    stepIndex: number,
  ): React.ReactNode {
    if (interval.kind === "wait") return null;
    let workerName = "Unattended";
    if (interval.attended)
      workerName = humanResource(run, interval.executor).name;
    else if (interval.kind === "native")
      workerName = interval.operation.attempt.input.bindings.cell;
    const rawState = taskAt(run, interval, this.props.session.cursor.time).kind;
    const stationWait = stationWaitForStep(run, batchId, interval.station);
    const prevStep = stepIndex > 0 ? steps[stepIndex - 1] : undefined;
    const prevState =
      prevStep !== undefined && prevStep.kind !== "wait"
        ? taskAt(run, prevStep, this.props.session.cursor.time).kind
        : null;
    let chipState: "running" | "completed" | "waiting" | "queued" = "queued";
    let subtitle: string;
    if (rawState === "running") {
      chipState = "running";
      subtitle = `${workerName} · Run`;
    } else if (stationWait !== null && rawState === "queued") {
      chipState = "waiting";
      subtitle = compactStationWait(stationWait.label, stationWait.seconds);
    } else if (rawState === "completed") {
      chipState = "completed";
      subtitle = `${workerName} · Done`;
    } else if (interval.station === "cool" && !interval.attended) {
      chipState = "queued";
      subtitle = "Moulds → Cell";
    } else if (prevState === "running" || prevState === "completed") {
      chipState = "queued";
      subtitle = `${workerName} · Next`;
    } else {
      chipState = "queued";
      subtitle = `${workerName} · Queued`;
    }
    const shortTitle = shortProcessTitle(interval);
    const targetInterval =
      chipState === "waiting" && stationWait !== null
        ? stationWait.first
        : interval;
    return (
      <button
        key={interval.id}
        type="button"
        className="production-hybrid-step"
        data-state={chipState}
        aria-pressed={
          this.props.session.selection.kind === "task" &&
          this.props.session.selection.id === interval.id
        }
        onClick={this.inspect.bind(this, targetInterval)}
      >
        <strong>
          {stepIndex + 1}. {shortTitle}
        </strong>
        <span>{subtitle}</span>
      </button>
    );
  }
  private nativeCanvasNode(
    data: Ready,
    operation: ProductionWorkcell,
  ): React.ReactNode {
    const point = this.props.session.presentation[operation.id];
    if (point === undefined) return null;
    const status = nativeOperationStatus(
      data,
      operation,
      this.props.session.cursor.time,
    );
    const trayState =
      status === "Awaiting native result"
        ? "ready"
        : status === "Recovery required"
          ? "failed"
          : status === "running"
            ? "running"
            : status === "completed"
              ? "completed"
              : "queued";
    const visibleTitle =
      this.props.session.procedure === "rehearsal"
        ? cardTitle(this.props.session.procedure, operation)
        : `5${String.fromCharCode(96 + operation.tray)}. Robot Tray ${operation.tray}`;
    const visibleStatus = compactNativeTrayStatus(status);
    return (
      <button
        key={operation.id}
        type="button"
        className="production-canvas-node"
        data-tray-state={trayState}
        style={{ left: point.x, top: point.y }}
        onClick={this.chooseNativeOperation.bind(this, operation)}
        onKeyDown={this.moveNode.bind(this, operation.id)}
        aria-label={`${cardTitle(this.props.session.procedure, operation)}. ${status}. Arrow keys arrange this card; Shift moves faster.`}
      >
        <strong>{visibleTitle}</strong>
        <span>{visibleStatus} ›</span>
      </button>
    );
  }
  private plannedCanvasNode(
    operation: PlannedProductionWorkcell,
  ): React.ReactNode {
    const point = this.props.session.presentation[operation.id];
    if (point === undefined) return null;
    const title = `Tray ${operation.batchId} · step ${operation.step} · ${stepName(operation)}`;
    return (
      <button
        key={operation.id}
        type="button"
        className="production-canvas-node"
        data-tray-state="queued"
        style={{ left: point.x, top: point.y }}
        onKeyDown={this.moveNode.bind(this, operation.id)}
        aria-label={`${title}. Planned; starts from ${operation.predecessorId} once its result is accepted. Arrow keys arrange this card; Shift moves faster.`}
      >
        <strong>{title}</strong>
        <span>After {operation.predecessorId} ›</span>
      </button>
    );
  }
  private selectManualTask(value: string | null): void {
    if (value !== null) this.update({ manualTaskId: value });
  }
  private editManualTask(task: ProductionManualTask): void {
    this.editDraft({ kind: "manual", task });
  }
  private manualWorker(task: ProductionManualTask, value: string | null): void {
    if (value === null) return;
    this.editManualTask({
      bakeryTaskId: task.bakeryTaskId,
      workerId: value === "automatic" ? null : `human-${Number(value)}`,
      dependsOn: task.dependsOn,
      earliestStartSeconds: task.earliestStartSeconds,
    });
  }
  private manualStart(
    task: ProductionManualTask,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    this.editManualTask({
      bakeryTaskId: task.bakeryTaskId,
      workerId: task.workerId,
      dependsOn: task.dependsOn,
      earliestStartSeconds: Number(event.currentTarget.value),
    });
  }
  private manualDependency(
    task: ProductionManualTask,
    predecessor: string,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    const dependencies = new Set(task.dependsOn);
    if (event.currentTarget.checked) dependencies.add(predecessor);
    else dependencies.delete(predecessor);
    this.editManualTask({
      bakeryTaskId: task.bakeryTaskId,
      workerId: task.workerId,
      dependsOn: [...dependencies].sort(),
      earliestStartSeconds: task.earliestStartSeconds,
    });
  }
  private manualPredecessor(
    task: ProductionManualTask,
    choice: ProductionTaskChoice,
  ): React.ReactNode {
    return (
      <label key={choice.id}>
        <input
          type="checkbox"
          checked={task.dependsOn.includes(choice.id)}
          onChange={this.manualDependency.bind(this, task, choice.id)}
        />
        {choice.label}
      </label>
    );
  }
  private manualAuthor(
    settings: Settings,
    workers: readonly SelectChoice[],
  ): React.ReactNode {
    const choices = productionTaskChoices(
      settings,
      this.props.session.draft,
      "cold-racking",
    );
    const tasks = choices.filter(isManualChoice).map(taskChoice);
    const bakers = [ANY_BAKER, ...workers];
    const id = this.props.session.manualTaskId;
    const task = this.props.session.manualTasks.find(
      manualTaskWithId.bind(null, id),
    ) ?? {
      bakeryTaskId: id,
      workerId: null,
      dependsOn: [],
      earliestStartSeconds: 0,
    };
    return (
      <fieldset className="production-assignment">
        <legend>Manual operations and transfers</legend>
        <label>
          Task
          <Select.Root
            items={tasks}
            value={id}
            onValueChange={this.selectManualTask.bind(this)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{tasks.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          Assigned baker
          <Select.Root
            items={bakers}
            value={
              task.workerId === null ? "automatic" : task.workerId.slice(6)
            }
            onValueChange={this.manualWorker.bind(this, task)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{bakers.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          Earliest task start (seconds after 06:00)
          <input
            type="number"
            min={0}
            max={settings.horizonMinutes * 60 - 1}
            step={1}
            value={task.earliestStartSeconds}
            onChange={this.manualStart.bind(this, task)}
          />
        </label>
        <details>
          <summary>
            Additional task prerequisites ({task.dependsOn.length})
          </summary>
          <div className="production-predecessors">
            {choices
              .filter(otherTask.bind(null, id))
              .map(this.manualPredecessor.bind(this, task))}
          </div>
        </details>
      </fieldset>
    );
  }
  private author(data: Ready): React.ReactNode {
    const source = this.props.session.sourceProcedure ?? this.props.procedure;
    if (this.state.authorRoute === "oven-rack")
      return (
        <>
          <div className="production-section-header">
            <button
              type="button"
              className="production-menu-back"
              onClick={this.goBack.bind(this)}
            >
              ← Back
            </button>
            <h3>Edit production scenario</h3>
          </div>
          {this.detailsModeTabs("author")}
          {this.authorRouteChoice()}
          {source === null ? (
            <p>Load a shared procedure to author an oven route.</p>
          ) : (
            <OvenRouteAuthor
              key={source.revisionKey}
              procedure={source}
              connection={this.props.connection}
              open={this.showOven.bind(this)}
            />
          )}
        </>
      );
    const settings =
      this.props.session.sourceProcedure?.settings ?? data.plan.settings;
    const canSave =
      this.props.connection.kind === "workspace" &&
      this.props.connection.canManage &&
      source !== null;
    const choices: React.ReactNode[] = [];
    const workers = workerChoices(settings.workerCount);
    for (let batch = 0; batch < settings.batchCount; batch++) {
      const batchId = String.fromCharCode(65 + batch);
      for (let tray = 1; tray <= settings.traysPerBatch; tray++) {
        const id = productionAssignmentId({ batchId, tray });
        const assignment = this.props.session.draft.find(
          matchesDraftAssignment.bind(null, id),
        );
        const predecessors = productionTaskChoices(
          settings,
          this.props.session.draft,
          "cold-racking",
        ).filter(otherTask.bind(null, id));
        choices.push(
          <fieldset key={id} className="production-assignment">
            <legend>
              Batch {batchId} · tray {tray}
            </legend>
            <label>
              <input
                type="checkbox"
                checked={assignment !== undefined}
                onChange={this.toggleAssignment.bind(this, batchId, tray)}
              />
              Use Robot cold transfer
            </label>
            {assignment !== undefined && (
              <>
                <label>
                  Staging and clearance baker
                  <Select.Root
                    items={workers}
                    value={assignment.workerId.slice(6)}
                    onValueChange={this.changeWorker.bind(this, id)}
                  >
                    <Select.Trigger>
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Popup>{workers.map(renderItem)}</Select.Popup>
                  </Select.Root>
                </label>
                <details>
                  <summary>
                    After completed tasks ({assignment.dependsOn.length})
                  </summary>
                  <div className="production-predecessors">
                    {predecessors.length === 0 ? (
                      <p>Starts after this batch cools.</p>
                    ) : (
                      predecessors.map(
                        this.predecessorChoice.bind(this, id, assignment),
                      )
                    )}
                  </div>
                </details>
                <label>
                  Earliest staging time (seconds after 06:00)
                  <input
                    type="number"
                    min={0}
                    max={settings.horizonMinutes * 60 - 1}
                    step={1}
                    value={assignment.earliestStartSeconds}
                    onChange={this.changeEarliestStart.bind(this, id)}
                  />
                </label>
              </>
            )}
          </fieldset>,
        );
      }
    }
    return (
      <>
        <div className="production-section-header">
          <button
            type="button"
            className="production-menu-back"
            onClick={this.goBack.bind(this)}
          >
            ← Back
          </button>
          <h3>Edit production scenario</h3>
        </div>
        {this.detailsModeTabs("author")}
        {this.authorRouteChoice()}
        <div className="production-rehearsal-preset">
          <label>
            Start from
            <Select.Root
              items={FINANCIER_PRESETS}
              value={this.props.session.financierPreset}
              onValueChange={this.chooseFinancierPreset.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{FINANCIER_PRESETS.map(renderItem)}</Select.Popup>
            </Select.Root>
          </label>
          <button
            type="button"
            disabled={this.props.session.reading}
            onClick={this.startFinancierPreset.bind(this)}
          >
            Replace with preset
          </button>
        </div>
        {this.productionReplacementReview()}
        <label>
          Oven availability
          <Select.Root
            items={OVEN_VARIANTS}
            value={this.props.session.draftVariant}
            onValueChange={this.changeVariant.bind(this)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{OVEN_VARIANTS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        {this.manualAuthor(settings, workers)}
        <div className="production-assignment-list">{choices}</div>
        {this.props.session.preview !== null && (
          <p>
            Valid preview: {this.props.session.preview.plan.operations.length}{" "}
            Robot transfers across{" "}
            {this.props.session.preview.plan.settings.batchCount} batches.{" "}
            {
              this.props.session.preview.plan.operations.filter(hasPredecessor)
                .length
            }{" "}
            have authored task prerequisites. The provisional run ends at{" "}
            {this.props.session.preview.run.end.toFixed(0)} seconds with{" "}
            {metrics(this.props.session.preview.run).unfinished} unfinished
            batches.
          </p>
        )}
        <div className="production-author-actions">
          <button
            onClick={this.previewDraft.bind(this)}
            disabled={
              this.props.session.reading || this.props.session.savingDefinition
            }
          >
            Preview scenario
          </button>
          <button
            onClick={this.applyDraft.bind(this)}
            disabled={
              this.props.session.preview === null ||
              this.props.session.replacement !== null ||
              this.props.session.savingDefinition
            }
          >
            Apply preview and prepare new requests
          </button>
          <button
            onClick={this.discardDraft.bind(this)}
            disabled={this.props.session.savingDefinition}
          >
            Discard draft changes
          </button>
        </div>
        <section
          className="production-workspace-save"
          aria-label="Save or open workspace scenario"
        >
          <h4>Save or open workspace scenario</h4>
          <label>
            Scenario name
            <input
              type="text"
              maxLength={80}
              value={this.props.session.draftName}
              onChange={this.changeName.bind(this)}
            />
          </label>
          <label>
            Timing and calibration note
            <textarea
              maxLength={2000}
              value={this.props.session.draftNote}
              onChange={this.changeNote.bind(this)}
            />
          </label>
          <button
            onClick={this.saveDefinition.bind(this)}
            disabled={
              !canSave ||
              this.props.session.savingDefinition ||
              this.props.session.identity.kind !== "new" ||
              this.props.session.preview === null
            }
          >
            {this.props.session.savingDefinition
              ? "Saving…"
              : "Save scenario copy"}
          </button>
          {this.props.connection.kind === "workspace" && (
            <ScenarioPicker
              key={this.props.connection.organisationId}
              kind={PRODUCTION_SCENARIO_PICKER}
              organisationId={this.props.connection.organisationId}
              busy={
                this.props.session.openingDefinition ||
                this.props.session.savingDefinition
              }
              onLoad={this.openDefinition.bind(this)}
            />
          )}
        </section>
        {this.baselineComparison(data)}
      </>
    );
  }
  private batchDetail(run: Run, batch: Batch): React.ReactNode {
    const intervals = run.intervals.filter(batchTask.bind(null, batch.id));
    const waits = batchWaits(run, batch.id);
    return (
      <div className="production-batch-body">
        <div className="production-task-list">
          {intervals.map(this.task.bind(this, run))}
        </div>
        {waits.length > 0 && (
          <div className="production-wait-summary">
            {waits.map(this.waitSummary.bind(this))}
          </div>
        )}
        {this.props.session.data.kind === "ready" &&
          this.props.session.data.plan.operations
            .filter(inBatch.bind(null, batch.id))
            .map(this.requestCard.bind(this, run))}
        {run.nativeHolds
          .filter(batchHold.bind(null, batch.id))
          .map(this.hold.bind(this))}
        {run.unresolvedWaits
          .filter(waitForBatch.bind(null, batch.id))
          .map(this.unresolvedWait.bind(this, run))}
      </div>
    );
  }
  private task(run: Run, interval: Interval): React.ReactNode {
    if (interval.kind === "wait") return null;
    let assignment = "Unattended";
    if (interval.attended)
      assignment = humanResource(run, interval.executor).name;
    else if (interval.kind === "native")
      assignment = interval.operation.attempt.input.bindings.cell;
    return (
      <button
        key={interval.id}
        onClick={this.inspect.bind(this, interval)}
        aria-pressed={
          this.props.session.selection.kind === "task" &&
          this.props.session.selection.id === interval.id
        }
      >
        {describe(interval)} · {assignment} ·{" "}
        {taskAt(run, interval, this.props.session.cursor.time).kind}
      </button>
    );
  }
  private waitSummary(summary: BatchWaitSummary): React.ReactNode {
    return (
      <button
        key={summary.label}
        onClick={this.inspect.bind(this, summary.first)}
      >
        Wait · {summary.label} · {Math.round(summary.seconds)} s total
      </button>
    );
  }
  private requestCard(
    run: Run,
    operation: ProductionWorkcell,
  ): React.ReactNode {
    if (run.intervals.some(hasNativeOperation.bind(null, operation.id)))
      return null;
    return (
      <button
        key={operation.id}
        onClick={this.inspectRequest.bind(this, operation.id)}
      >
        Tray {operation.tray} · Native result needed · Request and evidence
      </button>
    );
  }
  private hold(hold: Run["nativeHolds"][number]): React.ReactNode {
    return (
      <p key={hold.operation.id}>
        At {(hold.kind === "failed" ? hold.settledTime : hold.start).toFixed(2)}{" "}
        s · Tray {hold.operation.tray}:{" "}
        {hold.kind === "failed"
          ? `${nativeFailureLabel(hold.failure)}; Robot cell and cooling allocation held.`
          : "Awaiting matching native evidence; Robot cell reserved."}{" "}
        <button
          onClick={this.seek.bind(
            this,
            hold.kind === "failed" ? hold.settledTime : hold.start,
          )}
        >
          Jump to reservation
        </button>
      </p>
    );
  }
  private unresolvedWait(
    run: Run,
    wait: Run["unresolvedWaits"][number],
  ): React.ReactNode {
    return (
      <p key={`${wait.batch}-${wait.station}-${wait.reason}`}>
        {workName(run, wait.batch)} is blocked at {wait.station}: {wait.label}
      </p>
    );
  }
  private track(run: Run, batch: Batch): React.ReactNode {
    return (
      <TimelineTrack
        key={batch.id}
        run={run}
        batch={batch}
        selection={this.props.session.selection}
        time={this.props.session.cursor.time}
        onSelect={this.select.bind(this)}
        onSeek={this.inspect.bind(this)}
      />
    );
  }
  private workerTrack(
    run: Run,
    resource: Run["resources"][number],
  ): React.ReactNode {
    return (
      <WorkerTimelineTrack
        key={resource.id}
        run={run}
        resource={resource}
        selection={this.props.session.selection}
        time={this.props.session.cursor.time}
        onSelect={this.select.bind(this)}
        onSeek={this.inspect.bind(this)}
      />
    );
  }
  private detailsModeTabs(active: "details" | "author"): React.ReactNode {
    return (
      <SegmentedControl
        ariaLabel="Details mode"
        value={active}
        options={[
          {
            value: "author",
            label: "Inputs",
            onSelect: this.selectPanel.bind(this, "author"),
          },
          {
            value: "details",
            label: "Inspect",
            onSelect: this.selectPanel.bind(this, "details"),
          },
        ]}
      />
    );
  }
  private details(run: Run): React.ReactNode {
    const context = selectionContext(
      run,
      this.props.session.selection,
      this.props.session.cursor.time,
    );
    const operation = this.selectedOperation();
    const selectedHold =
      operation === null
        ? undefined
        : run.nativeHolds.find(holdForOperation.bind(null, operation.id));
    const selectedWait =
      operation === null
        ? undefined
        : run.unresolvedWaits.find(waitForBatch.bind(null, operation.batchId));
    const operations =
      this.props.session.data.kind === "ready"
        ? this.props.session.data.plan.operations
        : [];
    return (
      <>
        <div className="production-section-header">
          <button
            type="button"
            className="production-menu-back"
            onClick={this.goBack.bind(this)}
          >
            ← Back
          </button>
          <h3>Details</h3>
        </div>
        {this.detailsModeTabs("details")}
        {operations.length > 0 && (
          <div
            className="production-details-pills"
            role="group"
            aria-label="Select tray"
          >
            {operations.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={operation?.id === item.id}
                onClick={this.chooseNativeOperation.bind(this, item)}
              >
                {run.unit === "tray"
                  ? `Tray ${item.batchId} · ${item.step}`
                  : `${item.batchId}${item.tray}`}
              </button>
            ))}
          </div>
        )}
        {operation === null && context.batch === null && (
          <p>Select a batch or task.</p>
        )}
        {operation !== null &&
          this.materialDetails(run, operation, selectedHold, selectedWait)}
        {context.task !== null && (
          <dl className="production-details-dl">
            <dt>Active step</dt>
            <dd>{describe(context.task)}</dd>
            <dt>Window</dt>
            <dd>
              {context.task.start.toFixed(0)} → {context.task.end.toFixed(0)} s
              · {taskAt(run, context.task, this.props.session.cursor.time).kind}
            </dd>
          </dl>
        )}
        {context.task?.kind === "native" && (
          <Views.ProductionNativeScene
            cameraView={this.props.cameraView}
            task={context.task}
            inspect={this.panel.bind(this, "details")}
          />
        )}
        {selectedHold !== undefined && this.hold(selectedHold)}
      </>
    );
  }
  private materialDetails(
    run: Run,
    operation: ProductionWorkcell,
    selectedHold: Run["nativeHolds"][number] | undefined,
    selectedWait: Run["unresolvedWaits"][number] | undefined,
  ): React.ReactNode {
    const material = productionMaterialAt(
      run,
      operation,
      this.props.session.cursor.time,
    );
    const occupant = run.nativeReservations.find(
      activeMaterialReservation.bind(
        null,
        operation.material.materialId,
        this.props.session.cursor.time,
      ),
    );
    const ingredients = operation.attempt.input.request.ingredients;
    return (
      <section aria-label="Material and tooling handoff">
        <dl className="production-details-dl">
          <dt>Material</dt>
          <dd>
            {run.unit === "tray"
              ? workName(run, operation.batchId)
              : `Batch ${operation.batchId} · Tray ${operation.tray}`}
          </dd>
          <dt>Status</dt>
          <dd>{selectedNativeStatus(selectedHold, selectedWait)}</dd>
          <dt>Assigned baker</dt>
          <dd>Baker {operation.workerId.slice(6)}</dd>
          <dt>Tray location</dt>
          <dd>
            {materialLocation(
              material.location,
              operation.attempt.input.bindings.destination ===
                coldCell(operation.attempt.input.bindings.cell).skills[
                  "table-to-oven"
                ].destination
                ? "Maruzen oven shelf"
                : "Reserved rack slot",
            )}
          </dd>
          <dt>Handoff</dt>
          <dd>{materialStatus(material)}</dd>
          <dt>Payload</dt>
          <dd>
            {ingredients.massKg} kg
            {ingredients.forwardMm !== 0 || ingredients.lateralMm !== 0
              ? ` (${ingredients.forwardMm} / ${ingredients.lateralMm} mm)`
              : ""}
          </dd>
          <dt>Reserved cell</dt>
          <dd>
            {occupant === undefined ? "None" : reservedCellNames(occupant)} ·{" "}
            {material.tool}
          </dd>
        </dl>
      </section>
    );
  }
}
function activeMaterialReservation(
  materialId: ProductionWorkcell["material"]["materialId"],
  time: number,
  reservation: Run["nativeReservations"][number],
): boolean {
  return (
    reservation.materialId === materialId &&
    reservation.start <= time &&
    (reservation.kind !== "released" || time < reservation.end)
  );
}
function materialStatus(state: ProductionMaterialState): string {
  switch (state.kind) {
    case "waiting":
      return "Waiting for production and an available cell";
    case "staging":
      return `Baker ${state.worker.slice(6)} is staging the tray`;
    case "awaiting-evidence":
      return "Staged; waiting for matching native evidence";
    case "transferring":
      return "Native transfer in progress";
    case "awaiting-clearance":
      return "Placement checked; waiting for baker clearance";
    case "clearing":
      return `Baker ${state.worker.slice(6)} is clearing the rack slot`;
    case "released":
      return "Tray cleared; cell and clamp released";
    case "recovery-required":
      return "Failed; material and tooling held for recovery";
    case "recovered":
      return "Recovery assumed: tray reset to its source; cell and clamp released";
    default:
      return assertNever(state);
  }
}
function materialLocation(
  location: ProductionMaterialState["location"],
  destination: string,
): string {
  switch (location) {
    case "production":
      return "Production batch";
    case "baker":
      return "Baker custody (assumed)";
    case "cell-1-source":
      return "Cell 1 source table (assumed recovery)";
    case "cell-1-rack":
      return "Cell 1 rack; awaiting human pickup";
    case "cell-2-source":
      return "Cell 2 source table (assumed placement)";
    case "buffer":
      return "One-slot transfer buffer (assumed placement)";
    case "source":
      return "Prepared source table";
    case "gripped":
      return "In the clamp";
    case "destination":
      return destination;
    case "oven":
      return "Maruzen oven";
    case "holding":
      return "Production holding area (assumed)";
    case "unknown":
      return "Unknown — recovery required";
    default:
      return assertNever(location);
  }
}
function runEnd(summary: RunSummary): string {
  return `${clock(summary.end)}${summary.kind === "complete" ? "" : ` (${summary.kind === "horizon" ? "shift end" : "blocked"})`}`;
}
function resourceChoice(resource: OutageResource): SelectChoice {
  return { value: resource, label: outageResourceName(resource) };
}
function currentDraft(identity: DraftIdentity, id: string): boolean {
  return identity.kind !== "saved" && identity.id === id;
}
function identityAfterSave(
  identity: DraftIdentity,
  id: string,
  unchanged: boolean,
): DraftIdentity {
  if (!currentDraft(identity, id)) return identity;
  if (!unchanged) return newDraftIdentity();
  return { kind: "uncertain", id };
}
function matchesOperation(
  id: string | null,
  operation: ProductionWorkcell,
): boolean {
  return id === operation.id;
}
function operationChoice(
  procedure: ProductionWorkcells["procedure"],
  operation: ProductionWorkcell,
): SelectChoice {
  const { robot, ingredients } = operation.attempt.input.request;
  return {
    value: operation.id,
    label: `${cardTitle(procedure, operation)} · ${ROBOTS[robot].label} · ${ingredients.massKg} kg · forward ${ingredients.forwardMm} mm · lateral ${ingredients.lateralMm} mm · ${operation.attempt.kind}`,
  };
}
function batchTask(batch: string, interval: Interval): boolean {
  return interval.batch === batch && interval.kind !== "wait";
}
function batchWaits(run: Run, batch: string): readonly BatchWaitSummary[] {
  const totals = new Map<string, BatchWaitSummary>();
  for (const interval of run.intervals) {
    if (interval.kind !== "wait" || interval.batch !== batch) continue;
    const previous = totals.get(interval.label);
    totals.set(interval.label, {
      label: interval.label,
      seconds: (previous?.seconds ?? 0) + interval.end - interval.start,
      first: previous?.first ?? interval,
    });
  }
  return [...totals.values()].sort(longestWaitFirst).slice(0, 3);
}
function longestWaitFirst(
  left: BatchWaitSummary,
  right: BatchWaitSummary,
): number {
  return right.seconds - left.seconds;
}
function batchHold(batch: string, hold: Run["nativeHolds"][number]): boolean {
  return hold.operation.batchId === batch;
}
function nativeFailureLabel(
  failure: Variant<Run["nativeHolds"][number], "failed">["failure"],
): string {
  switch (failure.kind) {
    case "failed":
      return `Native failure: ${failure.reason}`;
    case "execution-error":
      return `Runner error: ${failure.message}`;
    default:
      return assertNever(failure);
  }
}
function waitForBatch(
  batch: string,
  wait: Run["unresolvedWaits"][number],
): boolean {
  return wait.batch === batch;
}
function inBatch(batch: string, operation: ProductionWorkcell): boolean {
  return batch === operation.batchId;
}
function hasNativeOperation(id: string, interval: Interval): boolean {
  return interval.kind === "native" && interval.operation.id === id;
}
function nativeTaskFor(run: Run, id: string): NativeBakeryTask | null {
  for (const interval of run.intervals) {
    if (interval.kind === "native" && interval.operation.id === id)
      return interval;
  }
  return null;
}
function nativeOperationStatus(
  data: Ready,
  operation: ProductionWorkcell,
  time: number,
): string {
  const hold = data.run.nativeHolds.find(
    holdForOperation.bind(null, operation.id),
  );
  if (hold?.kind === "failed") return "Recovery required";
  if (hold?.kind === "awaiting-evidence") return "Awaiting native result";
  const task = nativeTaskFor(data.run, operation.id);
  if (task !== null) return taskAt(data.run, task, time).kind;
  for (const predecessorId of operation.dependsOn) {
    const predecessor =
      data.run.intervals.find(taskWithId.bind(null, predecessorId)) ?? null;
    if (
      predecessor === null ||
      predecessor.kind === "wait" ||
      taskAt(data.run, predecessor, time).kind !== "completed"
    )
      return `Waiting for ${predecessorId}`;
  }
  for (const predecessor of data.plan.operations) {
    if (
      predecessor.batchId !== operation.batchId ||
      predecessor.tray >= operation.tray
    )
      continue;
    const predecessorTask = nativeTaskFor(data.run, predecessor.id);
    if (
      predecessorTask === null ||
      taskAt(data.run, predecessorTask, time).kind !== "completed"
    )
      return `Waiting for tray ${predecessor.tray}`;
  }
  const wait = data.run.unresolvedWaits.find(
    waitForBatch.bind(null, operation.batchId),
  );
  return wait?.label ?? "Queued after cooling";
}
function holdForOperation(
  id: string,
  hold: Run["nativeHolds"][number],
): boolean {
  return hold.operation.id === id;
}
function selectedNativeStatus(
  hold: Run["nativeHolds"][number] | undefined,
  wait: Run["unresolvedWaits"][number] | undefined,
): string {
  if (hold?.kind === "failed") return "Recovery required; cell remains held";
  if (hold?.kind === "awaiting-evidence")
    return "Awaiting matching native result";
  return wait?.label ?? "Follows cooling and available resources";
}
const message = (error: unknown): string =>
  errorMessage(error, "Unable to prepare production workcells.");
function matchesDraftAssignment(
  id: string,
  assignment: ProductionAssignment,
): boolean {
  return productionAssignmentId(assignment) === id;
}
function settingsMatch(left: Settings, right: Settings): boolean {
  return fields.every((field) => left[field.key] === right[field.key]);
}
function hasPredecessor(operation: ProductionWorkcell): boolean {
  return operation.dependsOn.length > 0;
}

function manualTaskWithId(id: string, task: ProductionManualTask): boolean {
  return task.bakeryTaskId === id;
}
function otherTask(id: string, task: ProductionTaskChoice): boolean {
  return task.id !== id;
}
function isManualChoice(task: ProductionTaskChoice): boolean {
  return task.kind === "manual";
}
function taskChoice(task: ProductionTaskChoice): SelectChoice {
  return { value: task.id, label: task.label };
}
function taskWithId(id: string, task: Interval): boolean {
  return task.kind !== "wait" && task.id === id;
}

function hasPresetValue(
  value: string | null,
  preset: (typeof REHEARSAL_PRESETS)[number],
): boolean {
  return preset.id === value;
}
async function readPresetExample(
  example: Parameters<ReadExample>[0],
): Promise<PhysicsReplay> {
  const parsed = parsePhysicsReplay(await readExample(example));
  if (parsed.kind === "rejected") throw new Error(parsed.message);
  return parsed.recording;
}
// A tray's first skill runs in the browser from a prepared fixture; recorded
// oven and rack cycles replay only.
function browserRoot(root: ProductionWorkcell): boolean {
  const kind = root.attempt.input.kind;
  return kind === "transfer" || kind === "native-cycle";
}
function hasResult(
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): boolean {
  return (
    operation.attempt !== undefined &&
    operation.attempt.kind !== "awaiting-evidence"
  );
}
// Rehearsal cards sit in rows by tray and columns by step.
function isRoot(operation: ProductionWorkcell): boolean {
  return operation.step === 1;
}
function sameTray(
  root: ProductionWorkcell,
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): boolean {
  return operation.batchId === root.batchId && operation.tray === root.tray;
}
function otherTray(
  root: ProductionWorkcell,
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): boolean {
  return !sameTray(root, operation);
}
function byStep(
  left: { readonly step: number },
  right: { readonly step: number },
): number {
  return left.step - right.step;
}
function byTrayStep(
  left: ProductionWorkcell | PlannedProductionWorkcell,
  right: ProductionWorkcell | PlannedProductionWorkcell,
): number {
  return left.batchId.localeCompare(right.batchId) || left.step - right.step;
}
function otherId(excluded: string, id: string): boolean {
  return id !== excluded;
}
// Names the skill a tray step runs, from its plan or its bound request.
function cardTitle(
  procedure: ProductionWorkcells["procedure"],
  operation: ProductionWorkcell,
): string {
  return procedure === "rehearsal"
    ? `Tray ${operation.batchId} · step ${operation.step} · ${stepName(operation)}`
    : `Batch ${operation.batchId} · tray ${operation.tray}`;
}

function reason(text: string): React.ReactNode {
  return <li key={text}>{text}</li>;
}

function productionReplacementLabel(
  source: BakeryProductionReplacementSource,
): string {
  switch (source) {
    case "preview":
      return "Apply the compiled draft";
    case "one-batch":
      return "Use Financier + robot: one batch of one tray";
    case "procedure":
      return "Use the applied procedure preset";
  }
}

function isHumanTransferStep(
  batchId: string,
  step: ProductionWorkcell | PlannedProductionWorkcell,
): boolean {
  return (
    step.batchId === batchId &&
    (step.attempt === undefined
      ? step.skill.kind === "restage"
      : step.start.kind === "restaged")
  );
}

function reservedCellNames(
  reservation: Run["nativeReservations"][number],
): string {
  const names: string[] = [];
  for (const resource of reservation.resources) {
    const cellId = parseCellId(resource);
    if (cellId !== null) names.push(resourceInstance(cellId).name);
  }
  return names.join(", ");
}

function cellRobotLabel(
  cell: import("@purin-labs/production-simulation/recipes/bakery/production-workcells").CellRobot,
): string {
  switch (cell.kind) {
    case "unused":
      return "Unassigned";
    case "assigned":
      return ROBOTS[cell.robot].label;
  }
}

function batchWithId(id: string, batch: Batch): boolean {
  return batch.id === id;
}

function batchTitle(run: Run, batch: Batch): string {
  return run.unit === "tray"
    ? workName(run, batch.id)
    : `Batch ${batch.id} · ${batch.trays} trays`;
}

function isDefaultProductionNotice(notice: string): boolean {
  return (
    notice.startsWith("Production prepared.") ||
    notice.startsWith("Rehearsal prepared with two recorded trays.")
  );
}
