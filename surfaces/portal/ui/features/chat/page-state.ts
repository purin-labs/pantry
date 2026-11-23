import type { ConversationId } from "@purin-labs/control-api";
import type { ChatPageData } from "@purin-labs/control-api/portal/chat";

/** The chat page as the route holds it. */
export type PageState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly data: ChatPageData };

type PageHolder = Readonly<{ page: PageState }>;

/** The open chat after its draft was saved, unless a newer revision is open. */
export function updateSavedDraft(
  saved: {
    readonly revision: number;
    readonly draft: string;
    readonly updatedAt: number | null;
  },
  conversationId: ConversationId,
  state: PageHolder,
): PageHolder {
  if (state.page.kind !== "ready" || state.page.data.conversation === null)
    return { page: state.page };
  const conversation = state.page.data.conversation;
  if (
    conversation.id !== conversationId ||
    conversation.revision > saved.revision
  )
    return { page: state.page };
  return {
    page: {
      kind: "ready",
      data: {
        ...state.page.data,
        conversation: {
          ...conversation,
          revision: saved.revision,
          draft: {
            text: saved.draft,
            updatedAt: saved.updatedAt,
          },
        },
      },
    },
  };
}

/** The directory of a new read, kept beside the open chat. */
export function mergeDirectoryResult(
  directory: ChatPageData,
  state: PageHolder,
): PageHolder {
  if (state.page.kind !== "ready") return { page: state.page };
  return {
    page: {
      kind: "ready",
      data: {
        ...state.page.data,
        unreadCount: directory.unreadCount,
        conversations: directory.conversations,
        archivedConversations: directory.archivedConversations,
        projectDirectory: directory.projectDirectory,
        pendingDeletions: directory.pendingDeletions,
        pinnedConversations: directory.pinnedConversations,
        nextActiveCursor: directory.nextActiveCursor,
        nextArchivedCursor: directory.nextArchivedCursor,
      },
    },
  };
}
