import { evaluateMail } from "../src/mail-inbox/evaluation";
import { prepareTransientEmailAssignment } from "@purin-labs/conversation/actors/case-walking-path";
import type { EmailThreadTurnOutcome } from "../src/actors/email-case-processing";
declare const completedReply: Extract<
  EmailThreadTurnOutcome,
  { kind: "proposed" }
>;
// @ts-expect-error Deferred preparation cannot also publish a completed draft.
const invalidDeferredReply: EmailThreadTurnOutcome = {
  ...completedReply,
  kind: "deferred",
  reason: "placement_changed",
};
void invalidDeferredReply;
declare const assignmentPreparation: Parameters<
  typeof prepareTransientEmailAssignment
>[0];
const { scope: assignmentScope, ...unscopedAssignment } = assignmentPreparation;
void assignmentScope;
// @ts-expect-error Assignment preparation requires its originating placement.
void prepareTransientEmailAssignment(unscopedAssignment);
const { connectorSql: assignmentSql, ...unownedAssignment } =
  assignmentPreparation;
void assignmentSql;
// @ts-expect-error Assignment preparation must check the owning Actor's export barrier.
void prepareTransientEmailAssignment(unownedAssignment);
declare const input: Parameters<typeof evaluateMail>[0];
const { scope, ...withoutScope } = input;
void scope;
// @ts-expect-error Mail evaluation must retain its admitted Organisation placement.
void evaluateMail({ ...withoutScope });

import { readOrganization } from "../src/mail-inbox/commands";
import { readClassifiedPage, readDecision } from "../src/mail-inbox/reads";
declare const readContext: Parameters<typeof readDecision>[0];
const { scope: readScope, ...unscopedRead } = readContext;
void readScope;
declare const decision: Parameters<typeof readDecision>[1];
declare const page: Parameters<typeof readClassifiedPage>[1];
declare const organization: Parameters<typeof readOrganization>[1];
// @ts-expect-error Decision hydration requires captured Connector authority.
void readDecision({ ...unscopedRead }, decision);
// @ts-expect-error Classified pages require captured Connector authority.
void readClassifiedPage(unscopedRead, page);
// @ts-expect-error Organization summaries require captured Connector authority.
void readOrganization(unscopedRead, organization);

import { manageOrganization } from "../src/mail-inbox/commands";
import { queueSelectedMail } from "../src/mail-inbox/connector-runtime";
declare const command: Parameters<typeof manageOrganization>[1];
// @ts-expect-error Mutation commands require the admitted Connector scope.
void manageOrganization(unscopedRead, command);
declare const selection: Parameters<typeof queueSelectedMail>[0];
const { scope: queueScope, ...unscopedQueue } = selection;
void queueScope;
// @ts-expect-error Queue preparation must retain authority through provider reads.
void queueSelectedMail({ ...unscopedQueue });

import { runMailOrganization } from "../src/mail-inbox/connector-runtime";
import { projectMailClassifications } from "../src/mail-inbox/store";
// @ts-expect-error Background work must retain the alarm admission scope.
void runMailOrganization(unscopedRead);
declare const projection: Parameters<typeof projectMailClassifications>[0];
const { scope: projectionScope, ...unscopedProjection } = projection;
void projectionScope;
// @ts-expect-error Projection writes require the captured placement fence.
void projectMailClassifications({ ...unscopedProjection });

import { runInboxResponses } from "../src/mail-inbox/actions";
declare const responseHead: Parameters<typeof runInboxResponses>[1];
// @ts-expect-error Reply preparation must retain the alarm admission scope.
void runInboxResponses(unscopedRead, responseHead);

import { admitEmailThreadCase } from "../src/actors/email-case-admission";
declare const admission: Parameters<typeof admitEmailThreadCase>[1];
declare const mailEnv: Parameters<typeof admitEmailThreadCase>[0];
const { scope: admissionScope, ...unscopedAdmission } = admission;
void admissionScope;
// @ts-expect-error Case admission cannot replace its originating placement scope.
void admitEmailThreadCase(mailEnv, unscopedAdmission);

import { runConnectorEmailEvaluation } from "../src/actors/connector-email-evaluation";
declare const cueEvaluation: Parameters<typeof runConnectorEmailEvaluation>[0];
const { scope: cueScope, ...unscopedCueEvaluation } = cueEvaluation;
void cueScope;
// @ts-expect-error Cue evaluation must retain its originating alarm scope.
void runConnectorEmailEvaluation(unscopedCueEvaluation);

import type { InboxResponseSettlement } from "../src/mail-inbox/response-store";
const invalidRetry: InboxResponseSettlement = {
  kind: "retry",
  // @ts-expect-error An admission retry has no settled reply outcome.
  outcome: "draft",
};
void invalidRetry;

import { createEmailProposalDraft } from "../src/actors/email-case-processing";
import { projectEmailReplyProposal } from "../src/data/email-mailbox";
declare const draftInput: Parameters<typeof createEmailProposalDraft>[1];
declare const draftProposal: Parameters<typeof createEmailProposalDraft>[2];
const { scope: draftScope, ...unscopedDraftInput } = draftInput;
void draftScope;
// @ts-expect-error Draft creation retains placement through provider effects and receipt release.
void createEmailProposalDraft(mailEnv, unscopedDraftInput, draftProposal, {
  kind: "mailbox",
});
declare const replyProjection: Parameters<typeof projectEmailReplyProposal>[0];
const { scope: replyScope, ...unscopedReplyProjection } = replyProjection;
void replyScope;
// @ts-expect-error Reply projections require a captured placement fence.
void projectEmailReplyProposal(unscopedReplyProjection);

import {
  previewEmailProposal,
  dispatchEmailReply,
  editEmailReplyBody,
  resolveEmailProposalState,
  disposeEmailProposal,
} from "../src/actors/connector-email-proposal";
declare const proposalReview: Parameters<typeof previewEmailProposal>[0];
const { scope: proposalScope, ...unscopedProposalReview } = proposalReview;
void proposalScope;
// @ts-expect-error Protected proposal previews retain captured placement.
void previewEmailProposal(unscopedProposalReview);
declare const proposalDispatch: Parameters<typeof dispatchEmailReply>[0];
const { scope: sendScope, ...unscopedProposalDispatch } = proposalDispatch;
void sendScope;
// @ts-expect-error Submission and receipt settlement require originating placement.
void dispatchEmailReply(unscopedProposalDispatch);
declare const proposalEdit: Parameters<typeof editEmailReplyBody>[0];
const { scope: editScope, ...unscopedProposalEdit } = proposalEdit;
void editScope;
// @ts-expect-error Body edits retain placement through provider verification.
void editEmailReplyBody(unscopedProposalEdit);
declare const proposalResolution: Parameters<
  typeof resolveEmailProposalState
>[0];
const { scope: resolutionScope, ...unscopedResolution } = proposalResolution;
void resolutionScope;
// @ts-expect-error Reconciliation cannot reacquire a different placement.
void resolveEmailProposalState(unscopedResolution);
// @ts-expect-error Draft cleanup requires originating placement.
void disposeEmailProposal(unscopedProposalReview);

import {
  establishConnectorEmailWatch,
  renewConnectorEmailWatch,
  stopConnectorEmailWatch,
} from "../src/actors/connector-email-evaluation";
declare const watchInput: Parameters<typeof establishConnectorEmailWatch>[0];
const { scope: watchScope, ...unscopedWatch } = watchInput;
void watchScope;
// @ts-expect-error Watch activation must retain the admitted Connector placement.
void establishConnectorEmailWatch(unscopedWatch);
// @ts-expect-error Watch renewal must retain the admitted Connector placement.
void renewConnectorEmailWatch(unscopedWatch);
// @ts-expect-error Watch cleanup must retain the admitted Connector placement.
void stopConnectorEmailWatch(unscopedWatch);

import {
  createOperationalEmailProposal,
  editOperationalEmailProposal,
  previewOperationalEmailProposal,
  dispatchOperationalEmail,
} from "../src/actors/connector-email-operational";
import { projectEmailOperationalProposal } from "../src/data/email-operational";
declare const operationalCreate: Parameters<
  typeof createOperationalEmailProposal
>[0];
const { scope: operationalScope, ...unscopedOperationalCreate } =
  operationalCreate;
void operationalScope;
// @ts-expect-error Compose cannot replace its originating placement.
void createOperationalEmailProposal(unscopedOperationalCreate);
const { execution: operationalExecution, ...unboundOperationalCreate } =
  operationalCreate;
void operationalExecution;
// @ts-expect-error Session compose requires its originating turn authority.
void createOperationalEmailProposal(unboundOperationalCreate);
import { registerEmailSelfTest } from "../src/data/email-self-test";
declare const selfTestRegistration: Parameters<typeof registerEmailSelfTest>[0];
const { scope: selfTestScope, ...unscopedSelfTest } = selfTestRegistration;
void selfTestScope;
// @ts-expect-error Self-test registration requires captured placement for every write.
void registerEmailSelfTest(unscopedSelfTest);
const { execution: selfTestExecution, ...unboundSelfTest } =
  selfTestRegistration;
void selfTestExecution;
// @ts-expect-error Self-test registration requires the originating Session authority.
void registerEmailSelfTest(unboundSelfTest);
declare const operationalEdit: Parameters<
  typeof editOperationalEmailProposal
>[0];
const { scope: operationalEditScope, ...unscopedOperationalEdit } =
  operationalEdit;
void operationalEditScope;
// @ts-expect-error Editing retains its admitted placement.
void editOperationalEmailProposal(unscopedOperationalEdit);
declare const operationalPreview: Parameters<
  typeof previewOperationalEmailProposal
>[0];
const { scope: previewScope, ...unscopedOperationalPreview } =
  operationalPreview;
void previewScope;
// @ts-expect-error Preview cannot release content without originating authority.
void previewOperationalEmailProposal(unscopedOperationalPreview);
const { sql: previewSql, ...unownedOperationalPreview } = operationalPreview;
void previewSql;
// @ts-expect-error Protected release checks its owning Connector export barrier.
void previewOperationalEmailProposal(unownedOperationalPreview);
declare const operationalDispatch: Parameters<
  typeof dispatchOperationalEmail
>[0];
const { scope: dispatchScope, ...unscopedOperationalDispatch } =
  operationalDispatch;
void dispatchScope;
// @ts-expect-error Submission must retain its placement through preflight and issue.
void dispatchOperationalEmail(unscopedOperationalDispatch);
declare const operationalProjection: Parameters<
  typeof projectEmailOperationalProposal
>[0];
const { scope: operationalProjectionScope, ...unscopedOperationalProjection } =
  operationalProjection;
void operationalProjectionScope;
// @ts-expect-error Operational metadata writes require atomic placement fencing.
void projectEmailOperationalProposal(unscopedOperationalProjection);

import { runMailAssistant } from "../src/mail-inbox/assistant";
declare const assistantContext: Parameters<typeof runMailAssistant>[0];
declare const assistant: Parameters<typeof runMailAssistant>[1];
const { controlSessionId: assistantOrigin, ...withoutAssistantOrigin } =
  assistant;
void assistantOrigin;
// @ts-expect-error Inbox assistance must retain the originating Portal session.
void runMailAssistant(assistantContext, { ...withoutAssistantOrigin });
void runMailAssistant(assistantContext, {
  ...assistant,
  // @ts-expect-error An unparsed string cannot become the session origin.
  controlSessionId: "unknown",
});
