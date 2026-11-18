import type { InputId } from "./InputId";
import type { RuntimeGeneration } from "./RuntimeGeneration";
import type { SessionResumePoint } from "./SessionResumePoint";
import type { TurnId } from "./TurnId";

export type QuarantineRecovery =
  | {
      kind: "reactivate";
      turnId: TurnId;
      inputId: InputId;
      resumePoint: SessionResumePoint;
      nextRuntimeGeneration: RuntimeGeneration;
    }
  | { kind: "terminate_only" };
