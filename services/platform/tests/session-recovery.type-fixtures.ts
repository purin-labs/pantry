import type {
  HarnessTurnLease,
  RecoveringSession,
  SessionRecoveryAction,
  SessionRecoveryEvidence,
} from "@purin-labs/contracts";
import { buildSessionExecutionResume } from "../src/actors/agent-session-recovery";

declare const recovering: RecoveringSession;
declare const lease: HarnessTurnLease;
declare const resume: Parameters<typeof buildSessionExecutionResume>[0];
declare const waiting: Extract<
  SessionRecoveryAction,
  { kind: "await_evidence" }
>;
declare const blocked: Extract<SessionRecoveryAction, { kind: "blocked" }>;

const executableRecovery: RecoveringSession = {
  ...recovering,
  // @ts-expect-error A recovering session has no executable runtime lease.
  runtimeLease: lease.runtimeLease,
};
void executableRecovery;

const executableHarness: RecoveringSession = {
  ...recovering,
  // @ts-expect-error A stored continuation grants no harness authority.
  harnessLease: lease,
};
void executableHarness;

// @ts-expect-error Direct construction requires the persisted task identity and history cursor.
const missingContinuation: RecoveringSession = {
  identity: recovering.identity,
  contract: recovering.contract,
  resumePoint: recovering.resumePoint,
  activeTurn: recovering.activeTurn,
  fencedRuntime: recovering.fencedRuntime,
  action: { kind: "resume_task" },
};
void missingContinuation;

// @ts-expect-error A wait requires evidence for the exact unresolved operation.
const missingEvidence: SessionRecoveryAction = { kind: "await_evidence" };
void missingEvidence;

// @ts-expect-error A ready action cannot retain a blocked reason through a spread.
const mixedAction: SessionRecoveryAction = { ...blocked, kind: "resume_task" };
void mixedAction;

// @ts-expect-error Missing model usage must identify its reservation.
const partialUsage: SessionRecoveryEvidence = {
  kind: "model_usage",
  modelRequestId: "request",
  runId: "run",
};
void partialUsage;

// @ts-expect-error An evidence wait cannot be cast to a ready action.
const unsafeResume = waiting as Extract<
  SessionRecoveryAction,
  { kind: "resume_task" }
>;
void unsafeResume;

buildSessionExecutionResume({
  ...resume,
  // @ts-expect-error A broad recovering state cannot call the resume builder.
  current: { kind: "recovering", state: recovering },
});
