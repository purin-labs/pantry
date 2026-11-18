import type {
  CaseExecutionApprovalState,
  CaseExecutionAssignmentState,
  CaseExecutionEffectState,
  CaseExecutionProposalState,
  CaseExecutionToolAuthority,
  CaseExecutionTurnMemory,
} from "@seams/control-api";

/**
 * The execution records one Actor holds for a Case, as that Actor reads them.
 * They cross the Actor boundary as JSON text. Stored labels travel as their
 * canonical JSON once, in `labels`, and a record names one by its index. A
 * record with no stored label names none: it is then shown to nobody.
 */
export type CaseExecutionCaseRecords = Readonly<{
  caseId: string;
  revision: number;
  /** The last accepted journal sequence, or 0 when the journal is empty. */
  journalThrough: number;
  /** The connectors the Case is bound to. */
  connectorIds: readonly string[];
  labels: readonly string[];
  triggers: readonly CaseTriggerRecord[];
  assignments: readonly CaseAssignmentRecord[];
  sessionProposals: readonly CaseSessionProposalRecord[];
  commerceProposals: readonly CaseCommerceProposalRecord[];
  approvals: readonly CaseApprovalRecord[];
  mailProposals: readonly CaseMailProposalRecord[];
  outputs: readonly CaseOutputRecord[];
  entries: readonly CaseEntryRecord[];
  /** True when a table held more rows than this read returns. */
  truncated: boolean;
}>;

export type CaseTriggerRecord = Readonly<{
  triggerId: string;
  source: "connector" | "cue" | "api";
  acceptedAt: number;
  /** What the trigger is about, from its own source. */
  title: string | null;
}>;

export type CaseAssignmentRecord = Readonly<{
  assignmentId: string;
  sessionId: string;
  role: "coordinator" | "research" | "specialist";
  caseRevision: number;
  state: CaseExecutionAssignmentState;
  startedAt: number | null;
  settledAt: number | null;
  failureCode: string | null;
  /** The Case entries the assignment's context names. */
  contextEntryIds: readonly string[];
}>;

export type CaseSessionProposalRecord = Readonly<{
  proposalId: string;
  assignmentId: string;
  sessionId: string;
  turnId: string;
  entryIds: readonly string[];
  state: Extract<
    CaseExecutionProposalState,
    "accepted" | "rebase_required" | "rejected"
  >;
  recordedAt: number | null;
}>;

export type CaseCommerceProposalRecord = Readonly<{
  proposalId: string;
  /** Null for a proposal a person made on the control plane. */
  origin: Readonly<{ sessionId: string; assignmentId: string }> | null;
  /** The turn its acceptance is bound to. Null for a person's proposal. */
  turnId: string | null;
  /** The tool call that made it, when its acceptance records one. */
  toolCallId: string | null;
  recordedAt: number | null;
  label: number | null;
  /** What the proposal asks for, in the words of its action. */
  title: string | null;
}>;

export type CaseApprovalRecord = Readonly<{
  actionNonce: string;
  proposalId: string;
  state: CaseExecutionApprovalState;
  requestedAt: number;
  decidedAt: number | null;
}>;

export type CaseMailProposalRecord = Readonly<{
  proposalId: string;
  version: number;
  state: Extract<
    CaseExecutionProposalState,
    "awaiting_approval" | "approved" | "sent" | "closed" | "unresolved"
  >;
  /** The mailbox the reply belongs to, when the record or a binding names it. */
  integrationAccountId: string | null;
  recordedAt: number | null;
}>;

export type CaseOutputRecord = Readonly<{
  outputId: string;
  deliveryId: string;
  connectorId: string;
  entryId: string;
  source:
    | Readonly<{
        kind: "agent_turn";
        proposalId: string;
        actionNonce?: never;
      }>
    | Readonly<{
        kind: "commerce_outcome";
        proposalId: string;
        actionNonce: string;
      }>
    | Readonly<{
        kind: "commerce_approval_notice";
        proposalId: string;
        actionNonce: string;
      }>
    | Readonly<{
        kind: "operator_command";
        proposalId?: never;
        actionNonce?: never;
      }>;
  state: "pending" | "delivered";
  addressedAt: number;
  receipt: Readonly<{ nativeReceiptId: string; deliveredAt: number }> | null;
  label: number | null;
}>;

export type CaseEntryRecord = Readonly<{
  entryId: string;
  sequence: number;
  label: number | null;
}>;

/** The execution records one Session holds for the assignment it serves. */
export type CaseExecutionSessionRecords = Readonly<{
  sessionId: string;
  /** The assignment the Session was created for. Null for another parent. */
  assignmentId: string | null;
  labels: readonly string[];
  turns: readonly SessionTurnRecord[];
  /** The turns that keep no turn record, by the context each recorded. */
  contextTurns: readonly SessionContextTurnRecord[];
  attempts: readonly SessionAttemptRecord[];
  toolOperations: readonly SessionToolOperationRecord[];
  truncated: boolean;
}>;

export type SessionTurnRecord = Readonly<{
  turnId: string;
  /** The assignment the turn's accepted input names. */
  assignmentId: string | null;
  state: "running" | "complete" | "failed";
  startedAt: number;
  failureCode: string | null;
  label: number | null;
  /** What the turn's accepted context records of Memory. */
  memory: CaseExecutionTurnMemory;
}>;

/**
 * A turn that keeps no turn record: a mail turn or an Eval turn. Before the
 * model is asked, its Session records the context it gives the turn, with
 * the Memory the prompt carries. It records one context for each run of the
 * turn, and this is the latest. It records no state and no time of the turn.
 */
export type SessionContextTurnRecord = Readonly<{
  turnId: string;
  /** The assignment the context record names. */
  assignmentId: string;
  /** What the model of that run was given of Memory. */
  memory: CaseExecutionTurnMemory;
  /** The stored label of each Memory revision the context record holds. */
  labels: readonly number[];
}>;

export type SessionAttemptRecord = Readonly<{
  turnId: string;
  generation: number;
  state: "running" | "interrupted" | "ended";
  startedAt: number;
  /** The accepted time of the recovery that fenced the attempt. */
  interruptedAt: number | null;
}>;

export type SessionToolOperationRecord = Readonly<{
  turnId: string;
  callId: string;
  tool: string;
  state: "started" | "succeeded" | "failed";
  startedAt: number;
  settledAt: number | null;
  authority: CaseExecutionToolAuthority | null;
  receiptId: string | null;
}>;

/** What the governed action ledger holds for one action of the Case. */
export type CaseExecutionEffectRecord = Readonly<{
  actionNonce: string;
  proposalId: string;
  state: CaseExecutionEffectState;
  recordedAt: number;
  updatedAt: number;
  receipt: Readonly<{
    receiptId: string;
    status: string;
    observedAt: number;
  }> | null;
}>;

/** The governed actions of one Case, and whether the read was cut. */
export type CaseExecutionEffectRecords = Readonly<{
  effects: readonly CaseExecutionEffectRecord[];
  truncated: boolean;
}>;

/** The stored content behind one record, for a reader allowed to see it. */
export type CaseExecutionContentTarget =
  | Readonly<{ kind: "trigger"; triggerId: string }>
  | Readonly<{ kind: "session_proposal"; proposalId: string }>
  | Readonly<{ kind: "commerce_proposal"; proposalId: string }>
  | Readonly<{ kind: "output"; outputId: string }>;

export type SessionExecutionContentTarget = Readonly<{
  kind: "tool_operation";
  turnId: string;
  callId: string;
}>;

/** One stored text and the role it plays for the record it belongs to. */
export type CaseExecutionStoredContent = Readonly<{
  role: "input" | "arguments" | "result" | "entry" | "message" | "action";
  text: string;
}>;

export const MAX_EXECUTION_ASSIGNMENTS = 200;
export const MAX_EXECUTION_PROPOSALS = 400;
export const MAX_EXECUTION_OUTPUTS = 400;
export const MAX_EXECUTION_ENTRIES = 2_000;
export const MAX_EXECUTION_TURNS = 200;
export const MAX_EXECUTION_TOOL_OPERATIONS = 600;
export const MAX_EXECUTION_STORED_TEXT = 16_000;

/**
 * Interns label text while an Actor reads its rows, so each distinct label
 * is sent once.
 */
export class ExecutionLabelTable {
  private readonly index = new Map<string, number>();
  readonly labels: string[] = [];

  /** The index of `labelJson`, or null when the row stored no label. */
  intern(labelJson: string | null): number | null {
    if (labelJson === null || labelJson.length === 0) return null;
    const known = this.index.get(labelJson);
    if (known !== undefined) return known;
    const next = this.labels.length;
    this.labels.push(labelJson);
    this.index.set(labelJson, next);
    return next;
  }
}
