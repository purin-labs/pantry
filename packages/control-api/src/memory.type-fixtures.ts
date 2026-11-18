import type {
  MemoryApplicability,
  MemoryAuthor,
  MemoryCommand,
  MemoryDecision,
  MemoryRejection,
  MemoryRevisionState,
} from "./memory";

const decision: MemoryDecision = {
  reviewerPersonId: "person_reviewer",
  commandId: "command_accept",
  decidedAt: 1,
};

// @ts-expect-error A candidate has no acceptance.
export const acceptedCandidate: MemoryRevisionState = {
  kind: "candidate",
  acceptance: decision,
};

// @ts-expect-error An accepted revision requires its reviewer and receipt.
export const unreviewedAcceptance: MemoryRevisionState = { kind: "accepted" };

const acceptance = { acceptance: decision };
// @ts-expect-error Spreading acceptance fields cannot make a rejection accepted.
export const spreadRejection: MemoryRevisionState = {
  kind: "rejected",
  rejection: { ...decision, reason: "declined" },
  ...acceptance,
};

// @ts-expect-error A superseded revision names its replacement.
export const orphanedSupersession: MemoryRevisionState = {
  kind: "superseded",
  acceptance: decision,
};

// @ts-expect-error Revocation keeps the acceptance it withdraws.
export const unacceptedRevocation: MemoryRevisionState = {
  kind: "revoked",
  revocation: decision,
};

// @ts-expect-error A declined candidate has no replacement.
export const replacedDecline: MemoryRejection = {
  ...decision,
  reason: "declined",
  replacementRevision: 2,
};

// @ts-expect-error A revised candidate names the revision that replaced it.
export const unreplacedRevision: MemoryRejection = {
  ...decision,
  reason: "revised",
};

// @ts-expect-error A skill scope cannot also name a commerce entity.
export const mixedApplicability: MemoryApplicability = {
  kind: "skill",
  skillId: "skill_purchasing",
  merchantId: "merchant_a",
};

// @ts-expect-error An entity scope requires the exact entity reference.
export const classAsEntity: MemoryApplicability = {
  kind: "commerce_entity",
  merchantId: "merchant_a",
  entityType: "trade_partner",
};

// @ts-expect-error A decision names an exact revision and carries no content.
export const undirectedDecision: MemoryCommand = {
  commandId: "command_accept",
  expectedRevision: 1,
  kind: "accept",
  memoryId: "memory_a",
};

const agentWithSubmission = {
  kind: "agent",
  caseId: "case_a",
  assignmentId: "assignment_a",
  sessionId: "session_a",
  submission: "shared_review",
} as const;
// @ts-expect-error An agent has no review surface to submit an edit to.
export const agentSharedEdit: MemoryAuthor = agentWithSubmission;

// @ts-expect-error A person's revision states how it was submitted.
export const unstatedSubmission: MemoryAuthor = {
  kind: "operator",
  personId: "person_author",
};
