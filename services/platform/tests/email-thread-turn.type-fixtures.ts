import type { EmailThreadTurnOutcome } from "../src/actors/email-case-processing";
import type { EmailDispatchOutcome } from "../src/actors/connector-email-proposal";

// @ts-expect-error An uncertain send requires its exact dispatch version and digests.
export const unidentifiedSend: EmailDispatchOutcome = {
  kind: "send_indeterminate",
};

const uncertainSend = {
  kind: "send_indeterminate",
  version: 2,
  bodyDigest: "a".repeat(64),
  snapshotDigest: "b".repeat(64),
  rfcMessageId: "<dispatch-v2@example.test>",
} as const;

// @ts-expect-error A spread cannot turn an unresolved Message-ID into a confirmed receipt.
export const impossibleReceipt: EmailDispatchOutcome = {
  ...uncertainSend,
  kind: "sent",
  providerMessageId: "gmail_receipt",
};

const draft = {
  kind: "proposed",
  proposalId: "proposal_mail",
  draftId: "draft_mail",
  disposition: "approval_required",
  responsePolicy: "draft_only",
} as const;

export const reviewDraft: EmailThreadTurnOutcome = draft;

export const draftWithAcknowledgement: EmailThreadTurnOutcome = {
  ...draft,
  // @ts-expect-error A draft-only result cannot record an automatic acknowledgement.
  acknowledgement: "sent",
};

// @ts-expect-error Cue review requires its automatic acknowledgement outcome.
export const missingAcknowledgement: EmailThreadTurnOutcome = {
  kind: "proposed",
  proposalId: "proposal_mail",
  draftId: "draft_mail",
  disposition: "approval_required",
  responsePolicy: "cue_routed",
};
