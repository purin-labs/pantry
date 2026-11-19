/**
 * The `side-cases` scenario of the chat preview (Plan 74). The first chat
 * holds three side Case cards: one that its owner started, one open and one
 * dismissed. The started side Case shows under its source chat in the
 * sidebar, and "Start in a subthread" on the open card adds another one.
 */
import {
  parseConversationId,
  type ChatSideCaseView,
  type ChatSideCaseState,
  type ConversationId,
} from "@purin-labs/control-api";

const SOURCE = previewId("conv_00000000-0000-0000-0000-000000000001");
const STARTED = previewId("conv_00000000-0000-0000-0000-000000000004");
const NEW_CHAT = previewId("conv_00000000-0000-0000-0000-000000000005");
const previewParams = new URLSearchParams(window.location.search);
let startFailed = false;

function previewSideState(): ChatSideCaseState {
  switch (previewParams.get("sideState")) {
    case "starting":
      return { kind: "starting", mayRetry: false };
    case "retry":
      return { kind: "starting", mayRetry: true };
    case "expired":
      return { kind: "expired" };
    case "hidden":
      return { kind: "started", conversationId: null };
    case "readonly":
      return {
        kind: "open",
        expiresAt: Date.now() + 604_800_000,
        mayDecide: false,
      };
    default:
      return {
        kind: "open",
        expiresAt: Date.now() + 604_800_000,
        mayDecide: true,
      };
  }
}

let cards: ChatSideCaseView[] = [
  {
    proposalId: "a".repeat(32),
    title: "Fix the almond croissant price",
    brief:
      "The almond croissant shows a price of 0 yen in the shop, but the menu says 520 yen. Find where the price came from and correct it to 520 yen.",
    createdAt: 6,
    state: { kind: "started", conversationId: STARTED },
  },
  {
    proposalId: "b".repeat(32),
    title: "Restock butter",
    brief:
      "Butter stock is below two days of use at the current production plan. Prepare an order for the dairy supplier.",
    createdAt: 7,
    state: previewSideState(),
  },
  {
    proposalId: "c".repeat(32),
    title: "Check oven two",
    brief:
      "Oven two reported a low temperature twice this morning. Check its log.",
    createdAt: 8,
    state: { kind: "dismissed" },
  },
];

export function sideCasesPreviewEnabled(): boolean {
  return previewParams.get("scenario") === "side-cases";
}

/** "Start in a subthread" and the close of "Do it here" on a preview card. */
export function previewSideCaseResponse(
  url: URL,
  init: RequestInit | undefined,
): Response | null {
  const match = /\/side-cases\/([0-9a-f]{32})\/(start|dismiss)$/u.exec(
    url.pathname,
  );
  if (match === null || init?.method !== "POST") return null;
  if (previewParams.get("sideFault") === "once" && !startFailed) {
    startFailed = true;
    return Response.json(
      { error: "side_case_temporarily_unavailable" },
      { status: 503 },
    );
  }
  const card = cards.find((candidate) => candidate.proposalId === match[1]);
  if (card === undefined)
    return Response.json({ error: "side_case_not_found" }, { status: 404 });
  const next: ChatSideCaseView =
    match[2] === "start"
      ? { ...card, state: { kind: "started", conversationId: NEW_CHAT } }
      : { ...card, state: { kind: "dismissed" } };
  cards = cards.map((candidate) =>
    candidate.proposalId === next.proposalId ? next : candidate,
  );
  return Response.json({
    ok: true,
    sideCase: next,
    ...(match[2] === "start" ? { conversationId: NEW_CHAT } : {}),
  });
}

type PreviewSummary = Readonly<{
  id: ConversationId;
  placement: Readonly<{ projectId: string }>;
}> &
  Record<string, unknown>;

/**
 * The chat page with the scenario's cards, the side Case rows in the
 * sidebar, and the source link of an open side Case.
 */
export function withSideCasePreview<
  T extends Readonly<{
    conversations: readonly PreviewSummary[];
    conversation: (Record<string, unknown> & { id: ConversationId }) | null;
  }>,
>(data: T): T & Record<string, unknown> {
  const source = data.conversations.find((row) => row.id === SOURCE);
  if (source === undefined) return data;
  const children = cards.flatMap((card) =>
    card.state.kind === "started" && card.state.conversationId !== null
      ? [
          {
            ...source,
            id: card.state.conversationId,
            title: card.title,
            pinnedAt: null,
            parentConversationId: SOURCE,
          },
        ]
      : [],
  );
  const selected = data.conversation;
  const child = children.find((row) => row.id === selected?.id);
  return {
    ...data,
    conversations: [...data.conversations, ...children],
    conversation:
      selected === null
        ? null
        : child === undefined
          ? selected
          : {
              ...selected,
              title: child.title,
              lineage: {
                kind: "side_case",
                sourceConversationId: SOURCE,
                proposalId: "a".repeat(32),
              },
            },
    sideCases: selected?.id === SOURCE ? cards : [],
    sideCaseSource:
      child === undefined
        ? null
        : {
            kind: "available",
            conversationId: SOURCE,
            title: String(source.title),
          },
  };
}

function previewId(raw: string): ConversationId {
  const parsed = parseConversationId(raw);
  if (!parsed.ok) throw new Error("Invalid preview chat");
  return parsed.value;
}
