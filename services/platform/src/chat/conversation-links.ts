import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { conversationCaseIdentity } from "./conversation-access";
import { listDerivedChats } from "./forks";
import type { Env } from "../env";
import { deriveDirectCaseIdentities } from "../actors/case-direct-processing";
import { buildControlAuthority } from "../request-authority";
import type { AuthorizedOrganisationRequest } from "../control/authorization";
import type { Conversation } from "./conversation";
import {
  listConversationDirectory,
  type StoredConversation,
  type ConversationScope,
} from "./store";
import { listEmailReviewProjectionsForCase } from "../data/email-review";
import { emailReviewQueueWire } from "../control/email-review";
import { listConversationSideCases, readSideCaseSource } from "./side-cases";

export const CONVERSATION_EMAIL_REVIEW_LIMIT = 20;

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

export function unreadConversationCount(
  directory: Awaited<ReturnType<typeof listConversationDirectory>>,
): number {
  let count = 0;
  for (const conversation of directory.active) {
    if (conversation.latestSequence > conversation.lastReadSequence) count += 1;
  }
  return count;
}

/** The forks, the side Cases and the source of one chat, for its reader. */
export async function readConversationLinks(
  env: Env,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  authorized: AuthorizedOrganisationRequest,
  stored: StoredConversation | null,
  readActiveRevision: Promise<number | null>,
) {
  if (stored === null) return [[], [], null] as const;
  const activeRevision = await readActiveRevision;
  const readerAuthority =
    activeRevision === null
      ? null
      : buildControlAuthority({
          organisationId: scope.organisationId,
          requesterPersonId: authorized.membership.personId,
          userId: scope.userId,
          membershipRevision: activeRevision,
          role: authorized.membership.role,
        }).requestAuthority;
  return Promise.all([
    readerAuthority === null
      ? []
      : listDerivedChats(
          env,
          placement,
          scope,
          stored.conversation.id,
          readerAuthority,
        ),
    readerAuthority === null
      ? []
      : listConversationSideCases(
          placement,
          stored.conversation.id,
          {
            authority: readerAuthority,
            mayDecide:
              stored.sharing.visibility === "private" ||
              stored.sharing.role !== "viewer",
          },
          Date.now(),
        ),
    readSideCaseSource(placement, scope, stored.conversation),
  ]);
}
