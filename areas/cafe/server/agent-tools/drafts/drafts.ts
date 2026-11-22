import {
  type MenuDraftEdit,
  type MenuDraftRead,
} from "../../actors/menu-draft";
import { MenuDraftRequestError } from "../../contract/request-errors";
import {
  isMenuBoardFrameId,
  isMenuBoardItemRow,
  isMenuBoardStackAlign,
  isMenuBoardStackDirection,
  isMenuBoardRect,
  MENU_BOARD_ITEM_ROWS,
  type MenuBoardItemRow,
  isMenuBoardStyleToken,
  isMenuBoardStyleValue,
  MENU_BOARD_STYLE_TOKENS,
  isMenuBoardId,
  type MenuBoardFrameId,
  type MenuBoardRect,
  isMenuBoardLayout,
  isMenuBoardStart,
  isMenuBoardText,
  MENU_BOARD_LAYOUTS,
  MENU_BOARD_STARTS,
  menuBoardStartFits,
  isMenuBoardImageFit,
  isMenuBoardMediaId,
  isMenuBoardProductLook,
  type MenuBoardLayout,
  type MenuBoardStart,
  MENU_BOARD_PRODUCT_LOOKS,
  type MenuBoardProductLook,
} from "@purin-labs/menu-board-crdt";
import type {
  MenuBoardEdit,
  MenuBoardLayoutEdit,
  MenuBoardStackEdit,
  MenuBoardStackSettings,
} from "../../actors/menu-boards";
import type { MenuPriceProposalRequest } from "../../../../../services/platform/src/commerce/contract/types";
import { assertNever, hasExactKeys, isRecord } from "@purin-labs/std";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import type { CatalogExecutionContext } from "@purin-labs/agent-tools/catalog/execute";
import type { CommerceActionProposalOrigin } from "@purin-labs/agent-tools/catalog/types";
import { defineToolFamily, jsonSchema } from "@purin-labs/agent-tools/define-tool";
import { uncheckedEffect } from "@purin-labs/agent-tools/tool-effect";
import type { PreparedEffect } from "@purin-labs/agent-tools/tool-effect";

type MenuDraftReadTool = () => Promise<MenuDraftRead>;

type MenuDraftEditTool = (
  edit: MenuDraftEdit,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<PreparedEffect>;

/** Plan 40B phase 4: the shop's boards and the live prices of their items. */
type MenuBoardReadTool = (
  request: Readonly<{ boardId: string | null }>,
) => Promise<unknown>;

type MenuBoardEditTool = (
  request: Readonly<{ boardId: string; edit: MenuBoardEdit }>,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<PreparedEffect>;

/** Plan 40B, the start screen: a new board from a layout or a design. */
export type MenuBoardCreateRequest = Readonly<{
  title: string;
  layout: MenuBoardLayout;
  start: MenuBoardStart;
}>;

type MenuBoardCreateTool = (
  request: MenuBoardCreateRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<PreparedEffect>;

/** Plan 40B, board removal: archive a board or restore an archived one. */
export type MenuBoardArchiveRequest = Readonly<{
  boardId: string;
  archived: boolean;
}>;

type MenuBoardArchiveTool = (
  request: MenuBoardArchiveRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<unknown>;

type MenuPriceProposal = (
  request: MenuPriceProposalRequest,
  origin?: CommerceActionProposalOrigin,
) => Promise<unknown>;

/** What a turn gives to the shared menu and menu board tools. */
export type MenuToolServices = {
  readonly readMenuDraft: MenuDraftReadTool;
  readonly editMenuDraft: MenuDraftEditTool;
  readonly readMenuBoards: MenuBoardReadTool;
  readonly editMenuBoard: MenuBoardEditTool;
  readonly createMenuBoard: MenuBoardCreateTool;
  readonly archiveMenuBoard: MenuBoardArchiveTool;
  readonly proposeMenuPrice: MenuPriceProposal;
};

const defineMenuTool = defineToolFamily<MenuToolServices>()("menu");

export const menuDraftRead = defineMenuTool({
  name: "menu_draft_read",
  description:
    "Read the current organisation shared menu, including item positions, document identity, revision, and observation time. " +
    "Use a fresh read after human edits or a conversation fork.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMenuDraftReadArgs([input]),
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceMenuDraftRead,
  },
  unavailable: "menu draft read is unavailable",
  handler: ({ readMenuDraft }) =>
    readMenuDraft === undefined ? undefined : () => readMenuDraft(),
});

export const menuDraftEdit = defineMenuTool({
  name: "menu_draft_edit",
  description:
    "Make one change to the organisation's shared menu draft, in the room that people edit, and get the menu back. Open Menus pages show the change at once. " +
    "kind rename_menu: give title. add_section: give title. add_item: give productId, title (the display name), description and sectionId. " +
    "rename_item: give itemId and title. describe_item: give itemId and description. move_item: give itemId, sectionId and order. remove_item: give itemId. " +
    "Set every other field to null. Use ids from menu_draft_read. A productId comes from commerce_entity_context. " +
    "This changes the draft only, and it never changes a price or the live menu. To put the draft live, call commerce_propose_menu_publication.",
  input: jsonSchema({
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [
          "rename_menu",
          "add_section",
          "add_item",
          "rename_item",
          "describe_item",
          "move_item",
          "remove_item",
        ],
      },
      itemId: {
        type: ["string", "null"],
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      sectionId: {
        type: ["string", "null"],
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      productId: {
        type: ["string", "null"],
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      title: { type: ["string", "null"], maxLength: 1000 },
      description: { type: ["string", "null"], maxLength: 1000 },
      order: { type: ["integer", "null"], minimum: 0, maximum: 1000000 },
    },
    required: [
      "kind",
      "itemId",
      "sectionId",
      "productId",
      "title",
      "description",
      "order",
    ],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMenuDraftEditArgs([input]),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceMenuDraftEdit,
  },
  unavailable: "menu draft edit is unavailable",
  prepare: ({ editMenuDraft }) =>
    editMenuDraft === undefined
      ? undefined
      : (request, call) =>
          editMenuDraft(request, call.operationId, call.execution),
});

export const menuBoardRead = defineMenuTool({
  name: "menu_board_read",
  description:
    "Read the shop's menu boards, the Purin Pantry screens on TVs and tablets: each board's draft (title, layout, elements and their frames), its documentRevision, its newest release and its screen count. " +
    "Give boardId null for every board; then archivedBoards lists the archived boards (boardId, title, archivedAt), which menu_board_archive can restore. The result lists the shop's images (mediaId and altText) for menu_board_edit add_image. It also lists the menu items: the items of the menu draft and every item on the published menu, also when the shop has no board, with each item's live price, wasPrice (the earlier price of a deal, or null) and availability, as the screens show them now. Use an item's itemId for menu_board_propose_price. " +
    "A board holds no price. Prices come from the shop's offers.",
  input: jsonSchema({
    type: "object",
    properties: {
      boardId: {
        type: ["string", "null"],
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
    },
    required: ["boardId"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMenuBoardReadArgs([input]),
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceMenuDraftRead,
  },
  unavailable: "menu board read is unavailable",
  handler: ({ readMenuBoards }) =>
    readMenuBoards === undefined
      ? undefined
      : (request) => readMenuBoards(request),
});

export const menuBoardEdit = defineMenuTool({
  name: "menu_board_edit",
  description:
    "Make one change to a menu board's draft, in the room that people edit, and get the board back with the element before and after. Open board editors show the change at once, and a person can change it again. " +
    "kind rename_board: give boardId and title. set_text: give boardId, elementId, prop (a text prop of that element: heading eyebrow, title or detail; section note; featured label or note; order_qr title or detail; pickup_codes title; text text), before (the text that you read) and text. " +
    "set_featured_item: give boardId, elementId of a featured element and itemId. add_text: give boardId, frameId and text; on a free canvas board (layout canvas_*) give frameId canvas and also x, y, width and height. move_element (fixed layouts): give boardId, elementId, frameId and order. place_on_canvas (free canvas boards): give boardId, elementId, x, y, width and height in board units, where the board is 1600 by 900 (landscape), 720 by 1280 (portrait) or 1200 by 900 (tablet). remove_element: give boardId and elementId. set_style: give boardId, prop (a style token: background, surface, ink or accent as #rrggbb; fontDisplay or fontBody as serif, sans, rounded or mono; typeBase as a whole number from 12 to 32; typeRatio as 1.125, 1.2, 1.25, 1.333, 1.414 or 1.5; itemRow as the board's default item row) and text (the value, or an empty text to go back to the default). set_row: give boardId, elementId of a section element and text, the item row of that section: line (name and price on one line), leader (dot leaders to the price), stacked (the description under the name), price_first, tiles (a grid of small cards), or an empty text for the board's default. " +
    "add_item: give boardId, frameId, itemId (a menu draft item from menu_board_read) and text, its look: card, row, tile or price (the name and a big price); on a free canvas board give frameId canvas and also x, y, width and height. set_look: give boardId, elementId of a featured element and text, its look. A product shows its live price and sold-out mark; an item that is not on the published menu shows no price until a person publishes the menu. " +
    "add_image (free canvas boards): give boardId, itemId (the mediaId of an image in menu_board_read images), text (what the image shows, for people who cannot see it), x, y, width and height; the image fills its rect. set_fit: give boardId, elementId of an image and text, cover (fill the rect, cropped) or contain (the whole image inside the rect). " +
    "Set every other field to null. Use ids from menu_board_read. Text is at most 280 characters. " +
    "This changes the draft only. Screens keep the published release until a person publishes the board. It never changes a price: to change a price or set a deal, call menu_board_propose_price.",
  // The rect comes before the text: a model writes the fields in this
  // order, so the board shows the box before its text (Plan 40B phase 7).
  input: jsonSchema({
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [
          "rename_board",
          "set_text",
          "set_featured_item",
          "add_text",
          "move_element",
          "place_on_canvas",
          "remove_element",
          "set_style",
          "set_row",
          "add_item",
          "set_look",
          "add_image",
          "set_fit",
        ],
      },
      boardId: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,128}$" },
      elementId: {
        type: ["string", "null"],
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      frameId: {
        type: ["string", "null"],
        enum: [
          "header",
          "column_1",
          "column_2",
          "column_3",
          "footer",
          "canvas",
          null,
        ],
      },
      x: { type: ["integer", "null"], minimum: -4000, maximum: 4000 },
      y: { type: ["integer", "null"], minimum: -4000, maximum: 4000 },
      width: { type: ["integer", "null"], minimum: 16, maximum: 4000 },
      height: { type: ["integer", "null"], minimum: 16, maximum: 4000 },
      prop: {
        type: ["string", "null"],
        enum: [
          "eyebrow",
          "title",
          "detail",
          "note",
          "label",
          "text",
          ...MENU_BOARD_STYLE_TOKENS,
          null,
        ],
      },
      before: { type: ["string", "null"], maxLength: 280 },
      text: { type: ["string", "null"], maxLength: 280 },
      title: { type: ["string", "null"], maxLength: 280 },
      itemId: {
        type: ["string", "null"],
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      order: { type: ["integer", "null"], minimum: 0, maximum: 1000000 },
    },
    required: [
      "kind",
      "boardId",
      "elementId",
      "frameId",
      "x",
      "y",
      "width",
      "height",
      "prop",
      "before",
      "text",
      "title",
      "itemId",
      "order",
    ],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMenuBoardEditArgs([input]),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceMenuDraftEdit,
  },
  unavailable: "menu board edit is unavailable",
  prepare: ({ editMenuBoard }) =>
    editMenuBoard === undefined
      ? undefined
      : (request, call) =>
          editMenuBoard(request, call.operationId, call.execution),
});

/**
 * Plan 40B phase 5, slice 6: comments pinned to a board's elements. It
 * runs through the board edit path, so it has the same checks as a board
 * edit, and it changes no board, release or screen.
 */
export const menuBoardComment = defineMenuTool({
  name: "menu_board_comment",
  description:
    "Comment on a menu board's element, reply to a comment, or resolve a thread, where the people who edit the board see it. menu_board_read lists each board's comment threads: threadId, the elementId that the thread is pinned to, whether that element is still on the board, and each comment with its author. " +
    "kind add_comment: give boardId, elementId and text, a new thread on that element. reply_comment: give boardId, commentId (a threadId or any comment ID of the thread) and text. resolve_comment: give boardId and commentId. reopen_comment: give boardId and commentId. Set every other field to null. Text is at most 1000 characters. " +
    "A comment never changes the board: to do what a comment asks, call menu_board_edit, then reply and resolve the thread.",
  input: jsonSchema({
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["add_comment", "reply_comment", "resolve_comment", "reopen_comment"],
      },
      boardId: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,128}$" },
      elementId: {
        type: ["string", "null"],
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      commentId: {
        type: ["string", "null"],
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      text: { type: ["string", "null"], maxLength: 1000 },
    },
    required: ["kind", "boardId", "elementId", "commentId", "text"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMenuBoardCommentArgs([input]),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceMenuDraftEdit,
  },
  unavailable: "menu board comment is unavailable",
  prepare: ({ editMenuBoard }) =>
    editMenuBoard === undefined
      ? undefined
      : (request, call) =>
          editMenuBoard(request, call.operationId, call.execution),
});

/**
 * Plan 40B phase 5, slice 7: the version history of a board's draft. A
 * restore is one edit of the draft in the room that people edit; it saves
 * the draft first, so that another restore undoes it.
 */
export const menuBoardHistory = defineMenuTool({
  name: "menu_board_history",
  description:
    "Save a named version of a menu board's draft, or restore a saved version. menu_board_read lists each board's versions, newest first: versionId, kind (created, named, published, before_restore or auto), label, documentRevision and time. " +
    "kind save_version: give boardId and text, a name of at most 80 characters. restore_version: give boardId and versionId. Set every other field to null. " +
    "A restore makes the draft equal to that version in one edit that open editors see at once. It first saves the draft as a before_restore version, so restoring that version undoes it. A restore changes the draft only: screens keep the published board until a person publishes it. Tell the person what the restore changed.",
  input: jsonSchema({
    type: "object",
    properties: {
      kind: { type: "string", enum: ["save_version", "restore_version"] },
      boardId: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,128}$" },
      versionId: {
        type: ["string", "null"],
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      text: { type: ["string", "null"], maxLength: 80 },
    },
    required: ["kind", "boardId", "versionId", "text"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMenuBoardHistoryArgs([input]),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceMenuDraftEdit,
  },
  unavailable: "menu board history is unavailable",
  prepare: ({ editMenuBoard }) =>
    editMenuBoard === undefined
      ? undefined
      : (request, call) =>
          editMenuBoard(request, call.operationId, call.execution),
});

/**
 * Plan 40B, board removal: an owner or admin archives a board that no
 * screen shows, or restores an archived board. An archive deletes nothing.
 */
export const menuBoardArchive = defineMenuTool({
  name: "menu_board_archive",
  description:
    "Archive a menu board, or restore an archived board, as an owner or admin does from the board menu. Give boardId and archived: true to archive, false to restore. " +
    "An archived board leaves the board list and the screen picker, and its images stop being public; its draft, versions, comments and releases stay, so a restore brings it back as it was. " +
    "Only an owner or admin may do this. A board that a screen shows cannot be archived: the person first shows another board on that screen. Ask the person before you archive a board, and tell them that they can restore it. " +
    "menu_board_read with boardId null lists the boards and the archived boards.",
  input: jsonSchema({
    type: "object",
    properties: {
      boardId: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,128}$" },
      archived: { type: "boolean" },
    },
    required: ["boardId", "archived"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMenuBoardArchiveArgs(input),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceMenuDraftEdit,
  },
  unavailable: "menu board archive is unavailable",
  // No exit check today (Refactor 17, Appendix C): the effect has other rules.
  prepare: ({ archiveMenuBoard }) =>
    archiveMenuBoard === undefined
      ? undefined
      : async (request, call) =>
          uncheckedEffect(() =>
            archiveMenuBoard(request, call.operationId, call.execution),
          ),
});

function parseMenuBoardArchiveArgs(raw: unknown): MenuBoardArchiveRequest {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["boardId", "archived"]) ||
    typeof raw.boardId !== "string" ||
    !/^[A-Za-z0-9_:-]{1,128}$/u.test(raw.boardId) ||
    typeof raw.archived !== "boolean"
  )
    throw new TypeError("menu_board_archive arguments are invalid");
  return { boardId: raw.boardId, archived: raw.archived };
}

/**
 * Plan 40B, the start screen: a new board from a layout's template, a blank
 * free canvas or a designed menu, as a person makes one from Boards › New
 * board. It passes the same checks as menu_board_edit.
 */
export const menuBoardCreate = defineMenuTool({
  name: "menu_board_create",
  description:
    "Make a new menu board for the shop's screens, as a person does from Boards, New board. Give title (the board's name), layout and start. " +
    "layout: three_columns, two_columns or pickup_board for a landscape TV; portrait_list or portrait_pickup for a portrait TV; tablet_two_columns for a tablet; canvas_landscape, canvas_portrait or canvas_tablet for a free canvas in that shape. " +
    "start: template fills the layout from the shop's menu (sections, a featured item, the order QR code). blank is an empty free canvas. A designed menu is a free canvas with a style and an item row, filled from the menu: espresso_bar (dark, gold prices, dot leaders), bakery_counter (paper, the description under each name), matcha_bar (green, tiles) or night_market (the order codes and the QR code). Every start except template needs a canvas_* layout. " +
    "The board starts as a draft: screens show it only when a person publishes it. Returns the board's summary with its boardId; read it with menu_board_read.",
  input: jsonSchema({
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 280 },
      layout: { type: "string", enum: Object.keys(MENU_BOARD_LAYOUTS) },
      start: { type: "string", enum: [...MENU_BOARD_STARTS] },
    },
    required: ["title", "layout", "start"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMenuBoardCreateArgs([input]),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceMenuDraftEdit,
  },
  unavailable: "menu board create is unavailable",
  prepare: ({ createMenuBoard }) =>
    createMenuBoard === undefined
      ? undefined
      : (request, call) =>
          createMenuBoard(request, call.operationId, call.execution),
});

function parseMenuBoardCreateArgs(args: readonly unknown[]): MenuBoardCreateRequest {
  const raw = args[0];
  if (!isRecord(raw) || !hasExactKeys(raw, ["title", "layout", "start"]))
    throw new TypeError("menu_board_create arguments are invalid");
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (title.length === 0 || !isMenuBoardText(title))
    throw new MenuBoardArgumentError("menu_board_create title must be 1 to 280 characters");
  if (!isMenuBoardLayout(raw.layout) || !isMenuBoardStart(raw.start))
    throw new MenuBoardArgumentError("menu_board_create needs a layout and a start from the lists");
  if (!menuBoardStartFits(raw.start, raw.layout))
    throw new MenuBoardArgumentError(
      "menu_board_create: blank and the designed menus need a canvas_* layout; use start template with a fixed layout",
    );
  return { title, layout: raw.layout, start: raw.start };
}

/**
 * Plan 40B phase 5, slice 8: auto-layout stacks on a free canvas board. It
 * runs through the board edit path, with the same checks as
 * menu_board_edit.
 */
export const menuBoardStack = defineMenuTool({
  name: "menu_board_stack",
  description:
    "Arrange elements of a free canvas menu board (layout canvas_*) in an auto-layout stack, as in Figma. A stack places its elements one after another, down (vertical) or across (horizontal), with a gap between them and padding inside its rect; each element keeps its size along the stack, and across it the stack aligns them (start, center, end) or makes them fill it (stretch). In menu_board_read a stack is an element of kind stack, and each element in it has placement frameId stack with its stackId, order and size; canvasRects gives where each element shows. " +
    "kind stack_elements: give boardId, elementIds (2 to 12 canvas elements, in the order that the stack shows them), direction, gap, padding and align. set_stack: give boardId, elementId of a stack, direction, gap, padding and align. move_in_stack: give boardId, elementId of an element in a stack and order, its new place in the stack from 0. unstack: give boardId and elementId of a stack; its elements stay where they show, on the canvas. Set every other field to null. Gap and padding are whole board units from 0 to 400. " +
    "To take one element out of a stack, call menu_board_edit place_on_canvas. This changes the draft only, as menu_board_edit does.",
  input: jsonSchema({
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["stack_elements", "set_stack", "move_in_stack", "unstack"],
      },
      boardId: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,128}$" },
      elementId: {
        type: ["string", "null"],
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      elementIds: {
        type: ["array", "null"],
        items: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,128}$" },
        minItems: 2,
        maxItems: 12,
      },
      direction: { type: ["string", "null"], enum: ["vertical", "horizontal", null] },
      gap: { type: ["integer", "null"], minimum: 0, maximum: 400 },
      padding: { type: ["integer", "null"], minimum: 0, maximum: 400 },
      align: {
        type: ["string", "null"],
        enum: ["start", "center", "end", "stretch", null],
      },
      order: { type: ["integer", "null"], minimum: 0, maximum: 48 },
    },
    required: [
      "kind",
      "boardId",
      "elementId",
      "elementIds",
      "direction",
      "gap",
      "padding",
      "align",
      "order",
    ],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMenuBoardStackArgs([input]),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceMenuDraftEdit,
  },
  unavailable: "menu board stack is unavailable",
  prepare: ({ editMenuBoard }) =>
    editMenuBoard === undefined
      ? undefined
      : (request, call) =>
          editMenuBoard(request, call.operationId, call.execution),
});

export const menuPriceProposal = defineMenuTool({
  name: "menu_board_propose_price",
  description:
    "Propose a new price for one item on the café menu, or a deal. The price shows on every board, screen and the QR order page after an owner or admin approves it. " +
    "Give itemId from menu_board_read and priceMinor, the new price in minor units (yen for JPY). " +
    "deal true keeps the current price on the boards as the earlier price, struck through beside the new one; the new price must be lower. deal false sets a plain price, and it also ends a deal. " +
    "The result shows the price before and after. This records a proposal for approval and changes no price. An owner or admin approves the exact change on its card. " +
    "Never say that the price changed before the approval.",
  input: jsonSchema({
    type: "object",
    properties: {
      itemId: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,128}$" },
      priceMinor: { type: "integer", minimum: 1, maximum: 100000000 },
      deal: { type: "boolean" },
    },
    required: ["itemId", "priceMinor", "deal"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMenuPriceProposalArgs([input]),
  effect: "proposal",
  rerun: {
    kind: "script",
    reason:
      "The request names the item and the price, and the proposal freezes the offer revision that it read, so a rerun gets the first proposal.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceActionPropose,
  },
  unavailable: "menu price proposal is unavailable",
  handler: ({ proposeMenuPrice }) =>
    proposeMenuPrice === undefined
      ? undefined
      : (request, call) =>
          proposeMenuPrice(request, { toolCallId: call.callId }),
});

function parseMenuDraftReadArgs(
  args: readonly unknown[],
): Readonly<Record<string, never>> {
  if (args.length !== 1 || !isRecord(args[0]) || !hasExactKeys(args[0], [])) {
    throw new TypeError("menu_draft_read arguments are invalid");
  }
  return {};
}

const MENU_ID_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/u;

function menuIdArg(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || !MENU_ID_PATTERN.test(value)) {
    throw new TypeError(`menu_draft_edit ${key} is invalid`);
  }
  return value;
}

function menuTextArg(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length > 1_000) {
    throw new TypeError(`menu_draft_edit ${key} is invalid`);
  }
  return value;
}

/** Each kind reads its own fields, and every other field must be null. */
function parseMenuDraftEditArgs(args: readonly unknown[]): MenuDraftEdit {
  const raw = args[0];
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "kind",
      "itemId",
      "sectionId",
      "productId",
      "title",
      "description",
      "order",
    ])
  ) {
    throw new TypeError("menu_draft_edit arguments are invalid");
  }
  const edit = menuDraftEditOfKind(raw);
  for (const key of [
    "itemId",
    "sectionId",
    "productId",
    "title",
    "description",
    "order",
  ]) {
    const used =
      key === "title" ? "title" in edit || "displayName" in edit : key in edit;
    if (!used && raw[key] !== null) {
      throw new TypeError(
        `menu_draft_edit ${key} must be null for ${edit.kind}`,
      );
    }
  }
  return edit;
}

function menuDraftEditOfKind(raw: Record<string, unknown>): MenuDraftEdit {
  switch (raw.kind) {
    case "rename_menu":
      return { kind: raw.kind, title: menuTextArg(raw, "title") };
    case "add_section":
      return { kind: raw.kind, title: menuTextArg(raw, "title") };
    case "add_item":
      return {
        kind: raw.kind,
        productId: menuIdArg(raw, "productId"),
        displayName: menuTextArg(raw, "title"),
        description: menuTextArg(raw, "description"),
        sectionId: menuIdArg(raw, "sectionId"),
      };
    case "rename_item":
      return {
        kind: raw.kind,
        itemId: menuIdArg(raw, "itemId"),
        displayName: menuTextArg(raw, "title"),
      };
    case "describe_item":
      return {
        kind: raw.kind,
        itemId: menuIdArg(raw, "itemId"),
        description: menuTextArg(raw, "description"),
      };
    case "move_item": {
      if (
        typeof raw.order !== "number" ||
        !Number.isSafeInteger(raw.order) ||
        raw.order < 0 ||
        raw.order > 1_000_000
      ) {
        throw new TypeError("menu_draft_edit order is invalid");
      }
      return {
        kind: raw.kind,
        itemId: menuIdArg(raw, "itemId"),
        sectionId: menuIdArg(raw, "sectionId"),
        order: raw.order,
      };
    }
    case "remove_item":
      return { kind: raw.kind, itemId: menuIdArg(raw, "itemId") };
    default:
      throw new TypeError("menu_draft_edit kind is invalid");
  }
}

function parseMenuBoardReadArgs(
  args: readonly unknown[],
): Readonly<{ boardId: string | null }> {
  const raw = args[0];
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    !hasExactKeys(raw, ["boardId"]) ||
    (raw.boardId !== null && !isMenuBoardId(raw.boardId))
  ) {
    throw new TypeError("menu_board_read arguments are invalid");
  }
  return { boardId: raw.boardId };
}

const MENU_BOARD_EDIT_KEYS = [
  "kind",
  "boardId",
  "elementId",
  "prop",
  "before",
  "text",
  "title",
  "itemId",
  "frameId",
  "order",
  "x",
  "y",
  "width",
  "height",
] as const;

const MENU_BOARD_RECT_KEYS = ["x", "y", "width", "height"] as const;

type MenuBoardEditToolKind = Exclude<
  MenuBoardLayoutEdit,
  MenuBoardStackEdit
>["kind"];

const MENU_BOARD_EDIT_USES: Readonly<
  Record<MenuBoardEditToolKind, readonly string[]>
> = {
  rename_board: ["title"],
  set_text: ["elementId", "prop", "before", "text"],
  set_featured_item: ["elementId", "itemId"],
  add_text: ["frameId", "text"],
  move_element: ["elementId", "frameId", "order"],
  place_on_canvas: ["elementId", ...MENU_BOARD_RECT_KEYS],
  set_style: ["prop", "text"],
  set_row: ["elementId", "text"],
  add_item: ["frameId", "itemId", "text"],
  set_look: ["elementId", "text"],
  add_image: ["itemId", "text", ...MENU_BOARD_RECT_KEYS],
  set_fit: ["elementId", "text"],
  remove_element: ["elementId"],
};

function parseMenuBoardEditArgs(
  args: readonly unknown[],
): Readonly<{ boardId: string; edit: MenuBoardEdit }> {
  const raw = args[0];
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    !hasExactKeys(raw, MENU_BOARD_EDIT_KEYS) ||
    !isMenuBoardId(raw.boardId) ||
    typeof raw.kind !== "string" ||
    !(raw.kind in MENU_BOARD_EDIT_USES)
  ) {
    throw new TypeError("menu_board_edit arguments are invalid");
  }
  const kind = raw.kind as MenuBoardEditToolKind;
  const uses = MENU_BOARD_EDIT_USES[kind];
  for (const key of MENU_BOARD_EDIT_KEYS) {
    if (key === "kind" || key === "boardId") {
      continue;
    }
    // add_text and add_item take a rect on a free canvas and none in a
    // fixed layout.
    if (
      (kind === "add_text" || kind === "add_item") &&
      (MENU_BOARD_RECT_KEYS as readonly string[]).includes(key)
    ) {
      continue;
    }
    if (uses.includes(key) ? raw[key] === null : raw[key] !== null) {
      throw new MenuBoardArgumentError(
        `menu_board_edit ${key} must be ${uses.includes(key) ? "given" : "null"} for ${kind}`,
      );
    }
  }
  const text = (key: string): string => {
    const value = raw[key];
    if (
      typeof value !== "string" ||
      value.length > 280 ||
      value.includes("\r")
    ) {
      throw new TypeError(`menu_board_edit ${key} is invalid`);
    }
    return value;
  };
  const id = (key: string): string => {
    const value = raw[key];
    if (!isMenuBoardId(value)) {
      throw new TypeError(`menu_board_edit ${key} is invalid`);
    }
    return value;
  };
  const rect = (): MenuBoardRect => {
    const value = { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
    if (!isMenuBoardRect(value)) {
      throw new MenuBoardArgumentError(
        "menu_board_edit x and y must be integers from -4000 to 4000, and width and height integers from 16 to 4000",
      );
    }
    return value;
  };
  const frame = (): MenuBoardFrameId => {
    if (!isMenuBoardFrameId(raw.frameId)) {
      throw new TypeError("menu_board_edit frameId is invalid");
    }
    return raw.frameId;
  };
  const look = (): MenuBoardProductLook => {
    const given = text("text").trim().toLowerCase();
    if (!isMenuBoardProductLook(given)) {
      throw new MenuBoardArgumentError(
        `menu_board_edit text must be a look: ${MENU_BOARD_PRODUCT_LOOKS.join(", ")}`,
      );
    }
    return given;
  };
  let edit: MenuBoardEdit;
  switch (kind) {
    case "rename_board":
      edit = { kind, title: text("title") };
      break;
    case "set_text":
      edit = {
        kind,
        elementId: id("elementId"),
        prop: text("prop"),
        before: text("before"),
        text: text("text"),
      };
      break;
    case "set_featured_item":
      edit = { kind, elementId: id("elementId"), itemId: id("itemId") };
      break;
    case "add_text": {
      const given = MENU_BOARD_RECT_KEYS.filter((key) => raw[key] !== null);
      if (given.length !== 0 && given.length !== 4) {
        throw new MenuBoardArgumentError(
          "menu_board_edit add_text needs all of x, y, width and height, or none of them",
        );
      }
      edit = {
        kind,
        frameId: frame(),
        rect: given.length === 4 ? rect() : null,
        text: text("text"),
      };
      break;
    }
    case "add_item": {
      const given = MENU_BOARD_RECT_KEYS.filter((key) => raw[key] !== null);
      if (given.length !== 0 && given.length !== 4) {
        throw new MenuBoardArgumentError(
          "menu_board_edit add_item needs all of x, y, width and height, or none of them",
        );
      }
      edit = {
        kind,
        frameId: frame(),
        rect: given.length === 4 ? rect() : null,
        itemId: id("itemId"),
        look: look(),
      };
      break;
    }
    case "set_look":
      edit = { kind, elementId: id("elementId"), look: look() };
      break;
    case "add_image": {
      const mediaId = raw.itemId;
      if (!isMenuBoardMediaId(mediaId)) {
        throw new MenuBoardArgumentError(
          "menu_board_edit add_image itemId must be the mediaId of an image in menu_board_read images",
        );
      }
      edit = { kind, rect: rect(), mediaId, altText: text("text").trim(), fit: "cover" };
      break;
    }
    case "set_fit": {
      const given = text("text").trim().toLowerCase();
      if (!isMenuBoardImageFit(given)) {
        throw new MenuBoardArgumentError(
          "menu_board_edit set_fit text must be cover or contain",
        );
      }
      edit = { kind, elementId: id("elementId"), fit: given };
      break;
    }
    case "place_on_canvas":
      edit = { kind, elementId: id("elementId"), rect: rect() };
      break;
    case "set_row": {
      const given = text("text").trim().toLowerCase();
      if (given.length > 0 && !isMenuBoardItemRow(given)) {
        throw new MenuBoardArgumentError(
          `menu_board_edit set_row text must be one of ${MENU_BOARD_ITEM_ROWS.join(", ")}, or empty for the board's default`,
        );
      }
      edit = {
        kind,
        elementId: id("elementId"),
        row: given.length === 0 ? null : (given as MenuBoardItemRow),
      };
      break;
    }
    case "set_style": {
      const token = raw.prop;
      if (!isMenuBoardStyleToken(token)) {
        throw new MenuBoardArgumentError(
          `menu_board_edit set_style prop must be one of ${MENU_BOARD_STYLE_TOKENS.join(", ")}`,
        );
      }
      const given = text("text").trim();
      const value =
        given.length === 0
          ? null
          : token === "typeBase"
            ? Number(given)
            : given.toLowerCase();
      if (value !== null && !isMenuBoardStyleValue(token, value)) {
        throw new MenuBoardArgumentError(
          `menu_board_edit set_style ${token} cannot be ${JSON.stringify(given)}`,
        );
      }
      edit = { kind, token, value };
      break;
    }
    case "move_element": {
      const order = raw.order;
      if (
        typeof order !== "number" ||
        !Number.isSafeInteger(order) ||
        order < 0 ||
        order > 1_000_000
      ) {
        throw new TypeError("menu_board_edit order is invalid");
      }
      edit = { kind, elementId: id("elementId"), frameId: frame(), order };
      break;
    }
    case "remove_element":
      edit = { kind, elementId: id("elementId") };
      break;
    default:
      return assertNever(kind);
  }
  return { boardId: raw.boardId, edit };
}

const MENU_BOARD_COMMENT_USES: Readonly<Record<string, readonly string[]>> = {
  add_comment: ["elementId", "text"],
  reply_comment: ["commentId", "text"],
  resolve_comment: ["commentId"],
  reopen_comment: ["commentId"],
};

function parseMenuBoardCommentArgs(
  args: readonly unknown[],
): Readonly<{ boardId: string; edit: MenuBoardEdit }> {
  const raw = args[0];
  const keys = ["kind", "boardId", "elementId", "commentId", "text"] as const;
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    !hasExactKeys(raw, keys) ||
    !isMenuBoardId(raw.boardId) ||
    typeof raw.kind !== "string" ||
    !Object.hasOwn(MENU_BOARD_COMMENT_USES, raw.kind)
  ) {
    throw new TypeError("menu_board_comment arguments are invalid");
  }
  const uses = MENU_BOARD_COMMENT_USES[raw.kind] ?? [];
  for (const key of ["elementId", "commentId", "text"] as const) {
    if (uses.includes(key) ? raw[key] === null : raw[key] !== null) {
      throw new MenuBoardArgumentError(
        `menu_board_comment ${key} must be ${uses.includes(key) ? "given" : "null"} for ${raw.kind}`,
      );
    }
  }
  const id = (key: "elementId" | "commentId"): string => {
    const value = raw[key];
    if (!isMenuBoardId(value)) {
      throw new TypeError(`menu_board_comment ${key} is invalid`);
    }
    return value;
  };
  const text = (): string => {
    const value = raw.text;
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.length > 1000
    ) {
      throw new MenuBoardArgumentError(
        "menu_board_comment text must have 1 to 1000 characters",
      );
    }
    return value;
  };
  switch (raw.kind) {
    case "add_comment":
      return {
        boardId: raw.boardId,
        edit: { kind: "add_comment", elementId: id("elementId"), text: text() },
      };
    case "reply_comment":
      return {
        boardId: raw.boardId,
        edit: { kind: "reply_comment", commentId: id("commentId"), text: text() },
      };
    default:
      return {
        boardId: raw.boardId,
        edit: {
          kind: "resolve_comment",
          commentId: id("commentId"),
          resolved: raw.kind === "resolve_comment",
        },
      };
  }
}

const MENU_BOARD_STACK_KEYS = [
  "kind",
  "boardId",
  "elementId",
  "elementIds",
  "direction",
  "gap",
  "padding",
  "align",
  "order",
] as const;

const MENU_BOARD_STACK_USES: Readonly<
  Record<MenuBoardStackEdit["kind"], readonly string[]>
> = {
  stack_elements: ["elementIds", "direction", "gap", "padding", "align"],
  set_stack: ["elementId", "direction", "gap", "padding", "align"],
  move_in_stack: ["elementId", "order"],
  unstack: ["elementId"],
};

function parseMenuBoardStackArgs(
  args: readonly unknown[],
): Readonly<{ boardId: string; edit: MenuBoardEdit }> {
  const raw = args[0];
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    !hasExactKeys(raw, MENU_BOARD_STACK_KEYS) ||
    !isMenuBoardId(raw.boardId) ||
    typeof raw.kind !== "string" ||
    !Object.hasOwn(MENU_BOARD_STACK_USES, raw.kind)
  ) {
    throw new TypeError("menu_board_stack arguments are invalid");
  }
  const kind = raw.kind as MenuBoardStackEdit["kind"];
  const uses = MENU_BOARD_STACK_USES[kind];
  for (const key of MENU_BOARD_STACK_KEYS) {
    if (key === "kind" || key === "boardId") continue;
    if (uses.includes(key) ? raw[key] === null : raw[key] !== null) {
      throw new MenuBoardArgumentError(
        `menu_board_stack ${key} must be ${uses.includes(key) ? "given" : "null"} for ${kind}`,
      );
    }
  }
  const spacing = (key: "gap" | "padding"): number => {
    const value = raw[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 400
    ) {
      throw new MenuBoardArgumentError(
        `menu_board_stack ${key} must be a whole number from 0 to 400`,
      );
    }
    return value;
  };
  const settings = (): MenuBoardStackSettings => {
    if (!isMenuBoardStackDirection(raw.direction)) {
      throw new MenuBoardArgumentError(
        "menu_board_stack direction must be vertical or horizontal",
      );
    }
    if (!isMenuBoardStackAlign(raw.align)) {
      throw new MenuBoardArgumentError(
        "menu_board_stack align must be start, center, end or stretch",
      );
    }
    return {
      direction: raw.direction,
      gap: spacing("gap"),
      padding: spacing("padding"),
      align: raw.align,
    };
  };
  const elementId = (): string => {
    if (!isMenuBoardId(raw.elementId)) {
      throw new TypeError("menu_board_stack elementId is invalid");
    }
    return raw.elementId;
  };
  switch (kind) {
    case "stack_elements": {
      const ids = raw.elementIds;
      if (
        !Array.isArray(ids) ||
        ids.length < 2 ||
        ids.length > 12 ||
        !ids.every(isMenuBoardId) ||
        new Set(ids).size !== ids.length
      ) {
        throw new MenuBoardArgumentError(
          "menu_board_stack elementIds must name 2 to 12 different elements",
        );
      }
      return {
        boardId: raw.boardId,
        edit: { kind, elementIds: ids, settings: settings() },
      };
    }
    case "set_stack":
      return {
        boardId: raw.boardId,
        edit: { kind, elementId: elementId(), settings: settings() },
      };
    case "move_in_stack": {
      const order = raw.order;
      if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
        throw new MenuBoardArgumentError(
          "menu_board_stack order must be a whole number from 0",
        );
      }
      return {
        boardId: raw.boardId,
        edit: { kind, elementId: elementId(), index: order },
      };
    }
    case "unstack":
      return { boardId: raw.boardId, edit: { kind, elementId: elementId() } };
    default:
      return assertNever(kind);
  }
}

function parseMenuBoardHistoryArgs(
  args: readonly unknown[],
): Readonly<{ boardId: string; edit: MenuBoardEdit }> {
  const raw = args[0];
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "boardId", "versionId", "text"]) ||
    !isMenuBoardId(raw.boardId) ||
    (raw.kind !== "save_version" && raw.kind !== "restore_version")
  ) {
    throw new TypeError("menu_board_history arguments are invalid");
  }
  if (raw.kind === "save_version") {
    if (raw.versionId !== null) {
      throw new MenuBoardArgumentError(
        "menu_board_history versionId must be null for save_version",
      );
    }
    if (
      typeof raw.text !== "string" ||
      raw.text.trim().length === 0 ||
      raw.text.length > 80 ||
      raw.text.includes("\r")
    ) {
      throw new MenuBoardArgumentError(
        "menu_board_history save_version text must be a name of 1 to 80 characters",
      );
    }
    return { boardId: raw.boardId, edit: { kind: "save_version", label: raw.text } };
  }
  if (raw.text !== null || !isMenuBoardId(raw.versionId)) {
    throw new MenuBoardArgumentError(
      "menu_board_history restore_version needs versionId from menu_board_read and text null",
    );
  }
  return {
    boardId: raw.boardId,
    edit: { kind: "restore_version", versionId: raw.versionId },
  };
}

/** A board argument that the model can correct. */
class MenuBoardArgumentError extends MenuDraftRequestError {}

function parseMenuPriceProposalArgs(
  args: readonly unknown[],
): MenuPriceProposalRequest {
  const raw = args[0];
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    !hasExactKeys(raw, ["itemId", "priceMinor", "deal"]) ||
    !isMenuBoardId(raw.itemId) ||
    typeof raw.priceMinor !== "number" ||
    !Number.isSafeInteger(raw.priceMinor) ||
    raw.priceMinor < 1 ||
    raw.priceMinor > 100_000_000 ||
    typeof raw.deal !== "boolean"
  ) {
    throw new TypeError("menu_board_propose_price arguments are invalid");
  }
  return { itemId: raw.itemId, priceMinor: raw.priceMinor, deal: raw.deal };
}
