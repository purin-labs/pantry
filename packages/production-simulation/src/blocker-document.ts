import * as d from "./document-values.ts";
import { readWorkerIds } from "./scenario-document.ts";
import type { Blocker } from "./state.ts";

export function readBlocker(raw: unknown): Blocker {
  switch (d.kind(raw)) {
    case "batch-cycle": {
      const r = d.record(raw, ["kind", "resource", "reason"]);
      return {
        kind: "batch-cycle",
        resource: d.id("resource", r.resource),
        reason: d.choice(
          r.reason,
          "loading",
          "running",
          "unloading",
          "closed",
          "program",
        ),
      };
    }
    case "workers": {
      const r = d.record(raw, ["kind", "workers"]);
      return { kind: "workers", workers: readWorkerIds(r.workers) };
    }
    case "release": {
      const r = d.record(raw, ["kind", "at"]);
      return { kind: "release", at: d.time(r.at) };
    }
    case "inspection":
    case "prerequisite": {
      const r = d.record(raw, ["kind", "task"]);
      return {
        kind: d.choice(r.kind, "inspection", "prerequisite"),
        task: d.id("task", r.task),
      };
    }
    case "resource": {
      const r = d.record(raw, ["kind", "resource", "reason"]);
      return {
        kind: "resource",
        resource: d.id("resource", r.resource),
        reason: d.choice(r.reason, "capacity", "unavailable", "held"),
      };
    }
    case "configuration": {
      const r = d.record(raw, ["kind", "resource", "required", "current"]);
      return {
        kind: "configuration",
        resource: d.id("resource", r.resource),
        required: d.id("configuration", r.required),
        current: d.id("configuration", r.current),
      };
    }
    case "material": {
      const r = d.record(raw, ["kind", "product", "missing"]);
      return {
        kind: "material",
        product: d.id("product", r.product),
        missing: d.quantity(r.missing),
      };
    }
    case "carrier": {
      const r = d.record(raw, ["kind", "store"]);
      return { kind: "carrier", store: d.id("storage", r.store) };
    }
    case "destination": {
      const r = d.record(raw, ["kind", "storage"]);
      return { kind: "destination", storage: d.id("storage", r.storage) };
    }
    case "cell-slot":
    case "cell-state": {
      const r = d.record(raw, ["kind", "cell"]);
      return {
        kind: d.choice(r.kind, "cell-slot", "cell-state"),
        cell: d.id("cell", r.cell),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
