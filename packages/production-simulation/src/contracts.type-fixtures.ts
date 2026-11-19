import type { Variant } from "@purin-labs/type-utils";
import { withoutBatchMember } from "./engine-batches.ts";
import type { DomainEvent } from "./events.ts";

type RejectedBatchMember = Variant<DomainEvent, "batch-member-rejected">;
declare const rejectedMemberWithoutRecovery: Omit<
  RejectedBatchMember,
  "recovery"
>;
// @ts-expect-error Rejection must identify the completed recovery, including through a spread.
export const unprovenBatchRejection: RejectedBatchMember = {
  ...rejectedMemberWithoutRecovery,
};
declare const completedBatch: Variant<
  DomainEvent,
  "batch-completed" | "batch-cleared"
>;
// @ts-expect-error A completed cycle cannot become a member rejection without member identities.
export const incompleteBatchRejection: RejectedBatchMember = {
  ...completedBatch,
  kind: "batch-member-rejected",
};
declare const rejectedBatchMember: RejectedBatchMember;
import type { AdmittedScenario } from "./admission.ts";
import type {
  CommandReceipt,
  ControlCommand,
  PauseSettlement,
  RecoveryRequest,
} from "./commands.ts";
import type { ExecutionManifest, RetainedFile } from "./execution-bundle.ts";
import type { HostReply, HostRequest } from "./execution-host.ts";
import { submitCommand } from "./engine-commands.ts";
import { acceptSegment, supplyBoundary } from "./engine-physics.ts";
import { advanceRun, startRun } from "./engine.ts";
import {
  storeIdleRecording,
  storeHandoffRecording,
  type CellRecordingTime,
  type CellRecordingExecution,
} from "./cell-recording.ts";
import type {
  AttemptId,
  CarrierId,
  CommandId,
  ExecutionId,
  RunId,
  Sha256Hex,
  SnapshotId,
  TaskId,
  WorkflowInstanceId,
} from "./identity.ts";
import {
  admitSegment,
  type AttemptAddress,
  type AttemptLifecycle,
  type BoundaryRequest,
  type CarrierSlot,
  type CellRecording,
  type RestResult,
  type BoundaryCandidate,
  type CellStart,
  type CheckpointRef,
  type ExecutionBundle,
  type ExecutionNeed,
  type OperationDispatch,
  type HoldState,
  type StartOutcome,
  type Preview,
  type Segment,
  type SegmentCursor,
  type Terminal,
} from "./physics.ts";
import type { MaterialQuantity } from "./quantity.ts";
import type { RunDocument } from "./saved-run.ts";
import type {
  CompiledScenario,
  MaterialOutput,
  TaskExecutor,
  TaskDefinition,
  ResourceDefinition,
  InstanceTaskReference,
} from "./scenario.ts";

declare const reference: InstanceTaskReference;
// @ts-expect-error An instance reference requires an exact occurrence.
const missingOccurrence: InstanceTaskReference = {
  source: reference.source,
  key: reference.key,
};
const wrongReference: InstanceTaskReference = {
  ...reference,
  // @ts-expect-error Workflow instance identities cannot stand in for arrival sources.
  source: instanceId,
};
void [missingOccurrence, wrongReference];
import type {
  RunState,
  RunStatus,
  ScheduledEvent,
  TaskState,
  Blocker,
  ResourcePosition,
  BatchState,
} from "./state.ts";
import {
  advance,
  type LogicalTime,
  type StepCount,
  type TickDuration,
} from "./time.ts";

declare const runId: RunId;
declare const executionId: ExecutionId;
declare const commandId: CommandId;
declare const snapshotId: SnapshotId;
declare const instanceId: WorkflowInstanceId;
declare const attempt: AttemptId;
declare const carrier: CarrierId;
declare const digest: Sha256Hex;
declare const time: LogicalTime;
declare const duration: TickDuration;
declare const steps: StepCount;
declare const quantity: MaterialQuantity;
declare const scenario: CompiledScenario;
declare const taskDefinition: TaskDefinition;
declare const checkpoint: CheckpointRef;
declare const bundle: ExecutionBundle;
declare const state: RunState;
declare const cursor: SegmentCursor;
declare const preview: Preview;
declare const segment: Segment;
declare const waiting: Variant<TaskState, "waiting">;
declare const executing: Variant<TaskState, "executing">;
declare const workerResource: Variant<ResourceDefinition, "worker">;
declare const attended: Variant<TaskExecutor, "attended">;
declare const assignedPosition: Variant<ResourcePosition, "assigned">;
declare const batchExecutor: Variant<TaskExecutor, "batch">;
declare const runningBatch: Variant<BatchState, "running">;
// @ts-expect-error A running process cannot discard members through the recovery transition.
void withoutBatchMember(runningBatch, rejectedBatchMember.task);

// @ts-expect-error The cycle's program owns duration; a member cannot override it.
export const timedBatch: TaskExecutor = { ...batchExecutor, duration };

// @ts-expect-error Declared execution cannot retain batch membership fields.
export const mixedBatchExecutor: TaskExecutor = {
  ...batchExecutor,
  kind: "declared",
  duration,
  evidence: "model",
};

// @ts-expect-error An idle cycle cannot retain running membership and clocks.
export const mixedBatchState: BatchState = { ...runningBatch, kind: "idle" };

// @ts-expect-error Loading must state both its opening and admission deadline.
export const incompleteLoading: BatchState = {
  kind: "loading",
  sequence: 1,
  program: runningBatch.program,
  members: runningBatch.members,
};

// @ts-expect-error An idle state cannot be asserted into a running cycle.
export const assertedBatch = { kind: "idle" } as Variant<BatchState, "running">;

// @ts-expect-error A travelling worker cannot serve two tasks at once.
export const doubledWorker: ResourceDefinition = {
  ...workerResource,
  capacity: 2,
};

export const emptyAttendance: TaskExecutor = {
  kind: "attended",
  duration,
  evidence: "model",
  // @ts-expect-error Worker selection is nonempty, including direct construction.
  workers: [],
  start: attended.start,
  finish: attended.finish,
};

// @ts-expect-error An unattended executor cannot retain worker fields through a spread.
export const mixedExecutor: TaskExecutor = { ...attended, kind: "declared" };

// @ts-expect-error Idle state cannot retain an assignment through a spread.
export const mixedPosition: ResourcePosition = {
  ...assignedPosition,
  kind: "idle",
  at: attended.finish,
};

export const workerAsLocation: ResourcePosition = {
  kind: "idle",
  // @ts-expect-error A resource identity cannot stand in for a location.
  at: workerResource.id,
};

// @ts-expect-error A fixed resource cannot be asserted into an assigned worker.
export const castWorker = { kind: "fixed" } as Variant<
  ResourcePosition,
  "assigned"
>;

// Raw identities and values

// @ts-expect-error A raw string is not a parsed run identity.
export const rawRun: RunId = "run-1";

// @ts-expect-error One identity kind cannot stand in for another.
export const instanceAsTask: TaskId = instanceId;

// @ts-expect-error A continuation's execution is not its production ancestry.
export const executionAsRun: RunId = executionId;

// @ts-expect-error An authored number must pass the tick grid first.
export const rawTime: LogicalTime = 3_000;

// @ts-expect-error A span is not a position on the factory clock.
export const durationAsTime: LogicalTime = duration;

// @ts-expect-error Native steps convert to time only through the tick.
export const stepsAsDuration: TickDuration = steps;

// @ts-expect-error Advancing takes a parsed duration, not a raw number.
export const rawAdvance = advance(time, 2_000);

// @ts-expect-error A digest must be parsed before it binds anything.
export const rawDigest: Sha256Hex = "74c85b6f";

// Direct construction

// @ts-expect-error A quantity is normalized once, at admission.
export const rawQuantity: MaterialQuantity = { amount: 1, unit: "each" };

// @ts-expect-error A scenario is admitted only by validation.
export const selfAdmitted: AdmittedScenario = { scenario, digest };

// Compiled definitions

export const executorWithBoth: TaskExecutor = {
  kind: "declared",
  duration,
  evidence: "assumed",
  // @ts-expect-error A declared duration has no native operation.
  operation: { cell: "cell", skill: "skill", parameters: digest },
};

// @ts-expect-error Native work has no declared duration to schedule.
export const nativeWithDuration: TaskExecutor = { kind: "native", duration };

export const exitWithHolder: MaterialOutput = {
  kind: "exit",
  product: scenario.products[0]!.id,
  quantity,
  destination: scenario.destinations[0]!.id,
  // @ts-expect-error Material that exits stays in no factory position.
  holder: { kind: "storage", storage: scenario.storages[0]!.id },
};

// Task and run lifecycles

declare const taskWithoutRelease: Omit<TaskDefinition, "releaseAfter">;
// @ts-expect-error Every compiled task requires an explicit release delay.
export const missingRelease: TaskDefinition = { ...taskWithoutRelease };
export const rawRelease: TaskDefinition = {
  ...taskDefinition,
  // @ts-expect-error Raw numbers cannot become durations through a broad spread.
  releaseAfter: 1,
};
export const releaseBlocker: Blocker = { kind: "release", at: time };
// @ts-expect-error A prerequisite blocker cannot carry a release time.
export const mixedReleaseBlocker: Blocker = {
  ...releaseBlocker,
  kind: "prerequisite",
  task: waiting.id,
};
// @ts-expect-error A release blocker requires its exact logical time.
export const missingReleaseTime: Blocker = { kind: "release" };
// @ts-expect-error A cast cannot turn a release blocker into a prerequisite blocker.
export const castRelease = releaseBlocker as Variant<Blocker, "prerequisite">;

// @ts-expect-error A spread cannot turn waiting work into completed work.
export const spreadCompleted: TaskState = { ...waiting, kind: "completed" };

// @ts-expect-error Completed work carries no blockers.
export const completedWithBlockers: TaskState = {
  id: waiting.id,
  subject: waiting.subject,
  kind: "completed",
  startedAt: time,
  completedAt: time,
  blockers: waiting.blockers,
};

export const changeoverInInstance: TaskState = {
  id: waiting.id,
  subject: {
    kind: "changeover",
    resource: scenario.resources[0]!.id,
    from: scenario.resources[0]!.configuration!.initial,
    to: scenario.resources[0]!.configuration!.initial,
    cause: waiting.id,
    // @ts-expect-error A changeover task belongs to no workflow instance.
    instance: instanceId,
  },
  kind: "reserved",
  reservedAt: time,
};

// @ts-expect-error A lifecycle cast cannot skip the transition.
export const castCompleted = waiting as Variant<TaskState, "completed">;

// @ts-expect-error Executing work records when it started.
export const executingWithoutStart: TaskState = {
  id: executing.id,
  subject: executing.subject,
  kind: "executing",
  attempt,
  completesAt: null,
};

// @ts-expect-error A settled pause names its boundary.
export const pausedWithoutBoundary: RunStatus = {
  kind: "paused",
  command: commandId,
};

export const blockedAndComplete: RunStatus = {
  kind: "completed",
  completedAt: time,
  // @ts-expect-error A completed run has no blocked work.
  tasks: [waiting.id],
};

// Physics outputs and attempt lifecycles

// @ts-expect-error A preview is not an accepted segment and cannot advance a run.
export const previewAsSegment = admitSegment(cursor, preview, digest);

export const previewWithCheckpoint: Preview = {
  ...preview,
  // @ts-expect-error A preview carries no checkpoint to resume from.
  checkpoint,
};

// @ts-expect-error A paused attempt requires its validated checkpoint.
export const pausedWithoutCheckpoint: AttemptLifecycle = { kind: "paused" };

// @ts-expect-error An abort states its recoverable boundary or its absence.
export const abortedSilently: AttemptLifecycle = { kind: "aborted" };

// @ts-expect-error Running work has no settled checkpoint.
export const runningWithCheckpoint: AttemptLifecycle = {
  kind: "running",
  checkpoint,
};

// @ts-expect-error A completed terminal references its final checkpoint.
export const completedWithoutCheckpoint: Terminal = {
  runId,
  executionId,
  cellId: segment.cellId,
  attemptId: attempt,
  kind: "terminal",
  sequence: 1,
  steps,
  segments: [0],
  outcome: "completed",
};

// @ts-expect-error An inactive slot has no carrier binding.
export const inactiveWithCarrier: CarrierSlot = {
  kind: "inactive",
  generation: 0,
  carrier,
};

// @ts-expect-error An active slot binds exactly one carrier.
export const activeWithoutCarrier: CarrierSlot = {
  kind: "active",
  generation: 1,
};

// Engine operations

// @ts-expect-error A run starts only from an admitted scenario.
export const unadmittedStart = startRun({ scenario, digest }, state.identity);

// @ts-expect-error A run advances to a parsed logical time.
export const rawBoundary = advanceRun(state, 3_000);

export const rawCommand = submitCommand(state, {
  // @ts-expect-error A command names its target by parsed identities.
  commandId: "pause-1",
  runId,
  executionId,
  hostSession: state.identity.hostSession,
  expectedControlRevision: 0,
  kind: "pause",
});

export const editAsCommand = submitCommand(state, {
  commandId,
  runId,
  executionId,
  hostSession: state.identity.hostSession,
  expectedControlRevision: 0,
  // @ts-expect-error A recipe or layout edit is not a live command.
  kind: "change-recipe",
});

// Commands and saved runs

// @ts-expect-error An accepted command records its effective tick.
export const acceptedWithoutTick: CommandReceipt = {
  commandId,
  runId,
  executionId,
  status: "accepted",
  controlRevision: 1,
  eventSequence: 1,
};

// @ts-expect-error A rejected command never took effect.
export const rejectedWithTick: CommandReceipt = {
  commandId,
  runId,
  executionId,
  status: "rejected",
  reason: "stale_control_revision",
  effectiveAt: time,
};

// @ts-expect-error A pause without checkpoint coverage has no boundary.
export const unsettledWithBoundary: PauseSettlement = {
  commandId,
  kind: "recovery-required",
  cells: [segment.cellId],
  boundary: time,
};

// @ts-expect-error A resumable save names its retained execution bundle.
export const resumableWithoutBundle: RunDocument = {
  schemaVersion: 1,
  snapshot: snapshotId,
  artifacts: [],
  kind: "resumable",
  state,
};

// @ts-expect-error Evidence cannot become resumable through an added field.
export const evidenceWithState: RunDocument = {
  schemaVersion: 1,
  snapshot: snapshotId,
  artifacts: [],
  kind: "evidence",
  identity: state.identity,
  scenario,
  events: state.events,
  state,
};

// @ts-expect-error An evidence save resumes through no bundle.
export const evidenceWithBundle: RunDocument = {
  schemaVersion: 1,
  snapshot: snapshotId,
  artifacts: [],
  kind: "evidence",
  identity: state.identity,
  scenario,
  events: state.events,
  bundle,
};

declare const address: AttemptAddress;
declare const boundaryRequest: BoundaryRequest;
declare const idleRecording: Variant<CellRecording, "idle">;
declare const handoffRecording: Variant<CellRecording, "admission" | "removal">;
declare const restWithoutRecording: Omit<RestResult, "recording">;
declare const boundaryWithoutRecording: Omit<BoundaryCandidate, "recording">;

// @ts-expect-error A rest result requires solver observations, including through a spread.
export const restWithoutPoses: RestResult = { ...restWithoutRecording };

// @ts-expect-error Idle evolution cannot become a zero-time handoff through a spread.
export const idleAsHandoff: CellRecording = {
  ...idleRecording,
  kind: "admission",
};

export const handoffAsRest: RestResult = {
  ...restWithoutRecording,
  // @ts-expect-error Rest evidence requires an idle interval.
  recording: handoffRecording,
};

export const idleAsBoundary: BoundaryCandidate = {
  ...boundaryWithoutRecording,
  // @ts-expect-error A boundary change requires a handoff recording.
  recording: idleRecording,
};

declare const recordingExecution: CellRecordingExecution;

export const storeHandoffAsIdle = storeIdleRecording(
  recordingExecution,
  // @ts-expect-error The idle builder cannot accept a handoff.
  handoffRecording,
  state.position.time,
);

export const storeIdleAsHandoff = storeHandoffRecording(
  recordingExecution,
  // @ts-expect-error The handoff builder cannot accept an idle interval.
  idleRecording,
  state.position.time,
  boundaryRequest.boundary,
);

export const recordingWithoutAnExecutionBundle = storeIdleRecording(
  // @ts-expect-error A recording requires a pinned execution bundle.
  state.identity,
  idleRecording,
  state.position.time,
);

// @ts-expect-error A zero-time handoff cannot also have an idle interval.
export const handoffWithElapsedTime: CellRecordingTime = {
  kind: "admission",
  at: state.position.time,
  boundary: boundaryRequest.boundary,
  after: state.position.time,
  through: state.position.time,
};

// @ts-expect-error A run that waits on physics names the evidence it needs.
export const waitingOnNothing: RunStatus = { kind: "awaiting-execution" };

// @ts-expect-error An advance is bounded by a step allowance.
export const unboundedAdvance: ExecutionNeed = {
  kind: "advance",
  attempt: address,
};

// @ts-expect-error An idle cell advances under no attempt.
export const restAddressedToAnAttempt: ExecutionNeed = {
  kind: "rest",
  cellId: address.cellId,
  predecessor: digest,
  steps,
  stopAtHold: false,
  attempt: address,
};

// @ts-expect-error A boundary request cannot stand in for its candidate.
export const requestAsCandidate = supplyBoundary(state, boundaryRequest);

// @ts-expect-error A preview is no segment and cannot extend accepted history.
export const previewAccepted = acceptSegment(state, preview, digest);

// @ts-expect-error A restored world needs the content its checkpoint names.
export const restoreByReferenceAlone: CellStart = {
  kind: "restore",
  checkpoint,
  operation: null,
};

// @ts-expect-error A new world starts from its definition, not a checkpoint.
export const createdFromACheckpoint: CellStart = {
  kind: "create",
  modelHash: digest,
  checkpoint,
};

// @ts-expect-error A refused dispatch carries the terminal that ended it.
export const refusedWithoutEvidence: StartOutcome = { kind: "refused" };

// @ts-expect-error An attempt the controller has not started holds no state.
export const dispatchedWithCheckpoint: AttemptLifecycle = {
  kind: "dispatched",
  checkpoint,
};

declare const admitted: AdmittedScenario;
// @ts-expect-error Starting a run states which cell worlds were opened.
export const startedWithoutCells = startRun(admitted, state.identity);

declare const retainedFile: RetainedFile;

// @ts-expect-error A retained bundle names the runtime its engine drives.
export const manifestWithoutRuntime: ExecutionManifest = {
  schemaVersion: 1,
  bundle,
  engine: retainedFile,
};

export const fileWithRawDigest: RetainedFile = {
  file: "production-engine.mjs",
  // @ts-expect-error A retained file is named by a parsed digest.
  sha256: "0".repeat(64),
  byteLength: 1,
};

// @ts-expect-error A drive is bounded by a number of turns.
export const unboundedDrive: HostRequest = { kind: "drive", until: 2000 };

// @ts-expect-error A save hands over the artifacts it references.
export const saveWithoutArtifacts: HostReply = { kind: "saved", document: {} };

// @ts-expect-error A settled hold states where its qualification ends.
export const holdWithoutEnd: HoldState = {
  kind: "settled",
  model: state.cells[0]!.hold.model!,
  enteredAt: time,
};

declare const scheduled: ScheduledEvent;
declare const scheduledTask: TaskId;

// @ts-expect-error A hold entry cannot also carry a task boundary's fields.
export const mixedHoldEntry: ScheduledEvent = {
  kind: "hold-entry",
  order: scheduled.order,
  cell: address.cellId,
  task: scheduledTask,
};

// @ts-expect-error A broad spread cannot turn a task event into a hold event.
export const spreadHoldEntry: ScheduledEvent = {
  ...scheduled,
  kind: "hold-entry",
  cell: address.cellId,
};

// Recovery claims and controller intent stay separate from a completed task.
declare const failedTransfer: Variant<TaskState, "recovery-required">;
declare const recoveringTransfer: Variant<TaskState, "recovering">;
declare const untrustedNativePurpose: unknown;
declare const recoverCommand: Variant<ControlCommand, "recover">;
declare const recoveryLocation: Variant<
  RecoveryRequest["attendance"],
  "worker"
>;
// @ts-expect-error Worker recovery must name its location.
export const recoveryWithoutLocation: RecoveryRequest["attendance"] = {
  kind: "worker",
};
// @ts-expect-error In-place recovery cannot carry a worker location through a spread.
export const stationaryWithLocation: RecoveryRequest["attendance"] = {
  ...recoveryLocation,
  kind: "in-place",
};
// @ts-expect-error The host worker command needs a declared recovery location.
export const workerRecoveryWithoutLocation: HostRequest = {
  kind: "recover-with-worker",
  commandId: "recover",
  task: "task",
  resource: "worker",
  storage: "reject",
  handling: 1_000_000,
  evidence: "assumed",
  reports: [],
};

// @ts-expect-error A recovery payload cannot become a pause through a broad spread.
export const pauseWithRecoveryPayload: ControlCommand = {
  ...recoverCommand,
  kind: "pause",
};
declare const recoveryPurpose: Variant<
  OperationDispatch["purpose"],
  "recovery"
>;

// @ts-expect-error Recovery requires its carrier, human, reject storage and duration.
export const recoveryWithoutClaims: TaskState = {
  ...failedTransfer,
  kind: "recovering",
};

// @ts-expect-error A resolved failure cannot retain an active recovery through a broad spread.
export const failedWithActiveRecovery: TaskState = {
  ...recoveringTransfer,
  kind: "failed",
  resolvedAt: time,
};

// @ts-expect-error A workflow dispatch cannot carry recovery parameters through a spread.
export const workflowWithRecoveryParameters: OperationDispatch["purpose"] = {
  ...recoveryPurpose,
  kind: "workflow",
};

// @ts-expect-error Unknown native intent requires a boundary decoder.
export const unparsedOperationPurpose: OperationDispatch["purpose"] =
  untrustedNativePurpose;

import type { RecoveryView } from "./execution-view.ts";

declare const recoveringView: Variant<
  RecoveryView,
  "recovering" | "recovery-failed"
>;

// @ts-expect-error Pending recovery has no handling or return phase, even through a spread.
export const pendingWithRecoveryPhase: RecoveryView = {
  ...recoveringView,
  kind: "recovery-required",
};

// @ts-expect-error Active recovery must name its resource, storage and duration.
export const incompleteRecoveryView: RecoveryView = {
  kind: "recovering",
  task: "tray-orders#0/transfer",
  failedAt: 22_198_000,
};

import type { LogisticsView, TaskView } from "./logistics-view.ts";

declare const waitingTaskView: Variant<TaskView, "waiting">;
declare const untrustedTaskView: unknown;

// @ts-expect-error Completed tasks cannot retain waiting blockers through a spread.
export const completedWithWaitingBlockers: TaskView = {
  ...waitingTaskView,
  kind: "completed",
  startedAt: 0,
  completedAt: 2_000,
};

// @ts-expect-error A native execution must explicitly declare its unknown end.
export const executionWithoutEnd: TaskView = {
  id: "order#0/load",
  subject: waitingTaskView.subject,
  kind: "executing",
  startedAt: 0,
};

// @ts-expect-error Unknown worker data requires the host boundary decoder.
export const unparsedTaskView: TaskView = untrustedTaskView;

// @ts-expect-error Unavailable observations cannot claim that queues are empty.
export const unavailableWithQueues: LogisticsView = {
  kind: "unavailable",
  queues: [],
};

declare const availableLogistics: Variant<LogisticsView, "available">;
// @ts-expect-error A spread cannot remove the required dependency observation.
export const missingDependencyObservation: LogisticsView = {
  ...availableLogistics,
  dependencies: undefined,
};

import type { PhysicsView } from "./physics-view.ts";
declare const recordedPhysics: Variant<PhysicsView, "recorded">;
// @ts-expect-error An absent observation cannot retain sample identity through a spread.
export const absentWithRecording: PhysicsView = {
  ...recordedPhysics,
  kind: "unavailable",
};
// @ts-expect-error A live recording must name its accepted time and attempt.
export const incompletePhysics: PhysicsView = {
  kind: "recorded",
  version: 1,
  content: "{}",
};
declare const cellPhysics: Variant<PhysicsView, "cell-recorded">;
// @ts-expect-error Cell observations cannot acquire a task through a spread.
export const cellWithTask: PhysicsView = { ...cellPhysics, task: "invented" };
// @ts-expect-error An operation observation requires its task and attempt.
export const cellAsOperation: PhysicsView = {
  ...cellPhysics,
  kind: "recorded",
};

import type { ResourceHistoryView } from "./resource-history-view.ts";
import type { ResourceInterval } from "./results.ts";
declare const availableHistory: Variant<ResourceHistoryView, "available">;
declare const untrustedHistory: unknown;
// @ts-expect-error Unavailable history cannot retain totals through a spread.
export const absentWithResourceTotals: ResourceHistoryView = {
  ...availableHistory,
  kind: "unavailable",
};
// @ts-expect-error Unknown worker data must pass the host boundary decoder.
export const unparsedResourceHistory: ResourceHistoryView = untrustedHistory;
// @ts-expect-error An interval must declare whether the claim continues.
export const claimWithoutLifecycle: ResourceInterval = {
  task: scheduledTask,
  kind: "occupied",
  units: 1,
  start: 0,
  end: 2_000,
};

import type { StorageHistoryView, StorageInterval } from "./storage-history.ts";
declare const availableStorage: Variant<StorageHistoryView, "available">;
declare const untrustedStorage: unknown;
// @ts-expect-error Unavailable history cannot retain intervals through a spread.
export const absentWithStorageTotals: StorageHistoryView = {
  ...availableStorage,
  kind: "unavailable",
};
// @ts-expect-error Raw worker data requires the host boundary decoder.
export const unparsedStorageHistory: StorageHistoryView = untrustedStorage;
// @ts-expect-error Reservations are required even when the store is empty.
export const storageWithoutReservations: StorageInterval = {
  start: 0,
  end: 2_000,
  ongoing: true,
  occupants: [],
};
// @ts-expect-error An unavailable observation cannot fabricate an empty history.
export const absentWithEmptyStorage: StorageHistoryView = {
  kind: "unavailable",
  storages: [],
};

import type {
  SchedulingHistoryView,
  CapacityCategories,
  TaskWait,
} from "./scheduling-history.ts";
declare const availableScheduling: Variant<SchedulingHistoryView, "available">;
declare const rawScheduling: unknown;
// @ts-expect-error Unavailable observations cannot retain categories through a spread.
export const absentSchedulingWithTotals: SchedulingHistoryView = {
  ...availableScheduling,
  kind: "unavailable",
};
// @ts-expect-error Raw worker data must pass the host boundary decoder.
export const unparsedScheduling: SchedulingHistoryView = rawScheduling;
// @ts-expect-error Available observations require waits, resources and an interval.
export const emptyScheduling: SchedulingHistoryView = {
  kind: "available",
  version: 1,
};
// @ts-expect-error Every capacity category is required, including batch phases.
export const missingBatchPhases: CapacityCategories = {
  running: 1,
  reserved: 0,
  unavailable: 0,
  blocked: 0,
  starved: 0,
  idle: 0,
};
// @ts-expect-error Accepted waits require all blockers, including an empty list.
export const waitWithoutBlockers: TaskWait = { task: scheduledTask };

// Inspection gates carry no automatic completion time or physics request.
export const timedInspection: import("./scenario.ts").TaskExecutor = {
  kind: "inspection",
  // @ts-expect-error An inspection cannot complete through an elapsed duration.
  duration: 0,
};
declare const inspectionTarget: import("./commands.ts").CommandTarget;
declare const inspectionTask: import("./identity.ts").TaskId;
// @ts-expect-error An operator decision requires the definition, material identities, outcome and observation.
export const unboundInspection: import("./commands.ts").ControlCommand = {
  ...inspectionTarget,
  kind: "inspect",
  task: inspectionTask,
};
declare const inspectionWait: Variant<
  import("./state.ts").RunStatus,
  "awaiting-inspection"
>;
export const mixedInspectionWait: import("./state.ts").RunStatus = {
  ...inspectionWait,
  // @ts-expect-error An inspection boundary cannot also carry a native evidence request.
  need: {},
};

// @ts-expect-error Arrival closure must identify its source.
export const untargetedArrivalClosure: import("./execution-host.ts").HostRequest =
  {
    kind: "close-arrivals",
    commandId: "close-source",
  };

declare const declaredWork: Variant<
  import("./scenario.ts").TaskExecutor,
  "declared"
>;
declare const guardedWork: Variant<
  import("./scenario.ts").TaskExecutor,
  "after-inspection"
>;
declare const nativeWork: Variant<
  import("./scenario.ts").TaskExecutor,
  "native"
>;
declare const skippedTask: Variant<import("./state.ts").TaskState, "skipped">;
// @ts-expect-error Guarded work needs an inspection and its required outcome.
export const unboundConditionalWork: import("./scenario.ts").TaskExecutor = {
  kind: "after-inspection",
  work: declaredWork,
};
export const conditionalNative: import("./scenario.ts").TaskExecutor = {
  ...guardedWork,
  // @ts-expect-error A decision cannot skip a native carrier route.
  work: nativeWork,
};
export const nestedConditional: import("./scenario.ts").TaskExecutor = {
  ...guardedWork,
  // @ts-expect-error Inspection conditions cannot nest.
  work: guardedWork,
};
// @ts-expect-error Skipped work never starts or claims resources.
export const skippedWithStart: import("./state.ts").TaskState = {
  ...skippedTask,
  startedAt: skippedTask.completedAt,
};

declare const fixedCell: import("./scenario.ts").PhysicalCellDefinition;
const invalidSlotCount = { ...fixedCell, carrierSlots: 2 };
// @ts-expect-error A cell supports either no transferable carrier or one carrier.
export const unsupportedCellSlots: import("./scenario.ts").PhysicalCellDefinition =
  invalidSlotCount;
