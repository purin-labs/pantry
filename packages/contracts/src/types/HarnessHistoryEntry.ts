import type { AcceptedInputRef } from "./AcceptedInputRef";
import type { EmbeddedHarnessModelUsage } from "./EmbeddedHarnessModelUsage";
import type { HarnessAssistantContent } from "./HarnessAssistantContent";
import type { HarnessHistoryContent } from "./HarnessHistoryContent";
import type { HarnessStopReason } from "./HarnessStopReason";
import type { HarnessToolAuthority } from "./HarnessToolAuthority";
import type { HarnessToolOutcome } from "./HarnessToolOutcome";
import type { Timestamp } from "./Timestamp";
import type { TurnIdentity } from "./TurnIdentity";

export type HarnessHistoryEntry =
  | {
      kind: "user_input";
      turn: TurnIdentity;
      input: AcceptedInputRef;
      content: Array<HarnessHistoryContent>;
      acceptedAt: Timestamp;
    }
  | {
      kind: "assistant_message";
      turn: TurnIdentity;
      model: string;
      content: Array<HarnessAssistantContent>;
      stopReason: HarnessStopReason;
      usage: EmbeddedHarnessModelUsage;
      acceptedAt: Timestamp;
    }
  | {
      kind: "tool_result";
      turn: TurnIdentity;
      callId: string;
      tool: string;
      outcome: HarnessToolOutcome;
      authority: HarnessToolAuthority;
      acceptedAt: Timestamp;
    };
