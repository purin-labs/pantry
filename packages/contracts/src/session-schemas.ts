import { Type, type Static, type TSchema } from "typebox";
import { NonNegativeInteger, StrictObject } from "@purin-labs/contract-schema";
import { modelRouteSchema } from "./model-route.ts";

// Session lifecycle contracts (Plan 78 Step 5). Each object lists its fields
// in Rust declaration order, which is serde's output order. A `rule` names
// the Rust parser that the boundary applies after the JSON shape passes.

/** The Rust parser that a boundary applies to a string or an integer. */
type SessionFieldRule =
  | "actor_identity"
  | "bounded_identity"
  | "workspace_id"
  | "sha256"
  | "object_key"
  | "organisation_id"
  | "backend_id"
  | "positive"
  | "nonzero_byte_length";

function text(rule: SessionFieldRule) {
  return Type.String({ rule });
}
function counter() {
  return NonNegativeInteger;
}
function positive() {
  return Type.Integer({ ...NonNegativeInteger, rule: "positive" });
}
function variant<Kind extends string, Fields extends Record<string, TSchema>>(
  kind: Kind,
  fields: Fields,
) {
  return StrictObject({ kind: Type.Literal(kind), ...fields });
}

const actorId = () => text("actor_identity");
const sha256 = () => text("sha256");

export const sessionIdentitySchema = StrictObject({
  organisationId: text("organisation_id"),
  sessionId: actorId(),
  streamId: actorId(),
});

export const sessionContractSchema = StrictObject({
  policyVersion: text("bounded_identity"),
  budgetRevision: actorId(),
  runtimeRevision: actorId(),
  modelRoute: modelRouteSchema,
  lastEventSequence: counter(),
});

export const runtimeLeaseSchema = StrictObject({
  generation: positive(),
  leaseId: actorId(),
});

const causationRefSchema = Type.Union([
  variant("ingress", { observationId: actorId() }),
  variant("schedule", { scheduleId: actorId() }),
  variant("command", { commandId: actorId() }),
  variant("event", { eventId: actorId() }),
  variant("effect_receipt", { receiptId: actorId() }),
  variant("migration", { migrationId: actorId() }),
]);

export const workspaceRevisionReceiptSchema = StrictObject({
  receiptId: actorId(),
  outcome: Type.Union([
    Type.Literal("accepted"),
    Type.Literal("already_applied"),
  ]),
  workspaceId: text("workspace_id"),
  revision: actorId(),
  canonicalHead: sha256(),
  correlationId: actorId(),
  causation: causationRefSchema,
});

const sessionBudgetUsageSchema = StrictObject({
  tokens: counter(),
  activeWallMs: counter(),
  capabilityCalls: counter(),
});

export const verifiedSessionCheckpointSchema = StrictObject({
  checkpointId: actorId(),
  stateDigest: sha256(),
  lastEventSequence: counter(),
  runtimeRevision: actorId(),
  runtimeGeneration: positive(),
  policyVersion: text("bounded_identity"),
  budgetRevision: actorId(),
  budgetUsage: sessionBudgetUsageSchema,
  usageCursor: counter(),
  budgetAccountDigest: sha256(),
  workspaceRevisionReceipt: workspaceRevisionReceiptSchema,
});

export const sessionResumePointSchema = Type.Union([
  variant("new", { workspaceRevisionReceipt: workspaceRevisionReceiptSchema }),
  variant("checkpoint", { checkpoint: verifiedSessionCheckpointSchema }),
]);

export const turnIdentitySchema = StrictObject({
  turnId: actorId(),
  inputId: actorId(),
  turnLeaseGeneration: positive(),
  budgetRevision: actorId(),
});

export const turnLifecycleSchema = Type.Union([
  variant("admitted", {
    state: StrictObject({
      identity: turnIdentitySchema,
      admittedAt: counter(),
    }),
  }),
  variant("reasoning", {
    state: StrictObject({
      identity: turnIdentitySchema,
      modelRequestId: actorId(),
      startedAt: counter(),
    }),
  }),
  variant("awaiting_approval", {
    state: StrictObject({
      identity: turnIdentitySchema,
      approvalRequestId: actorId(),
      effectId: actorId(),
    }),
  }),
  variant("awaiting_tool_effect", {
    state: StrictObject({
      identity: turnIdentitySchema,
      effectId: actorId(),
    }),
  }),
  variant("awaiting_execution", {
    state: StrictObject({
      identity: turnIdentitySchema,
      executionId: actorId(),
      effectId: actorId(),
    }),
  }),
  variant("reducing_result", {
    state: StrictObject({
      identity: turnIdentitySchema,
      receiptId: actorId(),
      workspaceRevisionReceipt: workspaceRevisionReceiptSchema,
    }),
  }),
]);

const harnessHistoryCursorSchema = StrictObject({
  lastSequence: positive(),
  lastEntryDigest: sha256(),
});

export const harnessTaskContinuationSchema = variant("pi", {
  harnessTaskId: actorId(),
  submissionId: actorId(),
  harnessBuild: actorId(),
  historyCursor: harnessHistoryCursorSchema,
});

export const sessionRecoveryActionSchema = Type.Union([
  variant("resume_task", {}),
  variant("retry_at", { retryAt: counter() }),
  variant("await_evidence", {
    evidence: Type.Union([
      variant("model_usage", {
        modelRequestId: actorId(),
        runId: actorId(),
        reservationId: actorId(),
      }),
      variant("effect_receipt", { effectId: actorId() }),
    ]),
  }),
  variant("blocked", {
    reason: Type.Union([
      Type.Literal("authorization"),
      Type.Literal("budget"),
      Type.Literal("implementation"),
      Type.Literal("retry_exhausted"),
    ]),
  }),
]);

const turnOutcomeSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("cancelled"),
  Type.Literal("failed"),
]);

const terminalReasonSchema = Type.Union([
  Type.Literal("closed"),
  Type.Literal("expired"),
  Type.Literal("erased"),
  Type.Literal("cancelled"),
  Type.Literal("failed"),
]);

const quarantineReasonSchema = Type.Union([
  Type.Literal("activation_failure"),
  Type.Literal("integrity_failure"),
  Type.Literal("replay_failure"),
  Type.Literal("effect_indeterminate"),
  Type.Literal("journal_budget_exceeded"),
  Type.Literal("migration_blocked"),
]);

const cancellationLeaseSchema = Type.Union([
  variant("none", {}),
  variant("active", {
    runtimeLease: runtimeLeaseSchema,
    turnLeaseGeneration: positive(),
  }),
]);

export const sleepingSessionSchema = StrictObject({
  identity: sessionIdentitySchema,
  contract: sessionContractSchema,
  resumePoint: sessionResumePointSchema,
});

export const activatingSessionSchema = StrictObject({
  identity: sessionIdentitySchema,
  contract: sessionContractSchema,
  turnId: actorId(),
  inputId: actorId(),
  resumePoint: sessionResumePointSchema,
  runtimeGeneration: positive(),
});

export const processingSessionSchema = StrictObject({
  identity: sessionIdentitySchema,
  contract: sessionContractSchema,
  resumePoint: sessionResumePointSchema,
  runtimeLease: runtimeLeaseSchema,
  activeTurn: turnLifecycleSchema,
});

export const recoveringSessionSchema = StrictObject({
  identity: sessionIdentitySchema,
  contract: sessionContractSchema,
  resumePoint: sessionResumePointSchema,
  fencedRuntime: runtimeLeaseSchema,
  activeTurn: turnLifecycleSchema,
  continuation: harnessTaskContinuationSchema,
  action: sessionRecoveryActionSchema,
});

export const checkpointingSessionSchema = StrictObject({
  identity: sessionIdentitySchema,
  contract: sessionContractSchema,
  runtimeLease: runtimeLeaseSchema,
  turnId: actorId(),
  inputId: actorId(),
  turnLeaseGeneration: positive(),
  outcome: turnOutcomeSchema,
  resumePoint: sessionResumePointSchema,
  workspaceRevisionReceipt: workspaceRevisionReceiptSchema,
});

export const cancellingSessionSchema = StrictObject({
  identity: sessionIdentitySchema,
  contract: sessionContractSchema,
  plan: Type.Union([
    variant("turn", {
      turnId: actorId(),
      inputId: actorId(),
      resumePoint: sessionResumePointSchema,
      lease: cancellationLeaseSchema,
    }),
    variant("session", {
      reason: terminalReasonSchema,
      lease: cancellationLeaseSchema,
    }),
  ]),
});

export const quarantinedSessionSchema = StrictObject({
  identity: sessionIdentitySchema,
  contract: sessionContractSchema,
  reason: quarantineReasonSchema,
  recovery: Type.Union([
    variant("reactivate", {
      turnId: actorId(),
      inputId: actorId(),
      resumePoint: sessionResumePointSchema,
      nextRuntimeGeneration: positive(),
    }),
    variant("terminate_only", {}),
  ]),
});

export const terminalSessionSchema = StrictObject({
  identity: sessionIdentitySchema,
  contract: sessionContractSchema,
  reason: terminalReasonSchema,
  terminalAt: counter(),
});

export const agentSessionLifecycleSchema = Type.Union([
  variant("sleeping", { state: sleepingSessionSchema }),
  variant("activating", { state: activatingSessionSchema }),
  variant("processing", { state: processingSessionSchema }),
  variant("recovering", { state: recoveringSessionSchema }),
  variant("checkpointing", { state: checkpointingSessionSchema }),
  variant("cancelling", { state: cancellingSessionSchema }),
  variant("quarantined", { state: quarantinedSessionSchema }),
  variant("terminal", { state: terminalSessionSchema }),
]);

export const acceptedInputRefSchema = Type.Union([
  variant("case", {
    inputId: actorId(),
    caseId: actorId(),
    assignmentId: actorId(),
    caseRevision: counter(),
    contentDigest: sha256(),
    workspaceRevision: actorId(),
    contextBundleDigest: sha256(),
  }),
]);

const effectKindSchema = Type.Union([
  Type.Literal("model"),
  Type.Literal("tool"),
  Type.Literal("execution"),
  Type.Literal("workspace"),
  Type.Literal("surface"),
  Type.Literal("provider"),
]);

const adapterCapabilitySchema = Type.Union([
  Type.Literal("idempotent"),
  Type.Literal("reconcile_by_stable_lookup"),
  Type.Literal("unsafe_to_retry"),
]);

const executionOutcomeSchema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("platform_failed"),
  Type.Literal("organisation_failed"),
]);

function eventBodySchema<Value extends TSchema>(value: Value) {
  return Type.Union([
    variant("inline", { value }),
    variant("content_ref", {
      objectKey: text("object_key"),
      sha256: sha256(),
      mediaType: actorId(),
      byteLength: counter(),
    }),
  ]);
}

const codeModeExecutionRequestSchema = StrictObject({
  executionId: actorId(),
  turn: turnIdentitySchema,
  admissionDigest: sha256(),
  workspaceRevisionReceipt: workspaceRevisionReceiptSchema,
});

export const codeModeExecutionReceiptSchema = StrictObject({
  executionId: actorId(),
  turn: turnIdentitySchema,
  admissionDigest: sha256(),
  receiptDigest: sha256(),
  priceBookRevision: actorId(),
  reservedCostMicros: counter(),
  actualCostMicros: counter(),
  capabilityCalls: counter(),
  inputBytes: counter(),
  outputBytes: counter(),
  rootOutputBytes: counter(),
  workspaceExecutorUsage: Type.Union([
    variant("unused", {}),
    variant("settled", {
      allocationId: actorId(),
      allocationDigest: sha256(),
      receiptId: actorId(),
      receiptDigest: sha256(),
      reservedCostMicros: counter(),
      actualCostMicros: counter(),
      inputBytes: counter(),
      outputBytes: counter(),
      durationMs: counter(),
      outcome: executionOutcomeSchema,
    }),
  ]),
  outcome: executionOutcomeSchema,
  workspaceRevisionReceipt: workspaceRevisionReceiptSchema,
});

const pendingExecutionEffectSchema = StrictObject({
  effectId: actorId(),
  kind: effectKindSchema,
  capability: adapterCapabilitySchema,
  idempotencyKey: text("bounded_identity"),
  request: eventBodySchema(codeModeExecutionRequestSchema),
});

const settledExecutionEffectSchema = StrictObject({
  effectId: actorId(),
  kind: effectKindSchema,
  capability: adapterCapabilitySchema,
  receiptId: actorId(),
  receipt: eventBodySchema(codeModeExecutionReceiptSchema),
  settledAt: counter(),
});

export const sessionCommandSchema = Type.Union([
  variant("initialize", {
    identity: sessionIdentitySchema,
    contract: sessionContractSchema,
    resumePoint: sessionResumePointSchema,
  }),
  variant("accept_input", {
    input: acceptedInputRefSchema,
    turnId: actorId(),
    runtimeGeneration: positive(),
  }),
  variant("activate_runtime", {
    runtimeLease: runtimeLeaseSchema,
    turnLeaseGeneration: positive(),
    admittedAt: counter(),
  }),
  variant("request_execution", {
    runtimeLease: runtimeLeaseSchema,
    turnLeaseGeneration: positive(),
    request: pendingExecutionEffectSchema,
  }),
  variant("accept_execution_receipt", {
    runtimeLease: runtimeLeaseSchema,
    turnLeaseGeneration: positive(),
    receipt: settledExecutionEffectSchema,
  }),
  variant("begin_checkpoint", {
    runtimeLease: runtimeLeaseSchema,
    turnLeaseGeneration: positive(),
    outcome: turnOutcomeSchema,
    workspaceRevisionReceipt: workspaceRevisionReceiptSchema,
  }),
  variant("commit_checkpoint", { checkpoint: verifiedSessionCheckpointSchema }),
  variant("begin_execution_recovery", {
    continuation: harnessTaskContinuationSchema,
    action: sessionRecoveryActionSchema,
  }),
  variant("update_execution_recovery", { action: sessionRecoveryActionSchema }),
  variant("resume_execution", { runtimeLease: runtimeLeaseSchema }),
  variant("cancel", {
    target: Type.Union([
      variant("turn", { turnId: actorId() }),
      variant("session", { reason: terminalReasonSchema }),
    ]),
  }),
  variant("resolve_cancellation", {
    resolution: Type.Union([
      variant("return_to_sleeping", {}),
      variant("begin_checkpointing", {
        workspaceRevisionReceipt: workspaceRevisionReceiptSchema,
      }),
      variant("terminate", { terminalAt: counter() }),
    ]),
  }),
  variant("quarantine", { reason: quarantineReasonSchema }),
  variant("recover", {}),
  variant("terminate", { reason: terminalReasonSchema, terminalAt: counter() }),
]);

const sessionImportEvidenceSchema = StrictObject({
  sourceSchemaVersion: counter(),
  sourceRuntimeGeneration: positive(),
  sourceStateDigest: sha256(),
  auditObjectKey: text("object_key"),
  lastProviderDeliveryCursor: actorId(),
  importedAt: counter(),
});

export const sessionTransitionSchema = Type.Union([
  variant("session_state_imported", {
    state: agentSessionLifecycleSchema,
    evidence: sessionImportEvidenceSchema,
  }),
  variant("session_initialized", { state: sleepingSessionSchema }),
  variant("input_accepted", {
    input: acceptedInputRefSchema,
    state: activatingSessionSchema,
  }),
  variant("runtime_activated", { state: processingSessionSchema }),
  variant("execution_requested", {
    request: pendingExecutionEffectSchema,
    state: processingSessionSchema,
  }),
  variant("execution_settled", {
    receipt: settledExecutionEffectSchema,
    state: processingSessionSchema,
  }),
  variant("execution_recovery_started", { state: recoveringSessionSchema }),
  variant("execution_recovery_updated", { state: recoveringSessionSchema }),
  variant("execution_resumed", { state: processingSessionSchema }),
  variant("checkpointing_started", { state: checkpointingSessionSchema }),
  variant("checkpoint_committed", { state: sleepingSessionSchema }),
  variant("cancellation_started", { state: cancellingSessionSchema }),
  variant("cancellation_resolved", {
    resolution: Type.Union([
      variant("sleeping", { state: sleepingSessionSchema }),
      variant("checkpointing", { state: checkpointingSessionSchema }),
      variant("terminal", { state: terminalSessionSchema }),
    ]),
  }),
  variant("session_quarantined", { state: quarantinedSessionSchema }),
  variant("session_recovered", { state: activatingSessionSchema }),
  variant("session_terminated", { state: terminalSessionSchema }),
]);

export const harnessCheckpointRecordSchema = StrictObject({
  // serde reads any string here; the parser after the version check maps it.
  backendId: Type.Union(
    [Type.Literal("picocodex"), Type.Literal("pi"), Type.Literal("codex")],
    { rule: "backend_id" },
  ),
  blob: StrictObject({
    objectKey: text("object_key"),
    sha256: sha256(),
    byteLength: Type.Integer({
      ...NonNegativeInteger,
      rule: "nonzero_byte_length",
    }),
    formatVersion: actorId(),
    harnessBuild: actorId(),
    createdAt: counter(),
  }),
  session: sessionIdentitySchema,
  turn: turnIdentitySchema,
  runtimeLease: runtimeLeaseSchema,
  runtimeRevision: actorId(),
  policyVersion: text("bounded_identity"),
  budgetRevision: actorId(),
  budgetUsage: sessionBudgetUsageSchema,
  usageCursor: counter(),
  budgetAccountDigest: sha256(),
  cursor: StrictObject({
    turn: turnIdentitySchema,
    lastSequence: positive(),
    lastEventDigest: sha256(),
  }),
  historyCursor: harnessHistoryCursorSchema,
  lastActorEventSequence: counter(),
  workspaceBaseRevision: actorId(),
  workspaceRevision: actorId(),
  instructionDigest: sha256(),
  toolCatalogDigest: sha256(),
  modelRouteDigest: sha256(),
});

export type SessionIdentity = Static<typeof sessionIdentitySchema>;
export type SessionContract = Static<typeof sessionContractSchema>;
export type RuntimeLease = Static<typeof runtimeLeaseSchema>;
export type WorkspaceRevisionReceipt = Static<
  typeof workspaceRevisionReceiptSchema
>;
export type VerifiedSessionCheckpoint = Static<
  typeof verifiedSessionCheckpointSchema
>;
export type SessionResumePoint = Static<typeof sessionResumePointSchema>;
export type TurnIdentity = Static<typeof turnIdentitySchema>;
export type TurnLifecycle = Static<typeof turnLifecycleSchema>;
export type HarnessTaskContinuation = Static<
  typeof harnessTaskContinuationSchema
>;
export type SessionRecoveryAction = Static<typeof sessionRecoveryActionSchema>;
export type SleepingSession = Static<typeof sleepingSessionSchema>;
export type ActivatingSession = Static<typeof activatingSessionSchema>;
export type ProcessingSession = Static<typeof processingSessionSchema>;
export type RecoveringSession = Static<typeof recoveringSessionSchema>;
export type CheckpointingSession = Static<typeof checkpointingSessionSchema>;
export type CancellingSession = Static<typeof cancellingSessionSchema>;
export type QuarantinedSession = Static<typeof quarantinedSessionSchema>;
export type TerminalSession = Static<typeof terminalSessionSchema>;
export type AgentSessionLifecycle = Static<typeof agentSessionLifecycleSchema>;
export type AcceptedInputRef = Static<typeof acceptedInputRefSchema>;
export type CodeModeExecutionReceipt = Static<
  typeof codeModeExecutionReceiptSchema
>;
export type SessionCommand = Static<typeof sessionCommandSchema>;
export type SessionImportEvidence = Static<typeof sessionImportEvidenceSchema>;
export type SessionTransition = Static<typeof sessionTransitionSchema>;
export type HarnessCheckpointRecord = Static<
  typeof harnessCheckpointRecordSchema
>;
