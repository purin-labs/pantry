import { registerBoardChat } from "@purin-labs/area-cafe-contract/ui/features/menu-boards/board-chat";

/**
 * Gives the Café board's prompt edit the Portal chat. The chat code loads
 * when the board first reads or sends, as the chat page loads it.
 */
export function registerPortalBoardChat(): void {
  registerBoardChat({
    read: async (organisationId, conversationId) =>
      (await import("./features/chat/api")).readChat(
        organisationId,
        conversationId,
        "",
        "observe",
      ),
    send: async (organisationId, message) =>
      (await import("./features/chat/screen-send")).sendChat(organisationId, {
        kind: "message",
        ...message,
      }),
  });
}
