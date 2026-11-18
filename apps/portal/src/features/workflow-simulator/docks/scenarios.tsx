import React from "react";

import { PROCEDURE_PICKER, ScenarioPicker } from "../scenario-picker";
import type { WorkflowSimulatorActions } from "../simulator-actions";
import type { ScenarioView, SimulatorConnection } from "../simulator-state";
import type { Run } from "@seams/production-simulation/recipes/bakery/schedule";
import { DockHeader } from "./shared";
import { MeasuredShiftImport } from "./measured-shift-import";
import { assertNever } from "@seams/std";

type ScenarioState = Pick<
  ScenarioView,
  "shift" | "procedureLoad" | "copyName" | "copyNote"
>;

type ScenarioActions = Pick<
  WorkflowSimulatorActions,
  | "closeDock"
  | "createSample"
  | "loadProcedureId"
  | "loadScenarioId"
  | "saveScenario"
  | "changeCopyName"
  | "changeCopyNote"
  | "useSample"
>;

type Props = Readonly<{
  connection: SimulatorConnection;
  state: ScenarioState;
  actions: ScenarioActions;
  open: boolean;
  /** The run that real shift data is compared with. */
  run: Run;
  stageMeasuredSettings: WorkflowSimulatorActions["stageMeasuredSettings"];
}>;

export function ScenariosDock(props: Props): React.ReactNode {
  return (
    <section
      id="workflow-dock-scenarios"
      className="workflow-dock workflow-dock-left workflow-scenarios-dock"
      hidden={!props.open}
      aria-label="Scenarios"
    >
      <DockHeader label="Scenarios" onClose={props.actions.closeDock} />
      <div className="workflow-advanced">
        <WorkspaceProcedurePanel {...props} />
        <SharedScenariosPanel {...props} />
        <p role="status" className="workflow-copy-status">
          {scenarioStatusText(props.state)}
        </p>
        <ProcedureSource {...props} />
        <MeasuredShiftImport
          run={props.run}
          sourceKind={props.state.shift.kind}
          stage={props.stageMeasuredSettings}
        />
      </div>
    </section>
  );
}

function WorkspaceProcedurePanel(props: Props): React.ReactNode {
  if (props.connection.kind !== "workspace") {
    return null;
  }

  const busy = props.state.procedureLoad.kind === "loading";
  return (
    <section className="workflow-scenario-panel">
      <h2>Workspace procedure</h2>
      {props.connection.canManage ? (
        <>
          <p>
            Load a sample to enable saving. This replaces your local settings.
          </p>
          <button
            type="button"
            onClick={props.actions.createSample}
            disabled={busy}
          >
            Load workspace sample
          </button>
        </>
      ) : (
        <p>Ask an admin to create a workspace sample.</p>
      )}
      <ScenarioPicker
        key={props.connection.organisationId}
        kind={PROCEDURE_PICKER}
        organisationId={props.connection.organisationId}
        busy={busy}
        onLoad={props.actions.loadProcedureId}
      />
    </section>
  );
}

function SharedScenariosPanel(props: Props): React.ReactNode {
  if (props.connection.kind !== "workspace") {
    return null;
  }

  const busy = props.state.procedureLoad.kind === "loading";
  return (
    <section className="workflow-scenario-panel">
      <h2>Shared scenarios</h2>
      <p>Save and share shift settings with your workspace.</p>
      <ScenarioPicker
        key={props.connection.organisationId}
        organisationId={props.connection.organisationId}
        busy={busy}
        onLoad={props.actions.loadScenarioId}
      />
      <SaveScenarioForm {...props} />
    </section>
  );
}

function SaveScenarioForm(props: Props): React.ReactNode {
  if (props.connection.kind === "workspace" && !props.connection.canManage) {
    return <p>Only workspace admins can save scenarios.</p>;
  }
  if (
    props.connection.kind !== "workspace" ||
    props.state.shift.kind !== "procedure" ||
    !props.connection.canManage
  ) {
    return null;
  }

  const busy = props.state.procedureLoad.kind === "loading";
  return (
    <form
      className="workflow-operation-editor"
      onSubmit={props.actions.saveScenario}
    >
      <label htmlFor="workflow-copy-name">Scenario name</label>
      <input
        id="workflow-copy-name"
        name="copyName"
        required
        maxLength={80}
        value={props.state.copyName}
        onChange={props.actions.changeCopyName}
        disabled={busy}
      />
      <label htmlFor="workflow-copy-note">Timing note</label>
      <textarea
        id="workflow-copy-note"
        name="copyNote"
        required
        maxLength={2000}
        rows={3}
        value={props.state.copyNote}
        onChange={props.actions.changeCopyNote}
        disabled={busy}
        aria-describedby="workflow-copy-help"
      />
      <p id="workflow-copy-help">Which timings were measured or estimated?</p>
      <button type="submit" disabled={busy}>
        Save scenario
      </button>
    </form>
  );
}

function ProcedureSource(props: Props): React.ReactNode {
  if (props.state.shift.kind !== "procedure") {
    return <p className="workflow-scenario-source">Local sample · Unsaved</p>;
  }

  return (
    <section className="workflow-scenario-panel" aria-label="Procedure source">
      <h2>Loaded procedure</h2>
      <button
        onClick={props.actions.useSample}
        disabled={props.state.procedureLoad.kind === "loading"}
      >
        Use local sample
      </button>
    </section>
  );
}

function scenarioStatusText(state: ScenarioState): string {
  switch (state.procedureLoad.kind) {
    case "loading":
      return "Preparing shared scenario…";
    case "failed":
      return state.procedureLoad.message;
    case "idle":
      return "";
    default:
      return assertNever(
        state.procedureLoad,
        "Unexpected workflow scenario state",
      );
  }
}
