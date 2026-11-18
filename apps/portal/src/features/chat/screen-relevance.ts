import React from "react";
import {
  parseScreenRelevanceView,
  screenRelevanceObservation,
  SCREEN_RELEVANCE_MAX_DRAFT,
  SCREEN_RELEVANCE_MIN_DRAFT,
  SCREEN_RELEVANCE_PAUSE_MS,
  type ScreenRelevanceChoice,
  type ScreenRelevanceView,
} from "@seams/control-api";
import { controlMutation } from "../../control-client";
import { captureSurfaceObservation } from "../surface-observation";

// The chat routes, without an import of `./api`, which imports this module.
function chatPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/chat`;
}

/**
 * The Jev relevance suggestion of the composer (Plan 87 section 3A). While
 * the chip is off, a pause in the typing asks if the draft is about the page
 * on screen. The answer only suggests: a hint tags the chip, and a question
 * on send offers the page. Only the person's click attaches it.
 */
export type ScreenSuggestion = Readonly<{
  organisationId: string;
  conversationId: string;
  surfaceSessionId: string;
  /** The trimmed draft that Jev checked. */
  draft: string;
  view: Extract<ScreenRelevanceView, { kind: "quiet" | "hint" | "ask" }>;
  /** The question showed for this draft; Enter again sends without. */
  asked: boolean;
}>;

let suggestion: ScreenSuggestion | null = null;
const listeners = new Set<() => void>();

function publish(next: ScreenSuggestion | null): void {
  suggestion = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return unsubscribe.bind(null, listener);
}

function unsubscribe(listener: () => void): void {
  listeners.delete(listener);
}

function readSuggestion(): ScreenSuggestion | null {
  return suggestion;
}

export function useScreenSuggestion(): ScreenSuggestion | null {
  return React.useSyncExternalStore(subscribe, readSuggestion);
}

export type ScreenCheckTarget = Readonly<{
  organisationId: string;
  conversationId: string | null;
  surfaceSessionId: string | null;
  draft: string;
  /** The chip is off, and the chat's readers may receive the page. */
  eligible: boolean;
}>;

/**
 * Runs the check after a pause of 500 ms, one at a time: a new pause cancels
 * the check before it. A send never waits for it.
 */
export function useScreenRelevanceCheck(target: ScreenCheckTarget): void {
  const draft = target.draft.trim();
  React.useEffect(scheduleCheck.bind(null, { ...target, draft }), [
    target.organisationId,
    target.conversationId,
    target.surfaceSessionId,
    draft,
    target.eligible,
  ]);
}

function scheduleCheck(target: ScreenCheckTarget): () => void {
  const controller = new AbortController();
  if (
    !target.eligible ||
    target.conversationId === null ||
    target.surfaceSessionId === null ||
    target.draft.length < SCREEN_RELEVANCE_MIN_DRAFT ||
    target.draft.length > SCREEN_RELEVANCE_MAX_DRAFT ||
    (suggestion !== null &&
      suggestion.conversationId === target.conversationId &&
      suggestion.surfaceSessionId === target.surfaceSessionId &&
      suggestion.draft === target.draft)
  )
    return controller.abort.bind(controller);
  const timer = window.setTimeout(
    runCheck.bind(null, target, controller.signal),
    SCREEN_RELEVANCE_PAUSE_MS,
  );
  return cancelCheck.bind(null, timer, controller);
}

function cancelCheck(timer: number, controller: AbortController): void {
  window.clearTimeout(timer);
  controller.abort();
}

async function runCheck(
  target: ScreenCheckTarget,
  signal: AbortSignal,
): Promise<void> {
  const conversationId = target.conversationId;
  if (conversationId === null) return;
  const observation = captureSurfaceObservation(target.organisationId);
  if (
    observation === null ||
    observation.instance?.surfaceSessionId !== target.surfaceSessionId
  )
    return;
  let raw: unknown;
  try {
    raw = await controlMutation(
      `${chatPath(target.organisationId)}/conversations/${encodeURIComponent(conversationId)}/screen-relevance`,
      "POST",
      {
        draft: target.draft,
        // Jev reads the section titles only; the facts and rows stay here.
        observation: screenRelevanceObservation(observation),
      },
      undefined,
      { kind: "prepared", idempotencyKey: `portal-${crypto.randomUUID()}` },
      signal,
    );
  } catch {
    // A failed check leaves the attach rule alone.
    return;
  }
  if (signal.aborted) return;
  const view = parseScreenRelevanceView(raw);
  if (view === null || view.kind === "refused" || view.kind === "unavailable") {
    publish(null);
    return;
  }
  publish({
    organisationId: target.organisationId,
    conversationId,
    surfaceSessionId: observation.instance.surfaceSessionId,
    draft: target.draft,
    view,
    asked: false,
  });
}

/** The suggestion for this chat, page and draft, or null. */
export function currentSuggestion(
  conversationId: string | null,
  surfaceSessionId: string | null,
  draft: string | null,
): ScreenSuggestion | null {
  const current = suggestion;
  if (
    current === null ||
    current.conversationId !== conversationId ||
    current.surfaceSessionId !== surfaceSessionId ||
    (draft !== null && current.draft !== draft.trim())
  )
    return null;
  return current;
}

/**
 * Called on send with the chip off. When Jev asked for this exact draft and
 * the question has not shown yet, it shows the question and holds the send.
 * The second send of the same draft goes without the page.
 */
export function holdForScreenQuestion(
  conversationId: string | null,
  surfaceSessionId: string | null,
  draft: string,
): boolean {
  const current = currentSuggestion(conversationId, surfaceSessionId, draft);
  if (current === null || current.view.kind !== "ask" || current.asked)
    return false;
  publish({ ...current, asked: true });
  return true;
}

/**
 * A send ends the suggestion. A hint or a question that the person saw
 * records what they did: the page went with the message, or it did not.
 */
export function settleScreenSuggestion(
  conversationId: string,
  attached: boolean,
): void {
  const current = suggestion;
  if (current === null || current.conversationId !== conversationId) return;
  publish(null);
  if (current.view.kind === "quiet") return;
  recordChoice(current, attached ? "attached" : "sent_without");
}

/** "New chat from this page": the draft leaves this chat. */
export function moveSuggestionToNewChat(): void {
  const current = suggestion;
  if (current === null) return;
  publish(null);
  recordChoice(current, "new_chat");
}

function recordChoice(
  current: ScreenSuggestion,
  choice: ScreenRelevanceChoice,
): void {
  const checkId = current.view.checkId;
  if (checkId === null) return;
  void controlMutation(
    `${chatPath(current.organisationId)}/conversations/${encodeURIComponent(current.conversationId)}/screen-relevance/${checkId}/choice`,
    "POST",
    { choice },
    undefined,
    { kind: "prepared", idempotencyKey: `portal-${crypto.randomUUID()}` },
  ).catch(ignoreRecordFailure);
}

// The record tunes the bands; a lost record changes nothing for the person.
function ignoreRecordFailure(): void {
  return;
}
