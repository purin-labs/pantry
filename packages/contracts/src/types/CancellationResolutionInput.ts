import type { Timestamp } from "./Timestamp";
import type { WorkspaceRevisionReceipt } from "./WorkspaceRevisionReceipt";

export type CancellationResolutionInput =
  | { kind: "return_to_sleeping" }
  | {
      kind: "begin_checkpointing";
      workspaceRevisionReceipt: WorkspaceRevisionReceipt;
    }
  | { kind: "terminate"; terminalAt: Timestamp };
