import type { AgentObjective } from "./AgentObjective";
import type { AgentRole } from "./AgentRole";
import type { AssignmentId } from "./AssignmentId";
import type { AuthorityPartition } from "./AuthorityPartition";
import type { CaseContextSnapshot } from "./CaseContextSnapshot";
import type { CaseId } from "./CaseId";
import type { CaseRevision } from "./CaseRevision";
import type { SessionAuthority } from "./SessionAuthority";
import type { SessionBudget } from "./SessionBudget";
import type { SessionId } from "./SessionId";

export type CaseAssignment = {
  assignmentId: AssignmentId;
  caseId: CaseId;
  caseRevision: CaseRevision;
  sessionId: SessionId;
  role: AgentRole;
  objective: AgentObjective;
  authority: SessionAuthority;
  authorityPartition: AuthorityPartition;
  budget: SessionBudget;
  context: CaseContextSnapshot;
};
