import type { UserId } from "@purin-labs/control-api/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { ConversationId } from "@purin-labs/control-api";
import type { Env } from "@purin-labs/kernel/env";
import { resolveActiveSessionActorAtPlacement } from "../../actors/actor-router";
import {
  conversationTimeline,
  normalizeConversationTimeline,
  type Conversation,
} from "../conversation";
import {
  readConversation,
  saveConversation,
  type ConversationScope,
  type StoredConversation,
} from "../store";
import { assertNever } from "@purin-labs/std";
import { nextTimelineSequence } from "./timeline";
import type { Variant } from "@purin-labs/type-utils";

export async function reconcileFailedConversationTurn(
  env: Env,
  placement: OrganisationExecutionScope,
  userId: UserId,
  stored: StoredConversation,
): Promise<StoredConversation | null> {
  const scope: ConversationScope = {
    organisationId: placement.organisationId,
    userId,
  };
  const work = stored.conversation.work;
  if (work.kind !== "running") return stored;
  try {
    const actor = await resolveActiveSessionActorAtPlacement({
      placement: placement.placement,
      env: env,
      namespace: env.SESSION,
      organisationId: scope.organisationId,
      sessionId: work.stream.sessionId,
      now: Date.now(),
    });
    if (!actor.ok) return stored;
    const turn = await actor.value.inspectTurnStream({
      organisationId: scope.organisationId,
      turnId: work.stream.turnId,
    });
    if (
      !turn.ok ||
      turn.value.kind !== "present" ||
      turn.value.state !== "failed"
    )
      return stored;
  } catch {
    // Transport failure does not establish the canonical turn outcome.
    return stored;
  }
  const conversation = failedConversation(
    stored.conversation,
    work.requestId,
    "The response was interrupted. Retry to continue.",
  );
  // Fence the inspected step: a newer step can share the same request and lease.
  if (
    (
      await saveConversation(
        placement,
        scope.userId,
        conversation,
        stored.revision,
      )
    ).kind === "saved"
  )
    return {
      conversation,
      actorIdentity: stored.actorIdentity,
      sharing: stored.sharing,
      metadata: stored.metadata,
      placement: stored.placement,
      inheritsProject: stored.inheritsProject,
      revision: stored.revision + 1,
    };
  return readConversation(placement.database, scope, stored.conversation.id);
}

export function failedConversation(
  conversation: Conversation,
  requestId: string,
  message: string,
): Conversation {
  const timeline = conversationTimeline(conversation);
  const failureId = `failure_${requestId}_${nextTimelineSequence(timeline)}`;
  return normalizeConversationTimeline({
    ...conversation,
    work: {
      kind: "failed",
      requestId,
      error: message,
      recovery: interruptedConversationRecovery(conversation.work, requestId),
    },
    timeline: [
      ...timeline,
      {
        kind: "run_failed",
        eventId: failureId,
        sequence: nextTimelineSequence(timeline),
        requestId,
        createdAt: Date.now(),
        text: message,
      },
    ],
  });
}

function interruptedConversationRecovery(
  work: Conversation["work"],
  requestId: string,
): Variant<Conversation["work"], "failed">["recovery"] {
  if (work.kind === "ready" || work.requestId !== requestId) return null;
  switch (work.kind) {
    case "running":
    case "cancelling":
      return { kind: "interrupted", lease: work.lease, stream: work.stream };
    case "failed":
      return work.recovery;
    case "awaiting_permission":
      return null;
    default:
      return assertNever(work);
  }
}

export async function settleConversationFailure(input: {
  readonly placement: OrganisationExecutionScope;
  readonly env: Env;
  readonly scope: ConversationScope;
  readonly conversationId: ConversationId;
  readonly requestId: string;
  readonly lease: string;
  readonly message: string;
}): Promise<Conversation | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const latest = await readConversation(
      input.placement.database,
      input.scope,
      input.conversationId,
    );
    if (latest === null) return null;
    if (
      latest.conversation.work.kind === "failed" &&
      latest.conversation.work.requestId === input.requestId
    )
      return latest.conversation;
    const active = latest.conversation.work;
    if (
      active.kind !== "running" ||
      active.requestId !== input.requestId ||
      active.lease !== input.lease
    )
      return null;
    const failed = failedConversation(
      latest.conversation,
      input.requestId,
      input.message,
    );
    if (
      (
        await saveConversation(
          input.placement,
          input.scope.userId,
          failed,
          latest.revision,
        )
      ).kind === "saved"
    )
      return failed;
  }
  return null;
}

export async function interruptConversation(
  env: Env,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  conversationId: ConversationId,
  requestId: string,
  lease: string,
): Promise<void> {
  await settleConversationFailure({
    env,
    placement,
    scope,
    conversationId,
    requestId,
    lease,
    message:
      "Your access changed while the AI was working. Sign in with workspace admin access, then retry.",
  });
}
