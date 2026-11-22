import {
  CHAT_SIGNAL,
  type ChatSignal,
  type ConversationId,
  type UserId,
} from "@purin-labs/control-api";
import { errorMessage } from "@purin-labs/std";
import { waitUntil } from "cloudflare:workers";

import { actorPhysicalName } from "../actors/actor-registry";
import { actorStub } from "../actors/actor-stubs";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

/**
 * Whom a chat signal reaches. The Organisation Actor sends a conversation's
 * signal only to the users who may see that conversation, a user's signal
 * only to that user, and an Organisation's signal to every open chat page of
 * the Organisation. A signal carries no content, so a page that gets one
 * reads through the checked chat routes.
 */
export type ChatSignalTarget =
  | Readonly<{
      kind: "conversation";
      conversationId: ConversationId;
      userId?: never;
    }>
  | Readonly<{ kind: "user"; userId: UserId; conversationId?: never }>
  | Readonly<{ kind: "organisation"; conversationId?: never; userId?: never }>;

/**
 * Tells the open chat pages that a committed write changed what they show.
 * Call it after the write commits. The signal leaves in the background: the
 * writer does not wait for it, and a lost signal costs only a later read,
 * because a page reads everything again when its socket reconnects and reads
 * now and then while it stays connected.
 */
export function signalChat(
  scope: OrganisationExecutionScope,
  target: ChatSignalTarget,
  kind: ChatSignal["kind"] = CHAT_SIGNAL,
): void {
  const actors = scope.organisationActors;
  if (actors === null) return;
  waitUntil(sendSignal(actors, scope, target, kind));
}

async function sendSignal(
  actors: NonNullable<OrganisationExecutionScope["organisationActors"]>,
  scope: OrganisationExecutionScope,
  target: ChatSignalTarget,
  kind: ChatSignal["kind"],
): Promise<void> {
  try {
    // An Actor that holds chat sockets is active at the scope's placement,
    // so its stub needs no registry reservation. An Actor that holds none
    // drops the signal.
    const organisation = actorStub(
      actors,
      actorPhysicalName(
        {
          objectKind: "organisation",
          organisationId: scope.organisationId,
          logicalObjectId: scope.organisationId,
        },
        scope.placement,
      ),
      scope.placement,
    );
    await organisation.signalChat({
      organisationId: scope.organisationId,
      target,
      kind,
    });
  } catch (error) {
    traceWarn("chat.signal_failed", {
      requestId: newRequestId(),
      organisation_id: scope.organisationId,
      target: target.kind,
      detail: errorMessage(error),
    });
  }
}
