import {
  COLLABORATION_PING,
  COLLABORATION_PONG,
} from "@purin-labs/collaboration";
import { MenuBoardDoc } from "@purin-labs/menu-board-crdt";
import { menuBoardStartStyle } from "@purin-labs/menu-board-crdt/board";
import {
  encodeMenuBoardServerMessage,
  parseMenuBoardClientMessage,
} from "@purin-labs/menu-board-crdt/protocol";
import {
  MenuDraftDoc,
  type MenuDraftSnapshot,
} from "@purin-labs/menu-draft-crdt";
import {
  encodeMenuDraftServerMessage,
  parseMenuDraftClientMessage,
} from "@purin-labs/menu-draft-crdt/protocol";
import { templateElements } from "@purin-labs/menu-board-crdt/templates";

/*
 * The shared rooms of the café preview: the menu draft and each board. A
 * room answers the editor's protocol frames in the page, in place of the
 * Platform, so the real editors render a real document.
 */

const SECTIONS = [
  { id: "coffee", title: "Coffee", order: 0 },
  { id: "pastries", title: "Pastries", order: 1 },
] as const;

export const MENU_ITEMS = [
  {
    id: "item_latte",
    productId: "product_latte",
    displayName: "Café latte",
    description: "Double shot with steamed milk.",
    sectionId: "coffee",
  },
  {
    id: "item_cappuccino",
    productId: "product_cappuccino",
    displayName: "Cappuccino",
    description: "",
    sectionId: "coffee",
  },
  {
    id: "item_matcha",
    productId: "product_matcha",
    displayName: "Matcha latte",
    description: "Uji matcha whisked with milk.",
    sectionId: "coffee",
  },
  {
    id: "item_hojicha",
    productId: "product_hojicha",
    displayName: "Hojicha latte",
    description: "",
    sectionId: "coffee",
  },
  {
    id: "item_croissant",
    productId: "product_croissant",
    displayName: "Butter croissant",
    description: "Fermented butter, baked each morning.",
    sectionId: "pastries",
  },
  {
    id: "item_pain",
    productId: "product_pain",
    displayName: "Pain au chocolat",
    description: "",
    sectionId: "pastries",
  },
  {
    id: "item_financier",
    productId: "product_financier",
    displayName: "Brown butter financier",
    description: "Almond cake with a crisp edge.",
    sectionId: "pastries",
  },
  {
    id: "item_canele",
    productId: "product_canele",
    displayName: "Canelé",
    description: "",
    sectionId: "pastries",
  },
] as const;

function menuDocument(): MenuDraftDoc {
  const created = MenuDraftDoc.create("Café menu");
  if (!created.ok) throw new Error("The preview menu could not be made.");
  for (const section of SECTIONS) created.value.addSection(section);
  MENU_ITEMS.forEach((item, index) =>
    created.value.addItem({
      id: item.id,
      productId: item.productId,
      displayName: item.displayName,
      description: item.description,
      placement: { sectionId: item.sectionId, order: index % 4 },
    }),
  );
  return created.value;
}

function boardDocument(title: string, menu: MenuDraftSnapshot): MenuBoardDoc {
  const created = MenuBoardDoc.create(title, "canvas_landscape");
  if (!created.ok) throw new Error("The preview board could not be made.");
  const style = menuBoardStartStyle("espresso_bar");
  if (style !== null) created.value.setStyle(style);
  for (const element of templateElements(
    title,
    "canvas_landscape",
    menu,
    "espresso_bar",
  ))
    created.value.addElement(element);
  return created.value;
}

type Room = Readonly<{
  revision: number;
  receive: (socket: PreviewSocket, frame: string) => void;
}>;

const PARTICIPANT = {
  userId: "user_preview_owner",
  displayName: "Owner",
  state: "viewing",
  selection: null,
  pointer: null,
} as const;
const OTHER = {
  sessionId: "session_preview_mika",
  userId: "user_preview_mika",
  displayName: "Mika Sato",
  state: "viewing",
  selection: null,
  activeAt: Date.now(),
  pointer: null,
} as const;

const menu = menuDocument();

function menuRoom(): Room {
  const room = {
    revision: 7,
    receive(socket: PreviewSocket, frame: string): void {
      if (frame === COLLABORATION_PING)
        return socket.deliver(COLLABORATION_PONG);
      const parsed = parseMenuDraftClientMessage(frame);
      if (!parsed.ok) return;
      const message = parsed.value;
      if (message.kind === "sync_request") {
        const vector = menu.stateVector();
        const update = menu.syncUpdate(message.stateVector);
        if (!vector.ok || !update.ok) return;
        socket.deliver(
          encodeMenuDraftServerMessage({
            kind: "sync_response",
            serverStateVector: vector.value,
            missingUpdate: update.value,
            documentRevision: room.revision,
            access: "edit",
            sessionId: "session_preview_owner",
          }),
        );
        socket.deliver(
          encodeMenuDraftServerMessage({
            kind: "presence_changed",
            participants: [
              {
                sessionId: "session_preview_owner",
                ...PARTICIPANT,
                activeAt: Date.now(),
              },
            ],
            agents: [],
          }),
        );
      } else if (
        message.kind === "submit_update" &&
        menu.apply(message.update).ok
      ) {
        room.revision += 1;
        socket.deliver(
          encodeMenuDraftServerMessage({
            kind: "update_accepted",
            updateId: message.updateId,
          }),
        );
      }
    },
  };
  return room;
}

const boards = new Map<string, MenuBoardDoc>();

function boardRoom(boardId: string, title: string): Room {
  const document = boards.get(boardId) ?? boardDocument(title, menu.read());
  boards.set(boardId, document);
  const room = {
    revision: 4,
    receive(socket: PreviewSocket, frame: string): void {
      if (frame === COLLABORATION_PING)
        return socket.deliver(COLLABORATION_PONG);
      const parsed = parseMenuBoardClientMessage(frame);
      if (!parsed.ok) return;
      const message = parsed.value;
      if (message.kind === "sync_request") {
        const vector = document.stateVector();
        const update = document.syncUpdate(message.stateVector);
        if (!vector.ok || !update.ok) return;
        socket.deliver(
          encodeMenuBoardServerMessage({
            kind: "sync_response",
            serverStateVector: vector.value,
            missingUpdate: update.value,
            documentRevision: room.revision,
            access: "edit",
            sessionId: "session_preview_owner",
          }),
        );
        socket.deliver(
          encodeMenuBoardServerMessage({
            kind: "presence_changed",
            participants: [
              {
                sessionId: "session_preview_owner",
                ...PARTICIPANT,
                activeAt: Date.now(),
              },
              OTHER,
            ],
            agents: [],
          }),
        );
      } else if (
        message.kind === "submit_update" &&
        document.apply(message.update).ok
      ) {
        room.revision += 1;
        socket.deliver(
          encodeMenuBoardServerMessage({
            kind: "update_accepted",
            updateId: message.updateId,
          }),
        );
      }
    },
  };
  return room;
}

/** The saved menu draft, as the control route reads it. */
export function savedMenu(): Readonly<{
  revision: number;
  draft: MenuDraftSnapshot;
}> {
  return { revision: 7, draft: menu.read() };
}

/** A socket that a preview room answers. */
class PreviewSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = PreviewSocket.CONNECTING;
  readonly #room: Room;

  constructor(url: string) {
    super();
    const board = /\/menu-boards\/([^/]+)\/socket/u.exec(url)?.[1];
    this.#room =
      board === undefined
        ? menuRoom()
        : boardRoom(
            decodeURIComponent(board),
            BOARD_TITLES.get(decodeURIComponent(board)) ?? "Board",
          );
    setTimeout(this.#open.bind(this), 40);
  }

  send(data: string): void {
    setTimeout(this.#room.receive.bind(this.#room, this, data), 20);
  }

  close(): void {
    if (this.readyState === PreviewSocket.CLOSED) return;
    this.readyState = PreviewSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  deliver(data: string): void {
    if (this.readyState !== PreviewSocket.OPEN) return;
    setTimeout(
      () => this.dispatchEvent(new MessageEvent("message", { data })),
      20,
    );
  }

  #open(): void {
    this.readyState = PreviewSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
}

const BOARD_TITLES = new Map<string, string>();

/** Answers every collaboration socket of the page from the preview rooms. */
export function installPreviewRooms(titles: ReadonlyMap<string, string>): void {
  for (const [boardId, title] of titles) BOARD_TITLES.set(boardId, title);
  Object.defineProperty(window, "WebSocket", { value: PreviewSocket });
}
