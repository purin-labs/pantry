import type { ConversationId } from "@purin-labs/control-api";
declare const fixtureConversation: ConversationId;
import type { ChatThreadLineage } from "@purin-labs/control-api";
import type { ChatForkResult } from "../src/chat/forks";

// @ts-expect-error A fork requires its exact source, cutoff, and receipt.
const missingCutoff: ChatThreadLineage = { kind: "fork" };

const parentFields = { sourceConversationId: fixtureConversation };
// @ts-expect-error Spreading parent fields cannot turn an original into a fork.
const originalWithParent: ChatThreadLineage = {
  kind: "original",
  ...parentFields,
};

// @ts-expect-error A ready fork requires its accepted history digest.
const missingDigest: ChatForkResult = {
  kind: "ready",
  conversationId: fixtureConversation,
  operationId: "create",
};

// @ts-expect-error A failed fork cannot carry a success digest.
const contradictoryResult: ChatForkResult = {
  kind: "failed",
  conversationId: fixtureConversation,
  operationId: "create",
  code: "chat_fork_history_unavailable",
  digest: "digest",
};

void [missingCutoff, originalWithParent, missingDigest, contradictoryResult];
