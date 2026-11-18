import type { AssignmentId } from "./AssignmentId";
import type { CaseId } from "./CaseId";
import type { CaseRevision } from "./CaseRevision";
import type { ProposedCaseEntry } from "./ProposedCaseEntry";
import type { ProposedEffectRef } from "./ProposedEffectRef";
import type { SessionId } from "./SessionId";
import type { SessionProposalId } from "./SessionProposalId";
import type { TurnId } from "./TurnId";

export type SessionProposal = {
  proposalId: SessionProposalId;
  assignmentId: AssignmentId;
  caseId: CaseId;
  sessionId: SessionId;
  turnId: TurnId;
  basedOnRevision: CaseRevision;
  entries: Array<ProposedCaseEntry>;
  requestedEffects: Array<ProposedEffectRef>;
};
