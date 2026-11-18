import { assertNever } from "@seams/std";
import type { PhysicsReplay } from "@seams/bakery-model/bakery-physics";
import {
  summarizeMargins,
  type OperationMarginSummaries,
} from "@seams/bakery-model/bakery-margins";

/**
 * What a browser simulation tells the agent (`simulate_workcell`): the
 * outcome of its last operation, and the margins of each operation against
 * the robot's rated limits, as the robot comparison shows them.
 */
export function simulationResult(recording: PhysicsReplay): Readonly<{
  outcome: "completed" | "failed" | "execution-error";
  margins: OperationMarginSummaries;
}> {
  switch (recording.kind) {
    case "bakery-physics-recording":
      return {
        outcome: recording.outcome.kind,
        margins: [
          {
            operation: "transfer",
            margins: summarizeMargins(recording.outcome.margins),
          },
        ],
      };
    case "bakery-physics-sequence":
      return {
        outcome: recording.unloading.outcome.kind,
        margins: [
          {
            operation: "loading",
            margins: summarizeMargins(recording.loading.outcome.margins),
          },
          {
            operation: "unloading",
            margins: summarizeMargins(recording.unloading.outcome.margins),
          },
        ],
      };
    case "bakery-physics-rack-sequence":
      return {
        outcome: recording.racking.outcome.kind,
        margins: [
          {
            operation: "loading",
            margins: summarizeMargins(recording.loading.outcome.margins),
          },
          {
            operation: "unloading",
            margins: summarizeMargins(recording.unloading.outcome.margins),
          },
          {
            operation: "racking",
            margins: summarizeMargins(recording.racking.outcome.margins),
          },
        ],
      };
    default:
      return assertNever(recording, "Unexpected simulation state");
  }
}
