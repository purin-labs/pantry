import type { StrictUnion } from "@seams/type-utils";
import type { AgentSessionLifecycle as GeneratedLifecycle } from "./types/AgentSessionLifecycle";
import type { RecoveringSession as GeneratedRecovery } from "./types/RecoveringSession";
import type { SessionCommand as GeneratedCommand } from "./types/SessionCommand";
import type { SessionRecoveryAction as GeneratedAction } from "./types/SessionRecoveryAction";
import type { SessionRecoveryEvidence as GeneratedEvidence } from "./types/SessionRecoveryEvidence";
import type { SessionTransition as GeneratedTransition } from "./types/SessionTransition";

export type SessionRecoveryEvidence = StrictUnion<GeneratedEvidence>;

export type SessionRecoveryAction = StrictUnion<
  | Exclude<GeneratedAction, { kind: "await_evidence" }>
  | {
      kind: "await_evidence";
      evidence: SessionRecoveryEvidence;
    }
>;

export type RecoveringSession = Omit<GeneratedRecovery, "action"> & {
  action: SessionRecoveryAction;
  runtimeLease?: never;
  harnessLease?: never;
};

export type AgentSessionLifecycle =
  | Exclude<GeneratedLifecycle, { kind: "recovering" }>
  | { kind: "recovering"; state: RecoveringSession };

export type SessionTransition =
  | Exclude<
      GeneratedTransition,
      { kind: "execution_recovery_started" | "execution_recovery_updated" }
    >
  | { kind: "execution_recovery_started"; state: RecoveringSession }
  | { kind: "execution_recovery_updated"; state: RecoveringSession };

export type SessionCommand =
  | Exclude<
      GeneratedCommand,
      { kind: "begin_execution_recovery" | "update_execution_recovery" }
    >
  | {
      kind: "begin_execution_recovery";
      continuation: RecoveringSession["continuation"];
      action: SessionRecoveryAction;
    }
  | { kind: "update_execution_recovery"; action: SessionRecoveryAction };
