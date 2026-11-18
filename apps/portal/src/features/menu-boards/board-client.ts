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
  type MenuBoardFailureCode,
  type MenuBoardRoomMetadata,
} from "@seams/menu-board-crdt/protocol";
import type { CollaborationAgentActivity } from "@seams/collaboration";
import { assertNever } from "@seams/std";
import {
  DocumentClient,
  webSocketUrl,
  type DocumentParticipant,
  type DocumentState,
} from "../collaboration/document-client";

/**
 * The Portal's side of one board's shared draft (Plan 40B). It is the menu
 * draft client with the board's document: each edit applies locally at
 * once, goes to the room one at a time, and waits for the room's
 * acknowledgement before the next.
 */

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
}> &
  (
    | Readonly<{ kind: "connecting" | "syncing" | "synced" | "reconnecting" }>
    | Readonly<{ kind: "failed"; message: string }>
  );

export type MenuBoardPresenceView =
  DocumentParticipant<MenuBoardPresenceSelection>;

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
  | Readonly<{
      kind: "props";
      elementId: string;
      changes: MenuBoardPropChanges;
    }>
  | Readonly<{ kind: "add"; element: MenuBoardElement }>
  | Readonly<{ kind: "remove"; elementId: string }>
  | Readonly<{
      kind: "place";
      placements: readonly MenuBoardElementPlacement[];
    }>
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
  readonly #client: DocumentClient<
    MenuBoardDoc,
    MenuBoardUpdate,
    MenuBoardStateVector,
    MenuBoardPresenceSelection,
    MenuBoardFailureCode,
    MenuBoardRoomMetadata
  >;
  readonly #notify: (view: MenuBoardView) => void;
  #selection: MenuBoardPresenceSelection | null = null;
  #documentRevision: number | null = null;
  #changedSinceRevision = false;
  #check: ShownCheck | null = null;
  #movingTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #movingSend = this.#sendMoving.bind(this);
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];

  constructor(
    organisationId: string,
    boardId: string,
    surface: HTMLElement,
    notify: (view: MenuBoardView) => void,
  ) {
    this.#notify = notify;
    this.#client = new DocumentClient({
      url: webSocketUrl(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/menu-boards/${encodeURIComponent(boardId)}/socket`,
      ),
      surface,
      create: () => MenuBoardDoc.createReplica(),
      parse: parseMenuBoardServerMessage,
      encode: encodeMenuBoardClientMessage,
      invalidMessage: "invalid_message",
      ignoredEditFailures: [
        "collection_limit",
        "record_conflict",
        "text_too_long",
      ],
      keepAgents: true,
      presence: () => this.#selection,
      syncResponse: (message) => {
        this.#documentRevision = message.documentRevision;
        // Edits that the room has not accepted yet go in after this revision.
        this.#changedSinceRevision = this.#client.hasUnsyncedEdits();
        return true;
      },
      synced: this.#endCheckOnSync.bind(this),
      updated: () => {
        this.#changedSinceRevision = true;
      },
      lost: this.#endCheck.bind(this, { kind: "unavailable" }),
      emit: this.#emit.bind(this),
    });
    this.#client.connect();
  }

  dispose(): void {
    this.#stopMoving();
    this.#client.dispose();
    this.#endCheck({ kind: "unavailable" });
  }

  /**
   * Asks the room for the board again on the open socket. The answer names
   * the stored revision; if the room had changes that this screen did not
   * show yet, the screen shows them now and the check answers `changed`.
   */
  checkShown(): Promise<MenuBoardShownCheck> {
    if (this.#check !== null) {
      return Promise.resolve({ kind: "unavailable" });
    }
    return new Promise((resolve) => {
      this.#check = {
        board: JSON.stringify(this.#client.replica.read()),
        revision: this.#client.revision,
        resolve,
      };
      if (!this.#client.resync()) {
        this.#endCheck({ kind: "unavailable" });
      }
    });
  }

  #endCheckOnSync(message: Readonly<{ documentRevision: number }>): void {
    const check = this.#check;
    if (check === null) {
      return;
    }
    this.#endCheck(
      check.board === JSON.stringify(this.#client.replica.read()) &&
        check.revision === this.#client.revision
        ? { kind: "current", documentRevision: message.documentRevision }
        : { kind: "changed" },
    );
  }

  #endCheck(result: MenuBoardShownCheck): void {
    const check = this.#check;
    this.#check = null;
    check?.resolve(result);
  }

  hasUnsyncedEdits(): boolean {
    return this.#client.hasUnsyncedEdits();
  }

  select(selection: MenuBoardPresenceSelection | null): void {
    this.#stopMoving();
    this.#selection = selection;
    this.#client.sendPresence(selection);
  }

  /**
   * Shows a drag in progress to other people (Plan 40B phase 5, slice 5).
   * The board changes only when the drag ends; this is presence.
   */
  showMoving(selection: MenuBoardMovingSelection): void {
    this.#selection = selection;
    if (this.#movingTimer === null) {
      this.#movingTimer = setTimeout(this.#movingSend, MOVING_INTERVAL_MS);
    }
  }

  #sendMoving(): void {
    this.#movingTimer = null;
    this.#client.sendPresence(this.#selection);
  }

  #stopMoving(): void {
    if (this.#movingTimer !== null) {
      clearTimeout(this.#movingTimer);
    }
    this.#movingTimer = null;
  }

  /**
   * Pointer positions go as fractions of this element, so that every viewer
   * draws a cursor at the same place on the board.
   */
  setPointerSurface(element: HTMLElement | null): void {
    this.#client.setPointerSurface(element);
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
    this.#record(
      [
        { kind: "layout", layout, placements },
        ...removed.map((elementId): BoardOperation => ({
          kind: "remove",
          elementId,
        })),
      ],
      null,
    );
  }

  /**
   * Puts elements in a new auto-layout stack as one edit (slice 8): the
   * stack, then each element's place in it.
   */
  stackElements(
    stack: MenuBoardElement,
    placements: readonly MenuBoardElementPlacement[],
  ): void {
    this.#record(
      [
        { kind: "add", element: stack },
        { kind: "place", placements },
      ],
      null,
    );
  }

  /** Takes every element out of a stack onto the canvas, and removes the stack. */
  unstack(
    stackId: string,
    placements: readonly MenuBoardElementPlacement[],
  ): void {
    this.#record(
      [
        { kind: "place", placements },
        { kind: "remove", elementId: stackId },
      ],
      null,
    );
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
    this.#record(
      [{ kind: "place", placements: [{ elementId, placement }] }],
      null,
    );
  }

  /**
   * Sets or clears style tokens as one edit. Changes to the same tokens in
   * a row, such as a colour drag, join one undo step.
   */
  setStyle(changes: MenuBoardStyleChanges): void {
    this.#record(
      [{ kind: "style", changes }],
      `style:${Object.keys(changes).sort().join(",")}`,
    );
  }

  /** Moves several elements as one edit: a drag, an align or a distribute. */
  placeElements(placements: readonly MenuBoardElementPlacement[]): void {
    if (placements.length === 0) {
      return;
    }
    this.#record([{ kind: "place", placements }], null);
  }

  /**
   * Puts elements back as they were, as one undo step of this person
   * (Plan 40B phase 5, slice 9): each one's props and place, or the whole
   * element when it was removed since.
   */
  restoreElements(elements: readonly MenuBoardElement[]): void {
    const board = this.#client.replica.read();
    const current = new Set(
      [...board.elements, ...board.unplaced].map((element) => element.id),
    );
    const operations: BoardOperation[] = [];
    for (const element of elements) {
      if (!current.has(element.id)) {
        operations.push({ kind: "add", element });
        continue;
      }
      const props = menuBoardElementProps(element) as Readonly<
        Record<string, unknown>
      >;
      const changes: Record<string, string> = {};
      for (const key of [
        ...MENU_BOARD_TEXT_PROPS[element.kind],
        ...MENU_BOARD_ID_PROPS[element.kind],
        ...MENU_BOARD_OPTIONAL_PROPS[element.kind],
      ]) {
        changes[key] = typeof props[key] === "string" ? String(props[key]) : "";
      }
      operations.push({ kind: "props", elementId: element.id, changes });
      operations.push({
        kind: "place",
        placements: [{ elementId: element.id, placement: element.placement }],
      });
    }
    if (operations.length > 0) {
      this.#record(operations, null);
    }
  }

  removeElement(elementId: string): void {
    this.#record([{ kind: "remove", elementId }], null);
  }

  /** Removes several elements as one edit. */
  removeElements(elementIds: readonly string[]): void {
    if (elementIds.length === 0) {
      return;
    }
    this.#record(
      elementIds.map((elementId) => ({ kind: "remove", elementId })),
      null,
    );
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
  #record(
    operations: readonly BoardOperation[],
    mergeKey: string | null,
  ): void {
    const inverse = this.#applyOperations(operations);
    if (inverse === null) {
      return;
    }
    this.#redo = [];
    const now = Date.now();
    const last = this.#undo.at(-1);
    if (
      mergeKey !== null &&
      last?.mergeKey === mergeKey &&
      now - last.at < HISTORY_MERGE_MS
    ) {
      this.#undo[this.#undo.length - 1] = {
        inverse: last.inverse,
        mergeKey,
        at: now,
      };
    } else {
      this.#undo.push({ inverse, mergeKey, at: now });
      if (this.#undo.length > HISTORY_LIMIT) {
        this.#undo.shift();
      }
    }
  }

  #travel(from: HistoryEntry[], to: HistoryEntry[]): void {
    while (from.length > 0) {
      const entry = from.pop();
      if (entry === undefined) {
        return;
      }
      const inverse = this.#applyOperations(entry.inverse);
      if (inverse === null) {
        continue;
      }
      to.push({ inverse, mergeKey: null, at: Date.now() });
      return;
    }
    this.#client.emit();
  }

  /** Applies operations in order; answers their inverse, or null if none applied. */
  #applyOperations(
    operations: readonly BoardOperation[],
  ): BoardOperation[] | null {
    const inverse: BoardOperation[] = [];
    for (const operation of operations) {
      const undo = inverseOf(this.#client.replica.read(), operation);
      if (undo === null) {
        continue;
      }
      if (this.#edit(this.#apply(operation))) {
        inverse.unshift(undo);
      }
    }
    return inverse.length === 0 ? null : inverse;
  }

  #apply(operation: BoardOperation): MenuBoardCrdtResult<MenuBoardUpdate> {
    const doc = this.#client.replica;
    switch (operation.kind) {
      case "rename":
        return doc.rename(operation.title);
      case "props":
        return doc.updateElement(operation.elementId, operation.changes);
      case "add":
        return doc.addElement(operation.element);
      case "remove":
        return doc.removeElement(operation.elementId);
      case "place":
        return doc.placeElements(operation.placements);
      case "style":
        return doc.setStyle(operation.changes);
      case "layout":
        return operation.placements.length === 0
          ? doc.setLayout(operation.layout)
          : doc.arrangeLayout(operation.layout, operation.placements);
      default:
        return assertNever(operation, "Unexpected board operation");
    }
  }

  #edit(result: MenuBoardCrdtResult<MenuBoardUpdate>): boolean {
    if (result.ok) {
      this.#changedSinceRevision = true;
    }
    return this.#client.edit(result);
  }

  #emit(
    state: DocumentState<
      MenuBoardDoc,
      MenuBoardPresenceSelection,
      MenuBoardFailureCode
    >,
  ): void {
    const base = {
      board: state.replica.read(),
      participants: state.participants,
      agents: state.agents,
      access: state.access,
      documentRevision: this.#documentRevision,
      changedSinceRevision: this.#changedSinceRevision,
    };
    if (state.status === "failed") {
      // The code names the refused rule for a support report.
      this.#notify({
        ...base,
        kind: "failed",
        message: `${failureMessage(state.code)} Code: ${state.code}.`,
      });
      return;
    }
    // A shown-board check asks on the open socket: the board stays usable.
    const checking =
      state.connection === "awaiting_sync" && this.#check !== null;
    this.#notify({
      ...base,
      kind: checking ? (state.settled ? "synced" : "syncing") : state.status,
    });
  }
}

/** The operation that undoes `operation` on `board`; null if it cannot apply. */
function inverseOf(
  board: MenuBoardSnapshot,
  operation: BoardOperation,
): BoardOperation | null {
  const all = [...board.elements, ...board.unplaced];
  const find = (elementId: string): MenuBoardElement | undefined =>
    all.find((element) => element.id === elementId);
  switch (operation.kind) {
    case "rename":
      return { kind: "rename", title: board.title };
    case "props": {
      const element = find(operation.elementId);
      if (element === undefined) {
        return null;
      }
      const values = element as unknown as Readonly<Record<string, unknown>>;
      const changes: Record<string, string> = {};
      for (const key of Object.keys(operation.changes)) {
        changes[key] = String(values[key] ?? "");
      }
      return { kind: "props", elementId: element.id, changes };
    }
    case "add":
      return find(operation.element.id) === undefined
        ? { kind: "remove", elementId: operation.element.id }
        : null;
    case "remove": {
      const element = find(operation.elementId);
      return element === undefined ? null : { kind: "add", element };
    }
    case "place": {
      const placements = operation.placements.flatMap(({ elementId }) => {
        const element = find(elementId);
        return element === undefined
          ? []
          : [{ elementId, placement: element.placement }];
      });
      return placements.length === 0 ? null : { kind: "place", placements };
    }
    case "style": {
      const current = board.style as Readonly<
        Record<string, string | number | undefined>
      >;
      const changes: Record<string, string | number | null> = {};
      for (const token of Object.keys(operation.changes)) {
        changes[token] = current[token] ?? null;
      }
      return { kind: "style", changes };
    }
    case "layout":
      return {
        kind: "layout",
        layout: board.layout,
        placements: operation.placements.flatMap(({ elementId }) => {
          const element = find(elementId);
          return element === undefined
            ? []
            : [{ elementId, placement: element.placement }];
        }),
      };
    default:
      return assertNever(operation, "Unexpected board operation");
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
