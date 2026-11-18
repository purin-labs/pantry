import type { MemoryRevisionView } from "@seams/control-api";

import type { FlowLabel } from "../policy/information-flow";
import type { MemoryRevision, MemoryStoreCommand } from "./store";

declare const view: MemoryRevisionView;
declare const flowLabel: FlowLabel;

// @ts-expect-error Direct construction cannot supply the stored-revision brand.
export const constructed: MemoryRevision = { ...view, flowLabel };

const authoredDecision = {
  commandId: "command_accept",
  expectedRevision: 1,
  kind: "accept",
  memoryId: "memory_a",
  revision: 1,
  author: {
    kind: "agent",
    caseId: "case_a",
    assignmentId: "assignment_a",
    sessionId: "session_a",
  },
} as const;
// @ts-expect-error A decision names its reviewer; an agent author cannot decide.
export const agentDecision: MemoryStoreCommand = authoredDecision;

const proposal = {
  commandId: "command_propose",
  expectedRevision: 0,
  kind: "propose",
  memoryId: null,
  newMemoryId: "memory_a",
  content: view,
  author: {
    kind: "operator",
    personId: "person_author",
    submission: "own_input",
  },
  flowLabel,
} as const;
export const candidateProposal: MemoryStoreCommand = proposal;

const reviewer = { reviewerPersonId: "person_reviewer" };
const reviewedProposal = { ...proposal, ...reviewer };
// @ts-expect-error Spreading a reviewer into a proposal cannot decide it.
export const decidedProposal: MemoryStoreCommand = reviewedProposal;
