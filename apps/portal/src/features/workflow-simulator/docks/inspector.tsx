import React from "react";
import { Select } from "@purin-labs/ui/select";

import { batchTimeline, duration, machineSummary } from "@purin-labs/production-simulation/simulator/demo";
import { finishLabel } from "../results";
import {
  CAFE_BEVERAGE_ROTATION,
  VITRINE_ORDER_CHANNELS,
  VITRINE_RUSH_PRESETS,
  addCustomVitrineOrder,
  applyRecommendedVitrineCapacity,
  batchAt,
  clock,
  describe,
  distance,
  exportCustomVitrineOrdersJson,
  exportVitrineShiftServiceCsv,
  exportVitrineShiftServiceJson,
  getActiveVitrineChannelFilter,
  getActiveVitrineRushPreset,
  getAutoScaleVitrineBatches,
  getSnapVitrineOrdersToWaves,
  getVitrineDemandRevision,
  humanResource,
  importCustomVitrineOrdersJson,
  machineAt,
  outageAt,
  plan61ASubstepAt,
  removeCustomVitrineOrder,
  resetCustomVitrineOrders,
  setActiveVitrineChannelFilter,
  setActiveVitrineRushPreset,
  setAutoScaleVitrineBatches,
  setSnapVitrineOrdersToWaves,
  setVitrineOrderArrivalMinutes,
  setVitrineOrderItems,
  shiftAllVitrineOrderArrivals,
  station,
  stationLabel,
  stationZoneLabel,
  stations,
  subscribeVitrineRushPreset,
  summarizeVitrineShiftService,
  taskAt,
  transferZoneHandoff,
  vitrineStockAt,
  workerTasks,
  type Batch,
  type CafeBeverageRecipeId,
  type Interval,
  type OvenCycle,
  type Run,
  type Station,
  type BakeryTask,
  type HumanResource,
  type VitrineCustomerOrder,
  type VitrineOrderChannel,
  type VitrineRefillWave,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { getLiveStationWalkLegs } from "../bakery-appliance-layout";
import { downloadBakeryFile } from "../file-download";
import { selectionContext } from "@purin-labs/production-simulation/simulator/selection";
import type { WorkflowSimulatorActions } from "../simulator-actions";
import type { InspectorView, SimulatorConnection } from "../simulator-state";
import { DockHeader, SegmentedControl, taskStatusLabel } from "./shared";

type InspectorState = Pick<
  InspectorView,
  "selection" | "time" | "shift" | "variant"
>;

type InspectorActions = Pick<
  WorkflowSimulatorActions,
  "closeDock" | "select" | "observeOperation" | "goTo" | "inspectInterval"
>;

type Props = Readonly<{
  connection: SimulatorConnection;
  run: Run;
  open: boolean;
  state: InspectorState;
  actions: InspectorActions;
  /** The floor plan renders its selection and fit details into this. */
  layoutDetails: React.RefObject<HTMLDivElement | null>;
  openInputs: () => void;
}>;

const CHANNEL_ITEMS = VITRINE_ORDER_CHANNELS.map((ch) => ({
  value: ch.id,
  label: ch.label,
}));
const BEVERAGE_ITEMS = CAFE_BEVERAGE_ROTATION.map((bev) => ({
  value: bev.recipe,
  label: bev.shortName,
}));

export function InspectorDock(props: Props): React.ReactNode {
  React.useSyncExternalStore(
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
  const kind = props.state.selection.kind;
  const activeTab =
    kind === "resource"
      ? "workers"
      : kind === "station"
        ? "equipment"
        : "batches";
  const firstBatch = props.run.batches[0]?.id ?? "A";
  const firstWorker = props.run.resources[0]?.id ?? "human-1";
  const firstStation = stations[0]?.id ?? "stage";

  return (
    <section
      id="workflow-dock-inspector"
      className="workflow-dock workflow-dock-right workflow-inspector"
      hidden={!props.open}
      aria-label="Selection inspector"
    >
      <DockHeader
        label="Details"
        id="workflow-heading-Inspector"
        closeLabel="Close Inspector"
        onClose={props.actions.closeDock}
      />
      <SegmentedControl
        ariaLabel="Details category"
        value={activeTab}
        options={[
          {
            value: "inputs",
            label: "Inputs",
            onSelect: props.openInputs,
          },
          {
            value: "batches",
            label: "Batches",
            onSelect: props.actions.select.bind(null, {
              kind: "batch",
              id: firstBatch,
            }),
          },
          {
            value: "workers",
            label: "Workers",
            onSelect: props.actions.select.bind(null, {
              kind: "resource",
              id: firstWorker,
            }),
          },
          {
            value: "equipment",
            label: "Equipment",
            onSelect: props.actions.select.bind(null, {
              kind: "station",
              id: firstStation,
            }),
          },
        ]}
      />
      {activeTab === "batches" && (
        <div className="workflow-batches workflow-entity-chips">
          {props.run.batches.map(renderBatchButton.bind(null, props))}
        </div>
      )}
      {activeTab === "workers" && (
        <div className="workflow-batches workflow-entity-chips">
          {props.run.resources.map(renderWorker.bind(null, props))}
        </div>
      )}
      {activeTab === "equipment" && (
        <div className="workflow-batches workflow-entity-chips">
          {stations.map(renderStation.bind(null, props))}
        </div>
      )}
      <Inspection {...props} />
      {props.state.selection.kind === "station" &&
      props.state.selection.id === "bake" ? (
        <OvenDetails {...props} />
      ) : null}
      {props.state.selection.kind === "station" &&
      props.state.selection.id === "pack" ? (
        <VitrineDetails {...props} />
      ) : null}
      <div
        className="workflow-layout-details"
        hidden={activeTab !== "equipment"}
        ref={props.layoutDetails}
      />
    </section>
  );
}

function OvenDetails(props: Props): React.ReactNode {
  const run = props.run;
  return (
    <>
      {outageAt(run, props.state.time) && (
        <p className="workflow-notice">
          Oven unavailable for new work. Existing bake continues.
        </p>
      )}
      <section className="portal-band" aria-label="Shared oven cycles">
        <h3>Shared oven cycles ({run.cycles.length})</h3>
        {run.cycles.length === 0 ? (
          <p>No bake cycle started within this shift.</p>
        ) : (
          <div className="workflow-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">Cycle</th>
                  <th scope="col">Batches</th>
                  <th scope="col">Trays</th>
                  <th scope="col">Start</th>
                  <th scope="col">Bake ends</th>
                </tr>
              </thead>
              <tbody>{run.cycles.map(renderCycle.bind(null, props))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function VitrineDetails(props: Props): React.ReactNode {
  const [jsonPanelOpen, setJsonPanelOpen] = React.useState(false);
  const [jsonDraft, setJsonDraft] = React.useState("");
  const [jsonNotice, setJsonNotice] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const channelFilter = getActiveVitrineChannelFilter();
  const snapToWaves = getSnapVitrineOrdersToWaves();
  const stock = vitrineStockAt(props.run, props.state.time);
  const visibleOrders =
    channelFilter === "all"
      ? stock.orders
      : stock.orders.filter((o) => o.channel === channelFilter);
  const shiftServiceReport = summarizeVitrineShiftService(
    props.run,
    props.state.time,
    stock.rushPreset,
  );
  const hasCapacityDeficit =
    stock.batchDeficit > 0 ||
    stock.workerDeficit > 0 ||
    stock.ovenTrayDeficit > 0;
  return (
    <>
      <div className="workflow-presets" aria-label="Customer demand preset">
        {VITRINE_RUSH_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={stock.rushPreset === preset.id}
            title={`${preset.description} · Recommended: ${preset.recommendedBatchCount} batches · ${preset.recommendedWorkerCount} workers · ${preset.recommendedOvenTrays} oven trays`}
            onClick={setActiveVitrineRushPreset.bind(null, preset.id)}
          >
            {preset.shortLabel} ({preset.orderCount})
          </button>
        ))}
        <button
          type="button"
          aria-pressed={stock.autoScaleBatches}
          title="Automatically scale batches, workers, and oven trays when switching customer rush presets"
          onClick={() => setAutoScaleVitrineBatches(!stock.autoScaleBatches)}
        >
          Auto-scale batches
        </button>
        {hasCapacityDeficit && (
          <button
            type="button"
            title={stock.capacityRecommendationLabel}
            onClick={applyRecommendedVitrineCapacity}
          >
            Apply recommended ({stock.recommendedBatchCount}B ·{" "}
            {stock.recommendedWorkerCount}W · {stock.recommendedOvenTrays}T)
          </button>
        )}
      </div>
      {stock.waitingOrders.length > 0 && (
        <p className="workflow-notice">
          {stock.statusLabel}
        </p>
      )}
      <section
        className="portal-band"
        aria-label="Shift customer and bar report"
      >
        <h3>
          Shift customer &amp; bar report ({shiftServiceReport.fulfillmentRatePercent}%
          fulfilled)
        </h3>
        <dl className="workflow-plan61a-dl">
          <dt>Fulfillment rate</dt>
          <dd>
            {shiftServiceReport.fulfillmentRatePercent}% (
            {shiftServiceReport.fulfilledOrders}/{shiftServiceReport.totalOrders}{" "}
            orders · {shiftServiceReport.waitingOrders} waiting)
          </dd>
          <dt>Vitrine stockout wait</dt>
          <dd>
            {shiftServiceReport.stockoutOrderCount} delayed · mean{" "}
            {shiftServiceReport.meanStockoutWaitSeconds}s · max{" "}
            {shiftServiceReport.maxStockoutWaitSeconds}s
          </dd>
          <dt>Café bar service</dt>
          <dd>
            {shiftServiceReport.servedBeverageCups}/
            {shiftServiceReport.totalBeverageCups} cups · mean wait{" "}
            {shiftServiceReport.meanBeverageWaitSeconds}s · peak wait{" "}
            {shiftServiceReport.maxBeverageWaitSeconds}s
          </dd>
        </dl>
        <div
          className="workflow-presets"
          aria-label="Shift customer report exports"
        >
          <button
            type="button"
            aria-label="Download shift customer report JSON"
            title="Download customer order and beverage service shift report as JSON"
            onClick={() => {
              const payload = exportVitrineShiftServiceJson(
                props.run,
                props.state.time,
                stock.rushPreset,
              );
              downloadBakeryFile(
                `shift-customer-report-${stock.rushPreset}.json`,
                payload,
              );
              setJsonNotice(
                `Downloaded shift-customer-report-${stock.rushPreset}.json (${shiftServiceReport.fulfillmentRatePercent}% fulfilled).`,
              );
            }}
          >
            Report JSON
          </button>
          <button
            type="button"
            aria-label="Download shift customer report CSV"
            title="Download customer order and beverage service shift report as CSV"
            onClick={() => {
              const csv = exportVitrineShiftServiceCsv(
                props.run,
                props.state.time,
                stock.rushPreset,
              );
              downloadBakeryFile(
                `shift-customer-report-${stock.rushPreset}.csv`,
                csv,
                "text/csv;charset=utf-8",
              );
              setJsonNotice(
                `Downloaded shift-customer-report-${stock.rushPreset}.csv (${shiftServiceReport.totalOrders} orders).`,
              );
            }}
          >
            Report CSV
          </button>
        </div>
      </section>
      <section className="portal-band" aria-label="Vitrine refill waves">
        <h3>
          Vitrine refill waves ({stock.refillWaves.length})
        </h3>
        <div className="workflow-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Wave</th>
                <th scope="col">Batch</th>
                <th scope="col">Yield</th>
                <th scope="col">Refill start</th>
                <th scope="col">Stocked</th>
              </tr>
            </thead>
            <tbody>
              {stock.refillWaves.map(renderRefillWaveRow.bind(null, props))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="portal-band" aria-label="Customer vitrine orders">
        <h3>
          Customer orders ({stock.fulfilledOrders.length}/
          {stock.orders.length} fulfilled
          {stock.hasCustomArrivals
            ? ` · ${stock.customArrivalCount} custom`
            : ""}
          )
        </h3>
        <div
          className="workflow-presets"
          aria-label="Customer order arrival controls"
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
            disabled={!stock.hasCustomArrivals}
            title="Restore default customer order arrival times for this preset"
            onClick={() => resetCustomVitrineOrders()}
          >
            Reset arrivals
          </button>
          <button
            type="button"
            aria-pressed={snapToWaves}
            aria-label="Snap dragged order markers to refill waves"
            title="Snap dragged timeline order markers to the nearest refill wave completion (or hold Alt while dragging)"
            onClick={() => setSnapVitrineOrdersToWaves(!snapToWaves)}
          >
            Snap to waves
          </button>
          <button
            type="button"
            title="Export custom customer order schedule to JSON"
            onClick={() => {
              const exported = exportCustomVitrineOrdersJson(stock.rushPreset);
              setJsonDraft(exported);
              setJsonPanelOpen(true);
              setJsonNotice(
                `Exported ${stock.orders.length} orders (${stock.rushPreset}) to JSON.`,
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
                setJsonDraft(exportCustomVitrineOrdersJson(stock.rushPreset));
              }
              setJsonPanelOpen(!jsonPanelOpen);
              setJsonNotice(null);
            }}
          >
            Import JSON
          </button>
          <button
            type="button"
            aria-label="Download customer order schedule JSON"
            title="Download customer order schedule as a .json file"
            onClick={() => {
              const exported = exportCustomVitrineOrdersJson(stock.rushPreset);
              setJsonDraft(exported);
              downloadBakeryFile(
                `vitrine-orders-${stock.rushPreset}.json`,
                exported,
              );
              setJsonNotice(
                `Downloaded vitrine-orders-${stock.rushPreset}.json (${stock.orders.length} orders).`,
              );
            }}
          >
            Download .json
          </button>
          <button
            type="button"
            aria-label="Upload customer order schedule JSON button"
            title="Upload customer order schedule from a .json file"
            onClick={() => fileInputRef.current?.click()}
          >
            Upload .json
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            aria-label="Upload customer order schedule JSON"
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
          {stock.orders
            .filter((o) => o.isCustomOrder)
            .map((o) => (
              <button
                key={`remove-${o.id}`}
                type="button"
                aria-label={`Remove ${o.id}`}
                title={`Remove custom order ${o.id}`}
                onClick={() => removeCustomVitrineOrder(o.id)}
              >
                Remove {o.id}
              </button>
            ))}
        </div>
        {jsonPanelOpen && (
          <div
            className="workflow-plan61a-summary"
            aria-label="Customer order schedule JSON panel"
          >
            <label htmlFor="vitrine-order-schedule-json">
              Customer order schedule JSON
            </label>
            <textarea
              id="vitrine-order-schedule-json"
              aria-label="Customer order schedule JSON"
              rows={6}
              value={jsonDraft}
              style={{
                width: "100%",
                fontFamily: "var(--font-mono, monospace)",
                fontSize: "11px",
                marginTop: "0.35rem",
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
        <div
          className="workflow-presets"
          aria-label="Filter customer orders by channel"
        >
          <button
            type="button"
            data-channel-filter="all"
            aria-pressed={channelFilter === "all"}
            onClick={() => setActiveVitrineChannelFilter("all")}
          >
            All ({stock.orders.length})
          </button>
          {VITRINE_ORDER_CHANNELS.map((ch) => {
            const count = stock.orders.filter(
              (o) => o.channel === ch.id,
            ).length;
            return (
              <button
                key={ch.id}
                type="button"
                data-channel-filter={ch.id}
                aria-pressed={channelFilter === ch.id}
                onClick={() =>
                  setActiveVitrineChannelFilter(
                    channelFilter === ch.id ? "all" : ch.id,
                  )
                }
              >
                {ch.label} ({count})
              </button>
            );
          })}
        </div>
        <div className="workflow-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Channel</th>
                <th scope="col">Items</th>
                <th scope="col">Beverage (61B–E)</th>
                <th scope="col">Time</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map(renderCustomerOrderRow.bind(null, props))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function renderRefillWaveRow(
  props: Props,
  wave: VitrineRefillWave,
): React.ReactNode {
  return (
    <tr key={wave.waveNumber}>
      <td>Wave {wave.waveNumber}</td>
      <td>
        <button
          type="button"
          className="workflow-step-jump"
          onClick={props.actions.select.bind(null, {
            kind: "batch",
            id: wave.batchId,
          })}
        >
          Batch {wave.batchId} ↗
        </button>
      </td>
      <td>
        +{wave.loosePiecesAdded} loose · +{wave.ballotinBoxesAdded} ballotin
      </td>
      <td>
        <button
          type="button"
          className="workflow-step-jump"
          onClick={props.actions.goTo.bind(null, wave.refillStart)}
        >
          {clock(wave.refillStart)}
        </button>
      </td>
      <td>
        <button
          type="button"
          className="workflow-step-jump"
          onClick={props.actions.goTo.bind(null, wave.completedAt)}
        >
          {clock(wave.completedAt)}
        </button>
      </td>
    </tr>
  );
}

function renderCustomerOrderRow(
  props: Props,
  ord: VitrineCustomerOrder,
): React.ReactNode {
  const itemSummary =
    ord.ballotinBoxes > 0 && ord.loosePieces > 0
      ? `${ord.ballotinBoxes} box + ${ord.loosePieces} loose`
      : ord.ballotinBoxes > 0
        ? `${ord.ballotinBoxes} ballotin box${ord.ballotinBoxes === 1 ? "" : "es"}`
        : `${ord.loosePieces} loose pcs`;
  const statusLabel =
    ord.status === "fulfilled"
      ? ord.fulfilledByWave !== null
        ? `Fulfilled (Wave ${ord.fulfilledByWave})`
        : "Fulfilled"
      : ord.status === "waiting-refill"
        ? "Waiting refill"
        : "Upcoming";
  const bevStatusLabel =
    ord.beverageStatus === "served"
      ? `Served (${ord.beverageWaitSeconds} s)`
      : ord.beverageStatus === "brewing"
        ? "Brewing"
        : ord.beverageStatus === "queued-bar"
          ? "Queued at bar"
          : "Upcoming";
  return (
    <tr key={ord.id}>
      <td title={ord.label}>{ord.id}</td>
      <td>
        <div>{ord.channelLabel}</div>
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
            aria-label={`Channel for ${ord.id}`}
            title={`Select order channel for ${ord.id}`}
            style={{ marginTop: "0.2rem", maxWidth: "7.8rem" }}
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
        </Select.Root>
      </td>
      <td>
        <div>{itemSummary}</div>
        <div
          style={{
            display: "flex",
            gap: "0.25rem",
            alignItems: "center",
            marginTop: "0.2rem",
          }}
        >
          <input
            type="number"
            aria-label={`Ballotin boxes for ${ord.id}`}
            min={0}
            max={8}
            step={1}
            value={ord.ballotinBoxes}
            title={`Ballotin gift boxes (5 pcs) for ${ord.id}`}
            style={{ width: "3.1rem" }}
            onChange={(e) => {
              const val = Number(e.currentTarget.value);
              if (Number.isFinite(val) && val >= 0) {
                setVitrineOrderItems(ord.id, { ballotinBoxes: val });
              }
            }}
          />
          <small>box</small>
          <input
            type="number"
            aria-label={`Loose pieces for ${ord.id}`}
            min={0}
            max={24}
            step={1}
            value={ord.loosePieces}
            title={`Loose financier pieces for ${ord.id}`}
            style={{ width: "3.3rem" }}
            onChange={(e) => {
              const val = Number(e.currentTarget.value);
              if (Number.isFinite(val) && val >= 0) {
                setVitrineOrderItems(ord.id, { loosePieces: val });
              }
            }}
          />
          <small>pcs</small>
        </div>
      </td>
      <td title={ord.beverageEquipment}>
        <div>
          {ord.beverageLabel} · {bevStatusLabel}
        </div>
        <div
          style={{
            display: "flex",
            gap: "0.25rem",
            alignItems: "center",
            marginTop: "0.2rem",
          }}
        >
          <input
            type="number"
            aria-label={`Beverage cups for ${ord.id}`}
            min={1}
            max={6}
            step={1}
            value={ord.beverageCount}
            title={`Beverage cups for ${ord.id}`}
            style={{ width: "2.9rem" }}
            onChange={(e) => {
              const val = Number(e.currentTarget.value);
              if (Number.isFinite(val) && val >= 1) {
                setVitrineOrderItems(ord.id, { beverageCount: val });
              }
            }}
          />
          <small>×</small>
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
              aria-label={`Beverage recipe for ${ord.id}`}
              title={`Select Plan 61B–E beverage recipe for ${ord.id}`}
              style={{ maxWidth: "10.5rem" }}
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
        </div>
      </td>
      <td>
        <button
          type="button"
          className="workflow-step-jump"
          onClick={props.actions.goTo.bind(null, ord.orderedAt)}
        >
          {clock(ord.orderedAt)}
        </button>{" "}
        <input
          type="number"
          className="workflow-order-arrival-input"
          aria-label={`Arrival minute for ${ord.id}`}
          min={1}
          max={180}
          step={1}
          value={ord.orderedAtMinutes}
          title={`Arrival minute from 06:00 for ${ord.id} (default ${ord.defaultOrderedAtMinutes} min)`}
          style={{ width: "3.6rem", marginLeft: "0.25rem" }}
          onChange={(e) => {
            const val = Number(e.currentTarget.value);
            if (Number.isFinite(val) && val >= 1) {
              setVitrineOrderArrivalMinutes(ord.id, val);
            }
          }}
        />
        <small>m</small>
      </td>
      <td>{statusLabel}</td>
    </tr>
  );
}

function Inspection(props: Props): React.ReactNode {
  const selection = props.state.selection;
  const context = selectionContext(props.run, selection, props.state.time);
  if (selection.kind === "task") {
    return context.task === null ? null : (
      <TaskInspection {...props} task={context.task} />
    );
  }
  if (selection.kind === "resource") {
    if (context.resource === null) return null;
    const assigned = workerTasks(props.run, context.resource.id);
    const zoneHandoffTasks = assigned.filter(
      (t) =>
        t.kind === "transfer" &&
        transferZoneHandoff(t.from, t.station, props.run.resources.length)
          .isZoneBoundary,
    );
    return (
      <>
        <dl>
          <dt>Worker</dt>
          <dd>{context.resource.name}</dd>
          <dt>Staff role</dt>
          <dd>{context.resource.roleTitle}</dd>
          <dt>Assigned zone</dt>
          <dd>{context.resource.zoneLabel}</dd>
          <dt>Home station</dt>
          <dd>{stationLabel(context.resource.homeStation)}</dd>
          <dt>Zone handoffs</dt>
          <dd>
            {zoneHandoffTasks.length} cross-zone pass
            {zoneHandoffTasks.length === 1 ? "" : "es"}
          </dd>
          <dt>Status</dt>
          <dd>
            <span
              className="workflow-status-pill"
              data-tone={context.task === null ? "completed" : "running"}
            >
              {context.task === null ? "Available" : "Working"}
            </span>
          </dd>
          {context.task !== null && (
            <>
              <dt>Current step</dt>
              <dd>
                <button
                  type="button"
                  className="workflow-step-jump"
                  onClick={props.actions.inspectInterval.bind(
                    null,
                    context.task,
                  )}
                >
                  {describe(context.task)} ↗
                </button>
              </dd>
              <dt>Batch</dt>
              <dd>
                <button
                  type="button"
                  className="workflow-step-jump"
                  onClick={props.actions.select.bind(null, {
                    kind: "batch",
                    id: context.task.batch,
                  })}
                >
                  Batch {context.task.batch} ↗
                </button>
              </dd>
              <dt>Equipment</dt>
              <dd>
                {context.task.kind === "transfer"
                  ? `${stationLabel(context.task.from)} → ${stationLabel(context.task.station)}`
                  : stationLabel(context.task.station)}
              </dd>
              {context.task.kind === "transfer" && (
                <>
                  <dt>Zone handoff</dt>
                  <dd>
                    {
                      transferZoneHandoff(
                        context.task.from,
                        context.task.station,
                        props.run.resources.length,
                      ).summary
                    }
                  </dd>
                </>
              )}
              <dt>Window</dt>
              <dd>
                {clock(context.task.start)} → {clock(context.task.end)}
              </dd>
              {context.task.kind === "process" && (
                <>
                  <dt>Plan 61A phase</dt>
                  <dd>
                    {plan61ASubstepAt(context.task, props.state.time).label}
                  </dd>
                  <dt>Appliance / sink</dt>
                  <dd>
                    {plan61ASubstepAt(context.task, props.state.time).equipment}
                  </dd>
                </>
              )}
            </>
          )}
        </dl>
        <details>
          <summary>Assigned tasks ({assigned.length})</summary>
          <ol className="workflow-assigned-tasks">
            {assigned.map(renderAssignedTask.bind(null, props))}
          </ol>
        </details>
      </>
    );
  }
  if (selection.kind === "station") {
    const status = machineAt(props.run, selection.id, props.state.time);
    const liveStation = station(selection.id, props.run.layout);
    const walkLegs = getLiveStationWalkLegs().filter(
      (leg) => leg.from === selection.id || leg.to === selection.id,
    );
    const vitrine =
      selection.id === "pack"
        ? vitrineStockAt(props.run, props.state.time)
        : null;
    return (
      <dl>
        <dt>Station</dt>
        <dd>{liveStation.label}</dd>
        <dt>Kitchen zone</dt>
        <dd>{stationZoneLabel(selection.id)}</dd>
        <dt>Status</dt>
        <dd>{status.state}</dd>
        <dt>Activity</dt>
        <dd>{machineSummary(props.run, selection.id, props.state.time)}</dd>
        <dt>Batches here</dt>
        <dd>{status.occupants.join(", ") || "None"}</dd>
        <dt>Waiting</dt>
        <dd>{status.queue.join(", ") || "None"}</dd>
        {vitrine !== null && (
          <>
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
            <dt>Vitrine stock status</dt>
            <dd>{vitrine.statusLabel}</dd>
            <dt>Vitrine loose trays</dt>
            <dd>
              {vitrine.loosePieces} / {vitrine.looseCapacity} loose financiers (
              {vitrine.soldLoosePieces} sold, +{vitrine.restockedLoosePieces}{" "}
              restocked)
            </dd>
            <dt>Vitrine ballotin boxes</dt>
            <dd>
              {vitrine.ballotinBoxes} / {vitrine.ballotinCapacity} 5-pc boxes (
              {vitrine.soldBallotinBoxes} sold, +
              {vitrine.restockedBallotinBoxes} restocked)
            </dd>
            <dt>Café bar drinks (Plan 61E)</dt>
            <dd>{vitrine.barStatusLabel}</dd>
            <dt>Order arrival schedule</dt>
            <dd>{vitrine.customArrivalSummary}</dd>
          </>
        )}
        <dt>3D handoff (x, z)</dt>
        <dd>
          {liveStation.handoff[0].toFixed(2)} m,{" "}
          {liveStation.handoff[1].toFixed(2)} m
        </dd>
        {walkLegs.map((leg) => (
          <React.Fragment key={`${leg.from}-${leg.to}`}>
            <dt>
              3D walk ({stationLabel(leg.from)} → {stationLabel(leg.to)})
            </dt>
            <dd>
              {leg.distanceMeters.toFixed(2)} m · {leg.walkSeconds} s (
              {leg.handoffSummary})
            </dd>
          </React.Fragment>
        ))}
      </dl>
    );
  }

  const batch = props.run.batches.find(hasBatchId.bind(null, selection.id));
  if (!batch) {
    return null;
  }
  const current = batchAt(props.run, batch, props.state.time);
  const finish = batchFinishTime(props.run, batch.id);
  const isLate = finish !== null && finish > batch.deadline;
  const delayStatus =
    finish === null
      ? "Unfinished"
      : isLate
        ? `${duration(finish - batch.deadline)} late`
        : "On time";
  const waits = batchTimeline(props.run, batch.id).filter(isWaitInterval);
  const stepSnapshot =
    current.kind === "process" || current.kind === "transfer"
      ? taskAt(props.run, current, props.state.time)
      : null;

  return (
    <>
      <dl>
        <dt>Batch</dt>
        <dd>
          {batch.id} · {batch.quantity} financiers · {batch.trays} trays
        </dd>
        <dt>Current step</dt>
        <dd>
          {current.kind === "process" || current.kind === "transfer" ? (
            <button
              type="button"
              className="workflow-step-jump"
              onClick={props.actions.inspectInterval.bind(null, current)}
            >
              {describe(current)} ↗
            </button>
          ) : (
            describe(current)
          )}
        </dd>
        {stepSnapshot !== null ? (
          <>
            <dt>Status</dt>
            <dd>
              <span
                className="workflow-status-pill"
                data-tone={stepSnapshot.kind}
              >
                {taskStatusLabel(stepSnapshot.kind)}
              </span>
            </dd>
          </>
        ) : null}
        <dt>Due by</dt>
        <dd>{clock(batch.deadline)}</dd>
        <dt>Expected finish</dt>
        <dd className="workflow-finish-cell">
          <span>{finishLabel(props.run, batch.id)}</span>
          {finish !== null && (
            <span
              className="workflow-status-pill"
              data-tone={isLate ? "late" : "completed"}
            >
              {delayStatus}
            </span>
          )}
        </dd>
        {(current.kind === "process" || current.kind === "transfer") &&
        current.attended ? (
          <>
            <dt>Worker</dt>
            <dd>{humanResource(props.run, current.executor).name}</dd>
          </>
        ) : null}
        {current.kind === "process" && (
          <>
            <dt>Plan 61A phase</dt>
            <dd>{plan61ASubstepAt(current, props.state.time).label}</dd>
            <dt>Mass / mould detail</dt>
            <dd>{plan61ASubstepAt(current, props.state.time).massNote}</dd>
          </>
        )}
      </dl>
      {waits.length > 0 && (
        <section aria-label="Wait bottlenecks">
          <h3>Wait bottlenecks ({waits.length})</h3>
          <div className="workflow-wait-links">
            {waits.map(renderWaitButton.bind(null, props))}
          </div>
        </section>
      )}
    </>
  );
}

function TaskInspection(
  props: Props & Readonly<{ task: BakeryTask }>,
): React.ReactNode {
  const task = props.task;
  const status = taskAt(props.run, task, props.state.time);
  return (
    <dl>
      <dt>Task</dt>
      <dd>{describe(task)}</dd>
      <dt>Status</dt>
      <dd>
        <span className="workflow-status-pill" data-tone={status.kind}>
          {taskStatusLabel(status.kind)}
        </span>
      </dd>
      <dt>Batch</dt>
      <dd>
        <button
          type="button"
          className="workflow-step-jump"
          onClick={props.actions.select.bind(null, {
            kind: "batch",
            id: task.batch,
          })}
        >
          Batch {task.batch} ↗
        </button>
      </dd>
      <dt>Assignment</dt>
      <dd>
        {task.attended ? (
          <button
            type="button"
            className="workflow-step-jump"
            onClick={props.actions.select.bind(null, {
              kind: "resource",
              id: task.executor,
            })}
          >
            {humanResource(props.run, task.executor).name} ·{" "}
            {humanResource(props.run, task.executor).shortRole} ↗
          </button>
        ) : task.kind === "native" ? (
          "Robot arm and cell"
        ) : (
          "No worker needed"
        )}
      </dd>
      <dt>Equipment</dt>
      <dd>
        {task.kind === "transfer"
          ? `${stationLabel(task.from)} → ${stationLabel(task.station)}`
          : stationLabel(task.station)}
      </dd>
      {task.kind === "transfer" && (
        <>
          <dt>Zone handoff</dt>
          <dd>
            {
              transferZoneHandoff(
                task.from,
                task.station,
                props.run.resources.length,
              ).summary
            }
          </dd>
        </>
      )}
      {task.kind === "process" && (
        <>
          <dt>Kitchen zone</dt>
          <dd>{stationZoneLabel(task.station)}</dd>
          <dt>Plan 61A phase</dt>
          <dd>{plan61ASubstepAt(task, props.state.time).label}</dd>
          <dt>Mass / mould detail</dt>
          <dd>{plan61ASubstepAt(task, props.state.time).massNote}</dd>
          {task.operation === "pack" && (
            <>
              <dt>Vitrine refill wave</dt>
              <dd>
                Wave{" "}
                {vitrineStockAt(props.run, props.state.time).refillWaves.find(
                  (w) => w.batchId === task.batch,
                )?.waveNumber ?? 1}{" "}
                · +5 loose financiers &amp; +2 gold-ribbon ballotins (15 pcs)
              </dd>
            </>
          )}
        </>
      )}
      <dt>Starts</dt>
      <dd>
        <button
          type="button"
          className="workflow-step-jump"
          onClick={props.actions.goTo.bind(null, task.start)}
        >
          {clock(task.start)}
        </button>
      </dd>
      {task.kind === "process" && task.attended && (
        <>
          <dt>Approach walk</dt>
          <dd>
            {distance(task.emptyRoute).toFixed(2)} m (
            {Math.max(0, task.arrival - task.start)} s)
          </dd>
        </>
      )}
      {task.kind === "transfer" && (
        <>
          <dt>Pickup / handoff</dt>
          <dd>
            <button
              type="button"
              className="workflow-step-jump"
              onClick={props.actions.goTo.bind(null, task.pickup)}
            >
              {clock(task.pickup)}
            </button>
          </dd>
          <dt>3D walk distance</dt>
          <dd>
            {distance(task.route).toFixed(2)} m (
            {Math.max(0, task.loadedEnd - task.pickup)} s carry)
          </dd>
          <dt>Approach walk</dt>
          <dd>
            {distance(task.emptyRoute).toFixed(2)} m (
            {Math.max(0, task.pickupStart - task.start)} s)
          </dd>
        </>
      )}
      <dt>Planned finish</dt>
      <dd>
        {clock(task.end)}
        {task.end > props.run.end ? " (beyond shift)" : ""}
      </dd>
    </dl>
  );
}

function renderAssignedTask(props: Props, task: BakeryTask): React.ReactNode {
  return (
    <li key={task.id}>
      <button onClick={props.actions.inspectInterval.bind(null, task)}>
        Batch {task.batch}: {describe(task)} · {clock(task.start)}
      </button>
    </li>
  );
}

function renderWorker(props: Props, resource: HumanResource): React.ReactNode {
  const activeTask = selectionContext(
    props.run,
    { kind: "resource", id: resource.id },
    props.state.time,
  ).task;
  const tone = activeTask !== null ? "running" : "completed";
  return (
    <button
      key={resource.id}
      type="button"
      className="workflow-entity-chip"
      aria-pressed={
        props.state.selection.kind === "resource" &&
        props.state.selection.id === resource.id
      }
      onClick={props.actions.select.bind(null, {
        kind: "resource",
        id: resource.id,
      })}
    >
      <span className="workflow-chip-dot" data-tone={tone} aria-hidden="true" />
      {resource.name} · {resource.shortRole}
    </button>
  );
}

function renderBatchButton(props: Props, batch: Batch): React.ReactNode {
  const selectedId =
    props.state.selection.kind === "batch"
      ? props.state.selection.id
      : props.state.selection.kind === "task"
        ? selectionContext(props.run, props.state.selection, props.state.time)
            .batch?.id
        : null;
  const current = batchAt(props.run, batch, props.state.time);
  const tone =
    current.kind === "process" || current.kind === "transfer"
      ? "running"
      : current.kind === "wait"
        ? "late"
        : current.kind === "complete"
          ? "completed"
          : "idle";
  return (
    <button
      key={batch.id}
      type="button"
      className="workflow-entity-chip"
      aria-pressed={selectedId === batch.id}
      onClick={props.actions.select.bind(null, {
        kind: "batch",
        id: batch.id,
      })}
    >
      <span className="workflow-chip-dot" data-tone={tone} aria-hidden="true" />
      Batch {batch.id}
    </button>
  );
}

function renderCycle(props: Props, cycle: OvenCycle): React.ReactNode {
  return (
    <tr key={cycle.id}>
      <th scope="row">
        <button
          type="button"
          className="workflow-step-jump"
          onClick={props.actions.goTo.bind(null, cycle.start)}
        >
          Cycle {cycle.id}
        </button>
      </th>
      <td>{cycle.batches.join(", ")}</td>
      <td>
        {cycle.trays} / {props.run.settings.ovenTrays}
      </td>
      <td>{clock(cycle.start)}</td>
      <td>
        {clock(cycle.end)}
        {cycle.end > props.run.end ? " (beyond shift)" : ""}
      </td>
    </tr>
  );
}

function renderStation(props: Props, item: Station): React.ReactNode {
  const status = machineAt(props.run, item.id, props.state.time);
  const tone =
    item.id === "bake" && outageAt(props.run, props.state.time)
      ? "failed"
      : status.occupants.length > 0
        ? "running"
        : status.queue.length > 0
          ? "late"
          : "idle";
  return (
    <button
      key={item.id}
      type="button"
      className="workflow-entity-chip"
      aria-pressed={
        props.state.selection.kind === "station" &&
        props.state.selection.id === item.id
      }
      onClick={props.actions.select.bind(null, {
        kind: "station",
        id: item.id,
      })}
    >
      <span className="workflow-chip-dot" data-tone={tone} aria-hidden="true" />
      {item.label}
    </button>
  );
}

function renderWaitButton(props: Props, interval: Interval): React.ReactNode {
  const elapsed = Math.min(interval.end, props.run.end) - interval.start;
  return (
    <button
      key={interval.start}
      type="button"
      onClick={props.actions.inspectInterval.bind(null, interval)}
    >
      <span>{describe(interval)}</span>
      <small>
        {duration(elapsed)} wait · {clock(interval.start)}
      </small>
    </button>
  );
}

function isWaitInterval(interval: Interval): boolean {
  return interval.kind === "wait";
}

function batchFinishTime(run: Run, id: string): number | null {
  for (const item of run.completions) {
    if (item.batch === id) {
      return item.time;
    }
  }
  return null;
}

function hasBatchId(id: string, batch: Batch): boolean {
  return batch.id === id;
}
