import { isRecord } from "@seams/std";
import * as d from "./document-values.ts";
import type {
  AcceptedEvent,
  ArrivalOrder,
  DomainEvent,
  OrderKey,
} from "./events.ts";
import { readStorageContents } from "./storage-document.ts";
import { disposition } from "./physics-document.ts";
import { readTaskWait } from "./scheduling-history-document.ts";

export function arrivalOrder(raw: unknown): ArrivalOrder {
  const r = d.record(raw, ["time", "source", "sequence"]);
  return {
    time: d.time(r.time),
    source: d.id("arrival-source", r.source),
    sequence: d.natural(r.sequence),
  };
}
export function orderKey(raw: unknown): OrderKey {
  d.requireValue(isRecord(raw));
  const time = d.time(raw.time);
  if (raw.phase === "dispatch") {
    const r = d.record(raw, ["time", "phase", "priority", "arrival", "task"]);
    return {
      time,
      phase: "dispatch",
      priority: d.integer(r.priority),
      arrival: arrivalOrder(r.arrival),
      task: d.id("task", r.task),
    };
  }
  switch (raw.origin) {
    case "native": {
      const r = d.record(raw, [
        "time",
        "phase",
        "origin",
        "cell",
        "attempt",
        "step",
        "controllerSequence",
      ]);
      return {
        time,
        phase: d.choice(r.phase, "settle"),
        origin: "native",
        cell: d.id("cell", r.cell),
        attempt: d.id("attempt", r.attempt),
        step: d.steps(r.step),
        controllerSequence: d.natural(r.controllerSequence),
      };
    }
    case "declared": {
      const r = d.record(raw, [
        "time",
        "phase",
        "origin",
        "arrival",
        "task",
        "boundary",
      ]);
      return {
        time,
        phase: d.choice(r.phase, "settle"),
        origin: "declared",
        arrival: arrivalOrder(r.arrival),
        task: d.id("task", r.task),
        boundary: d.choice(r.boundary, "pickup", "placement", "completion"),
      };
    }
    case "hold": {
      const r = d.record(raw, ["time", "phase", "origin", "cell"]);
      return {
        time,
        phase: d.choice(r.phase, "control"),
        origin: "hold",
        cell: d.id("cell", r.cell),
      };
    }
    case "command": {
      const r = d.record(raw, ["time", "phase", "origin", "admission"]);
      return {
        time,
        phase: d.choice(r.phase, "control"),
        origin: "command",
        admission: d.positive(r.admission),
      };
    }
    case "availability": {
      const r = d.record(raw, ["time", "phase", "origin", "cause", "edge"]);
      return {
        time,
        phase: d.choice(r.phase, "control"),
        origin: "availability",
        cause: d.id("availability", r.cause),
        edge: d.choice(r.edge, "start", "end"),
      };
    }
    case "arrival": {
      const r = d.record(raw, ["time", "phase", "origin", "arrival"]);
      return {
        time,
        phase: d.choice(r.phase, "control"),
        origin: "arrival",
        arrival: arrivalOrder(r.arrival),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function domainEvent(raw: unknown): DomainEvent {
  switch (d.kind(raw)) {
    case "waiting-changed": {
      const r = d.record(raw, ["kind", "waiting"]);
      return {
        kind: "waiting-changed",
        waiting: d.array(r.waiting, readTaskWait),
      };
    }
    case "storage-changed": {
      const r = d.record(raw, ["kind", "storage", "occupants", "reservations"]);
      const contents = readStorageContents(r);
      return {
        kind: "storage-changed",
        storage: d.id("storage", r.storage),
        occupants: contents.occupants,
        reservations: contents.reservations,
      };
    }
    case "resource-claimed": {
      const r = d.record(raw, [
        "kind",
        "resource",
        "task",
        "allocation",
        "units",
      ]);
      return {
        kind: "resource-claimed",
        resource: d.id("resource", r.resource),
        task: d.id("task", r.task),
        allocation: d.choice(r.allocation, "reserved", "occupied", "held"),
        units: d.positive(r.units),
      };
    }
    case "resource-released": {
      const r = d.record(raw, ["kind", "resource", "task"]);
      return {
        kind: "resource-released",
        resource: d.id("resource", r.resource),
        task: d.id("task", r.task),
      };
    }
    case "batch-member-rejected": {
      const r = d.record(raw, [
        "kind",
        "resource",
        "cycle",
        "task",
        "carrier",
        "recovery",
      ]);
      return {
        kind: "batch-member-rejected",
        resource: d.id("resource", r.resource),
        cycle: d.positive(r.cycle),
        task: d.id("task", r.task),
        carrier: d.id("carrier", r.carrier),
        recovery: d.id("task", r.recovery),
      };
    }
    case "batch-admitted": {
      const r = d.record(raw, [
        "kind",
        "resource",
        "cycle",
        "program",
        "task",
        "carrier",
        "closeAt",
      ]);
      return {
        kind: "batch-admitted",
        resource: d.id("resource", r.resource),
        cycle: d.positive(r.cycle),
        program: d.authored("batch-program", r.program),
        task: d.id("task", r.task),
        carrier: d.id("carrier", r.carrier),
        closeAt: d.time(r.closeAt),
      };
    }
    case "batch-started": {
      const r = d.record(raw, [
        "kind",
        "resource",
        "cycle",
        "program",
        "completesAt",
      ]);
      return {
        kind: "batch-started",
        resource: d.id("resource", r.resource),
        cycle: d.positive(r.cycle),
        program: d.authored("batch-program", r.program),
        completesAt: d.time(r.completesAt),
      };
    }
    case "batch-completed":
    case "batch-cleared": {
      const r = d.record(raw, ["kind", "resource", "cycle"]);
      return {
        kind: d.choice(r.kind, "batch-completed", "batch-cleared"),
        resource: d.id("resource", r.resource),
        cycle: d.positive(r.cycle),
      };
    }
    case "worker-assigned": {
      const r = d.record(raw, [
        "kind",
        "worker",
        "task",
        "from",
        "start",
        "finish",
        "arrivesAt",
        "completesAt",
      ]);
      return {
        kind: "worker-assigned",
        worker: d.id("resource", r.worker),
        task: d.id("task", r.task),
        from: d.authored("location", r.from),
        start: d.authored("location", r.start),
        finish: d.authored("location", r.finish),
        arrivesAt: d.time(r.arrivesAt),
        completesAt: d.time(r.completesAt),
      };
    }
    case "instance-arrived": {
      const r = d.record(raw, ["kind", "instance", "source", "arrival"]);
      return {
        kind: "instance-arrived",
        instance: d.id("workflow-instance", r.instance),
        source: d.id("arrival-source", r.source),
        arrival: d.natural(r.arrival),
      };
    }
    case "task-reserved": {
      const r = d.record(raw, ["kind", "task"]);
      return { kind: "task-reserved", task: d.id("task", r.task) };
    }
    case "decision-taken": {
      const r = d.record(raw, ["kind", "task", "outcome"]);
      return {
        kind: "decision-taken",
        task: d.id("task", r.task),
        outcome: d.choice(r.outcome, "accept", "reject"),
      };
    }
    case "task-skipped": {
      const r = d.record(raw, ["kind", "task", "inspection", "outcome"]);
      return {
        kind: "task-skipped",
        task: d.id("task", r.task),
        inspection: d.id("task", r.inspection),
        outcome: d.choice(r.outcome, "accept", "reject"),
      };
    }
    case "task-started":
    case "task-completed": {
      const r = d.record(raw, ["kind", "task", "attempt"]);
      return {
        kind: d.choice(r.kind, "task-started", "task-completed"),
        task: d.id("task", r.task),
        attempt: r.attempt === null ? null : d.id("attempt", r.attempt),
      };
    }
    case "task-failed": {
      const r = d.record(raw, ["kind", "task", "attempt", "disposition"]);
      return {
        kind: "task-failed",
        task: d.id("task", r.task),
        attempt: d.id("attempt", r.attempt),
        disposition: disposition(r.disposition),
      };
    }
    case "recovery-started": {
      const r = d.record(raw, ["kind", "task", "attempt", "command"]);
      return {
        kind: "recovery-started",
        task: d.id("task", r.task),
        attempt: d.id("attempt", r.attempt),
        command: d.id("command", r.command),
      };
    }
    case "recovery-completed":
    case "recovery-failed": {
      const r = d.record(raw, ["kind", "task", "attempt"]);
      return {
        kind: d.choice(r.kind, "recovery-completed", "recovery-failed"),
        task: d.id("task", r.task),
        attempt: d.id("attempt", r.attempt),
      };
    }
    case "carrier-acquired": {
      const r = d.record(raw, ["kind", "carrier", "instance", "role"]);
      return {
        kind: "carrier-acquired",
        carrier: d.id("carrier", r.carrier),
        instance: d.id("workflow-instance", r.instance),
        role: d.id("carrier-role", r.role),
      };
    }
    case "carrier-released": {
      const r = d.record(raw, ["kind", "carrier", "instance"]);
      return {
        kind: "carrier-released",
        carrier: d.id("carrier", r.carrier),
        instance: d.id("workflow-instance", r.instance),
      };
    }
    case "carrier-picked-up": {
      const r = d.record(raw, ["kind", "carrier", "task", "from"]);
      return {
        kind: "carrier-picked-up",
        carrier: d.id("carrier", r.carrier),
        task: d.id("task", r.task),
        from: d.id("storage", r.from),
      };
    }
    case "carrier-placed": {
      const r = d.record(raw, ["kind", "carrier", "task", "to"]);
      return {
        kind: "carrier-placed",
        carrier: d.id("carrier", r.carrier),
        task: d.id("task", r.task),
        to: d.id("storage", r.to),
      };
    }
    case "lot-produced": {
      const r = d.record(raw, ["kind", "lot", "product", "quantity", "task"]);
      return {
        kind: "lot-produced",
        lot: d.id("lot", r.lot),
        product: d.id("product", r.product),
        quantity: d.quantity(r.quantity),
        task: d.id("task", r.task),
      };
    }
    case "lot-consumed": {
      const r = d.record(raw, ["kind", "lot", "quantity", "task"]);
      return {
        kind: "lot-consumed",
        lot: d.id("lot", r.lot),
        quantity: d.quantity(r.quantity),
        task: d.id("task", r.task),
      };
    }
    case "lot-released": {
      const r = d.record(raw, ["kind", "lot", "task"]);
      return {
        kind: "lot-released",
        lot: d.id("lot", r.lot),
        task: d.id("task", r.task),
      };
    }
    case "quantity-reported": {
      const r = d.record(raw, [
        "kind",
        "destination",
        "role",
        "product",
        "quantity",
        "task",
      ]);
      return {
        kind: "quantity-reported",
        destination: d.id("destination", r.destination),
        role: d.choice(
          r.role,
          "final-output",
          "intermediate-stock",
          "rejected-output",
          "loss",
        ),
        product: d.id("product", r.product),
        quantity: d.quantity(r.quantity),
        task: d.id("task", r.task),
      };
    }
    case "order-completed": {
      const r = d.record(raw, ["kind", "instance"]);
      return {
        kind: "order-completed",
        instance: d.id("workflow-instance", r.instance),
      };
    }
    case "configuration-changed": {
      const r = d.record(raw, ["kind", "resource", "from", "to", "task"]);
      return {
        kind: "configuration-changed",
        resource: d.id("resource", r.resource),
        from: d.id("configuration", r.from),
        to: d.id("configuration", r.to),
        task: d.id("task", r.task),
      };
    }
    case "availability-changed": {
      const r = d.record(raw, ["kind", "resource", "available", "cause"]);
      return {
        kind: "availability-changed",
        resource: d.id("resource", r.resource),
        available: d.boolean(r.available),
        cause: d.id("availability", r.cause),
      };
    }
    case "command-admitted": {
      const r = d.record(raw, ["kind", "command", "controlRevision"]);
      return {
        kind: "command-admitted",
        command: d.id("command", r.command),
        controlRevision: d.positive(r.controlRevision),
      };
    }
    case "arrivals-closed": {
      const r = d.record(raw, ["kind", "source"]);
      return {
        kind: "arrivals-closed",
        source: d.id("arrival-source", r.source),
      };
    }
    case "cell-committed": {
      const r = d.record(raw, ["kind", "cell", "checkpoint", "boundary"]);
      return {
        kind: "cell-committed",
        cell: d.id("cell", r.cell),
        checkpoint: d.digest(r.checkpoint),
        boundary: r.boundary === null ? null : d.id("boundary", r.boundary),
      };
    }
    case "cell-hold": {
      const r = d.record(raw, ["kind", "cell", "state", "model"]);
      return {
        kind: "cell-hold",
        cell: d.id("cell", r.cell),
        state: d.choice(r.state, "entered", "left"),
        model: d.id("hold-model", r.model),
      };
    }
    case "limit-reached": {
      const r = d.record(raw, ["kind", "limit"]);
      return {
        kind: "limit-reached",
        limit: d.choice(r.limit, "horizon", "events"),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
export function acceptedEvent(raw: unknown): AcceptedEvent {
  d.requireValue(isRecord(raw));
  const { sequence, time, execution, ...event } = raw;
  return {
    sequence: d.positive(sequence),
    time: d.time(time),
    execution: d.id("execution", execution),
    ...domainEvent(event),
  };
}
