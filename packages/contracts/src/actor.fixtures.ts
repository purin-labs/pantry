import type {
  AgentSessionLifecycle,
  CommandEnvelope,
  ConnectorAddress,
  EventBody,
  EffectLifecycle,
  HarnessCheckpointRecord,
  HarnessEventCursor,
  RequestAuthority,
  RunBudgetReservationState,
  SessionCommand,
  TurnLifecycle,
} from "./index";
import type { Variant } from "@purin-labs/type-utils";

// @ts-expect-error Direct conversation authority requires the resolved organisation role.
const invalidDirectRequestAuthority: RequestAuthority = {
  kind: "direct_conversation",
  organisationId: "organisation_1",
  requesterPersonId: "person_1",
  membershipRevision: 1,
  connectorId: "connector_1",
  integrationAccountId: "account_1",
  conversationId: "conversation_1",
};

const agentMailboxRequestAuthority: RequestAuthority = {
  kind: "agent_mailbox",
  organisationId: "organisation_1",
  integrationAccountId: "account_1",
  mailboxBindingId: "mailbox_binding_1",
  bindingRevision: 1,
  mailboxPolicyVersion: 1,
};

// @ts-expect-error Agent mailbox authority requires the pinned mailbox policy version.
const invalidAgentMailboxRequestAuthority: RequestAuthority = {
  kind: "agent_mailbox",
  organisationId: "organisation_1",
  integrationAccountId: "account_1",
  mailboxBindingId: "mailbox_binding_1",
  bindingRevision: 1,
};

const emailThreadConnectorAddress: ConnectorAddress = {
  kind: "email_thread",
  integrationAccountId: "account_1",
  gmailThreadId: "thread_1",
};

const invalidEmailThreadConnectorAddress: ConnectorAddress = {
  kind: "email_thread",
  integrationAccountId: "account_1",
  gmailThreadId: "thread_1",
  // @ts-expect-error Email thread addresses never carry Slack conversation fields.
  channelId: "channel_1",
};

// @ts-expect-error Active reservations require accepted usage.
const invalidActiveBudgetReservation: RunBudgetReservationState = {
  kind: "active",
  reservation: {
    reservationId: "reservation_1",
    runId: "run_1",
    turnId: "turn_1",
    runtimeGeneration: 1,
    turnLeaseGeneration: 1,
    budgetRevision: "budget_1",
    allowance: { tokens: 10, activeWallMs: 100, capabilityCalls: 1 },
    acceptedAt: 1,
    deadlineAt: 101,
  },
};

type TestCommand = { inputId: string };
type TestReceipt = { providerId: string };

const admittedTurn: TurnLifecycle = {
  kind: "admitted",
  state: {
    identity: {
      turnId: "turn_1",
      inputId: "input_1",
      turnLeaseGeneration: 1,
      budgetRevision: "budget_1",
    },
    admittedAt: 10,
  },
};

const workspaceRevisionReceipt = {
  receiptId: "workspace_receipt_1",
  outcome: "accepted" as const,
  workspaceId: "workspace_catalog_1",
  revision: "workspace_1",
  canonicalHead:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  correlationId: "correlation_1",
  causation: { kind: "command" as const, commandId: "workspace_command_1" },
};

const invalidNewResumePoint: Variant<
  AgentSessionLifecycle,
  "sleeping"
>["state"]["resumePoint"] = {
  kind: "new",
  // @ts-expect-error A new session requires the authority-owned workspace receipt.
  workspaceRevision: "workspace_1",
};

const processingSession: Variant<AgentSessionLifecycle, "processing"> = {
  kind: "processing",
  state: {
    identity: {
      organisationId: "organisation_1",
      sessionId: "session_1",
      streamId: "stream_1",
    },
    contract: {
      policyVersion: "policy_1",
      budgetRevision: "budget_1",
      runtimeRevision: "runtime_1",
      modelRoute: {
        keySource: "platform",
        provider: "openai-compatible",
        model: "gpt-5.6-sol",
      },
      lastEventSequence: 4,
    },
    resumePoint: {
      kind: "new",
      workspaceRevisionReceipt,
    },
    runtimeLease: {
      generation: 1,
      leaseId: "lease_1",
    },
    activeTurn: admittedTurn,
  },
};

const invalidSleepingSession: AgentSessionLifecycle = {
  kind: "sleeping",
  state: {
    identity: processingSession.state.identity,
    contract: processingSession.state.contract,
    resumePoint: {
      kind: "new",
      workspaceRevisionReceipt,
    },
    // @ts-expect-error Sleeping sessions cannot retain an active turn.
    activeTurn: admittedTurn,
  },
};

const activatingSession: Variant<AgentSessionLifecycle, "activating"> = {
  kind: "activating",
  state: {
    identity: processingSession.state.identity,
    contract: processingSession.state.contract,
    turnId: "turn_2",
    inputId: "input_2",
    resumePoint: {
      kind: "new",
      workspaceRevisionReceipt,
    },
    runtimeGeneration: 2,
  },
};

const initialHarnessCursor: HarnessEventCursor = {
  kind: "before_first",
  turn: admittedTurn.state.identity,
};

// @ts-expect-error An accepted cursor requires the digest of the accepted event.
const invalidAcceptedHarnessCursor: HarnessEventCursor = {
  kind: "accepted",
  turn: admittedTurn.state.identity,
  lastSequence: 1,
};

// @ts-expect-error A durable checkpoint must bind the model route digest.
const incompleteHarnessCheckpoint: HarnessCheckpointRecord = {
  backendId: "pi",
  blob: {
    objectKey: "harness/checkpoint/1",
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    byteLength: 128,
    formatVersion: "checkpoint_v1",
    harnessBuild: "pi_agent_core_0_82_0",
    createdAt: 20,
  },
  session: processingSession.state.identity,
  turn: admittedTurn.state.identity,
  runtimeLease: processingSession.state.runtimeLease,
  runtimeRevision: processingSession.state.contract.runtimeRevision,
  policyVersion: processingSession.state.contract.policyVersion,
  budgetRevision: processingSession.state.contract.budgetRevision,
  budgetUsage: {
    tokens: 0,
    activeWallMs: 0,
    capabilityCalls: 0,
  },
  usageCursor: 0,
  budgetAccountDigest:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  cursor: {
    turn: admittedTurn.state.identity,
    lastSequence: 1,
    lastEventDigest:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  lastActorEventSequence: processingSession.state.contract.lastEventSequence,
  workspaceBaseRevision: "workspace_1",
  workspaceRevision: "workspace_1",
  instructionDigest:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  toolCatalogDigest:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const invalidActivatingSession: AgentSessionLifecycle = {
  kind: "activating",
  state: {
    identity: processingSession.state.identity,
    contract: processingSession.state.contract,
    turnId: "turn_2",
    inputId: "input_2",
    resumePoint: {
      kind: "new",
      workspaceRevisionReceipt,
    },
    runtimeGeneration: 2,
    // @ts-expect-error Activation cannot claim a runtime lease before allocation succeeds.
    runtimeLease: processingSession.state.runtimeLease,
  },
};

const recoverableQuarantine: AgentSessionLifecycle = {
  kind: "quarantined",
  state: {
    identity: processingSession.state.identity,
    contract: processingSession.state.contract,
    reason: "activation_failure",
    recovery: {
      kind: "reactivate",
      turnId: "turn_2",
      inputId: "input_2",
      resumePoint: activatingSession.state.resumePoint,
      nextRuntimeGeneration: 3,
    },
  },
};

const invalidRecoverableQuarantine: AgentSessionLifecycle = {
  kind: "quarantined",
  // @ts-expect-error Reactivation requires the next fenced runtime generation.
  state: {
    identity: processingSession.state.identity,
    contract: processingSession.state.contract,
    reason: "activation_failure",
    recovery: {
      kind: "reactivate",
      turnId: "turn_2",
      inputId: "input_2",
      resumePoint: activatingSession.state.resumePoint,
    },
  },
};

const invalidAwaitingExecution: TurnLifecycle = {
  kind: "awaiting_execution",
  // @ts-expect-error Awaiting execution requires its effect identity.
  state: {
    identity: admittedTurn.state.identity,
    executionId: "execution_1",
  },
};

const indeterminateEffect: EffectLifecycle<TestCommand, TestReceipt> = {
  kind: "indeterminate",
  state: {
    effectId: "effect_1",
    kind: "provider",
    capability: "unsafe_to_retry",
    idempotencyKey: "provider_request_1",
    request: {
      kind: "inline",
      value: { inputId: "input_1" },
    },
    dispatchId: "dispatch_1",
    reason: "dispatch_outcome_unknown",
    observedAt: 20,
  },
};

const invalidSettledState: {
  effectId: string;
  kind: "provider";
  capability: "idempotent";
  request: EventBody<TestCommand>;
  settledAt: number;
} = {
  effectId: "effect_1",
  kind: "provider",
  capability: "idempotent",
  request: {
    kind: "inline",
    value: { inputId: "input_1" },
  },
  settledAt: 30,
};

const invalidSettledEffect: EffectLifecycle<TestCommand, TestReceipt> = {
  kind: "settled",
  // @ts-expect-error Settled effects require a receipt and cannot carry a request.
  state: invalidSettledState,
};

const validCommandEnvelope: CommandEnvelope<TestCommand> = {
  envelopeVersion: "actor-envelope.v1",
  payloadVersion: "session-command.v1",
  commandId: "command_1",
  organisationId: "organisation_1",
  targetActorId: "session_1",
  sourceTime: { kind: "producer", occurredAt: 1 },
  receivedAt: 2,
  correlationId: "correlation_1",
  causation: { kind: "ingress", observationId: "ingress_1" },
  idempotencyKey: "input_1",
  runtimeRevision: "runtime_1",
  principal: { kind: "human", principalId: "user_1" },
  sensitivity: "organisation_private",
  retention: "session",
  body: { inputId: "input_1" },
};

const acceptedInputCommand: SessionCommand = {
  kind: "accept_input",
  input: {
    kind: "case",
    inputId: "input_1",
    caseId: "case_1",
    assignmentId: "assignment_1",
    caseRevision: 1,
    contentDigest:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workspaceRevision: "workspace_1",
    contextBundleDigest:
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  },
  turnId: "turn_1",
  runtimeGeneration: 1,
};

const invalidAcceptedInputCommand: SessionCommand = {
  kind: "accept_input",
  // @ts-expect-error Accepted input commands require canonical content provenance.
  input: {
    kind: "case",
    inputId: "input_1",
    caseId: "case_1",
    assignmentId: "assignment_1",
    caseRevision: 1,
    workspaceRevision: "workspace_1",
  },
  turnId: "turn_1",
  runtimeGeneration: 1,
};

const activateRuntimeCommand: SessionCommand = {
  kind: "activate_runtime",
  runtimeLease: { generation: 2, leaseId: "lease_2" },
  turnLeaseGeneration: 1,
  admittedAt: 20,
};

// @ts-expect-error Runtime activation requires one fenced runtime lease.
const invalidActivateRuntimeCommand: SessionCommand = {
  kind: "activate_runtime",
  turnLeaseGeneration: 1,
  admittedAt: 20,
};

// @ts-expect-error Actor command envelopes require an attributed principal.
const invalidCommandEnvelope: CommandEnvelope<TestCommand> = {
  envelopeVersion: "actor-envelope.v1",
  payloadVersion: "session-command.v1",
  commandId: "command_1",
  organisationId: "organisation_1",
  targetActorId: "session_1",
  sourceTime: { kind: "producer", occurredAt: 1 },
  receivedAt: 2,
  correlationId: "correlation_1",
  causation: { kind: "ingress", observationId: "ingress_1" },
  idempotencyKey: "input_1",
  runtimeRevision: "runtime_1",
  sensitivity: "organisation_private",
  retention: "session",
  body: { inputId: "input_1" },
};

void invalidSleepingSession;
void activatingSession;
void invalidActivatingSession;
void recoverableQuarantine;
void invalidRecoverableQuarantine;
void invalidAwaitingExecution;
void indeterminateEffect;
void invalidSettledEffect;
void validCommandEnvelope;
void invalidCommandEnvelope;
void acceptedInputCommand;
void invalidAcceptedInputCommand;
void activateRuntimeCommand;
void invalidActivateRuntimeCommand;
void initialHarnessCursor;
void invalidAcceptedHarnessCursor;
void invalidNewResumePoint;
void invalidDirectRequestAuthority;
void agentMailboxRequestAuthority;
void invalidAgentMailboxRequestAuthority;
void emailThreadConnectorAddress;
void invalidEmailThreadConnectorAddress;
