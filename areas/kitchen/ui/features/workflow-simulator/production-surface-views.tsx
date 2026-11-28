import { jobStepLabel } from "../production-run/job-progress";
import { Select } from "@purin-labs/ui/select";
import { EspressoRecipeAuthor } from "../production-run/linea/espresso-recipe-author";
import { FinancierBakeRecipeAuthor } from "../production-run/financier-bake/financier-bake-recipe-author";
import type { FinancierHandoffRecoveryPreset } from "@purin-labs/production-simulation/recipes/financier-bake/model";
import { FinancierBatterRecipeAuthor } from "../production-run/financier-batter/financier-batter-recipe-author";
import { FinancierPackRecipeAuthor } from "../production-run/financier-pack/financier-pack-recipe-author";
import { CafeShiftRecipeAuthor } from "../production-run/cafe-shift/cafe-shift-recipe-author";
import { BakeryShiftAuthor } from "../production-run/bakery-shift-author";
import { ColdCellRouteAuthor } from "../production-run/cold-cell-route-author";
import { BlackSesameRecipeAuthor } from "../production-run/black-sesame-recipe-author";
import { BlackSesameCobotRecipeAuthor } from "../production-run/black-sesame/black-sesame-cobot-recipe-author";
import { GingerTeaRecipeAuthor } from "../production-run/ginger-tea-recipe-author";
import { GingerMilkTeaRecipeAuthor } from "../production-run/ginger-milk-tea-recipe-author";
import { GingerTeaCobotRecipeAuthor } from "../production-run/ginger-tea/ginger-tea-cobot-recipe-author";
import { LatteRecipeAuthor } from "../production-run/latte/latte-recipe-author";
import { PourOverRecipeAuthor } from "../production-run/pour-over/pour-over-recipe-author";
import { PastryBenchRecipeAuthor } from "../production-run/pastry-bench/pastry-bench-recipe-author";
import { RECIPE_TASKS, WorkflowCatalog } from "./workflow-catalog";
import {
  batchWorkerFlow,
  compactNativeTrayStatus,
  compactStationWait,
  shortProcessTitle,
  shortStationName,
  stationWaitForStep,
} from "./production-workspace-helpers";
import { SiphonRecipeAuthor } from "../production-run/siphon/siphon-recipe-author";
import { FactoryComparison } from "../production-run/factory-comparison";
import { acceptedProductionResults } from "./production-draft";
import React from "react";
import type {
  PlannedProductionWorkcell,
  ProductionWorkcell,
} from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import {
  humanResource,
  taskAt,
  workName,
  type Run,
  type Interval,
  type Batch,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { NativeTimelineTrack } from "./timeline";
import { nextProductionExecution } from "@purin-labs/production-simulation/simulator/production-execution";
import type { ProductionReady as Ready } from "./production-session";
import { WorkspaceRunsPanel } from "./workspace-runs-panel";
import { RecordingCandidatePreview } from "./recording-candidate-preview";
import { stepName } from "./scheduled-rehearsal";
import { HANDOFF_PRESETS, renderItem } from "./production-workspace-choices";
import type { ProductionWorkspace } from "./production-workspace";
import {
  batchTask,
  batchTitle,
  batchWaits,
  batchWithId,
  cardTitle,
  inBatch,
  nativeOperationStatus,
  operationChoice,
} from "./production-workspace-queries";

export const productionSurfaceViews = {
  timelineDrawer(this: ProductionWorkspace, data: Ready): React.ReactNode {
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
  },

  executing(this: ProductionWorkspace): boolean {
    return (
      this.props.browserJob.kind === "loading" ||
      this.props.browserJob.kind === "running"
    );
  },

  browserExecution(this: ProductionWorkspace, data: Ready): React.ReactNode {
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
  },

  runInBrowser(this: ProductionWorkspace): void {
    this.props.playback.pause();
    this.props.runInBrowser();
  },

  catalogSectionContent(this: ProductionWorkspace): React.ReactNode {
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
  },

  catalogMenuList(this: ProductionWorkspace, data: Ready): React.ReactNode {
    const batchSummary = data.run.batches
      .map((batch) => workName(data.run, batch.id))
      .join(" → ");
    const processStepCount = data.run.intervals.filter(
      (interval) => interval.kind === "process",
    ).length;
    return (
      <>
        <WorkflowCatalog
          rows={[
            ...(this.props.session.procedure === "rehearsal"
              ? [
                  {
                    id: "rehearsal-production" as const,
                    fact: `${batchSummary} · rack handoff`,
                    open: this.openCatalogSection.bind(
                      this,
                      "active-production",
                    ),
                  },
                ]
              : []),
            {
              id: "appliance-rehearsals",
              open: this.openCatalogSection.bind(this, "appliance-rehearsals"),
            },
            ...RECIPE_TASKS.map((id) => ({
              id,
              open: this.openCatalogSection.bind(this, id),
            })),
            ...(this.props.session.procedure !== "rehearsal"
              ? [
                  {
                    id: "active-production" as const,
                    fact: `${batchSummary} · ${processStepCount} steps · robot handoffs`,
                    open: this.openCatalogSection.bind(
                      this,
                      "active-production",
                    ),
                  },
                ]
              : []),
            {
              id: "cafe-shift",
              open: this.openCatalogSection.bind(this, "cafe-shift"),
            },
            ...(this.props.connection.kind === "workspace"
              ? [
                  {
                    id: "shared-runs" as const,
                    open: this.openCatalogSection.bind(this, "shared-runs"),
                  },
                ]
              : []),
          ]}
        />
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
  },

  content(this: ProductionWorkspace, data: Ready): React.ReactNode {
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
  },

  hybridBatchChain(this: ProductionWorkspace, data: Ready): React.ReactNode {
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
              <span className="production-hybrid-status">
                {activeSettings.traysPerBatch} trays a batch ·{" "}
                {activeSettings.piecesPerTray} pieces a tray · Stage{" "}
                {activeSettings.stage} · Portion {activeSettings.portion} · Bake{" "}
                {activeSettings.bake} · Cool {activeSettings.cool} · Pack{" "}
                {activeSettings.pack} min
                {hasTier2Calibration ? " · calibrated" : ""}
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
            <dt>Held handoffs</dt>
            <dd>{gatedHandoffCount}</dd>
          </dl>
          <label className="production-handoff-preset-control">
            Handoff
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
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{HANDOFF_PRESETS.map(renderItem)}</Select.Popup>
            </Select.Root>
          </label>
        </section>
        {data.run.batches.map((batch, index) => (
          <React.Fragment key={batch.id}>
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
  },

  hybridBatchCard(
    this: ProductionWorkspace,
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
          ? `1 wait · ${totalWaitSeconds} s at ${shortStationName(waits[0]!.first.station)}`
          : `${waits.length} waits · ${totalWaitSeconds} s`;
    return (
      <section className="production-hybrid-card" data-state={badgeState}>
        <header className="production-hybrid-card-header">
          <div className="production-hybrid-card-title">
            <span className="production-hybrid-badge" data-state={badgeState}>
              {workName(run, batch.id)}
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
  },

  hybridStepChip(
    this: ProductionWorkspace,
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
  },

  nativeCanvasNode(
    this: ProductionWorkspace,
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
  },

  plannedCanvasNode(
    this: ProductionWorkspace,
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
  },
};
