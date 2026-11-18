import type { RequestAuthority } from "@seams/contracts";
import type {
  ChatOrigin,
  ScreenRelevanceRequest,
  ScreenRelevanceView,
} from "@seams/control-api";
import { surfaceAreaTitle } from "@seams/control-api";
import { bytesToHex } from "@seams/std";
import type { Variant } from "@seams/type-utils";
import { requireActiveOrganisationActorAtScope } from "../actors/actor-router";
import type { Env } from "../env";
import type { ScreenRelevanceState } from "../jev-features/screen-relevance-jev";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { createCurrentSourceFlowLabel } from "../policy/information-flow/source-labels";
import type { Result } from "../result";
import { timelineVisibleMessages, type Conversation } from "./conversation";
import type { AuthorizedConversation } from "./conversation-access";
import { checkConversationDisclosure } from "./conversation-disclosure";
import { conversationOrigin } from "./origin";
import { admitScreenObservation } from "./screen-observation-admission";
import type { ConversationScope, StoredConversation } from "./store";

/** The last answer of the chat that Jev reads, in characters. */
const LAST_ANSWER_CHARACTERS = 1_000;

export type ScreenRelevanceError = Readonly<{
  code: "screen_relevance_label_unavailable";
}>;

/**
 * The Jev relevance check of the composer (Plan 87 section 3A). The audience
 * rule of section 4 runs first: a page that the chat's readers may not
 * receive sends no request to Jev. The Organisation Actor then checks the
 * Screen relevance switch and the TypeSafe authority, reserves the budget,
 * calls Jev and records a hint or a question. Jev only suggests a page.
 */
export async function checkScreenRelevance(
  env: Env,
  input: Readonly<{
    placement: OrganisationExecutionScope;
    scope: ConversationScope;
    authority: Variant<RequestAuthority, "control">;
    access: AuthorizedConversation;
    stored: StoredConversation;
    request: ScreenRelevanceRequest;
  }>,
): Promise<Result<ScreenRelevanceView, ScreenRelevanceError>> {
  if (input.access.access.kind === "workspace_canvas") return refused("canvas");
  const admission = admitScreenObservation(
    input.stored.sharing.visibility === "private"
      ? { kind: "private" }
      : { kind: "shared" },
    input.request.observation,
  );
  if (admission.kind === "withheld") return refused(admission.reason);
  const conversation = input.stored.conversation;
  // Jev reads the last answer, so the sender must be a reader of the chat's
  // history, as when they open it.
  const disclosure = await checkConversationDisclosure(
    env,
    input.placement,
    input.scope,
    conversation,
    [input.scope.userId],
    "viewing",
  );
  if (disclosure.kind === "rejected")
    return refused("chat_history_unavailable");
  // The draft, the page and the answer are what the sender typed, saw and
  // may read, so each one carries the sender's own label.
  const label = await createCurrentSourceFlowLabel({
    kind: "ingress",
    db: input.placement.database,
    authority: input.authority,
  });
  if (!label.ok)
    return { ok: false, error: { code: "screen_relevance_label_unavailable" } };
  const observation = input.request.observation;
  const organisation = await requireActiveOrganisationActorAtScope({
    env,
    scope: input.placement,
    now: Date.now(),
  });
  const checked = await organisation.checkScreenRelevance({
    organisationId: input.scope.organisationId,
    checkId: newCheckId(),
    userId: input.scope.userId,
    conversationId: conversation.id,
    surface: observation.surface,
    authority: input.authority,
    state: relevanceState(conversation, input.request),
    label: label.value.toJSON(),
  });
  if (!checked.ok) return { ok: true, value: { kind: "unavailable" } };
  return { ok: true, value: checked.value };
}

function relevanceState(
  conversation: Conversation,
  request: ScreenRelevanceRequest,
): ScreenRelevanceState {
  const observation = request.observation;
  return {
    draft: request.draft,
    chatOrigin: originLabel(conversationOrigin(conversation)),
    lastAnswer: lastAnswer(conversation),
    page: {
      title: observation.title,
      area: surfaceAreaTitle(observation.area),
      record: observation.record?.label ?? null,
      // Section titles only: no table row and no fact value.
      sections: observation.view.map(sectionTitle),
    },
  };
}

function sectionTitle(section: Readonly<{ title: string }>): string {
  return section.title;
}

function originLabel(origin: ChatOrigin | null): string | null {
  if (origin === null) return null;
  const page = `${surfaceAreaTitle(origin.area)} › ${origin.title}`;
  return origin.record === null ? page : `${page} › ${origin.record.label}`;
}

function lastAnswer(conversation: Conversation): string | null {
  const messages = timelineVisibleMessages(conversation);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === "assistant" && message.text.trim().length > 0)
      return message.text.slice(0, LAST_ANSWER_CHARACTERS);
  }
  return null;
}

function newCheckId(): string {
  return `src_${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

function refused(
  reason: Extract<ScreenRelevanceView, { kind: "refused" }>["reason"],
): Result<ScreenRelevanceView, never> {
  return { ok: true, value: { kind: "refused", reason } };
}

/** The person's choice for a hint or a question that they saw. */
export async function recordScreenRelevanceChoice(
  env: Env,
  input: Readonly<{
    placement: OrganisationExecutionScope;
    scope: ConversationScope;
    checkId: string;
    choice: import("@seams/control-api").ScreenRelevanceChoice;
  }>,
): Promise<
  Result<null, Readonly<{ code: "screen_relevance_check_not_found" }>>
> {
  const organisation = await requireActiveOrganisationActorAtScope({
    env,
    scope: input.placement,
    now: Date.now(),
  });
  const decided = await organisation.decideScreenRelevance({
    organisationId: input.scope.organisationId,
    checkId: input.checkId,
    userId: input.scope.userId,
    choice: input.choice,
  });
  return decided.ok
    ? { ok: true, value: null }
    : { ok: false, error: { code: "screen_relevance_check_not_found" } };
}
