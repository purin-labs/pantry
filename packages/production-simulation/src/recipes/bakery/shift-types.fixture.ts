import type { Measurement, ShiftCohort } from "./shift-metrics.ts";
import type { ShiftReport } from "./shift-report.ts";
import { sixHourShiftRecipeInput } from "./shift-preset.ts";
import type { ShiftTrace } from "./shift-trace.ts";

/** Compile-only checks for evidence states and preset identity. */
export function checkShiftEvidenceTypes(): void {
  // @ts-expect-error Missing evidence cannot also contain a measured value.
  const missing: Measurement = {
    kind: "unavailable",
    reason: "missing",
    value: 900,
    sampleCount: 1,
  };
  const observed = { value: 900, sampleCount: 1 };
  // @ts-expect-error Broad spreads cannot add observations to missing evidence.
  const spread: Measurement = {
    ...observed,
    kind: "unavailable",
    reason: "missing",
  };
  // @ts-expect-error An available trace requires its actual nodes and edges.
  const trace: ShiftTrace = { kind: "available", coverage: "tasks" };
  const report: ShiftReport = {
    kind: "unavailable",
    reason: "missing",
    // @ts-expect-error A report cannot mix unavailable and available evidence.
    trace: { kind: "unavailable", reason: "missing" },
  };
  // @ts-expect-error An unavailable cohort cannot claim a run count.
  const cohort: ShiftCohort = {
    kind: "unavailable",
    reason: "empty",
    runCount: 0,
  };
  // @ts-expect-error Configuration overrides cannot change the preset identity.
  sixHourShiftRecipeInput({ kind: "morning-shift" });
  void [missing, spread, trace, report, cohort];
}
