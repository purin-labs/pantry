import type { AssignmentId } from "./AssignmentId";
import type { SessionId } from "./SessionId";
import type { SessionProposalId } from "./SessionProposalId";
import type { TurnId } from "./TurnId";

export type CaseContributionSource =
  | { kind: "operator_command"; commandId: string; requestDigest: string }
  | {
      kind: "agent_turn";
      assignmentId: AssignmentId;
      sessionId: SessionId;
      turnId: TurnId;
      proposalId: SessionProposalId;
    }
  | { kind: "commerce_outcome"; proposalId: string; actionNonce: string };
