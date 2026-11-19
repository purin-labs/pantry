import type { SessionRecoveryAction, TurnLifecycle } from "@purin-labs/contracts";
import { parseJsonOrNull } from "@purin-labs/std";
import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import type { CodeModeLeaseBinding } from "./code-mode-budget";
import { readCodeModeExecution } from "./code-mode-execution-record";
import {
  parseCodeModeReceiptPhase,
  type CodeModeReceiptPhase,
} from "./pi-durable-code-receipt";
import { parseCodeModeExecutionProjection } from "./code-mode-execution-projection";

/** An admitted execution that a runtime lease can hold. */
export type RecoverableCodeModeExecution = {
  readonly executionId: string;
  readonly effectId: string;
  /** The lease that the Session Actor accepted before the interruption. */
  readonly binding: CodeModeLeaseBinding;
  /** The deadline of the first admission. Recovery never moves it. */
  readonly executionDeadlineAt: number;
};

/**
 * What a recovered Session Actor may do with the Code Mode call that its lost
 * process left unfinished. Each state carries only what its action needs.
 */
export type CodeModeRecovery = StrictUnion<
  /** No Code Mode call is unfinished. */
  | { readonly kind: "no_execution" }
  /**
   * Reauthorize, bind the reservation to the new lease, and replay the
   * journal. A script that stopped before its admission has no reservation.
   */
  | {
      readonly kind: "resumable_script";
      readonly execution: RecoverableCodeModeExecution | null;
    }
  /** Reconcile the original operation. Do not repeat an uncertain write. */
  | {
      readonly kind: "awaiting_effect_evidence";
      readonly cause: "receipt_invalid" | "execution_record_invalid";
      readonly effectId: string | null;
    }
  /** Settle the saved result under its recorded lease. Do not run the script. */
  | {
      readonly kind: "pending_settlement";
      readonly lease: {
        readonly executionId: string;
        readonly leaseId: string;
      };
    }
  /** Return the saved receipt. No effect and no charge follows. */
  | { readonly kind: "completed" }
  /**
   * Stop the script and settle known usage. The reservation still needs the
   * new lease, because a settlement is accepted only under the current one.
   */
  | {
      readonly kind: "terminal_failure";
      readonly failure: "deadline_expired";
      readonly execution: RecoverableCodeModeExecution;
    }
>;

type ReceiptRow = Record<string, SqlStorageValue> & {
  readonly revision_kind: string;
  readonly content: string;
};

/**
 * Decides the recovery of the unfinished Code Mode call from what the lost
 * process stored: the receipt of the call, the admitted execution, and the
 * clock. It writes nothing.
 */
export function classifyCodeModeRecovery(
  sql: SqlStorage,
  activeTurn: TurnLifecycle,
  now: number,
): CodeModeRecovery {
  const active =
    activeTurn.kind === "awaiting_execution"
      ? {
          executionId: activeTurn.state.executionId,
          effectId: activeTurn.state.effectId,
        }
      : null;
  const receipts = readUnfinishedReceipts(sql);
  // A call that never began, and a call that kept its receipt, need nothing.
  const open = receipts.filter(needsRecovery);
  const receipt = open[0];
  if (receipt === undefined) {
    if (receipts.length > 0)
      return receipts.some(isCompleted)
        ? { kind: "completed" }
        : { kind: "no_execution" };
    // An execution that holds the turn has a receipt until it settles.
    return active === null
      ? { kind: "no_execution" }
      : {
          kind: "awaiting_effect_evidence",
          cause: "receipt_invalid",
          effectId: active.effectId,
        };
  }
  // A turn has one Code Mode call, so one receipt at most is open.
  if (receipt === null || open.length > 1)
    return {
      kind: "awaiting_effect_evidence",
      cause: "receipt_invalid",
      effectId: active?.effectId ?? null,
    };
  switch (receipt.kind) {
    case "pending_settlement":
      return { kind: "pending_settlement", lease: receipt.lease };
    case "started":
      return active === null
        ? { kind: "resumable_script", execution: null }
        : classifyAdmittedScript(sql, active, now);
    default:
      return receipt satisfies never;
  }
}

type OpenReceipt = Variant<
  CodeModeReceiptPhase,
  "started" | "pending_settlement"
>;

function needsRecovery(
  receipt: CodeModeReceiptPhase | null,
): receipt is OpenReceipt | null {
  return (
    receipt === null ||
    receipt.kind === "started" ||
    receipt.kind === "pending_settlement"
  );
}

function isCompleted(receipt: CodeModeReceiptPhase | null): boolean {
  return receipt?.kind === "completed";
}

function classifyAdmittedScript(
  sql: SqlStorage,
  active: { readonly executionId: string; readonly effectId: string },
  now: number,
): CodeModeRecovery {
  const invalid: CodeModeRecovery = {
    kind: "awaiting_effect_evidence",
    cause: "execution_record_invalid",
    effectId: active.effectId,
  };
  const stored = readCodeModeExecution(sql, active.executionId);
  if (stored.kind !== "found") return invalid;
  const authority = stored.stored.record.authority;
  if (authority.kind === "generation_unrecorded") return invalid;
  const projection = parseCodeModeExecutionProjection(
    stored.stored.stateProjection,
  );
  if (projection === null) return invalid;
  const execution: RecoverableCodeModeExecution = {
    executionId: active.executionId,
    effectId: active.effectId,
    binding: authority.binding,
    executionDeadlineAt: authority.executionDeadlineAt,
  };
  return now >= authority.executionDeadlineAt
    ? { kind: "terminal_failure", failure: "deadline_expired", execution }
    : { kind: "resumable_script", execution };
}

/**
 * The execution whose reservation must hold the lease of the next runtime
 * generation before the harness task resumes, or `null` when none does.
 */
export function codeModeRecoveryRebind(
  recovery: CodeModeRecovery,
): RecoverableCodeModeExecution | null {
  switch (recovery.kind) {
    case "resumable_script":
    case "terminal_failure":
      return recovery.execution;
    case "no_execution":
    case "awaiting_effect_evidence":
    case "pending_settlement":
    case "completed":
      return null;
    default:
      return recovery satisfies never;
  }
}

/**
 * The Session recovery action for a Code Mode decision. `resume_task` lets
 * the harness task run again: it replays, settles, or returns its receipt.
 * Every other action keeps the task stopped until evidence arrives.
 */
export function codeModeRecoveryAction(
  recovery: CodeModeRecovery,
): SessionRecoveryAction {
  switch (recovery.kind) {
    case "no_execution":
    case "resumable_script":
    case "pending_settlement":
    case "completed":
    case "terminal_failure":
      return { kind: "resume_task" };
    case "awaiting_effect_evidence":
      return recovery.effectId === null
        ? { kind: "blocked", reason: "implementation" }
        : {
            kind: "await_evidence",
            evidence: { kind: "effect_receipt", effectId: recovery.effectId },
          };
    default:
      return recovery satisfies never;
  }
}

/** The receipts of Code Mode calls whose harness task has not ended. */
function readUnfinishedReceipts(
  sql: SqlStorage,
): (CodeModeReceiptPhase | null)[] {
  return sql
    .exec<ReceiptRow>(
      `SELECT r.kind AS revision_kind, r.content
       FROM documents d JOIN tasks t ON t.id = d.owner_id
       JOIN document_revisions r ON r.document_id = d.id
       WHERE d.kind = ? AND d.scope_kind = 'task' AND t.status <> 'terminal'
         AND d.retired_at IS NULL
         AND r.seq = (SELECT MAX(seq) FROM document_revisions WHERE document_id = d.id)`,
      JSON.stringify("satyr.codemode.result"),
    )
    .toArray()
    .map(receiptPhase);
}

function receiptPhase(row: ReceiptRow): CodeModeReceiptPhase | null {
  // The receipt document stores every change as a complete value.
  return row.revision_kind === "base"
    ? parseCodeModeReceiptPhase(parseJsonOrNull(row.content))
    : null;
}
