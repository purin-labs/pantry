import type { BakeryRunSummary } from "@seams/bakery-model/bakery-surface";
import {
  metrics,
  type Run,
  type TaskEvent,
} from "../recipes/bakery/schedule.ts";

// A pinned baseline keeps only the measures a later run is compared against.
export type RunSummary = BakeryRunSummary;

export function summarizeRun(run: Run): RunSummary {
  const measured = metrics(run);
  return {
    kind: run.kind,
    end: run.end,
    completed: run.taskEvents.filter(completedTask).length,
    unfinished: measured.unfinished,
    failed:
      run.nativeHolds.filter(failedHold).length + run.handlingFailures.length,
    waiting: measured.waiting,
  };
}

export function compareRuns(
  baseline: RunSummary,
  current: RunSummary,
  unit: "tray" | "batch",
): string {
  const parts: string[] = [];
  const end = current.end - baseline.end;
  if (Math.abs(end) >= 0.05)
    parts.push(
      `Run ${current.kind === "complete" ? "ends" : "stops"} ${duration(Math.abs(end))} ${end > 0 ? "later" : "earlier"} than the baseline.`,
    );
  const unfinished = current.unfinished - baseline.unfinished;
  if (unfinished !== 0)
    parts.push(
      `${Math.abs(unfinished)} ${unfinished > 0 ? "more" : "fewer"} unfinished ${unit}${Math.abs(unfinished) === 1 ? "" : "s"}.`,
    );
  const failed = current.failed - baseline.failed;
  if (failed !== 0)
    parts.push(
      `${Math.abs(failed)} ${failed > 0 ? "more" : "fewer"} failed task${Math.abs(failed) === 1 ? "" : "s"}.`,
    );
  const waiting = current.waiting - baseline.waiting;
  if (Math.abs(waiting) >= 0.05)
    parts.push(
      `Total waiting ${waiting > 0 ? "+" : "−"}${duration(Math.abs(waiting))}.`,
    );
  return parts.length === 0 ? "Same outcome as the baseline." : parts.join(" ");
}

export function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round((seconds - minutes * 60) * 10) / 10;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

function completedTask(event: TaskEvent): boolean {
  return (
    event.kind === "completed" ||
    (event.kind === "native-settled" && event.task.outcome === "completed")
  );
}
function failedHold(hold: Run["nativeHolds"][number]): boolean {
  return hold.kind === "failed";
}
