import { coldCell } from "./workcell-instances.ts";
import { isCompletedLoading } from "@seams/bakery-model/bakery-physics";
import type {
  PhysicsRecording,
  PhysicsReplay,
  PhysicsSequence,
  PhysicsOutcome,
  PhysicsRackSequence,
} from "@seams/bakery-model/bakery-physics";
import type {
  WorkcellInput,
  WorkcellResource,
  TransferInput,
  AnyCycleInput,
  WorkcellTaskId,
  RackCycleInput,
} from "./workcell-input.ts";
import { physicsDuration, physicsOutcome } from "./physics-playback.ts";
import type { Variant, VariantBy } from "@seams/type-utils";
import { assertNever } from "@seams/std";

const lifecycle: unique symbol = Symbol("workcell attempt lifecycle");
export type WorkcellResourceStatus =
  AttemptProjection["resources"][WorkcellResource["role"]];

type QueuedResources = Readonly<{
  arm: "available";
  tool: "available";
  tray: "at-source";
  source: "occupied";
  destination: "available";
  cell: "available";
}>;

type ReservedResources = Readonly<{
  arm: "reserved";
  tool: "reserved";
  tray: "reserved";
  source: "occupied";
  destination: "reserved";
  cell: "reserved";
}>;
type ReleasedResources = Readonly<{
  arm: "available";
  tool: "available";
  tray: "at-destination";
  source: "available";
  destination: "occupied";
  cell: "available";
}>;
type ReturnedResources = Readonly<{
  arm: "available";
  tool: "available";
  tray: "at-source";
  source: "occupied";
  destination: "available";
  cell: "available";
}>;
type HeldResources = Readonly<{
  arm: "held";
  tool: "held";
  tray: "held";
  source: "held";
  destination: "held";
  cell: "held";
}>;
type AttemptIdentity = Readonly<{
  input: WorkcellInput;
}>;
type FailedRecording = PhysicsRecording &
  Readonly<{
    outcome: Exclude<PhysicsOutcome, { kind: "completed" }>;
  }>;
export type WorkcellEvidence =
  | Readonly<{
      mode: "rack-cycle";
      input: RackCycleInput;
      recording: PhysicsRackSequence;
    }>
  | Readonly<{
      mode: "transfer";
      input: TransferInput;
      recording: PhysicsRecording;
    }>
  | Readonly<{
      mode: "oven-cycle";
      input: Exclude<AnyCycleInput, RackCycleInput>;
      recording: PhysicsSequence;
    }>
  | Readonly<{
      mode: "cycle-loading-failed";
      input: AnyCycleInput;
      recording: FailedRecording;
    }>;
export type WaitingAttempt = AttemptIdentity &
  Readonly<{
    [lifecycle]: "awaiting-evidence";
    kind: "awaiting-evidence";
    resources: ReservedResources;
    recording?: never;
    settledTime?: never;
  }>;
export type CompletedAttempt = (
  | (VariantBy<WorkcellEvidence, "mode", "transfer"> &
      Readonly<{ resources: ReleasedResources }>)
  | (VariantBy<WorkcellEvidence, "mode", "oven-cycle"> &
      Readonly<{ resources: ReturnedResources }>)
  | (VariantBy<WorkcellEvidence, "mode", "rack-cycle"> &
      Readonly<{ resources: ReleasedResources }>)
) &
  Readonly<{
    [lifecycle]: "completed";
    kind: "completed";
    settledTime: number;
  }>;
export type HeldAttempt = WorkcellEvidence &
  Readonly<{
    [lifecycle]: "recovery-required";
    kind: "recovery-required";
    resources: HeldResources;
    settledTime: number;
  }>;
export type LoadingEvidence = Readonly<{
  mode: "cycle-loading";
  input: Exclude<AnyCycleInput, RackCycleInput>;
  recording: PhysicsSequence["loading"];
}>;
export type AwaitingReturnAttempt = LoadingEvidence &
  Readonly<{
    [lifecycle]: "awaiting-return";
    kind: "awaiting-return";
    loadingCompletedTime: number;
    settledTime?: never;
    resources: Readonly<{
      arm: "reserved";
      tool: "reserved";
      tray: "reserved";
      source: "reserved";
      destination: "occupied";
      cell: "reserved";
    }>;
  }>;
export type ActiveAttempt =
  WaitingAttempt | CompletedAttempt | HeldAttempt | AwaitingReturnAttempt;
export type WorkcellAttempt =
  | Readonly<{
      kind: "empty";
      input?: never;
      resources?: never;
      recording?: never;
    }>
  | ActiveAttempt;
type Rejection = Readonly<{
  kind: "rejected";
  message: string;
  attempt?: never;
}>;
export type ReservationResult =
  | Readonly<{
      kind: "reserved";
      attempt: WaitingAttempt;
      message?: never;
    }>
  | Rejection;
export type SettlementResult =
  | Readonly<{
      kind: "accepted" | "duplicate";
      attempt: CompletedAttempt | HeldAttempt | AwaitingReturnAttempt;
      message?: never;
    }>
  | Rejection;

export function reserveWorkcell(
  current: WorkcellAttempt,
  input: WorkcellInput,
): ReservationResult {
  if (current.kind !== "empty") {
    return {
      kind: "rejected",
      message:
        "This cell already has a prepared run. Its evidence and resource allocations are kept.",
    };
  }
  return {
    kind: "reserved",
    attempt: {
      [lifecycle]: "awaiting-evidence",
      kind: "awaiting-evidence",
      input,
      resources: {
        arm: "reserved",
        tool: "reserved",
        tray: "reserved",
        source: "occupied",
        destination: "reserved",
        cell: "reserved",
      },
    },
  };
}

export function settleWorkcell(
  attempt: ActiveAttempt,
  recording: PhysicsReplay,
): SettlementResult {
  if (attempt.kind === "awaiting-return") {
    if (JSON.stringify(attempt.recording) === JSON.stringify(recording))
      return { kind: "duplicate", attempt };
    if (
      recording.kind === "bakery-physics-recording" ||
      JSON.stringify(recording.loading) !== JSON.stringify(attempt.recording)
    )
      return {
        kind: "rejected",
        message:
          "Unloading must continue the accepted loading result. The existing loading evidence and reservations were kept.",
      };
  }
  if (
    attempt.kind === "awaiting-evidence" &&
    attempt.input.kind !== "transfer" &&
    attempt.input.kind !== "rack-cycle" &&
    recording.kind === "bakery-physics-recording" &&
    isCompletedLoading(recording) &&
    sameRequest(attempt.input.request, recording.request)
  ) {
    return {
      kind: "accepted",
      attempt: {
        [lifecycle]: "awaiting-return",
        kind: "awaiting-return",
        mode: "cycle-loading",
        input: attempt.input,
        recording,
        loadingCompletedTime:
          attempt.input.dispatch.time + physicsDuration(recording),
        resources: {
          arm: "reserved",
          tool: "reserved",
          tray: "reserved",
          source: "reserved",
          destination: "occupied",
          cell: "reserved",
        },
      },
    };
  }
  const evidence = matchEvidence(attempt.input, recording);
  if (evidence === null) {
    return {
      kind: "rejected",
      message:
        "Recording does not match this run. Task requests and cycle handoff must match exactly. A cycle accepts successful loading first, then its matching continuous return. Reservations kept.",
    };
  }
  if (
    attempt.kind !== "awaiting-evidence" &&
    attempt.kind !== "awaiting-return"
  ) {
    if (JSON.stringify(attempt.recording) === JSON.stringify(recording)) {
      return { kind: "duplicate", attempt };
    }
    return {
      kind: "rejected",
      message:
        "A different recording already settled this attempt. The accepted evidence and allocations were kept.",
    };
  }
  const settledTime = attempt.input.dispatch.time + physicsDuration(recording);
  if (
    evidence.mode !== "cycle-loading-failed" &&
    physicsOutcome(recording).kind === "completed"
  ) {
    return {
      kind: "accepted",
      attempt: completeEvidence(evidence, settledTime),
    };
  }
  return {
    kind: "accepted",
    attempt: {
      [lifecycle]: "recovery-required",
      kind: "recovery-required",
      ...evidence,
      settledTime,
      resources: {
        arm: "held",
        tool: "held",
        tray: "held",
        source: "held",
        destination: "held",
        cell: "held",
      },
    },
  };
}

function completeEvidence(
  evidence: Exclude<WorkcellEvidence, { mode: "cycle-loading-failed" }>,
  settledTime: number,
): CompletedAttempt {
  if (evidence.mode === "rack-cycle")
    return {
      [lifecycle]: "completed",
      kind: "completed",
      mode: "rack-cycle",
      input: evidence.input,
      recording: evidence.recording,
      settledTime,
      resources: {
        arm: "available",
        tool: "available",
        tray: "at-destination",
        source: "available",
        destination: "occupied",
        cell: "available",
      },
    };
  if (evidence.mode === "oven-cycle")
    return {
      [lifecycle]: "completed",
      kind: "completed",
      mode: "oven-cycle",
      input: evidence.input,
      recording: evidence.recording,
      settledTime,
      resources: {
        arm: "available",
        tool: "available",
        tray: "at-source",
        source: "occupied",
        destination: "available",
        cell: "available",
      },
    };
  return {
    [lifecycle]: "completed",
    kind: "completed",
    mode: "transfer",
    input: evidence.input,
    recording: evidence.recording,
    settledTime,
    resources: {
      arm: "available",
      tool: "available",
      tray: "at-destination",
      source: "available",
      destination: "occupied",
      cell: "available",
    },
  };
}

export function recordingMatchesInput(
  input: WorkcellInput,
  recording: PhysicsReplay,
): boolean {
  if (input.kind === "rack-cycle") {
    if (recording.kind === "bakery-physics-recording")
      return (
        sameRequest(input.request, recording.request) &&
        failedRecording(recording)
      );
    return (
      recording.kind === "bakery-physics-rack-sequence" &&
      sameRequest(input.request, recording.loading.request) &&
      sameRequest(input.returnRequest, recording.unloading.request) &&
      sameRequest(input.rackPlan.rackRequest, recording.racking.request) &&
      input.handoffDigest === recording.loadingHandoffDigest &&
      input.rackPlan.rackHandoffDigest === recording.handoffDigest
    );
  }
  if (recording.kind === "bakery-physics-rack-sequence") return false;
  if (input.kind === "transfer")
    return (
      recording.kind === "bakery-physics-recording" &&
      sameRequest(input.request, recording.request)
    );
  if (recording.kind === "bakery-physics-recording")
    return (
      sameRequest(input.request, recording.request) &&
      (failedRecording(recording) || isCompletedLoading(recording))
    );
  return (
    sameRequest(input.request, recording.loading.request) &&
    (input.kind !== "oven-cycle" ||
      (sameRequest(input.returnRequest, recording.unloading.request) &&
        input.handoffDigest === recording.handoffDigest))
  );
}

function matchEvidence(
  input: WorkcellInput,
  recording: PhysicsReplay,
): WorkcellEvidence | null {
  if (!recordingMatchesInput(input, recording)) return null;
  if (
    input.kind === "rack-cycle" &&
    recording.kind === "bakery-physics-rack-sequence"
  )
    return { mode: "rack-cycle", input, recording };
  if (
    input.kind === "transfer" &&
    recording.kind === "bakery-physics-recording"
  )
    return { mode: "transfer", input, recording };
  if (input.kind !== "transfer") {
    if (
      recording.kind === "bakery-physics-sequence" &&
      input.kind !== "rack-cycle"
    )
      return { mode: "oven-cycle", input, recording };
    if (
      recording.kind === "bakery-physics-recording" &&
      failedRecording(recording)
    )
      return { mode: "cycle-loading-failed", input, recording };
  }
  return null;
}

export function attemptRecording(attempt: ActiveAttempt): PhysicsReplay | null {
  switch (attempt.kind) {
    case "awaiting-evidence":
      return null;
    case "awaiting-return":
    case "completed":
    case "recovery-required":
      return attempt.recording;
    default:
      return assertNever(attempt, "Unexpected workcell state");
  }
}

function sameRequest(
  first: PhysicsRecording["request"] | PhysicsSequence["unloading"]["request"],
  second: PhysicsRecording["request"] | PhysicsSequence["unloading"]["request"],
): boolean {
  // The parser normalizes request field order at ingress.
  return JSON.stringify(first) === JSON.stringify(second);
}

function failedRecording(
  recording: PhysicsRecording,
): recording is FailedRecording {
  return recording.outcome.kind !== "completed";
}

export type AttemptProjection =
  | Readonly<{
      kind: "awaiting-return";
      tray: "destination";
      resources: AwaitingReturnAttempt["resources"];
    }>
  | Readonly<{
      kind: "queued";
      tray: "source";
      resources: QueuedResources;
    }>
  | Readonly<{
      kind: "awaiting-evidence";
      tray: "source";
      resources: ReservedResources;
    }>
  | Readonly<{
      kind: "running";
      tray: "source" | "gripped" | "destination" | "oven";
      resources: Readonly<{
        arm: "reserved";
        tool: "reserved";
        tray: "reserved";
        source: "occupied" | "available" | "reserved";
        destination: "reserved" | "occupied" | "available";
        cell: "reserved";
      }>;
    }>
  | Readonly<{
      kind: "completed";
      tray: "destination" | "source";
      resources: ReleasedResources | ReturnedResources;
    }>
  | Readonly<{
      kind: "recovery-required";
      tray: "source" | "gripped" | "destination" | "unknown";
      resources: HeldResources;
    }>;

export function workcellAt(
  attempt: ActiveAttempt,
  time: number,
): AttemptProjection {
  if (time < attempt.input.dispatch.time) {
    return {
      kind: "queued",
      tray: "source",
      resources: {
        arm: "available",
        tool: "available",
        tray: "at-source",
        source: "occupied",
        destination: "available",
        cell: "available",
      },
    };
  }
  if (attempt.kind === "awaiting-evidence") {
    return {
      kind: "awaiting-evidence",
      tray: "source",
      resources: attempt.resources,
    };
  }
  if (attempt.kind === "awaiting-return") {
    if (time >= attempt.loadingCompletedTime)
      return {
        kind: "awaiting-return",
        tray: "destination",
        resources: attempt.resources,
      };
    return loadingAt(attempt, time);
  }
  if (time >= attempt.settledTime) {
    if (attempt.kind === "completed") {
      return {
        kind: "completed",
        tray: attempt.mode === "oven-cycle" ? "source" : "destination",
        resources: attempt.resources,
      };
    }
    const outcome = physicsOutcome(attempt.recording);
    let tray: "source" | "destination" | "gripped" | "unknown" =
      outcome.kind === "failed" ? outcome.trayDisposition : "unknown";
    if (attempt.mode === "oven-cycle") {
      if (tray === "source") tray = "destination";
      else if (tray === "destination") tray = "source";
    }
    return {
      kind: "recovery-required",
      tray,
      resources: attempt.resources,
    };
  }
  if (attempt.mode === "rack-cycle") return rackCycleAt(attempt, time);
  if (attempt.mode === "oven-cycle") return cycleAt(attempt, time);
  return loadingAt(attempt, time);
}

function loadingAt(
  attempt:
    | AwaitingReturnAttempt
    | Exclude<
        CompletedAttempt | HeldAttempt,
        { mode: "oven-cycle" | "rack-cycle" }
      >,
  time: number,
): Variant<AttemptProjection, "running"> {
  let tray: "source" | "gripped" | "destination" = "source";
  for (const event of attempt.recording.events) {
    if (
      attempt.input.dispatch.time +
        event.step * attempt.input.request.timestep >
      time
    )
      break;
    if (event.kind === "pickup") tray = "gripped";
    if (event.kind === "placement") tray = "destination";
  }
  let source: "occupied" | "reserved" | "available" = "occupied";
  if (tray !== "source") {
    source = attempt.input.kind !== "transfer" ? "reserved" : "available";
  }
  return {
    kind: "running",
    tray,
    resources: {
      arm: "reserved",
      tool: "reserved",
      tray: "reserved",
      cell: "reserved",
      source,
      destination: tray === "destination" ? "occupied" : "reserved",
    },
  };
}

function pickupTime(
  recording: PhysicsSequence["loading"] | PhysicsSequence["unloading"],
): number {
  for (const event of recording.events)
    if (event.kind === "pickup") return event.step * recording.request.timestep;
  return Infinity;
}

function cycleAt(
  attempt: VariantBy<CompletedAttempt | HeldAttempt, "mode", "oven-cycle">,
  time: number,
): Variant<AttemptProjection, "running"> {
  const dispatch = attempt.input.dispatch.time;
  const boundary = physicsDuration(attempt.recording.loading);
  const loaded = time >= dispatch + boundary;
  const pickedUp = loaded
    ? time >= dispatch + (boundary + pickupTime(attempt.recording.unloading))
    : time >= dispatch + pickupTime(attempt.recording.loading);
  let tray: "source" | "destination" | "gripped" = loaded
    ? "destination"
    : "source";
  if (pickedUp) tray = "gripped";
  let destination: "reserved" | "occupied" | "available" = "reserved";
  if (loaded) destination = pickedUp ? "available" : "occupied";
  return {
    kind: "running",
    tray,
    resources: {
      arm: "reserved",
      tool: "reserved",
      tray: "reserved",
      cell: "reserved",
      source: !loaded && !pickedUp ? "occupied" : "reserved",
      destination,
    },
  };
}

function rackCycleAt(
  attempt: VariantBy<CompletedAttempt | HeldAttempt, "mode", "rack-cycle">,
  time: number,
): Variant<AttemptProjection, "running"> {
  const elapsed = time - attempt.input.dispatch.time;
  const loadingEnd = physicsDuration(attempt.recording.loading);
  const returnEnd = loadingEnd + physicsDuration(attempt.recording.unloading);
  let tray: "source" | "gripped" | "destination" | "oven" = "source";
  let source: "occupied" | "reserved" | "available" = "occupied";
  const legs = [
    {
      recording: attempt.recording.loading,
      start: 0,
      destination: "oven",
      tableAfterPickup: "reserved",
    },
    {
      recording: attempt.recording.unloading,
      start: loadingEnd,
      destination: "source",
      tableAfterPickup: "reserved",
    },
    {
      recording: attempt.recording.racking,
      start: returnEnd,
      destination: "destination",
      tableAfterPickup: "available",
    },
  ] as const;
  for (const leg of legs) {
    if (elapsed < leg.start) break;
    for (const event of leg.recording.events) {
      if (leg.start + event.step * leg.recording.request.timestep > elapsed)
        break;
      if (event.kind === "pickup") {
        tray = "gripped";
        source = leg.tableAfterPickup;
      }
      if (event.kind === "placement") {
        tray = leg.destination;
        if (tray === "source") source = "occupied";
      }
    }
  }
  return {
    kind: "running",
    tray,
    resources: {
      arm: "reserved",
      tool: "reserved",
      tray: "reserved",
      cell: "reserved",
      source,
      destination: tray === "destination" ? "occupied" : "reserved",
    },
  };
}

export function workcellResourceAt(
  attempt: ActiveAttempt,
  time: number,
  resource: WorkcellResource,
): WorkcellResourceStatus {
  const projection = workcellAt(attempt, time);
  if (
    attempt.input.kind !== "rack-cycle" ||
    resource.id !==
      coldCell(attempt.input.bindings.cell).skills["table-to-oven"].destination
  )
    return projection.resources[resource.role];
  switch (projection.kind) {
    case "queued":
    case "completed":
      return "available";
    case "recovery-required":
      return "held";
    case "awaiting-evidence":
      return "reserved";
    case "awaiting-return":
      return "occupied";
    case "running":
      if (
        attempt.kind === "awaiting-evidence" ||
        attempt.kind === "awaiting-return" ||
        attempt.mode !== "rack-cycle"
      )
        return "reserved";
      if (projection.tray === "oven") return "occupied";
      return time >=
        attempt.input.dispatch.time +
          physicsDuration(attempt.recording.loading) +
          pickupTime(attempt.recording.unloading)
        ? "available"
        : "reserved";
    default:
      return assertNever(projection, "Unexpected workcell state");
  }
}

// A native task of the attempt: its recorded span, or unknown until evidence.
export type WorkcellTask = Readonly<{
  id: WorkcellTaskId;
  name: string;
  status: AttemptProjection["kind"] | "blocked";
  dependency: WorkcellTaskId | null;
  execution: "native";
  executor: "Robot";
  attemptId: string | null;
  timing:
    | Readonly<{ kind: "unknown" }>
    | Readonly<{ kind: "recorded"; start: number; end: number }>;
}>;

export function workcellTasks(
  attempt: ActiveAttempt,
  time: number,
): readonly [WorkcellTask, ...WorkcellTask[]] {
  const input = attempt.input;
  const state = workcellAt(attempt, time);
  if (input.kind === "rack-cycle") return rackCycleTasks(input, attempt, time);
  if (attempt.kind === "awaiting-return") {
    return [
      {
        id: attempt.input.taskInstanceId,
        execution: "native",
        executor: "Robot",
        name: "Load oven",
        attemptId: attempt.input.request.attemptId,
        status: time >= attempt.loadingCompletedTime ? "completed" : state.kind,
        dependency: null,
        timing: {
          kind: "recorded",
          start: attempt.input.dispatch.time,
          end: attempt.loadingCompletedTime,
        },
      },
      {
        id: attempt.input.returnTaskInstanceId,
        execution: "native",
        executor: "Robot",
        name: "Unload oven",
        attemptId:
          attempt.input.kind === "oven-cycle"
            ? attempt.input.returnRequest.attemptId
            : null,
        status:
          time >= attempt.loadingCompletedTime
            ? "awaiting-evidence"
            : "blocked",
        dependency: attempt.input.taskInstanceId,
        timing: { kind: "unknown" },
      },
    ];
  }
  const dispatchTime = attempt.input.dispatch.time;
  if (input.kind === "transfer")
    return [
      {
        id: input.taskInstanceId,
        execution: "native",
        executor: "Robot",
        name: "Robot transfer",
        attemptId: input.request.attemptId,
        status: state.kind,
        dependency: null,
        timing:
          attempt.kind === "awaiting-evidence"
            ? { kind: "unknown" }
            : {
                kind: "recorded",
                start: dispatchTime,
                end: attempt.settledTime,
              },
      },
    ];
  const sequence =
    attempt.kind !== "awaiting-evidence" && attempt.mode === "oven-cycle"
      ? attempt.recording
      : null;
  const boundary =
    sequence === null ? null : dispatchTime + physicsDuration(sequence.loading);
  const unloadingStarted = boundary !== null && time >= boundary;
  return [
    {
      id: input.taskInstanceId,
      execution: "native",
      executor: "Robot",
      name: "Load oven",
      attemptId: input.request.attemptId,
      status: unloadingStarted ? "completed" : state.kind,
      dependency: null,
      timing:
        attempt.kind === "awaiting-evidence"
          ? { kind: "unknown" }
          : {
              kind: "recorded",
              start: dispatchTime,
              end: boundary ?? attempt.settledTime,
            },
    },
    {
      id: input.returnTaskInstanceId,
      execution: "native",
      executor: "Robot",
      name: "Unload oven",
      attemptId:
        sequence?.unloading.request.attemptId ??
        (input.kind === "oven-cycle" ? input.returnRequest.attemptId : null),
      status: unloadingStarted ? state.kind : "blocked",
      dependency: input.taskInstanceId,
      timing:
        boundary === null || attempt.kind === "awaiting-evidence"
          ? { kind: "unknown" }
          : { kind: "recorded", start: boundary, end: attempt.settledTime },
    },
  ];
}

function rackCycleTasks(
  input: RackCycleInput,
  attempt: ActiveAttempt,
  time: number,
): readonly [WorkcellTask, ...WorkcellTask[]] {
  const sequence =
    (attempt.kind === "completed" || attempt.kind === "recovery-required") &&
    attempt.mode === "rack-cycle"
      ? attempt.recording
      : null;
  let loading: PhysicsRecording | null = sequence?.loading ?? null;
  if (
    attempt.kind === "recovery-required" &&
    attempt.mode === "cycle-loading-failed"
  )
    loading = attempt.recording;
  const definitions = [
    {
      id: input.taskInstanceId,
      name: "Load oven",
      request: input.request,
      dependency: null,
      recording: loading,
    },
    {
      id: input.returnTaskInstanceId,
      name: "Unload oven",
      request: input.returnRequest,
      dependency: input.taskInstanceId,
      recording: sequence?.unloading ?? null,
    },
    {
      id: input.rackTaskInstanceId,
      name: "Transfer to cooling rack",
      request: input.rackPlan.rackRequest,
      dependency: input.returnTaskInstanceId,
      recording: sequence?.racking ?? null,
    },
  ] as const;
  const tasks: WorkcellTask[] = [];
  let start = input.dispatch.time;
  for (const definition of definitions) {
    const recording = definition.recording;
    let status: WorkcellTask["status"] = "blocked";
    let timing: WorkcellTask["timing"] = { kind: "unknown" };
    if (recording !== null) {
      const end = start + physicsDuration(recording);
      if (time < start) status = "queued";
      else if (time < end) status = "running";
      else if (recording.outcome.kind === "completed") status = "completed";
      else status = "recovery-required";
      timing = { kind: "recorded", start, end };
      start = end;
    } else if (definition.dependency === null)
      status = workcellAt(attempt, time).kind;
    tasks.push({
      id: definition.id,
      name: definition.name,
      dependency: definition.dependency,
      execution: "native",
      executor: "Robot",
      attemptId: definition.request.attemptId,
      status,
      timing,
    });
  }
  const first = tasks.shift();
  if (first === undefined)
    throw new Error("A rack cycle must contain loading.");
  return [first, ...tasks];
}

// The attempt's native span ends when its accepted evidence does, or at
// dispatch while evidence is awaited.
export function workcellEnd(
  input: WorkcellInput,
  recording: PhysicsReplay | null,
): number {
  return (
    input.dispatch.time + (recording === null ? 0 : physicsDuration(recording))
  );
}
