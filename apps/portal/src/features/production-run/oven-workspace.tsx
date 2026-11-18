import { History } from "lucide-react";
import { reportBakeryShift } from "@seams/production-simulation/recipes/bakery/shift-report";
import { Select } from "../../ui/select";
import {
  EspressoPhysicsView,
  readEspressoObservation,
  readEspressoSamples,
} from "./linea/espresso-physics-view";
import { initialEspressoSample } from "./linea/espresso-scene";
import type { ApplianceSample } from "@seams/bakery-model/bakery-appliance-protocol";
import type {
  PersistentEspressoCell,
  PersistentPourOverCell,
} from "@seams/bakery-model/bakery-physics";
import { PourOverPhysicsView } from "./pour-over/pour-over-physics-view";
import {
  readPourOverObservation,
  readPourOverSamples,
  type PourOverSample,
} from "@seams/production-simulation/recipes/pour-over/sample";
import {
  INITIAL_POUR_OVER_SETUP,
  initialPourOverSample,
  readPourOverScene,
  type PourOverSetup,
} from "./pour-over/pour-over-scene";
import { FactoryPhysicsView } from "./factory-physics-view";
import {
  PersistentProductionSurface,
  productionControlDescription,
} from "./persistent-production-surface";
import type { BakeryProductionControl } from "@seams/bakery-model/bakery-surface";
import type { HostIdentity } from "@seams/production-simulation";
import { ProductionResults } from "./production-results";
import { ProductionControls } from "./production-controls";
import {
  ProductionRecoveryControls,
  type ReviewedRecovery,
} from "./production-recovery-controls";
import {
  ProductionScenarioControls,
  type ReviewedScenarioControl,
} from "./production-scenario-controls";
import React from "react";
import { teaStrainTiming } from "@seams/production-simulation/recipes/bakery/tea-process";
import {
  parseHostView,
  parseObservationView,
  type ObservationView,
  readCellPhysicsViews,
  TICK_MICROSECONDS,
  type HostView,
  type InspectionView,
} from "@seams/production-simulation";
import { assertNever, isRecord } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";
import {
  openAuthoredCellWorker,
  openExecutionWorker,
  type ExecutionWorker,
} from "./execution-client";
import {
  readOvenSave,
  exportOvenSave,
  ovenCheckpointContents,
  type ArtifactContent,
  type OvenRunSource,
} from "@seams/production-simulation/runs/oven-run-file";
import { downloadBakeryFile } from "../workflow-simulator/file-download";
import { FactoryOverview } from "./factory-overview";
import {
  FactoryComparison,
  factoryResult,
  type FactoryResult,
} from "./factory-comparison";
import { OvenLogistics, SelectedOvenTask, seconds } from "./oven-logistics";
import { OvenStorageHistory } from "./oven-storage-history";
import { MaterialStorageHistory } from "./material-storage-history";
import { OvenResourceHistory } from "./oven-resource-history";
import { OvenSchedulingHistory } from "./oven-scheduling-history";
import { physicsEvidenceVisible } from "@seams/production-simulation/runs/physics-evidence";
import { OvenTaskViews } from "./oven-task-views";
import type { RecipeGraphSource } from "./recipe-graph";
import { RecipeWorkflowGraph } from "./recipe-workflow-graph";
import { OvenPhysicsView } from "./oven-physics-view";
import {
  OvenRecordings,
  ovenRecordingArchive,
} from "@seams/production-simulation/runs/oven-recordings";
import {
  readOvenScene,
  readOvenLiveFrame,
  type OvenLiveFrame,
  withOvenCommittedAt,
  ovenOperation,
} from "@seams/production-simulation/runs/oven-live-physics";
import type {
  PersistentPhysicsScene,
  PersistentCell,
} from "@seams/bakery-model/bakery-physics";
import {
  RecipeBackButton,
  RecipeSplitDivider,
  RecipeSurfaceSwitch,
  RunIcon,
  TimelineLabel,
  type RecipeSurface,
} from "./recipe-workflow";
import "./oven-workspace.css";
import { ProductionOverview } from "./production-overview";
import { FinancierComparison } from "./financier-comparison";
import {
  financierInput,
  financierResult,
  type FinancierResult,
} from "@seams/production-simulation/runs/financier-results";
import {
  BatchList,
  StationDetails,
  WaitExplanationView,
} from "./wait-explanation-view";
import {
  factoryStationsForScenario,
  financierStation,
  isPieScenario,
} from "./factory-places";
import {
  createApplianceFaultRecord,
  synchronizeCobotTransfers,
  synchronizeMorningShiftAppliances,
  type ApplianceFaultRecord,
  type MorningShiftApplianceCode,
} from "./morning-shift-appliances";
import {
  WorkspaceRunsPanel,
  type WorkspaceRunSaveChanged,
  type PersistentSaveSource,
} from "../workflow-simulator/workspace-runs-panel";
import { preparePersistentWorkspaceRun } from "../workflow-simulator/workspace-runs-api";
import type {
  SimulatorConnection,
  WorkspaceRunSaveStatus,
} from "../workflow-simulator/simulator-state";
import { notifySurfaceListeners } from "../bakery-surface-registry";
import { FloorPlanTravelSync } from "./floor-plan-travel-sync";

type Session = StrictUnion<
  | Readonly<{ kind: "review" | "opening" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{
      kind: "running" | "commanding" | "settled" | "saving";
      worker: ExecutionWorker;
      view: HostView;
    }>
>;
type Props = Readonly<{
  source: OvenRunSource;
  comparisons: readonly FactoryResult[];
  captureComparison(result: FactoryResult): void;
  clearComparisons(): void;
  financierResults: readonly FinancierResult[];
  keepFinancierResult(result: FinancierResult): void;
  replaceFinancierResults(results: readonly FinancierResult[]): void;
  clearFinancierResults(): void;
  connection: SimulatorConnection;
  saveStatus: WorkspaceRunSaveStatus;
  saveChanged: WorkspaceRunSaveChanged;
  close(): void;
}>;
type Inspection = StrictUnion<
  | Readonly<{ kind: "empty" | "loading" }>
  | Readonly<{ kind: "unavailable"; message: string }>
  | Readonly<{ kind: "ready"; playback: OvenLiveFrame }>
>;
type LivePhysics = StrictUnion<
  | Readonly<{
      kind: "espresso";
      cell: PersistentEspressoCell;
      sample: ApplianceSample | null;
      samples?: readonly ApplianceSample[];
    }>
  | Readonly<{
      kind: "pour-over";
      cell: PersistentPourOverCell;
      setup: PourOverSetup;
      sample: PourOverSample | null;
      samples?: readonly PourOverSample[];
    }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "unavailable"; message: string }>
  | Readonly<{
      kind: "observing";
      cells: readonly Readonly<{
        scene: PersistentPhysicsScene;
        frame: OvenLiveFrame | null;
      }>[];
    }>
>;
type HistoryPlayback = StrictUnion<
  | Readonly<{ kind: "paused" }>
  | Readonly<{ kind: "playing"; rate: number; from: number; startedAt: number }>
>;
type Observation = StrictUnion<
  | Readonly<{ kind: "live" | "loading" }>
  | Readonly<{ kind: "unavailable"; message: string }>
  | Readonly<{
      kind: "ready";
      view: ObservationView;
      physics: LivePhysics;
      playback: HistoryPlayback;
    }>
>;

type Panel =
  "scenario" | "logistics" | "results" | "inspector" | "save" | "history";

type State = Readonly<{
  panel: Panel | null;
  surface: RecipeSurface;
  timeline: boolean;
  observation: Observation;
  observationSeconds: string;
  session: Session;
  notice: string;
  selectedTask: string | null;
  selectedCell: string | null;
  inspection: Inspection;
  livePhysics: LivePhysics;
  inspectionSeconds: string;
  inspectionCell: string;
  inspectionNote: string;
  applianceFaults: Readonly<Record<string, ApplianceFaultRecord>>;
}>;
type SavedSource = Extract<OvenRunSource, { kind: "snapshot" }>;
type SavedBoundary = StrictUnion<
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "saved"; worker: ExecutionWorker; source: SavedSource }>
>;

function readView(reply: unknown, kind: string): HostView {
  if (!isRecord(reply) || reply.kind !== kind)
    throw new Error(
      isRecord(reply) && typeof reply.reason === "string"
        ? `The execution refused this action: ${reply.reason}.`
        : "The execution returned an invalid reply.",
    );
  const parsed = parseHostView(reply.view);
  if (!parsed.ok) throw new Error("The execution returned an invalid view.");
  return parsed.value;
}

function canAdvance(view: HostView): boolean {
  switch (view.status.kind) {
    case "ready":
    case "advancing":
    case "awaiting-execution":
      return true;
    case "awaiting-inspection":
    case "pause-requested":
    case "paused":
    case "blocked":
    case "completed":
    case "stopped-at-limit":
      return false;
    default:
      return assertNever(view.status.kind);
  }
}

/**
 * Bring every cell to one committed time before retrying a refused pause.
 * One drive turn moves one cell, and a cell can compute ahead of the others
 * to the next point of the shared grid, so a turn toward the furthest cell
 * brings the others to it.
 */
async function pauseExecution(worker: ExecutionWorker): Promise<unknown> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 64; attempt++) {
    const reply = await worker.request({
      kind: "pause",
      commandId: crypto.randomUUID(),
    });
    const view = readView(reply, "commanded");
    if (!isRecord(reply) || !isRecord(reply.receipt))
      throw new Error("The pause returned no receipt.");
    if (
      reply.receipt.status === "accepted" ||
      reply.receipt.reason !== "boundary_unsettled"
    )
      return reply;
    let until = view.time + TICK_MICROSECONDS;
    for (const cell of view.cells)
      if (cell.boundary > until) until = cell.boundary;
    last = await worker.request({
      kind: "drive",
      turns: 1,
      until: Math.min(until, view.horizon),
    });
    const advanced = readView(last, "drove");
    if (!canAdvance(advanced)) return last;
  }
  return last;
}

function initialLivePhysics(source: OvenRunSource): LivePhysics {
  const cells = sourceCells(source);
  const first = cells[0];
  if (cells.length === 1 && first?.fixture === "persistent-pour-over/1") {
    return {
      kind: "pour-over",
      cell: first,
      setup: INITIAL_POUR_OVER_SETUP,
      sample: initialPourOverSample(first),
    };
  }
  if (cells.length === 1 && first?.fixture === "persistent-espresso/1") {
    return {
      kind: "espresso",
      cell: first,
      sample: initialEspressoSample(first.appliance),
    };
  }
  return { kind: "empty" };
}

const NO_STAGES: readonly [] = [];
function ignoreSeek(): void {}

function sourceScenario(source: OvenRunSource) {
  return source.kind === "snapshot"
    ? source.save.document.state.definition.scenario
    : source.scenario;
}

/** The retained worker owns simulation state. React displays its protocol view. */
export class OvenWorkspace extends React.Component<Props, State> {
  state: State = {
    observation: { kind: "live" },
    observationSeconds: "0",
    session: { kind: "review" },
    notice: "Ready for review.",
    selectedTask: null,
    selectedCell: null,
    inspection: { kind: "empty" },
    livePhysics: initialLivePhysics(this.props.source),
    panel:
      sourceScenario(this.props.source).id === "bakery-shift"
        ? "logistics"
        : null,
    surface: "factory",
    timeline: false,
    inspectionSeconds: "",
    inspectionCell: "",
    inspectionNote: "",
    applianceFaults: {},
  };
  // This synchronous reference also guards requests before React paints a change.
  private session: Session = this.state.session;
  private mounted = false;
  private agentSurface: PersistentProductionSurface | null = null;
  private readonly artifacts = new Map<string, ArtifactContent>();
  private livePhysics: LivePhysics = this.state.livePhysics;
  private readonly recordings = new OvenRecordings();
  private savedBoundary: SavedBoundary = { kind: "empty" };
  private lastPreviewAt = 0;
  private observationRequest = 0;
  private playbackTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly floorPlanSync = new FloorPlanTravelSync({
    isMounted: () => this.mounted,
    isBeforeStart: () =>
      this.session.kind === "review" || this.session.kind === "opening",
    onDirtyBeforeStart: () => this.forceUpdate(),
    canFlushSettledNow: () =>
      this.session.kind === "settled" &&
      this.state.observation.kind === "live" &&
      (this.session.view.status.kind === "paused" ||
        this.session.view.status.kind === "ready" ||
        this.session.view.status.kind === "awaiting-inspection"),
    onFlushSettled: () => void this.flushSettledFloorPlanSync(),
  });

  private async flushSettledFloorPlanSync(
    options?: Readonly<{
      forceFirstWorker?: boolean;
      expectedControlRevision?: number;
      label?: string;
    }>,
  ): Promise<void> {
    if (
      this.state.observation.kind !== "live" ||
      this.session.kind !== "settled"
    )
      return;
    const { worker, view } = this.session;
    if (
      view.status.kind === "completed" ||
      view.status.kind === "blocked" ||
      view.status.kind === "stopped-at-limit"
    ) {
      this.floorPlanSync.consumePendingSync();
      return;
    }
    this.floorPlanSync.consumePendingSync();
    this.updateSession(
      { kind: "commanding", worker, view },
      "Updating floor-plan walk routes…",
    );
    try {
      const synced = await this.floorPlanSync.syncWorkerTravel(
        this.props.source,
        worker,
        view,
        {
          forceFirstWorker: options?.forceFirstWorker ?? false,
          ...(options?.expectedControlRevision !== undefined
            ? { expectedControlRevision: options.expectedControlRevision }
            : {}),
          ...(options?.label !== undefined ? { label: options.label } : {}),
        },
      );
      if (!this.mounted) return;
      if (synced === null) {
        this.updateSession(
          { kind: "settled", worker, view },
          options?.label ?? "Floor-plan station placement updated.",
        );
        return;
      }
      this.updateSession(
        { kind: "settled", worker, view: synced.view },
        synced.notice,
      );
      notifySurfaceListeners();
    } catch (error) {
      if (this.mounted)
        this.updateSession(
          { kind: "settled", worker, view },
          error instanceof Error
            ? error.message
            : "Could not update floor-plan walk routes.",
        );
    }
  }

  componentDidMount(): void {
    this.mounted = true;
    this.floorPlanSync.connect();
    if (this.props.source.kind === "snapshot")
      for (const artifact of this.props.source.save.artifacts)
        this.artifacts.set(artifact.digest, artifact);
    if (
      this.props.source.kind === "snapshot" &&
      this.props.connection.kind === "workspace"
    ) {
      const document = this.props.source.save.document;
      this.agentSurface = new PersistentProductionSurface({
        kind: "snapshot",
        organisationId: this.props.connection.organisationId,
        changed: this.agentChanged.bind(this),
        snapshot: {
          kind: "persistent-snapshot",
          snapshotId: document.snapshot,
          runId: document.state.identity.runId,
          bundleId: document.bundle.id,
          time: document.state.position.time,
          events: document.state.events.length,
        },
      });
    }
  }

  componentWillUnmount(): void {
    this.mounted = false;
    this.floorPlanSync.dispose();
    this.agentSurface?.close();
    this.agentSurface = null;
    this.clearPlaybackTimer();
    this.currentWorker()?.terminate();
  }

  private currentWorker(): ExecutionWorker | null {
    switch (this.session.kind) {
      case "running":
      case "commanding":
      case "settled":
      case "saving":
        return this.session.worker;
      case "review":
      case "opening":
      case "failed":
        return null;
      default:
        return assertNever(this.session);
    }
  }

  private updateSession(session: Session, notice: string): void {
    if (!this.mounted) return;
    this.session = session;
    this.setState({ session, notice });
  }

  private fail(error: unknown): void {
    this.agentSurface?.close();
    this.agentSurface = null;
    this.currentWorker()?.terminate();
    const message =
      error instanceof Error ? error.message : "The execution failed.";
    this.updateSession({ kind: "failed", message }, message);
  }

  private selectTask(task: string): void {
    if (this.state.selectedTask !== task)
      this.setState({
        selectedTask: task,
        selectedCell: null,
        panel: "inspector",
        inspection: { kind: "empty" },
      });
    else this.setState({ panel: "inspector" });
  }

  private reviewRecovery(): void {
    this.setState({ panel: "scenario" });
  }

  private selectFactoryCell(cell: string, task: string | null): void {
    this.setState({
      selectedCell: cell,
      selectedTask: task,
      inspectionCell: cell,
      panel: "inspector",
      inspection: { kind: "empty" },
    });
  }

  private injectApplianceFault(appliance: MorningShiftApplianceCode): void {
    const timeUs =
      this.state.session.kind === "running" ||
      this.state.session.kind === "settled" ||
      this.state.session.kind === "commanding" ||
      this.state.session.kind === "saving"
        ? this.state.session.view.time
        : 0;
    const record = createApplianceFaultRecord(appliance, timeUs);
    this.setState((prev) => ({
      applianceFaults: {
        ...prev.applianceFaults,
        [appliance]: record,
      },
      notice: `Injected mid-cycle ${record.code} fault on ${appliance} (checkpoint ${record.checkpointDigest.slice(0, 8)}).`,
    }));
  }

  private restoreApplianceCheckpoint(
    appliance: MorningShiftApplianceCode,
  ): void {
    const timeUs =
      this.state.session.kind === "running" ||
      this.state.session.kind === "settled" ||
      this.state.session.kind === "commanding" ||
      this.state.session.kind === "saving"
        ? this.state.session.view.time
        : 0;
    const restoredAtSeconds = Number((timeUs / 1_000_000).toFixed(1));
    this.setState((prev) => {
      const existing =
        prev.applianceFaults[appliance] ??
        createApplianceFaultRecord(appliance, timeUs);
      return {
        applianceFaults: {
          ...prev.applianceFaults,
          [appliance]: {
            ...existing,
            restored: true,
            restoredAtSeconds,
          },
        },
        notice: `Restored ${appliance} from checkpoint ${existing.checkpointDigest.slice(0, 8)} at ${restoredAtSeconds} s.`,
      };
    });
  }

  private rememberSave(source: SavedSource, worker: ExecutionWorker): void {
    this.artifacts.clear();
    for (const artifact of source.save.artifacts)
      this.artifacts.set(artifact.digest, artifact);
    this.savedBoundary = { kind: "saved", worker, source };
  }

  private async readSave(
    worker: ExecutionWorker,
    view: HostView,
  ): Promise<SavedSource> {
    const cached = this.savedBoundary;
    if (cached.kind === "saved" && cached.worker === worker) {
      const position = cached.source.save.document.state.position;
      if (
        position.time === view.time &&
        position.controlRevision === view.controlRevision &&
        position.eventSequence === view.events &&
        position.horizon === view.horizon &&
        cached.source.save.document.state.status.kind === view.status.kind
      )
        return cached.source;
    }
    const reply = await worker.request({ kind: "save" });
    for (const [digest, artifact] of worker.artifacts.files)
      this.artifacts.set(digest, artifact);
    const checked = await readOvenSave(reply, this.artifacts);
    if (!checked.ok) throw new Error(checked.error);
    this.rememberSave(checked.value, worker);
    return checked.value;
  }

  private sharedSaveSource(): PersistentSaveSource | null {
    if (
      this.state.observation.kind !== "live" ||
      this.session.kind !== "settled"
    )
      return null;
    const view = this.session.view;
    return {
      identity: `${view.time}/${view.controlRevision}/${view.events}/${view.status.kind}`,
      prepare: this.prepareSharedSave.bind(this),
    };
  }

  private async prepareSharedSave(name: string) {
    if (this.session.kind !== "settled")
      throw new Error("Pause the run before saving a shared copy.");
    const { worker, view } = this.session;
    const saved = await this.readSave(worker, view);
    if (
      this.session.kind !== "settled" ||
      this.session.worker !== worker ||
      this.session.view !== view
    )
      throw new Error(
        "The run changed while preparing the copy. Review it again.",
      );
    return preparePersistentWorkspaceRun(name, saved.save);
  }

  private setLivePhysics(livePhysics: LivePhysics): void {
    if (!this.mounted) return;
    this.livePhysics = livePhysics;
    this.setState({ livePhysics });
  }

  private async openLivePhysics(worker: ExecutionWorker): Promise<void> {
    const source = this.props.source;
    const cells = sourceCells(source);
    if (cells.length === 0) return;
    try {
      const espresso = cells[0];
      if (cells.length === 1 && espresso?.fixture === "persistent-espresso/1") {
        const sample = readEspressoObservation(
          await worker.request({
            kind: "appliance-observation",
            cell: espresso.cellId,
          }),
          espresso,
        );
        this.setLivePhysics({ kind: "espresso", cell: espresso, sample });
        return;
      }
      const station = cells[0];
      if (cells.length === 1 && station?.fixture === "persistent-pour-over/1") {
        const setup = readPourOverScene(
          station,
          await worker.request({ kind: "scene", cell: station.cellId }),
        );
        const sample = readPourOverObservation(
          await worker.request({
            kind: "pour-over-observation",
            cell: station.cellId,
          }),
          station,
        );
        this.setLivePhysics({
          kind: "pour-over",
          cell: station,
          setup,
          sample,
        });
        return;
      }
      const observed = [];
      for (const cell of cells) {
        const scene = readOvenScene(
          cell,
          await worker.request({ kind: "scene", cell: cell.cellId }),
        );
        const frame =
          source.kind === "snapshot"
            ? await this.recordings.latest(
                ovenRecordingArchive(source.save),
                scene,
                source.save.document.state.position.time,
              )
            : null;
        observed.push({ scene, frame });
      }
      this.setLivePhysics({ kind: "observing", cells: observed });
      if (this.mounted)
        this.setState({ inspectionCell: cells[0]?.cellId ?? "" });
    } catch (error) {
      this.setLivePhysics({
        kind: "unavailable",
        message:
          error instanceof Error
            ? error.message
            : "Live physics is unavailable.",
      });
    }
  }

  private async observePhysics(reply: unknown, view: HostView): Promise<void> {
    const live = this.livePhysics;
    if (
      live.kind !== "observing" &&
      live.kind !== "espresso" &&
      live.kind !== "pour-over"
    )
      return;
    try {
      if (!isRecord(reply) || reply.physics === undefined)
        throw new Error(
          "This retained build does not provide live observations. Paused inspection remains available.",
        );
      const observations = readCellPhysicsViews(reply.physics, view.time);
      if (live.kind === "pour-over") {
        const collected: PourOverSample[] = [];
        for (const observation of observations) {
          if (
            observation.kind !== "unavailable" &&
            observation.cell === live.cell.cellId
          ) {
            const batch = await readPourOverSamples(observation, live.cell);
            for (const item of batch)
              if (collected.at(-1)?.step !== item.step) collected.push(item);
          }
        }
        const latest = collected.at(-1);
        if (latest !== undefined)
          this.setLivePhysics({
            ...live,
            sample: latest,
            samples: collected,
          });
        return;
      }
      if (live.kind === "espresso") {
        const collected: ApplianceSample[] = [];
        for (const observation of observations) {
          if (
            observation.kind !== "unavailable" &&
            observation.cell === live.cell.cellId
          ) {
            const batch = await readEspressoSamples(observation, live.cell);
            for (const item of batch)
              if (collected.at(-1)?.timeSeconds !== item.timeSeconds)
                collected.push(item);
          }
        }
        const latest = collected.at(-1);
        if (latest !== undefined)
          this.setLivePhysics({
            kind: "espresso",
            cell: live.cell,
            sample: latest,
            samples: collected,
          });
        return;
      }

      const cells = [];
      for (const cell of live.cells) {
        const previous = cell.frame;
        if (previous !== null && view.time < previous.committedAt) return;
        let frame =
          previous === null ? null : withOvenCommittedAt(previous, view.time);
        for (const observation of observations) {
          if (
            observation.kind === "unavailable" ||
            observation.cell !== cell.scene.cell.cellId
          )
            continue;
          frame = await readOvenLiveFrame(cell.scene, observation, view.time);
          if (previous !== null && frame.at < previous.at)
            throw new Error(
              "The live recording moved behind its accepted cursor.",
            );
        }
        cells.push({ scene: cell.scene, frame });
      }
      this.setLivePhysics({ kind: "observing", cells });
    } catch (error) {
      this.setLivePhysics({
        kind: "unavailable",
        message:
          error instanceof Error
            ? error.message
            : "The live observation is unavailable.",
      });
    }
  }

  private chooseInspectionCell(cell: string | null): void {
    if (cell === null) return;
    this.setState({
      inspectionCell: cell,
      inspection: { kind: "empty" },
    });
  }

  private liveCell(
    cell: Readonly<{
      scene: PersistentPhysicsScene;
      frame: OvenLiveFrame | null;
    }>,
  ): React.ReactNode {
    return (
      <div key={cell.scene.cell.cellId} data-live-cell={cell.scene.cell.cellId}>
        {cell.frame === null ? (
          <p>
            Waiting for an accepted motion sample from {cell.scene.cell.cellId}.
          </p>
        ) : (
          <OvenPhysicsView
            kind={
              this.state.observation.kind === "ready" ? "observation" : "live"
            }
            playback={cell.frame}
            select={this.selectTask.bind(this)}
          />
        )}
      </div>
    );
  }

  private togglePanel(panel: Panel): void {
    this.setState({ panel: this.state.panel === panel ? null : panel });
  }

  private closePanel(): void {
    this.setState({ panel: null });
  }

  private backToRecipes(): void {
    const kind = this.state.session.kind;
    if (
      (kind === "running" || kind === "commanding" || kind === "opening") &&
      !window.confirm("Stop this run? Unsaved progress ends.")
    )
      return;
    this.props.close();
  }

  private graphSource: RecipeGraphSource | null = null;
  /** One value for one run source, because the graph compares its source. */
  private recipeSource(
    source: Exclude<OvenRunSource, Readonly<{ kind: "snapshot" }>>,
  ): RecipeGraphSource {
    this.graphSource ??= {
      kind: "compiled",
      title: source.name ?? source.scenario.id,
      scenario: source.scenario,
      cells: sourceCells(source),
    };
    return this.graphSource;
  }
  private chooseSurface(surface: RecipeSurface): void {
    // An open panel would cover the canvas tools. A person opens one when needed.
    this.setState({
      surface,
      panel:
        surface === "workflow" || surface === "split" ? null : this.state.panel,
    });
  }

  private toggleTimeline(): void {
    this.setState({ timeline: !this.state.timeline });
  }

  private primaryControl(): React.ReactNode {
    const live = this.state.observation.kind === "live";
    switch (this.state.session.kind) {
      case "review":
        return (
          <button
            className="production-primary"
            onClick={this.start.bind(this)}
          >
            <RunIcon action="start" />
            {this.props.source.kind === "snapshot"
              ? "Continue saved run"
              : "Start production"}
          </button>
        );
      case "running":
        return (
          <button
            className="production-primary"
            onClick={this.pause.bind(this)}
          >
            <RunIcon action="pause" />
            Pause production run
          </button>
        );
      case "settled":
        if (this.state.session.view.status.kind === "completed")
          return (
            <button
              className="production-primary"
              disabled={!live}
              onClick={this.restart.bind(this)}
            >
              <RunIcon action="again" />
              Run again
            </button>
          );
        return (
          <button
            className="production-primary"
            disabled={!live || this.state.session.view.status.kind !== "paused"}
            onClick={this.resume.bind(this)}
          >
            <RunIcon action="start" />
            Resume production run
          </button>
        );
      case "opening":
        return <button disabled>Opening factory…</button>;
      case "commanding":
        return <button disabled>Applying change…</button>;
      case "saving":
        return <button disabled>Preparing save…</button>;
      case "failed":
        return <button disabled>Run unavailable</button>;
      default:
        return assertNever(this.state.session);
    }
  }

  private restart(): void {
    if (
      this.state.observation.kind !== "live" ||
      this.session.kind !== "settled" ||
      this.session.view.status.kind !== "completed"
    )
      return;
    this.clearPlaybackTimer();
    this.observationRequest += 1;
    this.currentWorker()?.terminate();
    this.savedBoundary = { kind: "empty" };
    this.setState({
      observation: { kind: "live" },
      inspection: { kind: "empty" },
      selectedTask: null,
      selectedCell: null,
    });
    this.session = { kind: "review" };
    void this.start();
  }

  private setInspectionSeconds(
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    this.setState({ inspectionSeconds: event.currentTarget.value });
  }

  private closePhysicsInspection(): void {
    this.setState({ inspection: { kind: "empty" } });
  }

  private async inspectCellPhysics(): Promise<void> {
    if (
      this.session.kind !== "settled" ||
      this.livePhysics.kind !== "observing"
    )
      return;
    const { worker, view } = this.session;
    const requested =
      this.state.inspectionSeconds === ""
        ? view.time
        : Math.round(Number(this.state.inspectionSeconds) * 1_000_000);
    if (
      !Number.isSafeInteger(requested) ||
      requested < 0 ||
      requested > view.time
    ) {
      this.setState({
        inspection: {
          kind: "unavailable",
          message: "Choose a time within the committed run.",
        },
      });
      return;
    }
    this.setState({ inspection: { kind: "loading" } });
    this.updateSession(
      { kind: "saving", worker, view },
      "Reading accepted cell recordings…",
    );
    try {
      const source = await this.readSave(worker, view);
      const scene = this.inspectionScene(this.state.inspectionCell);
      const playback = await this.recordings.latest(
        ovenRecordingArchive(source.save),
        scene,
        requested,
      );
      if (playback === null)
        throw new Error("This time has no accepted physics recording.");
      if (this.mounted)
        this.setState({ inspection: { kind: "ready", playback } });
    } catch (error) {
      if (this.mounted)
        this.setState({
          inspection: {
            kind: "unavailable",
            message:
              error instanceof Error
                ? error.message
                : "Cell inspection is unavailable.",
          },
        });
    }
    this.updateSession(
      { kind: "settled", worker, view },
      "Cell inspection reads accepted recordings only.",
    );
  }

  private inspectionScene(cellId: string): PersistentPhysicsScene {
    if (this.livePhysics.kind === "observing")
      for (const cell of this.livePhysics.cells)
        if (cell.scene.cell.cellId === cellId) return cell.scene;
    throw new Error("The selected cell has no available scene.");
  }

  private async inspectPhysics(): Promise<void> {
    if (this.session.kind !== "settled" || this.state.selectedTask === null)
      return;
    const { worker, view } = this.session;
    const task = this.state.selectedTask;
    this.setState({ inspection: { kind: "loading" } });
    this.updateSession(
      { kind: "saving", worker, view },
      "Reading accepted physics recordings…",
    );
    let inspection: Inspection;
    try {
      const source = await this.readSave(worker, view);
      if (!this.mounted) return;
      const operation = ovenOperation(source.save.document.state, task);
      const scene = this.inspectionScene(operation.cell);
      const playback = await this.recordings.operation(
        ovenRecordingArchive(source.save),
        scene,
        task,
      );
      inspection = { kind: "ready", playback };
    } catch (error) {
      inspection = {
        kind: "unavailable",
        message:
          error instanceof Error
            ? error.message
            : "The recording is unavailable.",
      };
    }
    if (!this.mounted) return;
    this.setState({
      inspection:
        this.state.selectedTask === task ? inspection : { kind: "empty" },
    });
    this.updateSession(
      { kind: "settled", worker, view },
      "Run state is unchanged. Save before closing to retain progress.",
    );
  }

  private async start(): Promise<void> {
    if (this.session.kind !== "review") return;
    this.agentSurface?.close();
    this.agentSurface = null;
    this.updateSession(
      { kind: "opening" },
      "Opening the retained execution build…",
    );
    let worker: ExecutionWorker | null = null;
    try {
      const source = this.props.source;
      const opened =
        source.kind === "definition" || source.kind === "native-recipe"
          ? await openAuthoredCellWorker(
              source.kind === "definition" ? source.definition : source,
            )
          : await openExecutionWorker(
              source.kind === "snapshot"
                ? source.save.document.bundle
                : source.kind === "logistics"
                  ? source.bundle
                  : null,
            );
      if (!opened.ok)
        throw new Error(`Cannot start this run: ${opened.error.code}.`);
      worker = opened.value;
      if (!this.mounted) {
        worker.terminate();
        return;
      }
      const executionId = crypto.randomUUID();
      const parent =
        source.kind !== "snapshot"
          ? null
          : {
              snapshot: source.save.document.snapshot,
              execution: source.save.document.state.identity.executionId,
            };
      const identity: HostIdentity = {
        runId:
          source.kind === "snapshot"
            ? source.save.document.state.identity.runId
            : crypto.randomUUID(),
        executionId,
        hostSession: crypto.randomUUID(),
        parent,
      };
      const reply = await worker.request({
        kind: "begin",
        bundle: worker.manifest.bundle,
        cells: sourceCells(source),
        identity,
        origin:
          source.kind !== "snapshot"
            ? { kind: "scenario", scenario: source.scenario }
            : {
                kind: "snapshot",
                document: source.save.document,
                checkpoints: await ovenCheckpointContents(source.save),
              },
      });
      if (!this.mounted) {
        worker.terminate();
        return;
      }
      let view = readView(reply, "began");
      this.floorPlanSync.initializeBaseline(source);
      await this.openLivePhysics(worker);
      if (!this.mounted) {
        worker.terminate();
        return;
      }
      view = await this.floorPlanSync.syncInitialIfDirty(source, worker, view);
      if (!this.mounted) {
        worker.terminate();
        return;
      }
      this.updateSession({ kind: "running", worker, view }, "Running.");
      this.agentSurface = new PersistentProductionSurface({
        kind: "execution",
        organisationId:
          this.props.connection.kind === "workspace"
            ? this.props.connection.organisationId
            : "local-workspace",
        identity,
        bundleId: worker.manifest.bundle.id,
        observe: this.agentView.bind(this, worker),
        live: this.agentLive.bind(this),
        faultedAppliances: () => this.state.applianceFaults,
        changed: this.agentChanged.bind(this),
        apply: this.applyAgentControl.bind(this),
      });
      await this.drive(worker);
    } catch (error) {
      worker?.terminate();
      this.fail(error);
    }
  }

  private agentView(worker: ExecutionWorker): HostView | null {
    if (this.currentWorker() !== worker || !this.mounted) return null;
    return this.session.view ?? null;
  }
  private agentLive(): boolean {
    return (
      this.state.observation.kind === "live" &&
      (this.session.kind === "running" || this.session.kind === "settled")
    );
  }
  private agentChanged(): void {
    if (!this.mounted) return;
    if (
      this.agentSurface?.review !== null &&
      this.agentSurface?.review !== undefined &&
      this.state.panel !== "scenario" &&
      this.state.panel !== "inspector"
    ) {
      this.setState({ panel: "scenario" });
      return;
    }
    this.forceUpdate();
  }
  private async proposeChatApplianceRecovery(
    appliance: MorningShiftApplianceCode,
  ): Promise<void> {
    if (this.session.kind === "running") {
      await this.pause();
    }
    const fault = this.state.applianceFaults[appliance];
    if (fault === undefined || fault.restored) return;
    try {
      const review = await this.agentSurface?.proposeLocalControl({
        kind: "recover-appliance-fault",
        appliance,
        checkpointDigest: fault.checkpointDigest,
      });
      if (review !== undefined && this.mounted) {
        this.setState({
          notice: `Chat proposed fault recovery for ${appliance} (review ${review.digest.slice(0, 8)}).`,
        });
      }
    } catch (error) {
      if (this.mounted)
        this.setState({
          notice:
            error instanceof Error
              ? error.message
              : "Could not prepare chat recovery proposal.",
        });
    }
  }
  private async confirmAgentControl(): Promise<void> {
    try {
      await this.agentSurface?.confirm();
    } catch (error) {
      if (this.mounted)
        this.setState({
          notice:
            error instanceof Error
              ? error.message
              : "The production proposal could not be applied.",
        });
    }
  }
  private discardAgentControl(): void {
    this.agentSurface?.discard();
  }
  private async applyAgentControl(
    control: BakeryProductionControl,
  ): Promise<void> {
    switch (control.kind) {
      case "pause":
        return this.pause();
      case "resume":
        return this.resume();
      case "close-arrivals":
        return this.closeArrivals(control.source);
      case "recover-appliance-fault":
        this.restoreApplianceCheckpoint(
          control.appliance as MorningShiftApplianceCode,
        );
        return;
      case "extend-horizon":
      case "withhold-resource": {
        if (this.session.kind !== "settled") return;
        const commandId = crypto.randomUUID();
        const expectedControlRevision = this.session.view.controlRevision;
        return control.kind === "extend-horizon"
          ? this.applyScenarioControl({
              kind: "extend-horizon",
              commandId,
              expectedControlRevision,
              horizon: control.horizon,
            })
          : this.applyScenarioControl({
              kind: "withhold-resource",
              commandId,
              expectedControlRevision,
              resource: control.resource,
              interval: control.interval,
            });
      }
      case "move-equipment":
      case "rotate-equipment": {
        if (this.session.kind !== "settled") return;
        const expectedControlRevision = this.session.view.controlRevision;
        const outcome = this.floorPlanSync.applyEquipmentPlacement(
          this.props.source,
          control,
        );
        if (outcome.kind === "blocked") {
          this.setState({ notice: outcome.notice });
          return;
        }
        await this.flushSettledFloorPlanSync({
          forceFirstWorker: true,
          expectedControlRevision,
          label: outcome.label,
        });
        return;
      }
      default:
        return assertNever(control);
    }
  }

  private async drive(worker: ExecutionWorker): Promise<void> {
    while (
      this.mounted &&
      this.session.kind === "running" &&
      this.session.worker === worker
    ) {
      if (this.floorPlanSync.hasReadyPendingSync()) {
        const synced = await this.floorPlanSync.syncPendingBeforeDrive(
          this.props.source,
          worker,
          this.session.view,
        );
        if (
          !this.mounted ||
          this.session.kind !== "running" ||
          this.session.worker !== worker
        )
          return;
        if (synced !== null) {
          this.updateSession(
            { kind: "running", worker, view: synced.view },
            synced.notice,
          );
          notifySurfaceListeners();
        }
      }
      const startedAt = performance.now();
      const pourOver = this.livePhysics.kind === "pour-over";
      const espresso = this.livePhysics.kind === "espresso";
      const phase =
        this.livePhysics.kind === "pour-over"
          ? (this.livePhysics.sample?.control.phase ?? "")
          : "";
      const resting = phase.startsWith("rest-") || phase === "drainage";
      const reply = await worker.request({
        kind: "drive",
        // Bound the wait for the next control or visible update. Each native
        // operation can now advance 32 steps while other cells hold still.
        turns: pourOver ? (resting ? 6 : 2) : espresso ? 4 : 32,
        until: this.session.view.horizon,
      });
      if (
        !this.mounted ||
        this.session.kind !== "running" ||
        this.session.worker !== worker
      )
        return;
      const view = readView(reply, "drove");
      // Execution and artifact delivery continue between disposable previews.
      const now = performance.now();
      if (
        !pourOver &&
        !espresso &&
        canAdvance(view) &&
        now - this.lastPreviewAt < 100
      ) {
        this.session = { kind: "running", worker, view };
        continue;
      }
      this.lastPreviewAt = now;
      await this.observePhysics(reply, view);
      if (
        !this.mounted ||
        this.session.kind !== "running" ||
        this.session.worker !== worker
      )
        return;
      this.updateSession(
        { kind: canAdvance(view) ? "running" : "settled", worker, view },
        canAdvance(view) ? "Running." : `Run status: ${view.status.kind}.`,
      );
      if ((pourOver || espresso) && canAdvance(view)) {
        const minBatchMs = pourOver ? (resting ? 24 : 48) : 34;
        const remaining = minBatchMs - (performance.now() - startedAt);
        if (remaining > 4)
          await new Promise((resolve) => setTimeout(resolve, remaining));
      }
    }
  }

  private async pause(): Promise<void> {
    if (this.session.kind !== "running") return;
    const { worker, view } = this.session;
    this.updateSession(
      { kind: "commanding", worker, view },
      "Pausing at a committed physics boundary…",
    );
    try {
      const reply = await pauseExecution(worker);
      if (!this.mounted) return;
      const paused = readView(
        reply,
        isRecord(reply) && reply.kind === "drove" ? "drove" : "commanded",
      );
      await this.observePhysics(reply, paused);
      if (!this.mounted) return;
      if (canAdvance(paused)) {
        this.updateSession(
          { kind: "running", worker, view: paused },
          "The cells have not reached a shared save boundary. Pause again, or abort from the last complete save.",
        );
        await this.drive(worker);
        return;
      }
      this.updateSession(
        { kind: "settled", worker, view: paused },
        "The run reached a save boundary. Save before closing to retain progress.",
      );
    } catch (error) {
      this.fail(error);
    }
  }

  private async resume(): Promise<void> {
    if (
      this.state.observation.kind !== "live" ||
      this.session.kind !== "settled" ||
      this.session.view.status.kind !== "paused"
    )
      return;
    const { worker, view } = this.session;
    this.setState({ inspection: { kind: "empty" } });
    this.updateSession({ kind: "commanding", worker, view }, "Resuming…");
    try {
      const reply = await worker.request({
        kind: "resume",
        commandId: crypto.randomUUID(),
      });
      if (!this.mounted) return;
      const resumed = readView(reply, "commanded");
      await this.observePhysics(reply, resumed);
      if (!this.mounted) return;
      this.updateSession(
        { kind: "running", worker, view: resumed },
        "Running.",
      );
      await this.drive(worker);
    } catch (error) {
      this.fail(error);
    }
  }

  private async closeArrivals(source: string): Promise<void> {
    if (
      this.state.observation.kind !== "live" ||
      this.session.kind !== "settled" ||
      this.session.view.status.kind !== "paused"
    )
      return;
    const { worker, view } = this.session;
    this.updateSession(
      { kind: "commanding", worker, view },
      "Closing future arrivals…",
    );
    try {
      const reply = await worker.request({
        kind: "close-arrivals",
        commandId: crypto.randomUUID(),
        expectedControlRevision: view.controlRevision,
        source,
      });
      if (!this.mounted) return;
      const updated = readView(reply, "commanded");
      if (!isRecord(reply) || !isRecord(reply.receipt))
        throw new Error("The command returned no receipt.");
      const notice =
        reply.receipt.status === "accepted"
          ? "Arrival closure accepted. Resume to apply it and drain admitted work."
          : `Arrival closure refused: ${String(reply.receipt.reason)}.`;
      this.updateSession({ kind: "settled", worker, view: updated }, notice);
    } catch (error) {
      if (this.mounted)
        this.updateSession(
          { kind: "settled", worker, view },
          error instanceof Error ? error.message : "Arrival closure failed.",
        );
    }
  }

  private setObservationSeconds(
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    this.setState({ observationSeconds: event.currentTarget.value });
  }

  private async applyScenarioControl(
    command: ReviewedScenarioControl | ReviewedRecovery,
  ): Promise<void> {
    if (
      this.state.observation.kind !== "live" ||
      this.session.kind !== "settled"
    )
      return;
    const { worker, view } = this.session;
    this.updateSession(
      { kind: "commanding", worker, view },
      "Applying the reviewed scenario change…",
    );
    try {
      const reply = await worker.request(command);
      if (!this.mounted) return;
      const updated = readView(reply, "commanded");
      if (!isRecord(reply) || !isRecord(reply.receipt))
        throw new Error("The command returned no receipt.");
      const notice =
        reply.receipt.status === "accepted"
          ? "Scenario change accepted. Paused runs apply scheduled changes when resumed."
          : `Scenario change refused: ${String(reply.receipt.reason)}.`;
      this.updateSession(
        {
          kind: canAdvance(updated) ? "running" : "settled",
          worker,
          view: updated,
        },
        notice,
      );
      if (canAdvance(updated)) await this.drive(worker);
    } catch (error) {
      if (this.mounted)
        this.updateSession(
          { kind: "settled", worker, view },
          error instanceof Error ? error.message : "Scenario change failed.",
        );
    }
  }

  private returnToLive(): void {
    this.clearPlaybackTimer();
    this.observationRequest += 1;
    this.setState(
      {
        observation: { kind: "live" },
        inspection: { kind: "empty" },
      },
      () => {
        if (
          this.floorPlanSync.hasReadyPendingSync() &&
          this.session.kind === "settled"
        ) {
          void this.flushSettledFloorPlanSync();
        }
      },
    );
  }

  private async observeHistory(): Promise<void> {
    if (this.session.kind !== "settled") return;
    const { view } = this.session;
    this.clearPlaybackTimer();
    this.observationRequest += 1;
    const at = Math.round(Number(this.state.observationSeconds) * 1e6);
    if (
      !Number.isSafeInteger(at) ||
      at < 0 ||
      at > view.time ||
      at % 2000 !== 0
    ) {
      this.setState({
        observation: {
          kind: "unavailable",
          message: "Choose a committed time on the 2 ms grid.",
        },
      });
      return;
    }
    this.setState({
      observation: { kind: "loading" },
      inspection: { kind: "empty" },
      selectedTask: null,
      selectedCell: null,
    });
    await this.readObservation(at, { kind: "paused" });
  }

  private clearPlaybackTimer(): void {
    if (this.playbackTimer !== null) clearTimeout(this.playbackTimer);
    this.playbackTimer = null;
  }

  private playHistory(rate: number): void {
    const observation = this.state.observation;
    if (observation.kind !== "ready" || this.session.kind !== "settled") return;
    this.clearPlaybackTimer();
    this.observationRequest += 1;
    this.setState(
      {
        observation: {
          kind: "ready",
          view: observation.view,
          physics: observation.physics,
          playback: {
            kind: "playing",
            rate,
            from: observation.view.time,
            startedAt: performance.now(),
          },
        },
      },
      this.schedulePlayback.bind(this),
    );
  }

  private pauseHistory(): void {
    this.clearPlaybackTimer();
    this.observationRequest += 1;
    const observation = this.state.observation;
    if (observation.kind !== "ready") return;
    this.setState({
      observation: {
        kind: "ready",
        view: observation.view,
        physics: observation.physics,
        playback: { kind: "paused" },
      },
    });
  }

  private schedulePlayback(): void {
    this.clearPlaybackTimer();
    if (
      this.mounted &&
      this.state.observation.kind === "ready" &&
      this.state.observation.playback.kind === "playing"
    )
      this.playbackTimer = setTimeout(this.advancePlayback.bind(this), 200);
  }

  private async advancePlayback(): Promise<void> {
    const observation = this.state.observation;
    if (
      !this.mounted ||
      observation.kind !== "ready" ||
      observation.playback.kind !== "playing" ||
      this.session.kind !== "settled"
    )
      return;
    const playback = observation.playback;
    const elapsed =
      (performance.now() - playback.startedAt) * 1000 * playback.rate;
    const at = Math.min(
      this.session.view.time,
      Math.floor((playback.from + elapsed) / 2000) * 2000,
    );
    await this.readObservation(
      at,
      at === this.session.view.time ? { kind: "paused" } : playback,
    );
  }

  private async readObservation(
    at: number,
    playback: HistoryPlayback,
  ): Promise<void> {
    if (this.session.kind !== "settled") return;
    const { worker, view } = this.session;
    const request = ++this.observationRequest;
    try {
      const reply = await worker.request({ kind: "observe", at });
      if (!isRecord(reply) || reply.kind !== "observed")
        throw new Error(
          "This retained execution cannot inspect logistics history.",
        );
      const checked = parseObservationView(reply.observation);
      if (!checked.ok || checked.value.time !== at)
        throw new Error(
          "The retained execution returned an invalid observation.",
        );
      let physics: LivePhysics =
        this.livePhysics.kind === "espresso" ||
        this.livePhysics.kind === "pour-over"
          ? {
              kind: "unavailable",
              message:
                "This view shows workflow history. Historical station poses remain in the saved recordings.",
            }
          : { kind: "empty" };
      if (this.livePhysics.kind === "observing") {
        const saved = await this.readSave(worker, view);
        const cells = [];
        for (const cell of this.livePhysics.cells) {
          const frame = await this.recordings.latest(
            ovenRecordingArchive(saved.save),
            cell.scene,
            at,
          );
          cells.push({
            scene: cell.scene,
            frame: frame === null ? null : withOvenCommittedAt(frame, at),
          });
        }
        physics = { kind: "observing", cells };
      }
      if (this.mounted && request === this.observationRequest)
        this.setState(
          {
            observation: {
              kind: "ready",
              view: checked.value,
              physics,
              playback,
            },
            observationSeconds: String(at / 1e6),
          },
          this.schedulePlayback.bind(this),
        );
    } catch (error) {
      if (this.mounted && request === this.observationRequest)
        this.setState({
          observation: {
            kind: "unavailable",
            message:
              error instanceof Error
                ? error.message
                : "Historical observation failed.",
          },
        });
    }
  }

  private async save(): Promise<void> {
    if (
      this.state.observation.kind !== "live" ||
      this.session.kind !== "settled"
    )
      return;
    const { worker, view } = this.session;
    this.updateSession(
      { kind: "saving", worker, view },
      "Collecting the saved run and all referenced artifacts…",
    );
    try {
      const checked = await this.readSave(worker, view);
      if (!this.mounted) return;
      const saved = checked.save;
      downloadBakeryFile(
        `production-run-${saved.document.snapshot.slice(0, 12)}.json`,
        exportOvenSave(saved),
      );
      this.updateSession(
        { kind: "settled", worker, view },
        "Saved run downloaded. Open this file to continue in a fresh worker.",
      );
    } catch (error) {
      this.fail(error);
    }
  }

  private changeInspectionNote(
    event: React.ChangeEvent<HTMLTextAreaElement>,
  ): void {
    this.setState({ inspectionNote: event.currentTarget.value });
  }

  private async recordInspection(
    item: InspectionView,
    outcome: "accept" | "reject",
  ): Promise<void> {
    if (
      this.session.kind !== "settled" ||
      item.kind !== "pending" ||
      this.state.inspectionNote.trim() === ""
    )
      return;
    const { worker, view } = this.session;
    this.updateSession(
      { kind: "commanding", worker, view },
      "Recording the inspection…",
    );
    try {
      const reply = await worker.request({
        kind: "inspect",
        commandId: crypto.randomUUID(),
        expectedControlRevision: view.controlRevision,
        task: item.task,
        definition: item.definition,
        lots: item.lots,
        outcome,
        note: this.state.inspectionNote,
      });
      const observed = readView(reply, "commanded");
      if (
        !isRecord(reply) ||
        !isRecord(reply.receipt) ||
        reply.receipt.status !== "accepted"
      ) {
        this.updateSession(
          { kind: "settled", worker, view: observed },
          "The inspection was refused. Review the current task and try again.",
        );
        return;
      }
      this.setState({ inspectionNote: "" });
      this.updateSession(
        { kind: "running", worker, view: observed },
        "Inspection recorded. Continuing production.",
      );
      await this.drive(worker);
    } catch (error) {
      this.fail(error);
    }
  }

  private inspectionRow(item: InspectionView): React.ReactNode {
    return (
      <li
        key={item.task}
        data-inspection-task={item.task}
        data-inspection-state={item.kind}
      >
        <strong>{inspectionTitle(item.task)}</strong>
        {this.teaTiming(item.task)}
        {item.kind === "recorded" ? (
          <p>
            {item.outcome}: {item.note}
          </p>
        ) : (
          <div>
            <p>Material remains held until you record a decision.</p>
            <button
              disabled={
                this.session.kind !== "settled" ||
                this.state.inspectionNote.trim() === ""
              }
              onClick={this.recordInspection.bind(this, item, "accept")}
            >
              Accept
            </button>
            <button
              disabled={
                this.session.kind !== "settled" ||
                this.state.inspectionNote.trim() === ""
              }
              onClick={this.recordInspection.bind(this, item, "reject")}
            >
              Reject
            </button>
          </div>
        )}
      </li>
    );
  }

  private teaTiming(task: string): React.ReactNode {
    if (!task.endsWith("/inspect-strained-tea")) return null;
    if (
      this.session.kind !== "settled" &&
      this.session.kind !== "commanding" &&
      this.session.kind !== "running" &&
      this.session.kind !== "saving"
    )
      return null;
    const source = this.props.source;
    const scenario =
      source.kind === "snapshot"
        ? source.save.document.state.definition.scenario
        : source.scenario;
    if (
      scenario.id !== "ginger-black-tea" &&
      scenario.id !== "ginger-milk-tea" &&
      scenario.id !== "mixed-tea" &&
      scenario.id !== "bakery-shift"
    )
      return null;
    const timing = teaStrainTiming(
      scenario,
      this.session.view.resourceHistory,
      task,
    );
    const disposition = task.startsWith("milk-tea-batches#")
      ? "Accept permits milk addition and finishing. Reject discards the extract and preserves milk and sugar."
      : "Accept releases it for service. Reject discards it.";
    switch (timing.kind) {
      case "unavailable":
        return (
          <p>
            Strain timing is unavailable. Keep the batch held until you can
            review its extraction history.
          </p>
        );
      case "on-time":
        return (
          <p>
            Straining started at the selected extraction deadline. Record the
            batch disposition. {disposition}
          </p>
        );
      case "late":
        return (
          <p role="status">
            Straining started {timing.lateSeconds} seconds late. The batch
            remains subject to its recorded disposition. {disposition}
          </p>
        );
      default:
        return assertNever(timing);
    }
  }

  private inspections(view: HostView): React.ReactNode {
    if (view.inspections.length === 0) return null;
    return (
      <section aria-label="Recipe inspections">
        <h3>Recipe inspections</h3>
        <label>
          Inspection observation
          <textarea
            aria-label="Inspection observation"
            value={this.state.inspectionNote}
            maxLength={1000}
            onChange={this.changeInspectionNote.bind(this)}
          />
        </label>
        <ul>{view.inspections.map(this.inspectionRow.bind(this))}</ul>
      </section>
    );
  }

  render(): React.ReactNode {
    const hasPhysics = sourceCells(this.props.source).some(hasRobotFixture);
    const { session, notice } = this.state;
    const source = this.props.source;
    const view = session.view;
    const observation = this.state.observation;
    const display = observation.kind === "ready" ? observation.view : view;
    const physics =
      observation.kind === "ready"
        ? observation.physics
        : this.state.livePhysics;
    const live = observation.kind === "live";
    const scenario =
      source.kind === "snapshot"
        ? source.save.document.state.definition.scenario
        : source.scenario;
    const worker = this.currentWorker();
    const result =
      !live || view === undefined || worker === null
        ? null
        : factoryResult(scenario, worker.manifest.bundle.id, view);
    const financier =
      !live || view === undefined || worker === null
        ? null
        : financierResult(scenario, worker.manifest.bundle.id, view);
    const financierRoute = financierInput(scenario) !== null;
    const stations = factoryStationsForScenario(scenario);
    const usesFactoryFloorSplit =
      stations !== null ||
      sourceCells(this.props.source).length > 1 ||
      this.props.source.kind === "snapshot";
    const pieRoute = scenario.id !== "bakery-shift" && isPieScenario(scenario);
    const rawAppliances =
      (scenario.id === "bakery-shift" || pieRoute) && display !== undefined
        ? synchronizeMorningShiftAppliances(
            scenario,
            display.logistics,
            display.time,
            this.state.applianceFaults,
          )
        : null;
    const appliances =
      rawAppliances !== null && pieRoute && stations !== null
        ? rawAppliances.filter((a) =>
            stations.some((s) => s.id === a.stationId),
          )
        : rawAppliances;
    const cobotTransfers =
      scenario.id === "bakery-shift" && display !== undefined
        ? synchronizeCobotTransfers(
            physics.kind === "observing" ? physics.cells : [],
            display.logistics,
            scenario,
            display.time,
            this.state.applianceFaults,
          )
        : null;
    const report =
      observation.kind === "ready"
        ? observation.view.results
        : view?.production.kind === "available"
          ? view.production
          : null;
    const selected =
      display?.logistics.kind === "available"
        ? display.logistics.tasks.find(
            matchesTask.bind(null, this.state.selectedTask),
          )
        : undefined;
    const panel = this.state.panel;
    return (
      <section
        className="production-workspace persistent-production"
        aria-label="Persistent production"
        data-lifecycle={session.kind}
        data-surface={this.state.surface}
      >
        <div
          className="factory-main-canvas"
          hidden={this.state.surface === "workflow"}
        >
          {stations !== null && display !== undefined ? (
            <FactoryPhysicsView
              cells={physics.kind === "observing" ? physics.cells : []}
              stations={stations}
              appliances={appliances}
              cobotTransfers={cobotTransfers}
              logistics={display.logistics}
              time={display.time}
              selected={this.state.selectedTask}
              selectedCell={this.state.selectedCell}
              select={this.selectFactoryCell.bind(this)}
            />
          ) : physics.kind === "pour-over" ? (
            <PourOverPhysicsView
              setup={physics.setup}
              sample={physics.sample}
              samples={physics.samples}
            />
          ) : physics.kind === "espresso" ? (
            <EspressoPhysicsView
              key={physics.cell.appliance}
              sample={physics.sample}
              samples={physics.samples}
              appliance={physics.cell.appliance}
            />
          ) : physics.kind === "observing" && display !== undefined ? (
            physics.cells.length > 1 ? (
              <FactoryPhysicsView
                cells={physics.cells}
                stations={null}
                logistics={display.logistics}
                time={display.time}
                selected={this.state.selectedTask}
                selectedCell={this.state.selectedCell}
                select={this.selectFactoryCell.bind(this)}
              />
            ) : (
              <div className="production-cell-scenes">
                {physics.cells.map(this.liveCell.bind(this))}
              </div>
            )
          ) : (
            <div className="factory-empty-scene">
              <h3>
                {session.kind === "review"
                  ? "Factory ready"
                  : "Factory simulation"}
              </h3>
              <p>
                {physics.kind === "unavailable"
                  ? physics.message
                  : hasPhysics
                    ? "Start the run to display accepted robot motion."
                    : "Open Workflow to follow this recipe."}
              </p>
            </div>
          )}
        </div>
        <header className="factory-toolbar">
          <RecipeBackButton close={this.backToRecipes.bind(this)} />
          <div className="factory-title">
            <div>
              <span>Factory simulation</span>
              <h2>
                {source.kind === "definition"
                  ? source.definition.name
                  : source.name}
              </h2>
            </div>
          </div>
          <nav aria-label="Factory workspace">
            <RecipeSurfaceSwitch
              value={this.state.surface}
              allowSplit={!usesFactoryFloorSplit}
              select={this.chooseSurface.bind(this)}
            />
            <div
              className="factory-panel-pills"
              role="group"
              aria-label="Detail panels"
            >
              <button
                aria-expanded={panel === "scenario"}
                onClick={this.togglePanel.bind(this, "scenario")}
              >
                Scenario
              </button>
              <button
                aria-expanded={panel === "logistics"}
                onClick={this.togglePanel.bind(this, "logistics")}
              >
                Logistics
              </button>
              <button
                aria-expanded={panel === "results"}
                onClick={this.togglePanel.bind(this, "results")}
              >
                Results
              </button>
              <button
                aria-expanded={panel === "inspector"}
                onClick={this.togglePanel.bind(this, "inspector")}
              >
                Inspector
              </button>
              <button
                aria-expanded={panel === "save"}
                onClick={this.togglePanel.bind(this, "save")}
              >
                Save
              </button>
            </div>
          </nav>
        </header>
        {report !== null && (
          <button
            className="factory-summary"
            onClick={this.togglePanel.bind(this, "results")}
          >
            <strong>{report.ordersCompleted}</strong> orders completed ·{" "}
            {report.orders.length} admitted
          </button>
        )}
        <aside
          className="production-panel factory-drawer"
          aria-label="Factory details"
          hidden={panel === null}
        >
          <div className="factory-drawer-heading">
            <h3>{panel === null ? "Details" : panelTitle(panel)}</h3>
            <button onClick={this.closePanel.bind(this)}>Close details</button>
          </div>
          <div hidden={panel !== "save"}>
            <p>Pause the run before saving. Save before leaving this page.</p>
            <p role="status">{notice}</p>
            {this.props.connection.kind === "workspace" && (
              <section aria-label="Shared production runs">
                <h4>Save to workspace</h4>
                <WorkspaceRunsPanel
                  connection={this.props.connection}
                  kind="persistent-production"
                  source={this.sharedSaveSource()}
                  proposal={null}
                  saveStatus={this.props.saveStatus}
                  saveChanged={this.props.saveChanged}
                  open={null}
                />
              </section>
            )}

            <button
              disabled={!live || session.kind !== "settled"}
              onClick={this.save.bind(this)}
            >
              Download save file
            </button>
            <p>
              A downloaded save contains the complete run for later
              continuation.
            </p>
          </div>
          <div hidden={panel !== "scenario"}>
            <p>{sourceDescription(source)}</p>
            <p role="status">{notice}</p>
            {panel !== "inspector" &&
              this.agentSurface?.review !== null &&
              this.agentSurface?.review !== undefined && (
                <section
                  aria-label="Reviewed chat production control"
                  data-chat-proposal-kind={
                    this.agentSurface.review.control.kind
                  }
                  data-chat-proposal-digest={this.agentSurface.review.digest}
                >
                  <h3>Chat production proposal</h3>
                  <p>
                    {productionControlDescription(
                      this.agentSurface.review.control,
                    )}
                  </p>
                  <p>
                    Run {this.agentSurface.review.target.runId}, control
                    revision {this.agentSurface.review.target.controlRevision}.
                  </p>
                  <button
                    data-chat-proposal-action="confirm"
                    onClick={this.confirmAgentControl.bind(this)}
                  >
                    Confirm chat production control
                  </button>
                  <button
                    data-chat-proposal-action="discard"
                    onClick={this.discardAgentControl.bind(this)}
                  >
                    Discard chat production control
                  </button>
                </section>
              )}

            {view !== undefined && (
              <>
                {live && (
                  <ProductionControls
                    view={view}
                    enabled={
                      live &&
                      session.kind === "settled" &&
                      view.status.kind === "paused"
                    }
                    closeArrivals={this.closeArrivals.bind(this)}
                  />
                )}
                {live && (
                  <ProductionScenarioControls
                    view={view}
                    enabled={
                      live &&
                      session.kind === "settled" &&
                      (view.status.kind === "paused" ||
                        view.status.kind === "stopped-at-limit")
                    }
                    apply={this.applyScenarioControl.bind(this)}
                  />
                )}

                {live && (
                  <ProductionRecoveryControls
                    scenario={scenario}
                    view={view}
                    enabled={
                      session.kind === "settled" &&
                      view.status.kind !== "paused" &&
                      view.status.kind !== "stopped-at-limit"
                    }
                    apply={this.applyScenarioControl.bind(this)}
                  />
                )}
              </>
            )}
          </div>
          <div hidden={panel !== "results"}>
            {financierRoute && (
              <FinancierComparison
                results={this.props.financierResults}
                current={financier}
                keep={this.props.keepFinancierResult}
                replace={this.props.replaceFinancierResults}
                clear={this.props.clearFinancierResults}
              />
            )}
            {scenario.id === "plan-70-recurring-cold-cell" && (
              <FactoryComparison
                results={this.props.comparisons}
                current={result}
                capture={this.props.captureComparison}
                clear={this.props.clearComparisons}
              />
            )}

            {view !== undefined && display !== undefined && (
              <>
                <ProductionResults
                  time={display.time}
                  shift={reportBakeryShift(
                    scenario,
                    display.logistics,
                    display.resourceHistory,
                    report,
                    display.time,
                    live && view.status.kind === "completed"
                      ? "complete"
                      : "partial",
                  )}
                  results={
                    observation.kind === "ready"
                      ? observation.view.results
                      : view.production.kind === "available"
                        ? view.production
                        : null
                  }
                />
              </>
            )}
          </div>
          {display !== undefined && (
            <div hidden={panel !== "logistics"}>
              {financierRoute &&
                display.logistics.kind === "available" &&
                report !== null && (
                  <BatchList
                    view={display.logistics}
                    orders={report.orders}
                    select={this.selectTask.bind(this)}
                  />
                )}
              <FactoryOverview
                scenario={scenario}
                view={display}
                selected={this.state.selectedTask}
                select={this.selectTask.bind(this)}
              />
              {live && view !== undefined && (
                <ProductionOverview
                  view={view}
                  select={this.selectTask.bind(this)}
                  reviewRecovery={this.reviewRecovery.bind(this)}
                />
              )}
              {live &&
                view !== undefined &&
                panel === "logistics" &&
                this.inspections(view)}
              <OvenLogistics
                view={display.logistics}
                selected={this.state.selectedTask}
                select={this.selectTask.bind(this)}
              />
            </div>
          )}
          {view !== undefined && display !== undefined && (
            <>
              <div hidden={panel !== "history"}>
                <section aria-label="Factory observation cursor">
                  <h3>Inspect accepted history</h3>
                  <label>
                    Observation seconds
                    <input
                      aria-label="Observation seconds"
                      type="number"
                      min="0"
                      max={view.time / 1e6}
                      step="0.002"
                      value={this.state.observationSeconds}
                      onChange={this.setObservationSeconds.bind(this)}
                    />
                  </label>
                  <button
                    disabled={
                      session.kind !== "settled" ||
                      observation.kind === "loading"
                    }
                    onClick={this.observeHistory.bind(this)}
                  >
                    Inspect factory history
                  </button>
                  <button
                    disabled={live}
                    onClick={this.returnToLive.bind(this)}
                  >
                    Return to live state
                  </button>
                  {observation.kind === "loading" && (
                    <p role="status">
                      Reading the retained history and accepted cell samples…
                    </p>
                  )}
                  {observation.kind === "unavailable" && (
                    <p role="status">{observation.message}</p>
                  )}
                  {observation.kind === "ready" && (
                    <div>
                      <p>
                        Historical observation:{" "}
                        <output aria-label="Observation time">
                          {seconds(observation.view.time)}
                        </output>{" "}
                        seconds. Execution remains at {seconds(view.time)}{" "}
                        seconds. Return to live state to use execution controls.
                      </p>
                      <p>
                        History playback uses exact recorded samples. Missing
                        intervals hold the last accepted sample.
                      </p>
                      <button onClick={this.playHistory.bind(this, 1)}>
                        Play history at 1×
                      </button>
                      <button onClick={this.playHistory.bind(this, 10)}>
                        Play history at 10×
                      </button>
                      <button onClick={this.playHistory.bind(this, 60)}>
                        Play history at 60×
                      </button>
                      <button
                        disabled={observation.playback.kind === "paused"}
                        onClick={this.pauseHistory.bind(this)}
                      >
                        Pause history
                      </button>
                    </div>
                  )}
                </section>

                {physicsEvidenceVisible() && (
                  <>
                    <OvenResourceHistory
                      view={display.resourceHistory}
                      selected={this.state.selectedTask}
                      select={this.selectTask.bind(this)}
                    />
                    <OvenSchedulingHistory
                      view={display.schedulingHistory}
                      selected={this.state.selectedTask}
                      select={this.selectTask.bind(this)}
                    />
                    <OvenStorageHistory
                      view={display.storageHistory}
                      selected={this.state.selectedTask}
                      select={this.selectTask.bind(this)}
                    />
                    <MaterialStorageHistory
                      view={display.materialStorageHistory}
                      selected={this.state.selectedTask}
                      select={this.selectTask.bind(this)}
                    />
                  </>
                )}
              </div>
              <div hidden={panel !== "inspector"}>
                {panel === "inspector" &&
                  this.agentSurface?.review !== null &&
                  this.agentSurface?.review !== undefined && (
                    <section
                      aria-label="Reviewed chat production control"
                      data-chat-proposal-kind={
                        this.agentSurface.review.control.kind
                      }
                      data-chat-proposal-digest={
                        this.agentSurface.review.digest
                      }
                    >
                      <h3>Chat production proposal</h3>
                      <p>
                        {productionControlDescription(
                          this.agentSurface.review.control,
                        )}
                      </p>
                      <p>
                        Run {this.agentSurface.review.target.runId}, control
                        revision{" "}
                        {this.agentSurface.review.target.controlRevision}.
                      </p>
                      <button
                        data-chat-proposal-action="confirm"
                        onClick={this.confirmAgentControl.bind(this)}
                      >
                        Confirm chat production control
                      </button>
                      <button
                        data-chat-proposal-action="discard"
                        onClick={this.discardAgentControl.bind(this)}
                      >
                        Discard chat production control
                      </button>
                    </section>
                  )}
                {this.state.selectedCell !== null &&
                  financierStation(this.state.selectedCell, scenario) ===
                    null && <h4>{this.state.selectedCell}</h4>}
                {this.state.selectedCell !== null &&
                  display.logistics.kind === "available" && (
                    <StationDetails
                      id={this.state.selectedCell}
                      scenario={scenario}
                      view={display.logistics}
                      appliances={appliances}
                      cobotTransfers={cobotTransfers}
                      select={this.selectTask.bind(this)}
                      injectFault={this.injectApplianceFault.bind(this)}
                      restoreCheckpoint={this.restoreApplianceCheckpoint.bind(
                        this,
                      )}
                      proposeChatRecovery={this.proposeChatApplianceRecovery.bind(
                        this,
                      )}
                    />
                  )}
                {selected === undefined ? (
                  <p>Select a cell or workflow task to inspect its work.</p>
                ) : (
                  <SelectedOvenTask task={selected} />
                )}
                {selected?.kind === "waiting" &&
                  display.logistics.kind === "available" && (
                    <WaitExplanationView
                      scenario={scenario}
                      view={display.logistics}
                      task={selected.id}
                      select={this.selectTask.bind(this)}
                    />
                  )}
                {live && panel === "inspector" && this.inspections(view)}
                {hasPhysics && physicsEvidenceVisible() && (
                  <details className="factory-physics-details">
                    <summary>Physics details</summary>
                    <button
                      disabled={
                        !live ||
                        session.kind !== "settled" ||
                        this.state.selectedTask === null
                      }
                      onClick={this.inspectPhysics.bind(this)}
                    >
                      Inspect selected physics
                    </button>
                    <label>
                      Cell to inspect
                      <Select.Root
                        items={sourceCells(source).map(cellChoice)}
                        value={this.state.inspectionCell}
                        onValueChange={this.chooseInspectionCell.bind(this)}
                      >
                        <Select.Trigger aria-label="Cell to inspect">
                          <Select.Value />
                        </Select.Trigger>
                        <Select.Popup>
                          {sourceCells(source).map(cellOption)}
                        </Select.Popup>
                      </Select.Root>
                    </label>
                    <label>
                      Cell recording at or before simulation seconds
                      <input
                        aria-label="Cell recording seconds"
                        type="number"
                        min={0}
                        max={view.time / 1_000_000}
                        step="0.002"
                        placeholder={seconds(view.time)}
                        value={this.state.inspectionSeconds}
                        onChange={this.setInspectionSeconds.bind(this)}
                      />
                    </label>
                    <button
                      disabled={!live || session.kind !== "settled"}
                      onClick={this.inspectCellPhysics.bind(this)}
                    >
                      Inspect cell recording
                    </button>
                    {this.state.inspection.kind === "loading" && (
                      <p role="status">Reading accepted samples…</p>
                    )}
                    {this.state.inspection.kind === "unavailable" && (
                      <p role="status">{this.state.inspection.message}</p>
                    )}
                    {this.state.inspection.kind === "ready" && (
                      <button onClick={this.closePhysicsInspection.bind(this)}>
                        Close physics inspection
                      </button>
                    )}
                    {this.state.inspection.kind === "ready" && (
                      <OvenPhysicsView
                        kind="inspection"
                        key={`${this.state.inspection.playback.purpose}/${this.state.inspection.playback.at}`}
                        playback={this.state.inspection.playback}
                        select={this.selectTask.bind(this)}
                      />
                    )}
                  </details>
                )}
              </div>
            </>
          )}
        </aside>
        <div
          className="factory-workflow-canvas"
          hidden={this.state.surface === "factory"}
        >
          {this.props.source.kind !== "snapshot" && (
            <RecipeWorkflowGraph
              source={this.recipeSource(this.props.source)}
              stages={NO_STAGES}
              seek={ignoreSeek}
            />
          )}
          {display !== undefined ? (
            <OvenTaskViews
              mode="workflow"
              view={display.logistics}
              time={display.time}
              horizon={display.horizon}
              selected={this.state.selectedTask}
              select={this.selectTask.bind(this)}
            />
          ) : (
            <p>Start the run to display its workflow.</p>
          )}
        </div>
        <RecipeSplitDivider surface={this.state.surface} />
        <footer
          className="factory-bottom"
          data-timeline-open={this.state.timeline && display !== undefined}
        >
          {(session.kind === "failed" ||
            view?.status.kind === "blocked" ||
            view?.status.kind === "awaiting-inspection" ||
            this.agentSurface?.review != null) && (
            <button
              className="factory-attention"
              onClick={this.togglePanel.bind(
                this,
                view?.status.kind === "awaiting-inspection"
                  ? "inspector"
                  : "scenario",
              )}
            >
              {notice} · Review
            </button>
          )}
          <div
            className="factory-timeline-shell"
            data-open={this.state.timeline && display !== undefined}
          >
            <div className="factory-timeline-inner">
              {this.state.timeline && display !== undefined && (
                <section
                  className="factory-timeline-panel"
                  aria-label="Factory timeline"
                >
                  <OvenTaskViews
                    mode="timeline"
                    view={display.logistics}
                    time={display.time}
                    horizon={display.horizon}
                    selected={this.state.selectedTask}
                    select={this.selectTask.bind(this)}
                  />
                </section>
              )}
            </div>
          </div>
          <div className="factory-playback">
            <div className="factory-clock">
              <output aria-label="Simulation seconds">
                {seconds(display?.time ?? 0)}
              </output>
              <span>
                Simulation seconds ·{" "}
                <output aria-label="Execution status">
                  {view?.status.kind ?? session.kind}
                </output>
              </span>
            </div>
            {this.primaryControl()}
            {!live && (
              <button
                className="factory-history-state"
                onClick={this.returnToLive.bind(this)}
              >
                Viewing history · Return to live state
              </button>
            )}
            <div className="factory-playback-actions">
              <button
                className="production-timeline-toggle"
                aria-expanded={this.state.timeline}
                onClick={this.toggleTimeline.bind(this)}
                disabled={display === undefined}
              >
                <TimelineLabel open={this.state.timeline} />
              </button>
              <button
                aria-expanded={panel === "history"}
                onClick={this.togglePanel.bind(this, "history")}
                disabled={view === undefined}
              >
                <History size={14} aria-hidden="true" />
                History
              </button>
            </div>
          </div>
          <span className="factory-save-status">
            {this.props.saveStatus.kind === "verified"
              ? "Last shared save verified"
              : "Save before leaving this page"}
          </span>
        </footer>
      </section>
    );
  }
}

function sourceCells(source: OvenRunSource): readonly PersistentCell[] {
  switch (source.kind) {
    case "recipe":
      return [];
    case "definition":
      return [source.definition.cell];
    case "native-recipe":
      return [source.cell];
    case "logistics":
    case "snapshot":
      return source.cells;
    default:
      return assertNever(source);
  }
}
function cellChoice(
  cell: PersistentCell,
): Readonly<{ value: string; label: string }> {
  return { value: cell.cellId, label: cell.cellId };
}
function cellOption(cell: PersistentCell): React.ReactNode {
  return (
    <Select.Item key={cell.cellId} value={cell.cellId}>
      {cell.cellId}
    </Select.Item>
  );
}
function sourceDescription(source: OvenRunSource): string {
  const cells = sourceCells(source);
  if (cells.length > 1)
    return "Two independent cells share one baker and four returning trays. Each buffer transfer, unloading step, and tray return uses the same scheduler.";
  const cell = cells[0];
  if (cell === undefined)
    return "Assumed process timings and masses. Record simulated inspection decisions when requested. These decisions do not certify food quality.";
  switch (cell.fixture) {
    case "persistent-espresso/1":
      return "Preheated espresso station. Orders reserve one machine, one cup and one dedicated barista. Bakery tasks use their declared process assumptions and quality checks. Yield and guided handling remain uncalibrated.";
    case "persistent-pour-over/1":
      return `Prepared pour-over station with ${cell.station.kettleWaterG} g of 93 °C kettle water and a 27 g bed. The brew reserves the FR10, the station and the kettle. The controller measures the beverage, the spent bed, the kettle water and any losses.`;
    case "persistent-pan-staging/1":
      return "The FR10 stages an empty pan in a fixed carrier insert. A worker removes it before extraction. Heating, straining, and cleanup use assumed timings.";
    case "persistent-oven-rack/1":
      return "One shared oven cell performs loading, retrieval, and racking. Workers stage trays and clear the rack for cooling.";
    case "persistent-rack/1":
      return "The cell transfers trays from its table to its rack.";
    default:
      return assertNever(cell);
  }
}
function inspectionTitle(task: string): string {
  const separator = task.lastIndexOf("/");
  if (separator < 0) return task;
  const instance = task.slice(0, separator);
  const step = task.slice(separator + 1);
  if (step === "inspect-strained-tea") {
    const milk = instance.startsWith("milk-tea-batches#");
    const sequence = Number(instance.slice(instance.lastIndexOf("#") + 1));
    return `${milk ? "Milk tea" : "Tea"} batch ${sequence + 1} · Extraction review`;
  }
  const title = instance
    .replace("#0", "")
    .replace("load-", "Load ")
    .toUpperCase();
  switch (step) {
    case "inspect-bake":
      return `${title} · Bake inspection`;
    case "release-for-packing":
      return `${title} · Packing release`;
    default:
      return `${title} · ${step.replaceAll("-", " ")}`;
  }
}

function matchesTask(selected: string | null, task: { id: string }): boolean {
  return task.id === selected;
}
function panelTitle(panel: Panel): string {
  switch (panel) {
    case "scenario":
      return "Scenario and run controls";
    case "logistics":
      return "Queues and transfers";
    case "results":
      return "Production results";
    case "inspector":
      return "Selected work";
    case "save":
      return "Save production run";
    case "history":
      return "Recorded history";
    default:
      return assertNever(panel);
  }
}

/** Tray-cell fixtures use the robot inspection views; stations have their own. */
function hasRobotFixture(cell: PersistentCell): boolean {
  return (
    cell.fixture !== "persistent-espresso/1" &&
    cell.fixture !== "persistent-pour-over/1"
  );
}
