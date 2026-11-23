import React from "react";
import { useChatAgentRequest } from "@purin-labs/collaboration/portal/agent-request";
import { History, Plus, Redo2, Undo2 } from "lucide-react";
import {
  parseMenuBoardSummaries,
  parseMenuScreenFacts,
  type MenuBoardSummary,
  type MenuScreenFacts,
} from "@purin-labs/cafe-control-api";
import {
  MENU_BOARD_DEFAULT_CONSTRAINTS,
  MENU_BOARD_ITEM_ROWS,
  MENU_BOARD_LAYOUTS,
  MENU_BOARD_PRODUCT_LOOKS,
  MENU_BOARD_SCREEN_SIZES,
  MENU_BOARD_TEXT_LIMIT,
  menuBoardCanvasRects,
  type MenuBoardElement,
  type MenuBoardFrameId,
  type MenuBoardFramePlacement,
  type MenuBoardLayout,
  type MenuBoardPlacement,
  type MenuBoardProductLook,
  type MenuBoardRect,
  type MenuBoardStyle,
} from "@purin-labs/menu-board-crdt/board";
import type { MenuDraftSnapshot } from "@purin-labs/menu-draft-crdt";
import { isPositiveInteger, isRecord } from "@purin-labs/std";
import { Select } from "@purin-labs/ui/select";
import { MenuBoardClient, type MenuBoardView } from "./board-client";
import { SAMPLE_PICKUP, ScaledBoard, draftBoardContent } from "./board-view";
import { BoardStylePanel, ITEM_ROW_NAMES } from "./board-style-panel";
import { BoardHistoryPanel } from "./board-history";
import { BoardPageViewSource } from "./board-page-view-source";
import { PromptEdit } from "./prompt-edit";
import { BoardCommentList, CommentPins, ElementComments, useBoardComments, type BoardComments } from "./board-comments";
import { CanvasEditor, CanvasPlacementFields, ELEMENT_NAMES, participantColor, unstackPlacements } from "./canvas-editor";
import { BoardViewport } from "./board-viewport";
import { StartBoard } from "./start-board";
import { ArchiveBoardButton, ArchivedBoards, parseArchivedBoards, type ArchivedBoard } from "./board-archive";
import { CanvasConsole, CanvasMenu } from "./canvas-chrome";
import { useCanvasChrome } from "@purin-labs/ui/console-tools";
import { createPortal } from "react-dom";
import { PRODUCT_DRAG_TYPE, ProductsPanel, useMenuDraftAdder, type BoardProduct } from "./products-panel";
import { IMAGE_DRAG_TYPE, ImagesPanel, imageElement, parseShopImage, useShopImages, type ShopImage } from "./images-panel";
import { StackChildFields, StackFields } from "./stack-fields";
import { toCanvas, toFrames, toShape } from "./canvas-geometry";
import { controlAnswer, controlRead, controlWrite } from "@purin-labs/control/portal/control-client";
import { controlPath } from "@purin-labs/control/portal/control-paths";
import { readMenuDraft } from "./menu-board-requests";
import "./menu-boards.css";
import "./board-workspace.css";

/**
 * Menus › Boards (Plan 40B phase 1). A board starts from a fixed layout and
 * the shop's menu. People edit it together in its shared draft; the preview
 * shows the live prices and sold-out marks. Publishing sends the board to
 * every screen that plays it. A board holds no price: a new price keeps its
 * own approval path.
 */

type BoardsState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; boards: readonly MenuBoardSummary[]; archived: readonly ArchivedBoard[] }>
  | Readonly<{ kind: "failed" }>;

type PublishState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "publishing" }>
  | Readonly<{ kind: "published"; releaseRevision: number }>
  | Readonly<{ kind: "failed"; message: string }>;

const LAYOUT_NAMES: Readonly<Record<MenuBoardLayout, string>> = {
  three_columns: "Three columns · landscape TV",
  two_columns: "Two columns · landscape TV",
  portrait_list: "List · portrait TV",
  pickup_board: "Pickup board · landscape TV",
  tablet_two_columns: "Two columns · tablet",
  portrait_pickup: "Pickup board · portrait TV",
  canvas_landscape: "Free canvas · landscape TV",
  canvas_portrait: "Free canvas · portrait TV",
  canvas_tablet: "Free canvas · tablet",
};

const PICKUP_STAGES: Readonly<Record<"preparing" | "ready", string>> = {
  preparing: "Orders that staff prepare",
  ready: "Orders ready to collect",
};

const FRAME_NAMES: Readonly<Record<MenuBoardFrameId | "stack", string>> = {
  header: "Header",
  column_1: "Column 1",
  column_2: "Column 2",
  column_3: "Column 3",
  footer: "Footer",
  canvas: "Canvas",
  stack: "In a stack",
};

const EMPTY_MENU: MenuDraftSnapshot = { title: "Café menu", sections: [], items: [] };

/**
 * The Boards workspace (Plan 40B): the board on a canvas that fills the
 * page, with the tools in floating panels over it, as in a design tool.
 * The left panel lists the boards and the layers, the toolbar floats at the
 * top, and the right panel holds the inspector and Publish.
 */
export function MenuBoardsPanel(props: Readonly<{
  organisationId: string;
  /**
   * The buttons that open the Menus sheets, once on the page: at the top of
   * the left panel, or on the start layer while it covers that panel.
   */
  menuLinks?: React.ReactNode;
  /** An open sheet over the canvas: the menu items or the screens. */
  sheet?: React.ReactNode;
}>): React.ReactNode {
  const sheetOpen = props.sheet !== undefined && props.sheet !== null;
  const [boards, setBoards] = React.useState<BoardsState>({ kind: "loading" });
  const [selected, setSelected] = React.useState<string | null>(null);
  const [menu, setMenu] = React.useState<MenuDraftSnapshot>(EMPTY_MENU);
  const [facts, setFacts] = React.useState<MenuScreenFacts | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [layersHost, setLayersHost] = React.useState<HTMLElement | null>(null);
  // A product that is not on the menu goes into the menu draft first.
  const addToMenu = useMenuDraftAdder(props.organisationId, setMenu);
  const reload = React.useCallback(async () => {
    const listed = await readBoards(props.organisationId);
    setBoards(listed);
    if (listed.kind === "ready")
      setSelected((current) =>
        current !== null && listed.boards.some((board) => board.boardId === current)
          ? current
          : listed.boards[0]?.boardId ?? null);
  }, [props.organisationId]);
  React.useEffect(() => {
    let current = true;
    void reload();
    void readMenuDraft(props.organisationId).then((draft) => {
      if (current && draft !== null) setMenu(draft.draft);
    });
    void readFacts(props.organisationId).then((read) => {
      if (current) setFacts(read);
    });
    return () => {
      current = false;
    };
    // A sheet changes the menu, its publication and the screens; the canvas
    // reads them again when the sheet closes.
  }, [props.organisationId, reload, sheetOpen]);
  const list = boards.kind === "ready" ? boards.boards : [];
  const board = list.find((candidate) => candidate.boardId === selected) ?? null;
  // The start layer covers the board list, so the sheet links move onto it.
  const starting = creating || (boards.kind === "ready" && list.length === 0);
  // On a wide screen the Portal draws no rail and no top bar here: the
  // workspace draws its own menu and the console's tools.
  const chrome = useCanvasChrome();
  const archivedList = <ArchivedBoards
    organisationId={props.organisationId}
    boards={boards.kind === "ready" ? boards.archived : []}
    onRestored={async (boardId) => {
      setCreating(false);
      setSelected(boardId);
      await reload();
    }}
  />;
  return <section className="menu-board-workspace" aria-label="Boards" data-canvas-chrome={chrome === null ? undefined : ""}><div className="menu-board-workspace-body">
    {chrome === null ? null : <CanvasMenu chrome={chrome} title={board?.title ?? null} onNewBoard={setCreating.bind(null, true)} />}
    {chrome === null ? null : <CanvasConsole chrome={chrome} />}
    <aside className="menu-board-panel menu-board-panel-start" aria-label="Boards and layers">
      {starting ? null : props.menuLinks}
      <section className="menu-board-panel-section menu-boards-list" aria-label="Board list">
        <header>
          <h3>Boards</h3>
          <button
            type="button"
            className="menu-board-text-button"
            aria-expanded={creating}
            onClick={setCreating.bind(null, !creating)}
          >
            <Plus size={14} aria-hidden="true" />
            New board
          </button>
        </header>
        {boards.kind === "failed" ? <p className="description-draft-error" role="alert">
          The boards could not be loaded. Reload the page.
        </p> : null}
        {list.length > 0 ? <div className="menu-boards-chips" role="group" aria-label="Boards">
          {list.map((summary) => <button
            key={summary.boardId}
            type="button"
            aria-pressed={summary.boardId === selected}
            onClick={setSelected.bind(null, summary.boardId)}
          >
            {summary.title}
            <span>{summary.screens === 1 ? "1 screen" : `${summary.screens} screens`}</span>
          </button>)}
        </div> : null}
        {board === null ? null : <ArchiveBoardButton
          key={board.boardId}
          organisationId={props.organisationId}
          boardId={board.boardId}
          title={board.title}
          screens={board.screens}
          onArchived={async () => {
            setSelected(null);
            await reload();
          }}
        />}
      </section>
      {list.length === 0 ? null : archivedList}
      <div className="menu-board-layers-host" ref={setLayersHost} />
    </aside>
    {starting ? <StartBoard
      organisationId={props.organisationId}
      menuLinks={props.menuLinks}
      onCancel={list.length === 0 ? null : () => setCreating(false)}
      menuSize={{ items: menu.items.length, sections: menu.sections.length }}
      archived={list.length === 0 ? archivedList : null}
      onCreated={async (boardId) => {
        setCreating(false);
        setSelected(boardId);
        await reload();
      }}
    /> : null}
    {board === null ? <div className="menu-board-viewport menu-board-viewport-empty" /> : <BoardEditor
      key={board.boardId}
      organisationId={props.organisationId}
      summary={board}
      menu={menu}
      facts={facts}
      layersHost={layersHost}
      addToMenu={addToMenu}
      onPublished={reload}
    />}
    {props.sheet}
  </div></section>;
}

const INITIAL_VIEW: MenuBoardView = {
  kind: "connecting",
  board: { title: "", layout: "three_columns", style: {}, elements: [], unplaced: [] },
  participants: [],
  agents: [],
  access: "read",
  documentRevision: null,
  changedSinceRevision: false,
};

function BoardEditor(props: Readonly<{
  organisationId: string;
  summary: MenuBoardSummary;
  menu: MenuDraftSnapshot;
  facts: MenuScreenFacts | null;
  layersHost: HTMLElement | null;
  addToMenu: (product: Readonly<{ productId: string; name: string }>) => Promise<string | null>;
  onPublished: () => Promise<void>;
}>): React.ReactNode {
  const surface = React.useRef<HTMLDivElement>(null);
  // Plan 40B phase 7: the person's own chat request, for the presence bar.
  const agentRequest = useChatAgentRequest();
  const [toolsHost, setToolsHost] = React.useState<HTMLElement | null>(null);
  const [layersSlot, setLayersSlot] = React.useState<HTMLElement | null>(null);
  const [leftTab, setLeftTab] = React.useState<"layers" | "products" | "images">("layers");
  // The shop's images, for the Images tab and the board's image elements.
  const shopImages = useShopImages(props.organisationId);
  const [productError, setProductError] = React.useState<string | null>(null);
  const client = React.useRef<MenuBoardClient | null>(null);
  const [view, setView] = React.useState<MenuBoardView>(INITIAL_VIEW);
  const [selection, setSelection] = React.useState<readonly string[]>([]);
  const selected = selection.length === 1 ? (selection[0] ?? null) : null;
  const [publish, setPublish] = React.useState<PublishState>({ kind: "idle" });
  const preview = React.useRef<HTMLDivElement>(null);
  const boardArea = React.useRef<HTMLDivElement>(null);
  const comments = useBoardComments(props.organisationId, props.summary.boardId);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  // The chat sees this board and the selection when the person sends a
  // message (Plan 40B phase 5, slice 9).
  const pageView = React.useMemo(() => new BoardPageViewSource(), []);
  React.useEffect(() => {
    pageView.register();
    return () => pageView.unregister();
  }, [pageView]);
  React.useEffect(() => {
    if (surface.current === null) return;
    const connected = new MenuBoardClient(props.organisationId, props.summary.boardId, surface.current, setView);
    client.current = connected;
    return () => {
      client.current = null;
      connected.dispose();
    };
  }, [props.organisationId, props.summary.boardId]);
  const board = view.board;
  pageView.snapshot = {
    organisationId: props.organisationId,
    boardId: props.summary.boardId,
    board,
    selection,
    names: ELEMENT_NAMES,
  };
  const editable = view.access === "edit" && view.kind !== "failed";
  const selectedElements = selection.flatMap((id) => {
    const found = [...board.elements, ...board.unplaced].find((candidate) => candidate.id === id);
    return found === undefined ? [] : [found];
  });
  const prompt = selectedElements.length === 0 ? null : <PromptEdit
    key={selection.join(",")}
    organisationId={props.organisationId}
    board={board}
    selection={selectedElements}
    agents={view.agents}
    editable={editable}
    client={client}
    names={ELEMENT_NAMES}
  />;
  const element = board.elements.find((candidate) => candidate.id === selected) ??
    board.unplaced.find((candidate) => candidate.id === selected) ?? null;
  const selectMany = (elementIds: readonly string[]): void => {
    setSelection(elementIds);
    const first = elementIds[0];
    client.current?.select(first === undefined ? null : { kind: "element", elementId: first });
  };
  const select = (elementId: string | null): void => selectMany(elementId === null ? [] : [elementId]);
  const canvas = MENU_BOARD_LAYOUTS[board.layout].canvas;
  const changeLayout = (layout: MenuBoardLayout): void => {
    const target = MENU_BOARD_LAYOUTS[layout];
    const all = [...board.elements, ...board.unplaced];
    if (layout === board.layout) return;
    if (target.canvas && canvas) client.current?.arrangeLayout(layout, toShape(all, board.layout, layout));
    else if (target.canvas) {
      const measured = measureElements(preview.current, MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[board.layout].shape].width);
      client.current?.arrangeLayout(
        layout,
        toCanvas(all, measured, MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[board.layout].shape], layout),
      );
    } else if (canvas) {
      // A fixed layout has no stacks (slice 8): their elements go to the
      // columns where the stack showed them, and the stacks go.
      const size = MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[board.layout].shape];
      const rects = menuBoardCanvasRects(all, size, size);
      const stacks = all.filter((candidate) => candidate.kind === "stack").map((candidate) => candidate.id);
      const out = new Map(stacks.flatMap((stackId) => unstackPlacements(all, stackId, rects))
        .map((entry) => [entry.elementId, entry.placement] as const));
      const flat = all
        .filter((candidate) => candidate.kind !== "stack")
        .map((candidate) => ({ ...candidate, placement: out.get(candidate.id) ?? candidate.placement }) as MenuBoardElement);
      client.current?.arrangeLayout(layout, toFrames(flat, size, layout), stacks);
    }
    else client.current?.setLayout(layout);
  };
  const release = props.summary.release;
  const changed = release === null || view.documentRevision === null ||
    view.documentRevision !== release.documentRevision || view.changedSinceRevision || view.kind === "syncing";
  // Undo and redo work in every layout, so that a move to the free canvas
  // and back is one step each way (Plan 40B phase 5).
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!editable || isTypingTarget(event.target)) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (!mod || (key !== "z" && key !== "y")) return;
    event.preventDefault();
    if (key === "y" || event.shiftKey) client.current?.redo();
    else client.current?.undo();
  };
  /**
   * Puts a product on the board (the Products panel): at the point of a
   * drop on a free canvas, at its centre for the + button, or at the end
   * of the first column of a fixed layout.
   */
  const addProduct = async (product: BoardProduct, point: Readonly<{ x: number; y: number }> | null): Promise<void> => {
    setProductError(null);
    const itemId = product.kind === "item"
      ? product.itemId
      : await props.addToMenu({ productId: product.productId, name: product.name });
    if (itemId === null) {
      setProductError(`${product.name} could not be added to the menu draft. Add it on Items, then try again.`);
      return;
    }
    const added = productElement(board, itemId, point);
    client.current?.addElement(added);
    select(added.id);
  };
  /** Puts an image of the shop's library on a free canvas. */
  const addImage = (image: ShopImage, point: Readonly<{ x: number; y: number }> | null): void => {
    if (!canvas) return;
    const added = imageElement(board, image, point);
    client.current?.addElement(added);
    select(added.id);
  };
  const productDrop = {
    accepts: (event: React.DragEvent) => editable && (event.dataTransfer.types.includes(PRODUCT_DRAG_TYPE) ||
      (canvas && event.dataTransfer.types.includes(IMAGE_DRAG_TYPE))),
    onDrop: (event: React.DragEvent) => {
      const frame = boardArea.current?.querySelector<HTMLElement>(".menu-board-frame")?.getBoundingClientRect();
      const size = MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[board.layout].shape];
      const point = frame === undefined || frame.width === 0
        ? null
        : { x: ((event.clientX - frame.left) / frame.width) * size.width, y: ((event.clientY - frame.top) / frame.height) * size.height };
      const image = parseShopImage(event.dataTransfer.getData(IMAGE_DRAG_TYPE));
      if (image !== null) {
        addImage(image, point);
        return;
      }
      const product = parseBoardProduct(event.dataTransfer.getData(PRODUCT_DRAG_TYPE));
      if (product !== null) void addProduct(product, point);
    },
  };
  const left = props.layersHost === null ? null : createPortal(<div className="menu-board-left">
    <div className="menu-board-left-tabs" role="tablist" aria-label="Layers and products">
      {canvas ? <button type="button" role="tab" aria-selected={leftTab === "layers"} onClick={() => setLeftTab("layers")}>Layers</button> : null}
      <button type="button" role="tab" aria-selected={leftTab === "products" || !canvas} onClick={() => setLeftTab("products")}>Products</button>
      {canvas ? <button type="button" role="tab" aria-selected={leftTab === "images"} onClick={() => setLeftTab("images")}>Images</button> : null}
    </div>
    <div className="menu-board-left-slot" ref={setLayersSlot} hidden={!canvas || leftTab !== "layers"} />
    {canvas && leftTab === "images" ? <ImagesPanel
      organisationId={props.organisationId}
      shop={shopImages}
      editable={editable}
      onAdd={(image) => addImage(image, null)}
    /> : null}
    {leftTab === "products" || !canvas ? <ProductsPanel
      organisationId={props.organisationId}
      menu={props.menu}
      facts={props.facts}
      editable={editable}
      onAdd={(product) => void addProduct(product, null)}
    /> : null}
  </div>, props.layersHost);
  const content = draftBoardContent(board, props.menu, shopImages.mediaBase);
  const boardFacts = { facts: props.facts, verified: true, pickup: SAMPLE_PICKUP };
  const pins = <CommentPins area={boardArea} threads={comments.threads} revision={board} onOpen={select} />;
  const others = view.participants.filter((participant) => !participant.isSelf);
  const inspector = historyOpen ? <BoardHistoryPanel
    organisationId={props.organisationId}
    boardId={props.summary.boardId}
    editable={editable}
    documentRevision={view.documentRevision}
    onClose={() => setHistoryOpen(false)}
  /> : element === null ? <div className="menu-boards-side">
    {prompt}
    <BoardCommentList
      comments={comments}
      elements={[...board.elements, ...board.unplaced]}
      names={ELEMENT_NAMES}
      onOpen={select}
      editable={editable}
    />
    <BoardStylePanel style={board.style} editable={editable} client={client} />
  </div> : <ElementDrawer
    element={element}
    layout={board.layout}
    style={board.style}
    menu={props.menu}
    editable={editable}
    client={client}
    comments={comments}
    prompt={prompt}
    elements={[...board.elements, ...board.unplaced]}
    onClose={() => select(null)}
    onRemove={() => {
      if (element.kind === "stack") {
        const size = MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[board.layout].shape];
        const all = [...board.elements, ...board.unplaced];
        // A removed stack leaves its elements on the canvas where it showed them.
        client.current?.unstack(element.id, unstackPlacements(all, element.id, menuBoardCanvasRects(all, size, size)));
      } else client.current?.removeElement(element.id);
      select(null);
    }}
    nextOrder={(frameId) => nextOrder(board, frameId)}
  />;
  return <div className="menu-boards-editor" ref={surface} onKeyDown={onKeyDown} data-canvas={canvas ? "true" : undefined}>
    {canvas ? <CanvasEditor
      board={board}
      content={content}
      facts={boardFacts}
      editable={editable}
      client={client}
      participants={view.participants}
      agents={view.agents}
      agentRequest={agentRequest === null ? null : {
        agentSessionId: agentRequest.sessionId,
        latestLine: agentRequest.latestLine,
        stopping: agentRequest.stopping,
        stop: agentRequest.stop,
      }}
      selection={selection}
      onSelect={selectMany}
      toolsHost={toolsHost}
      layersHost={layersSlot}
      drop={productDrop}
      stageChildren={pins}
      stageRef={boardArea}
      fitKey={board.layout}
    /> : <BoardViewport
      design={MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[board.layout].shape]}
      fitKey={board.layout}
      stageChildren={pins}
      stageRef={boardArea}
      label={`${board.title} · ${LAYOUT_NAMES[board.layout]}`}
      onBackgroundClick={() => select(null)}
      drop={productDrop}
    >
      {(width) => <div className="menu-boards-preview" ref={preview} style={{ width }} onClick={() => select(null)}>
        <ScaledBoard
          content={content}
          facts={boardFacts}
          selectedElementId={selected}
          onSelectElement={editable ? select : undefined}
        />
      </div>}
    </BoardViewport>}
    <div className="menu-board-float menu-board-toolbar menu-boards-toolbar" role="toolbar" aria-label="Board tools">
      <label className="menu-board-toolbar-field">
        <span>Layout</span>
        <Select.Root
          items={LAYOUT_NAMES}
          value={board.layout}
          disabled={!editable}
          onValueChange={(value) => {
            if (value !== null) changeLayout(value);
          }}
        >
          <Select.Trigger variant="ghost"><Select.Value /></Select.Trigger>
          <Select.Popup>{(Object.keys(LAYOUT_NAMES) as MenuBoardLayout[]).map((key) => <Select.Item key={key} value={key}>{LAYOUT_NAMES[key]}</Select.Item>)}</Select.Popup>
        </Select.Root>
      </label>
      <span className="menu-board-toolbar-divider" aria-hidden="true" />
      <label className="menu-board-toolbar-field">
        <span>Add</span>
        <Select.Root
          items={{ "": "Add an element…", ...ELEMENT_NAMES }}
          value=""
          disabled={!editable}
          onValueChange={(value) => {
            if (value === null) return;
            const added = newElement(value, board, props.menu);
            if (added === null) return;
            client.current?.addElement(added);
            select(added.id);
          }}
        >
          <Select.Trigger variant="ghost"><Select.Value /></Select.Trigger>
          <Select.Popup>
            <Select.Item value="">Add an element…</Select.Item>
            {(Object.keys(ELEMENT_NAMES) as MenuBoardElement["kind"][]).map((kind) => <Select.Item key={kind} value={kind}>{ELEMENT_NAMES[kind]}</Select.Item>)}
          </Select.Popup>
        </Select.Root>
      </label>
      <span className="menu-board-toolbar-divider" aria-hidden="true" />
      <span className="menu-boards-history" role="group" aria-label="Undo and redo">
        <button type="button" className="menu-board-icon-button" aria-label="Undo" title="Undo (Ctrl Z)" disabled={!editable || client.current?.canUndo() !== true} onClick={() => client.current?.undo()}>
          <Undo2 size={16} aria-hidden="true" />
        </button>
        <button type="button" className="menu-board-icon-button" aria-label="Redo" title="Redo (Ctrl Shift Z)" disabled={!editable || client.current?.canRedo() !== true} onClick={() => client.current?.redo()}>
          <Redo2 size={16} aria-hidden="true" />
        </button>
      </span>
    </div>
    <aside className="menu-board-panel menu-board-panel-end" aria-label="Inspector">
      <header className="menu-board-panel-actions">
        <span className="menu-board-people" aria-label={others.length === 0 ? "Only you on this board" : `${others.length + 1} people on this board`}>
          {others.slice(0, 4).map((participant) => <span
            key={participant.sessionId}
            className="menu-board-person"
            title={participant.displayName}
            style={{ "--participant": participantColor(participant.userId) } as React.CSSProperties}
          >
            {initialsOf(participant.displayName)}
          </span>)}
        </span>
        <span className="description-draft-sync-status" data-state={view.kind}>{connectionLabel(view)}</span>
        <button
          type="button"
          className="menu-board-icon-button"
          aria-label="History"
          aria-pressed={historyOpen}
          title="Version history"
          onClick={() => setHistoryOpen(!historyOpen)}
        >
          <History size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="menu-boards-primary"
          disabled={!editable || publish.kind === "publishing" || board.unplaced.length > 0 || view.kind !== "synced" || !changed}
          onClick={() => void publishBoard(props.organisationId, props.summary, client.current, setPublish, props.onPublished)}
        >
          {publish.kind === "publishing"
            ? "Publishing…"
            : props.summary.screens === 0
              ? "Publish"
              : `Publish to ${props.summary.screens === 1 ? "1 screen" : `${props.summary.screens} screens`}`}
        </button>
      </header>
      <p className="menu-boards-publish">
        {release === null
          ? "Not published yet."
          : `Published revision ${release.releaseRevision}${changed ? " · changes not published" : ""}.`}
      </p>
      <div className="menu-board-align-row" ref={setToolsHost} />
      <div className="menu-board-panel-body">{inspector}</div>
    </aside>
    {left}
    <div className="menu-board-notices">
      {productError === null ? null : <p className="menu-board-float description-draft-error" role="alert">{productError}</p>}
      {board.unplaced.length > 0 ? <div className="menu-board-float menu-boards-unplaced" role="alert">
        <strong>{board.unplaced.length === 1 ? "One element has no place in this layout." : `${board.unplaced.length} elements have no place in this layout.`}</strong>
        <span>Move them before you publish.</span>
        <ul>
          {board.unplaced.map((loose) => <li key={loose.id}>
            {ELEMENT_NAMES[loose.kind]}
            <button
              type="button"
              className="secondary"
              disabled={!editable}
              onClick={() => client.current?.moveElement(loose.id, canvas
                ? newCanvasPlacement(board)
                : { frameId: firstColumn(board.layout), order: nextOrder(board, firstColumn(board.layout)) })}
            >
              {canvas ? "Place on the canvas" : "Move to the first column"}
            </button>
          </li>)}
        </ul>
      </div> : null}
      {publish.kind === "failed" ? <p className="menu-board-float description-draft-error" role="alert">{publish.message}</p> : null}
      {publish.kind === "published" ? <p className="menu-board-float content-studio-published" role="status">
        Published revision {publish.releaseRevision}. Screens change within a few seconds.
      </p> : null}
      {!editable ? <p className="menu-board-float menu-boards-hint">You can see this board. Staff, admins and owners can change it.</p> : null}
    </div>
  </div>;
}

const LOOK_NAMES: Readonly<Record<MenuBoardProductLook, string>> = {
  card: "Card",
  row: "Row",
  tile: "Tile",
  price: "Big price",
};

/** A product element for a menu item, where a person put it. */
function productElement(
  board: MenuBoardView["board"],
  itemId: string,
  point: Readonly<{ x: number; y: number }> | null,
): MenuBoardElement {
  const id = `element_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  if (!MENU_BOARD_LAYOUTS[board.layout].canvas) {
    const frameId = firstColumn(board.layout);
    return { id, kind: "featured", placement: { frameId, order: nextOrder(board, frameId) }, itemId, label: "", note: "", look: "row" };
  }
  const size = MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[board.layout].shape];
  const width = Math.round(Math.min(size.width, size.height) / 2.6);
  const height = Math.round(width * 0.75);
  const center = point ?? { x: size.width / 2, y: size.height / 2 };
  const rect: MenuBoardRect = {
    x: Math.round(Math.max(0, Math.min(size.width - width, center.x - width / 2))),
    y: Math.round(Math.max(0, Math.min(size.height - height, center.y - height / 2))),
    width,
    height,
  };
  const order = [...board.elements, ...board.unplaced].reduce((highest, element) => Math.max(highest, element.placement.order + 1), 0);
  return { id, kind: "featured", placement: { frameId: "canvas", order, rect, constraints: MENU_BOARD_DEFAULT_CONSTRAINTS }, itemId, label: "", note: "", look: "card" };
}

function parseBoardProduct(raw: string): BoardProduct | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.name !== "string") return null;
    if (value.kind === "item" && typeof value.itemId === "string") return { kind: "item", itemId: value.itemId, name: value.name };
    if (value.kind === "product" && typeof value.productId === "string") return { kind: "product", productId: value.productId, name: value.name };
    return null;
  } catch {
    return null;
  }
}

function initialsOf(name: string): string {
  return name.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function ElementDrawer(props: Readonly<{
  element: MenuBoardElement;
  layout: MenuBoardLayout;
  style: MenuBoardStyle;
  menu: MenuDraftSnapshot;
  editable: boolean;
  client: React.RefObject<MenuBoardClient | null>;
  comments: BoardComments;
  /** Prompt to edit for the selected element (slice 9). */
  prompt: React.ReactNode;
  /** Every element of the board, for the stack fields (slice 8). */
  elements: readonly MenuBoardElement[];
  onClose: () => void;
  onRemove: () => void;
  nextOrder: (frameId: MenuBoardFramePlacement["frameId"]) => number;
}>): React.ReactNode {
  const { element } = props;
  const placement = element.placement;
  const change = (key: string, value: string): void => {
    props.client.current?.updateElement(element.id, { [key]: value });
  };
  const text = (key: string, label: string, value: string): React.ReactNode => <label key={key}>
    <span>{label}</span>
    <input
      value={value}
      maxLength={MENU_BOARD_TEXT_LIMIT}
      disabled={!props.editable}
      onChange={(event) => change(key, event.target.value)}
    />
  </label>;
  return <aside className="menu-boards-drawer" aria-label={`Selected ${ELEMENT_NAMES[element.kind].toLowerCase()}`}>
    <header>
      <div>
        <span>{FRAME_NAMES[element.placement.frameId]}</span>
        <h3>{ELEMENT_NAMES[element.kind]}</h3>
      </div>
      <button type="button" className="secondary" onClick={props.onClose}>Done</button>
    </header>
    {props.prompt}
    {element.kind === "heading" ? <>
      {text("eyebrow", "Small line above", element.eyebrow)}
      {text("title", "Title", element.title)}
      {text("detail", "Line on the right", element.detail)}
    </> : null}
    {element.kind === "section" ? <>
      <label>
        <span>Menu section</span>
        <Select.Root items={props.menu.sections.map((section) => ({ value: section.id, label: section.title }))} value={element.sectionId} disabled={!props.editable} onValueChange={(value) => { if (value !== null) change("sectionId", value); }}>
          <Select.Trigger><Select.Value /></Select.Trigger>
          <Select.Popup>{props.menu.sections.map((section) => <Select.Item key={section.id} value={section.id}>{section.title}</Select.Item>)}</Select.Popup>
        </Select.Root>
      </label>
      {text("note", "Note under the title", element.note)}
      <label>
        <span>Item rows</span>
        <Select.Root
          items={{ "": `The board’s default (${ITEM_ROW_NAMES[props.style.itemRow ?? "line"].toLowerCase()})`, ...ITEM_ROW_NAMES }}
          value={element.row ?? ""}
          disabled={!props.editable}
          onValueChange={(value) => { if (value !== null) change("row", value); }}
        >
          <Select.Trigger><Select.Value /></Select.Trigger>
          <Select.Popup>
            <Select.Item value="">The board’s default ({ITEM_ROW_NAMES[props.style.itemRow ?? "line"].toLowerCase()})</Select.Item>
            {MENU_BOARD_ITEM_ROWS.map((row) => <Select.Item key={row} value={row}>{ITEM_ROW_NAMES[row]}</Select.Item>)}
          </Select.Popup>
        </Select.Root>
      </label>
      <p className="menu-boards-drawer-note">Items, prices and sold-out marks come from the published menu.</p>
    </> : null}
    {element.kind === "featured" ? <>
      <div className="menu-board-looks" role="group" aria-label="Look">
        {MENU_BOARD_PRODUCT_LOOKS.map((look) => <button
          key={look}
          type="button"
          aria-pressed={(element.look ?? "card") === look}
          disabled={!props.editable}
          onClick={() => change("look", look)}
        >
          {LOOK_NAMES[look]}
        </button>)}
      </div>
      <label>
        <span>Item</span>
        <Select.Root items={props.menu.items.map((item) => ({ value: item.id, label: item.displayName }))} value={element.itemId} disabled={!props.editable} onValueChange={(value) => { if (value !== null) change("itemId", value); }}>
          <Select.Trigger><Select.Value /></Select.Trigger>
          <Select.Popup>{props.menu.items.map((item) => <Select.Item key={item.id} value={item.id}>{item.displayName}</Select.Item>)}</Select.Popup>
        </Select.Root>
      </label>
      {text("label", "Label", element.label)}
      {text("note", "Note", element.note)}
      <p className="menu-boards-drawer-note">The price comes from the shop. A new price goes to the owner for approval.</p>
    </> : null}
    {element.kind === "image" ? <>
      <div className="menu-board-looks" role="group" aria-label="Fit">
        {(["cover", "contain"] as const).map((fit) => <button
          key={fit}
          type="button"
          aria-pressed={element.fit === fit}
          disabled={!props.editable}
          onClick={() => change("fit", fit)}
        >
          {fit === "cover" ? "Fill" : "Fit inside"}
        </button>)}
      </div>
      {text("altText", "What the image shows", element.altText)}
      <p className="menu-boards-drawer-note">Screens read this text aloud for people who cannot see the image.</p>
    </> : null}
    {element.kind === "order_qr" ? <>
      {text("title", "Title", element.title)}
      {text("detail", "Detail", element.detail)}
    </> : null}
    {element.kind === "pickup_codes" ? <>
      <label>
        <span>Shows</span>
        <Select.Root items={PICKUP_STAGES} value={element.stage} disabled={!props.editable} onValueChange={(value) => { if (value !== null) change("stage", value); }}>
          <Select.Trigger><Select.Value /></Select.Trigger>
          <Select.Popup>{Object.entries(PICKUP_STAGES).map(([value, label]) => <Select.Item key={value} value={value}>{label}</Select.Item>)}</Select.Popup>
        </Select.Root>
      </label>
      {text("title", "Title", element.title)}
      <p className="menu-boards-drawer-note">The screen shows the shop's live order codes. These codes are examples.</p>
    </> : null}
    {element.kind === "text" ? text("text", "Text", element.text) : null}
    {element.kind === "stack" ? <StackFields element={element} elements={props.elements} editable={props.editable} client={props.client} onUnstacked={props.onClose} /> : null}
    {placement.frameId === "stack"
      ? <StackChildFields element={element} placement={placement} elements={props.elements} editable={props.editable} client={props.client} />
      : placement.frameId === "canvas"
      ? <CanvasPlacementFields element={element} placement={placement} editable={props.editable} client={props.client} />
      : <label>
        <span>Place</span>
        <Select.Root
          items={FRAME_NAMES}
          value={placement.frameId}
          disabled={!props.editable}
          onValueChange={(value) => {
            if (value === null) return;
            const frameId = value as MenuBoardFramePlacement["frameId"];
            props.client.current?.moveElement(element.id, { frameId, order: props.nextOrder(frameId) });
          }}
        >
          <Select.Trigger><Select.Value /></Select.Trigger>
          <Select.Popup>{MENU_BOARD_LAYOUTS[props.layout].frames.filter(isFrame).map((frame) => <Select.Item key={frame} value={frame}>{FRAME_NAMES[frame]}</Select.Item>)}</Select.Popup>
        </Select.Root>
      </label>}
    <div className="menu-boards-drawer-actions">
      {placement.frameId === "canvas" || placement.frameId === "stack" ? null : <>
        <button
          type="button"
          className="secondary"
          disabled={!props.editable || placement.order === 0}
          onClick={() => props.client.current?.moveElement(element.id, { ...placement, order: Math.max(0, placement.order - 1) })}
        >
          Move up
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!props.editable}
          onClick={() => props.client.current?.moveElement(element.id, { ...placement, order: placement.order + 1 })}
        >
          Move down
        </button>
      </>}
      <button type="button" className="secondary" disabled={!props.editable} onClick={props.onRemove}>
        Remove from board
      </button>
    </div>
    <ElementComments elementId={element.id} comments={props.comments} editable={props.editable} />
  </aside>;
}

/**
 * A new element of `kind`: at the end of the layout's first column, or on
 * a free canvas in front of the others, near the board's centre.
 */
function newElement(
  kind: string,
  board: MenuBoardView["board"],
  menu: MenuDraftSnapshot,
): MenuBoardElement | null {
  const id = `element_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const frameId: MenuBoardFramePlacement["frameId"] = kind === "heading" ? "header" : firstColumn(board.layout);
  const placement: MenuBoardPlacement = MENU_BOARD_LAYOUTS[board.layout].canvas
    ? newCanvasPlacement(board)
    : { frameId, order: nextOrder(board, frameId) };
  switch (kind) {
    case "heading":
      return { id, kind, placement, eyebrow: "", title: board.title, detail: "" };
    case "section": {
      const section = menu.sections[0];
      return section === undefined ? null : { id, kind, placement, sectionId: section.id, note: "" };
    }
    case "featured": {
      const item = menu.items[0];
      return item === undefined ? null : { id, kind, placement, itemId: item.id, label: "Today’s pick", note: "" };
    }
    case "order_qr":
      return { id, kind, placement, title: "Order ahead", detail: "Scan to order and pay on your phone." };
    case "pickup_codes":
      return { id, kind, placement, stage: "ready", title: "Ready" };
    case "text":
      return { id, kind, placement, text: "" };
    default:
      return null;
  }
}

function newCanvasPlacement(board: MenuBoardView["board"]): MenuBoardPlacement {
  const size = MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[board.layout].shape];
  const width = Math.round(size.width / 3);
  const height = Math.round(size.height / 4);
  const rect: MenuBoardRect = {
    x: Math.round((size.width - width) / 2),
    y: Math.round((size.height - height) / 2),
    width,
    height,
  };
  const order = [...board.elements, ...board.unplaced].reduce(
    (highest, element) => Math.max(highest, element.placement.order + 1),
    0,
  );
  return { frameId: "canvas", order, rect, constraints: MENU_BOARD_DEFAULT_CONSTRAINTS };
}

function isTypingTarget(target: EventTarget): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

function firstColumn(layout: MenuBoardLayout): MenuBoardFramePlacement["frameId"] {
  return MENU_BOARD_LAYOUTS[layout].frames.filter(isFrame).find((frame) => frame.startsWith("column_")) ?? "column_1";
}

function isFrame(frame: MenuBoardFrameId): frame is MenuBoardFramePlacement["frameId"] {
  return frame !== "canvas";
}

function nextOrder(board: MenuBoardView["board"], frameId: MenuBoardFrameId): number {
  let order = -1;
  for (const element of [...board.elements, ...board.unplaced])
    if (element.placement.frameId === frameId) order = Math.max(order, element.placement.order);
  return order + 1;
}

/**
 * The boxes that the browser drew for a fixed layout's elements, in board
 * units, so that the free canvas starts from what the person saw.
 */
function measureElements(preview: HTMLElement | null, boardWidth: number): Map<string, MenuBoardRect> {
  const measured = new Map<string, MenuBoardRect>();
  const surface = preview?.querySelector<HTMLElement>(".menu-board");
  if (surface === null || surface === undefined) return measured;
  const box = surface.getBoundingClientRect();
  if (box.width === 0) return measured;
  const scale = box.width / boardWidth;
  for (const element of surface.querySelectorAll<HTMLElement>("[data-element-id]")) {
    const id = element.dataset.elementId;
    if (id === undefined) continue;
    const rect = element.getBoundingClientRect();
    measured.set(id, {
      x: Math.round((rect.left - box.left) / scale),
      y: Math.round((rect.top - box.top) / scale),
      width: Math.max(16, Math.round(rect.width / scale)),
      height: Math.max(16, Math.round(rect.height / scale)),
    });
  }
  return measured;
}

/**
 * Publishes the board revision that the person sees. The editor publishes
 * only when every local edit is saved. The room then confirms the revision
 * of the board on the screen; if a collaborator changed the board and the
 * screen did not show it yet, the screen shows it now and nothing is
 * published, so that the person can look at it first.
 */
async function publishBoard(
  organisationId: string,
  summary: MenuBoardSummary,
  client: MenuBoardClient | null,
  setPublish: (state: PublishState) => void,
  onPublished: () => Promise<void>,
): Promise<void> {
  setPublish({ kind: "publishing" });
  const shown = await (client?.checkShown() ?? Promise.resolve({ kind: "unavailable" } as const));
  if (shown.kind !== "current") {
    setPublish({
      kind: "failed",
      message: shown.kind === "changed"
        ? publishFailure({ error: "menu_board_changed" })
        : "The board could not be read. Try again.",
    });
    return;
  }
  const listed = await readBoards(organisationId);
  const current = listed.kind === "ready"
    ? listed.boards.find((candidate) => candidate.boardId === summary.boardId)
    : undefined;
  if (current === undefined) {
    setPublish({ kind: "failed", message: "The board could not be read. Try again." });
    return;
  }
  const answer = await controlAnswer(
    controlWrite(controlPath(organisationId, `menu-boards/${encodeURIComponent(summary.boardId)}/releases`), "POST", {
      documentRevision: shown.documentRevision,
      expectedReleaseRevision: current.release?.releaseRevision ?? null,
    }),
  );
  const raw = answer.body;
  if (answer.ok && isRecord(raw) && isRecord(raw.release) && isPositiveInteger(raw.release.releaseRevision)) {
    setPublish({ kind: "published", releaseRevision: raw.release.releaseRevision });
    await onPublished();
    return;
  }
  setPublish({ kind: "failed", message: publishFailure(raw) });
}

function publishFailure(raw: unknown): string {
  switch (isRecord(raw) ? raw.error : undefined) {
    case "organisation_role_insufficient":
      return "Only staff, admins and owners can publish a board.";
    case "menu_board_changed":
      return "Someone else changed the board. Check the preview, then publish again.";
    case "menu_board_release_conflict":
      return "Someone changed or published the board at the same time. Check the preview, then publish again.";
    case "menu_board_unplaced":
      return "Move the elements that have no place, then publish.";
    case "menu_board_empty":
      return "Add at least one element, then publish.";
    case "menu_board_binding_missing":
      return "An element names a menu section or an item that the menu no longer has. Choose another one, then publish.";
    default:
      return "The board could not be published. Try again.";
  }
}

function connectionLabel(view: MenuBoardView): string {
  switch (view.kind) {
    case "connecting":
      return "Connecting…";
    case "syncing":
      return "Saving…";
    case "synced":
      return "Saved";
    case "reconnecting":
      return "Reconnecting…";
    case "failed":
      return view.message;
    default:
      return view satisfies never;
  }
}

async function readBoards(organisationId: string): Promise<BoardsState> {
  const answer = await controlAnswer(controlRead(controlPath(organisationId, "menu-boards")));
  const raw = answer.body;
  const boards = answer.ok && isRecord(raw) ? parseMenuBoardSummaries(raw.boards) : null;
  return boards === null || !isRecord(raw)
    ? { kind: "failed" }
    : { kind: "ready", boards, archived: parseArchivedBoards(raw.archivedBoards) };
}

async function readFacts(organisationId: string): Promise<MenuScreenFacts | null> {
  const answer = await controlAnswer(controlRead(controlPath(organisationId, "menu-boards/facts")));
  const raw = answer.body;
  return answer.ok && isRecord(raw) && raw.facts !== null ? parseMenuScreenFacts(raw.facts) : null;
}
