import React from "react";
import type { Settings } from "@purin-labs/bakery-model/bakery";
import {
  parseMeasuredShift,
  recommendMeasuredSettings,
  type MeasuredShift,
  type MeasuredValue,
} from "@purin-labs/production-simulation/simulator/measured-shift";
import type { Run } from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { assertNever } from "@purin-labs/std";
const MAX_MEASUREMENT_BYTES = 1024 * 1024;

type Props = Readonly<{
  run: Run;
  sourceKind: "sample" | "procedure";
  stage(settings: Settings): void;
}>;

type ImportState =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "reading" }>
  | Readonly<{ kind: "invalid"; message: string }>
  | Readonly<{ kind: "ready"; shift: MeasuredShift }>;

export class MeasuredShiftImport extends React.Component<
  Props,
  Readonly<{ imported: ImportState }>
> {
  state = { imported: { kind: "empty" } as ImportState };

  private async importFile(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    if (file.size > MAX_MEASUREMENT_BYTES) {
      this.setState({
        imported: {
          kind: "invalid",
          message: "Choose a measured-shift JSON file smaller than 1 MiB.",
        },
      });
      return;
    }
    this.setState({ imported: { kind: "reading" } });
    try {
      const result = parseMeasuredShift(await file.text());
      this.setState({
        imported:
          result.kind === "valid"
            ? { kind: "ready", shift: result.shift }
            : { kind: "invalid", message: result.message },
      });
    } catch {
      this.setState({
        imported: {
          kind: "invalid",
          message: "The measured-shift file could not be read.",
        },
      });
    }
  }

  private stage(): void {
    const imported = this.state.imported;
    if (imported.kind !== "ready" || this.props.sourceKind !== "sample") return;
    const recommendation = recommendMeasuredSettings(
      this.props.run.settings,
      imported.shift,
    );
    if (recommendation.kind === "valid")
      this.props.stage(recommendation.settings);
  }

  render(): React.ReactNode {
    const imported = this.state.imported;
    const recommendation =
      imported.kind === "ready"
        ? recommendMeasuredSettings(this.props.run.settings, imported.shift)
        : null;
    return (
      <section
        className="workflow-scenario-panel workflow-measured-shift"
        aria-labelledby="workflow-measured-title"
      >
        <h2 id="workflow-measured-title">Real shift data</h2>
        <p>
          Compare the work times from a real shift with these inputs. Fill each
          interval in the template with the seconds from the shift start. The
          file stays in this browser tab.
        </p>
        <button type="button" onClick={downloadTemplate}>
          Download blank measurement template
        </button>
        <label htmlFor="workflow-measured-file">
          Import measured shift JSON
        </label>
        <input
          id="workflow-measured-file"
          type="file"
          accept=".json,application/json"
          onChange={this.importFile.bind(this)}
        />
        {imported.kind === "reading" && (
          <p role="status">Reading measurements…</p>
        )}
        {imported.kind === "invalid" && (
          <p role="alert">{imported.message} Current inputs are unchanged.</p>
        )}
        {imported.kind === "ready" && recommendation !== null && (
          <div aria-live="polite">
            <p>
              {imported.shift.site} · {imported.shift.batches.length} observed
              batch{imported.shift.batches.length === 1 ? "" : "es"} ·{" "}
              {imported.shift.workerIds.length} workers,{" "}
              {imported.shift.batches[0].trayCount} trays per batch,{" "}
              {imported.shift.piecesPerTray} pieces per tray. The suggested
              values also set these counts and the oven and rack capacities.
            </p>
            {!matchesRecordedSetup(this.props.run, imported.shift) && (
              <p>
                The current run has different staffing, tray counts or
                capacities. Finish errors include those configuration
                differences.
              </p>
            )}
            {this.props.run.batches.length === imported.shift.batches.length ? (
              <table>
                <caption>
                  Batch finish from shift start: observed against current
                  simulation
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Batch</th>
                    <th scope="col">Observed</th>
                    <th scope="col">Simulated</th>
                    <th scope="col">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {imported.shift.batches.map(
                    renderFinishComparison.bind(null, this.props.run),
                  )}
                </tbody>
              </table>
            ) : (
              <p>
                Current run has {this.props.run.batches.length} batches; the
                observation has {imported.shift.batches.length}. Apply matching
                counts before comparing finishes.
              </p>
            )}
            <table>
              <caption>
                Active operation time, observed against current input
              </caption>
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">Observed median (range)</th>
                  <th scope="col">Current</th>
                  <th scope="col">Suggested</th>
                </tr>
              </thead>
              <tbody>
                {recommendation.values.map(
                  renderMeasuredValue.bind(null, this.props.run.settings),
                )}
              </tbody>
            </table>
            <p>
              Suggestions round observed medians to the model’s whole-minute
              operation fields. Each distinct oven interval counts once toward
              the bake median. Worker travel, waits and quality outcomes need
              separate review. One shift does not validate physical handling.
            </p>
            {recommendation.kind === "unsupported" ? (
              <p role="alert">{recommendation.message}</p>
            ) : this.props.sourceKind === "procedure" ? (
              <p>
                This shared procedure owns its step durations. Review the
                measurements, then edit its operations in Workflow and save a
                new procedure revision.
              </p>
            ) : (
              <button
                type="button"
                className="primary-button"
                onClick={this.stage.bind(this)}
              >
                Put suggested values in draft
              </button>
            )}
            <p>
              Review the draft in Inputs, then select Apply changes to rerun the
              shift.
            </p>
          </div>
        )}
      </section>
    );
  }
}

function renderMeasuredValue(
  settings: Settings,
  value: MeasuredValue,
): React.ReactNode {
  const unit =
    value.field === "loadSeconds" || value.field === "unloadSeconds"
      ? "s"
      : "min";
  return (
    <tr key={value.field}>
      <th scope="row">{measuredLabel(value.field)}</th>
      <td>
        {formatObserved(value.field, value.observedSeconds)} (
        {formatObserved(value.field, value.minimumSeconds)}–
        {formatObserved(value.field, value.maximumSeconds)})
      </td>
      <td>
        {settings[value.field]} {unit}
      </td>
      <td>
        {value.recommended} {unit}
      </td>
    </tr>
  );
}

function measuredLabel(field: MeasuredValue["field"]): string {
  switch (field) {
    case "stage":
      return "Stage";
    case "portion":
      return "Portion";
    case "loadSeconds":
      return "Load oven";
    case "bake":
      return "Bake";
    case "unloadSeconds":
      return "Unload oven";
    case "cool":
      return "Cool in moulds";
    case "demould":
      return "Demould";
    case "finishCooling":
      return "Cool before packing";
    case "pack":
      return "Pack";
    default:
      return assertNever(field);
  }
}

function formatObserved(
  field: MeasuredValue["field"],
  seconds: number,
): string {
  if (field === "loadSeconds" || field === "unloadSeconds")
    return `${Number(seconds.toFixed(1))} s`;
  return `${Number((seconds / 60).toFixed(1))} min`;
}

function renderFinishComparison(
  run: Run,
  batch: MeasuredShift["batches"][number],
): React.ReactNode {
  const simulated = run.completions.find(matchesBatch.bind(null, batch.id));
  const observed = batch.intervals.pack.end;
  return (
    <tr key={batch.id}>
      <th scope="row">{batch.id}</th>
      <td>{elapsed(observed)}</td>
      <td>
        {simulated === undefined ? "Unfinished" : elapsed(simulated.time)}
      </td>
      <td>
        {simulated === undefined
          ? "—"
          : signedDuration(simulated.time - observed)}
      </td>
    </tr>
  );
}

function matchesBatch(
  id: string,
  completion: Run["completions"][number],
): boolean {
  return completion.batch === id;
}

function elapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function signedDuration(seconds: number): string {
  return `${seconds >= 0 ? "+" : "−"}${elapsed(Math.abs(seconds))}`;
}

function matchesRecordedSetup(run: Run, shift: MeasuredShift): boolean {
  const settings = run.settings;
  return (
    settings.batchCount === shift.batches.length &&
    settings.workerCount === shift.workerIds.length &&
    settings.traysPerBatch === shift.batches[0].trayCount &&
    settings.piecesPerTray === shift.piecesPerTray &&
    settings.ovenTrays === shift.ovenTrays &&
    settings.rackTrays === shift.rackTrays
  );
}

function downloadTemplate(): void {
  const blank = { start: null, end: null };
  const template = {
    kind: "bakery-measured-shift",
    schemaVersion: 2,
    shiftId: "",
    site: "",
    startTime: "",
    measurementMethod: "",
    evidenceRef: "",
    ovenId: "",
    mouldId: "",
    recipeRevision: "",
    emptyTrayMassKg: null,
    filledTrayMassKg: null,
    portionMassGrams: null,
    workerIds: [],
    ovenTrays: null,
    rackTrays: null,
    piecesPerTray: null,
    batches: [
      {
        id: "A",
        trayCount: null,
        intervals: {
          stage: blank,
          portion: blank,
          load: blank,
          bake: blank,
          unload: blank,
          cool: blank,
          demould: blank,
          finishCooling: blank,
          pack: blank,
        },
      },
    ],
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(template, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "bakery-measured-shift.json";
  link.click();
  URL.revokeObjectURL(url);
}
