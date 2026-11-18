import type { CancellationLease } from "./CancellationLease";
import type { InputId } from "./InputId";
import type { SessionResumePoint } from "./SessionResumePoint";
import type { SessionTerminalReason } from "./SessionTerminalReason";
import type { TurnId } from "./TurnId";

export type CancellationPlan =
  | {
      kind: "turn";
      turnId: TurnId;
      inputId: InputId;
      resumePoint: SessionResumePoint;
      lease: CancellationLease;
    }
  | {
      kind: "session";
      reason: SessionTerminalReason;
      lease: CancellationLease;
    };
