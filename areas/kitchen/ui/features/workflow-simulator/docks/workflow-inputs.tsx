import { scenarioAssumptionFields } from "@purin-labs/bakery-model/bakery-procedure";
import { fields } from "@purin-labs/bakery-model/bakery";
import React from "react";
import { ChevronRight } from "lucide-react";
import { Button, SideDrawer, Switch } from "@purin-labs/ui/index";
import {
  VITRINE_RUSH_PRESETS,
  applyRecommendedVitrineCapacity,
  getActiveVitrineRushPreset,
  getAutoScaleVitrineBatches,
  getVitrineDemandRevision,
  setActiveVitrineRushPreset,
  setAutoScaleVitrineBatches,
  stations,
  subscribeVitrineRushPreset,
  vitrineStockAt,
  type Run,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import type { WorkflowSimulatorActions } from "../simulator-actions";
import type { WorkflowInputView } from "../simulator-state";
import { DockHeader, SegmentedControl, normalSchedule } from "./shared";
import { OrderArrivalsDrawer } from "./order-arrivals";
import "./workflow-inputs.css";

type InputsProps = Readonly<{
  state: Pick<
    WorkflowInputView,
    "shift" | "procedureLoad" | "assumptionDraft" | "error" | "time"
  >;
  actions: Pick<
    WorkflowSimulatorActions,
    | "closeDock"
    | "chooseDemo"
    | "runShift"
    | "discardAssumptions"
    | "changeAssumption"
  >;
}> &
  Readonly<{
    form: React.RefObject<HTMLFormElement | null>;
    run: Run;
    open: boolean;
    openInspector: () => void;
    selectInspector: WorkflowSimulatorActions["select"];
  }>;

export function InputsDock(props: InputsProps): React.ReactNode {
  const [ordersOpen, setOrdersOpen] = React.useState(false);
  const activeRush = React.useSyncExternalStore(
    subscribeVitrineRushPreset,
    getActiveVitrineRushPreset,
    getActiveVitrineRushPreset,
  );
  const autoScaleBatches = React.useSyncExternalStore(
    subscribeVitrineRushPreset,
    getAutoScaleVitrineBatches,
    getAutoScaleVitrineBatches,
  );
  React.useSyncExternalStore(
    subscribeVitrineRushPreset,
    getVitrineDemandRevision,
    getVitrineDemandRevision,
  );
  const firstBatch = props.run.batches[0]?.id ?? "A";
  const firstWorker = props.run.resources[0]?.id ?? "human-1";
  const firstStation = stations[0]?.id ?? "stage";
  const vitrine = vitrineStockAt(props.run, props.state.time, activeRush);
  const hasCapacityDeficit =
    vitrine.batchDeficit > 0 ||
    vitrine.workerDeficit > 0 ||
    vitrine.ovenTrayDeficit > 0;
  return (
    <section
      id="workflow-dock-inputs"
      className="workflow-dock workflow-dock-right workflow-input-panel"
      hidden={!props.open}
      aria-label="Inputs"
    >
      <DockHeader
        label="Details"
        id="workflow-heading-Edit-inputs"
        closeLabel="Close Edit inputs"
        onClose={props.actions.closeDock}
      />
      <SegmentedControl
        ariaLabel="Details category"
        value="inputs"
        options={[
          {
            value: "inputs",
            label: "Inputs",
            onSelect: () => {},
          },
          {
            value: "batches",
            label: "Batches",
            onSelect: () => {
              props.selectInspector({ kind: "batch", id: firstBatch });
              props.openInspector();
            },
          },
          {
            value: "workers",
            label: "Workers",
            onSelect: () => {
              props.selectInspector({ kind: "resource", id: firstWorker });
              props.openInspector();
            },
          },
          {
            value: "equipment",
            label: "Equipment",
            onSelect: () => {
              props.selectInspector({ kind: "station", id: firstStation });
              props.openInspector();
            },
          },
        ]}
      />
      <p className="workflow-input-label" id="workflow-scenario-label">
        Scenario
      </p>
      <div
        className="workflow-presets"
        role="group"
        aria-labelledby="workflow-scenario-label"
      >
        <button onClick={props.actions.chooseDemo.bind(null, "morning")}>
          Normal
        </button>
        <button onClick={props.actions.chooseDemo.bind(null, "one-worker")}>
          One worker
        </button>
        <button onClick={props.actions.chooseDemo.bind(null, "breakdown")}>
          Oven breakdown
        </button>
      </div>
      <p className="workflow-input-label" id="workflow-orders-label">
        Orders
      </p>
      <div
        className="workflow-presets"
        role="group"
        aria-labelledby="workflow-orders-label"
      >
        {VITRINE_RUSH_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={activeRush === preset.id}
            title={`${preset.description} · Recommended: ${preset.recommendedBatchCount} batches`}
            onClick={setActiveVitrineRushPreset.bind(null, preset.id)}
          >
            {preset.shortLabel} · {preset.orderCount}
          </button>
        ))}
      </div>
      <div className="workflow-input-switch">
        <span>
          <strong id="workflow-autoscale-label">Auto-scale batches</strong>
          <small id="workflow-autoscale-hint">
            Batches, workers and oven trays follow the orders
          </small>
        </span>
        <Switch
          aria-labelledby="workflow-autoscale-label"
          aria-describedby="workflow-autoscale-hint"
          checked={autoScaleBatches}
          onCheckedChange={(checked) => setAutoScaleVitrineBatches(checked)}
        />
      </div>
      {hasCapacityDeficit && (
        <button
          type="button"
          className="workflow-input-recommend"
          title={vitrine.capacityRecommendationLabel}
          onClick={applyRecommendedVitrineCapacity}
        >
          Apply recommended ({vitrine.recommendedBatchCount}B ·{" "}
          {vitrine.recommendedWorkerCount}W · {vitrine.recommendedOvenTrays}T)
        </button>
      )}
      <ul className="workflow-input-rows">
        <li>
          <button
            type="button"
            className="workflow-input-row"
            onClick={() => setOrdersOpen(true)}
          >
            <span>
              <strong>Order arrivals</strong>
              <small>
                {vitrine.orders.length} orders
                {vitrine.hasCustomArrivals
                  ? ` · ${vitrine.customArrivalCount} edited`
                  : " · default times"}
              </small>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </li>
      </ul>
      <OrderArrivalsDrawer
        open={ordersOpen}
        close={() => setOrdersOpen(false)}
        vitrine={vitrine}
      />
      <InputsForm {...props} />
    </section>
  );
}

function InputsForm(props: InputsProps): React.ReactNode {
  const [moreOpen, setMoreOpen] = React.useState(false);
  const advanced = fields.filter(isAdvancedField);
  // A refused value of a field in the drawer shows under its row too.
  const advancedError = advanced.some(
    (field) => field.key === props.state.error?.field,
  )
    ? props.state.error?.message
    : undefined;
  return (
    <form
      id="workflow-inputs"
      ref={props.form}
      onSubmit={props.actions.runShift}
      noValidate
    >
      <div className="workflow-fields">
        {fields.filter(isQuickField).map(renderField.bind(null, props))}
      </div>
      <ul className="workflow-input-rows">
        <li>
          <button
            type="button"
            className="workflow-input-row"
            onClick={() => setMoreOpen(true)}
          >
            <span>
              <strong>More settings</strong>
              <small>{advanced.length} fields</small>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </li>
      </ul>
      {advancedError !== undefined && (
        <p className="error-text" role="alert">
          {advancedError}
        </p>
      )}
      <SideDrawer
        open={moreOpen}
        title="More settings"
        close={() => setMoreOpen(false)}
        className="workflow-settings-drawer"
        footer={
          <Button variant="primary" onClick={() => setMoreOpen(false)}>
            Done
          </Button>
        }
      >
        <div className="side-drawer-body workflow-fields">
          {advanced.map(renderField.bind(null, props))}
        </div>
      </SideDrawer>
      <div className="workflow-toolbar workflow-apply-actions">
        <button
          type="submit"
          className="primary-button"
          disabled={props.state.procedureLoad.kind === "loading"}
        >
          Apply changes
        </button>
        <button
          type="button"
          onClick={props.actions.discardAssumptions}
          disabled={props.state.assumptionDraft.size === 0}
        >
          Discard changes
        </button>
      </div>
    </form>
  );
}

function renderField(
  props: InputsProps,
  field: (typeof fields)[number],
): React.ReactNode {
  const error =
    props.state.error?.field === field.key ? props.state.error.message : null;
  return (
    <div key={field.key}>
      <label htmlFor={`workflow-field-${field.key}`}>{fieldLabel(field)}</label>
      <input
        id={`workflow-field-${field.key}`}
        name={field.key}
        type="number"
        min={field.min}
        max={field.max}
        step={1}
        required
        disabled={
          (props.state.shift.kind === "procedure" &&
            !scenarioAssumptionFields.has(field.key)) ||
          props.state.procedureLoad.kind === "loading"
        }
        value={
          props.state.assumptionDraft.get(field.key) ??
          normalSchedule(props.state.shift).settings[field.key]
        }
        onChange={props.actions.changeAssumption.bind(null, field.key)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `workflow-error-${field.key}` : undefined}
      />
      <span id={`workflow-error-${field.key}`} className="error-text">
        {error}
      </span>
    </div>
  );
}

function isQuickField(field: (typeof fields)[number]): boolean {
  return ["batchCount", "workerCount", "ovenTrays", "bake"].includes(field.key);
}

function isAdvancedField(field: (typeof fields)[number]): boolean {
  return !isQuickField(field);
}

function fieldLabel(field: (typeof fields)[number]): string {
  switch (field.key) {
    case "batchCount":
      return "Batches";
    case "workerCount":
      return "Workers";
    case "ovenTrays":
      return "Trays in the oven";
    case "bake":
      return "Bake time (min)";
    default:
      return field.label;
  }
}
