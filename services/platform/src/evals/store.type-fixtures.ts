import type { EvalContent, EvalRevisionView } from "@seams/control-api";

import type { FlowLabel } from "../policy/information-flow";
import type { EvalRevision, EvalStoreCommand } from "./store";

declare const view: EvalRevisionView;
declare const content: EvalContent;
declare const flowLabel: FlowLabel;

// @ts-expect-error Direct construction cannot supply the stored-revision brand.
export const constructed: EvalRevision = { ...view, flowLabel };

const authoredDecision = {
  commandId: "command_accept",
  expectedRevision: 1,
  kind: "accept",
  evalId: "eval_a",
  revision: 1,
  author: {
    kind: "agent",
    caseId: "case_a",
    assignmentId: "assignment_a",
    sessionId: "session_a",
  },
} as const;
// @ts-expect-error A decision names its reviewer; an agent author cannot decide.
export const agentDecision: EvalStoreCommand = authoredDecision;

const proposal = {
  commandId: "command_propose",
  expectedRevision: 0,
  kind: "propose",
  evalId: null,
  newEvalId: "eval_a",
  content,
  author: {
    kind: "agent",
    caseId: "case_a",
    assignmentId: "assignment_a",
    sessionId: "session_a",
  },
  flowLabel,
} as const;
export const candidateProposal: EvalStoreCommand = proposal;

const reviewer = { reviewerPersonId: "person_reviewer" };
const reviewedProposal = { ...proposal, ...reviewer };
// @ts-expect-error Spreading a reviewer into a proposal cannot decide it.
export const decidedProposal: EvalStoreCommand = reviewedProposal;
