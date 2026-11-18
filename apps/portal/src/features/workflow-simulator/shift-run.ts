import {
  parseProcedureAssumptions,
  scenarioAssumptionFields,
} from "@seams/bakery-model/bakery-procedure";
import {
  parseSettings,
  type SettingsField,
  type SettingsResult,
} from "@seams/bakery-model/bakery";
import type { Variant } from "@seams/type-utils";
import {
  normalRun,
  procedureShift,
  sampleShift,
  type SimulatorShift,
  type SimulatorState,
} from "./simulator-state";

export const SHIFT_RUN_NOTICE =
  "Both scenarios recalculated from 06:00. Playback reset. These inputs are local until you save a scenario copy.";

export type ShiftRunResult =
  | Readonly<{ kind: "ready"; shift: SimulatorShift }>
  | Variant<SettingsResult, "invalid">;

// Apply changes: the applied inputs with these values, recalculated as the
// normal and the outage run. The agent's run_shift takes the same path.
export function runShiftInputs(
  state: SimulatorState,
  values: ReadonlyMap<SettingsField, string | number>,
): ShiftRunResult {
  const raw = {
    ...normalRun(state).settings,
    ...Object.fromEntries(values),
  };
  if (state.run.shift.kind === "procedure") {
    const result = parseProcedureAssumptions(
      state.run.shift.normal.source,
      raw,
    );
    if (result.kind === "invalid") return result;
    return {
      kind: "ready",
      shift: procedureShift(result.procedure, state.run.layout),
    };
  }
  const result = parseSettings(raw);
  if (result.kind === "invalid") return result;
  return {
    kind: "ready",
    shift: sampleShift(result.settings, state.run.layout),
  };
}

// A recipe fixes every input but its scenario assumptions; the Inputs dock
// disables the others.
export function shiftInputEditable(
  state: SimulatorState,
  field: SettingsField,
): boolean {
  return (
    state.run.shift.kind !== "procedure" || scenarioAssumptionFields.has(field)
  );
}
