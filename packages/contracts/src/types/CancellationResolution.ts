import type { CheckpointingSession } from "./CheckpointingSession";
import type { SleepingSession } from "./SleepingSession";
import type { TerminalSession } from "./TerminalSession";

export type CancellationResolution =
  | { kind: "sleeping"; state: SleepingSession }
  | { kind: "checkpointing"; state: CheckpointingSession }
  | { kind: "terminal"; state: TerminalSession };
