import { assertNever } from "@seams/std";
import {
  DraftEncoding,
  WorkflowDraftDoc,
} from "@seams/workflow-canvas-crdt/draft";
import {
  encodeDraftClientMessage,
  parseDraftServerMessage,
  type DraftClientMessage,
  type DraftParticipant,
  type DraftServerMessage,
} from "@seams/workflow-canvas-crdt/draft-protocol";
import { SocketLiveness } from "../collaboration/socket-liveness";

export type DraftConnectionView = Readonly<{
  status: "connecting" | "syncing" | "synced" | "reconnecting" | "failed";
  message: string;
  canEdit: boolean;
  participants: readonly DraftParticipant[];
}>;

type Listener = Readonly<{
  /** The first sync filled the replica, or a later one changed it. */
  changed(): void;
  view(view: DraftConnectionView): void;
  /** A person applied a revision. The page reads it again. */
  revisionChanged(): void;
}>;

type Connection =
  | Readonly<{
      kind: "connecting" | "awaiting_sync" | "connected";
      socket: WebSocket;
    }>
  | Readonly<{
      kind: "reconnecting";
      timer: ReturnType<typeof setTimeout>;
    }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "closed" }>;

/**
 * The page's view of one recipe's draft room. Edits reach the replica first, and
 * `flush` sends what the room has not acknowledged, so an edit made without a
 * connection arrives after the reconnect. It uses the acknowledged delta flow of
 * the other shared drafts.
 */
export class WorkflowDraftClient {
  readonly doc = WorkflowDraftDoc.createReplica();
  readonly #url: string;
  readonly #listener: Listener;
  #connection: Connection = { kind: "closed" };
  #liveness: SocketLiveness | null = null;
  #access: "read" | "edit" = "read";
  #attempts = 0;
  /** Local edits so far, and how many of them the room acknowledged. */
  #revision = 0;
  #acknowledgedRevision = 0;
  /** What the room holds. A delete moves no state vector, so it cannot say what is unsaved. */
  #roomVector: DraftEncoding<"state_vector"> | null = null;
  #pending: Readonly<{
    id: string;
    revision: number;
    vector: DraftEncoding<"state_vector">;
  }> | null = null;
  #participants: readonly DraftParticipant[] = [];
  #selection: Readonly<{ objectId: string }> | null = null;

  constructor(organisationId: string, workflowId: string, listener: Listener) {
    this.#listener = listener;
    const url = new URL(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/bakery/workflows/${encodeURIComponent(workflowId)}/socket`,
      window.location.origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.#url = url.href;
    this.#connect();
  }

  dispose(): void {
    const previous = this.#connection;
    this.#connection = { kind: "closed" };
    if (previous.kind === "reconnecting") clearTimeout(previous.timer);
    else socketOf(previous)?.close();
    this.#liveness?.stop();
    this.#liveness = null;
    this.doc.destroy();
  }

  select(objectId: string | null): void {
    this.#selection = objectId === null ? null : { objectId };
    this.#presence();
  }

  /** Call after each local edit. It sends what the room has not acknowledged. */
  flush(): void {
    this.#revision++;
    if (this.#connection.kind === "connected" && this.#pending === null)
      this.#submitUnacknowledged();
    this.#emit();
  }

  hasUnsyncedEdits(): boolean {
    return this.#revision > this.#acknowledgedRevision;
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
    this.#liveness?.stop();
    this.#liveness = new SocketLiveness(
      socket,
      this.#disconnected.bind(this, socket),
    );
    const vector = this.doc.stateVector();
    if (!vector.ok) return this.#fail("The draft cannot be read.");
    this.#send({ kind: "sync_request", stateVector: vector.value });
  }

  #received(socket: WebSocket, event: MessageEvent): void {
    if (socketOf(this.#connection) !== socket) return;
    if (this.#liveness?.received(event.data) === true) return;
    const parsed = parseDraftServerMessage(event.data);
    if (!parsed.ok) return this.#fail("The draft cannot be synchronized.");
    this.#handle(socket, parsed.value);
  }

  #handle(socket: WebSocket, message: DraftServerMessage): void {
    switch (message.kind) {
      case "sync_response": {
        const applied = this.doc.apply(message.missingUpdate);
        if (!applied.ok) return this.#fail("The draft cannot be synchronized.");
        this.#access = message.access;
        this.#attempts = 0;
        this.#pending = null;
        this.#roomVector = message.serverStateVector;
        this.#connection = { kind: "connected", socket };
        this.#listener.changed();
        if (this.hasUnsyncedEdits() && this.#access !== "edit")
          return this.#fail("Your access to edit this draft ended.");
        this.#submitUnacknowledged();
        this.#presence();
        break;
      }
      case "update_broadcast": {
        const applied = this.doc.apply(message.update);
        if (!applied.ok) return this.#fail("The draft cannot be synchronized.");
        this.#listener.changed();
        break;
      }
      case "update_accepted": {
        const pending = this.#pending;
        if (pending === null || pending.id !== message.updateId)
          return this.#fail("The room sent an unexpected receipt.");
        this.#roomVector = pending.vector;
        this.#acknowledgedRevision = pending.revision;
        this.#pending = null;
        this.#submitUnacknowledged();
        break;
      }
      case "presence_changed":
        this.#participants = message.participants;
        break;
      case "revision_changed":
        this.#listener.revisionChanged();
        return;
      case "failure":
        return this.#fail(
          message.code === "access_revoked"
            ? "Your access to this draft ended."
            : "This draft is unavailable. Reload the page to reconnect.",
        );
      default:
        return assertNever(message, "Unexpected draft message");
    }
    this.#emit();
  }

  #submitUnacknowledged(): void {
    if (
      this.#roomVector === null ||
      this.#access !== "edit" ||
      !this.hasUnsyncedEdits()
    )
      return;
    const update = this.doc.syncUpdate(this.#roomVector);
    const vector = this.doc.stateVector();
    if (!update.ok || !vector.ok)
      return this.#fail("The draft cannot be saved. Reload the page.");
    const id = crypto.randomUUID();
    this.#pending = { id, revision: this.#revision, vector: vector.value };
    this.#send({ kind: "submit_update", updateId: id, update: update.value });
  }

  #send(message: DraftClientMessage): void {
    const socket = socketOf(this.#connection);
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(encodeDraftClientMessage(message));
  }

  #presence(): void {
    if (this.#connection.kind !== "connected") return;
    this.#send({
      kind: "presence_update",
      state: this.#selection === null ? "viewing" : "editing",
      selection: this.#selection,
    });
  }

  #disconnected(socket: WebSocket): void {
    if (socketOf(this.#connection) !== socket) return;
    this.#liveness?.stop();
    this.#liveness = null;
    this.#participants = [];
    this.#pending = null;
    this.#attempts = Math.min(this.#attempts + 1, 4);
    this.#connection = {
      kind: "reconnecting",
      timer: setTimeout(
        this.#connect.bind(this),
        Math.min(1000 * 2 ** this.#attempts, 10000),
      ),
    };
    socket.close();
    this.#emit();
  }

  #fail(message: string): void {
    this.#liveness?.stop();
    this.#liveness = null;
    this.#participants = [];
    const previous = this.#connection;
    this.#connection = { kind: "failed", message };
    if (previous.kind === "reconnecting") clearTimeout(previous.timer);
    else socketOf(previous)?.close();
    this.#emit();
  }

  #emit(): void {
    const connection = this.#connection;
    if (connection.kind === "closed") return;
    this.#listener.view({
      ...statusOf(connection, this.hasUnsyncedEdits()),
      canEdit: connection.kind !== "failed" && this.#access === "edit",
      participants: connection.kind === "connected" ? this.#participants : [],
    });
  }
}

function statusOf(
  connection: Exclude<Connection, Readonly<{ kind: "closed" }>>,
  unsynced: boolean,
): Pick<DraftConnectionView, "status" | "message"> {
  switch (connection.kind) {
    case "connecting":
    case "awaiting_sync":
      return { status: "connecting", message: "Connecting the draft…" };
    case "reconnecting":
      return {
        status: "reconnecting",
        message: "Reconnecting. Your changes stay on this page until then.",
      };
    case "failed":
      return { status: "failed", message: connection.message };
    case "connected":
      return unsynced
        ? { status: "syncing", message: "Saving the draft…" }
        : { status: "synced", message: "Draft saved." };
    default:
      return assertNever(connection, "Unexpected draft connection");
  }
}

function socketOf(connection: Connection): WebSocket | null {
  switch (connection.kind) {
    case "connecting":
    case "awaiting_sync":
    case "connected":
      return connection.socket;
    case "reconnecting":
    case "failed":
    case "closed":
      return null;
    default:
      return assertNever(connection, "Unexpected draft connection");
  }
}
