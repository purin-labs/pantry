import * as Views from "./workspace-views";
import { Select } from "@purin-labs/ui/select";
import { SegmentedControl } from "./docks/shared";
import { PRODUCTION_SCENARIO_PICKER, ScenarioPicker } from "./scenario-picker";
import type { BatchWaitSummary } from "./production-workspace-helpers";
import { OvenRouteAuthor } from "../production-run/oven-route-author";
import React from "react";
import { productionMaterialAt } from "@purin-labs/production-simulation/recipes/bakery/production-material";
import type { Settings } from "@purin-labs/bakery-model/bakery";
import {
  productionAssignmentId,
  productionTaskChoices,
  type ProductionTaskChoice,
  type ProductionManualTask,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import type { ProductionWorkcell } from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import {
  describe,
  humanResource,
  taskAt,
  metrics,
  workName,
  type Run,
  type Interval,
  type Batch,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { TimelineTrack, WorkerTimelineTrack } from "./timeline";
import { selectionContext } from "@purin-labs/production-simulation/simulator/selection";
import type { ProductionReady as Ready } from "./production-session";
import { coldCell } from "@purin-labs/production-simulation/recipes/bakery/workcell-instances";
import {
  ANY_BAKER,
  FINANCIER_PRESETS,
  OVEN_VARIANTS,
  renderItem,
  workerChoices,
  type SelectChoice,
} from "./production-workspace-choices";
import type { ProductionWorkspace } from "./production-workspace";
import {
  activeMaterialReservation,
  batchHold,
  batchTask,
  batchWaits,
  hasNativeOperation,
  hasPredecessor,
  holdForOperation,
  inBatch,
  isManualChoice,
  manualTaskWithId,
  matchesDraftAssignment,
  materialLocation,
  materialStatus,
  nativeFailureLabel,
  otherTask,
  reservedCellNames,
  selectedNativeStatus,
  taskChoice,
  waitForBatch,
} from "./production-workspace-queries";

export const productionAuthorViews = {
  selectManualTask(this: ProductionWorkspace, value: string | null): void {
    if (value !== null) this.update({ manualTaskId: value });
  },

  editManualTask(
    this: ProductionWorkspace,
    task: ProductionManualTask,
  ): void {
    this.editDraft({ kind: "manual", task });
  },

  manualWorker(
    this: ProductionWorkspace,
    task: ProductionManualTask,
    value: string | null,
  ): void {
    if (value === null) return;
    this.editManualTask({
      bakeryTaskId: task.bakeryTaskId,
      workerId: value === "automatic" ? null : `human-${Number(value)}`,
      dependsOn: task.dependsOn,
      earliestStartSeconds: task.earliestStartSeconds,
    });
  },

  manualStart(
    this: ProductionWorkspace,
    task: ProductionManualTask,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    this.editManualTask({
      bakeryTaskId: task.bakeryTaskId,
      workerId: task.workerId,
      dependsOn: task.dependsOn,
      earliestStartSeconds: Number(event.currentTarget.value),
    });
  },

  manualDependency(
    this: ProductionWorkspace,
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
  },

  manualPredecessor(
    this: ProductionWorkspace,
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
  },

  manualAuthor(
    this: ProductionWorkspace,
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
  },

  author(this: ProductionWorkspace, data: Ready): React.ReactNode {
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
  },

  batchDetail(
    this: ProductionWorkspace,
    run: Run,
    batch: Batch,
  ): React.ReactNode {
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
  },

  task(
    this: ProductionWorkspace,
    run: Run,
    interval: Interval,
  ): React.ReactNode {
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
  },

  waitSummary(
    this: ProductionWorkspace,
    summary: BatchWaitSummary,
  ): React.ReactNode {
    return (
      <button
        key={summary.label}
        onClick={this.inspect.bind(this, summary.first)}
      >
        Wait · {summary.label} · {Math.round(summary.seconds)} s total
      </button>
    );
  },

  requestCard(
    this: ProductionWorkspace,
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
  },

  hold(
    this: ProductionWorkspace,
    hold: Run["nativeHolds"][number],
  ): React.ReactNode {
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
  },

  unresolvedWait(
    this: ProductionWorkspace,
    run: Run,
    wait: Run["unresolvedWaits"][number],
  ): React.ReactNode {
    return (
      <p key={`${wait.batch}-${wait.station}-${wait.reason}`}>
        {workName(run, wait.batch)} is blocked at {wait.station}: {wait.label}
      </p>
    );
  },

  track(this: ProductionWorkspace, run: Run, batch: Batch): React.ReactNode {
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
  },

  workerTrack(
    this: ProductionWorkspace,
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
  },

  detailsModeTabs(
    this: ProductionWorkspace,
    active: "details" | "author",
  ): React.ReactNode {
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
  },

  details(this: ProductionWorkspace, run: Run): React.ReactNode {
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
  },

  materialDetails(
    this: ProductionWorkspace,
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
  },
};
