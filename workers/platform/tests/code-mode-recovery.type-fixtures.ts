import type { CodeModeLeaseBinding } from "@purin-labs/agent/actors/code-mode-budget";
import type { CodeModeExecutionAuthority } from "@purin-labs/agent/actors/code-mode-execution-record";
import type {
  ConfirmedCodeModeLeaseRebind,
  PreparedCodeModeLeaseRebind,
} from "@purin-labs/agent/actors/code-mode-lease-rebind";
import type {
  CodeModeRecovery,
  RecoverableCodeModeExecution,
} from "@purin-labs/agent/actors/code-mode-recovery";
import type {
  CodeModeExecutionRelease,
  markCodeModeExecutionReleased,
} from "@purin-labs/agent/actors/code-mode-execution-release";
import type { HarnessCodeModeAdmittedExecution } from "@purin-labs/agent-tools/catalog/types";
import type { CodeModeReceipt } from "@purin-labs/agent/actors/pi-durable-code-receipt";
import type { PiRecoveryLeaseRebind } from "@purin-labs/agent/actors/pi-durable-recovery";

declare const binding: CodeModeLeaseBinding;
declare const intended: CodeModeLeaseBinding;
declare const execution: RecoverableCodeModeExecution;
declare const prepared: PreparedCodeModeLeaseRebind;
declare const resumable: Extract<
  CodeModeRecovery,
  { kind: "resumable_script" }
>;
declare const pending: Extract<
  CodeModeRecovery,
  { kind: "pending_settlement" }
>;

// A lease is confirmed only by the owners of the reservation.
// @ts-expect-error A hand-written object is not a confirmed rebind.
const forgedConfirmation: ConfirmedCodeModeLeaseRebind = {
  executionId: "cmx-1",
  binding,
};

// @ts-expect-error A prepared rebind does not become confirmed by a spread.
const spreadConfirmation: ConfirmedCodeModeLeaseRebind = {
  ...prepared,
  binding: prepared.next,
};

// @ts-expect-error A confirmed recovery rebind carries the owners' confirmation.
const unconfirmedRecoveryRebind: PiRecoveryLeaseRebind = { kind: "confirmed" };

// @ts-expect-error A deferred rebind has no confirmation to adopt.
const mixedRecoveryRebind: PiRecoveryLeaseRebind = {
  kind: "deferred",
  reason: "platform:code_mode_platform_disabled",
  rebind: forgedConfirmation,
};

// @ts-expect-error A bound execution has no intended lease.
const boundWithIntent: CodeModeExecutionAuthority = {
  kind: "bound",
  binding,
  executionDeadlineAt: 1,
  intended,
};

// @ts-expect-error A rebinding execution names the lease that it intends.
const rebindingWithoutIntent: CodeModeExecutionAuthority = {
  kind: "rebinding",
  binding,
  executionDeadlineAt: 1,
};

// @ts-expect-error A record without its generation has no stored deadline.
const unrecordedWithDeadline: CodeModeExecutionAuthority = {
  kind: "generation_unrecorded",
  leaseId: "lease-1",
  executionDeadlineAt: 1,
};

// @ts-expect-error A script that stops at its deadline still names its execution.
const terminalWithoutExecution: CodeModeRecovery = {
  kind: "terminal_failure",
  failure: "deadline_expired",
};

// @ts-expect-error Only a script that was never admitted lacks an execution.
const terminalWithoutReservation: CodeModeRecovery = {
  kind: "terminal_failure",
  failure: "deadline_expired",
  execution: null,
};

// @ts-expect-error A saved result settles under its lease. It does not run.
const settlementThatRuns: CodeModeRecovery = {
  kind: "pending_settlement",
  lease: { executionId: "cmx-1", leaseId: "lease-1" },
  execution,
};

// @ts-expect-error A resumable script does not become a settlement by a spread.
const spreadSettlement: CodeModeRecovery = {
  ...resumable,
  kind: "pending_settlement",
};

// @ts-expect-error A settlement does not become a resumable script by a spread.
const spreadResumable: CodeModeRecovery = {
  ...pending,
  kind: "resumable_script",
};

// @ts-expect-error An execution that awaits evidence holds no runnable lease.
const evidenceWithLease: CodeModeRecovery = {
  kind: "awaiting_effect_evidence",
  cause: "receipt_invalid",
  effectId: null,
  execution,
};

// @ts-expect-error A started receipt states how its script can continue.
const startedWithoutContinuation: CodeModeReceipt = { kind: "started" };

void [
  forgedConfirmation,
  spreadConfirmation,
  unconfirmedRecoveryRebind,
  mixedRecoveryRebind,
  boundWithIntent,
  rebindingWithoutIntent,
  unrecordedWithDeadline,
  terminalWithoutExecution,
  terminalWithoutReservation,
  settlementThatRuns,
  spreadSettlement,
  spreadResumable,
  evidenceWithLease,
  startedWithoutContinuation,
];

// A released execution names what each owner holds. A deferred one does not.
// @ts-expect-error A release names the reservation state of both owners.
const halfRelease: CodeModeExecutionRelease = {
  kind: "released",
  organisation: "cancelled",
};

// @ts-expect-error A deferred release closed nothing at an owner.
const deferredWithOwner: CodeModeExecutionRelease = {
  kind: "deferred",
  reason: "code_mode_reservation_lease_conflict",
  platform: "cancelled",
};

declare const deferredRelease: Extract<
  CodeModeExecutionRelease,
  { kind: "deferred" }
>;
// @ts-expect-error Only a release closes the record of an execution.
const closesDeferred: Parameters<typeof markCodeModeExecutionReleased>[2] =
  deferredRelease;

// A script starts only after its admission says that the catalog is the same.
// @ts-expect-error An admitted execution states if it may run.
const admittedWithoutDecision: HarnessCodeModeAdmittedExecution = {
  executionId: "cmx-1",
  leaseId: "lease-1",
  executionDeadlineAt: 1,
};

void [halfRelease, deferredWithOwner, closesDeferred, admittedWithoutDecision];
