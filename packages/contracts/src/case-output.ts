import { Type } from "typebox";
import { StrictObject } from "@seams/commerce-contracts/schema";
import type { AssignmentId } from "./types/AssignmentId";
import type { SessionId } from "./types/SessionId";
import type { SessionProposalId } from "./types/SessionProposalId";
import type { TurnId } from "./types/TurnId";

// What produced a Case output.

/** Where a Case output came from. */
export type CaseContributionSource =
  | { kind: "operator_command"; commandId: string; requestDigest: string }
  | {
      kind: "agent_turn";
      assignmentId: AssignmentId;
      sessionId: SessionId;
      turnId: TurnId;
      proposalId: SessionProposalId;
    }
  | { kind: "commerce_outcome"; proposalId: string; actionNonce: string }
  /** The fixed notice that an agent's commerce proposal waits for approval. */
  | {
      kind: "commerce_approval_notice";
      proposalId: string;
      actionNonce: string;
    };

const text = Type.String({ minLength: 1 });

export const caseContributionSourceSchema = Type.Unsafe<CaseContributionSource>(
  Type.Union([
    StrictObject({
      kind: Type.Literal("operator_command"),
      commandId: text,
      requestDigest: text,
    }),
    StrictObject({
      kind: Type.Literal("agent_turn"),
      assignmentId: text,
      sessionId: text,
      turnId: text,
      proposalId: text,
    }),
    StrictObject({
      kind: Type.Literal("commerce_outcome"),
      proposalId: text,
      actionNonce: text,
    }),
    StrictObject({
      kind: Type.Literal("commerce_approval_notice"),
      proposalId: text,
      actionNonce: text,
    }),
  ]),
);
