import { scenarioAssumptionFields } from "@seams/bakery-model/bakery-procedure";
import { fields, financierOperations } from "@seams/bakery-model/bakery";
import React from "react";
import { Select } from "../../../ui/select";

import {
  CAFE_BEVERAGE_ROTATION,
  PLAN_61A_MASS_BALANCE,
  VITRINE_ORDER_CHANNELS,
  VITRINE_RUSH_PRESETS,
  addCustomVitrineOrder,
  applyRecommendedVitrineCapacity,
  clock,
  exportCustomVitrineOrdersJson,
  getActiveVitrineRushPreset,
  getAutoScaleVitrineBatches,
  getVitrineDemandRevision,
  humanResource,
  importCustomVitrineOrdersJson,
  nudgeVitrineOrderArrivalMinutes,
  plan61AOperationSubsteps,
  plan61ASubstepAt,
  removeCustomVitrineOrder,
  resetCustomVitrineOrders,
  setActiveVitrineRushPreset,
  setAutoScaleVitrineBatches,
  setVitrineOrderArrivalMinutes,
  setVitrineOrderItems,
  shiftAllVitrineOrderArrivals,
  stationLabel,
  stationZoneLabel,
  stations,
  subscribeVitrineRushPreset,
  taskAt,
  vitrineStockAt,
  type CafeBeverageRecipeId,
  type Run,
  type VitrineOrderChannel,
} from "@seams/production-simulation/recipes/bakery/schedule";
import {
  operationTask,
  selectionContext,
} from "@seams/production-simulation/simulator/selection";
import { downloadBakeryFile } from "../file-download";
import type { WorkflowSimulatorActions } from "../simulator-actions";
import type {
  SimulatorConnection,
  SimulatorShift,
  WorkflowInputView,
} from "../simulator-state";
import { DockHeader, SegmentedControl, taskStatusLabel } from "./shared";
import { CompleteRecipeTaskCatalog } from "../complete-recipe-task-catalog";
import type { CatalogSection } from "../production-workspace";

type WorkflowInputState = Pick<
  WorkflowInputView,
  | "shift"
  | "procedureLoad"
  | "assumptionDraft"
  | "error"
  | "selection"
  | "time"
  | "variant"
>;

type WorkflowInputActions = Pick<
  WorkflowSimulatorActions,
  | "closeDock"
  | "observeOperation"
  | "chooseDemo"
  | "runShift"
  | "discardAssumptions"
  | "changeAssumption"
>;

type CommonProps = Readonly<{
  connection: SimulatorConnection;
  state: WorkflowInputState;
  actions: WorkflowInputActions;
}>;

const CHANNEL_ITEMS = VITRINE_ORDER_CHANNELS.map((ch) => ({
  value: ch.id,
  label: ch.label,
}));
const BEVERAGE_ITEMS = CAFE_BEVERAGE_ROTATION.map((bev) => ({
  value: bev.recipe,
  label: bev.shortName,
}));

type WorkflowStepContext = Readonly<{
  state: Pick<WorkflowInputView, "shift" | "selection" | "time" | "variant">;
  actions: Pick<WorkflowSimulatorActions, "observeOperation">;
}>;

type WorkflowProps = CommonProps &
  Readonly<{
    open: boolean;
    subview: "catalog" | "steps";
    onSubviewChange(subview: "catalog" | "steps"): void;
    openCatalogSection(section: CatalogSection): void;
    selectBatch: WorkflowSimulatorActions["select"];
  }>;

type InputsProps = CommonProps &
  Readonly<{
    form: React.RefObject<HTMLFormElement | null>;
    run: Run;
    open: boolean;
    openInspector: () => void;
    selectInspector: WorkflowSimulatorActions["select"];
  }>;

export function WorkflowDock(props: WorkflowProps): React.ReactNode {
  // A loaded procedure opens on its steps; Back still returns to the catalog.
  const depth = props.subview === "steps" ? 1 : 0;
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
                  <button
                    type="button"
                    className="production-menu-item production-catalog-card"
                    onClick={props.openCatalogSection.bind(
                      null,
                      "rehearsal-production",
                    )}
                  >
                    <div className="production-catalog-card-body">
                      <strong>
                        Multi-tray robot rehearsal (Tray A → Tray B)
                      </strong>
                      <small>
                        Active 3D tray rehearsal &amp; rack handoff calibration
                      </small>
                    </div>
                    <span
                      className="production-menu-chevron"
                      aria-hidden="true"
                    >
                      ›
                    </span>
                  </button>
                  <button
                    type="button"
                    className="production-menu-item production-catalog-card"
                    onClick={props.openCatalogSection.bind(
                      null,
                      "appliance-rehearsals",
                    )}
                  >
                    <div className="production-catalog-card-body">
                      <strong>Standalone appliance rehearsals</strong>
                      <small>
                        Linea Classic S &amp; Eagle One group head calibration
                      </small>
                    </div>
                    <span
                      className="production-menu-chevron"
                      aria-hidden="true"
                    >
                      ›
                    </span>
                  </button>
                </div>
              </section>

              <CompleteRecipeTaskCatalog
                openCatalogSection={props.openCatalogSection}
              />

              <section className="production-catalog-group">
                <header className="production-catalog-group-header">
                  <span className="production-tier-badge" data-tier="loop">
                    Tier 3 · Autonomous Loop
                  </span>
                  <h4>Multi-task factory loops &amp; shifts</h4>
                  <p>
                    Compositions of tasks that loop to test autonomous
                    throughput.
                  </p>
                </header>
                <div className="production-menu-list">
                  <button
                    type="button"
                    className="production-menu-item production-catalog-card"
                    onClick={props.onSubviewChange.bind(null, "steps")}
                  >
                    <div className="production-catalog-card-body">
                      <strong>
                        Financier morning · Full Plan 61A 3D workflow
                      </strong>
                      <small>
                        Ohaus scale, Maruzen brown butter, Hobart HL200 mix,
                        Matsunaga 8P bake, sink mould wash &amp; vitrine refill
                      </small>
                    </div>
                    <span
                      className="production-menu-chevron"
                      aria-hidden="true"
                    >
                      ›
                    </span>
                  </button>
                  <button
                    type="button"
                    className="production-menu-item production-catalog-card"
                    onClick={props.openCatalogSection.bind(
                      null,
                      "active-production",
                    )}
                  >
                    <div className="production-catalog-card-body">
                      <strong>
                        Multi-batch production + Robot (Batch A → Batch B →
                        Batch C)
                      </strong>
                      <small>
                        3-batch autonomous pipeline · 12 process steps &amp;
                        robot tray handoffs
                      </small>
                    </div>
                    <span
                      className="production-menu-chevron"
                      aria-hidden="true"
                    >
                      ›
                    </span>
                  </button>
                  <button
                    type="button"
                    className="production-menu-item production-catalog-card"
                    onClick={props.openCatalogSection.bind(null, "cafe-shift")}
                  >
                    <div className="production-catalog-card-body">
                      <strong>
                        Combined Café Shift · Financiers &amp; Espresso (Plan
                        61E)
                      </strong>
                      <small>
                        Baker FR10 #1 + Barista FR10 #2 · Matsunaga 8P loads
                        &amp; Linea / Eagle One service
                      </small>
                    </div>
                    <span
                      className="production-menu-chevron"
                      aria-hidden="true"
                    >
                      ›
                    </span>
                  </button>
                  {props.connection.kind === "workspace" && (
                    <button
                      type="button"
                      className="production-menu-item production-catalog-card"
                      onClick={props.openCatalogSection.bind(
                        null,
                        "shared-runs",
                      )}
                    >
                      <div className="production-catalog-card-body">
                        <strong>Shared production runs</strong>
                        <small>
                          Open or compare saved workspace factory recordings
                        </small>
                      </div>
                      <span
                        className="production-menu-chevron"
                        aria-hidden="true"
                      >
                        ›
                      </span>
                    </button>
                  )}
                </div>
              </section>
            </div>
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
              <span className="production-tier-badge">
                Financier morning · Batch {workflowBatch(props.state)}
              </span>
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
            <VitrineStockSummary {...props} />
            <details className="workflow-plan61a-summary">
              <summary>
                Plan 61A recipe mass &amp; mould balance (
                {PLAN_61A_MASS_BALANCE.inputGrams} g batch)
              </summary>
              <dl className="workflow-plan61a-dl">
                <dt>Dry + wet input</dt>
                <dd>
                  {PLAN_61A_MASS_BALANCE.inputGrams} g weighed on Ohaus scale
                </dd>
                <dt>Beurre noisette</dt>
                <dd>
                  {PLAN_61A_MASS_BALANCE.brownButterInputGrams} g →{" "}
                  {PLAN_61A_MASS_BALANCE.brownButterOutputGrams} g (−
                  {PLAN_61A_MASS_BALANCE.brownButterEvaporationGrams} g steam)
                </dd>
                <dt>Hobart HL200 batter</dt>
                <dd>
                  {PLAN_61A_MASS_BALANCE.transferableBatterGrams} g net (−
                  {PLAN_61A_MASS_BALANCE.bowlResidueGrams} g bowl residue)
                </dd>
                <dt>Matsunaga 8P moulds</dt>
                <dd>
                  {PLAN_61A_MASS_BALANCE.mouldCount} × 8 cavities ={" "}
                  {PLAN_61A_MASS_BALANCE.trayDepositedGrams} g (
                  {PLAN_61A_MASS_BALANCE.retainedBatterGrams} g retained)
                </dd>
                <dt>Baked &amp; demoulded</dt>
                <dd>
                  {PLAN_61A_MASS_BALANCE.bakedPiecesGrams} g (−
                  {PLAN_61A_MASS_BALANCE.bakeEvaporationGrams} g bake loss) · 3
                  moulds washed at sink
                </dd>
                <dt>QA &amp; ballotin pack</dt>
                <dd>
                  {PLAN_61A_MASS_BALANCE.acceptedPackedGrams} g packed (
                  {PLAN_61A_MASS_BALANCE.acceptedPieceCount} pcs) ·{" "}
                  {PLAN_61A_MASS_BALANCE.sampledPieceGrams} g QA sample ·{" "}
                  {PLAN_61A_MASS_BALANCE.rejectedPiecesGrams} g rejected
                </dd>
              </dl>
            </details>
          </div>
        </div>
      </div>
    </section>
  );
}

export function InputsDock(props: InputsProps): React.ReactNode {
  const [jsonPanelOpen, setJsonPanelOpen] = React.useState(false);
  const [jsonDraft, setJsonDraft] = React.useState("");
  const [jsonNotice, setJsonNotice] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
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
      <div className="workflow-presets" aria-label="Try a preset">
        <button onClick={props.actions.chooseDemo.bind(null, "morning")}>
          Normal morning
        </button>
        <button onClick={props.actions.chooseDemo.bind(null, "one-worker")}>
          One worker
        </button>
        <button onClick={props.actions.chooseDemo.bind(null, "breakdown")}>
          Oven breakdown
        </button>
      </div>
      <div className="workflow-presets" aria-label="Customer demand preset">
        {VITRINE_RUSH_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={activeRush === preset.id}
            title={`${preset.description} · Recommended: ${preset.recommendedBatchCount} batches`}
            onClick={setActiveVitrineRushPreset.bind(null, preset.id)}
          >
            {preset.shortLabel} ({preset.orderCount})
          </button>
        ))}
        <button
          type="button"
          aria-pressed={autoScaleBatches}
          title="Automatically scale batches, workers, and oven trays when switching customer rush presets"
          onClick={() => setAutoScaleVitrineBatches(!autoScaleBatches)}
        >
          Auto-scale batches
        </button>
        {hasCapacityDeficit && (
          <button
            type="button"
            title={vitrine.capacityRecommendationLabel}
            onClick={applyRecommendedVitrineCapacity}
          >
            Apply recommended ({vitrine.recommendedBatchCount}B ·{" "}
            {vitrine.recommendedWorkerCount}W · {vitrine.recommendedOvenTrays}T)
          </button>
        )}
      </div>
      <details
        className="workflow-plan61a-summary"
        aria-label="Custom order arrivals"
      >
        <summary>
          Custom order arrivals ({vitrine.orders.length} orders
          {vitrine.hasCustomArrivals
            ? ` · ${vitrine.customArrivalCount} edited`
            : ""}
          )
        </summary>
        <div
          className="workflow-presets"
          aria-label="Inputs order arrival controls"
        >
          <button
            type="button"
            title="Add a custom customer order arrival to this shift"
            onClick={() => addCustomVitrineOrder()}
          >
            + Add order
          </button>
          <button
            type="button"
            title="Move all customer order arrivals 5 minutes earlier"
            onClick={() => shiftAllVitrineOrderArrivals(-5)}
          >
            Shift -5m
          </button>
          <button
            type="button"
            title="Move all customer order arrivals 5 minutes later"
            onClick={() => shiftAllVitrineOrderArrivals(5)}
          >
            Shift +5m
          </button>
          <button
            type="button"
            disabled={!vitrine.hasCustomArrivals}
            title="Restore default customer order arrival times for this preset"
            onClick={() => resetCustomVitrineOrders()}
          >
            Reset arrivals
          </button>
          <button
            type="button"
            title="Export custom customer order schedule to JSON"
            onClick={() => {
              const exported = exportCustomVitrineOrdersJson(
                vitrine.rushPreset,
              );
              setJsonDraft(exported);
              setJsonPanelOpen(true);
              setJsonNotice(
                `Exported ${vitrine.orders.length} orders (${vitrine.rushPreset}) to JSON.`,
              );
            }}
          >
            Export JSON
          </button>
          <button
            type="button"
            aria-expanded={jsonPanelOpen}
            title="Import custom customer order schedule from JSON"
            onClick={() => {
              if (!jsonPanelOpen && jsonDraft.trim().length === 0) {
                setJsonDraft(exportCustomVitrineOrdersJson(vitrine.rushPreset));
              }
              setJsonPanelOpen(!jsonPanelOpen);
              setJsonNotice(null);
            }}
          >
            Import JSON
          </button>
          <button
            type="button"
            aria-label="Inputs download customer order schedule JSON"
            title="Download customer order schedule as a .json file"
            onClick={() => {
              const exported = exportCustomVitrineOrdersJson(
                vitrine.rushPreset,
              );
              setJsonDraft(exported);
              downloadBakeryFile(
                `vitrine-orders-${vitrine.rushPreset}.json`,
                exported,
              );
              setJsonNotice(
                `Downloaded vitrine-orders-${vitrine.rushPreset}.json (${vitrine.orders.length} orders).`,
              );
            }}
          >
            Download .json
          </button>
          <button
            type="button"
            aria-label="Inputs upload customer order schedule JSON button"
            title="Upload customer order schedule from a .json file"
            onClick={() => fileInputRef.current?.click()}
          >
            Upload .json
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            aria-label="Inputs upload customer order schedule JSON"
            hidden
            onChange={async (e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (!file) return;
              const text = await file.text();
              setJsonDraft(text);
              setJsonPanelOpen(true);
              const res = importCustomVitrineOrdersJson(text);
              if (res.ok) {
                setJsonDraft(exportCustomVitrineOrdersJson(res.preset));
                setJsonNotice(
                  `Uploaded ${file.name}: ${res.orderCount} orders (${res.customCount} custom) for ${res.preset}.`,
                );
              } else {
                setJsonNotice(res.error);
              }
            }}
          />
        </div>
        {jsonPanelOpen && (
          <div
            className="workflow-plan61a-summary"
            aria-label="Inputs customer order schedule JSON panel"
          >
            <textarea
              aria-label="Inputs customer order schedule JSON"
              rows={5}
              value={jsonDraft}
              style={{
                width: "100%",
                fontFamily: "var(--font-mono, monospace)",
                fontSize: "11px",
              }}
              onChange={(e) => setJsonDraft(e.currentTarget.value)}
            />
            <div className="workflow-presets" style={{ marginTop: "0.35rem" }}>
              <button
                type="button"
                onClick={() => {
                  const res = importCustomVitrineOrdersJson(jsonDraft);
                  if (res.ok) {
                    setJsonDraft(exportCustomVitrineOrdersJson(res.preset));
                    setJsonNotice(
                      `Imported ${res.orderCount} orders (${res.customCount} custom) for ${res.preset}.`,
                    );
                  } else {
                    setJsonNotice(res.error);
                  }
                }}
              >
                Apply JSON
              </button>
              <button
                type="button"
                onClick={() => {
                  setJsonPanelOpen(false);
                  setJsonNotice(null);
                }}
              >
                Close JSON
              </button>
            </div>
            {jsonNotice !== null && (
              <p role="status" style={{ marginTop: "0.35rem" }}>
                {jsonNotice}
              </p>
            )}
          </div>
        )}
        <dl className="workflow-plan61a-dl">
          {vitrine.orders.map((ord) => (
            <React.Fragment key={ord.id}>
              <dt title={ord.label}>
                {ord.id} · {ord.channelLabel}
              </dt>
              <dd>
                <span>{clock(ord.orderedAt)}</span>{" "}
                <button
                  type="button"
                  aria-label={`Earlier arrival for ${ord.id}`}
                  onClick={() => nudgeVitrineOrderArrivalMinutes(ord.id, -5)}
                >
                  −5m
                </button>{" "}
                <input
                  type="number"
                  aria-label={`Input arrival minute for ${ord.id}`}
                  min={1}
                  max={180}
                  step={1}
                  value={ord.orderedAtMinutes}
                  style={{ width: "3.6rem" }}
                  onChange={(e) => {
                    const val = Number(e.currentTarget.value);
                    if (Number.isFinite(val) && val >= 1) {
                      setVitrineOrderArrivalMinutes(ord.id, val);
                    }
                  }}
                />
                <small>m</small>{" "}
                <button
                  type="button"
                  aria-label={`Later arrival for ${ord.id}`}
                  onClick={() => nudgeVitrineOrderArrivalMinutes(ord.id, 5)}
                >
                  +5m
                </button>{" "}
                <input
                  type="number"
                  aria-label={`Input ballotin boxes for ${ord.id}`}
                  min={0}
                  max={8}
                  step={1}
                  value={ord.ballotinBoxes}
                  style={{ width: "3rem" }}
                  onChange={(e) => {
                    const val = Number(e.currentTarget.value);
                    if (Number.isFinite(val) && val >= 0) {
                      setVitrineOrderItems(ord.id, { ballotinBoxes: val });
                    }
                  }}
                />
                <small>box</small>{" "}
                <input
                  type="number"
                  aria-label={`Input loose pieces for ${ord.id}`}
                  min={0}
                  max={24}
                  step={1}
                  value={ord.loosePieces}
                  style={{ width: "3.2rem" }}
                  onChange={(e) => {
                    const val = Number(e.currentTarget.value);
                    if (Number.isFinite(val) && val >= 0) {
                      setVitrineOrderItems(ord.id, { loosePieces: val });
                    }
                  }}
                />
                <small>pcs</small>{" "}
                <Select.Root
                  items={CHANNEL_ITEMS}
                  value={ord.channel}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setVitrineOrderItems(ord.id, {
                      channel: value as VitrineOrderChannel,
                    });
                  }}
                >
                  <Select.Trigger
                    aria-label={`Input channel for ${ord.id}`}
                    style={{ maxWidth: "7.8rem" }}
                  >
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Popup>
                    {CHANNEL_ITEMS.map((ch) => (
                      <Select.Item key={ch.value} value={ch.value}>
                        {ch.label}
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Root>{" "}
                <Select.Root
                  items={BEVERAGE_ITEMS}
                  value={ord.beverageRecipe}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setVitrineOrderItems(ord.id, {
                      beverageRecipe: value as CafeBeverageRecipeId,
                    });
                  }}
                >
                  <Select.Trigger
                    aria-label={`Input beverage recipe for ${ord.id}`}
                    style={{ maxWidth: "9.5rem" }}
                  >
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Popup>
                    {BEVERAGE_ITEMS.map((bev) => (
                      <Select.Item key={bev.value} value={bev.value}>
                        {bev.label}
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Root>
                {ord.isCustomOrder && (
                  <>
                    {" "}
                    <button
                      type="button"
                      aria-label={`Input remove ${ord.id}`}
                      onClick={() => removeCustomVitrineOrder(ord.id)}
                    >
                      Remove
                    </button>
                  </>
                )}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      </details>
      <InputsForm {...props} />
    </section>
  );
}

function VitrineStockSummary(props: WorkflowProps): React.ReactNode {
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
    (w) => w.status === "completed",
  );
  return (
    <details className="workflow-plan61a-summary" open>
      <summary>
        Pastry vitrine stock &amp; refill waves ({vitrine.loosePieces} loose ·{" "}
        {vitrine.ballotinBoxes} ballotins)
      </summary>
      <dl className="workflow-plan61a-dl">
        <dt>Customer demand</dt>
        <dd>{vitrine.rushPresetLabel}</dd>
        <dt>Batch scaling</dt>
        <dd>
          {vitrine.scheduledBatchCount} / {vitrine.recommendedBatchCount}{" "}
          recommended batches (
          {vitrine.batchDeficit > 0
            ? `${vitrine.batchDeficit}-batch deficit · `
            : "Demand covered · "}
          {vitrine.autoScaleBatches ? "Auto-scale on" : "Auto-scale off"})
        </dd>
        <dt>Staff &amp; oven capacity</dt>
        <dd>{vitrine.capacityRecommendationLabel}</dd>
        <dt>Showcase status</dt>
        <dd>{vitrine.statusLabel}</dd>
        <dt>Loose display trays</dt>
        <dd>
          {vitrine.loosePieces} / {vitrine.looseCapacity} pcs (
          {vitrine.soldLoosePieces} sold, +{vitrine.restockedLoosePieces}{" "}
          restocked)
        </dd>
        <dt>Ballotin gift boxes</dt>
        <dd>
          {vitrine.ballotinBoxes} / {vitrine.ballotinCapacity} boxes (
          {vitrine.soldBallotinBoxes} sold, +{vitrine.restockedBallotinBoxes}{" "}
          restocked)
        </dd>
        <dt>Customer orders</dt>
        <dd>
          {vitrine.fulfilledOrders.length} fulfilled ·{" "}
          {vitrine.waitingOrders.length} waiting ·{" "}
          {vitrine.upcomingOrders.length} upcoming
        </dd>
        <dt>Café bar drinks (Plan 61E)</dt>
        <dd>{vitrine.barStatusLabel}</dd>
        <dt>Order arrival schedule</dt>
        <dd>{vitrine.customArrivalSummary}</dd>
        <dt>Refill waves</dt>
        <dd>
          {completedWaves.length} / {vitrine.refillWaves.length} waves delivered
          (+5 loose &amp; +2 ballotins per batch)
        </dd>
      </dl>
    </details>
  );
}

function InputsForm(props: InputsProps): React.ReactNode {
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
      <details>
        <summary>More settings</summary>
        <div className="workflow-fields">
          {fields.filter(isAdvancedField).map(renderField.bind(null, props))}
        </div>
      </details>
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
        {substeps.map((sub) => {
          const isCurrent = activeSubstep?.id === sub.id;
          return (
            <li
              key={sub.id}
              className="workflow-substep-item"
              data-active={isCurrent ? "true" : undefined}
              title={`${sub.label} — ${sub.massNote}`}
            >
              <span>{sub.shortLabel}</span>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

function assignmentLabel(
  run: Run,
  task: NonNullable<ReturnType<typeof operationTask>>,
): string {
  const zone = stationZoneLabel(task.station);
  if (task.attended) {
    const worker = humanResource(run, task.executor);
    return ` · ${worker.name} (${worker.shortRole}) · ${zone}`;
  }
  return ` · No worker needed · ${zone}`;
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

function workflowBatch(state: WorkflowStepContext["state"]): string {
  const run = scheduleForVariant(state.shift, state.variant);
  const batch =
    selectionContext(run, state.selection, state.time).batch ?? run.batches[0];
  if (batch === undefined) throw new Error("the schedule has no batches");
  return batch.id;
}

function normalSchedule(shift: SimulatorShift): Run {
  return shift.kind === "sample" ? shift.normal : shift.normal.schedule;
}

function scheduleForVariant(
  shift: SimulatorShift,
  variant: "normal" | "outage",
): Run {
  if (variant === "normal") {
    return normalSchedule(shift);
  }
  return shift.kind === "sample" ? shift.outage : shift.outage.schedule;
}
