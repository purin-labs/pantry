import { commerceSystemKindSchema } from "./commerce-system.ts";
import { Type } from "typebox";
import {
  countSchema,
  nonBlankTextSchema,
  positiveCountSchema,
} from "./connector-rpc.ts";

// Refactor 10 step 2: the stored records and RPC inputs of CaseDO as TypeBox
// schemas. As for the Connector, a schema checks the shape and the parser then
// copies the named fields; extra fields stay allowed. A field that the old
// parser read with `String(value)` stays `Unknown` here, and the parser keeps
// that check, so no stored record reads differently.

const strict = { additionalProperties: false } as const;
/** A lowercase SHA-256 digest in hexadecimal. */
export const digestSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
/** A field that must be absent or undefined. */
const absent = Type.Optional(Type.Never());

export const caseTriggerSchema = Type.Object({
  triggerId: nonBlankTextSchema,
  caseId: nonBlankTextSchema,
  acceptedAt: countSchema,
  source: Type.Object({}),
  title: Type.Optional(nonBlankTextSchema),
});

export const caseTriggerSourceSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("connector"),
    connectorId: nonBlankTextSchema,
    ingressId: nonBlankTextSchema,
  }),
  Type.Object({ kind: Type.Literal("cue"), eventId: nonBlankTextSchema }),
  Type.Object({ kind: Type.Literal("api"), commandId: nonBlankTextSchema }),
]);

export const caseBindingSchema = Type.Object({
  bindingId: nonBlankTextSchema,
  caseId: nonBlankTextSchema,
  connectorId: nonBlankTextSchema,
});

export const assignmentLifecycleSchema = Type.Object({
  kind: Type.String(),
});

export const assignmentStartSchema = Type.Object({
  startId: nonBlankTextSchema,
  sessionId: nonBlankTextSchema,
  acceptedAt: countSchema,
});

export const terminalDispositionSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("completed"),
    proposalId: nonBlankTextSchema,
    settledAt: countSchema,
  }),
  Type.Object({
    kind: Type.Literal("cancelled"),
    commandId: nonBlankTextSchema,
    settledAt: countSchema,
  }),
  Type.Object({
    kind: Type.Literal("failed"),
    code: nonBlankTextSchema,
    settledAt: countSchema,
  }),
  Type.Object({
    kind: Type.Literal("budget_exhausted"),
    exhaustionId: nonBlankTextSchema,
    dimension: Type.Union([
      Type.Literal("tokens"),
      Type.Literal("active_wall_ms"),
      Type.Literal("capability_calls"),
    ]),
    settledAt: countSchema,
  }),
  Type.Object({
    kind: Type.Literal("abandoned"),
    reason: Type.Union([
      Type.Literal("never_started"),
      Type.Literal("session_quiescent"),
    ]),
    settledAt: countSchema,
  }),
]);

export const caseAssignmentSchema = Type.Object({
  assignmentId: nonBlankTextSchema,
  caseId: nonBlankTextSchema,
  caseRevision: countSchema,
  sessionId: nonBlankTextSchema,
  // Read with String(): see the note at the top.
  role: Type.Unknown(),
  objective: Type.Object({ instruction: nonBlankTextSchema }),
  authority: Type.Object({
    capabilityProfile: Type.Unknown(),
    authorityPartitionDigest: digestSchema,
  }),
  authorityPartition: Type.Optional(Type.Unknown()),
  budget: Type.Object({
    budgetRevision: nonBlankTextSchema,
    maxTokens: positiveCountSchema,
    maxWallMs: positiveCountSchema,
    maxToolCalls: positiveCountSchema,
  }),
  context: Type.Object({
    caseId: nonBlankTextSchema,
    revision: countSchema,
    workspaceRevision: nonBlankTextSchema,
    entries: Type.Array(Type.Unknown()),
    journalCursor: Type.Object({}),
    evidenceDependency: Type.Optional(Type.Unknown()),
  }),
});

export const sessionProposalSchema = Type.Object({
  proposalId: nonBlankTextSchema,
  assignmentId: nonBlankTextSchema,
  caseId: nonBlankTextSchema,
  sessionId: nonBlankTextSchema,
  turnId: nonBlankTextSchema,
  basedOnRevision: countSchema,
  entries: Type.Array(Type.Unknown()),
  requestedEffects: Type.Array(Type.Unknown()),
});

export const caseProposalAcceptanceSchema = Type.Object({
  outputs: Type.Array(Type.Unknown()),
  disposition: Type.Optional(Type.Unknown()),
});

export const outputLifecycleSchema = Type.Object({
  kind: Type.String(),
  output: Type.Optional(Type.Unknown()),
});

export const droppedOutputSchema = Type.Object({
  reason: Type.Union([
    Type.Literal("denied"),
    Type.Literal("expired"),
    Type.Literal("undelivered"),
  ]),
  droppedAt: countSchema,
});

export const heldOutputSchema = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
  heldAt: countSchema,
});

export const rejectedOutputSchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 256 }),
  rejectedAt: countSchema,
});

export const caseContributionSourceSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("operator_command"),
    commandId: nonBlankTextSchema,
    requestDigest: nonBlankTextSchema,
    proposalId: absent,
    assignmentId: absent,
    sessionId: absent,
    turnId: absent,
    actionNonce: absent,
  }),
  Type.Object({
    kind: Type.Literal("agent_turn"),
    commandId: absent,
    requestDigest: absent,
    proposalId: nonBlankTextSchema,
    assignmentId: nonBlankTextSchema,
    sessionId: nonBlankTextSchema,
    turnId: nonBlankTextSchema,
    actionNonce: absent,
  }),
  Type.Object({
    kind: Type.Literal("commerce_outcome"),
    commandId: absent,
    requestDigest: absent,
    proposalId: nonBlankTextSchema,
    actionNonce: nonBlankTextSchema,
    assignmentId: absent,
    sessionId: absent,
    turnId: absent,
  }),
  Type.Object({
    kind: Type.Literal("commerce_approval_notice"),
    commandId: absent,
    requestDigest: absent,
    proposalId: nonBlankTextSchema,
    actionNonce: nonBlankTextSchema,
    assignmentId: absent,
    sessionId: absent,
    turnId: absent,
  }),
]);

export const caseOutputSchema = Type.Object({
  proposalId: absent,
  outputId: nonBlankTextSchema,
  entryId: nonBlankTextSchema,
  connectorId: nonBlankTextSchema,
  flowBinding: Type.Optional(Type.Unknown()),
  delivery: Type.Optional(Type.Unknown()),
  source: Type.Optional(Type.Unknown()),
});

export const caseDeliveryReceiptSchema = Type.Object({
  deliveryId: nonBlankTextSchema,
  connectorId: nonBlankTextSchema,
  idempotencyKey: nonBlankTextSchema,
  nativeReceiptId: nonBlankTextSchema,
  deliveredAt: countSchema,
  flowBindingDigest: digestSchema,
  decisionDigest: digestSchema,
});

export const contextEntrySchema = Type.Union([
  Type.Object({
    kind: Type.Literal("inline_preview"),
    entryId: nonBlankTextSchema,
    digest: digestSchema,
    preview: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("artifact"),
    entryId: nonBlankTextSchema,
    digest: digestSchema,
    artifact: Type.Object({
      id: nonBlankTextSchema,
      kind: nonBlankTextSchema,
      url: Type.Union([Type.Null(), Type.String()]),
    }),
  }),
]);

export const proposedEffectSchema = Type.Object({
  effectId: nonBlankTextSchema,
  policyVersion: nonBlankTextSchema,
  stakes: Type.Union([Type.Literal("low_stakes"), Type.Literal("high_stakes")]),
});

export const proposedEntrySchema = Type.Object({
  entryId: nonBlankTextSchema,
  kind: Type.Union([
    Type.Literal("observation"),
    Type.Literal("shared_change"),
  ]),
  content: Type.Optional(Type.Unknown()),
  baseRevision: Type.Optional(Type.Unknown()),
});

export const journalCursorSchema = Type.Union([
  Type.Object({ kind: Type.Literal("before_first") }),
  Type.Object({
    kind: Type.Literal("accepted"),
    sequence: countSchema,
    entryDigest: digestSchema,
  }),
]);

export const proposalDispositionSchema = Type.Union([
  Type.Object({
    kind: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("rebase_required"),
    ]),
    revision: countSchema,
  }),
  // The reason is read with String(): see the note at the top.
  Type.Object({ kind: Type.Literal("rejected"), reason: Type.Unknown() }),
]);

export const caseLifecycleSchema = Type.Union([
  Type.Object({ kind: Type.Literal("open"), openedAt: countSchema }),
  Type.Object({
    kind: Type.Literal("waiting"),
    wait: Type.Union([
      Type.Object({
        kind: Type.Literal("input"),
        triggerId: nonBlankTextSchema,
      }),
      Type.Object({
        kind: Type.Literal("approval"),
        approvalRequestId: nonBlankTextSchema,
      }),
      Type.Object({
        kind: Type.Literal("schedule"),
        scheduleId: nonBlankTextSchema,
      }),
    ]),
  }),
  Type.Object({ kind: Type.Literal("completing"), startedAt: countSchema }),
  Type.Object({ kind: Type.Literal("completed"), completedAt: countSchema }),
  Type.Object({
    kind: Type.Literal("quarantined"),
    reason: nonBlankTextSchema,
    quarantinedAt: countSchema,
  }),
  Type.Object({ kind: Type.Literal("archived"), archivedAt: countSchema }),
]);

export const emailProposalEvidenceSchema = Type.Union([
  Type.Object({ kind: Type.Literal("source_only") }, strict),
  Type.Object(
    {
      kind: Type.Literal("case_context_collection_evidence"),
      dependency: Type.Unknown(),
      flowBindingDigest: digestSchema,
    },
    strict,
  ),
]);

export const goalMessageSchema = Type.Object({
  commandId: nonBlankTextSchema,
  text: Type.String(),
  acceptedAt: countSchema,
  support: Type.Union([Type.Literal("pi"), Type.Literal("unavailable")]),
  requestAuthority: Type.Optional(Type.Unknown()),
  authorityPartition: Type.Optional(Type.Unknown()),
});

// RPC inputs of CaseDO.

export const caseEnsureRequestSchema = Type.Object({
  identity: Type.Object({
    organisationId: nonBlankTextSchema,
    caseId: nonBlankTextSchema,
  }),
  lifecycle: Type.Object({ kind: Type.Literal("open"), openedAt: countSchema }),
  purpose: nonBlankTextSchema,
  workspaceRevision: nonBlankTextSchema,
});

const assignmentRequestFields = {
  caseId: nonBlankTextSchema,
  assignmentId: nonBlankTextSchema,
  sessionId: nonBlankTextSchema,
  expectedCaseRevision: countSchema,
};
export const beginAssignmentRequestSchema = Type.Object({
  ...assignmentRequestFields,
  start: Type.Optional(Type.Unknown()),
});
export const abandonAssignmentRequestSchema = Type.Object({
  ...assignmentRequestFields,
  expectedState: Type.Union([
    Type.Literal("assigned"),
    Type.Literal("running"),
  ]),
  expectedStartId: Type.Union([nonBlankTextSchema, Type.Null()]),
  proof: Type.Object({
    kind: Type.Literal("session_quiescent"),
    sessionId: nonBlankTextSchema,
    inspectedAt: countSchema,
  }),
  minimumAgeMs: countSchema,
  abandonedAt: countSchema,
});
export const settleAssignmentRequestSchema = Type.Object({
  ...assignmentRequestFields,
  expectedStartId: nonBlankTextSchema,
  disposition: Type.Optional(Type.Unknown()),
});

const commerceApprovalFields = {
  caseId: nonBlankTextSchema,
  proposalId: nonBlankTextSchema,
  actionNonce: nonBlankTextSchema,
};
export const waitForCommerceApprovalRequestSchema = Type.Object({
  ...commerceApprovalFields,
  expectedCaseRevision: countSchema,
  requestedAt: countSchema,
});
export const resolveCommerceApprovalRequestSchema = Type.Object({
  ...commerceApprovalFields,
  decision: Type.Optional(Type.Unknown()),
});
export const commerceApprovalRecordSchema = Type.Object({
  request: Type.Optional(Type.Unknown()),
});

export const commerceCaseProposalSchema = Type.Object({
  proposalId: nonBlankTextSchema,
  caseId: nonBlankTextSchema,
  basedOnRevision: countSchema,
  origin: Type.Object({}),
});
export const commerceEntityPlaneCaseProposalSchema = Type.Object({
  kind: Type.Literal("entity_plane"),
  proposalId: nonBlankTextSchema,
  caseId: nonBlankTextSchema,
  basedOnRevision: countSchema,
  origin: Type.Object({}),
});

export const integrationAccountAuthoritySchema = Type.Object({
  kind: Type.Literal("integration_account"),
  integrationAccountId: nonBlankTextSchema,
});
export const commerceSystemAuthoritySchema = Type.Object({
  kind: Type.Literal("commerce_system"),
  system: commerceSystemKindSchema,
  integrationAccountId: nonBlankTextSchema,
  revision: Type.Optional(Type.Unknown()),
});

export const commerceProposalOriginSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("merchant_control"),
    userId: nonBlankTextSchema,
    controlSessionId: nonBlankTextSchema,
  }),
  Type.Object({
    kind: Type.Literal("agent_session"),
    sessionId: nonBlankTextSchema,
    assignmentId: nonBlankTextSchema,
    threadId: nonBlankTextSchema,
  }),
]);

export const commerceProposalAcceptanceSchema = Type.Object({
  kind: Type.Literal("accepted"),
  revision: countSchema,
});

export const acceptDeliveryReceiptRequestSchema = Type.Object({
  outputId: nonBlankTextSchema,
  receipt: Type.Optional(Type.Unknown()),
});

const dropReasonSchema = Type.Union([
  Type.Literal("denied"),
  Type.Literal("expired"),
]);
export const noteRefusedEffectRequestSchema = Type.Object({
  requestId: nonBlankTextSchema,
  organisationId: nonBlankTextSchema,
  authorityPartitionDigest: nonBlankTextSchema,
  reason: dropReasonSchema,
  notedAt: countSchema,
  requestAuthority: Type.Optional(Type.Unknown()),
});
export const dropHeldOutputRequestSchema = Type.Object({
  outputId: nonBlankTextSchema,
  reason: dropReasonSchema,
  droppedAt: countSchema,
  requestAuthority: Type.Optional(Type.Unknown()),
});

export const acceptCommerceOutcomeRequestSchema = Type.Object({
  ...commerceApprovalFields,
  acceptedAt: countSchema,
  outcome: Type.Optional(Type.Unknown()),
  content: Type.Optional(Type.Unknown()),
});

export const commerceCaseOutcomeSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("provider_receipt"),
    receipt: Type.Optional(Type.Unknown()),
  }),
  Type.Object({
    kind: Type.Literal("merchant_rejection"),
    evidence: Type.Optional(Type.Unknown()),
  }),
  Type.Object({
    kind: Type.Literal("execution_failure"),
    actionNonce: nonBlankTextSchema,
  }),
]);

const emailProposalStoredFields = {
  proposalId: nonBlankTextSchema,
  caseId: nonBlankTextSchema,
  version: positiveCountSchema,
  policyVersion: positiveCountSchema,
  createdAt: countSchema,
  expiresAt: countSchema,
  targetDigest: digestSchema,
  bodyDigest: digestSchema,
  snapshotDigest: digestSchema,
  lifecycle: Type.Optional(Type.Unknown()),
};
export const operationalEmailProposalSchema = Type.Object({
  ...emailProposalStoredFields,
  kind: Type.Literal("operational_new_message"),
  integrationAccountId: nonBlankTextSchema,
  credentialGeneration: positiveCountSchema,
  subjectDigest: digestSchema,
  target: Type.Optional(Type.Unknown()),
});
export const replyEmailProposalSchema = Type.Object({
  ...emailProposalStoredFields,
  threadId: nonBlankTextSchema,
  providerDraftId: nonBlankTextSchema,
  providerDraftMessageId: nonBlankTextSchema,
  triggeringProviderMessageId: nonBlankTextSchema,
  mailboxBindingId: nonBlankTextSchema,
  bindingRevision: positiveCountSchema,
  evidence: Type.Optional(Type.Unknown()),
});
