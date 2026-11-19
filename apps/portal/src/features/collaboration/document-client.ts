import {
  COLLABORATION_POINTER_IDLE_MS,
  type CollaborationAgentActivity,
  type CollaborationParticipant,
  type CollaborationPointerPosition,
  type SyncClientMessage,
} from "@purin-labs/collaboration";
import { assertNever, backoffDelay } from "@purin-labs/std";
import { SocketLiveness } from "./socket-liveness";

/**
 * The Portal's side of a shared document room (Plan 92). `DocumentSocket`
 * keeps one room's socket open. `DocumentClient` adds the acknowledged update
 * flow of the menu, board, costs, plan and text drafts: each edit applies to
 * the local replica at once, goes to the room one at a time, and waits for
 * the room's receipt before the next.
 */

export type Result<T, Code extends string> =
  | Readonly<{ ok: true; value: T; error?: never }>
  | Readonly<{ ok: false; error: Readonly<{ code: Code }>; value?: never }>;

type Connection<Failure> =
  | Readonly<{
      kind: "connecting" | "awaiting_sync" | "syncing" | "connected";
      socket: WebSocket;
    }>
  | Readonly<{ kind: "reconnecting"; timer: ReturnType<typeof setTimeout> }>
  | Readonly<{ kind: "failed"; failure: Failure }>
  | Readonly<{ kind: "closed" }>;

export type DocumentConnection = Connection<unknown>["kind"];

type SocketEvents = Readonly<{
  /** A new socket is connecting. */
  connecting(): void;
  /** The socket opened, or the handshake restarts on it: ask for the document. */
  opened(): void;
  /** A frame from the room other than a pong. */
  received(frame: unknown): void;
  /** The socket closed; a new one connects after the backoff. */
  closed(): void;
}>;

/**
 * One document room's socket. It pings the room, and after a lost socket it
 * connects again after 2, 4, 8, then 10 s, until a sync restarts the backoff.
 */
export class DocumentSocket<Failure, Message> {
  readonly #url: string;
  readonly #encode: (message: Message) => string;
  readonly #events: SocketEvents;
  #connection: Connection<Failure> = { kind: "closed" };
  #liveness: SocketLiveness | null = null;
  #attempts = 0;

  constructor(
    url: string,
    encode: (message: Message) => string,
    events: SocketEvents,
  ) {
    this.#url = url;
    this.#encode = encode;
    this.#events = events;
  }

  get kind(): DocumentConnection {
    return this.#connection.kind;
  }

  /** What ended the connection, or null while it runs. */
  get failure(): Failure | null {
    return this.#connection.kind === "failed" ? this.#connection.failure : null;
  }

  hasSocket(): boolean {
    return socketOf(this.#connection) !== null;
  }

  isOpen(): boolean {
    return socketOf(this.#connection)?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#url);
    } catch {
      this.#connection = {
        kind: "reconnecting",
        timer: setTimeout(this.connect.bind(this), 1_000),
      };
      this.#events.connecting();
      return;
    }
    this.#connection = { kind: "connecting", socket };
    socket.addEventListener("open", this.#opened.bind(this, socket));
    socket.addEventListener("message", this.#received.bind(this, socket));
    socket.addEventListener("close", this.#lost.bind(this, socket));
    socket.addEventListener("error", this.#lost.bind(this, socket));
    this.#events.connecting();
  }

  /** Moves the open socket to the next step of the sync. */
  mark(kind: "awaiting_sync" | "syncing" | "connected"): void {
    const socket = socketOf(this.#connection);
    if (socket !== null) {
      this.#connection = { kind, socket };
    }
  }

  /** Runs the open handshake again on the open socket. */
  reopen(): void {
    const socket = socketOf(this.#connection);
    if (socket !== null) {
      this.#opened(socket);
    }
  }

  /** The room answered: the next lost socket waits the shortest time. */
  resetBackoff(): void {
    this.#attempts = 0;
  }

  send(message: Message): void {
    const socket = socketOf(this.#connection);
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(this.#encode(message));
    } catch {
      this.#lost(socket);
    }
  }

  /** Drops the open socket and connects again after the backoff. */
  reconnect(): void {
    const socket = socketOf(this.#connection);
    if (socket !== null) {
      this.#lost(socket);
    }
  }

  fail(failure: Failure): void {
    const previous = this.#connection;
    this.#connection = { kind: "failed", failure };
    this.#stopLiveness();
    if (previous.kind === "reconnecting") {
      clearTimeout(previous.timer);
    } else {
      socketOf(previous)?.close();
    }
  }

  close(): void {
    const previous = this.#connection;
    this.#connection = { kind: "closed" };
    if (previous.kind === "reconnecting") {
      clearTimeout(previous.timer);
    } else {
      socketOf(previous)?.close();
    }
    this.#stopLiveness();
  }

  #opened(socket: WebSocket): void {
    if (socketOf(this.#connection) !== socket) {
      return;
    }
    this.#connection = { kind: "awaiting_sync", socket };
    this.#stopLiveness();
    this.#liveness = new SocketLiveness(socket, this.#lost.bind(this, socket));
    this.#events.opened();
  }

  #received(socket: WebSocket, event: MessageEvent): void {
    if (socketOf(this.#connection) !== socket) {
      return;
    }
    if (this.#liveness?.received(event.data) === true) {
      return;
    }
    this.#events.received(event.data);
  }

  #lost(socket: WebSocket): void {
    if (socketOf(this.#connection) !== socket) {
      return;
    }
    this.#stopLiveness();
    this.#attempts = Math.min(this.#attempts + 1, 4);
    this.#connection = {
      kind: "reconnecting",
      timer: setTimeout(
        this.connect.bind(this),
        backoffDelay(this.#attempts, 1_000, 10_000),
      ),
    };
    socket.close();
    this.#events.closed();
  }

  #stopLiveness(): void {
    this.#liveness?.stop();
    this.#liveness = null;
  }
}

/** A participant of the room, marked when it is this page's own session. */
export type DocumentParticipant<Selection> =
  CollaborationParticipant<Selection> & Readonly<{ isSelf: boolean }>;

/** The replica operations of the sync. Each CRDT document class has them. */
export type DocumentReplica<
  Update,
  StateVector,
  Code extends string,
> = Readonly<{
  stateVector(): Result<StateVector, Code>;
  syncUpdate(stateVector: StateVector): Result<Update, Code>;
  apply(update: Update): Result<unknown, Code>;
  destroy(): void;
}>;

/** A sync response; `Room` holds the fields that the room adds to it. */
type SyncResponse<StateVector, Update, Room> = Readonly<{
  kind: "sync_response";
  serverStateVector: StateVector;
  missingUpdate: Update;
  access: "read" | "edit";
  sessionId: string;
}> &
  Room;

type ServerMessage<Selection, StateVector, Update, Code extends string, Room> =
  | SyncResponse<StateVector, Update, Room>
  | Readonly<{ kind: "update_accepted"; updateId: string }>
  | Readonly<{ kind: "update_broadcast"; update: Update }>
  | Readonly<{
      kind: "presence_changed";
      agents: readonly CollaborationAgentActivity[];
      participants: readonly CollaborationParticipant<Selection>[];
    }>
  | Readonly<{ kind: "failure"; code: Code }>;

type Pending<StateVector> =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "sync" | "edit";
      updateId: string;
      revision: number;
      stateVector: StateVector;
    }>;

/** What a page shows of its replica and the room. */
export type DocumentState<Replica, Selection, Code extends string> = Readonly<{
  replica: Replica;
  connection: Exclude<DocumentConnection, "closed">;
  access: "read" | "edit";
  participants: readonly DocumentParticipant<Selection>[];
  agents: readonly CollaborationAgentActivity[];
  /** No update waits for a receipt, and the room holds every local edit. */
  settled: boolean;
}> &
  (
    | Readonly<{ status: "connecting" | "syncing" | "synced" | "reconnecting" }>
    | Readonly<{ status: "failed"; code: Code }>
  );

type DocumentClientConfig<
  Replica,
  Update,
  StateVector,
  Selection,
  Code extends string,
  Room,
> = Readonly<{
  url: string;
  /** Pointer positions go to the room as fractions of this element. */
  surface: HTMLElement;
  create(): Replica;
  /**
   * `Room` is not inferred from here: a parser returns the whole message
   * union, which would become `Room`. It comes from the client's own type.
   */
  parse(
    frame: unknown,
  ): Result<
    ServerMessage<Selection, StateVector, Update, Code, NoInfer<Room>>,
    Code
  >;
  encode(message: SyncClientMessage<Selection, StateVector, Update>): string;
  invalidMessage: Code;
  /** Local edit refusals that keep the connection: the view shows again. */
  ignoredEditFailures?: readonly Code[];
  /**
   * Retries a recoverable failure as a reconnect, up to `limit` times in a
   * row. With it, the backoff restarts when the room accepts the sync, not
   * at the sync response.
   */
  retry?: Readonly<{ limit: number; recovery(code: Code): "retry" | "none" }>;
  /** Keeps the agents' activity while the socket reconnects. */
  keepAgents?: boolean;
  /** Typed text that the replica does not hold yet. */
  unsavedInput?(): boolean;
  /**
   * The document generation that a sync response names. When it changes,
   * the room replaced the document: this replica's history must not merge
   * into the new one, so the replica starts again from the room's copy.
   */
  generation?(message: SyncResponse<StateVector, Update, Room>): number;
  /** This page's selection, sent as its presence after each sync. */
  presence(): Selection | null;
  /** Runs before the sync response applies. False ends the response here. */
  syncResponse?(message: SyncResponse<StateVector, Update, Room>): boolean;
  /** The sync response's missing update applied to the replica. */
  synced?(message: SyncResponse<StateVector, Update, Room>): void;
  /** A collaborator's update applied to the replica. */
  updated?(): void;
  /** The socket closed, or the connection failed. */
  lost?(): void;
  emit(state: DocumentState<Replica, Selection, Code>): void;
}>;

export class DocumentClient<
  Replica extends DocumentReplica<Update, StateVector, Code>,
  Update,
  StateVector,
  Selection,
  Code extends string,
  Room = unknown,
> {
  readonly #config: DocumentClientConfig<
    Replica,
    Update,
    StateVector,
    Selection,
    Code,
    Room
  >;
  readonly #socket: DocumentSocket<
    Code,
    SyncClientMessage<Selection, StateVector, Update>
  >;
  #replica: Replica;
  #pending: Pending<StateVector> = { kind: "idle" };
  #participants: readonly CollaborationParticipant<Selection>[] = [];
  #agents: readonly CollaborationAgentActivity[] = [];
  #access: "read" | "edit" = "read";
  #sessionId: string | null = null;
  #generation: number | null = null;
  #revision = 0;
  #acknowledgedRevision = 0;
  #syncFailures = 0;
  #pointerSurface: HTMLElement;
  #pointer: CollaborationPointerPosition | null = null;
  #pointerTimer: ReturnType<typeof setTimeout> | null = null;
  #pointerIdle: ReturnType<typeof setTimeout> | null = null;
  readonly #pointerMove = this.#movePointer.bind(this);
  readonly #pointerHide = this.hidePointer.bind(this);
  readonly #pointerSend = this.#sendPointer.bind(this);
  readonly #beforeUnload = this.#onBeforeUnload.bind(this);

  /** Call `connect` once the page holds the client. */
  constructor(
    config: DocumentClientConfig<
      Replica,
      Update,
      StateVector,
      Selection,
      Code,
      Room
    >,
  ) {
    this.#config = config;
    this.#replica = config.create();
    this.#pointerSurface = config.surface;
    this.#socket = new DocumentSocket(config.url, config.encode, {
      connecting: this.emit.bind(this),
      opened: this.#requestSync.bind(this),
      received: this.#received.bind(this),
      closed: this.#closed.bind(this),
    });
    config.surface.addEventListener("pointermove", this.#pointerMove);
    config.surface.addEventListener("pointerleave", this.#pointerHide);
    config.surface.addEventListener("pointercancel", this.#pointerHide);
    window.addEventListener("beforeunload", this.#beforeUnload);
  }

  get replica(): Replica {
    return this.#replica;
  }

  /** The number of local edits so far. */
  get revision(): number {
    return this.#revision;
  }

  get access(): "read" | "edit" {
    return this.#access;
  }

  get connection(): DocumentConnection {
    return this.#socket.kind;
  }

  connect(): void {
    this.#socket.connect();
  }

  dispose(): void {
    this.hidePointer();
    this.#socket.close();
    const surface = this.#config.surface;
    surface.removeEventListener("pointermove", this.#pointerMove);
    surface.removeEventListener("pointerleave", this.#pointerHide);
    surface.removeEventListener("pointercancel", this.#pointerHide);
    window.removeEventListener("beforeunload", this.#beforeUnload);
    this.#replica.destroy();
  }

  hasUnsyncedEdits(): boolean {
    return (
      this.#revision > this.#acknowledgedRevision ||
      this.#config.unsavedInput?.() === true
    );
  }

  isSynced(): boolean {
    return (
      this.#socket.kind === "connected" &&
      this.#socket.isOpen() &&
      this.#settled()
    );
  }

  /** Connects again after a failure that `retry.recovery` allows. */
  retry(): void {
    const code = this.#socket.failure;
    if (code === null || this.#config.retry?.recovery(code) !== "retry") {
      return;
    }
    this.#syncFailures = 0;
    this.#socket.connect();
  }

  /**
   * Asks the room for the document again on the open socket. False when an
   * edit waits for the room or the socket is not connected.
   */
  resync(): boolean {
    if (this.#socket.kind !== "connected" || !this.#settled()) {
      return false;
    }
    const vector = this.#replica.stateVector();
    if (!vector.ok) {
      return false;
    }
    this.#socket.mark("awaiting_sync");
    this.#send({ kind: "sync_request", stateVector: vector.value });
    return true;
  }

  /** Sends a local edit to the room. False when it changed nothing. */
  edit(result: Result<Update | null, Code>): boolean {
    if (!result.ok) {
      if (
        this.#config.ignoredEditFailures?.includes(result.error.code) === true
      ) {
        this.emit();
      } else {
        this.fail(result.error.code);
      }
      return false;
    }
    if (result.value === null) {
      return false;
    }
    this.#revision++;
    if (this.#live() && this.#pending.kind === "idle") {
      this.#submit(result.value, "edit");
    }
    this.emit();
    return true;
  }

  sendPresence(selection: Selection | null): void {
    if (!this.#live()) {
      return;
    }
    this.#send({
      kind: "presence_update",
      state: selection === null ? "viewing" : "editing",
      selection,
    });
  }

  /** Pointer positions go as fractions of `element`, or of the surface. */
  setPointerSurface(element: HTMLElement | null): void {
    this.#pointerSurface = element ?? this.#config.surface;
  }

  hidePointer(): void {
    if (this.#pointerTimer !== null) {
      clearTimeout(this.#pointerTimer);
    }
    if (this.#pointerIdle !== null) {
      clearTimeout(this.#pointerIdle);
    }
    this.#pointerTimer = null;
    this.#pointerIdle = null;
    if (this.#pointer === null) {
      return;
    }
    this.#pointer = null;
    this.#sendPointer();
  }

  fail(code: Code): void {
    if (this.#retries(code)) {
      this.#syncFailures++;
      this.#socket.reconnect();
      return;
    }
    this.#socket.fail(code);
    this.#config.lost?.();
    this.emit();
  }

  /** Shows the view again. */
  emit(): void {
    const connection = this.#socket.kind;
    if (connection === "closed") {
      return;
    }
    const settled = this.#settled();
    const sessionId = this.#sessionId;
    const base = {
      replica: this.#replica,
      connection,
      access: this.#access,
      participants: this.#participants.map(
        (participant): DocumentParticipant<Selection> => ({
          ...participant,
          isSelf: participant.sessionId === sessionId,
        }),
      ),
      agents: this.#agents,
      settled,
    };
    const code = this.#socket.failure;
    this.#config.emit(
      code === null
        ? { ...base, status: statusOf(connection, settled) }
        : { ...base, status: "failed", code },
    );
  }

  #requestSync(): void {
    const vector = this.#replica.stateVector();
    if (!vector.ok) {
      return this.fail(vector.error.code);
    }
    this.#send({ kind: "sync_request", stateVector: vector.value });
  }

  #received(frame: unknown): void {
    const parsed = this.#config.parse(frame);
    if (!parsed.ok) {
      return this.fail(parsed.error.code);
    }
    this.#handle(parsed.value);
  }

  #handle(
    message: ServerMessage<Selection, StateVector, Update, Code, Room>,
  ): void {
    switch (message.kind) {
      case "sync_response": {
        if (this.#socket.kind !== "awaiting_sync") {
          return this.fail(this.#config.invalidMessage);
        }
        const generation = this.#config.generation?.(message) ?? null;
        if (generation !== null) {
          if (this.#generation !== null && this.#generation !== generation) {
            return this.#replace();
          }
          this.#generation = generation;
        }
        if (this.#config.syncResponse?.(message) === false) {
          return;
        }
        this.#access = message.access;
        this.#sessionId = message.sessionId;
        const applied = this.#replica.apply(message.missingUpdate);
        if (!applied.ok) {
          return this.fail(applied.error.code);
        }
        this.#config.synced?.(message);
        if (this.#config.retry === undefined) {
          this.#socket.resetBackoff();
        }
        this.#pending = { kind: "idle" };
        if (message.access === "edit") {
          const update = this.#replica.syncUpdate(message.serverStateVector);
          if (!update.ok) {
            return this.fail(update.error.code);
          }
          this.#socket.mark("syncing");
          this.#submit(update.value, "sync");
        } else {
          this.#connected();
        }
        this.sendPresence(this.#config.presence());
        break;
      }
      case "update_broadcast": {
        const applied = this.#replica.apply(message.update);
        if (!applied.ok) {
          return this.fail(applied.error.code);
        }
        this.#config.updated?.();
        break;
      }
      case "update_accepted": {
        const pending = this.#pending;
        if (pending.kind === "idle" || pending.updateId !== message.updateId) {
          return this.fail(this.#config.invalidMessage);
        }
        this.#acknowledgedRevision = Math.max(
          this.#acknowledgedRevision,
          pending.revision,
        );
        this.#pending = { kind: "idle" };
        if (pending.kind === "sync") {
          this.#connected();
        }
        if (this.#revision > this.#acknowledgedRevision) {
          const update = this.#replica.syncUpdate(pending.stateVector);
          if (!update.ok) {
            return this.fail(update.error.code);
          }
          this.#submit(update.value, "edit");
        }
        break;
      }
      case "presence_changed":
        this.#participants = message.participants;
        this.#agents = message.agents;
        break;
      case "failure":
        return this.fail(message.code);
      default:
        return assertNever(message, "Unexpected document client message");
    }
    this.emit();
  }

  /** Starts again from an empty replica on the open socket. */
  #replace(): void {
    this.#generation = null;
    this.#replica.destroy();
    this.#replica = this.#config.create();
    this.#revision = 0;
    this.#acknowledgedRevision = 0;
    this.#pending = { kind: "idle" };
    this.#socket.reopen();
  }

  #connected(): void {
    this.#socket.mark("connected");
    if (this.#config.retry !== undefined) {
      this.#socket.resetBackoff();
      this.#syncFailures = 0;
    }
  }

  #submit(update: Update, kind: "sync" | "edit"): void {
    const stateVector = this.#replica.stateVector();
    if (!stateVector.ok) {
      return this.fail(stateVector.error.code);
    }
    const updateId = crypto.randomUUID();
    this.#pending = {
      kind,
      updateId,
      revision: this.#revision,
      stateVector: stateVector.value,
    };
    this.#send({ kind: "submit_update", updateId, update });
  }

  #send(message: SyncClientMessage<Selection, StateVector, Update>): void {
    this.#socket.send(message);
  }

  #closed(): void {
    this.#participants = [];
    if (this.#config.keepAgents !== true) {
      this.#agents = [];
    }
    this.#config.lost?.();
    this.emit();
  }

  #retries(code: Code): boolean {
    const retry = this.#config.retry;
    return (
      retry !== undefined &&
      this.#socket.hasSocket() &&
      retry.recovery(code) === "retry" &&
      this.#syncFailures < retry.limit
    );
  }

  #live(): boolean {
    return this.#socket.kind === "connected" || this.#socket.kind === "syncing";
  }

  #settled(): boolean {
    return (
      this.#pending.kind === "idle" &&
      this.#revision <= this.#acknowledgedRevision
    );
  }

  #movePointer(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      return;
    }
    const rect = this.#pointerSurface.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    this.#pointer = {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
    if (this.#pointerTimer === null) {
      this.#pointerTimer = setTimeout(this.#pointerSend, 50);
    }
    if (this.#pointerIdle !== null) {
      clearTimeout(this.#pointerIdle);
    }
    this.#pointerIdle = setTimeout(
      this.#pointerHide,
      COLLABORATION_POINTER_IDLE_MS,
    );
  }

  #sendPointer(): void {
    this.#pointerTimer = null;
    if (this.#live()) {
      this.#send({ kind: "pointer_update", position: this.#pointer });
    }
  }

  #onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!this.hasUnsyncedEdits()) {
      return;
    }
    event.preventDefault();
    event.returnValue = "";
  }
}

/** The WebSocket URL of a path on this origin. */
export function webSocketUrl(path: string): string {
  const url = new URL(path, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function statusOf(
  connection: DocumentConnection,
  settled: boolean,
): "connecting" | "syncing" | "synced" | "reconnecting" {
  if (connection === "reconnecting") {
    return "reconnecting";
  }
  if (connection === "connecting" || connection === "awaiting_sync") {
    return "connecting";
  }
  return connection === "syncing" || !settled ? "syncing" : "synced";
}

function socketOf<Failure>(connection: Connection<Failure>): WebSocket | null {
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
      return assertNever(connection, "Unexpected document connection");
  }
}
