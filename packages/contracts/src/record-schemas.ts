import { Type, type Static } from "typebox";
import { fileResourceScopeSchema } from "./access-control.ts";

// Plan 78: TypeBox schemas of goal.rs, portal_chat.rs and file_context.rs.
// Rust only serializes these types, so they carry no parser of their own;
// goal.ts keeps its own TypeScript checks.

const caseGoalStateSchema = Type.Union([
  Type.Object({ kind: Type.Literal("active") }),
  Type.Object({ kind: Type.Literal("paused") }),
  Type.Object({ kind: Type.Literal("budget_limited") }),
  Type.Object({ kind: Type.Literal("completed"), evidence: Type.String() }),
  Type.Object({ kind: Type.Literal("cleared") }),
]);
const caseGoalSchema = Type.Object({
  goalId: Type.String(),
  organisationId: Type.String(),
  caseId: Type.String(),
  objective: Type.String(),
  tokenBudget: Type.Number(),
  tokensUsed: Type.Number(),
  activeTimeMs: Type.Number(),
  unknownOperations: Type.Number(),
  state: caseGoalStateSchema,
});
const caseGoalSnapshotSchema = Type.Union([
  Type.Object({ kind: Type.Literal("none"), revision: Type.Number() }),
  Type.Object({
    kind: Type.Literal("present"),
    revision: Type.Number(),
    goal: caseGoalSchema,
  }),
]);
const caseGoalCommandSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("set"),
    objective: Type.String(),
    tokenBudget: Type.Number(),
  }),
  Type.Object({
    kind: Type.Literal("update_budget"),
    tokenBudget: Type.Number(),
  }),
  Type.Object({ kind: Type.Literal("pause") }),
  Type.Object({ kind: Type.Literal("resume") }),
  Type.Object({ kind: Type.Literal("complete"), evidence: Type.String() }),
  Type.Object({ kind: Type.Literal("clear") }),
]);
const caseGoalOperationOutcomeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("unknown") }),
  Type.Object({
    kind: Type.Literal("reported"),
    tokens: Type.Number(),
    activeTimeMs: Type.Number(),
  }),
]);

const portalChatRunStateSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("cancelling"),
  Type.Literal("ready"),
  Type.Literal("failed"),
]);
const portalChatPauseReasonSchema = Type.Union([
  Type.Literal("awaiting_permission"),
]);
const portalChatStreamFailureSchema = Type.Object({
  code: Type.String(),
  retryable: Type.Boolean(),
});
const portalChatStreamRecordSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("assistant_text_delta"),
    sequence: Type.Number(),
    text: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("progress"),
    sequence: Type.Number(),
    label: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("run_state"),
    sequence: Type.Number(),
    run: portalChatRunStateSchema,
  }),
  Type.Object({
    kind: Type.Literal("usage"),
    sequence: Type.Number(),
    inputTokens: Type.Number(),
    outputTokens: Type.Number(),
    cachedInputTokens: Type.Union([Type.Number(), Type.Null()]),
    totalTokens: Type.Number(),
  }),
  Type.Object({
    kind: Type.Literal("complete"),
    sequence: Type.Number(),
    conversationRevision: Type.Number(),
  }),
  Type.Object({
    kind: Type.Literal("paused"),
    sequence: Type.Number(),
    run: portalChatPauseReasonSchema,
  }),
  Type.Object({
    kind: Type.Literal("failed"),
    sequence: Type.Number(),
    message: Type.String(),
    failure: Type.Optional(portalChatStreamFailureSchema),
  }),
]);

const fileContextProviderSchema = Type.Union([
  Type.Literal("dropbox"),
  Type.Literal("google_drive"),
]);
const fileResourceGrantTargetSchema = Type.Object({
  kind: Type.Literal("file_resource"),
  capabilityId: Type.String(),
  capabilityVersion: Type.Number(),
  integrationAccountId: Type.String(),
  scope: fileResourceScopeSchema,
});
const providerFileRevisionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("dropbox"), rev: Type.String() }),
  Type.Object({
    kind: Type.Literal("gdrive"),
    version: Type.String(),
    modifiedTime: Type.String(),
    headRevisionId: Type.Union([Type.String(), Type.Null()]),
  }),
]);
const canonicalContextSourceRefSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("case_entry"),
    caseId: Type.String(),
    entryId: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("file_segment"),
    integrationAccountId: Type.String(),
    provider: fileContextProviderSchema,
    providerFileId: Type.String(),
    segmentIndex: Type.Number(),
  }),
]);
const contextSourceRevisionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("case_entry"), sequence: Type.Number() }),
  Type.Object({
    kind: Type.Literal("file"),
    sequence: Type.Number(),
    providerRevision: providerFileRevisionSchema,
  }),
]);
const fileGrantSyncStateSchema = Type.Union([
  Type.Object({ kind: Type.Literal("pending"), nextRunAt: Type.Number() }),
  Type.Object({
    kind: Type.Literal("reconciling"),
    leaseId: Type.String(),
    leaseExpiresAt: Type.Number(),
    startedAt: Type.Number(),
  }),
  Type.Object({
    kind: Type.Literal("ready"),
    reconciledAt: Type.Number(),
    nextRunAt: Type.Number(),
  }),
  Type.Object({
    kind: Type.Literal("retry_wait"),
    attempt: Type.Number(),
    reason: Type.String(),
    nextRunAt: Type.Number(),
  }),
  Type.Object({
    kind: Type.Literal("capped"),
    observedFileCount: Type.Number(),
    maxFileCount: Type.Number(),
    cappedAt: Type.Number(),
  }),
]);
const providerFileCursorSchema = Type.Union([
  Type.Object({ kind: Type.Literal("dropbox"), cursor: Type.String() }),
  Type.Object({ kind: Type.Literal("gdrive"), pageToken: Type.String() }),
]);
const fileGrantAdmissionSchema = Type.Object({
  grantId: Type.String(),
  grantRevision: Type.Number(),
  integrationAccountId: Type.String(),
  provider: fileContextProviderSchema,
  providerFileId: Type.String(),
  containingScopeKey: Type.String(),
  providerRevision: providerFileRevisionSchema,
});

export type CaseGoalStateValue = Static<typeof caseGoalStateSchema>;
export type CaseGoalValue = Static<typeof caseGoalSchema>;
export type CaseGoalSnapshotValue = Static<typeof caseGoalSnapshotSchema>;
export type CaseGoalCommandValue = Static<typeof caseGoalCommandSchema>;
export type CaseGoalOperationOutcomeValue = Static<
  typeof caseGoalOperationOutcomeSchema
>;
export type PortalChatStreamRecord = Static<
  typeof portalChatStreamRecordSchema
>;
export type FileContextProvider = Static<typeof fileContextProviderSchema>;
export type FileResourceGrantTarget = Static<
  typeof fileResourceGrantTargetSchema
>;
export type ProviderFileRevision = Static<typeof providerFileRevisionSchema>;
export type CanonicalContextSourceRef = Static<
  typeof canonicalContextSourceRefSchema
>;
export type ContextSourceRevision = Static<typeof contextSourceRevisionSchema>;
export type FileGrantSyncState = Static<typeof fileGrantSyncStateSchema>;
export type ProviderFileCursor = Static<typeof providerFileCursorSchema>;
export type FileGrantAdmission = Static<typeof fileGrantAdmissionSchema>;
