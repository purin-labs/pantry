import {
  CostsSheetDoc,
  META_SAVED_AT_CELL_KEY,
  type CostsSheetCellChange,
  type CostsSheetCrdtResult,
  type CostsSheetSelection,
  type CostsSheetStateVector,
  type CostsSheetTab,
  type CostsSheetUpdate,
} from "@seams/costs-sheet-crdt";
import {
  encodeCostsSheetClientMessage,
  parseCostsSheetServerMessage,
  type CostsSheetClientMessage,
  type CostsSheetFailureCode,
  type CostsSheetParticipant,
  type CostsSheetServerMessage,
} from "@seams/costs-sheet-crdt/protocol";
import {
  COLLABORATION_POINTER_IDLE_MS,
  type CollaborationAgentActivity,
  type CollaborationPointerPosition,
} from "@seams/collaboration";
import { assertNever } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";
import { SocketLiveness } from "../collaboration/socket-liveness";

const SYNC_RETRY_LIMIT = 3;

type Connection =
  | Readonly<{
      kind: "connecting" | "awaiting_sync" | "syncing" | "connected";
      socket: WebSocket;
    }>
  | Readonly<{ kind: "reconnecting"; timer: ReturnType<typeof setTimeout> }>
  | Readonly<{ kind: "failed"; code: CostsSheetFailureCode }>
  | Readonly<{ kind: "closed" }>;

type Pending =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "sync" | "edit";
      updateId: string;
      revision: number;
      stateVector: CostsSheetStateVector;
    }>;

export type CostsSheetPresence = CostsSheetParticipant &
  Readonly<{ isSelf: boolean }>;

export type CostsSheetView = Readonly<{
  cells: Readonly<Record<string, string>>;
  savedAt: string | null;
  participants: readonly CostsSheetPresence[];
  agents: readonly CollaborationAgentActivity[];
  access: "read" | "edit";
}> &
  StrictUnion<
    | Readonly<{ kind: "connecting" | "syncing" | "synced" | "reconnecting" }>
    | Readonly<{ kind: "failed"; message: string; recovery: "retry" | "none" }>
  >;

export const INITIAL_COSTS_SHEET_VIEW: CostsSheetView = {
  kind: "connecting",
  cells: {},
  savedAt: null,
  participants: [],
  agents: [],
  access: "read",
};

/**
 * Plan 86 Phase 3: multiplayer Yjs + Figma-style presence client for an
 * Organisation's Costs & margins workbook.
 */
export class CostsSheetClient {
  #doc: CostsSheetDoc;
  readonly #url: string;
  readonly #surface: HTMLElement;
  readonly #notify: (view: CostsSheetView) => void;
  #connection: Connection = { kind: "closed" };
  #pending: Pending = { kind: "idle" };
  #participants: readonly CostsSheetParticipant[] = [];
  #agents: readonly CollaborationAgentActivity[] = [];
  #selection: CostsSheetSelection | null;
  #access: "read" | "edit" = "read";
  #generation: number | null = null;
  #sessionId: string | null = null;
  #revision = 0;
  #acknowledgedRevision = 0;
  #attempts = 0;
  #syncFailures = 0;
  #pointer: CollaborationPointerPosition | null = null;
  #pointerTimer: ReturnType<typeof setTimeout> | null = null;
  #pointerIdle: ReturnType<typeof setTimeout> | null = null;
  #liveness: SocketLiveness | null = null;
  readonly #pointerMove = this.#movePointer.bind(this);
  readonly #pointerHide = this.#hidePointer.bind(this);
  readonly #pointerSend = this.#sendPointer.bind(this);
  readonly #beforeUnload = this.#onBeforeUnload.bind(this);

  constructor(
    organisationId: string,
    initialSheet: CostsSheetTab,
    surface: HTMLElement,
    notify: (view: CostsSheetView) => void,
  ) {
    this.#doc = CostsSheetDoc.create();
    this.#selection = { sheet: initialSheet, cellKey: null };
    this.#surface = surface;
    this.#notify = notify;
    const url = new URL(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/costs/sheet/socket`,
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
    const previous = this.#connection;
    this.#connection = { kind: "closed" };
    if (previous.kind === "reconnecting") clearTimeout(previous.timer);
    else socketOf(previous)?.close();
    this.#stopLiveness();
    this.#surface.removeEventListener("pointermove", this.#pointerMove);
    this.#surface.removeEventListener("pointerleave", this.#pointerHide);
    this.#surface.removeEventListener("pointercancel", this.#pointerHide);
    window.removeEventListener("beforeunload", this.#beforeUnload);
    this.#doc.destroy();
  }

  hasUnsyncedEdits(): boolean {
    return this.#revision > this.#acknowledgedRevision;
  }

  retry(): void {
    if (
      this.#connection.kind !== "failed" ||
      failureRecovery(this.#connection.code) !== "retry"
    )
      return;
    this.#syncFailures = 0;
    this.#connect();
  }

  select(sheet: CostsSheetTab, cellKey: string | null): void {
    if (
      this.#selection !== null &&
      this.#selection.sheet === sheet &&
      this.#selection.cellKey === cellKey
    )
      return;
    this.#selection = { sheet, cellKey };
    this.#sendPresence();
  }

  setCells(changes: readonly CostsSheetCellChange[]): boolean {
    if (changes.length === 0) return true;
    const result = this.#doc.setCells(changes);
    if (!result.ok && result.error.code === "cell_invalid") return false;
    this.#edit(result);
    return true;
  }

  clearAll(): void {
    this.#edit(this.#doc.clearAllDraftCells());
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
    this.#liveness = new SocketLiveness(
      socket,
      this.#disconnected.bind(this, socket),
    );
    const vector = this.#doc.stateVector();
    if (!vector.ok) return this.#fail(vector.error.code);
    this.#send({ kind: "sync_request", stateVector: vector.value });
  }

  #received(socket: WebSocket, event: MessageEvent): void {
    if (socketOf(this.#connection) !== socket) return;
    if (this.#liveness?.received(event.data) === true) return;
    const parsed = parseCostsSheetServerMessage(event.data);
    if (!parsed.ok) return this.#fail(parsed.error.code);
    this.#handle(socket, parsed.value);
  }

  #handle(socket: WebSocket, message: CostsSheetServerMessage): void {
    switch (message.kind) {
      case "sync_response": {
        if (this.#connection.kind !== "awaiting_sync")
          return this.#fail("invalid_message");
        if (
          this.#generation !== null &&
          this.#generation !== message.generation
        ) {
          this.#generation = null;
          this.#doc.destroy();
          this.#doc = CostsSheetDoc.create();
          this.#revision = 0;
          this.#acknowledgedRevision = 0;
          this.#pending = { kind: "idle" };
          this.#connection = { kind: "connecting", socket };
          this.#opened(socket);
          return;
        }
        this.#generation = message.generation;
        this.#access = message.access;
        this.#sessionId = message.sessionId;
        const applied = this.#doc.apply(message.missingUpdate);
        if (!applied.ok) return this.#fail(applied.error.code);
        this.#pending = { kind: "idle" };
        if (message.access === "edit") {
          const update = this.#doc.syncUpdate(message.serverStateVector);
          if (!update.ok) return this.#fail(update.error.code);
          this.#connection = { kind: "syncing", socket };
          this.#submit(update.value, "sync");
        } else {
          this.#connection = { kind: "connected", socket };
          this.#attempts = 0;
          this.#syncFailures = 0;
        }
        this.#sendPresence();
        break;
      }
      case "update_broadcast": {
        const applied = this.#doc.apply(message.update);
        if (!applied.ok) return this.#fail(applied.error.code);
        break;
      }
      case "update_accepted": {
        const pending = this.#pending;
        if (pending.kind === "idle" || pending.updateId !== message.updateId)
          return this.#fail("invalid_message");
        this.#acknowledgedRevision = Math.max(
          this.#acknowledgedRevision,
          pending.revision,
        );
        this.#pending = { kind: "idle" };
        if (pending.kind === "sync") {
          this.#connection = { kind: "connected", socket };
          this.#attempts = 0;
          this.#syncFailures = 0;
        }
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
        return assertNever(message, "Unexpected costs sheet server message");
    }
    this.#emit();
  }

  #edit(result: CostsSheetCrdtResult<CostsSheetUpdate | null>): void {
    if (!result.ok) {
      if (
        result.error.code === "collection_limit" ||
        result.error.code === "record_conflict" ||
        result.error.code === "cell_invalid"
      ) {
        this.#emit();
        return;
      }
      return this.#fail(result.error.code);
    }
    if (result.value === null) return;
    this.#revision++;
    if (
      (this.#connection.kind === "connected" ||
        this.#connection.kind === "syncing") &&
      this.#pending.kind === "idle"
    )
      this.#submit(result.value, "edit");
    this.#emit();
  }

  #submit(update: CostsSheetUpdate, kind: "sync" | "edit"): void {
    const stateVector = this.#doc.stateVector();
    if (!stateVector.ok) return this.#fail(stateVector.error.code);
    const updateId = crypto.randomUUID();
    this.#pending = {
      kind,
      updateId,
      revision: this.#revision,
      stateVector: stateVector.value,
    };
    this.#send({ kind: "submit_update", updateId, update });
  }

  #send(message: CostsSheetClientMessage): void {
    const socket = socketOf(this.#connection);
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(encodeCostsSheetClientMessage(message));
  }

  #sendPresence(): void {
    if (
      this.#connection.kind !== "connected" &&
      this.#connection.kind !== "syncing"
    )
      return;
    const editing = this.#access === "edit" && this.#selection !== null;
    this.#send({
      kind: "presence_update",
      state: editing ? "editing" : "viewing",
      selection: editing ? this.#selection : null,
    });
  }

  #movePointer(event: PointerEvent): void {
    if (event.pointerType === "touch") return;
    const rect = this.#surface.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.#pointer = {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
    if (this.#pointerTimer === null)
      this.#pointerTimer = setTimeout(this.#pointerSend, 50);
    if (this.#pointerIdle !== null) clearTimeout(this.#pointerIdle);
    this.#pointerIdle = setTimeout(
      this.#pointerHide,
      COLLABORATION_POINTER_IDLE_MS,
    );
  }

  #sendPointer(): void {
    this.#pointerTimer = null;
    if (
      this.#connection.kind === "connected" ||
      this.#connection.kind === "syncing"
    )
      this.#send({ kind: "pointer_update", position: this.#pointer });
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
      timer: setTimeout(
        this.#connect.bind(this),
        Math.min(1_000 * 2 ** this.#attempts, 10_000),
      ),
    };
    this.#participants = [];
    this.#agents = [];
    socket.close();
    this.#emit();
  }

  #stopLiveness(): void {
    this.#liveness?.stop();
    this.#liveness = null;
  }

  #fail(code: CostsSheetFailureCode): void {
    const previous = this.#connection;
    const socket = socketOf(previous);
    if (
      socket !== null &&
      failureRecovery(code) === "retry" &&
      this.#syncFailures < SYNC_RETRY_LIMIT
    ) {
      this.#syncFailures++;
      this.#disconnected(socket);
      return;
    }
    this.#connection = { kind: "failed", code };
    this.#stopLiveness();
    if (previous.kind === "reconnecting") clearTimeout(previous.timer);
    else socketOf(previous)?.close();
    this.#emit();
  }

  #onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!this.hasUnsyncedEdits()) return;
    event.preventDefault();
    event.returnValue = "";
  }

  #emit(): void {
    if (this.#connection.kind === "closed") return;
    const cells = this.#doc.cellsRecord();
    const base = {
      cells,
      savedAt: cells[META_SAVED_AT_CELL_KEY] ?? null,
      participants: this.#participants.map(
        markParticipant.bind(null, this.#sessionId),
      ),
      agents: this.#agents,
      access: this.#access,
    };
    if (this.#connection.kind === "failed") {
      this.#notify({
        ...base,
        kind: "failed",
        message: failureMessage(this.#connection.code),
        recovery: failureRecovery(this.#connection.code),
      });
      return;
    }
    const kind =
      this.#connection.kind === "reconnecting"
        ? "reconnecting"
        : this.#connection.kind === "connecting" ||
            this.#connection.kind === "awaiting_sync"
          ? "connecting"
          : this.#connection.kind === "syncing" ||
              this.#pending.kind !== "idle" ||
              this.hasUnsyncedEdits()
            ? "syncing"
            : "synced";
    this.#notify({ ...base, kind });
  }
}

function markParticipant(
  sessionId: string | null,
  participant: CostsSheetParticipant,
): CostsSheetPresence {
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
      return assertNever(connection, "Unexpected costs sheet connection");
  }
}

function failureRecovery(code: CostsSheetFailureCode): "retry" | "none" {
  switch (code) {
    case "storage_unavailable":
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "invalid_message":
      return "retry";
    case "cell_invalid":
    case "record_conflict":
    case "update_too_large":
    case "state_too_large":
    case "state_vector_too_large":
    case "access_revoked":
    case "collection_limit":
    case "room_full":
      return "none";
    default:
      return assertNever(code, "Unexpected costs sheet failure code");
  }
}

function failureMessage(code: CostsSheetFailureCode): string {
  switch (code) {
    case "access_revoked":
      return "Your access to this workbook has ended.";
    case "collection_limit":
      return "This workbook reached the draft cell limit. Save or reset before editing more cells.";
    case "cell_invalid":
    case "record_conflict":
      return "That cell edit could not be applied. Reload the page and try again.";
    case "room_full":
      return "This workbook already has 20 connected sessions.";
    case "storage_unavailable":
      return "The shared workbook is temporarily unavailable. Your edits remain on this page.";
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "invalid_message":
      return "The shared workbook lost sync. Your edits remain on this page.";
    case "update_too_large":
    case "state_too_large":
    case "state_vector_too_large":
      return "The shared workbook state is too large. Save or reset the sheet.";
    default:
      return assertNever(code, "Unexpected costs sheet failure code");
  }
}
