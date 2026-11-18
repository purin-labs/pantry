import type React from "react";
import type {
  CompiledScenario,
  HostView,
  WaitInterval,
} from "@seams/production-simulation";
import { canonicalJson } from "@seams/std";
import { downloadBakeryFile } from "../workflow-simulator/file-download";

/** Compact, read-only results. Recording packs and host histories stay with the run. */
export type FactoryResult = Readonly<{
  orders: OrderMetrics;
  identity: string;
  group: string;
  bundle: string;
  arrivalSeconds: number;
  bufferSlots: number;
  holds: string;
  controlRevision: number;
  endSeconds: number;
  output: number;
  fullBufferSeconds: number;
  sourceBlockedSeconds: number;
  carrierWaitSeconds: number;
  bakerOccupiedSeconds: number;
}>;

type OrderMetrics =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "available";
      completed: number;
      meanLeadSeconds: number | null;
      maximumLeadSeconds: number | null;
      drainSeconds: number | null;
    }>;

function orderMetrics(view: HostView): OrderMetrics {
  if (view.production.kind === "unavailable") return { kind: "unavailable" };
  let count = 0;
  let total = 0;
  let maximum = 0;
  let lastArrival: number | null = null;
  for (const order of view.production.orders) {
    lastArrival =
      lastArrival === null
        ? order.arrivedAt
        : Math.max(lastArrival, order.arrivedAt);
    if (order.kind !== "completed") continue;
    count += 1;
    total += order.leadTime;
    maximum = Math.max(maximum, order.leadTime);
  }
  return {
    kind: "available",
    completed: count,
    meanLeadSeconds: count === 0 ? null : total / count / 1e6,
    maximumLeadSeconds: count === 0 ? null : maximum / 1e6,
    drainSeconds: lastArrival === null ? null : (view.time - lastArrival) / 1e6,
  };
}

/** Only completed fixed-route runs with complete accepted histories can enter a comparison. */
export function factoryResult(
  scenario: CompiledScenario,
  bundle: string,
  view: HostView,
): FactoryResult | null {
  if (
    scenario.id !== "plan-70-recurring-cold-cell" ||
    view.status.kind !== "completed"
  )
    return null;
  if (
    view.storageHistory.kind !== "available" ||
    view.resourceHistory.kind !== "available" ||
    view.schedulingHistory.kind !== "available"
  )
    return null;
  for (const history of [
    view.storageHistory,
    view.resourceHistory,
    view.schedulingHistory,
  ])
    if (history.after !== 0 || history.through !== view.time) return null;
  const arrival = scenario.arrivals[0];
  if (scenario.arrivals.length !== 1 || arrival?.kind !== "periodic")
    return null;
  let slots = 0;
  let full = 0;
  let baker: number | null = null;
  let output: number | null = null;
  for (const store of view.storageHistory.storages)
    if (store.storage === "intermediate-buffer") {
      slots = store.slots;
      full = store.fullSeconds;
    }
  for (const resource of view.resourceHistory.resources)
    if (resource.resource === "baker") baker = resource.occupiedUnitSeconds;
  for (const total of view.totals)
    if (total.destination === "completed-items" && total.unit === "each")
      output = total.amount;
  if (slots === 0 || baker === null || output === null) return null;
  // Only buffer capacity and planned availability may differ within a group.
  // Recipe, arrivals, equipment, limits, stock and retained engine must match.
  const { sources, storages, availability, workflows, ...common } = scenario;
  const group = canonicalJson({
    common,
    bundle,
    storages: storages.map(comparisonStorage),
    workflows: workflows.map(comparisonWorkflow),
  });
  return {
    orders: orderMetrics(view),
    identity: canonicalJson({
      bundle,
      scenario,
      controlRevision: view.controlRevision,
      events: view.events,
    }),
    group,
    bundle,
    arrivalSeconds: arrival.interval / 1e6,
    bufferSlots: slots,
    holds: availability.map(holdLabel).join(", ") || "None",
    controlRevision: view.controlRevision,
    endSeconds: view.time / 1e6,
    output,
    fullBufferSeconds: full,
    sourceBlockedSeconds: sumWaits(
      view.schedulingHistory.waits,
      "to-buffer",
      "destination",
      "intermediate-buffer",
    ),
    carrierWaitSeconds: sumWaits(
      view.schedulingHistory.waits,
      "admit",
      "carrier",
      "tray-store",
    ),
    bakerOccupiedSeconds: baker,
  };
}
function comparisonStorage(
  store: CompiledScenario["storages"][number],
): unknown {
  if (store.id === "intermediate-buffer")
    return { id: store.id, cell: store.cell, capacity: { kind: "carriers" } };
  return store;
}
function comparisonWorkflow(
  workflow: CompiledScenario["workflows"][number],
): unknown {
  return { id: workflow.id, demand: workflow.demand, tasks: workflow.tasks };
}
function holdLabel(hold: CompiledScenario["availability"][number]): string {
  return `${hold.resource} ${hold.interval.start / 1e6}–${hold.interval.end / 1e6} s`;
}
function sumWaits(
  waits: readonly WaitInterval[],
  key: string,
  kind: "destination" | "carrier",
  storage: string,
): number {
  let duration = 0;
  for (const wait of waits) {
    if (!wait.task.endsWith(`/${key}`)) continue;
    for (const blocker of wait.blockers)
      if (
        (kind === "destination" &&
          blocker.kind === "destination" &&
          blocker.storage === storage) ||
        (kind === "carrier" &&
          blocker.kind === "carrier" &&
          blocker.store === storage)
      ) {
        duration += wait.end - wait.start;
        break;
      }
  }
  return duration / 1e6;
}

type Props = Readonly<{
  results: readonly FactoryResult[];
  current: FactoryResult | null;
  capture(result: FactoryResult): void;
  clear(): void;
}>;
export function FactoryComparison(props: Props): React.ReactNode {
  const groups = new Map<string, FactoryResult[]>();
  for (const result of props.results) {
    const group = groups.get(result.group) ?? [];
    group.push(result);
    groups.set(result.group, group);
  }
  return (
    <section aria-label="Factory comparisons">
      <h3>Compare completed routes</h3>
      <p>
        Keep a completed result, then close this run and choose another case.
        Results remain while this workspace stays open. Export them before
        leaving.
      </p>
      <p>
        Each table uses the same arrivals, recipe, equipment, and engine.
        Compare buffer sizes with the same receiving hold. Overload cases have a
        separate table.
      </p>
      <button
        disabled={props.current === null}
        onClick={captureCurrent.bind(null, props)}
      >
        Keep completed result
      </button>
      <button
        disabled={props.results.length === 0}
        onClick={exportResults.bind(null, props.results)}
      >
        Export comparison results
      </button>
      <button disabled={props.results.length === 0} onClick={props.clear}>
        Clear comparison results
      </button>
      {Array.from(groups.values()).map(comparisonTable)}
      <p>
        Times cover the whole run. Wait totals use task-seconds and can overlap.
        Buffer-full time includes reserved slots. Output measures completed
        items; end time includes tray return.
      </p>
    </section>
  );
}
function captureCurrent(props: Props): void {
  if (props.current !== null) props.capture(props.current);
}
function exportResults(results: readonly FactoryResult[]): void {
  downloadBakeryFile(
    "factory-comparisons.json",
    JSON.stringify(results, null, 2),
  );
}
function comparisonTable(results: FactoryResult[]): React.ReactNode {
  const first = results[0];
  if (first === undefined) return null;
  return (
    <div
      key={first.group}
      className="oven-logistics-scroll"
      tabIndex={0}
      aria-label={`Comparison at ${first.arrivalSeconds} second arrivals`}
    >
      <table className="oven-workspace-cells">
        <caption>
          Arrivals every {first.arrivalSeconds} s · engine{" "}
          {first.bundle.slice(0, 12)}
        </caption>
        <thead>
          <tr>
            <th>Buffer slots</th>
            <th>Receiving hold</th>
            <th>Output (items)</th>
            <th>End (s)</th>
            <th>Mean lead (s)</th>
            <th>Maximum lead (s)</th>
            <th>Drain after last arrival (s)</th>
            <th>Buffer full (s)</th>
            <th>Source blocked (task-s)</th>
            <th>Tray wait (task-s)</th>
            <th>Baker occupied (s)</th>
            <th>Control revision</th>
          </tr>
        </thead>
        <tbody>{results.map(resultRow)}</tbody>
      </table>
    </div>
  );
}
function resultRow(result: FactoryResult): React.ReactNode {
  return (
    <tr key={result.identity} data-comparison-result={result.arrivalSeconds}>
      <td>{result.bufferSlots}</td>
      <td>{result.holds}</td>
      <td>{result.output}</td>
      <td>{result.endSeconds.toFixed(3)}</td>
      <td>{orderMetric(result.orders, "meanLeadSeconds")}</td>
      <td>{orderMetric(result.orders, "maximumLeadSeconds")}</td>
      <td>{orderMetric(result.orders, "drainSeconds")}</td>
      <td>{result.fullBufferSeconds.toFixed(3)}</td>
      <td>{result.sourceBlockedSeconds.toFixed(3)}</td>
      <td>{result.carrierWaitSeconds.toFixed(3)}</td>
      <td>{result.bakerOccupiedSeconds.toFixed(3)}</td>
      <td>{result.controlRevision}</td>
    </tr>
  );
}

function orderMetric(
  metrics: OrderMetrics,
  key: "meanLeadSeconds" | "maximumLeadSeconds" | "drainSeconds",
): string {
  if (metrics.kind === "unavailable") return "Unavailable in retained build";
  const value = metrics[key];
  return value === null ? "No orders" : value.toFixed(3);
}
