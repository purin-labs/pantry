/**
 * Plan 24 S4: the physical execution adapter of the production engine. One
 * approved bake run with two cobots and one oven, driven only by dispatch
 * records and device receipts. It has no Platform, network or storage code;
 * a Durable Object holds its values and calls it.
 */
export {
  checkBakeRunInput,
  compileBakeRun,
  planBakeRun,
  type BakePlan,
  type BakeRunInput,
  type BakeRunProblem,
  type BakeStep,
  type BakeStepKind,
  type CompiledBakeRun,
  type MouldGroupInput,
  type PlannedStep,
} from "./compile.ts";
export {
  PHYSICAL_BUNDLE_ID,
  drivePhysicalRun,
  openDisposition,
  startPhysicalRun,
  type PhysicalRun,
  type PhysicalStartProblem,
  type PhysicalStop,
  type PhysicalWait,
} from "./drive.ts";
export type {
  DispatchRecord,
  DispositionReason,
  EvidenceDisposition,
  EvidenceLedger,
} from "./evidence.ts";
export {
  observeBakeRun,
  type BakeRunView,
  type BakeTaskView,
  type MouldGroupPosition,
  type MouldGroupView,
  type ObservedTaskState,
} from "./observe.ts";
export {
  correlateShadowMoves,
  type ShadowCorrelation,
  type ShadowMatch,
  type ShadowObservation,
} from "./shadow.ts";
export {
  dispatchIdentity,
  type CarrierAt,
  type ClockOrigin,
  type CobotClock,
  type CobotClockEntry,
  type CobotObserved,
  type CobotPlace,
  type CobotReport,
  type CobotTask,
  type CobotTaskMessage,
  type CobotTaskState,
  type DeviceRunState,
  type PhysicalEvidence,
} from "./protocol.ts";
