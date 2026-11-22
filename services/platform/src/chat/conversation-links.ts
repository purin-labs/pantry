import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { listDerivedChats } from "./forks";
import type { Env } from "@purin-labs/kernel/env";
import { buildControlAuthority } from "../request-authority";
import type { AuthorizedOrganisationRequest } from "../control/authorization";
import {
  listConversationDirectory,
  type StoredConversation,
  type ConversationScope,
} from "./store";
import { listConversationSideCases, readSideCaseSource } from "./side-cases";

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
