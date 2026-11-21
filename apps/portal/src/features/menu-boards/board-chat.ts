import type { ConversationId } from "@purin-labs/control-api";
import type { ChatPageData } from "@purin-labs/control-api/portal/chat";
import type { BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";

/** A message that the prompt edit sends to the Portal chat. */
type BoardChatMessage = Readonly<{
  conversationId: ConversationId;
  requestId: string;
  model: string;
  text: string;
  browserContext: BakeryBrowserContext;
}>;

/**
 * The Portal chat that the prompt edit reads and sends to. The Portal shell
 * registers it, so the board imports no chat file of the shell.
 */
export type BoardChat = Readonly<{
  /** The chat page as an observer, with this chat open, or a new chat. */
  read(
    organisationId: string,
    conversationId: ConversationId | null,
  ): Promise<ChatPageData>;
  /** Sends the message with the page on the screen. */
  send(organisationId: string, message: BoardChatMessage): Promise<unknown>;
}>;

let registered: BoardChat | null = null;

/** The Portal shell gives the chat. */
export function registerBoardChat(chat: BoardChat): void {
  registered = chat;
}

const UNAVAILABLE: BoardChat = {
  read: () => Promise.reject(new Error("The chat is not available on this page.")),
  send: () => Promise.reject(new Error("The chat is not available on this page.")),
};

/** The chat that the shell registered. */
export function boardChat(): BoardChat {
  return registered ?? UNAVAILABLE;
}
