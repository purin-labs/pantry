/**
 * Pin and Unpin in the chat preview. The sample store keeps each choice for
 * the page, so a pinned chat moves to the pinned rows and back, as it does
 * against the Worker.
 */
import type {
  ChatConversationSummary,
  ChatPageData,
} from "@purin-labs/control-api/portal/chat";

const pins = new Map<string, boolean>();

/** Answers `PATCH .../chat/conversations/:id` with `pin` or `unpin`. */
export async function previewPinResponse(
  url: URL,
  init: RequestInit | undefined,
  read: (url: URL) => Promise<Response>,
): Promise<Response | null> {
  if (init?.method !== "PATCH" || typeof init.body !== "string") return null;
  const body: unknown = JSON.parse(init.body);
  const action =
    typeof body === "object" && body !== null && "action" in body
      ? body.action
      : null;
  if (action !== "pin" && action !== "unpin") return null;
  const id = url.pathname.split("/").at(-1);
  if (id === undefined) return null;
  pins.set(id, action === "pin");
  const page = (await (await read(url)).json()) as Pick<
    ChatPageData,
    "conversations"
  >;
  const summary = page.conversations.find((row) => row.id === id);
  return summary === undefined
    ? Response.json({ message: "Unknown preview chat" }, { status: 404 })
    : Response.json(summary);
}

/** The page data with the pins of this preview. */
export function withPreviewPins<
  T extends Pick<ChatPageData, "conversations" | "pinnedConversations">,
>(data: T): T {
  if (pins.size === 0) return data;
  const conversations = data.conversations.map(pinned);
  return {
    ...data,
    conversations,
    pinnedConversations: conversations.filter(isPinned),
  };
}

function pinned(summary: ChatConversationSummary): ChatConversationSummary {
  const pin = pins.get(summary.id);
  if (pin === undefined) return summary;
  return {
    ...summary,
    pinnedAt: pin ? (summary.pinnedAt ?? Date.now()) : null,
  };
}

function isPinned(summary: ChatConversationSummary): boolean {
  return summary.pinnedAt !== null;
}
