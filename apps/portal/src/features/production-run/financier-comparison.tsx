import React from "react";
import { parseJsonOrNull } from "@seams/std";
import type { RecurringFinancierInput } from "@seams/production-simulation/recipes/bakery/recurring-financier";
import { downloadBakeryFile } from "../workflow-simulator/file-download";
import { placeLabel } from "./factory-places";
import {
  comparisonFile,
  readComparisonFile,
  sameDemand,
  sameResult,
  type FinancierResult,
} from "@seams/production-simulation/runs/financier-results";

type Props = Readonly<{
  results: readonly FinancierResult[];
  current: FinancierResult | null;
  keep(result: FinancierResult): void;
  replace(results: readonly FinancierResult[]): void;
  clear(): void;
}>;
type Row = Readonly<{
  label: string;
  value(result: FinancierResult): string;
  input: keyof RecurringFinancierInput | null;
}>;

const INPUTS: readonly Readonly<{
  key: keyof RecurringFinancierInput;
  label: string;
}>[] = [
  { key: "arrivalMinutes", label: "Minutes between batches" },
  { key: "workers", label: "Bakers" },
  { key: "trays", label: "Financier trays" },
  { key: "coolingPositions", label: "Cooling rack positions" },
];

const ROWS: readonly Row[] = [
  ...INPUTS.map(inputRow),
  { label: "Finished financiers per hour", value: perHour, input: null },
  { label: "Financiers packed", value: packed, input: null },
  { label: "Shift ends after", value: shiftEnd, input: null },
  { label: "Mean batch completion", value: meanBatch, input: null },
  { label: "Longest batch completion", value: longestBatch, input: null },
  { label: "Longest queue", value: longestQueue, input: null },
  { label: "Baker use", value: bakerUse, input: null },
  { label: "Oven idle", value: ovenIdle, input: null },
  {
    label: "Oven blocked by a full next position",
    value: ovenBlocked,
    input: null,
  },
];

function inputRow(input: (typeof INPUTS)[number]): Row {
  return {
    label: input.label,
    value: inputValue.bind(null, input.key),
    input: input.key,
  };
}
function inputValue(
  key: keyof RecurringFinancierInput,
  result: FinancierResult,
): string {
  return String(result.input[key]);
}
function perHour(result: FinancierResult): string {
  return result.piecesPerHour.toFixed(1);
}
function packed(result: FinancierResult): string {
  return String(result.packedPieces);
}
function shiftEnd(result: FinancierResult): string {
  return hours(result.endSeconds);
}
function meanBatch(result: FinancierResult): string {
  return `${result.meanBatchMinutes.toFixed(0)} min`;
}
function longestBatch(result: FinancierResult): string {
  return `${result.longestBatchMinutes.toFixed(0)} min`;
}
function longestQueue(result: FinancierResult): string {
  return result.longestQueue === null
    ? "None"
    : `${result.longestQueue.waiting} at ${placeLabel(result.longestQueue.place)}`;
}
function bakerUse(result: FinancierResult): string {
  return `${Math.round(result.bakerUse * 100)} %`;
}
function ovenIdle(result: FinancierResult): string {
  return hours(result.ovenIdleSeconds);
}
function ovenBlocked(result: FinancierResult): string {
  return hours(result.ovenBlockedSeconds);
}
function hours(seconds: number): string {
  return `${(seconds / 3600).toFixed(1)} h`;
}
function letter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** Each scenario against the reference A, in the same demand only. */
function decision(results: readonly FinancierResult[]): React.ReactNode[] {
  const reference = results[0];
  if (reference === undefined) return [];
  const lines: React.ReactNode[] = [];
  for (const [index, result] of results.entries()) {
    if (index === 0) continue;
    if (!sameDemand(reference, result)) {
      lines.push(
        <li key={index}>
          Scenario {letter(index)} has other demand or another engine. Compare
          it only with scenarios that have the same minutes between batches.
        </li>,
      );
      continue;
    }
    const changes: string[] = [];
    for (const input of INPUTS)
      if (reference.input[input.key] !== result.input[input.key])
        changes.push(
          `${input.label.toLowerCase()} ${reference.input[input.key]} → ${result.input[input.key]}`,
        );
    const change =
      reference.piecesPerHour === 0
        ? 0
        : (result.piecesPerHour / reference.piecesPerHour - 1) * 100;
    const effect =
      Math.abs(change) < 1
        ? "makes the same output per hour as"
        : change > 0
          ? `makes ${change.toFixed(0)} % more financiers per hour than`
          : `makes ${(-change).toFixed(0)} % fewer financiers per hour than`;
    lines.push(
      <li key={index} data-comparison-decision={letter(index)}>
        Scenario {letter(index)} {effect} A ({result.piecesPerHour.toFixed(1)}{" "}
        against {reference.piecesPerHour.toFixed(1)}). Change from A:{" "}
        {changes.length === 0 ? "none" : changes.join(", ")}.
      </li>,
    );
  }
  return lines;
}

function resultHeading(result: FinancierResult, index: number) {
  return <th key={result.identity}>{letter(index)}</th>;
}
function resultCell(
  row: Row,
  reference: FinancierResult | undefined,
  result: FinancierResult,
): React.ReactNode {
  return (
    <td
      key={result.identity}
      data-changed={
        row.input !== null &&
        reference !== undefined &&
        result.input[row.input] !== reference.input[row.input]
      }
    >
      {row.value(result)}
    </td>
  );
}
function resultRow(
  results: readonly FinancierResult[],
  row: Row,
): React.ReactNode {
  return (
    <tr key={row.label}>
      <th>{row.label}</th>
      {results.map(resultCell.bind(null, row, results[0]))}
    </tr>
  );
}

/** Kept results survive while the workspace stays open and in an exported file. */
export class FinancierComparison extends React.Component<
  Props,
  Readonly<{ notice: string }>
> {
  state = { notice: "" };
  private keepCurrent(): void {
    if (this.props.current !== null) this.props.keep(this.props.current);
  }
  private export(): void {
    downloadBakeryFile(
      "financier-comparison.json",
      comparisonFile(this.props.results),
    );
  }
  private async open(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    const results = readComparisonFile(parseJsonOrNull(await file.text()));
    if (results === null) {
      this.setState({ notice: "This file is not a financier comparison." });
      return;
    }
    this.props.replace(results);
    this.setState({
      notice: `Opened ${results.length} kept ${results.length === 1 ? "scenario" : "scenarios"}.`,
    });
  }
  private currentStatus(): React.ReactNode {
    const { results, current } = this.props;
    if (current === null)
      return <p>Run the shift to its end to keep its result.</p>;
    for (const [index, result] of results.entries())
      if (result.identity === current.identity)
        return (
          <p role="status" data-kept-match={letter(index)}>
            {sameResult(result, current)
              ? `This shift has the same result as kept scenario ${letter(index)}.`
              : `This shift differs from kept scenario ${letter(index)}.`}
          </p>
        );
    return (
      <p role="status">
        This shift: {current.piecesPerHour.toFixed(1)} finished financiers per
        hour.
      </p>
    );
  }
  private kept(): boolean {
    for (const result of this.props.results)
      if (result.identity === this.props.current?.identity) return true;
    return false;
  }
  render(): React.ReactNode {
    const { results, current } = this.props;
    return (
      <section aria-label="Financier comparison">
        <h3>Compare financier scenarios</h3>
        <p>
          Keep a completed shift. Then close it and prepare another with one
          change. Compare scenarios with the same minutes between batches.
        </p>
        {this.currentStatus()}
        <button
          disabled={current === null || this.kept()}
          onClick={this.keepCurrent.bind(this)}
        >
          Keep this result
        </button>
        <button
          disabled={results.length === 0}
          onClick={this.export.bind(this)}
        >
          Export comparison
        </button>
        <label>
          Open comparison
          <input
            type="file"
            accept=".json,application/json"
            onChange={this.open.bind(this)}
          />
        </label>
        <button disabled={results.length === 0} onClick={this.props.clear}>
          Clear comparison
        </button>
        <p role="status">{this.state.notice}</p>
        {results.length > 0 && (
          <div className="oven-logistics-scroll" tabIndex={0}>
            <table
              className="oven-workspace-cells financier-comparison"
              aria-label="Kept financier scenarios"
            >
              <thead>
                <tr>
                  <th>Scenario</th>
                  {results.map(resultHeading)}
                </tr>
              </thead>
              <tbody>{ROWS.map(resultRow.bind(null, results))}</tbody>
            </table>
          </div>
        )}
        {results.length > 1 && (
          <ul aria-label="Comparison decision">{decision(results)}</ul>
        )}
        <p>
          Output per hour covers the whole shift, from the first batch to the
          last tray return. Queue sizes count tasks that waited at once.
        </p>
      </section>
    );
  }
}
