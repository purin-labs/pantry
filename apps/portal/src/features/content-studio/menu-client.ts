import {
  MenuDraftDoc,
  type MenuDraftCrdtResult,
  type MenuDraftSnapshot,
  type MenuDraftStateVector,
  type MenuDraftUpdate,
  type MenuItem,
  type MenuItemPlacement,
  type MenuPresenceSelection,
  type MenuSection,
} from "@seams/menu-draft-crdt";
import {
  encodeMenuDraftClientMessage,
  parseMenuDraftServerMessage,
  POINTER_IDLE_MS,
  type MenuDraftClientMessage,
  type MenuDraftFailureCode,
  type MenuDraftParticipant,
  type MenuDraftServerMessage,
} from "@seams/menu-draft-crdt/protocol";
import type { CollaborationPointerPosition } from "@seams/collaboration";
import { assertNever } from "@seams/std";
import { SocketLiveness } from "../collaboration/socket-liveness";

type Connection =
  | Readonly<{ kind: "connecting" | "awaiting_sync" | "syncing" | "connected"; socket: WebSocket }>
  | Readonly<{ kind: "reconnecting"; timer: ReturnType<typeof setTimeout> }>
  | Readonly<{ kind: "failed"; code: MenuDraftFailureCode }>
  | Readonly<{ kind: "closed" }>;

type Pending =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "sync" | "edit"; updateId: string; revision: number; stateVector: MenuDraftStateVector }>;

export type MenuDraftView = Readonly<{
  draft: MenuDraftSnapshot;
  participants: readonly MenuDraftPresenceView[];
  access: "read" | "edit";
  documentRevision: number | null;
}> & (
  | Readonly<{ kind: "connecting" | "syncing" | "synced" | "reconnecting" }>
  | Readonly<{ kind: "failed"; message: string }>
);

export type MenuDraftPresenceView = MenuDraftParticipant & Readonly<{ isSelf: boolean }>;

export class MenuDraftClient {
  readonly #doc: MenuDraftDoc;
  readonly #url: string;
  readonly #surface: HTMLElement;
  readonly #notify: (view: MenuDraftView) => void;
  #connection: Connection = { kind: "closed" };
  #pending: Pending = { kind: "idle" };
  #participants: readonly MenuDraftParticipant[] = [];
  #selection: MenuPresenceSelection | null = null;
  #access: "read" | "edit" = "read";
  #documentRevision: number | null = null;
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

  constructor(organisationId: string, surface: HTMLElement, notify: (view: MenuDraftView) => void) {
    this.#doc = MenuDraftDoc.createReplica();
    this.#surface = surface;
    this.#notify = notify;
    const url = new URL(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/collaboration/menu-draft/socket`,
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

  select(selection: MenuPresenceSelection | null): void {
    this.#selection = selection;
    this.#sendPresence();
  }

  rename(title: string): void {
    this.#edit(this.#doc.rename(title));
  }

  addSection(section: MenuSection): void {
    this.#edit(this.#doc.addSection(section));
  }

  addItem(item: MenuItem): void {
    this.#edit(this.#doc.addItem(item));
  }

  renameItem(itemId: string, displayName: string): void {
    this.#edit(this.#doc.renameItem(itemId, displayName));
  }

  describeItem(itemId: string, description: string): void {
    this.#edit(this.#doc.describeItem(itemId, description));
  }

  moveItem(itemId: string, placement: MenuItemPlacement): void {
    this.#edit(this.#doc.moveItem(itemId, placement));
  }

  deleteItem(itemId: string): void {
    this.#edit(this.#doc.deleteItem(itemId));
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
    const parsed = parseMenuDraftServerMessage(event.data);
    if (!parsed.ok) return this.#fail(parsed.error.code);
    this.#handle(socket, parsed.value);
  }

  #handle(socket: WebSocket, message: MenuDraftServerMessage): void {
    switch (message.kind) {
      case "sync_response": {
        if (this.#connection.kind !== "awaiting_sync") return this.#fail("invalid_message");
        this.#access = message.access;
        this.#documentRevision = message.documentRevision;
        this.#sessionId = message.sessionId;
        const applied = this.#doc.apply(message.missingUpdate);
        if (!applied.ok) return this.#fail(applied.error.code);
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
        break;
      case "failure":
        return this.#fail(message.code);
      default:
        return assertNever(message, "Unexpected menu client branch");
    }
    this.#emit();
  }

  #edit(result: MenuDraftCrdtResult<MenuDraftUpdate>): void {
    if (!result.ok) {
      if (
        result.error.code === "collection_limit" ||
        result.error.code === "record_conflict" ||
        result.error.code === "text_too_long"
      ) {
        this.#emit();
        return;
      }
      return this.#fail(result.error.code);
    }
    this.#revision++;
    if ((this.#connection.kind === "connected" || this.#connection.kind === "syncing") && this.#pending.kind === "idle") {
      this.#submit(result.value, "edit");
    }
    this.#emit();
  }

  #submit(update: MenuDraftUpdate, kind: "sync" | "edit"): void {
    const stateVector = this.#doc.stateVector();
    if (!stateVector.ok) return this.#fail(stateVector.error.code);
    const updateId = crypto.randomUUID();
    this.#pending = { kind, updateId, revision: this.#revision, stateVector: stateVector.value };
    this.#send({ kind: "submit_update", updateId, update });
  }

  #send(message: MenuDraftClientMessage): void {
    const socket = socketOf(this.#connection);
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(encodeMenuDraftClientMessage(message));
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
    const rect = this.#surface.getBoundingClientRect();
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
    this.#emit();
  }

  #stopLiveness(): void {
    this.#liveness?.stop();
    this.#liveness = null;
  }

  #fail(code: MenuDraftFailureCode): void {
    const previous = this.#connection;
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
    const base = {
      draft: this.#doc.read(),
      participants: this.#participants.map(markMenuParticipant.bind(null, this.#sessionId)),
      access: this.#access,
      documentRevision: this.#documentRevision,
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
      : this.#connection.kind === "connecting" || this.#connection.kind === "awaiting_sync"
        ? "connecting"
        : this.#connection.kind === "syncing" || this.#pending.kind !== "idle" || this.hasUnsyncedEdits()
          ? "syncing"
          : "synced";
    this.#notify({ ...base, kind });
  }
}

function markMenuParticipant(
  sessionId: string | null,
  participant: MenuDraftParticipant,
): MenuDraftPresenceView {
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
      return assertNever(connection, "Unexpected menu client branch");
  }
}

function failureMessage(code: MenuDraftFailureCode): string {
  switch (code) {
    case "access_revoked":
      return "Menu editing access ended.";
    case "collection_limit":
    case "text_too_long":
    case "record_conflict":
      return "That menu change could not be applied. Refresh the current menu and try again.";
    case "room_full":
      return "This menu already has 20 connected sessions.";
    case "storage_unavailable":
      return "The menu room is temporarily unavailable.";
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "update_too_large":
    case "state_too_large":
    case "state_vector_too_large":
    case "invalid_message":
      return "The shared menu could not be synchronized. Reload the page.";
    default:
      return assertNever(code, "Unexpected menu client branch");
  }
}
