import React from "react";
import {
  applianceTaskRisk,
  type ApplianceTaskRisk,
  type ExecutedApplianceTaskRecord,
} from "@purin-labs/production-simulation/recipes/bakery/appliance-execution";
import type { ApplianceReportState } from "./recipe-appliance-report";

type Props = Readonly<{
  state: ApplianceReportState;
  selectedTask: string | null;
  selectTask: (task: string) => void;
  rerun: () => void;
}>;

/**
 * Displays recipe appliance physics checks in the Portal Kitchen run view
 * (Refactor 16, step 15B). Failed checks mark tasks as at risk without failing
 * the completed schedule task (D3).
 */
export function AppliancePhysicsReportSection({
  state,
  selectedTask,
  selectTask,
  rerun,
}: Props): React.ReactNode {
  if (state.kind === "idle" || state.kind === "not-applicable") return null;

  return (
    <section
      aria-label="Appliance physics report"
      className="appliance-report-panel"
      data-appliance-report-state={state.kind}
    >
      <div className="shift-evidence-header">
        <div>
          <h4>Appliance physics report</h4>
          <p className="shift-evidence-subtitle">
            MuJoCo appliance checks run after the schedule finishes. A failed
            check marks its task as at risk and does not fail the schedule task.
          </p>
        </div>
        <div className="shift-evidence-badges">
          {state.kind === "running" && (
            <span className="shift-band-badge" data-band="unavailable">
              Running {state.completed} / {state.total}
            </span>
          )}
          {state.kind === "ready" && (
            <>
              <span
                className="shift-band-badge"
                data-band="within-assumption"
                data-appliance-checks={state.report.taskCount}
              >
                {state.report.taskCount} checks
              </span>
              <span
                className="shift-band-badge"
                data-band="unavailable"
                data-appliance-count={state.report.applianceCount}
              >
                {state.report.applianceCount} appliances
              </span>
              <span
                className="shift-band-badge"
                data-band={
                  state.atRisk.size > 0
                    ? "outside-assumption"
                    : "within-assumption"
                }
                data-appliance-at-risk={state.atRisk.size}
              >
                {state.atRisk.size === 0
                  ? "0 at risk"
                  : `${state.atRisk.size} at risk`}
              </span>
              <span className="shift-band-badge" data-band="unavailable">
                Peak draw {state.report.facilityUtilities.peakTotalPowerWatts} W
              </span>
              <span className="shift-band-badge" data-band="unavailable">
                First-pass yield{" "}
                {state.report.massBalance.firstPassYieldPercent.toFixed(1)}%
              </span>
            </>
          )}
          {state.kind === "failed" && (
            <span className="shift-band-badge" data-band="outside-assumption">
              Verification unavailable
            </span>
          )}
        </div>
      </div>

      {state.kind === "running" && (
        <p role="status" className="appliance-report-status">
          Verifying recipe steps against MuJoCo appliance models:{" "}
          {state.completed} of {state.total} completed…
        </p>
      )}

      {state.kind === "failed" && (
        <div className="appliance-report-error" role="alert">
          <p>{state.message}</p>
          <button type="button" className="secondary" onClick={rerun}>
            Retry appliance checks
          </button>
        </div>
      )}

      {state.kind === "ready" && (
        <>
          {state.atRisk.size > 0 && (
            <div
              className="appliance-risk-callout"
              aria-label="At-risk appliance tasks"
            >
              <h5>Tasks marked at risk ({state.atRisk.size})</h5>
              <ul>
                {[...state.atRisk.values()].map((risk) => (
                  <li key={risk.taskId} data-at-risk-item={risk.taskId}>
                    <button
                      type="button"
                      className="appliance-task-link"
                      aria-pressed={selectedTask === risk.taskId}
                      onClick={selectTask.bind(null, risk.taskId)}
                    >
                      {risk.taskId}
                    </button>{" "}
                    <span className="appliance-risk-badge" data-risk="at-risk">
                      At risk
                    </span>{" "}
                    <span className="appliance-risk-meta">
                      {risk.appliance} · {risk.gateKind}
                      {risk.measured !== null ? ` · ${risk.measured}` : ""}
                      {risk.targetSpecRange !== null
                        ? ` (spec ${risk.targetSpecRange})`
                        : ""}
                    </span>
                    <p className="appliance-risk-reason">{risk.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="production-table-card">
            <table
              className="oven-workspace-cells production-data-table"
              aria-label="Appliance physics checks"
            >
              <caption>Appliance physics checks</caption>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Appliance</th>
                  <th>Category</th>
                  <th className="num-col">Sim (s)</th>
                  <th className="num-col">Temp (°C)</th>
                  <th>Check</th>
                  <th>Finding</th>
                  <th>Checkpoint</th>
                </tr>
              </thead>
              <tbody>
                {state.report.records.map((record) => (
                  <ApplianceCheckRow
                    key={`${record.index}-${record.taskId}`}
                    record={record}
                    risk={applianceTaskRisk(record)}
                    selected={selectedTask === record.taskId}
                    selectTask={selectTask}
                  />
                ))}
              </tbody>
            </table>
            <div className="production-table-footer">
              <button
                type="button"
                className="secondary production-stock-toggle"
                onClick={rerun}
              >
                Re-run appliance checks
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function ApplianceCheckRow({
  record,
  risk,
  selected,
  selectTask,
}: Readonly<{
  record: ExecutedApplianceTaskRecord;
  risk: ApplianceTaskRisk | null;
  selected: boolean;
  selectTask: (task: string) => void;
}>): React.ReactNode {
  const status = risk !== null ? "at-risk" : "ok";
  const cp = record.coupledPhysics;
  return (
    <tr
      data-appliance-task={record.taskId}
      data-appliance={record.appliance}
      data-appliance-check={status}
      data-at-risk={risk !== null ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
    >
      <td>
        <button
          type="button"
          className="appliance-task-link"
          aria-pressed={selected}
          onClick={selectTask.bind(null, record.taskId)}
        >
          {record.taskId}
        </button>
      </td>
      <td>{record.appliance}</td>
      <td>{record.category}</td>
      <td className="num-col">{record.simulatedSeconds.toFixed(1)}</td>
      <td className="num-col">
        {cp.entryTemperatureC.toFixed(1)} → {cp.exitTemperatureC.toFixed(1)}
      </td>
      <td>
        <span
          className={
            risk !== null ? "appliance-risk-badge" : "shift-band-badge"
          }
          data-band={risk !== null ? undefined : "within-assumption"}
          data-risk={risk !== null ? "at-risk" : undefined}
          data-appliance-check-status={status}
        >
          {risk !== null ? "At risk" : "Pass"}
        </span>
      </td>
      <td className="basis-col">
        {risk !== null ? risk.reason : cp.inspectionDecision.rationale}
      </td>
      <td className="num-col">{record.checkpointDigest.slice(0, 8)}</td>
    </tr>
  );
}
