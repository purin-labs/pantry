import { readBlocker } from "./blocker-document.ts";
import type { AdmittedScenario } from "./admission.ts";
import type {
  CommandReceipt,
  ControlCommand,
  RecoveryRequest,
} from "./commands.ts";
import * as d from "./document-values.ts";
import { acceptedEvent, arrivalOrder, orderKey } from "./event-document.ts";
import * as p from "./physics-document.ts";
import { readConfigurationId, readTravelRoute } from "./scenario-document.ts";
import { readStorageContents } from "./storage-document.ts";
import type * as S from "./state.ts";

export function readState(
  raw: unknown,
  definition: AdmittedScenario,
): S.RunState {
  const r = d.record(raw, [
    "identity",
    "definition",
    "position",
    "status",
    "arrivals",
    "instances",
    "tasks",
    "resources",
    "storages",
    "carriers",
    "lots",
    "cells",
    "scheduled",
    "commands",
    "events",
  ]);
  const position = d.record(r.position, [
    "time",
    "eventSequence",
    "controlRevision",
    "horizon",
  ]);
  return {
    identity: identity(r.identity),
    definition,
    position: {
      time: d.time(position.time),
      eventSequence: d.natural(position.eventSequence),
      controlRevision: d.natural(position.controlRevision),
      horizon: d.time(position.horizon),
    },
    status: status(r.status),
    arrivals: d.array(r.arrivals, arrival),
    instances: d.array(r.instances, instance),
    tasks: d.array(r.tasks, task),
    resources: d.array(r.resources, resource),
    storages: d.array(r.storages, storage),
    carriers: d.array(r.carriers, carrier),
    lots: d.array(r.lots, lot),
    cells: d.array(r.cells, cell),
    scheduled: d.array(r.scheduled, scheduled),
    commands: d.array(r.commands, commandEntry),
    events: d.array(r.events, acceptedEvent),
  };
}
function parent(raw: unknown): NonNullable<S.ExecutionIdentity["parent"]> {
  const r = d.record(raw, ["snapshot", "execution"]);
  return {
    snapshot: d.id("snapshot", r.snapshot),
    execution: d.id("execution", r.execution),
  };
}
function identity(raw: unknown): S.ExecutionIdentity {
  const r = d.record(raw, [
    "runId",
    "executionId",
    "hostSession",
    "bundle",
    "parent",
  ]);
  return {
    runId: d.id("run", r.runId),
    executionId: d.id("execution", r.executionId),
    hostSession: d.id("host-session", r.hostSession),
    bundle: d.nullable(r.bundle, d.digest),
    parent: d.nullable(r.parent, parent),
  };
}
// Hosts only publish saves at a completed boundary. Pending physics is not a
// resumable state until its artifacts and restore procedure are implemented.
function status(raw: unknown): S.RunStatus {
  switch (d.kind(raw)) {
    case "awaiting-inspection": {
      const r = d.record(raw, ["kind", "task"]);
      return { kind: "awaiting-inspection", task: d.id("task", r.task) };
    }
    case "paused": {
      const r = d.record(raw, ["kind", "command", "boundary"]);
      return {
        kind: "paused",
        command: d.id("command", r.command),
        boundary: d.time(r.boundary),
      };
    }
    case "blocked": {
      const r = d.record(raw, ["kind", "tasks"]);
      const tasks = d.ids("task", r.tasks);
      const first = tasks[0];
      d.requireValue(first !== undefined);
      return { kind: "blocked", tasks: [first, ...tasks.slice(1)] };
    }
    case "completed": {
      const r = d.record(raw, ["kind", "completedAt"]);
      return { kind: "completed", completedAt: d.time(r.completedAt) };
    }
    case "stopped-at-limit": {
      const r = d.record(raw, ["kind", "limit", "unfinished"]);
      return {
        kind: "stopped-at-limit",
        limit: d.choice(r.limit, "horizon", "events"),
        unfinished: d.ids("task", r.unfinished),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
export function readTaskSubject(raw: unknown): S.TaskSubject {
  const kind = d.choice(d.kind(raw), "workflow", "changeover");
  if (kind === "workflow") {
    const r = d.record(raw, ["kind", "instance", "key"]);
    return {
      kind: "workflow",
      instance: d.id("workflow-instance", r.instance),
      key: d.id("task-key", r.key),
    };
  }
  const r = d.record(raw, ["kind", "resource", "from", "to", "cause"]);
  return {
    kind: d.choice(r.kind, "changeover"),
    resource: d.id("resource", r.resource),
    from: d.id("configuration", r.from),
    to: d.id("configuration", r.to),
    cause: d.id("task", r.cause),
  };
}
function task(raw: unknown): S.TaskState {
  const kind = d.kind(raw);
  switch (kind) {
    case "skipped": {
      const r = d.record(raw, [
        "id",
        "subject",
        "kind",
        "completedAt",
        "inspection",
        "outcome",
      ]);
      return {
        id: d.id("task", r.id),
        subject: readTaskSubject(r.subject),
        kind,
        completedAt: d.time(r.completedAt),
        inspection: d.id("task", r.inspection),
        outcome: d.choice(r.outcome, "accept", "reject"),
      };
    }
    case "waiting": {
      const r = d.record(raw, ["id", "subject", "kind", "since", "blockers"]);
      return {
        id: d.id("task", r.id),
        subject: readTaskSubject(r.subject),
        kind,
        since: d.time(r.since),
        blockers: d.array(r.blockers, readBlocker),
      };
    }
    case "reserved": {
      const r = d.record(raw, ["id", "subject", "kind", "reservedAt"]);
      return {
        id: d.id("task", r.id),
        subject: readTaskSubject(r.subject),
        kind,
        reservedAt: d.time(r.reservedAt),
      };
    }
    case "executing": {
      const r = d.record(raw, [
        "id",
        "subject",
        "kind",
        "startedAt",
        "attempt",
        "completesAt",
      ]);
      return {
        id: d.id("task", r.id),
        subject: readTaskSubject(r.subject),
        kind,
        startedAt: d.time(r.startedAt),
        attempt: r.attempt === null ? null : d.id("attempt", r.attempt),
        completesAt: d.nullable(r.completesAt, d.time),
      };
    }
    case "completed": {
      const r = d.record(raw, [
        "id",
        "subject",
        "kind",
        "startedAt",
        "completedAt",
      ]);
      return {
        id: d.id("task", r.id),
        subject: readTaskSubject(r.subject),
        kind,
        startedAt: d.time(r.startedAt),
        completedAt: d.time(r.completedAt),
      };
    }
    case "recovery-required": {
      const r = d.record(raw, [
        "id",
        "subject",
        "kind",
        "startedAt",
        "failedAt",
        "attempt",
        "disposition",
      ]);
      return {
        id: d.id("task", r.id),
        subject: readTaskSubject(r.subject),
        kind,
        startedAt: d.time(r.startedAt),
        failedAt: d.time(r.failedAt),
        attempt: d.id("attempt", r.attempt),
        disposition: p.disposition(r.disposition),
      };
    }
    case "recovering":
    case "recovery-failed": {
      const r = d.record(raw, [
        "id",
        "subject",
        "kind",
        "startedAt",
        "failedAt",
        "attempt",
        "disposition",
        "recovery",
      ]);
      return {
        id: d.id("task", r.id),
        subject: readTaskSubject(r.subject),
        kind,
        startedAt: d.time(r.startedAt),
        failedAt: d.time(r.failedAt),
        attempt: d.id("attempt", r.attempt),
        disposition: p.disposition(r.disposition),
        recovery: recoveryState(r.recovery),
      };
    }
    case "failed": {
      const r = d.record(raw, [
        "id",
        "subject",
        "kind",
        "startedAt",
        "failedAt",
        "attempt",
        "disposition",
        "resolvedAt",
      ]);
      return {
        id: d.id("task", r.id),
        subject: readTaskSubject(r.subject),
        kind,
        startedAt: d.time(r.startedAt),
        failedAt: d.time(r.failedAt),
        attempt: d.id("attempt", r.attempt),
        disposition: p.disposition(r.disposition),
        resolvedAt: d.time(r.resolvedAt),
      };
    }
    case "cancelled": {
      const r = d.record(raw, [
        "id",
        "subject",
        "kind",
        "cause",
        "cancelledAt",
      ]);
      return {
        id: d.id("task", r.id),
        subject: readTaskSubject(r.subject),
        kind,
        cause: d.id("task", r.cause),
        cancelledAt: d.time(r.cancelledAt),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function allocation(raw: unknown): S.Allocation {
  const r = d.record(raw, ["task", "units", "kind", "since"]);
  return {
    task: d.id("task", r.task),
    units: d.positive(r.units),
    kind: d.choice(r.kind, "reserved", "occupied", "held"),
    since: d.time(r.since),
  };
}
function withheld(raw: unknown): S.ResourceState["withheld"][number] {
  const r = d.record(raw, ["cause", "interval"]);
  return {
    cause: d.id("availability", r.cause),
    interval: d.interval(r.interval),
  };
}
function resource(raw: unknown): S.ResourceState {
  const r = d.record(raw, [
    "id",
    "position",
    "batch",
    "configuration",
    "changeovers",
    "allocations",
    "withheld",
  ]);
  return {
    id: d.id("resource", r.id),
    position: resourcePosition(r.position),
    batch: d.nullable(r.batch, batchState),
    configuration: readConfigurationId(r.configuration),
    changeovers: d.natural(r.changeovers),
    allocations: d.array(r.allocations, allocation),
    withheld: d.array(r.withheld, withheld),
  };
}
function batchMember(raw: unknown): S.BatchMember {
  const r = d.record(raw, ["task", "carrier"]);
  return { task: d.id("task", r.task), carrier: d.id("carrier", r.carrier) };
}
function batchMembers(
  raw: unknown,
): readonly [S.BatchMember, ...S.BatchMember[]] {
  const [first, ...rest] = d.array(raw, batchMember);
  d.requireValue(first !== undefined);
  return [first, ...rest];
}
function batchState(raw: unknown): S.BatchState {
  switch (d.kind(raw)) {
    case "idle": {
      const r = d.record(raw, ["kind", "sequence"]);
      return { kind: "idle", sequence: d.natural(r.sequence) };
    }
    case "loading": {
      const r = d.record(raw, [
        "kind",
        "sequence",
        "program",
        "openedAt",
        "closeAt",
        "members",
      ]);
      return {
        kind: "loading",
        sequence: d.positive(r.sequence),
        program: d.authored("batch-program", r.program),
        openedAt: d.time(r.openedAt),
        closeAt: d.time(r.closeAt),
        members: batchMembers(r.members),
      };
    }
    case "running": {
      const r = d.record(raw, [
        "kind",
        "sequence",
        "program",
        "startedAt",
        "completesAt",
        "members",
      ]);
      return {
        kind: "running",
        sequence: d.positive(r.sequence),
        program: d.authored("batch-program", r.program),
        startedAt: d.time(r.startedAt),
        completesAt: d.time(r.completesAt),
        members: batchMembers(r.members),
      };
    }
    case "unloading": {
      const r = d.record(raw, [
        "kind",
        "sequence",
        "program",
        "completedAt",
        "members",
      ]);
      return {
        kind: "unloading",
        sequence: d.positive(r.sequence),
        program: d.authored("batch-program", r.program),
        completedAt: d.time(r.completedAt),
        members: batchMembers(r.members),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function resourcePosition(raw: unknown): S.ResourcePosition {
  switch (d.kind(raw)) {
    case "fixed":
      d.record(raw, ["kind"]);
      return { kind: "fixed" };
    case "idle": {
      const r = d.record(raw, ["kind", "at"]);
      return { kind: "idle", at: d.authored("location", r.at) };
    }
    case "assigned": {
      const r = d.record(raw, [
        "kind",
        "task",
        "from",
        "start",
        "finish",
        "arrivesAt",
        "completesAt",
      ]);
      return {
        kind: "assigned",
        task: d.id("task", r.task),
        from: d.authored("location", r.from),
        start: d.authored("location", r.start),
        finish: d.authored("location", r.finish),
        arrivesAt: d.time(r.arrivesAt),
        completesAt: d.time(r.completesAt),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function storage(raw: unknown): S.StorageState {
  const r = d.record(raw, ["id", "occupants", "reservations"]);
  const contents = readStorageContents(r);
  return {
    id: d.id("storage", r.id),
    occupants: contents.occupants,
    reservations: contents.reservations,
  };
}
function custody(raw: unknown): S.CarrierCustody {
  switch (d.kind(raw)) {
    case "stored": {
      const r = d.record(raw, ["kind", "storage"]);
      return { kind: "stored", storage: d.id("storage", r.storage) };
    }
    case "transport": {
      const r = d.record(raw, ["kind", "task", "from", "to"]);
      return {
        kind: "transport",
        task: d.id("task", r.task),
        from: d.id("storage", r.from),
        to: d.id("storage", r.to),
      };
    }
    case "unknown": {
      const r = d.record(raw, ["kind", "task", "lastKnown"]);
      return {
        kind: "unknown",
        task: d.id("task", r.task),
        lastKnown: d.id("storage", r.lastKnown),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function binding(raw: unknown): NonNullable<S.CarrierState["bound"]> {
  const r = d.record(raw, ["instance", "role"]);
  return {
    instance: d.id("workflow-instance", r.instance),
    role: d.id("carrier-role", r.role),
  };
}
function carrier(raw: unknown): S.CarrierState {
  const r = d.record(raw, ["id", "custody", "bound"]);
  return {
    id: d.id("carrier", r.id),
    custody: custody(r.custody),
    bound: d.nullable(r.bound, binding),
  };
}
function lotClaim(raw: unknown): S.LotState["claims"][number] {
  const r = d.record(raw, ["task", "quantity"]);
  return { task: d.id("task", r.task), quantity: d.quantity(r.quantity) };
}
function lotOrigin(raw: unknown): S.LotState["origin"] {
  if (d.kind(raw) === "initial-stock") {
    d.record(raw, ["kind"]);
    return { kind: "initial-stock" };
  }
  const r = d.record(raw, ["kind", "task", "at"]);
  return {
    kind: d.choice(r.kind, "produced"),
    task: d.id("task", r.task),
    at: d.time(r.at),
  };
}
function holder(raw: unknown): S.LotState["holder"] {
  if (d.kind(raw) === "storage") {
    const r = d.record(raw, ["kind", "storage"]);
    return { kind: "storage", storage: d.id("storage", r.storage) };
  }
  const r = d.record(raw, ["kind", "carrier"]);
  return {
    kind: d.choice(r.kind, "carrier"),
    carrier: d.id("carrier", r.carrier),
  };
}
function lot(raw: unknown): S.LotState {
  const r = d.record(raw, [
    "id",
    "product",
    "remaining",
    "claims",
    "lineage",
    "origin",
    "disposition",
    "holder",
  ]);
  return {
    id: d.id("lot", r.id),
    product: d.id("product", r.product),
    remaining: d.quantity(r.remaining),
    claims: d.array(r.claims, lotClaim),
    lineage: d.ids("lot", r.lineage),
    origin: lotOrigin(r.origin),
    disposition: d.choice(r.disposition, "held", "released"),
    holder: holder(r.holder),
  };
}
function instanceCarrier(
  raw: unknown,
): S.WorkflowInstanceState["carriers"][number] {
  const r = d.record(raw, ["role", "carrier"]);
  return {
    role: d.id("carrier-role", r.role),
    carrier: d.id("carrier", r.carrier),
  };
}
function instanceLot(raw: unknown): S.WorkflowInstanceState["lots"][number] {
  const r = d.record(raw, ["key", "lot"]);
  return { key: d.id("lot-key", r.key), lot: d.id("lot", r.lot) };
}
function instance(raw: unknown): S.WorkflowInstanceState {
  const kind = d.kind(raw);
  const r = d.record(raw, [
    "id",
    "workflow",
    "demand",
    "arrival",
    "carriers",
    "lots",
    "kind",
    ...(kind === "completed" ? ["completedAt"] : []),
    ...(kind === "failed" ? ["failedAt", "cause"] : []),
  ]);
  const head = {
    id: d.id("workflow-instance", r.id),
    workflow: d.id("workflow", r.workflow),
    demand: d.choice(r.demand, "order", "production"),
    arrival: arrivalOrder(r.arrival),
    carriers: d.array(r.carriers, instanceCarrier),
    lots: d.array(r.lots, instanceLot),
  };
  if (kind === "completed")
    return { ...head, kind, completedAt: d.time(r.completedAt) };
  if (kind === "failed")
    return {
      ...head,
      kind,
      failedAt: d.time(r.failedAt),
      cause: d.id("task", r.cause),
    };
  return { ...head, kind: d.choice(kind, "open") };
}
function arrival(raw: unknown): S.ArrivalSourceState {
  const kind = d.kind(raw);
  const r = d.record(raw, [
    "id",
    "next",
    "kind",
    ...(kind === "closed" ? ["closedAt", "command"] : []),
  ]);
  const id = d.id("arrival-source", r.id);
  const next = d.natural(r.next);
  if (kind === "closed")
    return {
      id,
      next,
      kind,
      closedAt: d.time(r.closedAt),
      command: d.id("command", r.command),
    };
  return { id, next, kind: d.choice(kind, "open", "exhausted") };
}
function attempt(raw: unknown): NonNullable<S.CellState["attempt"]> {
  const r = d.record(raw, [
    "id",
    "task",
    "dispatchedAt",
    "startingCheckpoint",
    "origin",
    "lifecycle",
    "steps",
    "segments",
  ]);
  return {
    id: d.id("attempt", r.id),
    task: d.id("task", r.task),
    dispatchedAt: d.time(r.dispatchedAt),
    startingCheckpoint: d.digest(r.startingCheckpoint),
    origin: p.origin(r.origin),
    lifecycle: p.lifecycle(r.lifecycle),
    steps: d.steps(r.steps),
    segments: d.array(r.segments, d.digest),
  };
}
function cell(raw: unknown): S.CellState {
  const r = d.record(raw, [
    "id",
    "slot",
    "committed",
    "pending",
    "hold",
    "attempt",
    "prepared",
  ]);
  d.requireValue(
    r.pending === null && Array.isArray(r.prepared) && r.prepared.length === 0,
  );
  const committed = d.record(r.committed, ["checkpoint", "boundary", "clock"]);
  const clock = d.record(committed.clock, ["origin", "steps", "held"]);
  return {
    id: d.id("cell", r.id),
    slot: p.slot(r.slot),
    committed: {
      checkpoint: p.checkpoint(committed.checkpoint),
      boundary: d.time(committed.boundary),
      clock: {
        origin: d.time(clock.origin),
        steps: d.steps(clock.steps),
        held: d.duration(clock.held),
      },
    },
    pending: null,
    hold: p.hold(r.hold),
    attempt: d.nullable(r.attempt, attempt),
    prepared: [],
  };
}
function scheduled(raw: unknown): S.ScheduledEvent {
  const kind = d.kind(raw);
  switch (kind) {
    case "task-boundary": {
      const r = d.record(raw, ["kind", "order", "task", "carrierStep"]);
      return {
        kind,
        order: orderKey(r.order),
        task: d.id("task", r.task),
        carrierStep: d.nullable(r.carrierStep, d.natural),
      };
    }
    case "native-event": {
      const r = d.record(raw, ["kind", "order", "task", "event"]);
      return {
        kind,
        order: orderKey(r.order),
        task: d.id("task", r.task),
        event: p.nativeEvent(r.event),
      };
    }
    case "native-terminal": {
      const r = d.record(raw, ["kind", "order", "task", "terminal"]);
      return {
        kind,
        order: orderKey(r.order),
        task: d.id("task", r.task),
        terminal: p.terminal(r.terminal),
      };
    }
    case "availability-edge": {
      const r = d.record(raw, ["kind", "order", "resource", "cause"]);
      return {
        kind,
        order: orderKey(r.order),
        resource: d.id("resource", r.resource),
        cause: d.id("availability", r.cause),
      };
    }
    case "command": {
      const r = d.record(raw, ["kind", "order", "command"]);
      return {
        kind,
        order: orderKey(r.order),
        command: d.id("command", r.command),
      };
    }
    case "hold-entry":
    case "hold-expiry": {
      const r = d.record(raw, ["kind", "order", "cell"]);
      return { kind, order: orderKey(r.order), cell: d.id("cell", r.cell) };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function readInspectionLot(raw: unknown) {
  return d.id("lot", raw);
}

export function readControlCommand(raw: unknown): ControlCommand {
  const kind = d.kind(raw);
  const keys = [
    "kind",
    "commandId",
    "runId",
    "executionId",
    "hostSession",
    "expectedControlRevision",
  ];
  switch (kind) {
    case "inspect":
      keys.push("task", "definition", "lots", "outcome", "note");
      break;
    case "withhold-resource":
      keys.push("resource", "interval");
      break;
    case "update-worker-travel":
      keys.push("resource", "travel");
      break;
    case "close-arrivals":
      keys.push("source");
      break;
    case "extend-horizon":
      keys.push("horizon");
      break;
    case "recover":
      keys.push(
        "task",
        "resource",
        "storage",
        "handling",
        "attendance",
        "evidence",
        "reports",
      );
      break;
  }
  const r = d.record(raw, keys);
  const target = {
    commandId: d.id("command", r.commandId),
    runId: d.id("run", r.runId),
    executionId: d.id("execution", r.executionId),
    hostSession: d.id("host-session", r.hostSession),
    expectedControlRevision: d.natural(r.expectedControlRevision),
  };
  switch (kind) {
    case "inspect": {
      const note = d.text(r.note).trim();
      d.requireValue(note.length > 0 && note.length <= 1000);
      return {
        ...target,
        kind,
        task: d.id("task", r.task),
        definition: d.digest(r.definition),
        lots: d.array(r.lots, readInspectionLot),
        outcome: d.choice(r.outcome, "accept", "reject"),
        note,
      };
    }
    case "pause":
    case "resume":
      return { ...target, kind };
    case "withhold-resource":
      return {
        ...target,
        kind,
        resource: d.id("resource", r.resource),
        interval: d.interval(r.interval),
      };
    case "update-worker-travel":
      return {
        ...target,
        kind,
        resource: d.id("resource", r.resource),
        travel: d.array(r.travel, readTravelRoute),
      };
    case "close-arrivals":
      return { ...target, kind, source: d.id("arrival-source", r.source) };
    case "extend-horizon":
      return { ...target, kind, horizon: d.time(r.horizon) };
    case "recover":
      return { ...target, kind, ...recoveryRequest(r) };
    default:
      throw new d.InvalidDocument();
  }
}
function receipt(raw: unknown): CommandReceipt {
  // Only admitted commands are retained for deduplication.
  const r = d.record(raw, [
    "commandId",
    "runId",
    "executionId",
    "status",
    "controlRevision",
    "eventSequence",
    "effectiveAt",
  ]);
  return {
    commandId: d.id("command", r.commandId),
    runId: d.id("run", r.runId),
    executionId: d.id("execution", r.executionId),
    status: d.choice(r.status, "accepted"),
    controlRevision: d.positive(r.controlRevision),
    eventSequence: d.natural(r.eventSequence),
    effectiveAt: d.time(r.effectiveAt),
  };
}
function commandEntry(raw: unknown): S.RunState["commands"][number] {
  const r = d.record(raw, ["command", "receipt"]);
  return {
    command: readControlCommand(r.command),
    receipt: receipt(r.receipt),
  };
}

function recoveryReport(raw: unknown): RecoveryRequest["reports"][number] {
  const r = d.record(raw, ["product", "destination"]);
  return {
    product: d.id("product", r.product),
    destination: d.id("destination", r.destination),
  };
}
function recoveryRequest(
  r: Readonly<Record<string, unknown>>,
): RecoveryRequest {
  const handling = d.duration(r.handling);
  d.requireValue(handling > 0 && handling <= 300_000_000);
  return {
    task: d.id("task", r.task),
    resource: d.id("resource", r.resource),
    storage: d.id("storage", r.storage),
    handling,
    attendance: recoveryAttendance(r.attendance),
    evidence: d.choice(r.evidence, "model", "measured", "assumed"),
    reports: d.array(r.reports, recoveryReport),
  };
}
function recoveryAttendance(raw: unknown): RecoveryRequest["attendance"] {
  const kind = d.kind(raw);
  if (kind === "in-place") {
    d.record(raw, ["kind"]);
    return { kind };
  }
  d.requireValue(kind === "worker");
  const r = d.record(raw, ["kind", "location"]);
  return { kind, location: d.id("location", r.location) };
}
function recoveryState(raw: unknown): S.RecoveryState {
  const r = d.record(raw, [
    "task",
    "resource",
    "storage",
    "handling",
    "attendance",
    "evidence",
    "reports",
    "command",
    "attempt",
    "carrier",
    "startedAt",
    "arrivesAt",
    "removesAt",
    "phase",
  ]);
  return {
    ...recoveryRequest(r),
    command: d.id("command", r.command),
    attempt: d.id("attempt", r.attempt),
    carrier: d.id("carrier", r.carrier),
    startedAt: d.time(r.startedAt),
    arrivesAt: d.time(r.arrivesAt),
    removesAt: d.time(r.removesAt),
    phase: d.choice(r.phase, "handling", "returning"),
  };
}
