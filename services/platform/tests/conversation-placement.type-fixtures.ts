import { createPortalChatStreamResponse } from "../src/chat/portal-stream";
import type { AdmittedConversationExecution } from "../src/chat/application";
import {
  saveConversation,
  reconcileRevokedConversationRun,
} from "@purin-labs/conversation/chat/store";
import type { Conversation } from "@purin-labs/conversation/chat/conversation";
import type { ConversationScope } from "@purin-labs/conversation/chat/store";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

declare const identity: ConversationScope;
declare const placement: OrganisationExecutionScope;
declare const conversation: Conversation;
declare const unscopedExecution: Omit<
  AdmittedConversationExecution,
  "placement"
>;

// @ts-expect-error Identity alone cannot authorize a conversation save.
saveConversation(identity, identity.userId, conversation, 1);
saveConversation(
  // @ts-expect-error Spreading placement loses its private execution authority.
  { ...placement },
  identity.userId,
  conversation,
  1,
);
// @ts-expect-error Background work must retain its captured placement.
const missingPlacement: AdmittedConversationExecution = unscopedExecution;
void missingPlacement;

// @ts-expect-error Revocation settlement needs captured placement authority.
reconcileRevokedConversationRun(identity, identity.userId, conversation.id);
reconcileRevokedConversationRun(
  // @ts-expect-error A copy cannot retain private execution authority.
  { ...placement },
  identity.userId,
  conversation.id,
);

declare const unscopedStream: Omit<
  Parameters<typeof createPortalChatStreamResponse>[0],
  "placement"
>;
declare const streamExecution: Parameters<
  typeof createPortalChatStreamResponse
>[1];
// @ts-expect-error A stream must retain placement throughout polling.
createPortalChatStreamResponse(unscopedStream, streamExecution);
