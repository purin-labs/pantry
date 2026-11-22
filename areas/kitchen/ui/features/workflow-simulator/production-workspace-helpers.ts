import type { Settings } from "@purin-labs/bakery-model/bakery";
import type { ProductionAssignment } from "@purin-labs/bakery-model/bakery-production-scenario";
import {
  describe,
  humanResource,
  type Interval,
  type Run,
  type Wait,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import {
  buildFinancierHandoffRecovery,
  type FinancierHandoffRecoveryPreset,
} from "@purin-labs/production-simulation/recipes/financier-bake/model";
import { defaultAssignments } from "./production-draft";

export type BatchWaitSummary = Readonly<{
  label: string;
  seconds: number;
  first: Wait;
}>;

export function batchWorkerFlow(run: Run, steps: readonly Interval[]): string {
  const names: string[] = [];
  for (const step of steps) {
    if (step.kind === "wait" || !step.attended) continue;
    const name = humanResource(run, step.executor).name;
    if (names[names.length - 1] !== name) names.push(name);
  }
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  const first = names[0]!;
  const rest = names
    .slice(1)
    .map((n) => (n.startsWith("Baker ") ? n.slice(6) : n));
  return `${first} → ${rest.join(" → ")}`;
}

export function shortStationName(station: Interval["station"]): string {
  switch (station) {
    case "stage":
      return "Batter";
    case "portion":
      return "Portion";
    case "bake":
      return "Bake";
    case "cool":
      return "Cool";
    case "pack":
      return "Pack";
  }
}

export function shortProcessTitle(interval: Interval): string {
  const raw = describe(interval);
  switch (raw) {
    case "Batter staging":
      return "Batter";
    case "Portioning":
      return "Portion";
    case "Baking":
      return "Bake";
    case "Cooling in moulds":
      return "Cool";
    case "Stage cold proxy in Robot cell":
      return "Stage in cell";
    default:
      return raw;
  }
}

export function stationWaitForStep(
  run: Run,
  batchId: string,
  station: Interval["station"],
): BatchWaitSummary | null {
  let seconds = 0;
  let first: Wait | null = null;
  let label = "";
  for (const interval of run.intervals) {
    if (
      interval.kind !== "wait" ||
      interval.batch !== batchId ||
      interval.station !== station
    )
      continue;
    seconds += interval.end - interval.start;
    if (first === null) {
      first = interval;
      label = interval.label;
    }
  }
  if (first === null || seconds <= 0) return null;
  return { label, seconds: Math.round(seconds), first };
}

export function compactStationWait(label: string, seconds: number): string {
  if (label.includes("shared bake cycle")) return `Wait ${seconds} s`;
  if (label.includes("next oven cycle")) return `Wait oven (${seconds} s)`;
  if (label.includes("Workcell resources reserved"))
    return `Wait cell (${seconds} s)`;
  const batchMatch = /batch ([A-Z0-9]+)/i.exec(label);
  if (batchMatch !== null)
    return `Wait ${batchMatch[1]!.toUpperCase()} (${seconds} s)`;
  return `Wait (${seconds} s)`;
}

export function compactNativeTrayStatus(status: string): string {
  if (status === "Awaiting native result") return "Awaiting native";
  const trayMatch = /^Waiting for tray ([0-9]+)$/i.exec(status);
  if (trayMatch !== null) return `After Tray ${trayMatch[1]}`;
  const crossBatchClearMatch =
    /^Waiting for batch:([A-Z0-9]+):handoff:[0-9]+-clear$/i.exec(status);
  if (crossBatchClearMatch !== null)
    return `After Batch ${crossBatchClearMatch[1]!.toUpperCase()} clear`;
  const crossBatchNativeMatch =
    /^Waiting for batch:([A-Z0-9]+):native:[0-9]+$/i.exec(status);
  if (crossBatchNativeMatch !== null)
    return `After Batch ${crossBatchNativeMatch[1]!.toUpperCase()} cell`;
  const batchHoldMatch =
    /^Workcell resources reserved by batch:([A-Z0-9]+):/i.exec(status);
  if (batchHoldMatch !== null)
    return `Held by Batch ${batchHoldMatch[1]!.toUpperCase()}`;
  if (status === "completed") return "Done";
  if (status === "running") return "Running";
  return status;
}

export function calibratedHandoffAssignments(
  settings: Settings,
  preset: FinancierHandoffRecoveryPreset,
): readonly ProductionAssignment[] {
  if (preset === "nominal-handoff") return defaultAssignments(settings);
  const recovery = buildFinancierHandoffRecovery(preset);
  const assignments: ProductionAssignment[] = [];
  for (let batch = 0; batch < settings.batchCount; batch++) {
    const batchId = String.fromCharCode(65 + batch);
    const prevBatchId = batch > 0 ? String.fromCharCode(65 + batch - 1) : null;
    for (let tray = 1; tray <= settings.traysPerBatch; tray++) {
      if (assignments.length === 16) return assignments;
      const useSecondaryWorker =
        settings.workerCount >= 2 &&
        (preset === "cell-2-restage-recovery"
          ? batch > 0 || tray > 1
          : tray > 1);
      const dependsOn: string[] = [];
      if (prevBatchId !== null && tray === 1) {
        dependsOn.push(
          preset === "cell-2-restage-recovery"
            ? `batch:${prevBatchId}:native:1`
            : `batch:${prevBatchId}:handoff:${settings.traysPerBatch}-clear`,
        );
      }
      const earliestStartSeconds =
        batch === 0 && tray === 1
          ? recovery.reSeatSeconds
          : preset === "cell-2-restage-recovery"
            ? recovery.holdReleaseSeconds
            : recovery.reSeatSeconds;
      assignments.push({
        batchId,
        tray,
        workerId: useSecondaryWorker ? "human-2" : "human-1",
        dependsOn,
        earliestStartSeconds,
      });
    }
  }
  return assignments;
}
