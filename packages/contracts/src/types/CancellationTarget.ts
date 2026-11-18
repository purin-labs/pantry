import type { SessionTerminalReason } from "./SessionTerminalReason";
import type { TurnId } from "./TurnId";

export type CancellationTarget =
  | { kind: "turn"; turnId: TurnId }
  | { kind: "session"; reason: SessionTerminalReason };
