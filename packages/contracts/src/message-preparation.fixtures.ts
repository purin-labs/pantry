import type {
  AttachmentId,
  MessageAttachmentPreparationIdentity,
  MessageAttachmentPreparationLimits,
  MessageAttachmentPreparationReceipt,
  MessageAttachmentPreparationState,
  OrganisationAttachmentObjectKey,
} from "./index.ts";
import type { MessageAttachmentPreparationUsage } from "./attachment-preparation.ts";

const identity = {
  organisationId: "organisation_1",
  sessionId: "session_1",
  turnId: "turn_1",
  attachmentId: "att_1" as AttachmentId,
  sourceSha256: "a".repeat(64),
  handlerRevision: "message-preparation.v1",
} satisfies MessageAttachmentPreparationIdentity;

const limits = {
  maxInputBytes: 1024,
  maxOutputBytes: 2048,
  maxDurationMs: 3000,
  maxFrames: 12,
} satisfies MessageAttachmentPreparationLimits;

const usage = {
  activeWallMs: 10,
  inputBytes: 100,
  outputBytes: 200,
} satisfies MessageAttachmentPreparationUsage;

const receipt = {
  identity,
  limits,
  resultDigest: "b".repeat(64),
  derivedObjectKeys: [
    "attachments/organisation_1/derived/result.json" as OrganisationAttachmentObjectKey,
  ],
  usage,
  completedAt: 20,
  outcome: {
    kind: "prepared",
    resultObjectKey:
      "attachments/organisation_1/derived/result.json" as OrganisationAttachmentObjectKey,
  },
} satisfies MessageAttachmentPreparationReceipt;

const pendingState = {
  kind: "pending",
  identity,
  limits,
  startedAt: 10,
  deadlineAt: 100,
} satisfies MessageAttachmentPreparationState;

const completedState = {
  kind: "completed",
  receipt,
} satisfies MessageAttachmentPreparationState;

const pendingWithReceipt = {
  ...pendingState,
  receipt: completedState.receipt,
};

// @ts-expect-error Pending preparation cannot acquire completed receipt fields through a spread.
const invalidPendingWithReceipt: MessageAttachmentPreparationState =
  pendingWithReceipt;

const completedWithIdentity = {
  ...completedState,
  identity: pendingState.identity,
};

// @ts-expect-error Completed preparation cannot retain pending identity fields through a spread.
const invalidCompletedWithIdentity: MessageAttachmentPreparationState =
  completedWithIdentity;

void invalidPendingWithReceipt;
void invalidCompletedWithIdentity;
