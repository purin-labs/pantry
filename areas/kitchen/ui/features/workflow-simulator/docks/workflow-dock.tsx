import { financierOperations } from "@purin-labs/bakery-model/bakery";
import React from "react";
import {
  PLAN_61A_MASS_BALANCE,
  getActiveVitrineRushPreset,
  getAutoScaleVitrineBatches,
  getVitrineDemandRevision,
  humanResource,
  plan61AOperationSubsteps,
  plan61ASubstepAt,
  stationLabel,
  stationZoneLabel,
  subscribeVitrineRushPreset,
  taskAt,
  vitrineStockAt,
  type Run,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import {
  operationTask,
  selectionContext,
} from "@purin-labs/production-simulation/simulator/selection";
import type { WorkflowSimulatorActions } from "../simulator-actions";
import type {
  SimulatorConnection,
  WorkflowInputView,
} from "../simulator-state";
import {
  DockHeader,
  SegmentedControl,
  scheduleForVariant,
  taskStatusLabel,
} from "./shared";
import {
  RECIPE_TASKS,
  WorkflowCatalog,
  type CatalogSection,
} from "../workflow-catalog";
import "./workflow-dock.css";

type WorkflowStepContext = Readonly<{
  state: Pick<WorkflowInputView, "shift" | "selection" | "time" | "variant">;
  actions: Pick<WorkflowSimulatorActions, "observeOperation">;
}>;

type WorkflowProps = WorkflowStepContext &
  Readonly<{
    connection: SimulatorConnection;
    actions: Pick<WorkflowSimulatorActions, "closeDock">;
    open: boolean;
    subview: "catalog" | "steps";
    onSubviewChange(subview: "catalog" | "steps"): void;
    openCatalogSection(section: CatalogSection): void;
    selectBatch: WorkflowSimulatorActions["select"];
  }>;

/**
 * The Workflow panel of the floor plan: the catalog, and the steps of the
 * Financier morning shift with its vitrine and its mass balance.
 */
export function WorkflowDock(props: WorkflowProps): React.ReactNode {
  // A loaded procedure opens on its steps; Back still returns to the catalog.
  const depth = props.subview === "steps" ? 1 : 0;
  const open = props.openCatalogSection;
  return (
    <section
      id="workflow-dock-workflow"
      className="workflow-dock workflow-dock-left workflow-overview"
      hidden={!props.open}
      aria-label="Workflow"
    >
      <DockHeader label="Workflow" onClose={props.actions.closeDock} />
      <div className="production-menu-viewport">
        <div className="production-menu-track" data-depth={depth}>
          <div className="production-menu-page" data-active={depth === 0}>
            <WorkflowCatalog
              rows={[
                {
                  id: "rehearsal-production",
                  open: open.bind(null, "rehearsal-production"),
                },
                {
                  id: "appliance-rehearsals",
                  open: open.bind(null, "appliance-rehearsals"),
                },
                ...RECIPE_TASKS.map((id) => ({
                  id,
                  open: open.bind(null, id),
                })),
                {
                  id: "financier-morning",
                  open: props.onSubviewChange.bind(null, "steps"),
                },
                {
                  id: "active-production",
                  open: open.bind(null, "active-production"),
                },
                { id: "cafe-shift", open: open.bind(null, "cafe-shift") },
                ...(props.connection.kind === "workspace"
                  ? [
                      {
                        id: "shared-runs" as const,
                        open: open.bind(null, "shared-runs"),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
          <div className="production-menu-page" data-active={depth === 1}>
            <div className="production-section-header">
              <button
                type="button"
                className="production-menu-back"
                onClick={props.onSubviewChange.bind(null, "catalog")}
              >
                ← Back
              </button>
              <h3>Financier morning</h3>
            </div>
            <SegmentedControl
              ariaLabel="Select batch"
              value={workflowBatch(props.state)}
              options={scheduleForVariant(
                props.state.shift,
                props.state.variant,
              ).batches.map((batch) => ({
                value: batch.id,
                label: `Batch ${batch.id}`,
                onSelect: props.selectBatch.bind(null, {
                  kind: "batch",
                  id: batch.id,
                }),
              }))}
            />
            <ol className="workflow-step-list">
              {financierOperations.map(renderWorkflowStep.bind(null, props))}
            </ol>
            <VitrineStock state={props.state} />
            <MassBalance />
          </div>
        </div>
      </div>
    </section>
  );
}

function FactList(
  props: Readonly<{
    title: string;
    rows: readonly (readonly [string, React.ReactNode])[];
  }>,
): React.ReactNode {
  return (
    <section className="workflow-fact-section" aria-label={props.title}>
      <h4>{props.title}</h4>
      <dl className="workflow-fact-list">
        {props.rows.map(([term, value]) => (
          <React.Fragment key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
}

function VitrineStock(
  props: Readonly<{ state: WorkflowStepContext["state"] }>,
): React.ReactNode {
  const activeRush = React.useSyncExternalStore(
    subscribeVitrineRushPreset,
    getActiveVitrineRushPreset,
    getActiveVitrineRushPreset,
  );
  React.useSyncExternalStore(
    subscribeVitrineRushPreset,
    getAutoScaleVitrineBatches,
    getAutoScaleVitrineBatches,
  );
  React.useSyncExternalStore(
    subscribeVitrineRushPreset,
    getVitrineDemandRevision,
    getVitrineDemandRevision,
  );
  const run = scheduleForVariant(props.state.shift, props.state.variant);
  const vitrine = vitrineStockAt(run, props.state.time, activeRush);
  const completedWaves = vitrine.refillWaves.filter(
    (wave) => wave.status === "completed",
  ).length;
  return (
    <FactList
      title={`Vitrine · ${vitrine.loosePieces} loose · ${vitrine.ballotinBoxes} boxes`}
      rows={[
        ["Demand", vitrine.rushPresetLabel],
        [
          "Batches",
          `${vitrine.scheduledBatchCount} of ${vitrine.recommendedBatchCount} · ${
            vitrine.batchDeficit > 0
              ? `${vitrine.batchDeficit}-batch deficit`
              : "demand covered"
          } · auto-scale ${vitrine.autoScaleBatches ? "on" : "off"}`,
        ],
        ["Staff and oven", vitrine.capacityRecommendationLabel],
        ["Showcase", vitrine.statusLabel],
        [
          "Loose pieces",
          `${vitrine.loosePieces} of ${vitrine.looseCapacity} · ${vitrine.soldLoosePieces} sold · +${vitrine.restockedLoosePieces} restocked`,
        ],
        [
          "Gift boxes",
          `${vitrine.ballotinBoxes} of ${vitrine.ballotinCapacity} · ${vitrine.soldBallotinBoxes} sold · +${vitrine.restockedBallotinBoxes} restocked`,
        ],
        [
          "Orders",
          `${vitrine.fulfilledOrders.length} done · ${vitrine.waitingOrders.length} waiting · ${vitrine.upcomingOrders.length} to come`,
        ],
        ["Bar drinks", vitrine.barStatusLabel],
        ["Arrivals", vitrine.customArrivalSummary],
        [
          "Refill waves",
          `${completedWaves} of ${vitrine.refillWaves.length} · +5 loose and +2 boxes a batch`,
        ],
      ]}
    />
  );
}

function MassBalance(): React.ReactNode {
  const mass = PLAN_61A_MASS_BALANCE;
  return (
    <FactList
      title={`Mass balance · ${mass.inputGrams} g batch`}
      rows={[
        ["Weighed", `${mass.inputGrams} g · Ohaus scale`],
        [
          "Brown butter",
          `${mass.brownButterInputGrams} g → ${mass.brownButterOutputGrams} g (−${mass.brownButterEvaporationGrams} g steam)`,
        ],
        [
          "Batter",
          `${mass.transferableBatterGrams} g · Hobart HL200 (−${mass.bowlResidueGrams} g in bowl)`,
        ],
        [
          "Moulds",
          `${mass.mouldCount} × 8 cavities = ${mass.trayDepositedGrams} g (${mass.retainedBatterGrams} g kept)`,
        ],
        [
          "Baked",
          `${mass.bakedPiecesGrams} g (−${mass.bakeEvaporationGrams} g bake loss) · 3 moulds washed`,
        ],
        [
          "Packed",
          `${mass.acceptedPackedGrams} g · ${mass.acceptedPieceCount} pcs · ${mass.sampledPieceGrams} g check · ${mass.rejectedPiecesGrams} g rejected`,
        ],
      ]}
    />
  );
}

function renderWorkflowStep(
  props: WorkflowStepContext,
  item: (typeof financierOperations)[number],
): React.ReactNode {
  const label = operationLabel(item);
  const run = scheduleForVariant(props.state.shift, props.state.variant);
  const task = operationTask(
    run,
    props.state.selection,
    props.state.time,
    item.operation,
  );
  const selected = selectionContext(
    run,
    props.state.selection,
    props.state.time,
  ).task;
  const stepKind =
    task === null ? "queued" : taskAt(run, task, props.state.time).kind;
  const substeps = plan61AOperationSubsteps(item.operation);
  const activeSubstep =
    task !== null && task.kind === "process" && stepKind === "running"
      ? plan61ASubstepAt(task, props.state.time)
      : null;
  return (
    <li key={item.operation}>
      <button
        className="workflow-step"
        aria-pressed={task !== null && selected?.id === task.id}
        onClick={props.actions.observeOperation.bind(null, item.operation)}
      >
        <strong>{label}</strong>
        <span
          className="workflow-step-status workflow-status-pill"
          data-tone={stepKind}
        >
          {task === null ? "Not scheduled" : taskStatusLabel(stepKind)}
        </span>
        <small>
          {run.settings[item.operation]} min
          {task === null ? "" : assignmentLabel(run, task)}
        </small>
      </button>
      <ul className="workflow-substep-list" aria-label={`${label} sub-steps`}>
        {substeps.map((sub) => (
          <li
            key={sub.id}
            className="workflow-substep-item"
            data-active={activeSubstep?.id === sub.id ? "true" : undefined}
            title={`${sub.label} — ${sub.massNote}`}
          >
            {sub.shortLabel}
          </li>
        ))}
      </ul>
    </li>
  );
}

/** The worker and the place of a step: "Baker 1 · Prep & Portioning". */
function assignmentLabel(
  run: Run,
  task: NonNullable<ReturnType<typeof operationTask>>,
): string {
  const place = stationZoneLabel(task.station).replace(/ Zone$/u, "");
  return task.attended
    ? ` · ${humanResource(run, task.executor).name} · ${place}`
    : ` · No worker · ${place}`;
}

function operationLabel(item: (typeof financierOperations)[number]): string {
  switch (item.operation) {
    case "stage":
      return "Stage batter";
    case "portion":
      return "Fill moulds";
    case "cool":
      return "Cool in moulds";
    case "demould":
      return "Remove from moulds";
    case "finishCooling":
      return "Cool before packing";
    default:
      return stationLabel(item.station);
  }
}

function workflowBatch(state: WorkflowStepContext["state"]): string {
  const run = scheduleForVariant(state.shift, state.variant);
  const batch =
    selectionContext(run, state.selection, state.time).batch ?? run.batches[0];
  if (batch === undefined) throw new Error("the schedule has no batches");
  return batch.id;
}
