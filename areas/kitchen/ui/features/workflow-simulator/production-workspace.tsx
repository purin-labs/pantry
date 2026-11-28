import type { ScheduleSpatialLayout } from "@purin-labs/production-simulation/recipes/bakery/schedule";
import * as Views from "./workspace-views";
// Loads here, as before the split, so that the CSS order stays the same.
import "@purin-labs/ui/select";
import { BakeryAppearanceControl } from "@purin-labs/ui/preferences/appearance-controls";
import { SimulatorHistoryControls } from "./docks/history-controls";
import { LocateFixed, Map as MapIcon } from "lucide-react";
import type {
  FinancierBakeOutcome,
  FinancierBakeRecipeConfig,
  FinancierHandoffRecoveryPreset,
} from "@purin-labs/production-simulation/recipes/financier-bake/model";
import type {
  FinancierBatterOutcome,
  FinancierBatterRecipeConfig,
} from "@purin-labs/production-simulation/recipes/financier-batter/model";
import type {
  FinancierPackOutcome,
  FinancierPackRecipeConfig,
} from "@purin-labs/production-simulation/recipes/financier-pack/model";
import type { CafeShiftRecipeConfig } from "@purin-labs/production-simulation/recipes/cafe-shift/model";
import type { BlackSesameCobotRecipeConfig } from "@purin-labs/production-simulation/recipes/black-sesame/model";
import type { GingerTeaCobotRecipeConfig } from "@purin-labs/production-simulation/recipes/ginger-tea/model";
import type { LatteRecipeConfig } from "@purin-labs/production-simulation/recipes/latte/model";
import type { PastryBenchRecipeConfig } from "../production-run/pastry-bench/pastry-bench-model";
import { workspaceTitle, type CatalogSection } from "./workflow-catalog";
import type { SiphonRecipeConfig } from "@purin-labs/production-simulation/recipes/siphon/model";
import { downloadBakeryFile } from "./file-download";
import type { FactoryResult } from "../production-run/factory-comparison";
import {
  RecipeWorkspaceContext,
  type RecipeWorkspace,
} from "../production-run/recipe-workspace";
import type { OvenRunSource } from "@purin-labs/production-simulation/runs/oven-run-file";
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
import React from "react";
import {
  PlaybackScrubber,
  PlaybackTimeContext,
  PlaybackTimeText,
  secondsText,
} from "./playback-cursor";
import type { Settings } from "@purin-labs/bakery-model/bakery";
import { bakeryFingerprint } from "@purin-labs/bakery-model/bakery";
import type { CompiledProcedure } from "@purin-labs/bakery-model/bakery-procedure";
import type {
  ProductionTaskChoice,
  ProductionAssignment,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import type {
  ProductionWorkcells,
  ProductionWorkcell,
} from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import type { PreparedRehearsalEdit } from "./rehearsal-edits";
import {
  appliedRunPatch,
  compileProductionDraft,
  editProductionDraft,
  prepareProductionPreview,
  type ProductionDraftEdit,
} from "./production-draft";
import {
  metrics,
  type Interval,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { SceneController } from "./scene-controller";
import type { RecordingReplayActions } from "./simulator-actions";
import {
  selectionForInterval,
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
import type {
  FinancierPreset,
  ProductionPending as Pending,
  ProductionSession as State,
} from "./production-session";
import { readProductionScenario } from "./production-scenario-api";
// Loads here, as before the split, so that the CSS order stays the same.
import "./recording-candidate-preview";
import {
  acceptProductionCandidate,
  readyProduction,
} from "./scheduled-rehearsal";
import type { RehearsalPreset } from "@purin-labs/production-simulation/simulator/rehearsal-presets";
import type { Variant } from "@purin-labs/type-utils";
import {
  isDefaultProductionNotice,
  matchesDraftAssignment,
  matchesOperation,
  message,
  nativeTaskFor,
  productionReplacementLabel,
} from "./production-workspace-queries";
import {
  productionDefinitionFiles,
  productionRecipeViews,
} from "./production-recipe-files";
import { productionRehearsalAuthoring } from "./production-rehearsal-authoring";
import { productionSurfaceViews } from "./production-surface-views";
import { productionAuthorViews } from "./production-author-views";

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
  readonly recordingHeading = React.createRef<HTMLHeadingElement>();
  readonly runReviewHeading = React.createRef<HTMLHeadingElement>();
  readonly fileInput = React.createRef<HTMLInputElement>();
  readonly scene = new SceneController();
  mounted = false;
  static contextType = PlaybackTimeContext;
  declare context: React.ContextType<typeof PlaybackTimeContext>;
  private unsubscribeTime: (() => void) | null = null;
  sceneMounted = false;
  generation = 0;
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
  currentMenuSnapshot(
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
  selectPanel(panel: State["panel"]): void {
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
  goBack(): void {
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
  openCatalogSection(catalogSection: CatalogSection): void {
    this.setState({
      menuHistory: [...this.state.menuHistory, this.currentMenuSnapshot()],
      catalogOpen: false,
      catalogSection,
      activeBatchId: null,
      panelHidden: false,
      transitionDirection: "forward",
    });
  }
  openBatch(activeBatchId: string): void {
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
  update(patch: Partial<State>): void {
    this.props.changed(patch);
  }
  private sceneStatus(scene: "ready" | "unavailable"): void {
    if (this.mounted) this.update({ scene });
  }
  select(selection: Selection): void {
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
  inspect(interval: Interval): void {
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
  seek(time: number): void {
    this.props.playback.seek(time);
  }
  private scrub(event: React.ChangeEvent<HTMLInputElement>): void {
    this.seek(Number(event.currentTarget.value));
  }
  panel(panel: State["panel"]): void {
    const from = this.props.session.data;
    if (from.kind === "ready")
      this.props.authored({ kind: "productionPanelShown", from, panel });
  }
  operation(value: string | null): void {
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
  chooseFinancierPreset(value: string | null): void {
    if (value === "procedure" || value === "one-batch")
      this.update({ financierPreset: value });
  }
  startFinancierPreset(): void {
    void this.reviewProductionReplacement(this.props.session.financierPreset);
  }
  async prepareDefinition(
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
  editDraft(edit: ProductionDraftEdit): void {
    if (editProductionDraft(this.props.session, edit).kind === "ready")
      this.generation++;
    this.props.authored({ kind: "productionDraftEdited", edit });
  }
  toggleAssignment(
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
  changeWorker(id: string, value: string | null): void {
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
  predecessorChoice(
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
  changeEarliestStart(
    id: string,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    this.editDraft({
      kind: "start",
      id,
      earliestStartSeconds: Number(event.currentTarget.value),
    });
  }
  changeVariant(value: string | null): void {
    if (value === null) return;
    this.editDraft({
      kind: "variant",
      variant: value === "outage" ? "outage" : "normal",
    });
  }
  changeName(event: React.ChangeEvent<HTMLInputElement>): void {
    this.editDraft({ kind: "name", name: event.currentTarget.value });
  }
  changeNote(event: React.ChangeEvent<HTMLTextAreaElement>): void {
    this.editDraft({ kind: "note", note: event.currentTarget.value });
  }
  moveNode(
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
  applyDraft(): void {
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
  productionReplacementReview(): React.ReactNode {
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
  discardDraft(): void {
    this.editDraft({ kind: "discard" });
  }
  async previewDraft(): Promise<void> {
    this.generation++;
    const preview = await prepareProductionPreview(
      this.props.session,
      this.props.procedure,
      this.props.layout,
    );
    if (preview !== null)
      this.props.authored({ kind: "productionPreviewed", preview });
  }
  showOven(...args: Parameters<typeof productionRecipeViews.showOven>) {
    return productionRecipeViews.showOven.apply(this, args);
  }
  openSharedProduction(
    ...args: Parameters<typeof productionRecipeViews.openSharedProduction>
  ) {
    return productionRecipeViews.openSharedProduction.apply(this, args);
  }
  private closeOven(
    ...args: Parameters<typeof productionRecipeViews.closeOven>
  ) {
    return productionRecipeViews.closeOven.apply(this, args);
  }
  showSiphon(...args: Parameters<typeof productionRecipeViews.showSiphon>) {
    return productionRecipeViews.showSiphon.apply(this, args);
  }
  private closeSiphon(
    ...args: Parameters<typeof productionRecipeViews.closeSiphon>
  ) {
    return productionRecipeViews.closeSiphon.apply(this, args);
  }
  showLatte(...args: Parameters<typeof productionRecipeViews.showLatte>) {
    return productionRecipeViews.showLatte.apply(this, args);
  }
  private closeLatte(
    ...args: Parameters<typeof productionRecipeViews.closeLatte>
  ) {
    return productionRecipeViews.closeLatte.apply(this, args);
  }
  showBlackSesame(
    ...args: Parameters<typeof productionRecipeViews.showBlackSesame>
  ) {
    return productionRecipeViews.showBlackSesame.apply(this, args);
  }
  private closeBlackSesame(
    ...args: Parameters<typeof productionRecipeViews.closeBlackSesame>
  ) {
    return productionRecipeViews.closeBlackSesame.apply(this, args);
  }
  showGingerTea(
    ...args: Parameters<typeof productionRecipeViews.showGingerTea>
  ) {
    return productionRecipeViews.showGingerTea.apply(this, args);
  }
  private closeGingerTea(
    ...args: Parameters<typeof productionRecipeViews.closeGingerTea>
  ) {
    return productionRecipeViews.closeGingerTea.apply(this, args);
  }
  showFinancierBatter(
    ...args: Parameters<typeof productionRecipeViews.showFinancierBatter>
  ) {
    return productionRecipeViews.showFinancierBatter.apply(this, args);
  }
  private closeFinancierBatter(
    ...args: Parameters<typeof productionRecipeViews.closeFinancierBatter>
  ) {
    return productionRecipeViews.closeFinancierBatter.apply(this, args);
  }
  showFinancierBake(
    ...args: Parameters<typeof productionRecipeViews.showFinancierBake>
  ) {
    return productionRecipeViews.showFinancierBake.apply(this, args);
  }
  private closeFinancierBake(
    ...args: Parameters<typeof productionRecipeViews.closeFinancierBake>
  ) {
    return productionRecipeViews.closeFinancierBake.apply(this, args);
  }
  showFinancierPack(
    ...args: Parameters<typeof productionRecipeViews.showFinancierPack>
  ) {
    return productionRecipeViews.showFinancierPack.apply(this, args);
  }
  private closeFinancierPack(
    ...args: Parameters<typeof productionRecipeViews.closeFinancierPack>
  ) {
    return productionRecipeViews.closeFinancierPack.apply(this, args);
  }
  showPastryBench(
    ...args: Parameters<typeof productionRecipeViews.showPastryBench>
  ) {
    return productionRecipeViews.showPastryBench.apply(this, args);
  }
  private closePastryBench(
    ...args: Parameters<typeof productionRecipeViews.closePastryBench>
  ) {
    return productionRecipeViews.closePastryBench.apply(this, args);
  }
  showCafeShift(
    ...args: Parameters<typeof productionRecipeViews.showCafeShift>
  ) {
    return productionRecipeViews.showCafeShift.apply(this, args);
  }
  private closeCafeShift(
    ...args: Parameters<typeof productionRecipeViews.closeCafeShift>
  ) {
    return productionRecipeViews.closeCafeShift.apply(this, args);
  }
  private applyCafeShiftToSchedule(
    ...args: Parameters<typeof productionRecipeViews.applyCafeShiftToSchedule>
  ) {
    return productionRecipeViews.applyCafeShiftToSchedule.apply(this, args);
  }
  private applyFinancierBatterToSchedule(
    ...args: Parameters<
      typeof productionRecipeViews.applyFinancierBatterToSchedule
    >
  ) {
    return productionRecipeViews.applyFinancierBatterToSchedule.apply(
      this,
      args,
    );
  }
  private applyFinancierBakeToSchedule(
    ...args: Parameters<
      typeof productionRecipeViews.applyFinancierBakeToSchedule
    >
  ) {
    return productionRecipeViews.applyFinancierBakeToSchedule.apply(this, args);
  }
  applyHandoffRecoveryPreset(
    ...args: Parameters<typeof productionRecipeViews.applyHandoffRecoveryPreset>
  ) {
    return productionRecipeViews.applyHandoffRecoveryPreset.apply(this, args);
  }
  private applyFinancierPackToSchedule(
    ...args: Parameters<
      typeof productionRecipeViews.applyFinancierPackToSchedule
    >
  ) {
    return productionRecipeViews.applyFinancierPackToSchedule.apply(this, args);
  }
  chooseAuthorRoute(
    ...args: Parameters<typeof productionRecipeViews.chooseAuthorRoute>
  ) {
    return productionRecipeViews.chooseAuthorRoute.apply(this, args);
  }
  authorRouteChoice(
    ...args: Parameters<typeof productionRecipeViews.authorRouteChoice>
  ) {
    return productionRecipeViews.authorRouteChoice.apply(this, args);
  }
  openOvenFile(
    ...args: Parameters<typeof productionDefinitionFiles.openOvenFile>
  ) {
    return productionDefinitionFiles.openOvenFile.apply(this, args);
  }
  openDefinition(
    ...args: Parameters<typeof productionDefinitionFiles.openDefinition>
  ) {
    return productionDefinitionFiles.openDefinition.apply(this, args);
  }
  saveDefinition(
    ...args: Parameters<typeof productionDefinitionFiles.saveDefinition>
  ) {
    return productionDefinitionFiles.saveDefinition.apply(this, args);
  }
  private prepareRehearsal(
    ...args: Parameters<typeof productionRehearsalAuthoring.prepareRehearsal>
  ) {
    return productionRehearsalAuthoring.prepareRehearsal.apply(this, args);
  }
  choosePreset(
    ...args: Parameters<typeof productionRehearsalAuthoring.choosePreset>
  ) {
    return productionRehearsalAuthoring.choosePreset.apply(this, args);
  }
  startPreset(
    ...args: Parameters<typeof productionRehearsalAuthoring.startPreset>
  ) {
    return productionRehearsalAuthoring.startPreset.apply(this, args);
  }
  applyRehearsal(
    ...args: Parameters<typeof productionRehearsalAuthoring.applyRehearsal>
  ) {
    return productionRehearsalAuthoring.applyRehearsal.apply(this, args);
  }
  editRehearsal(
    ...args: Parameters<typeof productionRehearsalAuthoring.editRehearsal>
  ) {
    return productionRehearsalAuthoring.editRehearsal.apply(this, args);
  }
  addRehearsalChain(
    ...args: Parameters<typeof productionRehearsalAuthoring.addRehearsalChain>
  ) {
    return productionRehearsalAuthoring.addRehearsalChain.apply(this, args);
  }
  rackCase(...args: Parameters<typeof productionRehearsalAuthoring.rackCase>) {
    return productionRehearsalAuthoring.rackCase.apply(this, args);
  }
  rehearsalIngredients(
    ...args: Parameters<
      typeof productionRehearsalAuthoring.rehearsalIngredients
    >
  ) {
    return productionRehearsalAuthoring.rehearsalIngredients.apply(this, args);
  }
  ingredientEditor(
    ...args: Parameters<typeof productionRehearsalAuthoring.ingredientEditor>
  ) {
    return productionRehearsalAuthoring.ingredientEditor.apply(this, args);
  }
  rehearsalWorker(
    ...args: Parameters<typeof productionRehearsalAuthoring.rehearsalWorker>
  ) {
    return productionRehearsalAuthoring.rehearsalWorker.apply(this, args);
  }
  rehearsalCell(
    ...args: Parameters<typeof productionRehearsalAuthoring.rehearsalCell>
  ) {
    return productionRehearsalAuthoring.rehearsalCell.apply(this, args);
  }
  rehearsalStart(
    ...args: Parameters<typeof productionRehearsalAuthoring.rehearsalStart>
  ) {
    return productionRehearsalAuthoring.rehearsalStart.apply(this, args);
  }
  rehearsalPrerequisite(
    ...args: Parameters<
      typeof productionRehearsalAuthoring.rehearsalPrerequisite
    >
  ) {
    return productionRehearsalAuthoring.rehearsalPrerequisite.apply(this, args);
  }
  resetRehearsalTray(
    ...args: Parameters<typeof productionRehearsalAuthoring.resetRehearsalTray>
  ) {
    return productionRehearsalAuthoring.resetRehearsalTray.apply(this, args);
  }
  removeRehearsalTray(
    ...args: Parameters<typeof productionRehearsalAuthoring.removeRehearsalTray>
  ) {
    return productionRehearsalAuthoring.removeRehearsalTray.apply(this, args);
  }
  reviewRehearsalChange(
    ...args: Parameters<
      typeof productionRehearsalAuthoring.reviewRehearsalChange
    >
  ) {
    return productionRehearsalAuthoring.reviewRehearsalChange.apply(this, args);
  }
  resolveRehearsalReview(
    ...args: Parameters<
      typeof productionRehearsalAuthoring.resolveRehearsalReview
    >
  ) {
    return productionRehearsalAuthoring.resolveRehearsalReview.apply(
      this,
      args,
    );
  }
  rehearsalChangeReview(
    ...args: Parameters<
      typeof productionRehearsalAuthoring.rehearsalChangeReview
    >
  ) {
    return productionRehearsalAuthoring.rehearsalChangeReview.apply(this, args);
  }
  locked(...args: Parameters<typeof productionRehearsalAuthoring.locked>) {
    return productionRehearsalAuthoring.locked.apply(this, args);
  }
  rehearsalAuthor(
    ...args: Parameters<typeof productionRehearsalAuthoring.rehearsalAuthor>
  ) {
    return productionRehearsalAuthoring.rehearsalAuthor.apply(this, args);
  }
  trayLayout(
    ...args: Parameters<typeof productionRehearsalAuthoring.trayLayout>
  ) {
    return productionRehearsalAuthoring.trayLayout.apply(this, args);
  }
  previewTrayLayout(
    ...args: Parameters<typeof productionRehearsalAuthoring.previewTrayLayout>
  ) {
    return productionRehearsalAuthoring.previewTrayLayout.apply(this, args);
  }
  prepareTrayLayout(
    ...args: Parameters<typeof productionRehearsalAuthoring.prepareTrayLayout>
  ) {
    return productionRehearsalAuthoring.prepareTrayLayout.apply(this, args);
  }
  discardTrayLayout(
    ...args: Parameters<typeof productionRehearsalAuthoring.discardTrayLayout>
  ) {
    return productionRehearsalAuthoring.discardTrayLayout.apply(this, args);
  }
  applyTrayLayout(
    ...args: Parameters<typeof productionRehearsalAuthoring.applyTrayLayout>
  ) {
    return productionRehearsalAuthoring.applyTrayLayout.apply(this, args);
  }
  editFaults(
    ...args: Parameters<typeof productionRehearsalAuthoring.editFaults>
  ) {
    return productionRehearsalAuthoring.editFaults.apply(this, args);
  }
  outageResource(
    ...args: Parameters<typeof productionRehearsalAuthoring.outageResource>
  ) {
    return productionRehearsalAuthoring.outageResource.apply(this, args);
  }
  outageTime(
    ...args: Parameters<typeof productionRehearsalAuthoring.outageTime>
  ) {
    return productionRehearsalAuthoring.outageTime.apply(this, args);
  }
  failureTask(
    ...args: Parameters<typeof productionRehearsalAuthoring.failureTask>
  ) {
    return productionRehearsalAuthoring.failureTask.apply(this, args);
  }
  failureAfter(
    ...args: Parameters<typeof productionRehearsalAuthoring.failureAfter>
  ) {
    return productionRehearsalAuthoring.failureAfter.apply(this, args);
  }
  recoveryTask(
    ...args: Parameters<typeof productionRehearsalAuthoring.recoveryTask>
  ) {
    return productionRehearsalAuthoring.recoveryTask.apply(this, args);
  }
  recoverySeconds(
    ...args: Parameters<typeof productionRehearsalAuthoring.recoverySeconds>
  ) {
    return productionRehearsalAuthoring.recoverySeconds.apply(this, args);
  }
  rehearsalFaults(
    ...args: Parameters<typeof productionRehearsalAuthoring.rehearsalFaults>
  ) {
    return productionRehearsalAuthoring.rehearsalFaults.apply(this, args);
  }
  pinBaseline(
    ...args: Parameters<typeof productionRehearsalAuthoring.pinBaseline>
  ) {
    return productionRehearsalAuthoring.pinBaseline.apply(this, args);
  }
  clearBaseline(
    ...args: Parameters<typeof productionRehearsalAuthoring.clearBaseline>
  ) {
    return productionRehearsalAuthoring.clearBaseline.apply(this, args);
  }
  baselineComparison(
    ...args: Parameters<typeof productionRehearsalAuthoring.baselineComparison>
  ) {
    return productionRehearsalAuthoring.baselineComparison.apply(this, args);
  }
  rehearsalTray(
    ...args: Parameters<typeof productionRehearsalAuthoring.rehearsalTray>
  ) {
    return productionRehearsalAuthoring.rehearsalTray.apply(this, args);
  }
  rehearsalStep(
    ...args: Parameters<typeof productionRehearsalAuthoring.rehearsalStep>
  ) {
    return productionRehearsalAuthoring.rehearsalStep.apply(this, args);
  }
  rehearsalChoice(
    ...args: Parameters<typeof productionRehearsalAuthoring.rehearsalChoice>
  ) {
    return productionRehearsalAuthoring.rehearsalChoice.apply(this, args);
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
  selectedOperation(): ProductionWorkcell | null {
    if (this.props.session.data.kind !== "ready") return null;
    return (
      this.props.session.data.plan.operations.find(
        matchesOperation.bind(null, this.props.session.operationId),
      ) ?? null
    );
  }
  inspectRequest(operationId: string): void {
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
  chooseNativeOperation(operation: ProductionWorkcell): void {
    if (this.props.session.data.kind !== "ready") return;
    const task = nativeTaskFor(this.props.session.data.run, operation.id);
    if (task !== null) this.inspect(task);
    else this.inspectRequest(operation.id);
  }
  request(): void {
    this.downloadFile("request");
  }
  save(): void {
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
  async open(
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
  exportHandoff(): void {
    this.downloadFile("handoff");
  }
  startFromConversion(): void {
    this.update({
      readOnly: [],
      notice:
        "Started a new rehearsal from the converted run. It no longer includes what was not carried forward.",
    });
  }
  resolveRunOpen(
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
  accept(): void {
    if (this.props.session.data.kind !== "ready") return;
    const pending = this.props.session.pending;
    if (pending.kind === "none") return;
    if (pending.kind === "run") {
      this.resolveRunOpen(pending.review, "apply");
      return;
    }
    void this.acceptResult(pending);
  }
  discardRecording(): void {
    if (this.props.session.pending.kind !== "recording") return;
    this.generation++;
    this.props.authored({
      kind: "productionCandidateDiscarded",
      candidate: this.props.session.pending,
    });
    this.fileInput.current?.focus();
  }
  captureComparison(result: FactoryResult): void {
    const comparisons: FactoryResult[] = [];
    for (const previous of this.state.comparisons)
      if (previous.identity !== result.identity) comparisons.push(previous);
    comparisons.push(result);
    this.setState({ comparisons });
  }
  clearComparisons(): void {
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
              {workspaceTitle(
                this.state.catalogSection,
                this.props.session.procedure === "rehearsal",
              )}
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
  private timelineDrawer(
    ...args: Parameters<typeof productionSurfaceViews.timelineDrawer>
  ) {
    return productionSurfaceViews.timelineDrawer.apply(this, args);
  }
  executing(...args: Parameters<typeof productionSurfaceViews.executing>) {
    return productionSurfaceViews.executing.apply(this, args);
  }
  private browserExecution(
    ...args: Parameters<typeof productionSurfaceViews.browserExecution>
  ) {
    return productionSurfaceViews.browserExecution.apply(this, args);
  }
  runInBrowser(
    ...args: Parameters<typeof productionSurfaceViews.runInBrowser>
  ) {
    return productionSurfaceViews.runInBrowser.apply(this, args);
  }
  catalogSectionContent(
    ...args: Parameters<typeof productionSurfaceViews.catalogSectionContent>
  ) {
    return productionSurfaceViews.catalogSectionContent.apply(this, args);
  }
  catalogMenuList(
    ...args: Parameters<typeof productionSurfaceViews.catalogMenuList>
  ) {
    return productionSurfaceViews.catalogMenuList.apply(this, args);
  }
  private content(...args: Parameters<typeof productionSurfaceViews.content>) {
    return productionSurfaceViews.content.apply(this, args);
  }
  hybridBatchChain(
    ...args: Parameters<typeof productionSurfaceViews.hybridBatchChain>
  ) {
    return productionSurfaceViews.hybridBatchChain.apply(this, args);
  }
  hybridBatchCard(
    ...args: Parameters<typeof productionSurfaceViews.hybridBatchCard>
  ) {
    return productionSurfaceViews.hybridBatchCard.apply(this, args);
  }
  hybridStepChip(
    ...args: Parameters<typeof productionSurfaceViews.hybridStepChip>
  ) {
    return productionSurfaceViews.hybridStepChip.apply(this, args);
  }
  nativeCanvasNode(
    ...args: Parameters<typeof productionSurfaceViews.nativeCanvasNode>
  ) {
    return productionSurfaceViews.nativeCanvasNode.apply(this, args);
  }
  plannedCanvasNode(
    ...args: Parameters<typeof productionSurfaceViews.plannedCanvasNode>
  ) {
    return productionSurfaceViews.plannedCanvasNode.apply(this, args);
  }
  selectManualTask(
    ...args: Parameters<typeof productionAuthorViews.selectManualTask>
  ) {
    return productionAuthorViews.selectManualTask.apply(this, args);
  }
  editManualTask(
    ...args: Parameters<typeof productionAuthorViews.editManualTask>
  ) {
    return productionAuthorViews.editManualTask.apply(this, args);
  }
  manualWorker(...args: Parameters<typeof productionAuthorViews.manualWorker>) {
    return productionAuthorViews.manualWorker.apply(this, args);
  }
  manualStart(...args: Parameters<typeof productionAuthorViews.manualStart>) {
    return productionAuthorViews.manualStart.apply(this, args);
  }
  manualDependency(
    ...args: Parameters<typeof productionAuthorViews.manualDependency>
  ) {
    return productionAuthorViews.manualDependency.apply(this, args);
  }
  manualPredecessor(
    ...args: Parameters<typeof productionAuthorViews.manualPredecessor>
  ) {
    return productionAuthorViews.manualPredecessor.apply(this, args);
  }
  manualAuthor(...args: Parameters<typeof productionAuthorViews.manualAuthor>) {
    return productionAuthorViews.manualAuthor.apply(this, args);
  }
  author(...args: Parameters<typeof productionAuthorViews.author>) {
    return productionAuthorViews.author.apply(this, args);
  }
  batchDetail(...args: Parameters<typeof productionAuthorViews.batchDetail>) {
    return productionAuthorViews.batchDetail.apply(this, args);
  }
  task(...args: Parameters<typeof productionAuthorViews.task>) {
    return productionAuthorViews.task.apply(this, args);
  }
  waitSummary(...args: Parameters<typeof productionAuthorViews.waitSummary>) {
    return productionAuthorViews.waitSummary.apply(this, args);
  }
  requestCard(...args: Parameters<typeof productionAuthorViews.requestCard>) {
    return productionAuthorViews.requestCard.apply(this, args);
  }
  hold(...args: Parameters<typeof productionAuthorViews.hold>) {
    return productionAuthorViews.hold.apply(this, args);
  }
  unresolvedWait(
    ...args: Parameters<typeof productionAuthorViews.unresolvedWait>
  ) {
    return productionAuthorViews.unresolvedWait.apply(this, args);
  }
  track(...args: Parameters<typeof productionAuthorViews.track>) {
    return productionAuthorViews.track.apply(this, args);
  }
  workerTrack(...args: Parameters<typeof productionAuthorViews.workerTrack>) {
    return productionAuthorViews.workerTrack.apply(this, args);
  }
  detailsModeTabs(
    ...args: Parameters<typeof productionAuthorViews.detailsModeTabs>
  ) {
    return productionAuthorViews.detailsModeTabs.apply(this, args);
  }
  details(...args: Parameters<typeof productionAuthorViews.details>) {
    return productionAuthorViews.details.apply(this, args);
  }
  materialDetails(
    ...args: Parameters<typeof productionAuthorViews.materialDetails>
  ) {
    return productionAuthorViews.materialDetails.apply(this, args);
  }
}
