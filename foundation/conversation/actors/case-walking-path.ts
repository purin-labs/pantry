import type { Env } from "@purin-labs/kernel/env";
import { holdCaseOutput } from "./case-output-hold";
import type { Outcome } from "@purin-labs/contracts";
import type { ProjectSnapshot } from "@purin-labs/control-api";
import type {
  AgentRole,
  CaseAssignment,
  CaseBinding,
  CaseContent,
  CaseTrigger,
  CaseTriggerSource,
  ConnectorIdentity,
  ConnectorIngress,
  EventPrincipal,
  PageBrowserContext,
  RequestAuthority,
  SessionBudget,
  SessionBudgetExhaustion,
  SessionProposal,
  StoredMessageAttachment,
  WorkspaceRevisionReceipt,
} from "@purin-labs/contracts";

import { caseContentAttachments, caseContentInstruction } from "./case-content";
import { userMessageLinks } from "@purin-labs/agent/actors/message-tools";
import {
  parseChannelId,
  parseWorkspaceId,
  type RequestId,
  type SessionId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { PinnedSessionPolicy } from "@purin-labs/authority/policy-snapshot";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { isActorExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import {
  decideCaseConversationSink,
  type AllowFlowDecision,
} from "./case-conversation-sink";
import { traceLog } from "@purin-labs/kernel/observability";
import { FlowBinding, sinkRefusalAsksPerson } from "@purin-labs/authority/policy/index";
import type { SerializedFlowBinding } from "@purin-labs/authority/policy/index";
import {
  slackCaseOutputIdempotencyKey,
  slackCaseStreamId,
  slackCaseTurnId,
  type ConnectorCaseStreamRelease,
  type ConnectorCaseTurnStreamInput,
  type ConnectorCaseTurnStreamError,
  type ConnectorCaseTurnStreamResult,
} from "./case-turn-stream";
import { parseSessionTurnInputDigest } from "@purin-labs/agent/actors/agent-session-turn-input-digest";
import { serializeContextBundle } from "@purin-labs/agent/actors/actor-journal/parsers";
import type {
  InitializedCaseSessionCommit,
  InitializedSessionCommit,
} from "@purin-labs/agent/actors/actor-journal";
import type { CanonicalEmbeddedHarnessTextTurnError } from "@purin-labs/agent/actors/session/types";
import type { SessionActor } from "@purin-labs/agent/actors/session/session-actor";
import type { CaseActor } from "./case/case-actor";
import type { CaseOutput, CaseSnapshot } from "./case/types";
import type { CaseConnectorRpc } from "./case/connector-rpc";
import type { SessionActorRoute } from "@purin-labs/actor-runtime/actors/actor-router";
import type { ConnectorWarmActorSlots } from "@purin-labs/actor-runtime/actors/warm-actor-slots";
import { selectEmbeddedHarnessAdapterForModelRoute } from "@purin-labs/agent/actors/embedded-harness-adapter";
import type {
  EmbeddedHarnessModelUsage,
  EmbeddedHarnessThinkingLevel,
} from "@purin-labs/agent/actors/embedded-harness";
import { EMBEDDED_HARNESS_INSTRUCTIONS } from "@purin-labs/agent/actors/embedded-harness-instructions";
import {
  composeAgentInstructions,
  type PinnedAgentProfile,
} from "@purin-labs/agent/data/pinned-agent-profile";
import type { CompiledTurnAuthority } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import type { ContextAssemblyResult } from "@purin-labs/agent/context/assembly/index";
import type { TurnPageState } from "@purin-labs/agent/actors/session/tool-wiring";
import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import {
  assertNever,
  isPositiveInteger,
  sameJson,
  sha256Hex,
} from "@purin-labs/std";

type CaseWalkingConnector = CaseConnectorRpc;
export type OngoingCaseWalkingConnector = CaseWalkingConnector & {
  /** Streams a Case turn; the release check lets its answer reach the thread. */
  streamCaseTurn(
    raw: unknown,
    release: ConnectorCaseStreamRelease,
  ): Promise<Result<ConnectorCaseTurnStreamResult, ConnectorCaseTurnStreamError>>;
  /** The Connector's warm Case and Session slots (Plan 55F). */
  readonly warmActorSlots: ConnectorWarmActorSlots;
};
export type CaseWalkingCase = Pick<
  CaseActor,
  | "prepareDirectTurn"
  | "assignSession"
  | "beginAssignment"
  | "settleAssignment"
  | "abandonAssignment"
  | "assignmentLifecycles"
  | "acceptSessionProposal"
  | "acceptDeliveryReceipt"
  | "holdOutput"
  | "rejectOutput"
  | "inspect"
>;
type OngoingCaseWalkingCase = CaseWalkingCase &
  Pick<CaseActor, "prepareOngoingTurn">;
export type CaseWalkingSession = {
  initializeCaseSession(
    input: Parameters<SessionActor["initializeCaseSession"]>[0],
  ): Promise<Result<unknown, { readonly code: string }>>;
  prepareSessionInformationFlow(input: {
    readonly requestingOrganisationId: OrganisationId;
    readonly sessionId: SessionId;
    readonly turnId: string;
    readonly authorityPartitionDigest: string;
    readonly contextBundle: unknown;
  }): Promise<
    Result<
      { readonly flowBinding: SerializedFlowBinding },
      { readonly code: string }
    >
  >;
  startCanonicalEmbeddedHarnessTextTurn(
    input: Parameters<SessionActor["startCanonicalEmbeddedHarnessTextTurn"]>[0],
  ): Promise<
    Result<
      {
        readonly finalMessage: string;
        readonly outcome: Outcome;
        readonly flowBinding: SerializedFlowBinding;
        readonly modelUsage?: EmbeddedHarnessModelUsage;
      },
      CanonicalEmbeddedHarnessTextTurnError
    >
  >;
};

export type OngoingCaseWalkingSession = CaseWalkingSession &
  Pick<SessionActor, "inspectTurnStream">;

type RevalidateTurnAuthority = () => Promise<
  Result<CompiledTurnAuthority, { readonly code: string }>
>;

export type CaseWalkingPathInput = {
  readonly env: Env;
  readonly connector: CaseWalkingConnector;
  readonly caseActor: CaseWalkingCase;
  readonly session: CaseWalkingSession;
  readonly organisationId: OrganisationId;
  readonly requestId: RequestId;
  readonly sessionId: SessionId;
  readonly connectorIdentity: ConnectorIdentity;
  readonly ingress: ConnectorIngress;
  readonly binding: CaseBinding;
  readonly assignmentId: string;
  readonly purpose: string;
  readonly principalId: string;
  readonly policy: PinnedSessionPolicy;
  readonly workspaceRevisionReceipt: WorkspaceRevisionReceipt;
  readonly receivedAt: number;
  readonly turnAuthority: CompiledTurnAuthority;
  readonly revalidateTurnAuthority: RevalidateTurnAuthority;
  readonly context: ContextAssemblyResult;
  readonly projectContext: ProjectSnapshot | null;
  readonly thinkingLevel?: EmbeddedHarnessThinkingLevel;
  /**
   * The installed agent this turn runs, or null when no installation owns the
   * Case. Its published instructions and pinned skills compose the system
   * prompt; the platform harness rules apply either way.
   */
  readonly pinnedAgent: PinnedAgentProfile | null;
};

type OngoingCaseTurnResult =
  | { readonly kind: "duplicate_ingress"; readonly caseId: string }
  | {
      readonly kind: "delivery_pending";
      readonly caseId: string;
      readonly retryAt: number;
    }
  /** The exit check stopped the answer, and it waits for a person. */
  | { readonly kind: "delivery_held"; readonly caseId: string }
  | {
      readonly kind: "completed";
      readonly assignment: CaseAssignment;
      readonly proposal: SessionProposal;
      readonly completion: {
        readonly finalMessage: string;
        readonly modelUsage?: EmbeddedHarnessModelUsage;
      };
      readonly caseRevision: number;
      readonly deliveryReceiptId: string;
    };

const admittedCaseTurn = Symbol("admitted_case_turn");

export type AdmittedCaseTurn = Readonly<{
  [admittedCaseTurn]: true;
  ingressId: string;
  snapshot: CaseSnapshot;
  trigger: CaseTrigger;
}>;

export type OngoingCaseTurnInput = Omit<
  CaseWalkingPathInput,
  "caseActor" | "session" | "connector"
> & {
  readonly admittedCase: AdmittedCaseTurn;
  readonly connector: OngoingCaseWalkingConnector;
  readonly caseActor: OngoingCaseWalkingCase;
  readonly session: OngoingCaseWalkingSession;
  readonly sessionRoute: SessionActorRoute;
  /**
   * Which attempt of the accepted work this is, from 1. Only a later attempt
   * can find its turn in the Session, so only a later attempt looks for it.
   */
  readonly attempt: number;
  readonly output:
    | { readonly kind: "terminal" }
    | {
        readonly kind: "slack_stream";
        /** The Slack user that the answer replies to. */
        readonly recipientUserId: string;
      };
};

/**
 * The Session of a participant of a two-session trigger. It also answers for
 * a turn that it ran before this delivery.
 */
export type TwoSessionCaseSession = CaseWalkingSession &
  Pick<SessionActor, "inspectTurnStream" | "readCompletedTurn">;

type CaseParticipantInput = {
  readonly session: TwoSessionCaseSession;
  readonly requestId: RequestId;
  readonly sessionId: SessionId;
  readonly assignmentId: string;
  readonly role: AgentRole;
  readonly objective: string;
  /** Names this participant's input when two participants share a role. */
  readonly inputKey?: string;
};

/**
 * A third assignment of a two-session Case. It starts after both
 * participants ended, and its context holds what both proposed. Its proposal
 * so follows from the two assignments.
 */
type CombinedCaseParticipantInput = {
  readonly participant: CaseParticipantInput;
  /**
   * Assembled after the trigger is accepted, so that each participant's turn
   * is bound to the trigger's label. A proposal with no label is not admitted
   * to a later context.
   */
  readonly prepareParticipantContexts: () => Promise<
    Result<
      readonly [ContextAssemblyResult, ContextAssemblyResult],
      { readonly code: string }
    >
  >;
  /** Assembled after both proposals are accepted, so that it holds them. */
  readonly prepareContext: () => Promise<
    Result<ContextAssemblyResult, { readonly code: string }>
  >;
};

export type DirectCasePathInput = {
  readonly env: Env;
  readonly pinnedAgent: PinnedAgentProfile | null;
  readonly caseActor: CaseWalkingCase;
  readonly session: CaseWalkingSession;
  readonly organisationId: OrganisationId;
  readonly requestId: RequestId;
  readonly sessionId: SessionId;
  readonly caseId: string;
  readonly triggerId: string;
  readonly triggerSource: Exclude<
    CaseTriggerSource,
    { readonly kind: "connector" }
  >;
  readonly content: CaseContent;
  /**
   * What the trigger is about, in a few words from its own source. The Case
   * stores it with the trigger and shows it under the trigger's label.
   */
  readonly title?: string;
  readonly assignmentId: string;
  readonly purpose: string;
  readonly principal: EventPrincipal;
  readonly policy: PinnedSessionPolicy;
  readonly workspaceRevisionReceipt: WorkspaceRevisionReceipt;
  readonly receivedAt: number;
  readonly role: AgentRole;
  readonly objective: string;
  readonly delivery: DirectCaseDelivery;
  readonly turnAuthority: CompiledTurnAuthority;
  readonly revalidateTurnAuthority: RevalidateTurnAuthority;
  readonly context: ContextAssemblyResult;
  readonly projectContext: ProjectSnapshot | null;
  readonly thinkingLevel?: EmbeddedHarnessThinkingLevel;
  readonly browserContext: PageBrowserContext;
  readonly surfaceContext: TurnPageState;
};

export type DirectCasePathResult =
  | { readonly kind: "duplicate_trigger"; readonly caseId: string }
  | {
      readonly kind: "completed";
      readonly assignment: CaseAssignment;
      readonly proposal: SessionProposal;
      readonly completion: {
        readonly finalMessage: string;
        readonly outcome: Outcome;
        readonly flowBinding: SerializedFlowBinding;
        readonly modelUsage?: EmbeddedHarnessModelUsage;
      };
      readonly caseRevision: number;
      readonly delivery: CompletedCaseParticipant["delivery"];
    };

type DirectTwoSessionCasePathInput = {
  readonly env: Env;
  readonly pinnedAgent: PinnedAgentProfile | null;
  readonly caseActor: CaseWalkingCase;
  readonly organisationId: OrganisationId;
  readonly caseId: string;
  readonly triggerId: string;
  readonly triggerSource: Exclude<
    CaseTriggerSource,
    { readonly kind: "connector" }
  >;
  readonly content: CaseContent;
  /**
   * What the trigger is about, in a few words from its own source. The Case
   * stores it with the trigger and shows it under the trigger's label.
   */
  readonly title?: string;
  readonly purpose: string;
  readonly principal: EventPrincipal;
  readonly policy: PinnedSessionPolicy;
  readonly workspaceRevisionReceipt: WorkspaceRevisionReceipt;
  readonly receivedAt: number;
  readonly participants: readonly [CaseParticipantInput, CaseParticipantInput];
  readonly delivery: DirectCaseDelivery;
  readonly turnAuthority: CompiledTurnAuthority;
  readonly revalidateTurnAuthority: RevalidateTurnAuthority;
  readonly contexts: readonly [ContextAssemblyResult, ContextAssemblyResult];
  readonly combined?: CombinedCaseParticipantInput;
};

export type DirectTwoSessionCasePathResult =
  | { readonly kind: "duplicate_trigger"; readonly caseId: string }
  | {
      readonly kind: "completed";
      readonly participants: readonly [
        DirectCaseParticipant,
        DirectCaseParticipant,
      ];
      /** Null when the command asked for no combined assignment. */
      readonly combined: DirectCaseParticipant | null;
      readonly finalCaseRevision: number;
    };

export type DirectCaseDelivery =
  | { readonly kind: "none" }
  | {
      readonly kind: "connector";
      readonly connector: CaseWalkingConnector;
      readonly connectorIdentity: ConnectorIdentity;
      readonly binding: CaseBinding;
    };

export type CaseWalkingPathError = StrictUnion<
  | {
      readonly kind: "budget_exhausted";
      readonly code: "session_turn:budget_exhausted";
      readonly exhaustion: SessionBudgetExhaustion;
      readonly budget: SessionBudget;
    }
  | {
      readonly kind: "history_corruption";
      readonly source: "session_stream" | "session_turn";
      readonly code: "embedded_harness_history_failed";
    }
  | {
      readonly kind: "usage_pending";
      readonly code: "session_turn:budget_reservation_indeterminate";
    }
  | {
      readonly kind: "operational";
      readonly code: string;
      readonly source?: never;
    }
>;

type CompletedCaseParticipant = {
  readonly assignment: CaseAssignment;
  readonly proposal: SessionProposal;
  readonly completion: {
    readonly finalMessage: string;
    readonly outcome: Outcome;
    readonly flowBinding: SerializedFlowBinding;
    readonly modelUsage?: EmbeddedHarnessModelUsage;
  };
  readonly caseRevision: number;
} & (
  | { readonly delivery: { readonly kind: "unaddressed" } }
  | {
      readonly delivery: {
        readonly kind: "delivered";
        readonly receiptId: string;
      };
    }
  | {
      readonly delivery: {
        readonly kind: "held";
        readonly requestId: string;
      };
    }
);

type DirectCaseParticipant = Omit<CompletedCaseParticipant, "delivery"> & {
  readonly delivery: CompletedCaseParticipant["delivery"];
};

type AssignedCaseSessionInput = {
  readonly env: Env;
  readonly pinnedAgent: PinnedAgentProfile | null;
  readonly caseActor: CaseWalkingCase;
  readonly session: CaseWalkingSession;
  readonly organisationId: OrganisationId;
  readonly requestId: RequestId;
  readonly sessionId: SessionId;
  readonly caseId: string;
  readonly inputId: string;
  readonly assignmentId: string;
  readonly purpose: string;
  readonly principal: EventPrincipal;
  readonly policy: PinnedSessionPolicy;
  readonly workspaceRevisionReceipt: WorkspaceRevisionReceipt;
  readonly receivedAt: number;
  readonly turnAuthority: CompiledTurnAuthority;
  readonly revalidateTurnAuthority: RevalidateTurnAuthority;
  readonly context: ContextAssemblyResult;
  readonly projectContext: ProjectSnapshot | null;
  readonly thinkingLevel?: EmbeddedHarnessThinkingLevel;
  readonly browserContext: PageBrowserContext;
  readonly surfaceContext: TurnPageState;
  /**
   * Derived from the admitted content by `caseContentAttachments`, never
   * supplied alongside it. Keeping the derivation at the construction sites
   * means no caller can hand the session a set of files the message does not
   * contain.
   */
  readonly attachments: readonly StoredMessageAttachment[];
  /** Links carried by the admitted message, scoped for the link tool. */
  readonly links: readonly string[];
  readonly delivery:
    | { readonly kind: "none" }
    | {
        readonly kind: "connector";
        readonly connector: CaseWalkingConnector;
        readonly connectorIdentity: ConnectorIdentity;
      };
};

function caseContentLinks(content: CaseContent): readonly string[] {
  return content.kind === "user_message" || content.kind === "record_message"
    ? userMessageLinks(content.message)
    : [];
}

export async function restoreFlowBinding(
  raw: SerializedFlowBinding,
): Promise<Result<FlowBinding, { readonly code: string }>> {
  const restored = await FlowBinding.restore(raw);
  return restored.ok
    ? restored
    : { ok: false, error: { code: "case_flow_binding_invalid" } };
}

export type TransientEmailAssignmentInput = {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly connectorSql: SqlStorage;
  readonly evidenceDependency: import("@purin-labs/contracts").CaseEvidenceDependency;
  readonly pinnedAgent: PinnedAgentProfile | null;
  readonly caseActor: CaseWalkingCase;
  readonly session: CaseWalkingSession &
    Pick<SessionActor, "inspectCaseSessionInitialization">;
  readonly organisationId: OrganisationId;
  readonly requestId: RequestId;
  readonly sessionId: SessionId;
  readonly caseId: string;
  readonly inputId: string;
  readonly assignmentId: string;
  readonly purpose: string;
  readonly objective: string;
  readonly principal: EventPrincipal;
  readonly policy: PinnedSessionPolicy;
  readonly workspaceRevisionReceipt: WorkspaceRevisionReceipt;
  readonly receivedAt: number;
  readonly turnAuthority: CompiledTurnAuthority;
  readonly revalidateTurnAuthority: RevalidateTurnAuthority;
  readonly context: ContextAssemblyResult;
  readonly projectContext: ProjectSnapshot | null;
};

type TransientEmailAssignmentError =
  | CaseWalkingPathError
  | {
      readonly kind: "placement_changed";
      readonly code: "connector_placement_conflict";
    };

/**
 * Prepares one transient email assignment: bounded budget, Case assignment,
 * session initialization under the pinned route, and the begun start record.
 * The caller runs the transient turn and settles the assignment with the
 * exact disposition; email content never appears in any of these records.
 */
export async function prepareTransientEmailAssignment(
  input: TransientEmailAssignmentInput,
): Promise<
  Result<
    {
      readonly assignment: CaseAssignment;
      readonly startId: string;
      readonly budget: SessionBudget;
    },
    TransientEmailAssignmentError
  >
> {
  if (input.scope.organisationId !== input.organisationId)
    return failure("case_admission_identity_mismatch");
  if (!(await isActorExecutionActive(input.connectorSql, input.scope)))
    return deferredTransientAssignment();
  const budget = boundedSessionBudget(input.policy);
  if (!budget.ok) return budget;
  const snapshot = await input.caseActor.inspect();
  if (!(await isActorExecutionActive(input.connectorSql, input.scope)))
    return deferredTransientAssignment();
  if (!snapshot.ok) return failure(snapshot.error.code);
  if (
    snapshot.value.identity.organisationId !== input.organisationId ||
    snapshot.value.identity.caseId !== input.caseId
  )
    return failure("case_admission_identity_mismatch");
  const existing = findAssignmentLifecycle(snapshot.value, input.assignmentId);
  if (
    existing?.kind === "running" ||
    snapshot.value.assignmentLifecycles.some(
      isCompetingTransientAssignment.bind(null, input.assignmentId),
    )
  )
    return failure("case_assignment_in_progress");
  if (existing?.kind === "settled") return failure("case_assignment_settled");
  const authority = await input.revalidateTurnAuthority();
  if (!(await isActorExecutionActive(input.connectorSql, input.scope)))
    return deferredTransientAssignment();
  if (!authority.ok) return failure(authority.error.code);
  if (
    authority.value.authorityPartition.digest !==
    input.turnAuthority.authorityPartition.digest
  )
    return failure("case_authority_partition_changed");
  const sessionInput: AssignedCaseSessionInput = {
    env: input.env,
    pinnedAgent: input.pinnedAgent,
    caseActor: input.caseActor,
    session: input.session,
    organisationId: input.organisationId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    caseId: input.caseId,
    inputId: input.inputId,
    assignmentId: input.assignmentId,
    purpose: input.purpose,
    principal: input.principal,
    policy: input.policy,
    workspaceRevisionReceipt: input.workspaceRevisionReceipt,
    receivedAt: input.receivedAt,
    turnAuthority: input.turnAuthority,
    revalidateTurnAuthority: input.revalidateTurnAuthority,
    context: input.context,
    projectContext: input.projectContext,
    attachments: [],
    links: [],
    browserContext: { kind: "unavailable" },
    surfaceContext: null,
    delivery: { kind: "none" },
  };
  const assignment = await buildAssignment(
    sessionInput,
    budget.value,
    snapshot.value.revision,
    snapshot.value.journalCursor,
    snapshot.value.entries,
    "coordinator",
    input.objective,
  );
  let emailAssignment: CaseAssignment = {
    assignmentId: assignment.assignmentId,
    caseId: assignment.caseId,
    caseRevision: assignment.caseRevision,
    sessionId: assignment.sessionId,
    role: assignment.role,
    objective: assignment.objective,
    authority: assignment.authority,
    authorityPartition: assignment.authorityPartition,
    budget: assignment.budget,
    context: {
      caseId: assignment.context.caseId,
      revision: assignment.context.revision,
      journalCursor: assignment.context.journalCursor,
      workspaceRevision: assignment.context.workspaceRevision,
      entries: assignment.context.entries,
      evidenceDependency: input.evidenceDependency,
    },
  };

  if (existing !== undefined) {
    if (!sameJson(existing.assignment, emailAssignment))
      return failure("case_assignment_conflict");
    emailAssignment = existing.assignment;
  }
  if (!(await isActorExecutionActive(input.connectorSql, input.scope)))
    return deferredTransientAssignment();
  if (existing === undefined) {
    const assigned = await input.caseActor.assignSession(emailAssignment);
    if (!(await isActorExecutionActive(input.connectorSql, input.scope)))
      return deferredTransientAssignment();
    if (!assigned.ok) return failure(assigned.error.code);
  }
  const initialized = initializedSession(sessionInput, emailAssignment);
  if (!initialized.ok) return initialized;
  const initialization = {
    initialization: initialized.value,
    assignment: emailAssignment,
  };
  let initializationState: { readonly kind: "missing" | "initialized" } = {
    kind: "missing",
  };
  if (existing !== undefined) {
    // Reuse the accepted initialization; replay would change its request metadata.
    const previous =
      await input.session.inspectCaseSessionInitialization(initialization);
    if (!(await isActorExecutionActive(input.connectorSql, input.scope)))
      return deferredTransientAssignment();
    if (!previous.ok) return failure(previous.error.code);
    initializationState = previous.value;
  }
  if (initializationState.kind === "missing") {
    const initialized =
      await input.session.initializeCaseSession(initialization);
    if (!(await isActorExecutionActive(input.connectorSql, input.scope)))
      return deferredTransientAssignment();
    if (!initialized.ok)
      return failure(`session_initialize:${initialized.error.code}`);
  }
  const startId = `start_turn_${input.inputId}`;
  const begun = await input.caseActor.beginAssignment({
    caseId: assignment.caseId,
    assignmentId: assignment.assignmentId,
    sessionId: assignment.sessionId,
    expectedCaseRevision: assignment.caseRevision,
    start: {
      startId,
      sessionId: assignment.sessionId,
      acceptedAt: input.receivedAt,
    },
  });
  if (!begun.ok) {
    if (!(await isActorExecutionActive(input.connectorSql, input.scope)))
      return deferredTransientAssignment();
    return failure(begun.error.code);
  }
  // The caller needs an issued start to settle its exact assignment during freeze.
  return {
    ok: true,
    value: { assignment: emailAssignment, startId, budget: budget.value },
  };
}

function deferredTransientAssignment(): Result<
  never,
  TransientEmailAssignmentError
> {
  return {
    ok: false,
    error: { kind: "placement_changed", code: "connector_placement_conflict" },
  };
}

function isCompetingTransientAssignment(
  assignmentId: string,
  lifecycle: CaseSnapshot["assignmentLifecycles"][number],
): boolean {
  return (
    lifecycle.assignment.assignmentId !== assignmentId &&
    lifecycle.kind !== "settled"
  );
}

export async function settleTransientEmailAssignment(
  input: Readonly<{
    caseActor: CaseWalkingCase;
    assignment: CaseAssignment;
    startId: string;
    disposition:
      | {
          readonly kind: "completed";
          readonly proposalId: string;
          readonly settledAt: number;
        }
      | {
          readonly kind: "cancelled";
          readonly commandId: string;
          readonly settledAt: number;
        }
      | {
          readonly kind: "failed";
          readonly code: string;
          readonly settledAt: number;
        };
  }>,
): Promise<Result<null, CaseWalkingPathError>> {
  const settled = await input.caseActor.settleAssignment({
    caseId: input.assignment.caseId,
    assignmentId: input.assignment.assignmentId,
    sessionId: input.assignment.sessionId,
    expectedCaseRevision: input.assignment.caseRevision,
    expectedStartId: input.startId,
    disposition: input.disposition,
  });
  return settled.ok ? { ok: true, value: null } : failure(settled.error.code);
}

export async function runDirectCasePath(
  input: DirectCasePathInput,
): Promise<Result<DirectCasePathResult, CaseWalkingPathError>> {
  const budget = boundedSessionBudget(input.policy);
  if (!budget.ok) return budget;
  const preparationStartedAt = Date.now();
  const prepared = await prepareDirectCase(input);
  traceDirectSessionPreparation(input, "case_trigger", preparationStartedAt);
  if (!prepared.ok) return prepared;
  if (prepared.value.kind === "duplicate") {
    const resumed = await resumeDirectCaseDelivery(
      input,
      prepared.value.snapshot,
    );
    if (!resumed.ok) return resumed;
    if (hasActiveCaseAssignment(prepared.value.snapshot)) {
      const resumed = await resumeStoppedDirectAssignment(
        input,
        prepared.value.snapshot,
      );
      if (resumed === null) return failure("case_assignment_in_progress");
      if (!resumed.ok) return resumed;
      return { ok: true, value: completedDirectCase(resumed.value) };
    }
    return {
      ok: true,
      value: { kind: "duplicate_trigger", caseId: input.caseId },
    };
  }
  const sessionInput = directSessionInput(input);
  const assignmentStartedAt = Date.now();
  const assignment = await buildAssignment(
    sessionInput,
    budget.value,
    prepared.value.snapshot.revision,
    prepared.value.snapshot.journalCursor,
    prepared.value.snapshot.entries,
    input.role,
    input.objective,
  );
  const assigned = await input.caseActor.assignSession(assignment);
  traceDirectSessionPreparation(input, "assignment", assignmentStartedAt);
  if (!assigned.ok) return failure(assigned.error.code);
  const participant = await runAssignedCaseSession(sessionInput, assignment);
  if (!participant.ok) return participant;
  return { ok: true, value: completedDirectCase(participant.value) };
}

function completedDirectCase(
  participant: CompletedCaseParticipant,
): DirectCasePathResult {
  return {
    kind: "completed",
    assignment: participant.assignment,
    proposal: participant.proposal,
    completion: participant.completion,
    caseRevision: participant.caseRevision,
    delivery: participant.delivery,
  };
}

/**
 * A delivery of a trigger whose earlier delivery stopped after its
 * assignment and before its turn began (Refactor 15, refactor 9). When this
 * trigger's own assignment is the only active one and never began, this
 * delivery begins it and runs its turn. A begin by a live delivery comes
 * first, and this one then fails on the begin. Null for an assignment that
 * began: the command's recovery reads the Session's turn
 * (`processDirectCaseCommand`), and a turn that still runs keeps it.
 */
async function resumeStoppedDirectAssignment(
  input: DirectCasePathInput,
  snapshot: CaseSnapshot,
): Promise<Result<CompletedCaseParticipant, CaseWalkingPathError> | null> {
  const own = findAssignmentLifecycle(snapshot, input.assignmentId);
  if (
    own?.kind !== "assigned" ||
    snapshot.assignmentLifecycles.some(
      isCompetingTransientAssignment.bind(null, input.assignmentId),
    )
  )
    return null;
  return runAssignedCaseSession(directSessionInput(input), own.assignment);
}

export async function runDirectTwoSessionCasePath(
  input: DirectTwoSessionCasePathInput,
): Promise<Result<DirectTwoSessionCasePathResult, CaseWalkingPathError>> {
  const budget = boundedSessionBudget(input.policy);
  if (!budget.ok) return budget;
  const prepared = await prepareDirectCase(input);
  if (!prepared.ok) return prepared;
  if (prepared.value.kind === "duplicate") {
    const resumed = await resumeDirectCaseDelivery(
      input,
      prepared.value.snapshot,
    );
    if (!resumed.ok) return resumed;
    let snapshot = prepared.value.snapshot;
    if (hasActiveCaseAssignment(snapshot)) {
      const finished = await finishStoppedTwoSessionTurns(input, snapshot);
      if (!finished.ok) return finished;
      if (!finished.value) return failure("case_assignment_in_progress");
      const current = await input.caseActor.inspect();
      if (!current.ok) return failure(current.error.code);
      snapshot = current.value;
    }
    // An earlier delivery of this trigger ended after both participants and
    // before the combined assignment began. This delivery runs it.
    if (
      input.combined !== undefined &&
      combinedAssignmentOwed(snapshot, input, input.combined)
    ) {
      const combined = await runCombinedCaseSession(
        input,
        input.combined,
        budget.value,
      );
      if (!combined.ok) return combined;
    }
    return {
      ok: true,
      value: { kind: "duplicate_trigger", caseId: input.caseId },
    };
  }
  const snapshot = prepared.value.snapshot;
  const contexts =
    input.combined === undefined
      ? { ok: true as const, value: input.contexts }
      : await input.combined.prepareParticipantContexts();
  if (!contexts.ok) return failure(contexts.error.code);
  const firstInput = directParticipantSessionInput(
    input,
    input.participants[0],
    contexts.value[0],
  );
  const secondInput = directParticipantSessionInput(
    input,
    input.participants[1],
    contexts.value[1],
  );
  const [firstAssignment, secondAssignment] = await Promise.all([
    buildAssignment(
      firstInput,
      budget.value,
      snapshot.revision,
      snapshot.journalCursor,
      snapshot.entries,
      firstInput.role,
      firstInput.objective,
    ),
    buildAssignment(
      secondInput,
      budget.value,
      snapshot.revision,
      snapshot.journalCursor,
      snapshot.entries,
      secondInput.role,
      secondInput.objective,
    ),
  ]);
  const firstAssigned = await input.caseActor.assignSession(firstAssignment);
  if (!firstAssigned.ok) return failure(firstAssigned.error.code);
  const secondAssigned = await input.caseActor.assignSession(secondAssignment);
  if (!secondAssigned.ok) return failure(secondAssigned.error.code);
  const [first, second] = await Promise.all([
    runAssignedCaseSession(firstInput, firstAssignment),
    runAssignedCaseSession(secondInput, secondAssignment),
  ]);
  if (!first.ok) return first;
  if (!second.ok) return second;
  const combined =
    input.combined === undefined
      ? null
      : await runCombinedCaseSession(input, input.combined, budget.value);
  if (combined !== null && !combined.ok) return combined;
  const finalSnapshot = await input.caseActor.inspect();
  if (!finalSnapshot.ok) return failure(finalSnapshot.error.code);
  return {
    ok: true,
    value: {
      kind: "completed",
      participants: [
        directParticipant(first.value),
        directParticipant(second.value),
      ],
      combined: combined === null ? null : directParticipant(combined.value),
      finalCaseRevision: finalSnapshot.value.revision,
    },
  };
}

/**
 * A delivery of a two-session trigger whose earlier delivery stopped while a
 * turn ran (Plan 42J). The Session's own recovery finishes such a turn under
 * a new attempt, and nothing else gives its answer to the Case. This delivery
 * reads each completed turn of its own running assignments and finishes the
 * assignment with it: the proposal, the delivery and the settlement. False:
 * an assignment stays active, because its turn still runs or failed, it
 * never began, or it belongs to another trigger. The Case's alarm ends an
 * assignment that nothing moves.
 */
async function finishStoppedTwoSessionTurns(
  input: DirectTwoSessionCasePathInput,
  snapshot: CaseSnapshot,
): Promise<Result<boolean, CaseWalkingPathError>> {
  const own = [
    ...input.participants,
    ...(input.combined === undefined ? [] : [input.combined.participant]),
  ];
  let finished = true;
  for (const lifecycle of snapshot.assignmentLifecycles) {
    if (lifecycle.kind === "settled") continue;
    const participant = own.find(
      (candidate) =>
        candidate.assignmentId === lifecycle.assignment.assignmentId,
    );
    const turnId =
      participant === undefined
        ? null
        : `turn_${participantInputId(input, participant)}`;
    if (
      participant === undefined ||
      turnId === null ||
      lifecycle.kind !== "running" ||
      lifecycle.start.startId !== `start_${turnId}`
    ) {
      finished = false;
      continue;
    }
    const state = await participant.session.inspectTurnStream({
      organisationId: input.organisationId,
      turnId,
    });
    if (!state.ok) return failure(state.error.code);
    if (state.value.kind !== "present" || state.value.state !== "complete") {
      finished = false;
      continue;
    }
    if (
      input.turnAuthority.authorityPartition.digest !==
      lifecycle.assignment.authorityPartition.digest
    )
      return failure("case_authority_partition_changed");
    const completion = await participant.session.readCompletedTurn({
      organisationId: input.organisationId,
      sessionId: participant.sessionId,
      turnId,
    });
    if (!completion.ok) return failure(completion.error.code);
    const finalized = await finalizeAssignedCaseSession(
      {
        env: input.env,
        caseActor: input.caseActor,
        turnAuthority: input.turnAuthority,
        receivedAt: lifecycle.start.acceptedAt,
        delivery: sessionDelivery(input.delivery),
        revalidateTurnAuthority: input.revalidateTurnAuthority,
      },
      lifecycle.assignment,
      turnId,
      completion.value,
    );
    if (!finalized.ok) return finalized;
  }
  return { ok: true, value: finished };
}

/** Names a participant's one input of a two-session trigger. */
function participantInputId(
  input: Pick<DirectTwoSessionCasePathInput, "triggerId">,
  participant: Pick<CaseParticipantInput, "inputKey" | "role">,
): string {
  return `${input.triggerId}_${participant.inputKey ?? participant.role}`;
}

/**
 * Whether both participants completed and the combined assignment never
 * began. A participant that failed leaves nothing to combine.
 */
function combinedAssignmentOwed(
  snapshot: CaseSnapshot,
  input: DirectTwoSessionCasePathInput,
  combined: CombinedCaseParticipantInput,
): boolean {
  const lifecycleOf = (assignmentId: string) =>
    snapshot.assignmentLifecycles.find(
      (lifecycle) => lifecycle.assignment.assignmentId === assignmentId,
    );
  if (lifecycleOf(combined.participant.assignmentId) !== undefined)
    return false;
  for (const participant of input.participants) {
    const lifecycle = lifecycleOf(participant.assignmentId);
    if (
      lifecycle?.kind !== "settled" ||
      lifecycle.disposition.kind !== "completed"
    )
      return false;
  }
  return true;
}

/**
 * Runs the combined assignment. It is built from the Case as it stands after
 * both participants ended, so its context names what each of them proposed.
 */
async function runCombinedCaseSession(
  input: DirectTwoSessionCasePathInput,
  combined: CombinedCaseParticipantInput,
  budget: SessionBudget,
): Promise<Result<CompletedCaseParticipant, CaseWalkingPathError>> {
  const snapshot = await input.caseActor.inspect();
  if (!snapshot.ok) return failure(snapshot.error.code);
  const context = await combined.prepareContext();
  if (!context.ok) return failure(context.error.code);
  const sessionInput = directParticipantSessionInput(
    input,
    combined.participant,
    context.value,
  );
  const assignment = await buildAssignment(
    sessionInput,
    budget,
    snapshot.value.revision,
    snapshot.value.journalCursor,
    snapshot.value.entries,
    sessionInput.role,
    sessionInput.objective,
  );
  const assigned = await input.caseActor.assignSession(assignment);
  if (!assigned.ok) return failure(assigned.error.code);
  return runAssignedCaseSession(sessionInput, assignment);
}

async function prepareDirectCase(
  input: Pick<
    DirectTwoSessionCasePathInput,
    | "caseActor"
    | "organisationId"
    | "caseId"
    | "triggerId"
    | "triggerSource"
    | "content"
    | "title"
    | "purpose"
    | "workspaceRevisionReceipt"
    | "receivedAt"
    | "delivery"
    | "turnAuthority"
  >,
): Promise<
  Result<
    | { readonly kind: "duplicate"; readonly snapshot: CaseSnapshot }
    | { readonly kind: "accepted"; readonly snapshot: CaseSnapshot },
    CaseWalkingPathError
  >
> {
  const prepared = await input.caseActor.prepareDirectTurn({
    ensure: {
      identity: { organisationId: input.organisationId, caseId: input.caseId },
      purpose: input.purpose,
      workspaceRevision: input.workspaceRevisionReceipt.revision,
      lifecycle: { kind: "open", openedAt: input.receivedAt },
    },
    trigger: {
      triggerId: input.triggerId,
      caseId: input.caseId,
      source: input.triggerSource,
      requestAuthority: input.turnAuthority.requestAuthority,
      content: input.content,
      acceptedAt: input.receivedAt,
      ...(input.title === undefined ? {} : { title: input.title }),
    },
    binding:
      input.delivery.kind === "connector" ? input.delivery.binding : null,
  });
  return prepared.ok ? prepared : failure(prepared.error.code);
}

export async function runOngoingCaseTurn(
  input: OngoingCaseTurnInput,
): Promise<Result<OngoingCaseTurnResult, CaseWalkingPathError>> {
  const preparationStartedAt = Date.now();
  const budget = boundedSessionBudget(input.policy);
  if (!budget.ok) return budget;
  const sessionInput = connectorSessionInput(input);
  const prepared = input.admittedCase.snapshot;
  if (
    input.admittedCase[admittedCaseTurn] !== true ||
    input.admittedCase.ingressId !== input.ingress.ingressId ||
    prepared.identity.organisationId !== input.organisationId ||
    prepared.identity.caseId !== input.ingress.caseId
  )
    return failure("case_admission_identity_mismatch");
  if (
    prepared.acceptedProposalIds.includes(`proposal_${input.ingress.ingressId}`)
  ) {
    return resumePendingCaseDelivery(input);
  }
  const existing = findAssignmentLifecycle(prepared, input.assignmentId);
  let assignment: CaseAssignment;
  if (existing === undefined) {
    assignment = await buildAssignment(
      sessionInput,
      budget.value,
      prepared.revision,
      prepared.journalCursor,
      prepared.entries,
    );
    const assigned = await input.caseActor.assignSession(assignment);
    if (!assigned.ok) return failure(assigned.error.code);
  } else {
    if (existing.kind === "settled")
      return existing.disposition.kind === "budget_exhausted"
        ? earlierBudgetStop(existing.assignment, existing.disposition)
        : failure("case_assignment_settled");
    assignment = existing.assignment;
    if (
      assignment.authorityPartition.digest !==
      input.turnAuthority.authorityPartition.digest
    ) {
      return failure("case_authority_partition_changed");
    }
  }
  const assignmentStartId =
    existing?.kind === "running"
      ? existing.start.startId
      : `start_${slackCaseTurnId(input.ingress.ingressId)}`;
  if (existing === undefined || existing.kind === "assigned") {
    const initialization = initializedSession(sessionInput, assignment);
    if (!initialization.ok) return initialization;
    const initialized = await input.session.initializeCaseSession({
      initialization: initialization.value,
      assignment,
    });
    if (!initialized.ok)
      return failure(`session_initialize:${initialized.error.code}`);
    const begun = await input.caseActor.beginAssignment({
      caseId: assignment.caseId,
      assignmentId: assignment.assignmentId,
      sessionId: assignment.sessionId,
      expectedCaseRevision: assignment.caseRevision,
      start: {
        startId: assignmentStartId,
        sessionId: assignment.sessionId,
        acceptedAt: input.receivedAt,
      },
    });
    if (!begun.ok) return failure(begun.error.code);
  }
  const instruction = caseContentInstruction(
    input.ingress.content,
    input.purpose,
  );
  traceCaseSessionPreparation(input, "assignment", preparationStartedAt);
  const recovered =
    existing?.kind === "running" && input.attempt > 1
      ? await recoverOngoingSessionTurn(input)
      : { ok: true as const, value: { kind: "missing" as const } };
  if (!recovered.ok) {
    if (
      existing?.kind === "running" &&
      recovered.error.code === "session_stream:session_stream_replay_timeout"
    ) {
      const settled = await settleOngoingSessionFailure(
        input,
        existing.assignment,
        recovered.error.code,
      );
      if (!settled.ok) return settled;
    }
    return recovered;
  }
  const completion =
    recovered.value.kind === "completed"
      ? {
          ok: true as const,
          value: {
            finalMessage: recovered.value.finalMessage,
            binding: recovered.value.binding,
            modelUsage: recovered.value.modelUsage,
          },
        }
      : await runOngoingSessionTurn(
          input,
          assignment,
          assignmentStartId,
          instruction,
        );
  if (!completion.ok) return completion;
  const proposal: SessionProposal = {
    proposalId: `proposal_${input.ingress.ingressId}`,
    assignmentId: assignment.assignmentId,
    caseId: assignment.caseId,
    sessionId: assignment.sessionId,
    turnId: slackCaseTurnId(input.ingress.ingressId),
    basedOnRevision: prepared.revision,
    entries: [
      {
        kind: "observation",
        entryId: `entry_${input.ingress.ingressId}`,
        content: { kind: "text", text: completion.value.finalMessage },
      },
    ],
    requestedEffects: [],
  };
  // The answer is complete, so the delivery reads its live authority now. The
  // read shares the wait of the Case's acceptance. The sink decision still
  // follows both, and the post still follows the Connector's fence.
  const deliveryStartedAt = Date.now();
  const deliveryAuthority = currentDeliveryAuthority(input);
  void deliveryAuthority.then(
    traceCaseAnswerDelivery.bind(
      null,
      input,
      "delivery_authority",
      deliveryStartedAt,
    ),
    ignoreUnusedDeliveryAuthority,
  );
  const acceptance = await input.caseActor.acceptSessionProposal({
    proposal,
    requestAuthority: input.turnAuthority.requestAuthority,
    acceptedAt: input.receivedAt + 2,
    flowBinding: completion.value.binding.toJSON(),
  });
  traceCaseAnswerDelivery(input, "proposal_acceptance", deliveryStartedAt);
  if (!acceptance.ok) return failure(acceptance.error.code);
  if (acceptance.value.disposition.kind !== "accepted")
    return failure(`proposal_${acceptance.value.disposition.kind}`);
  const output = acceptance.value.outputs[0];
  if (output === undefined || acceptance.value.outputs.length !== 1)
    return failure("case_output_missing");
  const delivery = await deliverAndSettleCaseOutput(
    input,
    output,
    deliveryAuthority,
  );
  traceCaseAnswerDelivery(input, "delivery", deliveryStartedAt);
  if (!delivery.ok) return delivery;
  if (delivery.value.kind === "delivery_pending")
    return { ok: true, value: delivery.value };
  if (delivery.value.kind === "delivery_held")
    return { ok: true, value: delivery.value };
  return {
    ok: true,
    value: {
      kind: "completed",
      assignment,
      proposal,
      completion: completion.value,
      caseRevision: acceptance.value.disposition.revision,
      deliveryReceiptId: delivery.value.deliveryReceiptId,
    },
  };
}

export async function admitOngoingCaseTurn(
  input: Readonly<{
    connector: Pick<CaseConnectorRpc, "acceptIngress">;
    connectorIdentity: ConnectorIdentity;
    caseActor: Pick<CaseActor, "prepareOngoingTurn">;
    organisationId: OrganisationId;
    ingress: ConnectorIngress;
    binding: CaseBinding;
    purpose: string;
    workspaceRevisionReceipt: WorkspaceRevisionReceipt;
    requestAuthority: RequestAuthority;
    receivedAt: number;
  }>,
): Promise<Result<AdmittedCaseTurn, CaseWalkingPathError>> {
  const acceptedIngress = structuredClone(input.ingress);
  const trigger: CaseTrigger = {
    triggerId: `trigger_${acceptedIngress.ingressId}`,
    caseId: acceptedIngress.caseId,
    source: {
      kind: "connector",
      connectorId: acceptedIngress.connectorId,
      ingressId: acceptedIngress.ingressId,
    },
    requestAuthority: structuredClone(input.requestAuthority),
    content: acceptedIngress.content,
    acceptedAt: input.receivedAt,
  };
  const ingress = await input.connector.acceptIngress({
    identity: input.connectorIdentity,
    ingress: acceptedIngress,
    attachments: caseContentAttachments(acceptedIngress.content),
  });
  if (!ingress.ok) return failure(ingress.error.code);
  const prepared = await input.caseActor.prepareOngoingTurn({
    ensure: {
      identity: {
        organisationId: input.organisationId,
        caseId: acceptedIngress.caseId,
      },
      purpose: input.purpose,
      workspaceRevision: input.workspaceRevisionReceipt.revision,
      lifecycle: { kind: "open", openedAt: input.receivedAt },
    },
    trigger: {
      ...trigger,
      attachments: caseContentAttachments(trigger.content),
    },
    binding: input.binding,
  });
  if (!prepared.ok) return failure(prepared.error.code);
  return {
    ok: true,
    value: Object.freeze({
      [admittedCaseTurn]: true as const,
      ingressId: acceptedIngress.ingressId,
      snapshot: prepared.value,
      trigger,
    }),
  };
}

/**
 * Start the turn in the Session with one call and stream its output.
 *
 * The Session takes its own next runtime generation, prepares the turn's
 * flow binding and decides the stream sink from that binding and its live
 * authority, all before it commits the start. The Connector decides the
 * sink again for the final output, after the turn.
 */
async function runOngoingSessionTurn(
  input: OngoingCaseTurnInput,
  assignment: CaseAssignment,
  assignmentStartId: string,
  instruction: string,
): Promise<
  Result<
    {
      readonly finalMessage: string;
      readonly binding: FlowBinding;
      readonly modelUsage?: EmbeddedHarnessModelUsage;
    },
    CaseWalkingPathError
  >
> {
  const preparationStartedAt = Date.now();
  const instructionDigest = await sha256Hex(instruction);
  const inputDigest = parseSessionTurnInputDigest(instructionDigest);
  if (!inputDigest.ok) return failure(inputDigest.error.code);
  const turnId = slackCaseTurnId(input.ingress.ingressId);
  traceCaseSessionPreparation(
    input,
    "instruction_digest",
    preparationStartedAt,
  );
  let streamSink: { readonly channelId: string } | null = null;
  if (input.output.kind === "slack_stream") {
    if (input.binding.address.kind !== "slack")
      return failure("case_stream_address_unsupported");
    streamSink = { channelId: input.binding.address.channelId };
  }
  const completedPromise = input.session.startCanonicalEmbeddedHarnessTextTurn({
    requestingOrganisationId: input.organisationId,
    requestId: input.requestId,
    inputDigest: inputDigest.value,
    currentModelRoute: input.policy.modelRoute,
    start: {
      startId: `start_${turnId}`,
      correlationId: input.requestId,
      acceptedAt: input.receivedAt,
      admittedAt: input.receivedAt,
      harnessLeaseExpiresAt: input.receivedAt + 10 * 60 * 1_000,
      input: {
        kind: "case",
        inputId: `input_${input.ingress.ingressId}`,
        caseId: assignment.caseId,
        assignmentId: assignment.assignmentId,
        caseRevision: assignment.caseRevision,
        contentDigest: instructionDigest,
        workspaceRevision: assignment.context.workspaceRevision,
        contextBundleDigest: input.context.bundleDigest,
      },
      requestAuthority: input.turnAuthority.requestAuthority,
      authorityPartitionDigest: assignment.authority.authorityPartitionDigest,
      turnId,
      origin: {
        kind: "command",
        principal: { kind: "human", principalId: input.principalId },
      },
    },
    streamSink,
    attachments: caseContentAttachments(input.ingress.content),
    links: caseContentLinks(input.ingress.content),
    browserContext: { kind: "unavailable" },
    surfaceContext: null,
    context: sessionTurnContext(input.context, input.projectContext),
    thinkingLevel: input.thinkingLevel,
    harnessInstructions: composeAgentInstructions(
      EMBEDDED_HARNESS_INSTRUCTIONS,
      input.pinnedAgent,
    ),
    turnPrompt: instruction,
    completion: {
      completionId: `complete_${turnId}`,
      acceptedAt: input.receivedAt + 1,
    },
  });
  void completedPromise.catch(ignoreCompletedPromiseFailure);
  if (input.output.kind === "terminal") {
    const completed = await completedPromise;
    if (completed.ok) {
      const binding = await restoreFlowBinding(completed.value.flowBinding);
      return binding.ok
        ? {
            ok: true,
            value: {
              finalMessage: completed.value.finalMessage,
              binding: binding.value,
              modelUsage: completed.value.modelUsage,
            },
          }
        : failure(binding.error.code);
    }
    if (completed.error.code === "budget_exhausted") {
      const settled = await settleOngoingBudgetExhaustion(
        input,
        assignment,
        assignmentStartId,
        completed.error.exhaustion,
      );
      if (!settled.ok) return settled;
    }
    return sessionTurnFailure(completed.error, assignment.budget);
  }
  const streamInput = ongoingCaseStreamInput(input);
  if (!streamInput.ok) return streamInput;
  const streamedPromise = input.connector.streamCaseTurn(
    streamInput.value,
    caseStreamRelease(input),
  );
  const streamed = await streamedPromise;
  if (!streamed.ok) {
    if (
      streamed.error.code === "budget_exhausted" ||
      streamed.error.code === "session_turn_not_found" ||
      streamed.error.code === "embedded_harness_turn_failed_with_usage" ||
      streamed.error.code === "embedded_harness_model_usage_missing"
    ) {
      const completed = await completedPromise;
      if (!completed.ok) {
        if (completed.error.code === "budget_exhausted") {
          const settled = await settleOngoingBudgetExhaustion(
            input,
            assignment,
            assignmentStartId,
            completed.error.exhaustion,
          );
          if (!settled.ok) return settled;
        }
        return sessionTurnFailure(completed.error, assignment.budget);
      }
    }
    const streamError = `session_stream:${streamed.error.code}`;
    if (streamed.error.code === "session_stream_replay_timeout") {
      const settled = await settleOngoingSessionFailure(
        input,
        assignment,
        streamError,
      );
      if (!settled.ok) return settled;
    }
    return sessionStreamFailure(streamed.error);
  }
  const completed = await completedPromise;
  if (!completed.ok) {
    if (completed.error.code === "budget_exhausted") {
      const settled = await settleOngoingBudgetExhaustion(
        input,
        assignment,
        assignmentStartId,
        completed.error.exhaustion,
      );
      if (!settled.ok) return settled;
    }
    return sessionTurnFailure(completed.error, assignment.budget);
  }
  if (streamed.value.canonicalMessage !== completed.value.finalMessage) {
    return failure("session_stream_message_mismatch");
  }
  const binding = await restoreFlowBinding(completed.value.flowBinding);
  return binding.ok
    ? {
        ok: true,
        value: {
          finalMessage: streamed.value.finalMessage,
          binding: binding.value,
          modelUsage: completed.value.modelUsage,
        },
      }
    : failure(binding.error.code);
}

/**
 * Look for the turn of a later attempt in the Session. An earlier attempt
 * can have started it. A turn that the Session holds is streamed again and
 * not started a second time. The Connector decides the stream sink here
 * itself, from the turn's flow binding and the live delivery authority.
 */
async function recoverOngoingSessionTurn(input: OngoingCaseTurnInput): Promise<
  Result<
    | { readonly kind: "missing" }
    | {
        readonly kind: "completed";
        readonly finalMessage: string;
        readonly binding: FlowBinding;
        readonly modelUsage?: EmbeddedHarnessModelUsage;
      },
    CaseWalkingPathError
  >
> {
  if (input.output.kind === "terminal")
    return { ok: true, value: { kind: "missing" } };
  const streamInput = ongoingCaseStreamInput(input);
  if (!streamInput.ok) return streamInput;
  const turnId = slackCaseTurnId(input.ingress.ingressId);
  // The Connector's stream is prepared only when the Session holds the turn.
  const inspectionStartedAt = Date.now();
  const inspected = await input.session.inspectTurnStream({
    organisationId: input.organisationId,
    turnId,
  });
  traceCaseSessionPreparation(
    input,
    "recovery_inspection",
    inspectionStartedAt,
  );
  if (!inspected.ok)
    return sessionStreamFailure({
      kind: "operational",
      code: inspected.error.code,
    });
  if (inspected.value.kind === "missing")
    return { ok: true, value: { kind: "missing" } };
  const bindingStartedAt = Date.now();
  const authority = currentDeliveryAuthority(input);
  void authority.catch(ignoreUnusedDeliveryAuthority);
  const binding = await prepareOngoingStreamBinding(input, turnId);
  traceCaseSessionPreparation(
    input,
    "recovery_information_flow",
    bindingStartedAt,
  );
  if (!binding.ok) return binding;
  const authorizationStartedAt = Date.now();
  const allowed = await decideCaseStreamSink(input, binding.value, authority);
  traceCaseSessionPreparation(
    input,
    "recovery_authorization",
    authorizationStartedAt,
  );
  // An answer that waits for a person still finishes its turn. The stream
  // releases nothing, and the delivery holds the answer.
  if (!allowed.ok && !sinkRefusalAsksPerson(allowed.error.code)) return allowed;
  const recovered = await input.connector.streamCaseTurn(
    streamInput.value,
    caseStreamRelease(input),
  );
  if (!recovered.ok) return sessionStreamFailure(recovered.error);
  return {
    ok: true,
    value: {
      kind: "completed",
      finalMessage: recovered.value.finalMessage,
      binding: binding.value,
    },
  };
}

/**
 * A step beside the authority read failed. That failure is reported, and the
 * authority read is not used.
 */
function ignoreUnusedDeliveryAuthority(): void {}

/**
 * The waits of an answer between the Session's completion and the Slack
 * post. Each record gives the time since the first of them started.
 */
function traceCaseAnswerDelivery(
  input: Pick<
    OngoingCaseTurnInput,
    "requestId" | "organisationId" | "sessionId" | "ingress"
  >,
  phase: "proposal_acceptance" | "delivery_authority" | "delivery",
  startedAt: number,
): void {
  traceLog("case.answer_delivery_timing", {
    requestId: input.requestId,
    organisation_id: input.organisationId,
    session_id: input.sessionId,
    turn_id: slackCaseTurnId(input.ingress.ingressId),
    phase,
    started_at: startedAt,
    duration_ms: Date.now() - startedAt,
  });
}

function traceCaseSessionPreparation(
  input: Pick<
    OngoingCaseTurnInput,
    "requestId" | "organisationId" | "sessionId" | "ingress"
  >,
  phase:
    | "assignment"
    | "instruction_digest"
    | "recovery_inspection"
    | "recovery_information_flow"
    | "recovery_authorization",
  startedAt: number,
): void {
  traceLog("case.session_preparation_timing", {
    requestId: input.requestId,
    organisation_id: input.organisationId,
    session_id: input.sessionId,
    turn_id: slackCaseTurnId(input.ingress.ingressId),
    phase,
    started_at: startedAt,
    duration_ms: Date.now() - startedAt,
  });
}

async function prepareOngoingStreamBinding(
  input: OngoingCaseTurnInput,
  turnId: string,
): Promise<Result<FlowBinding, CaseWalkingPathError>> {
  if (typeof input.session.prepareSessionInformationFlow !== "function") {
    return failure("session_information_flow_unavailable");
  }
  const prepared = await input.session.prepareSessionInformationFlow({
    requestingOrganisationId: input.organisationId,
    sessionId: input.sessionId,
    turnId,
    authorityPartitionDigest: input.turnAuthority.authorityPartition.digest,
    contextBundle: serializeContextBundle(input.context.bundle),
  });
  if (!prepared.ok)
    return failure(`session_information_flow:${prepared.error.code}`);
  const binding = await restoreFlowBinding(prepared.value.flowBinding);
  return binding.ok
    ? binding
    : failure(`session_information_flow:${binding.error.code}`);
}

function ongoingCaseStreamInput(
  input: OngoingCaseTurnInput,
): Result<ConnectorCaseTurnStreamInput, CaseWalkingPathError> {
  if (
    input.output.kind !== "slack_stream" ||
    input.binding.address.kind !== "slack"
  ) {
    return failure("case_stream_address_unsupported");
  }
  const workspaceId = parseWorkspaceId(input.binding.address.workspaceId);
  const channelId = parseChannelId(input.binding.address.channelId);
  if (!workspaceId.ok || !channelId.ok)
    return failure("case_stream_address_invalid");
  const turnId = slackCaseTurnId(input.ingress.ingressId);
  return {
    ok: true,
    value: {
      identity: input.connectorIdentity,
      requestId: input.requestId,
      organisationId: input.organisationId,
      sessionId: input.sessionId,
      sessionRoute: input.sessionRoute,
      turnId,
      streamId: slackCaseStreamId(input.ingress.ingressId),
      expectedIdempotencyKey: slackCaseOutputIdempotencyKey(
        input.ingress.ingressId,
      ),
      target: {
        workspaceId: workspaceId.value,
        channelId: channelId.value,
        threadTs: input.binding.address.threadTs,
        recipientUserId: input.output.recipientUserId,
      },
      receivedAt: input.receivedAt,
    },
  };
}

/**
 * The check that lets each part of a streamed answer reach the thread: the
 * turn's current binding against the thread, with live delivery authority.
 * A denial is final. A failed authority read only delays the part; the final
 * delivery decides again.
 */
function caseStreamRelease(
  input: OngoingCaseTurnInput,
): ConnectorCaseStreamRelease {
  return releaseCaseStream.bind(null, input);
}

/**
 * The release check of a streamed part. Every refusal of the conversation
 * sink denies, as a changed authority partition does; an authority that
 * cannot be read now leaves the part unreleased.
 */
async function releaseCaseStream(
  input: OngoingCaseTurnInput,
  serialized: SerializedFlowBinding,
): Promise<"allow" | "deny" | "unavailable"> {
  if (input.binding.address.kind !== "slack") return "unavailable";
  const binding = await restoreFlowBinding(serialized);
  if (!binding.ok) return "unavailable";
  const current = await currentDeliveryAuthority(input);
  if (!current.ok)
    return current.error.code === "case_delivery_authority_partition_changed"
      ? "deny"
      : "unavailable";
  const decision = await decideCaseConversationSink(
    current.value,
    binding.value,
    input.binding.address.channelId,
    input.env,
  );
  return decision.ok ? "allow" : "deny";
}

async function settleOngoingBudgetExhaustion(
  input: OngoingCaseTurnInput,
  assignment: CaseAssignment,
  assignmentStartId: string,
  exhaustion: SessionBudgetExhaustion,
): Promise<Result<null, CaseWalkingPathError>> {
  const settled = await input.caseActor.settleAssignment({
    caseId: assignment.caseId,
    assignmentId: assignment.assignmentId,
    sessionId: assignment.sessionId,
    expectedCaseRevision: assignment.caseRevision,
    expectedStartId: assignmentStartId,
    disposition: {
      kind: "budget_exhausted",
      exhaustionId: exhaustion.exhaustionId,
      dimension: exhaustion.dimension,
      settledAt: input.receivedAt + 1,
    },
  });
  return settled.ok
    ? { ok: true, value: null }
    : failure(`case_assignment_settle:${settled.error.code}`);
}

async function settleOngoingSessionFailure(
  input: OngoingCaseTurnInput,
  assignment: CaseAssignment,
  code: string,
): Promise<Result<null, CaseWalkingPathError>> {
  const settled = await input.caseActor.settleAssignment({
    caseId: assignment.caseId,
    assignmentId: assignment.assignmentId,
    sessionId: assignment.sessionId,
    expectedCaseRevision: assignment.caseRevision,
    expectedStartId: `start_${slackCaseTurnId(input.ingress.ingressId)}`,
    disposition: { kind: "failed", code, settledAt: input.receivedAt + 1 },
  });
  return settled.ok
    ? { ok: true, value: null }
    : failure(`case_assignment_settle:${settled.error.code}`);
}

function ignoreCompletedPromiseFailure(): void {
  // The stream terminal outcome owns this turn after an early return.
}

async function resumePendingCaseDelivery(
  input: CaseWalkingPathInput,
): Promise<Result<OngoingCaseTurnResult, CaseWalkingPathError>> {
  const snapshot = await input.caseActor.inspect();
  if (!snapshot.ok) return failure(snapshot.error.code);
  // Earlier answers of the Case can wait for a person, so this turn resumes
  // only its own output.
  const proposalId = `proposal_${input.ingress.ingressId}`;
  const pending = pendingCaseOutputs(snapshot.value).filter(
    (lifecycle) =>
      lifecycle.output.source.kind === "agent_turn" &&
      lifecycle.output.source.proposalId === proposalId,
  );
  if (pending.length === 0)
    return {
      ok: true,
      value: { kind: "duplicate_ingress", caseId: input.ingress.caseId },
    };
  if (pending.length !== 1 || pending[0] === undefined)
    return failure("case_output_ambiguous");
  const delivered = await deliverAndSettleCaseOutput(input, pending[0].output);
  if (!delivered.ok) return delivered;
  return delivered.value.kind === "delivered"
    ? {
        ok: true,
        value: { kind: "duplicate_ingress", caseId: input.ingress.caseId },
      }
    : { ok: true, value: delivered.value };
}

/**
 * Whether the admitted Case holds this assignment already. A turn's agent
 * profile reads it from the same snapshot that the turn itself runs on.
 */
export function admittedCaseHoldsAssignment(
  admitted: AdmittedCaseTurn,
  assignmentId: string,
): boolean {
  return findAssignmentLifecycle(admitted.snapshot, assignmentId) !== undefined;
}

function findAssignmentLifecycle(
  snapshot: CaseSnapshot,
  assignmentId: string,
): CaseSnapshot["assignmentLifecycles"][number] | undefined {
  for (const lifecycle of snapshot.assignmentLifecycles) {
    if (lifecycle.assignment.assignmentId === assignmentId) return lifecycle;
  }
  return undefined;
}

function pendingCaseOutputs(
  snapshot: CaseSnapshot,
): Variant<CaseSnapshot["outputs"][number], "pending">[] {
  const pending: Variant<CaseSnapshot["outputs"][number], "pending">[] = [];
  for (const output of snapshot.outputs) {
    if (output.kind === "pending") pending.push(output);
  }
  return pending;
}

async function decideCaseOutputSink(
  input: Pick<
    CaseWalkingPathInput,
    "env" | "turnAuthority" | "revalidateTurnAuthority"
  >,
  output: CaseOutput,
  startedAuthority: ReturnType<typeof currentDeliveryAuthority> | null,
): Promise<Result<AllowFlowDecision, CaseWalkingPathError>> {
  const current = await (startedAuthority ?? currentDeliveryAuthority(input));
  return current.ok
    ? authorizeCaseConversationOutput(current.value, output, input.env)
    : current;
}

export async function authorizeCaseConversationOutput(
  currentAuthority: CompiledTurnAuthority,
  output: CaseOutput,
  env: Env,
): Promise<Result<AllowFlowDecision, CaseWalkingPathError>> {
  const address = output.delivery.address;
  if (address.kind !== "slack" && address.kind !== "slack_channel") {
    return failure("case_output_address_unsupported");
  }
  const binding = await restoreFlowBinding(output.flowBinding);
  return binding.ok
    ? decideCurrentCaseConversationSink(
        currentAuthority,
        binding.value,
        address.channelId,
        env,
      )
    : failure(binding.error.code);
}

async function decideCaseStreamSink(
  input: Pick<
    OngoingCaseTurnInput,
    "env" | "turnAuthority" | "revalidateTurnAuthority" | "binding"
  >,
  binding: FlowBinding,
  authority: ReturnType<typeof currentDeliveryAuthority>,
): Promise<Result<AllowFlowDecision, CaseWalkingPathError>> {
  if (input.binding.address.kind !== "slack")
    return failure("case_stream_address_unsupported");
  const current = await authority;
  return current.ok
    ? decideCurrentCaseConversationSink(
        current.value,
        binding,
        input.binding.address.channelId,
        input.env,
      )
    : current;
}

async function decideCurrentCaseConversationSink(
  currentAuthority: CompiledTurnAuthority,
  binding: FlowBinding,
  channelId: string,
  env: Env,
): Promise<Result<AllowFlowDecision, CaseWalkingPathError>> {
  const decision = await decideCaseConversationSink(
    currentAuthority,
    binding,
    channelId,
    env,
  );
  return decision.ok ? decision : failure(decision.error.code);
}

async function currentDeliveryAuthority(
  input: Pick<
    CaseWalkingPathInput,
    "turnAuthority" | "revalidateTurnAuthority"
  >,
): Promise<Result<CompiledTurnAuthority, CaseWalkingPathError>> {
  const current = await input.revalidateTurnAuthority();
  if (!current.ok)
    return failure(`case_delivery_authority:${current.error.code}`);
  return current.value.authorityPartition.digest ===
    input.turnAuthority.authorityPartition.digest
    ? current
    : failure("case_delivery_authority_partition_changed");
}

function hasActiveCaseAssignment(snapshot: CaseSnapshot): boolean {
  for (const lifecycle of snapshot.assignmentLifecycles) {
    if (lifecycle.kind === "assigned" || lifecycle.kind === "running")
      return true;
  }
  return false;
}

/**
 * Hold an output that the level rule stopped, and ask a person (Plan 27C). A
 * refusal that a person cannot answer stays the failure that it was.
 */
async function holdRefusedOutput(
  input: Pick<CaseWalkingPathInput, "env" | "turnAuthority"> &
    Readonly<{
      connector: Pick<CaseConnectorRpc, "deliver">;
      connectorIdentity: ConnectorIdentity;
      caseActor: Pick<CaseActor, "holdOutput">;
    }>,
  output: CaseOutput,
  refusal: CaseWalkingPathError,
): Promise<Result<string, CaseWalkingPathError>> {
  if (!sinkRefusalAsksPerson(refusal.code))
    return { ok: false, error: refusal };
  const held = await holdCaseOutput({
    env: input.env,
    organisationId: input.connectorIdentity.organisationId,
    connector: input.connector,
    connectorIdentity: input.connectorIdentity,
    caseActor: input.caseActor,
    output,
    refusal: refusal.code,
    requestAuthority: input.turnAuthority.requestAuthority,
  });
  return held.ok ? { ok: true, value: held.requestId } : failure(held.error.code);
}

export async function deliverAndSettleCaseOutput(
  input: Pick<
    CaseWalkingPathInput,
    | "turnAuthority"
    | "env"
    | "revalidateTurnAuthority"
    | "connector"
    | "connectorIdentity"
    | "ingress"
  > & {
    readonly caseActor: Pick<
      CaseActor,
      "acceptDeliveryReceipt" | "holdOutput" | "rejectOutput"
    >;
  },
  output: CaseOutput,
  /**
   * The live authority read of this delivery, when the caller started it
   * beside the acceptance of this output. Null reads it here.
   */
  startedAuthority: ReturnType<typeof currentDeliveryAuthority> | null = null,
): Promise<
  Result<
    | { readonly kind: "delivered"; readonly deliveryReceiptId: string }
    | {
        readonly kind: "delivery_pending";
        readonly caseId: string;
        readonly retryAt: number;
      }
    | { readonly kind: "delivery_held"; readonly caseId: string },
    CaseWalkingPathError
  >
> {
  const allowed = await decideCaseOutputSink(input, output, startedAuthority);
  if (!allowed.ok) {
    const held = await holdRefusedOutput(input, output, allowed.error);
    return held.ok
      ? {
          ok: true,
          value: { kind: "delivery_held", caseId: input.ingress.caseId },
        }
      : held;
  }
  const delivered = await input.connector.deliver({
    identity: input.connectorIdentity,
    delivery: output.delivery,
    requestedAt: Date.now(),
  });
  if (!delivered.ok) return failure(delivered.error.code);
  if (delivered.value.kind === "retry") {
    return {
      ok: true,
      value: {
        kind: "delivery_pending",
        caseId: input.ingress.caseId,
        retryAt: delivered.value.retryAt,
      },
    };
  }
  if (delivered.value.kind === "rejected") {
    await input.caseActor.rejectOutput({
      outputId: output.outputId,
      reason: delivered.value.reason,
    });
    return failure(`connector_delivery_rejected:${delivered.value.reason}`);
  }
  const receipt = await input.caseActor.acceptDeliveryReceipt({
    outputId: output.outputId,
    receipt: {
      ...delivered.value.receipt,
      flowBindingDigest: allowed.value.flowBindingDigest,
      decisionDigest: allowed.value.decisionDigest,
    },
  });
  return receipt.ok
    ? {
        ok: true,
        value: {
          kind: "delivered",
          deliveryReceiptId: delivered.value.receipt.nativeReceiptId,
        },
      }
    : failure(receipt.error.code);
}

function directParticipantSessionInput(
  input: DirectTwoSessionCasePathInput,
  participant: CaseParticipantInput,
  context: ContextAssemblyResult,
): AssignedCaseSessionInput & {
  readonly role: AgentRole;
  readonly objective: string;
} {
  return {
    env: input.env,
    pinnedAgent: input.pinnedAgent,
    caseActor: input.caseActor,
    session: participant.session,
    organisationId: input.organisationId,
    requestId: participant.requestId,
    sessionId: participant.sessionId,
    caseId: input.caseId,
    inputId: participantInputId(input, participant),
    assignmentId: participant.assignmentId,
    purpose: input.purpose,
    principal: input.principal,
    policy: input.policy,
    workspaceRevisionReceipt: input.workspaceRevisionReceipt,
    receivedAt: input.receivedAt,
    delivery: sessionDelivery(input.delivery),
    attachments: caseContentAttachments(input.content),
    links: caseContentLinks(input.content),
    browserContext: { kind: "unavailable" },
    surfaceContext: null,
    turnAuthority: input.turnAuthority,
    revalidateTurnAuthority: input.revalidateTurnAuthority,
    context,
    projectContext: null,
    role: participant.role,
    objective: participant.objective,
  };
}

function connectorSessionInput(
  input: CaseWalkingPathInput,
): AssignedCaseSessionInput {
  return {
    env: input.env,
    pinnedAgent: input.pinnedAgent,
    caseActor: input.caseActor,
    session: input.session,
    organisationId: input.organisationId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    caseId: input.ingress.caseId,
    inputId: input.ingress.ingressId,
    assignmentId: input.assignmentId,
    purpose: input.purpose,
    principal: { kind: "human", principalId: input.principalId },
    policy: input.policy,
    workspaceRevisionReceipt: input.workspaceRevisionReceipt,
    receivedAt: input.receivedAt,
    delivery: {
      kind: "connector",
      connector: input.connector,
      connectorIdentity: input.connectorIdentity,
    },
    attachments: caseContentAttachments(input.ingress.content),
    links: caseContentLinks(input.ingress.content),
    browserContext: { kind: "unavailable" },
    surfaceContext: null,
    turnAuthority: input.turnAuthority,
    revalidateTurnAuthority: input.revalidateTurnAuthority,
    context: input.context,
    projectContext: input.projectContext,
    thinkingLevel: input.thinkingLevel,
  };
}

function directSessionInput(
  input: DirectCasePathInput,
): AssignedCaseSessionInput {
  return {
    env: input.env,
    pinnedAgent: input.pinnedAgent,
    caseActor: input.caseActor,
    session: input.session,
    organisationId: input.organisationId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    caseId: input.caseId,
    inputId: input.triggerId,
    assignmentId: input.assignmentId,
    purpose: input.purpose,
    principal: input.principal,
    policy: input.policy,
    workspaceRevisionReceipt: input.workspaceRevisionReceipt,
    receivedAt: input.receivedAt,
    delivery: sessionDelivery(input.delivery),
    attachments: caseContentAttachments(input.content),
    links: caseContentLinks(input.content),
    browserContext: input.browserContext,
    surfaceContext: input.surfaceContext,
    turnAuthority: input.turnAuthority,
    revalidateTurnAuthority: input.revalidateTurnAuthority,
    context: input.context,
    projectContext: input.projectContext,
    thinkingLevel: input.thinkingLevel,
  };
}

function sessionDelivery(
  delivery: DirectCaseDelivery,
): AssignedCaseSessionInput["delivery"] {
  switch (delivery.kind) {
    case "none":
      return { kind: "none" };
    case "connector":
      return {
        kind: "connector",
        connector: delivery.connector,
        connectorIdentity: delivery.connectorIdentity,
      };
    default:
      return assertNever(delivery);
  }
}

function directParticipant(
  participant: CompletedCaseParticipant,
): DirectCaseParticipant {
  return {
    assignment: participant.assignment,
    proposal: participant.proposal,
    completion: participant.completion,
    caseRevision: participant.caseRevision,
    delivery: participant.delivery,
  };
}

async function resumeDirectCaseDelivery(
  input: Pick<
    DirectTwoSessionCasePathInput,
    "env" | "caseActor" | "delivery" | "turnAuthority" | "revalidateTurnAuthority"
  >,
  snapshot: CaseSnapshot,
): Promise<Result<null, CaseWalkingPathError>> {
  if (input.delivery.kind === "none") return { ok: true, value: null };
  for (const output of pendingCaseOutputs(snapshot)) {
    const allowed = await decideCaseOutputSink(input, output.output, null);
    if (!allowed.ok) {
      const held = await holdRefusedOutput(
        {
          env: input.env,
          turnAuthority: input.turnAuthority,
          connector: input.delivery.connector,
          connectorIdentity: input.delivery.connectorIdentity,
          caseActor: input.caseActor,
        },
        output.output,
        allowed.error,
      );
      if (!held.ok) return held;
      continue;
    }
    const delivered = await input.delivery.connector.deliver({
      identity: input.delivery.connectorIdentity,
      delivery: output.output.delivery,
      requestedAt: Date.now(),
    });
    if (!delivered.ok) return failure(delivered.error.code);
    if (delivered.value.kind === "retry") {
      return failure(`connector_delivery_retry:${delivered.value.retryAt}`);
    }
    if (delivered.value.kind === "rejected") {
      // The provider refused it for good: the output ends, so the next
      // trigger does not fail on it again.
      await input.caseActor.rejectOutput({
        outputId: output.output.outputId,
        reason: delivered.value.reason,
      });
      return failure(`connector_delivery_rejected:${delivered.value.reason}`);
    }
    const receipt = await input.caseActor.acceptDeliveryReceipt({
      outputId: output.output.outputId,
      receipt: {
        ...delivered.value.receipt,
        flowBindingDigest: allowed.value.flowBindingDigest,
        decisionDigest: allowed.value.decisionDigest,
      },
    });
    if (!receipt.ok) return failure(receipt.error.code);
  }
  return { ok: true, value: null };
}

async function completeCaseOutput(
  input: Pick<
    AssignedCaseSessionInput,
    "env" | "caseActor" | "delivery" | "turnAuthority" | "revalidateTurnAuthority"
  >,
  outputs: readonly CaseOutput[],
): Promise<Result<CompletedCaseParticipant["delivery"], CaseWalkingPathError>> {
  switch (input.delivery.kind) {
    case "none":
      return outputs.length === 0
        ? { ok: true, value: { kind: "unaddressed" } }
        : failure("case_output_unexpected");
    case "connector": {
      const output = outputs[0];
      if (output === undefined || outputs.length !== 1)
        return failure("case_output_missing");
      const allowed = await decideCaseOutputSink(input, output, null);
      if (!allowed.ok) {
        const held = await holdRefusedOutput(
          {
            env: input.env,
            turnAuthority: input.turnAuthority,
            connector: input.delivery.connector,
            connectorIdentity: input.delivery.connectorIdentity,
            caseActor: input.caseActor,
          },
          output,
          allowed.error,
        );
        return held.ok
          ? { ok: true, value: { kind: "held", requestId: held.value } }
          : held;
      }
      const delivered = await input.delivery.connector.deliver({
        identity: input.delivery.connectorIdentity,
        delivery: output.delivery,
        requestedAt: Date.now(),
      });
      if (!delivered.ok) return failure(delivered.error.code);
      if (delivered.value.kind === "retry")
        return failure(`connector_delivery_retry:${delivered.value.retryAt}`);
      if (delivered.value.kind === "rejected") {
        await input.caseActor.rejectOutput({
          outputId: output.outputId,
          reason: delivered.value.reason,
        });
        return failure(`connector_delivery_rejected:${delivered.value.reason}`);
      }
      const receipt = await input.caseActor.acceptDeliveryReceipt({
        outputId: output.outputId,
        receipt: {
          ...delivered.value.receipt,
          flowBindingDigest: allowed.value.flowBindingDigest,
          decisionDigest: allowed.value.decisionDigest,
        },
      });
      return receipt.ok
        ? {
            ok: true,
            value: {
              kind: "delivered",
              receiptId: delivered.value.receipt.nativeReceiptId,
            },
          }
        : failure(receipt.error.code);
    }
  }
}

async function runAssignedCaseSession(
  input: AssignedCaseSessionInput,
  assignment: CaseAssignment,
): Promise<Result<CompletedCaseParticipant, CaseWalkingPathError>> {
  const initializationStartedAt = Date.now();
  const initialization = initializedSession(input, assignment);
  if (!initialization.ok) return initialization;
  const initialized = await input.session.initializeCaseSession({
    initialization: initialization.value,
    assignment,
  });
  traceDirectSessionPreparation(
    input,
    "session_initialization",
    initializationStartedAt,
  );
  if (!initialized.ok)
    return failure(`session_initialize:${initialized.error.code}`);

  const instructionDigest = await sha256Hex(assignment.objective.instruction);
  const inputDigest = parseSessionTurnInputDigest(instructionDigest);
  if (!inputDigest.ok) return failure(inputDigest.error.code);
  const turnId = `turn_${input.inputId}`;
  const startId = `start_${turnId}`;
  const assignmentStartedAt = Date.now();
  const begun = await input.caseActor.beginAssignment({
    caseId: assignment.caseId,
    assignmentId: assignment.assignmentId,
    sessionId: assignment.sessionId,
    expectedCaseRevision: assignment.caseRevision,
    start: {
      startId,
      sessionId: assignment.sessionId,
      acceptedAt: input.receivedAt,
    },
  });
  traceDirectSessionPreparation(input, "assignment_start", assignmentStartedAt);
  if (!begun.ok) return failure(begun.error.code);
  const completion = await input.session.startCanonicalEmbeddedHarnessTextTurn({
    requestingOrganisationId: input.organisationId,
    requestId: input.requestId,
    inputDigest: inputDigest.value,
    currentModelRoute: input.policy.modelRoute,
    start: {
      startId,
      correlationId: input.requestId,
      acceptedAt: input.receivedAt,
      admittedAt: input.receivedAt,
      harnessLeaseExpiresAt: input.receivedAt + 10 * 60 * 1_000,
      input: {
        kind: "case",
        inputId: `input_${input.inputId}`,
        caseId: assignment.caseId,
        assignmentId: assignment.assignmentId,
        caseRevision: assignment.caseRevision,
        contentDigest: instructionDigest,
        workspaceRevision: assignment.context.workspaceRevision,
        contextBundleDigest: input.context.bundleDigest,
      },
      requestAuthority: input.turnAuthority.requestAuthority,
      authorityPartitionDigest: assignment.authority.authorityPartitionDigest,
      turnId,
      runtimeLease: { generation: 1, leaseId: `runtime_${turnId}_1` },
      turnLeaseGeneration: 1,
      origin: { kind: "command", principal: input.principal },
    },
    streamSink: null,
    attachments: input.attachments,
    links: input.links,
    browserContext: input.browserContext,
    surfaceContext: input.surfaceContext,
    context: sessionTurnContext(input.context, input.projectContext),
    thinkingLevel: input.thinkingLevel,
    harnessInstructions: composeAgentInstructions(
      EMBEDDED_HARNESS_INSTRUCTIONS,
      input.pinnedAgent,
    ),
    turnPrompt: assignment.objective.instruction,
    completion: {
      completionId: `complete_${turnId}`,
      acceptedAt: input.receivedAt + 1,
    },
  });
  if (!completion.ok) {
    if (completion.error.code === "budget_reservation_indeterminate") {
      return sessionTurnFailure(completion.error, assignment.budget);
    }
    const disposition =
      completion.error.code === "budget_exhausted"
        ? {
            kind: "budget_exhausted" as const,
            exhaustionId: completion.error.exhaustion.exhaustionId,
            dimension: completion.error.exhaustion.dimension,
            settledAt: input.receivedAt + 1,
          }
        : {
            kind: "failed" as const,
            code: completion.error.code,
            settledAt: input.receivedAt + 1,
          };
    await input.caseActor.settleAssignment({
      caseId: assignment.caseId,
      assignmentId: assignment.assignmentId,
      sessionId: assignment.sessionId,
      expectedCaseRevision: assignment.caseRevision,
      expectedStartId: startId,
      disposition,
    });
    return sessionTurnFailure(completion.error, assignment.budget);
  }

  return finalizeAssignedCaseSession(
    input,
    assignment,
    turnId,
    completion.value,
  );
}

function traceDirectSessionPreparation(
  input: Pick<
    AssignedCaseSessionInput,
    "requestId" | "organisationId" | "sessionId"
  >,
  phase:
    | "case_trigger"
    | "assignment"
    | "session_initialization"
    | "assignment_start",
  startedAt: number,
): void {
  traceLog("case.direct_session_preparation_timing", {
    requestId: input.requestId,
    organisation_id: input.organisationId,
    session_id: input.sessionId,
    phase,
    started_at: startedAt,
    duration_ms: Date.now() - startedAt,
  });
}

export async function finalizeAssignedCaseSession(
  input: Pick<
    AssignedCaseSessionInput,
    "env" | "caseActor"
    | "turnAuthority"
    | "receivedAt"
    | "delivery"
    | "revalidateTurnAuthority"
  >,
  assignment: CaseAssignment,
  turnId: string,
  completion: CompletedCaseParticipant["completion"],
): Promise<Result<CompletedCaseParticipant, CaseWalkingPathError>> {
  const proposal: SessionProposal = {
    proposalId: `proposal_${assignment.assignmentId}`,
    assignmentId: assignment.assignmentId,
    caseId: assignment.caseId,
    sessionId: assignment.sessionId,
    turnId,
    basedOnRevision: assignment.caseRevision,
    entries: [
      {
        kind: "observation",
        entryId: `entry_${assignment.assignmentId}`,
        content: { kind: "text", text: completion.finalMessage },
      },
    ],
    requestedEffects: [],
  };
  const flowBinding = await restoreFlowBinding(completion.flowBinding);
  if (!flowBinding.ok) return failure(flowBinding.error.code);
  const acceptance = await input.caseActor.acceptSessionProposal({
    proposal,
    requestAuthority: input.turnAuthority.requestAuthority,
    acceptedAt: input.receivedAt + 2,
    flowBinding: flowBinding.value.toJSON(),
  });
  if (!acceptance.ok) return failure(acceptance.error.code);
  if (acceptance.value.disposition.kind !== "accepted")
    return failure(`proposal_${acceptance.value.disposition.kind}`);
  const delivery = await completeCaseOutput(input, acceptance.value.outputs);
  if (!delivery.ok) return delivery;
  const settled = await input.caseActor.settleAssignment({
    caseId: assignment.caseId,
    assignmentId: assignment.assignmentId,
    sessionId: assignment.sessionId,
    expectedCaseRevision: assignment.caseRevision,
    expectedStartId: `start_${turnId}`,
    disposition: {
      kind: "completed",
      proposalId: proposal.proposalId,
      settledAt: input.receivedAt + 3,
    },
  });
  if (!settled.ok) return failure(settled.error.code);
  const completed = {
    assignment,
    proposal,
    completion,
    caseRevision: acceptance.value.disposition.revision,
  };
  switch (delivery.value.kind) {
    case "unaddressed":
      return {
        ok: true,
        value: { ...completed, delivery: { kind: "unaddressed" } },
      };
    case "held":
      return {
        ok: true,
        value: {
          ...completed,
          delivery: { kind: "held", requestId: delivery.value.requestId },
        },
      };
    case "delivered":
      return {
        ok: true,
        value: {
          ...completed,
          delivery: {
            kind: "delivered",
            receiptId: delivery.value.receiptId,
          },
        },
      };
    default:
      return assertNever(delivery.value);
  }
}

async function buildAssignment(
  input: AssignedCaseSessionInput,
  budget: SessionBudget,
  revision: number,
  journalCursor: CaseAssignment["context"]["journalCursor"],
  entries: readonly CaseAssignment["context"]["entries"][number][],
  role: AgentRole = "coordinator",
  objective: string = input.purpose,
): Promise<CaseAssignment> {
  return {
    assignmentId: input.assignmentId,
    caseId: input.caseId,
    caseRevision: revision,
    sessionId: input.sessionId,
    role,
    objective: { instruction: objective },
    authority: {
      capabilityProfile: "read_and_propose",
      authorityPartitionDigest: input.turnAuthority.authorityPartition.digest,
    },
    authorityPartition: input.turnAuthority.authorityPartition,
    budget,
    context: {
      caseId: input.caseId,
      revision,
      journalCursor,
      workspaceRevision: input.workspaceRevisionReceipt.revision,
      entries: [...entries],
      evidenceDependency: { kind: "source_only" },
    },
  };
}

function sessionTurnContext(
  context: ContextAssemblyResult,
  projectContext: ProjectSnapshot | null,
): Readonly<{
  projectContext: ProjectSnapshot | null;
  bundle: unknown;
  bundleDigest: ContextAssemblyResult["bundleDigest"];
  modelContext: ContextAssemblyResult["modelContext"];
}> {
  return {
    projectContext,
    bundle: serializeContextBundle(context.bundle),
    bundleDigest: context.bundleDigest,
    modelContext: context.modelContext,
  };
}

function boundedSessionBudget(
  policy: PinnedSessionPolicy,
): Result<SessionBudget, CaseWalkingPathError> {
  const limit = policy.authz.maxBudget;
  if (
    limit === null ||
    limit.maxTokens === null ||
    limit.maxWallMs === null ||
    limit.maxToolCalls === null ||
    !isPositiveInteger(limit.maxTokens) ||
    !isPositiveInteger(limit.maxWallMs) ||
    !isPositiveInteger(limit.maxToolCalls)
  ) {
    return failure("case_session_budget_unbounded");
  }
  return {
    ok: true,
    value: {
      budgetRevision: `budget_${policy.version}`,
      maxTokens: limit.maxTokens,
      maxWallMs: limit.maxWallMs,
      maxToolCalls: limit.maxToolCalls,
    },
  };
}

/** A new Session on the current route of the policy, which must have an adapter. */
function initializedSession(
  input: AssignedCaseSessionInput,
  assignment: CaseAssignment,
): Result<InitializedCaseSessionCommit["initialization"], CaseWalkingPathError> {
  const selected = selectEmbeddedHarnessAdapterForModelRoute(
    input.policy.modelRoute,
  );
  if (!selected.ok) return failure(selected.error.code);
  const adapter = selected.value;
  const state: InitializedSessionCommit["state"] = {
    kind: "sleeping",
    state: {
      identity: {
        organisationId: input.organisationId,
        sessionId: input.sessionId,
        streamId: `stream_${input.sessionId}`,
      },
      contract: {
        policyVersion: assignment.authorityPartition.policyVersion,
        budgetRevision: assignment.budget.budgetRevision,
        runtimeRevision: adapter.manifest.harnessBuild,
        modelRoute: input.policy.modelRoute,
        lastEventSequence: 0,
      },
      resumePoint: {
        kind: "new",
        workspaceRevisionReceipt: input.workspaceRevisionReceipt,
      },
    },
  };
  const commandId = `initialize_${input.sessionId}`;
  return {
    ok: true,
    value: {
    source: "case_actor",
    commandId,
    event: {
      envelopeVersion: "actor-envelope.v1",
      payloadVersion: "session-transition.v1",
      eventId: `${commandId}_accepted`,
      organisationId: input.organisationId,
      actorId: input.sessionId,
      streamId: state.state.identity.streamId,
      sequence: 0,
      sourceTime: { kind: "pantry", issuedAt: input.receivedAt },
      acceptedAt: input.receivedAt,
      correlationId: input.requestId,
      causation: { kind: "command", commandId },
      idempotencyKey: commandId,
      runtimeRevision: adapter.manifest.harnessBuild,
      principal: input.principal,
      sensitivity: "organisation_private",
      retention: "session",
      body: { kind: "session_initialized", state: state.state },
    },
    state,
    projection: {
      threadKey: `case:${assignment.caseId}`,
      track: "managed-agents",
      startedAt: input.receivedAt,
    },
    },
  };
}

function failure(code: string): Result<never, CaseWalkingPathError> {
  return { ok: false, error: { kind: "operational", code } };
}

/**
 * A message in a thread whose Session already ran out of its budget. It gets
 * the same budget notice as the request that ran out, not a retry.
 */
function earlierBudgetStop(
  assignment: CaseAssignment,
  disposition: Readonly<{
    exhaustionId: SessionBudgetExhaustion["exhaustionId"];
    dimension: SessionBudgetExhaustion["dimension"];
    settledAt: SessionBudgetExhaustion["exhaustedAt"];
  }>,
): Result<never, CaseWalkingPathError> {
  return {
    ok: false,
    error: {
      kind: "budget_exhausted",
      code: "session_turn:budget_exhausted",
      exhaustion: {
        exhaustionId: disposition.exhaustionId,
        dimension: disposition.dimension,
        runId: assignment.sessionId,
        observedUsage: { tokens: 0, activeWallMs: 0, capabilityCalls: 0 },
        exhaustedAt: disposition.settledAt,
      },
      budget: assignment.budget,
    },
  };
}

function sessionTurnFailure(
  error: CanonicalEmbeddedHarnessTextTurnError,
  budget: SessionBudget,
): Result<never, CaseWalkingPathError> {
  if (
    error.code === "budget_reservation_indeterminate" ||
    error.code === "embedded_harness_model_usage_missing" ||
    (error.code === "embedded_harness_turn_failed_with_usage" &&
      error.cause.code === "embedded_harness_model_usage_missing")
  )
    return {
      ok: false,
      error: {
        kind: "usage_pending",
        code: "session_turn:budget_reservation_indeterminate",
      },
    };
  if (error.code === "budget_exhausted")
    return {
      ok: false,
      error: {
        kind: "budget_exhausted",
        code: "session_turn:budget_exhausted",
        exhaustion: error.exhaustion,
        budget,
      },
    };
  // The Session refused the stream sink before the turn began. The refusal
  // keeps the code that the Connector gives for the same decision.
  if (error.code === "canonical_text_turn_sink_refused")
    return failure(error.refusal);
  return error.code === "embedded_harness_history_failed"
    ? {
        ok: false,
        error: {
          kind: "history_corruption",
          source: "session_turn",
          code: error.code,
        },
      }
    : failure(
        error.code === "canonical_text_turn_state_invalid"
          ? `session_turn:${error.code}:${error.reason}`
          : `session_turn:${error.code}`,
      );
}

function sessionStreamFailure(
  error: ConnectorCaseTurnStreamError,
): Result<never, CaseWalkingPathError> {
  switch (error.kind) {
    case "history_corruption":
      return {
        ok: false,
        error: { kind: error.kind, source: "session_stream", code: error.code },
      };
    case "operational":
      return failure(`session_stream:${error.code}`);
    default:
      return assertNever(error);
  }
}
