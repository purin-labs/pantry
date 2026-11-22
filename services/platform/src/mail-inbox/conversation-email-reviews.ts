import type { Conversation } from "@purin-labs/conversation/chat/conversation";
import { conversationCaseIdentity } from "@purin-labs/conversation/chat/conversation-access";
import type { ConversationScope } from "@purin-labs/conversation/chat/store";
import { deriveDirectCaseIdentities } from "@purin-labs/conversation/actors/case-direct-processing";
import { emailReviewQueueWire } from "../control/email-review";
import { listEmailReviewProjectionsForCase } from "../data/email-review";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

const CONVERSATION_EMAIL_REVIEW_LIMIT = 20;

/** The email reviews of the Case of one chat, for the chat reader. */
export async function readConversationEmailReviews(
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  conversation: Conversation,
): Promise<
  | { readonly ok: true; readonly value: readonly Record<string, unknown>[] }
  | { readonly ok: false }
> {
  const identities = await deriveDirectCaseIdentities(
    await conversationCaseIdentity(placement.database, scope, conversation.id),
  );
  if (!identities.ok) return { ok: false };
  const reviews = await listEmailReviewProjectionsForCase({
    db: placement.database,
    organisationId: scope.organisationId,
    caseId: identities.value.caseId,
    limit: CONVERSATION_EMAIL_REVIEW_LIMIT,
  });
  return { ok: true, value: reviews.map(emailReviewQueueWire) };
}
