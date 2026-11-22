import { assertNever, isRecord } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";
import { defineDoc, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { CodeModeExecutionOutcome } from "@purin-labs/contracts";

export type AuthorizedResult = {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  details: {
    pantryOutput: {
      kind: "inline";
      content: { kind: "text"; text: string }[];
      digest: string;
    };
    pantryAuthority:
      | { kind: "read"; resultDigest: string }
      | { kind: "code_execution"; resultDigest: string; receiptId: string };
  };
  isError: boolean;
};
export type PendingCodeModeReceipt = {
  kind: "pending_settlement";
  lease: { executionId: string; leaseId: string };
  outcome: CodeModeExecutionOutcome;
  outputBytes: number;
  authorized: AuthorizedResult;
};
type UnstartedReceipt = {
  kind: "unstarted";
};
/**
 * A started script continues from the journal of Pi: Pi records each
 * delivered result before the script sees it, so a later process
 * reconstructs the script from that record. A stored receipt that names no
 * journal is not a receipt of this runner, and no script starts from it.
 */
type StartedReceipt = {
  kind: "started";
  continuation: "journal";
};
type CompletedReceipt = {
  kind: "completed";
  result: AuthorizedResult;
};
// The library's JsonObject constraint rejects optional `never` fields.
// Keep its serialized shape at this boundary and normalize the domain union on read.
type StoredCodeModeReceipt =
  UnstartedReceipt | StartedReceipt | PendingCodeModeReceipt | CompletedReceipt;
export type CodeModeReceipt = StrictUnion<
  UnstartedReceipt | StartedReceipt | PendingCodeModeReceipt | CompletedReceipt
>;

/** What recovery needs from a receipt, without its authorized content. */
export type CodeModeReceiptPhase = StrictUnion<
  | { kind: "unstarted" }
  | { kind: "started" }
  | {
      kind: "pending_settlement";
      lease: { executionId: string; leaseId: string };
    }
  | { kind: "completed" }
>;
export function readCodeModeReceipt(
  receipt: StoredCodeModeReceipt,
): CodeModeReceipt {
  switch (receipt.kind) {
    case "unstarted":
      return { kind: "unstarted" };
    case "started":
      // The stored document is not proven to hold what its type says.
      if (receipt.continuation !== "journal")
        throw new Error("Code Mode receipt names no journal");
      return { kind: "started", continuation: "journal" };
    case "completed":
      return { kind: "completed", result: receipt.result };
    case "pending_settlement":
      return {
        kind: "pending_settlement",
        lease: receipt.lease,
        outcome: receipt.outcome,
        outputBytes: receipt.outputBytes,
        authorized: receipt.authorized,
      };
    default:
      return assertNever(receipt);
  }
}

export const CodeModeResult = defineDoc<{ state: StoredCodeModeReceipt }>({
  kind: "pantry.codemode.result",
  version: 2,
  scope: "task",
  initial: initialReceipt,
  checkpointWhen: alwaysCheckpoint,
});
function initialReceipt(): { state: CodeModeReceipt } {
  return { state: { kind: "unstarted" } };
}
function alwaysCheckpoint(): boolean {
  return true;
}
/** Pi records every result that it delivers, so a later process continues. */
export async function startCodeModeReceipt(
  tx: Tx,
  harnessTaskId: TaskId,
): Promise<void> {
  const receipt = await tx.doc(CodeModeResult, harnessTaskId);
  if (receipt.state.kind !== "unstarted")
    throw new Error("Code Mode already started");
  receipt.state = { kind: "started", continuation: "journal" };
}

/**
 * Reads the phase of a receipt from the stored content of its document. The
 * recovery of a lost process reads receipts from Actor SQLite, before any
 * harness is open.
 */
export function parseCodeModeReceiptPhase(
  content: unknown,
): CodeModeReceiptPhase | null {
  if (!isRecord(content) || !isRecord(content.state)) return null;
  const state = content.state;
  switch (state.kind) {
    case "unstarted":
      return { kind: "unstarted" };
    case "started":
      return state.continuation === "journal" ? { kind: "started" } : null;
    case "pending_settlement":
      return isRecord(state.lease) &&
        typeof state.lease.executionId === "string" &&
        typeof state.lease.leaseId === "string"
        ? {
            kind: "pending_settlement",
            lease: {
              executionId: state.lease.executionId,
              leaseId: state.lease.leaseId,
            },
          }
        : null;
    case "completed":
      return { kind: "completed" };
    default:
      return null;
  }
}
export async function saveCodeModeReceipt(
  pending: PendingCodeModeReceipt,
  harnessTaskId: TaskId,
  tx: Tx,
): Promise<void> {
  const receipt = await tx.doc(CodeModeResult, harnessTaskId);
  if (receipt.state.kind !== "started")
    throw new Error("Code Mode output requires a started execution");
  receipt.state = pending;
}
export async function completeCodeModeReceipt(
  tx: Tx,
  harnessTaskId: TaskId,
  result: AuthorizedResult,
): Promise<void> {
  const receipt = await tx.doc(CodeModeResult, harnessTaskId);
  if (
    receipt.state.kind !== "started" &&
    receipt.state.kind !== "pending_settlement"
  )
    throw new Error("Invalid Code Mode completion");
  receipt.state = { kind: "completed", result };
}
