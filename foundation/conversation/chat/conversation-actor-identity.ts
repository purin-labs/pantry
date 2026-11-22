import type { ConversationId } from "@purin-labs/control-api";
import { isNonEmptyString } from "@purin-labs/std";
import { deriveStableCaseId } from "@purin-labs/kernel/case-identity";
import type { CaseId } from "@purin-labs/kernel/ids";
import type { ConversationScope } from "./store";

// Persist this address once so representation changes preserve durable history.
export function initialConversationCaseIdentity(
  scope: ConversationScope,
  conversationId: ConversationId,
): string {
  return `${scope.organisationId}:portal-chat:${scope.userId}:${conversationId}`;
}

export function parseConversationActorIdentity(
  raw: unknown,
  organisationId: ConversationScope["organisationId"],
): string {
  if (
    !isNonEmptyString(raw) ||
    !raw.startsWith(`${organisationId}:portal-chat:`)
  )
    throw new Error("chat_actor_identity_storage_invalid");
  return raw;
}

// A chat presents one Case, named by its persisted address.
export async function conversationCaseId(
  actorIdentity: string,
): Promise<CaseId> {
  const stable = await deriveStableCaseId(actorIdentity);
  if (stable === null) throw new Error("chat_actor_identity_storage_invalid");
  return stable.caseId;
}
