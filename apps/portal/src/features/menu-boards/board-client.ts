import {
  MENU_BOARD_ID_PROPS,
  MENU_BOARD_OPTIONAL_PROPS,
  MENU_BOARD_TEXT_PROPS,
  MenuBoardDoc,
  menuBoardElementProps,
  type MenuBoardCrdtResult,
  type MenuBoardElement,
  type MenuBoardElementPlacement,
  type MenuBoardLayout,
  type MenuBoardMovingSelection,
  type MenuBoardPlacement,
  type MenuBoardPresenceSelection,
  type MenuBoardPropChanges,
  type MenuBoardSnapshot,
  type MenuBoardStateVector,
  type MenuBoardStyleChanges,
  type MenuBoardUpdate,
} from "@seams/menu-board-crdt";
import {
  encodeMenuBoardClientMessage,
  parseMenuBoardServerMessage,
  POINTER_IDLE_MS,
  type MenuBoardClientMessage,
  type MenuBoardFailureCode,
  type MenuBoardParticipant,
  type MenuBoardServerMessage,
} from "@seams/menu-board-crdt/protocol";
import type {
  CollaborationAgentActivity,
  CollaborationPointerPosition,
} from "@seams/collaboration";
import { assertNever } from "@seams/std";
import { SocketLiveness } from "../collaboration/socket-liveness";

/**
 * The Portal's side of one board's shared draft (Plan 40B). It is the menu
 * draft client with the board's document: each edit applies locally at
 * once, goes to the room one at a time, and waits for the room's
 * acknowledgement before the next.
 */

type Connection =
  | Readonly<{ kind: "connecting" | "awaiting_sync" | "syncing" | "connected"; socket: WebSocket }>
  | Readonly<{ kind: "reconnecting"; timer: ReturnType<typeof setTimeout> }>
  | Readonly<{ kind: "failed"; code: MenuBoardFailureCode }>
  | Readonly<{ kind: "closed" }>;

type Pending =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "sync" | "edit"; updateId: string; revision: number; stateVector: MenuBoardStateVector }>;

export type MenuBoardView = Readonly<{
  board: MenuBoardSnapshot;
  participants: readonly MenuBoardPresenceView[];
  /** What each agent works on or just changed (the room holds it 5 s). */
  agents: readonly CollaborationAgentActivity[];
  access: "read" | "edit";
  /** The draft revision that the room named when this editor last synced. */
  documentRevision: number | null;
  /**
   * The board changed after the room named `documentRevision`: an edit here
   * or a collaborator's edit. The room saves each change as a new revision,
   * so the board is no longer the one at `documentRevision`.
   */
  changedSinceRevision: boolean;
}> & (
  | Readonly<{ kind: "connecting" | "syncing" | "synced" | "reconnecting" }>
  | Readonly<{ kind: "failed"; message: string }>
);

export type MenuBoardPresenceView = MenuBoardParticipant & Readonly<{ isSelf: boolean }>;

/**
 * What the room holds against the board on the screen: the same board at
 * `documentRevision`, a newer board that the screen now shows, or no answer.
 */
type MenuBoardShownCheck =
  | Readonly<{ kind: "current"; documentRevision: number }>
  | Readonly<{ kind: "changed" }>
  | Readonly<{ kind: "unavailable" }>;

type ShownCheck = Readonly<{
  board: string;
  revision: number;
  resolve: (check: MenuBoardShownCheck) => void;
}>;

/**
 * One local edit, kept so that this person can undo it (Plan 40B phase 5).
 * Undo applies the edit's inverse as a new edit, so it undoes only this
 * person's own changes and never another person's.
 */
type BoardOperation =
  | Readonly<{ kind: "rename"; title: string }>
  | Readonly<{ kind: "props"; elementId: string; changes: MenuBoardPropChanges }>
  | Readonly<{ kind: "add"; element: MenuBoardElement }>
  | Readonly<{ kind: "remove"; elementId: string }>
  | Readonly<{ kind: "place"; placements: readonly MenuBoardElementPlacement[] }>
  | Readonly<{ kind: "style"; changes: MenuBoardStyleChanges }>
  | Readonly<{
      kind: "layout";
      layout: MenuBoardLayout;
      placements: readonly MenuBoardElementPlacement[];
    }>;

type HistoryEntry = Readonly<{
  inverse: readonly BoardOperation[];
  /** Typing in one field joins one entry, so that one undo removes a word. */
  mergeKey: string | null;
  at: number;
}>;

const HISTORY_LIMIT = 100;
/** A drag's presence goes at most this often (Plan 40B phase 5, slice 5). */
const MOVING_INTERVAL_MS = 66;
const HISTORY_MERGE_MS = 1_000;

export class MenuBoardClient {
  readonly #doc: MenuBoardDoc;
  readonly #url: string;
  readonly #surface: HTMLElement;
  readonly #notify: (view: MenuBoardView) => void;
  #connection: Connection = { kind: "closed" };
  #pending: Pending = { kind: "idle" };
  #participants: readonly MenuBoardParticipant[] = [];
  #agents: readonly CollaborationAgentActivity[] = [];
  #selection: MenuBoardPresenceSelection | null = null;
  #access: "read" | "edit" = "read";
  #documentRevision: number | null = null;
  #changedSinceRevision = false;
  #check: ShownCheck | null = null;
  #sessionId: string | null = null;
  #revision = 0;
  #acknowledgedRevision = 0;
  #attempts = 0;
  #pointer: CollaborationPointerPosition | null = null;
  #pointerTimer: ReturnType<typeof setTimeout> | null = null;
  #pointerIdle: ReturnType<typeof setTimeout> | null = null;
  #liveness: SocketLiveness | null = null;
  readonly #pointerMove = this.#movePointer.bind(this);
  readonly #pointerHide = this.#hidePointer.bind(this);
  readonly #pointerSend = this.#sendPointer.bind(this);
  readonly #beforeUnload = this.#onBeforeUnload.bind(this);
  #pointerSurface: HTMLElement;
  #movingTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #movingSend = this.#sendMoving.bind(this);
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];

  constructor(organisationId: string, boardId: string, surface: HTMLElement, notify: (view: MenuBoardView) => void) {
    this.#doc = MenuBoardDoc.createReplica();
    this.#surface = surface;
    this.#pointerSurface = surface;
    this.#notify = notify;
    const url = new URL(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/menu-boards/${encodeURIComponent(boardId)}/socket`,
      window.location.origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.#url = url.href;
    surface.addEventListener("pointermove", this.#pointerMove);
    surface.addEventListener("pointerleave", this.#pointerHide);
    surface.addEventListener("pointercancel", this.#pointerHide);
    window.addEventListener("beforeunload", this.#beforeUnload);
    this.#connect();
  }

  dispose(): void {
    this.#hidePointer();
    this.#stopMoving();
    const previous = this.#connection;
    this.#connection = { kind: "closed" };
    if (previous.kind === "reconnecting") clearTimeout(previous.timer);
    else socketOf(previous)?.close();
    this.#stopLiveness();
    this.#surface.removeEventListener("pointermove", this.#pointerMove);
    this.#surface.removeEventListener("pointerleave", this.#pointerHide);
    this.#surface.removeEventListener("pointercancel", this.#pointerHide);
    window.removeEventListener("beforeunload", this.#beforeUnload);
    this.#endCheck({ kind: "unavailable" });
    this.#doc.destroy();
  }

  /**
   * Asks the room for the board again on the open socket. The answer names
   * the stored revision; if the room had changes that this screen did not
   * show yet, the screen shows them now and the check answers `changed`.
   */
  checkShown(): Promise<MenuBoardShownCheck> {
    const connection = this.#connection;
    if (connection.kind !== "connected" || this.#pending.kind !== "idle" || this.hasUnsyncedEdits() ||
      this.#check !== null)
      return Promise.resolve({ kind: "unavailable" });
    const vector = this.#doc.stateVector();
    if (!vector.ok) return Promise.resolve({ kind: "unavailable" });
    return new Promise((resolve) => {
      this.#check = { board: JSON.stringify(this.#doc.read()), revision: this.#revision, resolve };
      this.#connection = { kind: "awaiting_sync", socket: connection.socket };
      this.#send({ kind: "sync_request", stateVector: vector.value });
    });
  }

  #endCheck(result: MenuBoardShownCheck): void {
    const check = this.#check;
    this.#check = null;
    check?.resolve(result);
  }

  hasUnsyncedEdits(): boolean {
    return this.#revision > this.#acknowledgedRevision;
  }

  select(selection: MenuBoardPresenceSelection | null): void {
    this.#stopMoving();
    this.#selection = selection;
    this.#sendPresence();
  }

  /**
   * Shows a drag in progress to other people (Plan 40B phase 5, slice 5).
   * The board changes only when the drag ends; this is presence.
   */
  showMoving(selection: MenuBoardMovingSelection): void {
    this.#selection = selection;
    if (this.#movingTimer === null) this.#movingTimer = setTimeout(this.#movingSend, MOVING_INTERVAL_MS);
  }

  #sendMoving(): void {
    this.#movingTimer = null;
    this.#sendPresence();
  }

  #stopMoving(): void {
    if (this.#movingTimer !== null) clearTimeout(this.#movingTimer);
    this.#movingTimer = null;
  }

  /**
   * Pointer positions go as fractions of this element, so that every viewer
   * draws a cursor at the same place on the board.
   */
  setPointerSurface(element: HTMLElement | null): void {
    this.#pointerSurface = element ?? this.#surface;
  }

  canUndo(): boolean {
    return this.#undo.length > 0;
  }

  canRedo(): boolean {
    return this.#redo.length > 0;
  }

  rename(title: string): void {
    this.#record([{ kind: "rename", title }], "rename");
  }

  setLayout(layout: MenuBoardLayout): void {
    this.#record([{ kind: "layout", layout, placements: [] }], null);
  }

  /**
   * A new layout and the elements' places for it, as one edit. `removed`
   * names stacks that the new layout cannot hold (Plan 40B phase 5, slice 8).
   */
  arrangeLayout(
    layout: MenuBoardLayout,
    placements: readonly MenuBoardElementPlacement[],
    removed: readonly string[] = [],
  ): void {
    this.#record([
      { kind: "layout", layout, placements },
      ...removed.map((elementId): BoardOperation => ({ kind: "remove", elementId })),
    ], null);
  }

  /**
   * Puts elements in a new auto-layout stack as one edit (slice 8): the
   * stack, then each element's place in it.
   */
  stackElements(stack: MenuBoardElement, placements: readonly MenuBoardElementPlacement[]): void {
    this.#record([{ kind: "add", element: stack }, { kind: "place", placements }], null);
  }

  /** Takes every element out of a stack onto the canvas, and removes the stack. */
  unstack(stackId: string, placements: readonly MenuBoardElementPlacement[]): void {
    this.#record([{ kind: "place", placements }, { kind: "remove", elementId: stackId }], null);
  }

  addElement(element: MenuBoardElement): void {
    this.#record([{ kind: "add", element }], null);
  }

  updateElement(elementId: string, changes: MenuBoardPropChanges): void {
    this.#record(
      [{ kind: "props", elementId, changes }],
      `props:${elementId}:${Object.keys(changes).sort().join(",")}`,
    );
  }

  moveElement(elementId: string, placement: MenuBoardPlacement): void {
    this.#record([{ kind: "place", placements: [{ elementId, placement }] }], null);
  }

  /**
   * Sets or clears style tokens as one edit. Changes to the same tokens in
   * a row, such as a colour drag, join one undo step.
   */
  setStyle(changes: MenuBoardStyleChanges): void {
    this.#record([{ kind: "style", changes }], `style:${Object.keys(changes).sort().join(",")}`);
  }

  /** Moves several elements as one edit: a drag, an align or a distribute. */
  placeElements(placements: readonly MenuBoardElementPlacement[]): void {
    if (placements.length === 0) return;
    this.#record([{ kind: "place", placements }], null);
  }

  /**
   * Puts elements back as they were, as one undo step of this person
   * (Plan 40B phase 5, slice 9): each one's props and place, or the whole
   * element when it was removed since.
   */
  restoreElements(elements: readonly MenuBoardElement[]): void {
    const current = new Set([...this.#doc.read().elements, ...this.#doc.read().unplaced].map((element) => element.id));
    const operations: BoardOperation[] = [];
    for (const element of elements) {
      if (!current.has(element.id)) {
        operations.push({ kind: "add", element });
        continue;
      }
      const props = menuBoardElementProps(element) as Readonly<Record<string, unknown>>;
      const changes: Record<string, string> = {};
      for (const key of [...MENU_BOARD_TEXT_PROPS[element.kind], ...MENU_BOARD_ID_PROPS[element.kind], ...MENU_BOARD_OPTIONAL_PROPS[element.kind]])
        changes[key] = typeof props[key] === "string" ? String(props[key]) : "";
      operations.push({ kind: "props", elementId: element.id, changes });
      operations.push({ kind: "place", placements: [{ elementId: element.id, placement: element.placement }] });
    }
    if (operations.length > 0) this.#record(operations, null);
  }

  removeElement(elementId: string): void {
    this.#record([{ kind: "remove", elementId }], null);
  }

  /** Removes several elements as one edit. */
  removeElements(elementIds: readonly string[]): void {
    if (elementIds.length === 0) return;
    this.#record(elementIds.map((elementId) => ({ kind: "remove", elementId })), null);
  }

  undo(): void {
    this.#travel(this.#undo, this.#redo);
  }

  redo(): void {
    this.#travel(this.#redo, this.#undo);
  }

  /**
   * Applies operations as one undo step. An operation whose element another
   * person removed in the meantime is left out.
   */
  #record(operations: readonly BoardOperation[], mergeKey: string | null): void {
    const inverse = this.#applyOperations(operations);
    if (inverse === null) return;
    this.#redo = [];
    const now = Date.now();
    const last = this.#undo.at(-1);
    if (mergeKey !== null && last?.mergeKey === mergeKey && now - last.at < HISTORY_MERGE_MS) {
      this.#undo[this.#undo.length - 1] = { inverse: last.inverse, mergeKey, at: now };
    } else {
      this.#undo.push({ inverse, mergeKey, at: now });
      if (this.#undo.length > HISTORY_LIMIT) this.#undo.shift();
    }
  }

  #travel(from: HistoryEntry[], to: HistoryEntry[]): void {
    while (from.length > 0) {
      const entry = from.pop();
      if (entry === undefined) return;
      const inverse = this.#applyOperations(entry.inverse);
      if (inverse === null) continue;
      to.push({ inverse, mergeKey: null, at: Date.now() });
      return;
    }
    this.#emit();
  }

  /** Applies operations in order; answers their inverse, or null if none applied. */
  #applyOperations(operations: readonly BoardOperation[]): BoardOperation[] | null {
    const inverse: BoardOperation[] = [];
    for (const operation of operations) {
      const undo = inverseOf(this.#doc.read(), operation);
      if (undo === null) continue;
      if (this.#edit(this.#apply(operation))) inverse.unshift(undo);
    }
    return inverse.length === 0 ? null : inverse;
  }

  #apply(operation: BoardOperation): MenuBoardCrdtResult<MenuBoardUpdate> {
    switch (operation.kind) {
      case "rename":
        return this.#doc.rename(operation.title);
      case "props":
        return this.#doc.updateElement(operation.elementId, operation.changes);
      case "add":
        return this.#doc.addElement(operation.element);
      case "remove":
        return this.#doc.removeElement(operation.elementId);
      case "place":
        return this.#doc.placeElements(operation.placements);
      case "style":
        return this.#doc.setStyle(operation.changes);
      case "layout":
        return operation.placements.length === 0
          ? this.#doc.setLayout(operation.layout)
          : this.#doc.arrangeLayout(operation.layout, operation.placements);
      default:
        return assertNever(operation, "Unexpected board operation");
    }
  }

  #connect(): void {
    const socket = new WebSocket(this.#url);
    this.#connection = { kind: "connecting", socket };
    socket.addEventListener("open", this.#opened.bind(this, socket));
    socket.addEventListener("message", this.#received.bind(this, socket));
    socket.addEventListener("close", this.#disconnected.bind(this, socket));
    socket.addEventListener("error", this.#disconnected.bind(this, socket));
    this.#emit();
  }

  #opened(socket: WebSocket): void {
    if (socketOf(this.#connection) !== socket) return;
    this.#connection = { kind: "awaiting_sync", socket };
    this.#stopLiveness();
    this.#liveness = new SocketLiveness(socket, this.#disconnected.bind(this, socket));
    const vector = this.#doc.stateVector();
    if (!vector.ok) return this.#fail(vector.error.code);
    this.#send({ kind: "sync_request", stateVector: vector.value });
  }

  #received(socket: WebSocket, event: MessageEvent): void {
    if (socketOf(this.#connection) !== socket) return;
    if (this.#liveness?.received(event.data) === true) return;
    const parsed = parseMenuBoardServerMessage(event.data);
    if (!parsed.ok) return this.#fail(parsed.error.code);
    this.#handle(socket, parsed.value);
  }

  #handle(socket: WebSocket, message: MenuBoardServerMessage): void {
    switch (message.kind) {
      case "sync_response": {
        if (this.#connection.kind !== "awaiting_sync") return this.#fail("invalid_message");
        this.#access = message.access;
        this.#documentRevision = message.documentRevision;
        // Edits that the room has not accepted yet go in after this revision.
        this.#changedSinceRevision = this.hasUnsyncedEdits();
        this.#sessionId = message.sessionId;
        const applied = this.#doc.apply(message.missingUpdate);
        if (!applied.ok) return this.#fail(applied.error.code);
        const check = this.#check;
        if (check !== null)
          this.#endCheck(check.board === JSON.stringify(this.#doc.read()) && check.revision === this.#revision
            ? { kind: "current", documentRevision: message.documentRevision }
            : { kind: "changed" });
        this.#attempts = 0;
        this.#pending = { kind: "idle" };
        if (message.access === "edit") {
          const update = this.#doc.syncUpdate(message.serverStateVector);
          if (!update.ok) return this.#fail(update.error.code);
          this.#connection = { kind: "syncing", socket };
          this.#submit(update.value, "sync");
        } else {
          this.#connection = { kind: "connected", socket };
        }
        this.#sendPresence();
        break;
      }
      case "update_broadcast": {
        const applied = this.#doc.apply(message.update);
        if (!applied.ok) return this.#fail(applied.error.code);
        this.#changedSinceRevision = true;
        break;
      }
      case "update_accepted": {
        const pending = this.#pending;
        if (pending.kind === "idle" || pending.updateId !== message.updateId) return this.#fail("invalid_message");
        this.#acknowledgedRevision = Math.max(this.#acknowledgedRevision, pending.revision);
        this.#pending = { kind: "idle" };
        if (pending.kind === "sync") this.#connection = { kind: "connected", socket };
        if (this.#revision > this.#acknowledgedRevision) {
          const update = this.#doc.syncUpdate(pending.stateVector);
          if (!update.ok) return this.#fail(update.error.code);
          this.#submit(update.value, "edit");
        }
        break;
      }
      case "presence_changed":
        this.#participants = message.participants;
        this.#agents = message.agents;
        break;
      case "failure":
        return this.#fail(message.code);
      default:
        return assertNever(message, "Unexpected board client branch");
    }
    this.#emit();
  }

  #edit(result: MenuBoardCrdtResult<MenuBoardUpdate>): boolean {
    if (!result.ok) {
      if (
        result.error.code === "collection_limit" ||
        result.error.code === "record_conflict" ||
        result.error.code === "text_too_long"
      ) {
        this.#emit();
        return false;
      }
      this.#fail(result.error.code);
      return false;
    }
    this.#revision++;
    this.#changedSinceRevision = true;
    if ((this.#connection.kind === "connected" || this.#connection.kind === "syncing") && this.#pending.kind === "idle") {
      this.#submit(result.value, "edit");
    }
    this.#emit();
    return true;
  }

  #submit(update: MenuBoardUpdate, kind: "sync" | "edit"): void {
    const stateVector = this.#doc.stateVector();
    if (!stateVector.ok) return this.#fail(stateVector.error.code);
    const updateId = crypto.randomUUID();
    this.#pending = { kind, updateId, revision: this.#revision, stateVector: stateVector.value };
    this.#send({ kind: "submit_update", updateId, update });
  }

  #send(message: MenuBoardClientMessage): void {
    const socket = socketOf(this.#connection);
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(encodeMenuBoardClientMessage(message));
  }

  #sendPresence(): void {
    if (this.#connection.kind !== "connected" && this.#connection.kind !== "syncing") return;
    this.#send({
      kind: "presence_update",
      state: this.#selection === null ? "viewing" : "editing",
      selection: this.#selection,
    });
  }

  #movePointer(event: PointerEvent): void {
    if (event.pointerType === "touch") return;
    const rect = this.#pointerSurface.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.#pointer = {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
    if (this.#pointerTimer === null) this.#pointerTimer = setTimeout(this.#pointerSend, 50);
    if (this.#pointerIdle !== null) clearTimeout(this.#pointerIdle);
    this.#pointerIdle = setTimeout(this.#pointerHide, POINTER_IDLE_MS);
  }

  #sendPointer(): void {
    this.#pointerTimer = null;
    if (this.#connection.kind === "connected" || this.#connection.kind === "syncing") {
      this.#send({ kind: "pointer_update", position: this.#pointer });
    }
  }

  #hidePointer(): void {
    if (this.#pointerTimer !== null) clearTimeout(this.#pointerTimer);
    if (this.#pointerIdle !== null) clearTimeout(this.#pointerIdle);
    this.#pointerTimer = null;
    this.#pointerIdle = null;
    if (this.#pointer === null) return;
    this.#pointer = null;
    this.#sendPointer();
  }

  #disconnected(socket: WebSocket): void {
    if (socketOf(this.#connection) !== socket) return;
    this.#stopLiveness();
    this.#attempts = Math.min(this.#attempts + 1, 4);
    this.#connection = {
      kind: "reconnecting",
      timer: setTimeout(this.#connect.bind(this), Math.min(1_000 * 2 ** this.#attempts, 10_000)),
    };
    this.#participants = [];
    socket.close();
    this.#endCheck({ kind: "unavailable" });
    this.#emit();
  }

  #stopLiveness(): void {
    this.#liveness?.stop();
    this.#liveness = null;
  }

  #fail(code: MenuBoardFailureCode): void {
    const previous = this.#connection;
    this.#connection = { kind: "failed", code };
    this.#stopLiveness();
    if (previous.kind === "reconnecting") clearTimeout(previous.timer);
    else socketOf(previous)?.close();
    this.#endCheck({ kind: "unavailable" });
    this.#emit();
  }

  #onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!this.hasUnsyncedEdits()) return;
    event.preventDefault();
    event.returnValue = "";
  }

  #emit(): void {
    if (this.#connection.kind === "closed") return;
    const base = {
      board: this.#doc.read(),
      participants: this.#participants.map(markBoardParticipant.bind(null, this.#sessionId)),
      agents: this.#agents,
      access: this.#access,
      documentRevision: this.#documentRevision,
      changedSinceRevision: this.#changedSinceRevision,
    };
    if (this.#connection.kind === "failed") {
      // The code names the refused rule for a support report.
      this.#notify({
        ...base,
        kind: "failed",
        message: `${failureMessage(this.#connection.code)} Code: ${this.#connection.code}.`,
      });
      return;
    }
    const kind = this.#connection.kind === "reconnecting"
      ? "reconnecting"
      : this.#connection.kind === "connecting" ||
          (this.#connection.kind === "awaiting_sync" && this.#check === null)
        ? "connecting"
        : this.#connection.kind === "syncing" || this.#pending.kind !== "idle" || this.hasUnsyncedEdits()
          ? "syncing"
          : "synced";
    this.#notify({ ...base, kind });
  }
}

/** The operation that undoes `operation` on `board`; null if it cannot apply. */
function inverseOf(board: MenuBoardSnapshot, operation: BoardOperation): BoardOperation | null {
  const all = [...board.elements, ...board.unplaced];
  const find = (elementId: string): MenuBoardElement | undefined =>
    all.find((element) => element.id === elementId);
  switch (operation.kind) {
    case "rename":
      return { kind: "rename", title: board.title };
    case "props": {
      const element = find(operation.elementId);
      if (element === undefined) return null;
      const values = element as unknown as Readonly<Record<string, unknown>>;
      const changes: Record<string, string> = {};
      for (const key of Object.keys(operation.changes)) changes[key] = String(values[key] ?? "");
      return { kind: "props", elementId: element.id, changes };
    }
    case "add":
      return find(operation.element.id) === undefined ? { kind: "remove", elementId: operation.element.id } : null;
    case "remove": {
      const element = find(operation.elementId);
      return element === undefined ? null : { kind: "add", element };
    }
    case "place": {
      const placements = operation.placements.flatMap(({ elementId }) => {
        const element = find(elementId);
        return element === undefined ? [] : [{ elementId, placement: element.placement }];
      });
      return placements.length === 0 ? null : { kind: "place", placements };
    }
    case "style": {
      const current = board.style as Readonly<Record<string, string | number | undefined>>;
      const changes: Record<string, string | number | null> = {};
      for (const token of Object.keys(operation.changes)) changes[token] = current[token] ?? null;
      return { kind: "style", changes };
    }
    case "layout":
      return {
        kind: "layout",
        layout: board.layout,
        placements: operation.placements.flatMap(({ elementId }) => {
          const element = find(elementId);
          return element === undefined ? [] : [{ elementId, placement: element.placement }];
        }),
      };
    default:
      return assertNever(operation, "Unexpected board operation");
  }
}

function markBoardParticipant(
  sessionId: string | null,
  participant: MenuBoardParticipant,
): MenuBoardPresenceView {
  return { ...participant, isSelf: participant.sessionId === sessionId };
}

function socketOf(connection: Connection): WebSocket | null {
  switch (connection.kind) {
    case "connecting":
    case "awaiting_sync":
    case "syncing":
    case "connected":
      return connection.socket;
    case "reconnecting":
    case "failed":
    case "closed":
      return null;
    default:
      return assertNever(connection, "Unexpected board client branch");
  }
}

function failureMessage(code: MenuBoardFailureCode): string {
  switch (code) {
    case "access_revoked":
      return "Board editing access ended.";
    case "collection_limit":
    case "text_too_long":
    case "record_conflict":
      return "That board change could not be applied. Refresh the board and try again.";
    case "room_full":
      return "This board already has 20 connected sessions.";
    case "storage_unavailable":
      return "The board room is temporarily unavailable.";
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "update_too_large":
    case "state_too_large":
    case "state_vector_too_large":
    case "invalid_message":
      return "The shared board could not be synchronized. Reload the page.";
    default:
      return assertNever(code, "Unexpected board client branch");
  }
}
