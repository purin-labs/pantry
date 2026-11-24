import type { EngineJobs } from "../production-run/engine-jobs";
import type {
  BakeryWorkspaceViewAction,
  BakeryRecordingCameraView,
} from "@purin-labs/bakery-model/bakery-surface";
import type { WorkspaceCameraView } from "./simulator-state";
import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { GlideHighlight } from "@purin-labs/ui/glide-highlight";
import {
  ChevronDown,
  Eye,
  Workflow,
  SlidersHorizontal,
  ScanSearch,
  SquareDashed,
} from "lucide-react";
import { PhysicsReplay } from "./physics-replay";
import type { CatalogSection } from "./workflow-catalog";

import { ComparisonDock } from "./docks/comparison";
import { InspectorDock } from "./docks/inspector";
import { SimulatorHistoryControls } from "./docks/history-controls";
import { PlaybackDock } from "./docks/playback";
import { SceneViewControls } from "./docks/scene-view";
import { ScenariosDock } from "./docks/scenarios";
import { InputsDock } from "./docks/workflow-inputs";
import { WorkflowDock } from "./docks/workflow-dock";
import {
  clock,
  metrics,
  type Run,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import type { WorkflowSimulatorActionGroups } from "./simulator-actions";
import {
  type SimulatorConnection,
  type SimulatorDock as Dock,
  type SimulatorShellView,
} from "./simulator-state";

type Props = Readonly<{
  robotRunner: EngineJobs;
  connection: SimulatorConnection;
  view: SimulatorShellView;
  host: React.RefObject<HTMLDivElement | null>;
  layoutDetails: React.RefObject<HTMLDivElement | null>;
  form: React.RefObject<HTMLFormElement | null>;
  actions: WorkflowSimulatorActionGroups;
  cameraView: WorkspaceCameraView;
  controlView(action: BakeryWorkspaceViewAction): void;
  prepareRunOpen(id: string): Promise<void>;
}>;

type ShellState = Readonly<{
  workflowDockSubview: "catalog" | "steps";
  initialCatalogSection: CatalogSection | null;
}>;

export class WorkflowSimulatorShell extends React.Component<Props, ShellState> {
  state: ShellState = {
    workflowDockSubview: "catalog",
    initialCatalogSection: null,
  };
  private readonly recording = React.createRef<PhysicsReplay>();
  cameraAvailable(camera: BakeryRecordingCameraView["camera"]): boolean {
    return this.recording.current?.cameraAvailable(camera) === true;
  }
  get doorInspectionAvailable(): boolean {
    return this.recording.current?.doorInspectionAvailable === true;
  }
  componentDidUpdate(previous: Props): void {
    if (previous.view.recording.open && !this.props.view.recording.open) {
      focusPhysicsTrigger();
    }
    // A newly loaded procedure shows its steps in the Workflow panel.
    const shift = this.props.view.scenario.shift;
    const before = previous.view.scenario.shift;
    if (
      shift.kind === "procedure" &&
      (before.kind !== "procedure" ||
        before.normal.source !== shift.normal.source)
    )
      this.setState({ workflowDockSubview: "steps" });
  }
  private toggleWorkflowDock(): void {
    if (
      this.props.view.dock === "workflow" &&
      this.state.workflowDockSubview === "steps"
    ) {
      this.setState({ workflowDockSubview: "catalog" });
      return;
    }
    this.setState({ workflowDockSubview: "catalog" });
    this.props.actions.shell.toggleDock("workflow");
  }
  private setWorkflowDockSubview(
    workflowDockSubview: "catalog" | "steps",
  ): void {
    this.setState({ workflowDockSubview });
  }
  private openCatalogSection(section: CatalogSection): void {
    const procedure =
      section === "rehearsal-production" ? "rehearsal" : "financier";
    const targetSection =
      section === "rehearsal-production" ? "active-production" : section;
    this.setState({ initialCatalogSection: targetSection });
    this.props.actions.shell.openRecording();
    this.props.actions.workspace({
      kind: "openProduction",
      procedure,
    });
  }
  private returnToCatalog(): void {
    this.setState({
      workflowDockSubview: "catalog",
      initialCatalogSection: null,
    });
    this.props.actions.workspace({ kind: "closeProduction" });
    this.props.actions.recording.close();
    this.props.actions.shell.openDock("workflow");
  }
  private openFinancierMorning(): void {
    this.setState({
      workflowDockSubview: "steps",
      initialCatalogSection: null,
    });
    this.props.actions.workspace({ kind: "closeProduction" });
    this.props.actions.recording.close();
    this.props.actions.shell.openDock("workflow");
  }
  private toggleInspectorDock(): void {
    if (
      this.props.view.dock === "inspector" ||
      this.props.view.dock === "inputs"
    ) {
      this.props.actions.shell.openDock("closed");
      return;
    }
    this.props.actions.shell.openDock("inspector");
  }
  private renderDockToggle(
    dock: Exclude<Dock, "closed">,
    label: string,
    icon: React.ReactNode,
    disabled = false,
    srAlias = false,
  ): React.ReactNode {
    const onClick =
      dock === "workflow"
        ? this.toggleWorkflowDock.bind(this)
        : dock === "inspector"
          ? this.toggleInspectorDock.bind(this)
          : this.props.actions.shell.toggleDock.bind(this, dock);
    const expanded =
      dock === "inspector"
        ? this.props.view.dock === "inspector" ||
          this.props.view.dock === "inputs"
        : this.props.view.dock === dock;
    return (
      <button
        id={`workflow-toggle-${dock}`}
        className={srAlias ? "production-sr-alias" : undefined}
        tabIndex={srAlias ? -1 : undefined}
        aria-label={label}
        title={label}
        aria-expanded={expanded}
        aria-controls={`workflow-dock-${dock}`}
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
        <span className="workflow-command-label">{label}</span>
      </button>
    );
  }

  render(): React.ReactNode {
    const run = this.props.view.run;
    const result = metrics(run);
    const dock = this.props.view.dock;

    return (
      <div
        className="workflow-simulator"
        data-chrome={this.props.view.sceneView.chrome}
        onKeyDown={this.props.actions.shell.dockKeyDown.bind(this)}
      >
        <div
          className="workflow-layer"
          inert={this.props.view.recording.open}
          aria-hidden={this.props.view.recording.open}
        >
          <div className="workflow-scene" ref={this.props.host} />
          {this.props.view.sceneView.chrome === "hidden" ? (
            <button
              id="workflow-chrome-restore"
              type="button"
              className="workflow-chrome-restore"
              onClick={this.props.actions.shell.toggleChrome}
            >
              <Eye size={15} aria-hidden="true" />
              Show interface
              <kbd>H</kbd>
            </button>
          ) : null}
          {this.renderTopbar(run, result)}
          {this.renderSurfaceEdit()}
          <div className="workflow-stage">
            <WorkflowDock
              connection={this.props.connection}
              state={this.props.view.workflowInput}
              actions={this.props.actions.workflowInput}
              open={dock === "workflow"}
              subview={this.state.workflowDockSubview}
              onSubviewChange={this.setWorkflowDockSubview.bind(this)}
              openCatalogSection={this.openCatalogSection.bind(this)}
              selectBatch={this.props.actions.inspector.select}
            />
            <InputsDock
              state={this.props.view.workflowInput}
              actions={this.props.actions.workflowInput}
              form={this.props.form}
              run={run}
              open={dock === "inputs"}
              openInspector={this.props.actions.shell.openDock.bind(
                this,
                "inspector",
              )}
              selectInspector={this.props.actions.inspector.select}
            />
            <ScenariosDock
              connection={this.props.connection}
              state={this.props.view.scenario}
              actions={this.props.actions.scenario}
              open={dock === "scenarios"}
              run={run}
              stageMeasuredSettings={
                this.props.actions.workflowInput.stageMeasuredSettings
              }
            />
            <InspectorDock
              connection={this.props.connection}
              run={run}
              state={this.props.view.inspector}
              actions={this.props.actions.inspector}
              layoutDetails={this.props.layoutDetails}
              open={dock === "inspector"}
              openInputs={this.props.actions.shell.openDock.bind(
                this,
                "inputs",
              )}
            />
            <ComparisonDock
              run={run}
              state={this.props.view.comparison}
              actions={this.props.actions.comparison}
              open={dock === "comparison"}
            />
          </div>
          <div className="workflow-bottom-bar">
            <PlaybackDock
              run={run}
              result={result}
              timelineOpen={dock === "timeline"}
              state={this.props.view.playback}
              actions={this.props.actions.playback}
            />
            <SceneViewControls
              view={this.props.view.sceneView}
              actions={this.props.actions.sceneView}
            />
          </div>
        </div>
        <PhysicsReplay
          robotRunner={this.props.robotRunner}
          ref={this.recording}
          cameraView={this.props.cameraView}
          controlView={this.props.controlView}
          prepareRunOpen={this.props.prepareRunOpen}
          workspace={this.props.view.workspace}
          workspaceAction={this.props.actions.workspace}
          productionSettings={run.settings}
          productionLayout={this.props.view.scenario.layout}
          productionProcedure={
            this.props.view.scenario.shift.kind === "procedure"
              ? this.props.view.scenario.shift.normal.source
              : null
          }
          connection={this.props.connection}
          view={this.props.view.recording}
          actions={this.props.actions.recording}
          browserNotice={this.props.view.workcellNotice}
          browserJob={this.props.view.browserJob}
          browser={this.props.actions.browser}
          initialCatalogSection={this.state.initialCatalogSection}
          openFinancierMorning={this.openFinancierMorning.bind(this)}
          returnToCatalog={this.returnToCatalog.bind(this)}
        />
      </div>
    );
  }

  private renderTopbar(
    run: Run,
    result: ReturnType<typeof metrics>,
  ): React.ReactNode {
    const dock = this.props.view.dock;
    const compact =
      this.props.view.playback.playback === "playing" &&
      (dock === "closed" || dock === "timeline");
    return (
      <header className="workflow-topbar" data-compact={compact}>
        <div className="workflow-topbar-row">
          <h1 title="Financier morning">Financier morning</h1>
          {result.late > 0 && (
            <button
              className="workflow-delay-summary"
              data-late={result.late > 0}
              aria-label={`View delays: ${result.late} late`}
              onClick={this.props.actions.shell.openDock.bind(
                this,
                "comparison",
              )}
            >
              {result.late} late ↗
            </button>
          )}
          <nav aria-label="Simulator panels">
            <button
              type="button"
              className="production-sr-alias"
              style={{ right: "6px" }}
              tabIndex={-1}
              onClick={this.openCatalogSection.bind(this, "cafe-shift")}
            >
              Recipes
            </button>
            {this.renderDockToggle(
              "workflow",
              "Workflow",
              <Workflow size={15} aria-hidden="true" />,
            )}
            {this.renderDockToggle(
              "inputs",
              "Inputs",
              <SlidersHorizontal size={15} aria-hidden="true" />,
              false,
              true,
            )}
            {this.renderDockToggle(
              "inspector",
              "Details",
              <ScanSearch size={15} aria-hidden="true" />,
            )}
            {this.renderDockToggle(
              "floorPlan",
              "Floor plan",
              <SquareDashed size={15} aria-hidden="true" />,
              this.props.view.sceneView.scene === "unavailable",
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  id="workflow-more"
                  type="button"
                  aria-label="More simulator tools"
                  title="More simulator tools"
                >
                  <span className="workflow-command-label">More</span>
                  <ChevronDown size={15} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="workflow-more-menu"
                  align="start"
                  sideOffset={6}
                  collisionPadding={12}
                  aria-label="More simulator tools"
                >
                  <GlideHighlight target="[data-highlighted]" />
                  <DropdownMenu.Label className="workflow-more-summary">
                    {run.kind === "complete" ? "Finish" : "Shift ends"} ~
                    {clock(Math.round(run.end / 60) * 60).slice(0, 5)}
                    {" · "}
                    {result.unfinished} unfinished
                  </DropdownMenu.Label>
                  {/* Real shift data works without a workspace, so the local
                      demo opens Scenarios too. */}
                  <DropdownMenu.Item
                    onSelect={this.props.actions.shell.toggleDock.bind(
                      this,
                      "scenarios",
                    )}
                  >
                    Scenarios
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={this.props.actions.shell.toggleDock.bind(
                      this,
                      "comparison",
                    )}
                  >
                    Compare
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={this.props.actions.shell.openRecording}
                  >
                    Robot rehearsal
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    onSelect={this.props.actions.shell.resetView.bind(this)}
                  >
                    Reset view
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="workflow-menu-shortcut"
                    onSelect={this.props.actions.shell.toggleChrome}
                  >
                    Hide interface
                    <kbd>H</kbd>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </nav>
          {!this.props.view.recording.open && <SimulatorHistoryControls />}
        </div>
      </header>
    );
  }

  private renderSurfaceEdit(): React.ReactNode {
    const proposal = this.props.view.surfaceEditProposal;
    if (proposal === null) {
      return this.props.view.canUndoSurfaceEdit ? (
        <div className="workflow-surface-edit">
          <span>Agent changes applied to the draft.</span>
          <button type="button" onClick={this.props.actions.surfaceEdit.undo}>
            Undo agent changes
          </button>
        </div>
      ) : null;
    }
    return (
      <section className="workflow-surface-edit" aria-live="polite">
        <div>
          <strong>Agent-proposed assumption changes</strong>
          <ul>{proposal.summary.map(renderSurfaceEditSummary)}</ul>
          <p>
            Compiled preview: {proposal.preview.before.lateBatches} late and{" "}
            {proposal.preview.before.unfinishedBatches} unfinished before;{" "}
            {proposal.preview.after.lateBatches} late and{" "}
            {proposal.preview.after.unfinishedBatches} unfinished after.
          </p>
        </div>
        <div className="workflow-surface-edit-actions">
          <button
            type="button"
            onClick={this.props.actions.surfaceEdit.discard}
          >
            Discard
          </button>
          <button type="button" onClick={this.props.actions.surfaceEdit.apply}>
            Apply to draft
          </button>
        </div>
      </section>
    );
  }
}

function renderSurfaceEditSummary(summary: string): React.ReactNode {
  return <li key={summary}>{summary}</li>;
}

function focusPhysicsTrigger(): void {
  document.getElementById("workflow-more")?.focus();
}
