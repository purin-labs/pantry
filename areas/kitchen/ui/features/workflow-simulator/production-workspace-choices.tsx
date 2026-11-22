import React from "react";
import { REHEARSAL_PRESETS } from "@purin-labs/production-simulation/simulator/rehearsal-presets";
import { Select } from "@purin-labs/ui/select";

// The items of the production workspace selects. production-workspace.tsx is
// at its line limit, so its Select item lists live here.

/** One item of a Select: its value and the label that the trigger shows. */
export type SelectChoice = Readonly<{ value: string; label: string }>;

export function renderItem(item: SelectChoice): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}

/** Baker 1 to Baker `count`; the value is the baker number. */
export function workerChoices(count: number): SelectChoice[] {
  const workers: SelectChoice[] = [];
  for (let worker = 1; worker <= count; worker++)
    workers.push({ value: String(worker), label: `Baker ${worker}` });
  return workers;
}

export const ANY_BAKER: SelectChoice = {
  value: "automatic",
  label: "Any available baker",
};

export const AUTHOR_ROUTES: readonly SelectChoice[] = [
  { value: "cold-racking", label: "Cold racking after cooling" },
  {
    value: "oven-rack",
    label: "Persistent oven loading, retrieval and racking",
  },
];

export const PRESET_CHOICES: readonly SelectChoice[] = REHEARSAL_PRESETS.map(
  (preset) => ({ value: preset.id, label: preset.name }),
);

export const RACK_CASES: readonly SelectChoice[] = [
  { value: "nominal", label: "Nominal" },
  { value: "slip", label: "Injected slip" },
];

export const NO_OUTAGE: SelectChoice = { value: "", label: "No outage" };

export const NO_FAILURE: SelectChoice = {
  value: "",
  label: "No injected failure",
};

export const KEEP_HOLDS: SelectChoice = {
  value: "",
  label: "Keep failure holds",
};

export const COLD_CELLS: readonly SelectChoice[] = [
  { value: "cold-cell-1", label: "Robot cell 1" },
  { value: "cold-cell-2", label: "Robot cell 2" },
];

export const HANDOFF_PRESETS: readonly SelectChoice[] = [
  {
    value: "nominal-handoff",
    label:
      "Nominal cell handoff (0 mm slip · direct cold-cell-1 transfer · 3m cool)",
  },
  {
    value: "carrier-slip-recovery",
    label:
      "Carrier rail slip + FR10 re-seat (14 mm slip · +45 s datum check · 4m cool · Batch B gated on Batch A clearance)",
  },
  {
    value: "cell-2-restage-recovery",
    label:
      "Cell 1 clamp hold + Cell 2 failover restage (18 mm slip · +60 s re-registration · 120 s hold release · secondary baker)",
  },
];

export const FINANCIER_PRESETS: readonly SelectChoice[] = [
  { value: "procedure", label: "Procedure inputs" },
  { value: "one-batch", label: "Financier + robot · one batch, one tray" },
];

export const OVEN_VARIANTS: readonly SelectChoice[] = [
  { value: "normal", label: "Normal" },
  { value: "outage", label: "Assumed oven outage" },
];
