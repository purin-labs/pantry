import type {
  CaseAssignment,
  CaseAssignmentLifecycle,
  CaseAssignmentStart,
  CaseOutput,
  CaseOutputLifecycle,
} from "@purin-labs/contracts";
import type { CaseContributionSource } from "../src/actors/case/types";

declare const assignment: CaseAssignment;
declare const start: CaseAssignmentStart;
declare const output: CaseOutput;

// @ts-expect-error assigned lifecycle requires its immutable assignment
const assignedWithoutAssignment: CaseAssignmentLifecycle = { kind: "assigned" };

// @ts-expect-error running lifecycle requires accepted start evidence
const runningWithoutStart: CaseAssignmentLifecycle = {
  kind: "running",
  assignment,
};

// @ts-expect-error settled lifecycle requires a terminal disposition
const settledWithoutDisposition: CaseAssignmentLifecycle = {
  kind: "settled",
  assignment,
  start,
};

// @ts-expect-error settled Case output requires its Connector receipt
const settledOutputWithoutReceipt: CaseOutputLifecycle = {
  kind: "settled",
  output,
};

void assignedWithoutAssignment;
void runningWithoutStart;
void settledWithoutDisposition;
void settledOutputWithoutReceipt;

// @ts-expect-error an agent contribution requires its full accepted turn identity
const agentWithoutTurn: CaseContributionSource = {
  kind: "agent_turn",
  proposalId: "proposal",
};
// @ts-expect-error commerce outcomes require their action identity
const outcomeWithoutAction: CaseContributionSource = {
  kind: "commerce_outcome",
  proposalId: "proposal",
};
// @ts-expect-error action identity belongs to a commerce outcome
const agentWithAction: CaseContributionSource = {
  kind: "agent_turn",
  assignmentId: "assignment",
  sessionId: "session",
  turnId: "turn",
  proposalId: "proposal",
  actionNonce: "action",
};
void agentWithoutTurn;
void outcomeWithoutAction;
void agentWithAction;

const outcomeWithSession = {
  kind: "commerce_outcome" as const,
  proposalId: "proposal",
  actionNonce: "action",
  sessionId: "session",
};
// @ts-expect-error structural assignment also rejects producer identity mixtures
const mixedSource: CaseContributionSource = outcomeWithSession;
// @ts-expect-error spreading a producer cannot smuggle a session into an outcome
const spreadSource: CaseContributionSource = { ...outcomeWithSession };
void mixedSource;
void spreadSource;

const operatorWithAgentFields = {
  kind: "operator_command" as const,
  commandId: "command",
  requestDigest: "digest",
  sessionId: "session",
};
// @ts-expect-error an operator command cannot claim agent-turn ownership
const invalidOperator: CaseContributionSource = operatorWithAgentFields;
// @ts-expect-error broad spreads preserve the same producer restriction
const invalidOperatorSpread: CaseContributionSource = {
  ...operatorWithAgentFields,
};
// @ts-expect-error command receipts require their request digest
const missingOperatorDigest: CaseContributionSource = {
  kind: "operator_command",
  commandId: "command",
};
void invalidOperator;
void invalidOperatorSpread;
void missingOperatorDigest;

// Completion consumers must retain the saved terminal outcome.
declare const completionWithoutOutcome: Omit<
  import("@purin-labs/agent/actors/session/types").CanonicalEmbeddedHarnessTextTurnResult,
  "outcome"
>;
// @ts-expect-error A reconstructed completion requires its terminal outcome.
const incompleteTurn: import("@purin-labs/agent/actors/session/types").CanonicalEmbeddedHarnessTextTurnResult =
  { ...completionWithoutOutcome };
void incompleteTurn;
