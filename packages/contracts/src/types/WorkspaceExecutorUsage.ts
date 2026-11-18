import type { ByteLength } from "./ByteLength";
import type { CodeModeExecutionOutcome } from "./CodeModeExecutionOutcome";
import type { DurationMs } from "./DurationMs";
import type { EffectReceiptId } from "./EffectReceiptId";
import type { InternalCostMicros } from "./InternalCostMicros";
import type { Sha256Digest } from "./Sha256Digest";
import type { WorkspaceExecutorAllocationId } from "./WorkspaceExecutorAllocationId";

export type WorkspaceExecutorUsage =
  | { kind: "unused" }
  | {
      kind: "settled";
      allocationId: WorkspaceExecutorAllocationId;
      allocationDigest: Sha256Digest;
      receiptId: EffectReceiptId;
      receiptDigest: Sha256Digest;
      reservedCostMicros: InternalCostMicros;
      actualCostMicros: InternalCostMicros;
      inputBytes: ByteLength;
      outputBytes: ByteLength;
      durationMs: DurationMs;
      outcome: CodeModeExecutionOutcome;
    };
