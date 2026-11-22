import React from "react";
import { Plus, X } from "lucide-react";
import type { Chat } from "@purin-labs/control-api/portal/chat";
import { sharedChatMayCarry } from "@purin-labs/control-api";
import {
  surfaceOnScreenView,
  useSurfaceOnScreenView,
  type SurfaceOnScreenView,
} from "@purin-labs/ui/features/surface-observation";
import {
  currentSuggestion,
  holdForScreenQuestion,
  moveSuggestionToNewChat,
  useScreenRelevanceCheck,
  useScreenSuggestion,
} from "./screen-relevance";
import "./screen-chip.css";

/**
 * The composer chip for the page on screen (Plan 87). A message carries the
 * page only when the chip is on. The chip is on by default on the page where
 * the chat started, and off on any other page, so a click elsewhere in the
 * Portal never sends a page by accident. The first message of a new chat
 * carries the page and sets the chat's origin.
 */
type ChipChat = Readonly<{
  conversationId: string | null;
  started: boolean;
  originPage: string | null;
  shared: boolean;
}>;

type ChipChoice = Readonly<{
  conversationId: string | null;
  surfaceSessionId: string;
  attach: boolean;
}>;

let openChat: ChipChat | null = null;
let choice: ChipChoice | null = null;
const listeners = new Set<() => void>();

function chipChat(chat: Chat | null): ChipChat {
  return {
    conversationId: chat?.id ?? null,
    started: chat?.messages.some(isUserMessage) ?? false,
    originPage: chat?.origin?.page ?? null,
    shared: chat?.sharing?.visibility === "shared",
  };
}

function isUserMessage(message: Chat["messages"][number]): boolean {
  return message.kind === "user";
}

function attachesByDefault(
  chat: ChipChat,
  screen: SurfaceOnScreenView,
): boolean {
  if (!chat.started) return true;
  return chat.originPage === screen.page;
}

// A shared chat has other readers, so only a page on the shared list goes.
function blockedInSharedChat(
  chat: ChipChat,
  screen: SurfaceOnScreenView,
): boolean {
  return chat.shared && !sharedChatMayCarry(screen.page);
}

function attaches(chat: ChipChat | null, screen: SurfaceOnScreenView): boolean {
  if (chat === null || blockedInSharedChat(chat, screen)) return false;
  if (
    choice !== null &&
    choice.conversationId === chat.conversationId &&
    choice.surfaceSessionId === screen.surfaceSessionId
  )
    return choice.attach;
  return attachesByDefault(chat, screen);
}

type ScreenChipDecision = Readonly<{
  screen: SurfaceOnScreenView | null;
  attached: boolean;
}>;

/**
 * Whether the message that the person sends now carries the page on screen.
 * A send ends the person's choice, so the next message starts from the rule.
 */
export function takeScreenChipDecision(): ScreenChipDecision {
  const screen = surfaceOnScreenView();
  const attached = screen !== null && attaches(openChat, screen);
  choice = null;
  publish();
  return { screen, attached };
}

/** What the chip shows for a chat now, for another part of the composer. */
export function useScreenChipDecision(chat: Chat | null): ScreenChipDecision {
  const screen = useSurfaceOnScreenView();
  React.useSyncExternalStore(subscribe, readChoice);
  return {
    screen,
    attached: screen !== null && attaches(chipChat(chat), screen),
  };
}

/**
 * Called on send. When Jev asked about this draft and the chip is off, the
 * composer shows the question once and holds the send (Plan 87 section 3A).
 */
export function holdSendForScreenQuestion(text: string): boolean {
  const screen = surfaceOnScreenView();
  if (openChat === null || screen === null || attaches(openChat, screen))
    return false;
  return holdForScreenQuestion(
    openChat.conversationId,
    screen.surfaceSessionId,
    text,
  );
}

function choose(chat: ChipChat, screen: SurfaceOnScreenView, attach: boolean) {
  choice = {
    conversationId: chat.conversationId,
    surfaceSessionId: screen.surfaceSessionId,
    attach,
  };
  publish();
}

function publish(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return unsubscribe.bind(null, listener);
}

function unsubscribe(listener: () => void): void {
  listeners.delete(listener);
}

function readChoice(): ChipChoice | null {
  return choice;
}

function followChat(chat: ChipChat): () => void {
  openChat = chat;
  return leaveChat.bind(null, chat);
}

function leaveChat(chat: ChipChat): void {
  if (openChat === chat) openChat = null;
}

export function ScreenChip({
  chat,
  organisationId,
  draft,
  onNewChat,
}: {
  readonly chat: Chat | null;
  readonly organisationId: string;
  readonly draft: string;
  readonly onNewChat: (draft: string) => void;
}): React.ReactNode {
  const screen = useSurfaceOnScreenView();
  React.useSyncExternalStore(subscribe, readChoice);
  useScreenSuggestion();
  const current = chipChat(chat);
  React.useEffect(followChat.bind(null, current), [
    current.conversationId,
    current.started,
    current.originPage,
    current.shared,
  ]);
  const attached = screen !== null && attaches(current, screen);
  const blocked = screen !== null && blockedInSharedChat(current, screen);
  // Jev checks only a draft whose page the chip leaves out (section 3A).
  useScreenRelevanceCheck({
    organisationId,
    conversationId: current.conversationId,
    surfaceSessionId: screen?.surfaceSessionId ?? null,
    draft,
    eligible: screen !== null && current.started && !attached && !blocked,
  });
  if (screen === null) return null;
  const name =
    screen.record === null
      ? screen.title
      : `${screen.title} › ${screen.record.label}`;
  if (blocked)
    return (
      <span className="chat-screen-chip" data-attached="blocked">
        {name} is not sent: other people read this shared chat.
      </span>
    );
  const suggestion = attached
    ? null
    : // Only for the draft that Jev checked: a sent or changed draft drops the tag.
      currentSuggestion(current.conversationId, screen.surfaceSessionId, draft);
  const chip = (
    <button
      type="button"
      className="chat-screen-chip"
      data-attached={attached}
      aria-pressed={attached}
      aria-label={
        attached
          ? `${name} goes with your message. Remove it.`
          : `Send ${name} with your message.`
      }
      onClick={choose.bind(null, current, screen, !attached)}
    >
      {attached ? null : <Plus size={13} aria-hidden="true" />}
      <span>{attached ? `On screen: ${name}` : name}</span>
      {attached ? <X size={13} aria-hidden="true" /> : null}
    </button>
  );
  if (suggestion === null || suggestion.view.kind === "quiet") return chip;
  if (!suggestion.asked || suggestion.draft !== draft.trim())
    return (
      <span className="chat-screen-suggestion">
        {chip}
        <span className="chat-screen-tag">Looks related to your message</span>
      </span>
    );
  return (
    <span className="chat-screen-suggestion">
      {chip}
      <span className="chat-screen-question" role="alert">
        <span>
          Your message seems to be about {name}. {startedOn(chat)}, so the page
          is not attached.
        </span>
        <span className="chat-screen-question-actions">
          <button
            type="button"
            onClick={sendWithPage.bind(null, current, screen)}
          >
            Send with this page
          </button>
          <button type="button" onClick={submitComposer}>
            Send without
          </button>
          {suggestion.view.offerNewChat ? (
            <button
              type="button"
              onClick={newChatFromPage.bind(null, onNewChat, draft)}
            >
              New chat from this page
            </button>
          ) : null}
        </span>
      </span>
    </span>
  );
}

function startedOn(chat: Chat | null): string {
  const origin = chat?.origin;
  if (origin === undefined || origin === null)
    return "This chat started without a page";
  const page =
    origin.record === null
      ? origin.title
      : `${origin.title} › ${origin.record.label}`;
  return `This chat started on ${page}`;
}

function sendWithPage(
  chat: ChipChat,
  screen: SurfaceOnScreenView,
  event: React.MouseEvent<HTMLButtonElement>,
): void {
  choose(chat, screen, true);
  event.currentTarget.form?.requestSubmit();
}

// The question showed once for this draft, so a send goes without the page.
function submitComposer(event: React.MouseEvent<HTMLButtonElement>): void {
  event.currentTarget.form?.requestSubmit();
}

function newChatFromPage(onNewChat: (draft: string) => void, draft: string) {
  moveSuggestionToNewChat();
  onNewChat(draft);
}
