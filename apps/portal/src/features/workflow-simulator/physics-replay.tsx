import { ROBOTS } from "@purin-labs/bakery-model/bakery-robots";
import type { ScheduleSpatialLayout } from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { BakeryAppearanceControl } from "@purin-labs/ui/preferences/appearance-controls";
import { SegmentedControl } from "./docks/shared";
import { RobotComparison } from "./robot-comparison";
import type { EngineJobs } from "../production-run/engine-jobs";
import type {
  BakeryWorkspaceViewAction,
  BakeryRecordingCameraView,
} from "@purin-labs/bakery-model/bakery-surface";
import type { WorkspaceCameraView } from "./simulator-state";
import type { PhysicsFrame } from "./spatial/physics-inspection";
import { PhysicsSceneHost } from "./spatial/physics-scene-host";
import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { GlideHighlight } from "@purin-labs/ui/glide-highlight";
import { PlaybackToggle } from "./playback-toggle";
import type { Settings } from "@purin-labs/bakery-model/bakery";
import type { CompiledProcedure } from "@purin-labs/bakery-model/bakery-procedure";
import { MAX_RUN_FILE_BYTES } from "@purin-labs/bakery-model/bakery-run-snapshot";
import {
  ArrowLeft,
  ArrowRight,
  Box,
  RotateCcw,
  StepForward,
  ChevronDown,
  Check,
} from "lucide-react";
import type {
  PhysicsOutcome,
  PhysicsReplay as PhysicsReplayData,
  PhysicsRequest,
} from "@purin-labs/bakery-model/bakery-physics";
import {
  recordingDuration as duration,
  recordingReplayStart,
  recordingReplayEnd,
  recordingSampleTime,
  recordingSpeeds,
  prepareRecordingNavigation,
  type RecordingDocument,
  type ReplayState,
  type RecordingSource,
  type RecordingReplayView,
} from "@purin-labs/production-simulation/simulator/playback-state";
import type {
  BrowserRunActions,
  RecordingReplayActions,
} from "./simulator-actions";
import { samplePhysics } from "./spatial/physics-model";
import {
  physicsDuration,
  physicsEvents,
  physicsLegAt,
  physicsOutcome,
  physicsTasks,
  type RecordedTransfer,
  type PhysicsReplayEvent,
} from "@purin-labs/production-simulation/recipes/bakery/physics-playback";
import type { RecordedFitEvent } from "./spatial/floor-plan-geometry";
import type { WorkcellSelection } from "@purin-labs/production-simulation/simulator/selection";
import type {
  BakeryWorkspaceAction,
  BakeryWorkspaceState,
  SimulatorState,
  SimulatorConnection,
} from "./simulator-state";
import { SAVED_RUN_MESSAGE, parseRehearsalFile } from "@purin-labs/production-simulation/simulator/rehearsal-file";
import { readExample } from "./rehearsal-examples";
import "./physics-replay.css";
import {
  ProductionWorkspace,
  type CatalogSection,
} from "./production-workspace";
import type { ProductionSession } from "./production-session";
import type { PreparedRehearsalEdit } from "./rehearsal-edits";
import type { Variant } from "@purin-labs/type-utils";
import { physicsEvidenceVisible } from "@purin-labs/production-simulation/runs/physics-evidence";

type Progress =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "reading" }>
  | Readonly<{ kind: "rejected"; message: string }>;
type State = Readonly<{
  importing: Progress;
  rehearsing: Progress;
  scene: "empty" | "loading" | "ready" | "unavailable";
  notice: string;
  setupOpen: boolean;
  setupTab: "examples" | "files";
}>;
type Props = Readonly<{
  robotRunner: EngineJobs;
  workspace: BakeryWorkspaceState;
  cameraView: WorkspaceCameraView;
  controlView(action: BakeryWorkspaceViewAction): void;
  prepareRunOpen(id: string): Promise<void>;
  workspaceAction(action: BakeryWorkspaceAction): void;
  productionSettings: Settings;
  productionProcedure: CompiledProcedure | null;
  productionLayout: ScheduleSpatialLayout | null;
  connection: SimulatorConnection;
  view: RecordingReplayView;
  actions: RecordingReplayActions;
  browserNotice: string;
  browserJob: SimulatorState["browserJob"];
  browser: BrowserRunActions;
  initialCatalogSection?: CatalogSection | null;
  openFinancierMorning?: () => void;
  returnToCatalog?: () => void;
}>;
type Example = PhysicsRequest["bakeryTaskId"] | "oven-cycle" | "rack-cycle";

// The recording viewer: open an example or file, watch the recorded motion and
// rehearse it on the production scheduler. Production and rehearsal runs open
// in the production workspace.
export class PhysicsReplay extends React.Component<Props, State> {
  get doorInspectionAvailable(): boolean {
    return (
      this.props.workspace.kind === "rehearsal" &&
      this.props.view.open &&
      this.sceneHost.doorAvailable
    );
  }
  cameraAvailable(camera: BakeryRecordingCameraView["camera"]): boolean {
    return this.props.workspace.kind === "production"
      ? this.props.workspace.production.scene === "ready"
      : this.props.view.open && this.sceneHost.cameraAvailable(camera);
  }
  state: State = {
    importing: { kind: "idle" },
    rehearsing: { kind: "idle" },
    scene: "empty",
    notice: "",
    setupOpen: true,
    setupTab: "examples",
  };
  private readonly host = React.createRef<HTMLDivElement>();
  private readonly file = React.createRef<HTMLInputElement>();
  private readonly heading = React.createRef<HTMLHeadingElement>();
  private readonly setupToggle = React.createRef<HTMLButtonElement>();
  private readonly sceneHost = new PhysicsSceneHost({
    fallback: "floor-plan",
    camera: "reset",
    select: this.selectRecordingResource.bind(this),
    changed: this.sceneChanged.bind(this),
    inspectEvent: this.inspectRecordedFinding.bind(this),
    pause: this.pauseScene.bind(this),
    controlCamera: this.controlCamera.bind(this),
    controlDoorPreview: this.controlDoorPreview.bind(this),
  });
  private get scene() {
    return this.sceneHost.webgl;
  }
  private get floorPlan() {
    return this.sceneHost.fallback;
  }
  private importGeneration = 0;
  private mounted = false;

  componentDidMount(): void {
    this.mounted = true;
    if (this.props.view.open) {
      this.heading.current?.focus();
      void this.mountScene();
    }
  }

  componentDidUpdate(previous: Props): void {
    if (this.props.workspace.kind === "production") {
      this.disposeScene();
      return;
    }
    if (previous.workspace.kind === "production") void this.mountScene();
    const document = this.props.view.document;
    if (this.props.view.open && !previous.view.open) {
      this.heading.current?.focus();
      void this.mountScene();
    } else if (!this.props.view.open && previous.view.open) {
      this.importGeneration++;
      this.disposeScene();
      this.setState({
        importing: { kind: "idle" },
        rehearsing: { kind: "idle" },
      });
    } else if (
      this.props.view.open &&
      document.kind === "ready" &&
      (previous.view.document.kind !== "ready" ||
        previous.view.document.recording !== document.recording)
    ) {
      void this.mountScene();
    }
    if (document.kind === "empty" && previous.view.document.kind !== "empty") {
      this.disposeScene();
      this.setState({ scene: "empty" });
    }
    this.updateScene();
    if (
      previous.cameraView.camera !== this.props.cameraView.camera ||
      previous.cameraView.cameraResetRevision !==
        this.props.cameraView.cameraResetRevision
    )
      this.applyCamera();
  }

  componentWillUnmount(): void {
    this.mounted = false;
    this.importGeneration++;
    this.disposeScene();
    this.sceneHost.dispose();
  }

  private disposeScene(): void {
    this.sceneHost.clear();
  }

  private pauseScene(): void {
    this.props.actions.pause();
  }

  private sceneChanged(scene: State["scene"]): void {
    if (!this.mounted) return;
    const document = this.props.view.document;
    if (
      scene !== "ready" &&
      document.kind === "ready" &&
      document.doorPreviewDegrees !== null
    )
      this.controlDoorPreview(null);
    this.updateScene();
    this.setState({ scene });
    if (scene === "ready") this.applyCamera();
  }

  private async mountScene(): Promise<void> {
    const document = this.props.view.document;
    if (
      !this.props.view.open ||
      document.kind !== "ready" ||
      this.host.current === null
    )
      return;
    await this.sceneHost.load(this.host.current, document.recording);
  }

  private updateScene(): void {
    const document = this.props.view.document;
    const frame: PhysicsFrame = {
      seconds: document.kind === "ready" ? recordingSampleTime(document) : 0,
      workcell: { kind: "empty" },
      layout: null,
      trays: null,
    };
    this.scene?.update(frame);
    this.floorPlan?.update(frame);
    this.sceneHost.setSelection(
      document.kind === "ready" ? document.selection : null,
    );
    this.sceneHost.setDoorPreview(
      document.kind === "ready" ? document.doorPreviewDegrees : null,
    );
  }

  private controlDoorPreview(degrees: number | null): void {
    this.props.controlView({ kind: "setDoorPreview", degrees });
  }

  private selectRecordingResource(selection: WorkcellSelection): void {
    const document = this.props.view.document;
    if (document.kind === "ready")
      this.navigateRecording(selection, document.replay.time);
  }

  private navigateRecording(selection: WorkcellSelection, time: number): void {
    const document = this.props.view.document;
    if (document.kind !== "ready") return;
    const navigation = prepareRecordingNavigation(document, {
      selection,
      cursorSeconds: time,
      playback: "paused",
    });
    if (navigation !== null) this.props.actions.navigate(navigation);
  }

  private async importFile(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    const text =
      file.size > MAX_RUN_FILE_BYTES
        ? Promise.reject(
            new Error("Choose a file smaller than 16 MiB plus 64 KiB."),
          )
        : file.text();
    await this.readFile(text);
  }

  private async loadExample(task: Example): Promise<void> {
    await this.readFile(readExample(task));
  }

  private async readFile(text: Promise<string>): Promise<void> {
    this.props.actions.pause();
    const generation = ++this.importGeneration;
    this.setState({
      importing: { kind: "reading" },
      rehearsing: { kind: "idle" },
      notice: "Opening file…",
    });
    try {
      const result = parseRehearsalFile(await text);
      if (
        !this.mounted ||
        !this.props.view.open ||
        generation !== this.importGeneration
      )
        return;
      if (result.kind === "rejected") throw new Error(result.message);
      if (result.kind === "saved-run") throw new Error(SAVED_RUN_MESSAGE);
      this.props.actions.loaded(result.recording);
      this.setState({
        importing: { kind: "idle" },
        notice:
          result.kind === "loading-handoff"
            ? "Loading recording opened from the native handoff. Keep the original handoff file to resume MuJoCo: Multi-tray rehearsal → Files accepts it for a tray's loading step."
            : "Recording opened. Watch its motion here, or rehearse it on the production scheduler.",
      });
    } catch (error) {
      if (
        !this.mounted ||
        !this.props.view.open ||
        generation !== this.importGeneration
      )
        return;
      const message =
        error instanceof Error ? error.message : "Unable to read this file.";
      this.setState(
        {
          importing: { kind: "rejected", message },
          notice: "",
        },
        this.focusFile.bind(this),
      );
    }
  }

  // The recording becomes tray A of a rehearsal with its result accepted.
  private async rehearse(): Promise<void> {
    const document = this.props.view.document;
    if (document.kind !== "ready") return;
    this.props.actions.pause();
    const generation = ++this.importGeneration;
    this.setState({ rehearsing: { kind: "reading" } });
    const message = await this.props.actions.rehearse(document.recording);
    if (!this.mounted || generation !== this.importGeneration) return;
    this.setState({
      rehearsing:
        message === null ? { kind: "idle" } : { kind: "rejected", message },
    });
  }

  private focusFile(): void {
    let disclosure = this.file.current?.closest("details");
    while (disclosure) {
      disclosure.open = true;
      disclosure = disclosure.parentElement?.closest("details");
    }
    this.file.current?.focus();
  }

  private scrub(event: React.ChangeEvent<HTMLInputElement>): void {
    this.props.actions.seek(Number(event.currentTarget.value));
  }
  private event(event: PhysicsReplayEvent): void {
    const document = this.props.view.document;
    if (document.kind === "ready")
      this.props.actions.seek(recordingReplayStart(document) + event.time);
  }

  private inspectRecordedFinding(event: RecordedFitEvent): void {
    const document = this.props.view.document;
    if (
      !this.mounted ||
      !this.props.view.open ||
      document.kind !== "ready" ||
      document.recording !== event.recording
    )
      return;
    this.props.actions.pause();
    this.props.actions.seek(recordingReplayStart(document) + event.time);
  }
  private nextEvent(): void {
    this.props.actions.nextEvent();
  }
  private focusCell(): void {
    this.controlCamera("cell");
  }

  private applyCamera(): void {
    this.sceneHost.setCamera(this.props.cameraView.camera);
  }
  private controlCamera(camera: BakeryRecordingCameraView["camera"]): void {
    this.props.controlView(
      camera === "perspective"
        ? { kind: "resetCamera" }
        : { kind: "setCamera", camera },
    );
  }
  private resetCamera(): void {
    this.props.controlView({ kind: "resetCamera" });
  }
  private toggleCamera(): void {
    this.props.controlView({
      kind: "setCamera",
      camera:
        this.props.cameraView.camera === "overhead" ||
        this.props.cameraView.camera === "inspectionOverhead"
          ? "perspective"
          : "overhead",
    });
  }
  private exportFile(): void {
    const document = this.props.view.document;
    if (document.kind !== "ready") return;
    const blob = new Blob([JSON.stringify(document.recording, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download =
      document.recording.kind !== "bakery-physics-recording"
        ? "robot-oven-cycle.json"
        : `${document.recording.request.robot}-${document.recording.request.case}.json`;
    link.click();
    setTimeout(revokeDownload.bind(null, url), 1000);
  }

  private toggleSetup(): void {
    this.setState({ setupOpen: !this.state.setupOpen });
  }

  private selectSetupTab(tab: "examples" | "files"): void {
    this.setState({ setupTab: tab });
  }

  private closeSetup(): void {
    this.setState({ setupOpen: false }, this.focusSetupToggle.bind(this));
  }

  private focusSetupToggle(): void {
    this.setupToggle.current?.focus();
  }

  private keyDown(event: React.KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (this.state.setupOpen) {
      this.closeSetup();
      return;
    }
    this.props.actions.close();
  }

  private openProduction(): void {
    this.disposeScene();
    this.props.workspaceAction({
      kind: "openProduction",
      procedure: "financier",
    });
  }

  private openFinancierRobot(): void {
    this.disposeScene();
    this.props.workspaceAction({
      kind: "openProduction",
      procedure: "financier",
      financierPreset: "one-batch",
    });
  }

  private openRehearsal(): void {
    this.disposeScene();
    this.props.workspaceAction({
      kind: "openProduction",
      procedure: "rehearsal",
    });
  }

  private closeProduction(): void {
    this.props.workspaceAction({ kind: "closeProduction" });
  }

  private productionChanged(patch: Partial<ProductionSession>): void {
    this.props.workspaceAction({ kind: "productionSessionChanged", patch });
  }
  private rehearsalEdited(edit: PreparedRehearsalEdit): void {
    this.props.workspaceAction({ kind: "rehearsalEdited", edit });
  }

  render(): React.ReactNode {
    if (this.props.workspace.kind === "production")
      return this.props.view.open ? (
        <ProductionWorkspace
          cameraView={this.props.cameraView}
          controlView={this.props.controlView}
          prepareRunOpen={this.props.prepareRunOpen}
          settings={this.props.productionSettings}
          layout={this.props.productionLayout}
          procedure={this.props.productionProcedure}
          connection={this.props.connection}
          saveStatus={
            this.props.workspace.runSaves[
              this.props.workspace.production.procedure === "rehearsal"
                ? "rehearsal"
                : "production"
            ]
          }
          saveChanged={this.props.workspaceAction}
          persistentSaveStatus={
            this.props.workspace.runSaves["persistent-production"]
          }
          runSaveProposal={
            this.props.workspace.runSaveProposal.kind === "prepared"
              ? this.props.workspace.runSaveProposal
              : null
          }
          session={this.props.workspace.production}
          playback={this.props.actions}
          changed={this.productionChanged.bind(this)}
          rehearsalEdited={this.rehearsalEdited.bind(this)}
          authored={this.props.workspaceAction}
          browserJob={this.props.browserJob}
          browserNotice={this.props.browserNotice}
          runInBrowser={this.props.browser.runProductionInBrowser}
          stopSimulation={this.props.browser.stopSimulation}
          persistentOvenVisible={this.props.browser.persistentOvenVisible}
          close={this.closeProduction.bind(this)}
          initialCatalogSection={this.props.initialCatalogSection}
          openFinancierMorning={this.props.openFinancierMorning}
          returnToCatalog={this.props.returnToCatalog}
        />
      ) : null;
    const document = this.props.view.document;
    const busy =
      this.state.importing.kind === "reading" ||
      this.state.rehearsing.kind === "reading";
    const error =
      this.state.importing.kind === "rejected"
        ? this.state.importing.message
        : "";
    return (
      <section
        className="physics-replay"
        hidden={!this.props.view.open}
        aria-labelledby="physics-heading"
        onKeyDown={this.keyDown.bind(this)}
      >
        <header className="physics-header">
          <div>
            <h2 id="physics-heading" tabIndex={-1} ref={this.heading}>
              Robot rehearsal
            </h2>
            <p>
              Try a robot moving a tray. No real equipment is controlled.
              {this.state.scene === "unavailable" &&
                " 3D unavailable. Floor plan, playback and details remain usable."}
            </p>
          </div>
          <nav aria-label="Recording panels">
            <button
              ref={this.setupToggle}
              aria-expanded={this.state.setupOpen}
              aria-controls="physics-setup"
              onClick={this.toggleSetup.bind(this)}
            >
              Setup &amp; files
            </button>
            <div className="physics-camera-group" role="group" aria-label="3D camera">
              <BakeryAppearanceControl />
              <button
                aria-label="Show entire bakery"
                title="Show entire bakery"
                disabled={this.state.scene !== "ready"}
                onClick={this.resetCamera.bind(this)}
              >
                <RotateCcw size={16} aria-hidden="true" />
              </button>
              <button
                disabled={this.state.scene !== "ready"}
                aria-pressed={
                  this.props.cameraView.camera === "overhead" ||
                  this.props.cameraView.camera === "inspectionOverhead"
                }
                onClick={this.toggleCamera.bind(this)}
              >
                Top view
              </button>
              <button
                disabled={this.state.scene !== "ready"}
                onClick={this.focusCell.bind(this)}
              >
                Focus robot cell
              </button>
            </div>
            <button onClick={this.props.actions.close}>
              <ArrowLeft size={16} aria-hidden="true" /> Back to production
            </button>
          </nav>
        </header>
        <aside
          id="physics-setup"
          className="physics-setup"
          hidden={!this.state.setupOpen}
          aria-label="Recording setup"
        >
          <div className="physics-setup-tabs">
            <SegmentedControl
              ariaLabel="Setup mode"
              value={this.state.setupTab}
              options={[
                {
                  value: "examples",
                  label: "Examples",
                  onSelect: this.selectSetupTab.bind(this, "examples"),
                },
                {
                  value: "files",
                  label: "Compare & files",
                  onSelect: this.selectSetupTab.bind(this, "files"),
                },
              ]}
            />
          </div>
          <section
            className="physics-transfer"
            aria-labelledby="physics-transfer-heading"
            hidden={this.state.setupTab !== "examples"}
          >
            <h3 id="physics-transfer-heading">Choose an example</h3>
            {document.kind === "empty" && (
              <p>
                Watch a recorded robot move, then rehearse it with bakers and
                trays.
              </p>
            )}
            <div className="physics-examples">
              <button
                className="physics-example"
                onClick={this.openProduction.bind(this)}
                disabled={busy}
              >
                <Box size={20} aria-hidden="true" />
                <span>
                  <strong>Multi-batch + robot</strong>
                  <small>
                    Applied batches, shared oven and workers · Native evidence
                    per tray
                  </small>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
              <button
                className="physics-example replay-primary"
                onClick={this.openRehearsal.bind(this)}
                disabled={busy}
              >
                <Box size={20} aria-hidden="true" />
                <span>
                  <strong>Multi-tray rehearsal</strong>
                  <small>
                    Tray chains on the production scheduler · Browser MuJoCo ·
                    Shared robot cell
                  </small>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
              <button
                className="physics-example"
                disabled={busy}
                onClick={this.openFinancierRobot.bind(this)}
              >
                <Box size={20} aria-hidden="true" />
                <span>
                  <strong>Financier + robot</strong>
                  <small>
                    One batch, one tray · Production scheduler · Browser MuJoCo
                  </small>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
              <button
                className={
                  document.kind === "empty"
                    ? "replay-primary physics-example"
                    : "physics-example"
                }
                disabled={busy}
                onClick={this.loadExample.bind(this, "table-to-rack")}
              >
                <Box size={20} aria-hidden="true" />
                <span>
                  <strong>Table to rack</strong>
                  <small>Move a tray to storage · 29 sec</small>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
              <button
                className="physics-example"
                disabled={busy}
                onClick={this.loadExample.bind(this, "table-to-oven")}
              >
                <Box size={20} aria-hidden="true" />
                <span>
                  <strong>Table to oven</strong>
                  <small>FANUC · Place a tray on shelf 3 · 36 sec</small>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
              <button
                className="physics-example"
                disabled={busy}
                onClick={this.loadExample.bind(this, "oven-cycle")}
              >
                <Box size={20} aria-hidden="true" />
                <span>
                  <strong>Cold oven cycle</strong>
                  <small>
                    FANUC · Load the oven and bring the tray back · 73 sec
                  </small>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
              <button
                className="physics-example"
                disabled={busy}
                onClick={this.loadExample.bind(this, "rack-cycle")}
              >
                <Box size={20} aria-hidden="true" />
                <span>
                  <strong>Oven → table → rack</strong>
                  <small>
                    FANUC · Three continuous native operations · 101 sec
                  </small>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>
          </section>
          {document.kind === "ready" && (
            <p className="physics-loaded">{replayLabel(document.recording)}</p>
          )}
          {document.kind === "ready" && (
            <section
              className="physics-rehearse"
              aria-labelledby="physics-rehearse-heading"
            >
              <h3 id="physics-rehearse-heading">Rehearse this recording</h3>
              <p>
                Opens Multi-tray rehearsal with this recording as tray A and its
                result accepted. Clear its results there to run it again in
                browser MuJoCo.
              </p>
              <button
                className="replay-primary"
                disabled={busy}
                onClick={this.rehearse.bind(this)}
              >
                {this.state.rehearsing.kind === "reading"
                  ? "Preparing rehearsal…"
                  : "Rehearse this recording"}
              </button>
              <p role="alert">
                {this.state.rehearsing.kind === "rejected"
                  ? this.state.rehearsing.message
                  : ""}
              </p>
            </section>
          )}
          <div hidden={this.state.setupTab !== "files"}>
            <RobotComparison
              runner={this.props.robotRunner}
              open={this.props.actions.loaded}
              disabled={busy || !this.props.view.open}
              active={this.props.view.open}
            />
            <section
              className="physics-file-tools"
              aria-labelledby="physics-files-heading"
            >
              <h3 id="physics-files-heading">Open or save a recording</h3>
              <div className="physics-import">
                <p>Open a saved recording or loading handoff.</p>
                <label>
                  Recording file (.json)
                  <input
                    ref={this.file}
                    type="file"
                    accept=".json,application/json"
                    disabled={busy}
                    aria-invalid={error !== ""}
                    aria-describedby="physics-import-error"
                    onChange={this.importFile.bind(this)}
                  />
                </label>
                <p id="physics-import-error" role="alert">
                  {error}
                </p>
                <p className="physics-import-notice" role="status">
                  {this.state.notice}
                </p>
              </div>
              {document.kind === "ready" && (
                <button
                  className="physics-recording-file"
                  onClick={this.exportFile.bind(this)}
                >
                  Save recording only
                </button>
              )}
            </section>
          </div>
        </aside>
        <section
          id="physics-player"
          tabIndex={-1}
          className="physics-player"
          aria-label="Robot playback"
        >
          <div className="physics-viewport">
            <div className="physics-scene" ref={this.host} />
            {document.kind !== "ready" && (
              <div className="physics-empty">
                <Box size={36} strokeWidth={1.5} aria-hidden="true" />
                <h3>See your robot in motion</h3>
                <p>
                  Choose Table to rack to get started. Then rehearse it with
                  bakers, trays and the shared robot cell.
                </p>
              </div>
            )}
            {this.state.scene === "loading" && (
              <p className="physics-scene-status">
                Loading bakery and robot cell…
              </p>
            )}
          </div>
          {document.kind === "ready" && this.renderControls(document)}
        </section>
      </section>
    );
  }

  private renderTransport(
    replay: ReplayState,
    source: RecordingSource,
    end: number,
    step: number,
  ): React.ReactNode {
    return (
      <>
        <div className="workflow-playback-controls">
          <div className="workflow-playback-clock">
            <output aria-label="Recording time" aria-live="off">
              {formatDuration(replay.time)} / {formatDuration(end)}
            </output>
          </div>
          <div
            className="workflow-playback-transport"
            role="group"
            aria-label="Playback controls"
          >
            <PlaybackToggle
              playing={replay.playback === "playing"}
              playLabel="Play recording"
              pauseLabel="Pause"
              disabled={end === 0 || this.state.importing.kind === "reading"}
              onToggle={this.props.actions.toggle}
            />
            <button
              className="workflow-playback-restart"
              aria-label="Restart"
              title="Restart"
              onClick={this.props.actions.seek.bind(null, 0)}
            >
              <RotateCcw size={16} aria-hidden="true" />
            </button>
            <button onClick={this.nextEvent.bind(this)}>
              <StepForward size={16} aria-hidden="true" />
              Next event
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="workflow-playback-speed">
                  <span>Speed</span>
                  <span>{replay.speed}×</span>
                  <ChevronDown aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="workflow-more-menu workflow-speed-menu"
                  side="top"
                  align="end"
                  sideOffset={8}
                  collisionPadding={12}
                  aria-label="Playback speed"
                >
                  <GlideHighlight target="[data-highlighted]" />
                  <DropdownMenu.RadioGroup value={String(replay.speed)}>
                    {recordingSpeeds(source).map(
                      renderSpeed.bind(null, this.props.actions),
                    )}
                  </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
        <label className="physics-scrubber">
          Recording position
          <input
            type="range"
            min={0}
            max={end}
            step={step}
            value={replay.time}
            aria-valuetext={`${replay.time.toFixed(2)} seconds`}
            disabled={end === 0}
            onChange={this.scrub.bind(this)}
          />
        </label>
      </>
    );
  }

  private renderControls(
    document: Variant<RecordingDocument, "ready">,
  ): React.ReactNode {
    const replay = document.recording;
    const leg = physicsLegAt(replay, recordingSampleTime(document));
    const recording = leg.recording;
    const sample = samplePhysics(replay, recordingSampleTime(document));
    const end = recordingReplayEnd(document);
    return (
      <footer className="physics-controls">
        {this.renderTransport(
          document.replay,
          document.source,
          end,
          recording.request.timestep,
        )}
        <section aria-label="Recorded transfers" className="physics-transfers-row">
          <div className="physics-toolbar">
            {physicsTasks(replay).map(
              this.renderRecordedTransfer.bind(this, document),
            )}
          </div>
          <p className="physics-phase-summary">
            Current phase: <strong>{leg.label}</strong> · {leg.time.toFixed(2)}{" "}
            / {physicsDuration(recording).toFixed(2)} s · Recorded phase result:{" "}
            <span className="physics-outcome-badge" data-outcome={recording.outcome.kind}>
              {outcomeLabel(recording.outcome)}
            </span>
          </p>
        </section>
        {physicsEvidenceVisible() && (
          <details className="physics-telemetry-drawer">
            <summary>Events, poses and provenance</summary>
            <p className="physics-recording-status">
              <strong>Recording preview</strong> · {replayLabel(replay)} ·
              Recording result: {outcomeLabel(physicsOutcome(replay))} · Recorded
              motion: {recordingSampleTime(document).toFixed(2)} /{" "}
              {duration(replay).toFixed(2)} s
            </p>
            <div className="physics-details">
              <nav aria-label="Recording events">
                {physicsEvents(replay).map(this.renderEvent.bind(this))}
              </nav>
              <div className="physics-telemetry-grid">
                <div className="physics-telemetry-card">
                  <p>
                    Tray XYZ (m):{" "}
                    {sample.tray.slice(0, 3).map(formatCoordinate).join(", ")}
                  </p>
                  <p>
                    Arm joints (rad):{" "}
                    {sample.joints.map(formatCoordinate).join(", ")}
                  </p>
                  <p>{outcomeDescription(recording.outcome)}</p>
                </div>
                <div className="physics-telemetry-card">
                  <p>
                    Run: {recording.request.runId}
                    <br />
                    Attempt: {recording.request.attemptId}
                  </p>
                  <p>
                    MuJoCo {recording.provenance.version} ·{" "}
                    {recording.samples.length} samples
                    <br />
                    Model: <code>{recording.provenance.modelHash}</code>
                  </p>
                </div>
                <ul>{recording.provenance.assumptions.map(renderAssumption)}</ul>
                <p className="physics-telemetry-note">
                  Structural validation checks file consistency. Imported evidence
                  is unauthenticated and is never a physical production receipt.
                </p>
                {replay.kind === "bakery-physics-sequence" && (
                  <p className="physics-telemetry-note">
                    Native handoff digest: <code>{replay.handoffDigest}</code>.
                    Matching boundary poses check visible continuity. This file
                    cannot authenticate or reconstruct the full native state.
                  </p>
                )}
              </div>
            </div>
          </details>
        )}
      </footer>
    );
  }

  private renderRecordedTransfer(
    document: Variant<RecordingDocument, "ready">,
    task: RecordedTransfer,
  ): React.ReactNode {
    const time = recordingReplayStart(document) + task.start;
    return (
      <button
        key={task.id}
        aria-pressed={
          document.selection?.kind === "task" &&
          document.selection.id === task.id
        }
        onClick={this.navigateRecording.bind(
          this,
          { kind: "task", id: task.id },
          time,
        )}
      >
        {task.name} · {time.toFixed(2)} s
      </button>
    );
  }

  private renderEvent(
    event: PhysicsReplayEvent,
    index: number,
  ): React.ReactNode {
    const document = this.props.view.document;
    if (document.kind !== "ready") return null;
    return (
      <button key={index} onClick={this.event.bind(this, event)}>
        {(recordingReplayStart(document) + event.time).toFixed(2)} s ·{" "}
        {event.label}
      </button>
    );
  }
}

function renderSpeed(
  actions: RecordingReplayActions,
  speed: number,
): React.ReactNode {
  return (
    <DropdownMenu.RadioItem
      key={speed}
      value={String(speed)}
      onSelect={actions.changeSpeed.bind(null, speed)}
    >
      <span className="workflow-speed-indicator">
        <DropdownMenu.ItemIndicator>
          <Check size={16} aria-hidden="true" />
        </DropdownMenu.ItemIndicator>
      </span>
      {speed}×
    </DropdownMenu.RadioItem>
  );
}

function formatCoordinate(value: number): string {
  return value.toFixed(3);
}
function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds * 100) / 100;
  const minutes = Math.floor(rounded / 60);
  const remainder = Math.round((rounded - minutes * 60) * 100) / 100;
  if (minutes === 0) return `${remainder} s`;
  if (remainder === 0) return `${minutes} min`;
  return `${minutes} min ${remainder} s`;
}
function revokeDownload(url: string): void {
  URL.revokeObjectURL(url);
}
function taskLabel(task: PhysicsRequest["bakeryTaskId"]): string {
  switch (task) {
    case "table-to-rack":
      return "Table → rack";
    case "table-to-oven":
      return "Table → oven shelf 3";
  }
}

function replayLabel(replay: PhysicsReplayData): string {
  if (replay.kind === "bakery-physics-rack-sequence")
    return `${ROBOTS[replay.loading.request.robot].label} · Cold oven → table → cooling rack`;
  if (replay.kind === "bakery-physics-sequence")
    return `${ROBOTS[replay.loading.request.robot].label} · Cold oven load–unload cycle`;
  return `${ROBOTS[replay.request.robot].label} · ${taskLabel(replay.request.bakeryTaskId)} · ${replay.request.case}`;
}

function renderAssumption(text: string, index: number): React.ReactNode {
  return <li key={index}>{text}</li>;
}
function outcomeLabel(outcome: PhysicsOutcome): string {
  switch (outcome.kind) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "execution-error":
      return "Execution error";
  }
}
function outcomeDescription(outcome: PhysicsOutcome): string {
  switch (outcome.kind) {
    case "completed":
      return `Placement error ${(outcome.evidence.positionErrorM * 1000).toFixed(2)} mm; settled for ${outcome.evidence.settledSeconds.toFixed(2)} s.`;
    case "failed":
      return `${outcome.reason} Tray disposition: ${outcome.trayDisposition}.`;
    case "execution-error":
      return outcome.message;
  }
}
