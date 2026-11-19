import type { ConversationId } from "@purin-labs/control-api";
declare const fixtureConversation: ConversationId;
import type {
  ChatMessage,
  ChatCommand,
  Conversation,
  ConversationWork,
  ConnectorCardTarget,
} from "../src/chat/conversation";
import type { SessionId } from "../src/ids";

declare const sessionId: SessionId;
declare const conversation: Conversation;

const duplicateTranscript: Conversation = {
  ...conversation,
  // @ts-expect-error Public message projections are derived from the timeline.
  messages: [],
};
// @ts-expect-error Failure construction explicitly chooses whether an accepted result needs recovery.
const ambiguousFailure: ConversationWork = {
  kind: "failed",
  requestId: "request_test",
  error: "Interrupted",
};
void [duplicateTranscript, ambiguousFailure];

// @ts-expect-error Canonical conversations always carry queue, cursor, draft, and effort state.
const partialConversation: Conversation = {
  id: fixtureConversation,
  title: "Test",
  modelRoute: {
    keySource: "platform",
    provider: "openai-compatible",
    model: "test",
  },
  documents: [],
  work: { kind: "ready" },
  completedRequests: [],
};

const running: ConversationWork = {
  kind: "running",
  requestId: "request_test",
  lease: "lease_test",
  expiresAt: 100,
  stream: { step: 0, sessionId, turnId: "turn_test" },
};
const cancelling: ConversationWork = {
  kind: "cancelling",
  requestId: "request_test",
  cancellationId: "cancellation_test",
  lease: "lease_test",
  expiresAt: 100,
  stream: { step: 0, sessionId, turnId: "turn_test" },
};
// @ts-expect-error Running work always identifies the exact replay stream.
const runningWithoutStream: ConversationWork = {
  kind: "running",
  requestId: "request_test",
  lease: "lease_test",
  expiresAt: 100,
};
// @ts-expect-error A ready conversation cannot retain a running lease.
const readyWithLease: ConversationWork = { kind: "ready", lease: "lease_test" };
// @ts-expect-error Spreading a running turn cannot make it ready.
const readyFromRunning: ConversationWork = { ...running, kind: "ready" };
// @ts-expect-error A failed turn always identifies the request being retried.
const failureWithoutRequest: ConversationWork = {
  kind: "failed",
  error: "Interrupted",
};
// @ts-expect-error Cancelling work always identifies the exact cancellation.
const cancellingWithoutIdentity: ConversationWork = {
  kind: "cancelling",
  requestId: "request_test",
  lease: "lease_test",
  expiresAt: 100,
  stream: { step: 0, sessionId, turnId: "turn_test" },
};
// @ts-expect-error New connector cards cannot target an existing revision.
const newWithRevision: ConnectorCardTarget = {
  kind: "new",
  expectedHeadRevision: 1,
};
// @ts-expect-error Text messages cannot smuggle a connector definition.
const textWithDocument: ChatMessage = {
  kind: "assistant",
  id: "message_test",
  text: "Ready",
  document: {},
};
void [
  readyWithLease,
  runningWithoutStream,
  readyFromRunning,
  failureWithoutRequest,
  cancelling,
  cancellingWithoutIdentity,
  newWithRevision,
  textWithDocument,
  partialConversation,
];

import type { DirectCasePathResult } from "../src/actors/case-walking-path";
declare const completion: Variant<DirectCasePathResult, "completed">;
const missingFlow: Variant<DirectCasePathResult, "completed"> = {
  ...completion,
  // @ts-expect-error A completed conversation step must retain its cumulative flow receipt.
  completion: { finalMessage: "reply" },
};
void missingFlow;

import type { ChatModelAction } from "../src/chat/conversation";
import type { Variant } from "@purin-labs/type-utils";
declare const questionAction: Variant<ChatModelAction, "question">;
// @ts-expect-error Question actions cannot carry an alternative plain-text reply through a spread.
const questionWithReply: ChatModelAction = { ...questionAction, text: "Reply" };
// @ts-expect-error A question action requires a validated question payload.
const questionWithoutPayload: ChatModelAction = { kind: "question" };
void [questionWithReply, questionWithoutPayload];

declare const attachmentCommand: Extract<ChatCommand, { kind: "message" }>;
declare const retryCommand: Extract<ChatCommand, { kind: "retry" }>;
const { attachments, ...commandWithoutAttachments } = attachmentCommand;
// @ts-expect-error Authored commands explicitly choose their retained attachments.
const absentAttachments: ChatCommand = commandWithoutAttachments;
// @ts-expect-error Retry inherits its accepted content and cannot replace attachment identity.
const replacedRetryAttachments: ChatCommand = { ...retryCommand, attachments };
void [absentAttachments, replacedRetryAttachments];

// @ts-expect-error Interrupted recovery requires the original stream identity.
const interruptedWithoutStream: NonNullable<
  Extract<ConversationWork, { kind: "failed" }>["recovery"]
> = { kind: "interrupted", lease: "lease_test" };
void interruptedWithoutStream;

const interruptedFields: { kind: "interrupted"; lease: string } = {
  kind: "interrupted",
  lease: "lease_test",
};
// @ts-expect-error Broad spreads cannot omit interrupted stream evidence.
const spreadInterrupted: NonNullable<
  Extract<ConversationWork, { kind: "failed" }>["recovery"]
> = { ...interruptedFields };
void spreadInterrupted;
