import { assertNever } from "@seams/std";
import type { BakerySurfaceCommandV1 } from "@seams/bakery-model/bakery-surface";
import type { StrictUnion, Variant } from "@seams/type-utils";
import type { ProductionReady } from "./production-session.ts";
import type { ProductionWorkcell } from "@seams/production-simulation/recipes/bakery/production-workcells";
import {
  stations,
  type Run,
} from "@seams/production-simulation/recipes/bakery/schedule";
import type { Selection } from "@seams/production-simulation/simulator/selection";

export type ProductionNavigation = Readonly<{
  from: ProductionReady;
  time: number;
  target: StrictUnion<
    | Readonly<{ kind: "selection"; selection: Selection }>
    | Readonly<{ kind: "operation"; operation: ProductionWorkcell }>
  >;
}>;

// Resolve external identities against the applied run. An operation may await
// evidence and have no scheduled task yet; it opens the native Files selector.
export function prepareProductionNavigation(
  from: ProductionReady,
  view: Variant<BakerySurfaceCommandV1, "set_view">["view"],
): ProductionNavigation | null {
  const time = view.cursorSeconds;
  if (!Number.isFinite(time) || time < 0 || time > from.run.end) return null;
  const target = view.selection;
  let selection: Selection;
  switch (target.kind) {
    case "operation": {
      const operation = from.plan.operations.find(hasId.bind(null, target.id));
      return operation === undefined
        ? null
        : { from, time, target: { kind: "operation", operation } };
    }
    case "batch": {
      const batch = from.run.batches.find(hasId.bind(null, target.id));
      if (batch === undefined) return null;
      selection = { kind: "batch", id: batch.id };
      break;
    }
    case "station": {
      const station = stations.find(hasId.bind(null, target.id));
      if (station === undefined) return null;
      selection = { kind: "station", id: station.id };
      break;
    }
    case "resource": {
      const resource = from.run.resources.find(hasId.bind(null, target.id));
      if (resource === undefined) return null;
      selection = { kind: "resource", id: resource.id };
      break;
    }
    case "task": {
      const task = from.run.intervals.find(taskHasId.bind(null, target.id));
      if (task === undefined || task.kind === "wait") return null;
      selection = { kind: "task", id: task.id };
      break;
    }
    default:
      return assertNever(target);
  }
  return { from, time, target: { kind: "selection", selection } };
}

function hasId(id: string, value: Readonly<{ id: string }>): boolean {
  return value.id === id;
}

function taskHasId(id: string, interval: Run["intervals"][number]): boolean {
  return interval.kind !== "wait" && interval.id === id;
}
