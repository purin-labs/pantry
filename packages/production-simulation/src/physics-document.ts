import * as d from "./document-values.ts";
import type * as P from "./physics.ts";

export function checkpoint(raw: unknown): P.CheckpointRef {
  const r = d.record(raw, ["digest", "byteLength", "step"]);
  return {
    digest: d.digest(r.digest),
    byteLength: d.positive(r.byteLength),
    step: d.steps(r.step),
  };
}
export function disposition(raw: unknown): P.CarrierDisposition {
  return d.choice(raw, "source", "tool", "destination", "unknown");
}
export function nativeEvent(raw: unknown): P.NativeEvent {
  const kind = d.kind(raw);
  const r = d.record(
    raw,
    kind === "failure"
      ? ["kind", "step", "controllerSequence", "disposition", "reason"]
      : ["kind", "step", "controllerSequence"],
  );
  const step = d.steps(r.step);
  const controllerSequence = d.natural(r.controllerSequence);
  switch (kind) {
    case "pickup":
      return { kind, step, controllerSequence };
    case "placement":
    case "carrier-removed":
      return { kind, step, controllerSequence };
    case "failure":
      return {
        kind,
        step,
        controllerSequence,
        disposition: disposition(r.disposition),
        reason: d.text(r.reason),
      };
    default:
      throw new d.InvalidDocument();
  }
}
function measurement(raw: unknown): P.Measurement {
  const r = d.record(raw, ["measurement", "quantity"]);
  return {
    measurement: d.authored("measurement", r.measurement),
    quantity: d.quantity(r.quantity),
  };
}
export function terminal(raw: unknown): P.Terminal {
  d.requireValue(isRecord(raw));
  const outcome = d.text(raw.outcome);
  const r = d.record(raw, [
    "runId",
    "executionId",
    "cellId",
    "attemptId",
    "kind",
    "sequence",
    "steps",
    "segments",
    "outcome",
    "checkpoint",
    ...(outcome === "failed" ? ["disposition"] : []),
    // Documents saved before measured outputs carry no measurements.
    ...(outcome === "completed" && "measurements" in raw
      ? ["measurements"]
      : []),
  ]);
  const head = {
    kind: d.choice(r.kind, "terminal"),
    runId: d.id("run", r.runId),
    executionId: d.id("execution", r.executionId),
    cellId: d.id("cell", r.cellId),
    attemptId: d.id("attempt", r.attemptId),
    sequence: d.natural(r.sequence),
    steps: d.steps(r.steps),
    segments: d.array(r.segments, d.natural),
  };
  switch (outcome) {
    case "completed":
      return {
        ...head,
        outcome,
        checkpoint: checkpoint(r.checkpoint),
        measurements:
          r.measurements === undefined
            ? []
            : d.array(r.measurements, measurement),
      };
    case "failed":
      return {
        ...head,
        outcome,
        checkpoint: d.nullable(r.checkpoint, checkpoint),
        disposition: disposition(r.disposition),
      };
    default:
      throw new d.InvalidDocument();
  }
}
function recovery(raw: unknown): P.RecoveryBoundary {
  switch (d.kind(raw)) {
    case "none":
      d.record(raw, ["kind"]);
      return { kind: "none" };
    case "checkpoint": {
      const r = d.record(raw, ["kind", "checkpoint"]);
      return { kind: "checkpoint", checkpoint: checkpoint(r.checkpoint) };
    }
    default:
      throw new d.InvalidDocument();
  }
}
export function lifecycle(raw: unknown): P.AttemptLifecycle {
  switch (d.kind(raw)) {
    case "dispatched":
      d.record(raw, ["kind"]);
      return { kind: "dispatched" };
    case "running":
      d.record(raw, ["kind"]);
      return { kind: "running" };
    case "pause-requested":
      d.record(raw, ["kind"]);
      return { kind: "pause-requested" };
    case "paused": {
      const r = d.record(raw, ["kind", "checkpoint"]);
      return { kind: "paused", checkpoint: checkpoint(r.checkpoint) };
    }
    case "completed": {
      const r = d.record(raw, ["kind", "checkpoint", "steps"]);
      return {
        kind: "completed",
        checkpoint: checkpoint(r.checkpoint),
        steps: d.steps(r.steps),
      };
    }
    case "failed": {
      const r = d.record(raw, ["kind", "steps", "disposition", "retained"]);
      return {
        kind: "failed",
        steps: d.steps(r.steps),
        disposition: disposition(r.disposition),
        retained: recovery(r.retained),
      };
    }
    case "aborted": {
      const r = d.record(raw, ["kind", "recoverable"]);
      return { kind: "aborted", recoverable: recovery(r.recoverable) };
    }
    default:
      throw new d.InvalidDocument();
  }
}
export function slot(raw: unknown): P.CarrierSlot {
  switch (d.kind(raw)) {
    case "inactive": {
      const r = d.record(raw, ["kind", "generation"]);
      return { kind: "inactive", generation: d.natural(r.generation) };
    }
    case "active": {
      const r = d.record(raw, ["kind", "generation", "carrier"]);
      return {
        kind: "active",
        generation: d.natural(r.generation),
        carrier: d.id("carrier", r.carrier),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
export function hold(raw: unknown): P.HoldState {
  switch (d.kind(raw)) {
    case "evolving":
      d.record(raw, ["kind"]);
      return { kind: "evolving" };
    case "unresolved": {
      const r = d.record(raw, ["kind", "since"]);
      return { kind: "unresolved", since: d.time(r.since) };
    }
    case "settled": {
      const r = d.record(raw, ["kind", "model", "enteredAt", "until"]);
      return {
        kind: "settled",
        model: d.id("hold-model", r.model),
        enteredAt: d.time(r.enteredAt),
        until: d.time(r.until),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
export function origin(raw: unknown): P.DispatchOrigin {
  switch (d.kind(raw)) {
    case "original":
      d.record(raw, ["kind"]);
      return { kind: "original" };
    case "continuation": {
      const r = d.record(raw, [
        "kind",
        "sourceExecution",
        "sourceAttempt",
        "resumeFrom",
      ]);
      return {
        kind: "continuation",
        sourceExecution: d.id("execution", r.sourceExecution),
        sourceAttempt: d.id("attempt", r.sourceAttempt),
        resumeFrom: checkpoint(r.resumeFrom),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
import { isRecord } from "@purin-labs/std";
