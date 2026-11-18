import {
  COLLABORATION_POINTER_IDLE_MS,
  type CollaborationAgentActivity,
  type CollaborationParticipant,
  type CollaborationPointerPosition,
  type TextInputRange,
  type TextSelectionDirection,
  type TextSelectionRange,
  type EncodedValue,
} from "@seams/collaboration";
import { assertNever } from "@seams/std";
import { SocketLiveness } from "./socket-liveness";
import type { TextCollaborationServerMessage } from "@seams/control-api/portal/text-collaboration";

export type Result<T, Code extends string> =
  | Readonly<{ ok: true; value: T; error?: never }>
  | Readonly<{ ok: false; error: Readonly<{ code: Code }>; value?: never }>;

export type TextCollaborationPresence<Field extends string> = Readonly<{
  field: Field;
  range: TextSelectionRange;
}>;

export type TextCollaborationParticipant<Field extends string> = Readonly<{
  sessionId: string;
  userId: string;
  displayName: string;
  state: "viewing" | "editing";
  selection: TextCollaborationPresence<Field> | null;
  activeAt: number;
  pointer: Readonly<{ position: CollaborationPointerPosition; updatedAt: number }> | null;
  isSelf: boolean;
}>;

export type TextCollaborationView<Field extends string, Metadata> = Readonly<{
  values: Readonly<Record<Field, string>>;
  participants: readonly TextCollaborationParticipant<Field>[];
  agents: readonly CollaborationAgentActivity[];
  metadata: Metadata | null;
  readOnly: boolean;
}> & (
  | Readonly<{ kind: "connecting" | "synced" | "syncing" | "reconnecting" }>
  | Readonly<{ kind: "failed"; message: string }>
);

export type TextDocumentAdapter<
  Field extends string,
  Document,
  Update,
  StateVector,
  LocalSelection,
  PresenceSelection,
  FailureCode extends string,
> = Readonly<{
  fields: readonly Field[];
  create(): Result<Document, FailureCode>;
  clone(document: Document): Result<Document, FailureCode>;
  read(document: Document, field: Field): string;
  readInputs(textareas: Readonly<Record<Field, HTMLTextAreaElement>>): Readonly<Record<Field, string>>;
  edit(document: Document, field: Field, next: string, range?: TextInputRange): Result<Update, FailureCode>;
  apply(document: Document, update: Update): Result<null, FailureCode>;
  stateVector(document: Document): Result<StateVector, FailureCode>;
  syncUpdate(document: Document, stateVector: StateVector): Result<Update, FailureCode>;
  captureLocalSelection(
    document: Document,
    field: Field,
    start: number,
    end: number,
    direction: TextSelectionDirection,
  ): LocalSelection;
  resolveLocalSelection(document: Document, selection: LocalSelection): TextSelectionRange;
  capturePresenceSelection(
    document: Document,
    field: Field,
    start: number,
    end: number,
    direction: TextSelectionDirection,
  ): PresenceSelection;
  resolvePresenceSelection(
    document: Document,
    selection: PresenceSelection,
  ): TextCollaborationPresence<Field> | null;
  destroy(document: Document): void;
}>;

export type TextCollaborationClientMessage<Update, StateVector, PresenceSelection> =
  | Readonly<{ kind: "pointer_update"; position: CollaborationPointerPosition | null }>
  | Readonly<{ kind: "presence_update"; state: "viewing" | "editing"; selection: PresenceSelection | null }>
  | Readonly<{ kind: "sync_request"; stateVector: StateVector }>
  | Readonly<{ kind: "submit_update"; updateId: string; update: Update }>;

export type TextProtocolAdapter<Update, StateVector, PresenceSelection, Metadata, FailureCode extends string> = Readonly<{
  parseServer(frame: unknown): Result<TextCollaborationServerMessage<Update, StateVector, PresenceSelection, Metadata, FailureCode>, FailureCode>;
  encodeClient(message: TextCollaborationClientMessage<Update, StateVector, PresenceSelection>): string;
  failureMessage(code: FailureCode): string;
  invalidMessageCode: FailureCode;
}>;

export type Connection<FailureCode extends string> =
  | Readonly<{ kind: "connecting" | "awaiting_sync" | "syncing" | "connected"; socket: WebSocket }>
  | Readonly<{ kind: "reconnecting"; timer: ReturnType<typeof setTimeout> }>
  | Readonly<{ kind: "failed"; code: FailureCode }>
  | Readonly<{ kind: "closed" }>;

export type PendingUpdate<StateVector> =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "sync" | "edit"; updateId: string; revision: number; stateVector: StateVector }>;

export type Composition<Field extends string, Document, LocalSelection> =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "composing";
      field: Field;
      base: Document;
      range: TextInputRange;
      selections: ReadonlyMap<Field, LocalSelection>;
    }>;

export type NativeInput<Field extends string> =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "replacing"; field: Field; before: string; range: TextInputRange }>;

export class TextCollaborationClient<
  Field extends string,
  Document,
  Update,
  StateVector extends EncodedValue,
  LocalSelection,
  PresenceSelection,
  Metadata,
  FailureCode extends string,
> {
  readonly #doc: Document;
  readonly #surface: HTMLElement;
  readonly #textareas: Readonly<Record<Field, HTMLTextAreaElement>>;
  readonly #document: TextDocumentAdapter<Field, Document, Update, StateVector, LocalSelection, PresenceSelection, FailureCode>;
  readonly #protocol: TextProtocolAdapter<Update, StateVector, PresenceSelection, Metadata, FailureCode>;
  readonly #notify: (view: TextCollaborationView<Field, Metadata>) => void;
  readonly #url: string;
  readonly #listeners = new Map<Field, Readonly<{
    input: () => void;
    beforeInput: () => void;
    compositionStart: () => void;
    compositionEnd: () => void;
  }>>();
  #connection: Connection<FailureCode> = { kind: "closed" };
  #pending: PendingUpdate<StateVector> = { kind: "idle" };
  #composition: Composition<Field, Document, LocalSelection> = { kind: "idle" };
  #nativeInput: NativeInput<Field> = { kind: "idle" };
  #agents: readonly CollaborationAgentActivity[] = [];
  #participants: readonly CollaborationParticipant<PresenceSelection>[] = [];
  #metadata: Metadata | null = null;
  #access: "read" | "edit" = "read";
  #sessionId: string | null = null;
  #revision = 0;
  #acknowledgedRevision = 0;
  #attempts = 0;
  #presenceTimer: ReturnType<typeof setTimeout> | null = null;
  #pointerTimer: ReturnType<typeof setTimeout> | null = null;
  #pointerIdle: ReturnType<typeof setTimeout> | null = null;
  #pointer: CollaborationPointerPosition | null = null;
  #liveness: SocketLiveness | null = null;
  readonly #selectionChanged = this.#schedulePresence.bind(this);
  readonly #sendPresenceBound = this.#sendPresence.bind(this);
  readonly #pointerMove = this.#movePointer.bind(this);
  readonly #pointerHide = this.#hidePointer.bind(this);
  readonly #pointerSend = this.#sendPointer.bind(this);
  readonly #beforeUnload = this.#onBeforeUnload.bind(this);

  constructor(input: Readonly<{
    url: string;
    surface: HTMLElement;
    textareas: Readonly<Record<Field, HTMLTextAreaElement>>;
    document: TextDocumentAdapter<Field, Document, Update, StateVector, LocalSelection, PresenceSelection, FailureCode>;
    protocol: TextProtocolAdapter<Update, StateVector, PresenceSelection, Metadata, FailureCode>;
    notify: (view: TextCollaborationView<Field, Metadata>) => void;
  }>) {
    const created = input.document.create();
    if (!created.ok) throw new Error(created.error.code);
    this.#doc = created.value;
    this.#url = input.url;
    this.#surface = input.surface;
    this.#textareas = input.textareas;
    this.#document = input.document;
    this.#protocol = input.protocol;
    this.#notify = input.notify;
    for (const field of this.#document.fields) this.#bindField(field);
    this.#surface.addEventListener("pointermove", this.#pointerMove);
    this.#surface.addEventListener("pointerleave", this.#pointerHide);
    this.#surface.addEventListener("pointercancel", this.#pointerHide);
    window.addEventListener("blur", this.#pointerHide);
    window.addEventListener("scroll", this.#pointerHide, true);
    window.addEventListener("resize", this.#pointerHide);
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
    if (this.#presenceTimer !== null) clearTimeout(this.#presenceTimer);
    for (const field of this.#document.fields) this.#unbindField(field);
    this.#surface.removeEventListener("pointermove", this.#pointerMove);
    this.#surface.removeEventListener("pointerleave", this.#pointerHide);
    this.#surface.removeEventListener("pointercancel", this.#pointerHide);
    window.removeEventListener("blur", this.#pointerHide);
    window.removeEventListener("scroll", this.#pointerHide, true);
    window.removeEventListener("resize", this.#pointerHide);
    window.removeEventListener("beforeunload", this.#beforeUnload);
    if (this.#composition.kind === "composing") this.#document.destroy(this.#composition.base);
    this.#document.destroy(this.#doc);
  }

  hasUnsyncedEdits(): boolean {
    if (this.#revision > this.#acknowledgedRevision) return true;
    for (const field of this.#document.fields) {
      if (this.#textareas[field].value !== this.#document.read(this.#doc, field)) return true;
    }
    return false;
  }

  #bindField(field: Field): void {
    const input = this.#onInput.bind(this, field);
    const beforeInput = this.#onBeforeInput.bind(this, field);
    const compositionStart = this.#onCompositionStart.bind(this, field);
    const compositionEnd = this.#onCompositionEnd.bind(this, field);
    this.#listeners.set(field, { input, beforeInput, compositionStart, compositionEnd });
    const textarea = this.#textareas[field];
    textarea.addEventListener("input", input);
    textarea.addEventListener("beforeinput", beforeInput);
    textarea.addEventListener("compositionstart", compositionStart);
    textarea.addEventListener("compositionend", compositionEnd);
    textarea.addEventListener("focus", this.#sendPresenceBound);
    textarea.addEventListener("blur", this.#sendPresenceBound);
    textarea.addEventListener("select", this.#selectionChanged);
    textarea.addEventListener("keyup", this.#selectionChanged);
    textarea.addEventListener("pointerup", this.#selectionChanged);
  }

  #unbindField(field: Field): void {
    const listeners = this.#listeners.get(field);
    if (listeners === undefined) return;
    const textarea = this.#textareas[field];
    textarea.removeEventListener("input", listeners.input);
    textarea.removeEventListener("beforeinput", listeners.beforeInput);
    textarea.removeEventListener("compositionstart", listeners.compositionStart);
    textarea.removeEventListener("compositionend", listeners.compositionEnd);
    textarea.removeEventListener("focus", this.#sendPresenceBound);
    textarea.removeEventListener("blur", this.#sendPresenceBound);
    textarea.removeEventListener("select", this.#selectionChanged);
    textarea.removeEventListener("keyup", this.#selectionChanged);
    textarea.removeEventListener("pointerup", this.#selectionChanged);
  }

  #connect(): void {
    try {
      const socket = new WebSocket(this.#url);
      this.#connection = { kind: "connecting", socket };
      socket.addEventListener("open", this.#opened.bind(this, socket));
      socket.addEventListener("message", this.#received.bind(this, socket));
      socket.addEventListener("close", this.#disconnected.bind(this, socket));
      socket.addEventListener("error", this.#disconnected.bind(this, socket));
      this.#emit();
    } catch {
      this.#connection = { kind: "reconnecting", timer: setTimeout(this.#connect.bind(this), 1_000) };
      this.#emit();
    }
  }

  #opened(socket: WebSocket): void {
    if (socketOf(this.#connection) !== socket) return;
    this.#connection = { kind: "awaiting_sync", socket };
    this.#stopLiveness();
    this.#liveness = new SocketLiveness(socket, this.#disconnected.bind(this, socket));
    const vector = this.#document.stateVector(this.#doc);
    if (!vector.ok) return this.#fail(vector.error.code);
    this.#send({ kind: "sync_request", stateVector: vector.value });
  }

  #received(socket: WebSocket, event: MessageEvent): void {
    if (socketOf(this.#connection) !== socket) return;
    if (this.#liveness?.received(event.data) === true) return;
    const parsed = this.#protocol.parseServer(event.data);
    if (!parsed.ok) return this.#fail(parsed.error.code);
    this.#handle(socket, parsed.value);
  }

  #handle(
    socket: WebSocket,
    message: TextCollaborationServerMessage<Update, StateVector, PresenceSelection, Metadata, FailureCode>,
  ): void {
    switch (message.kind) {
      case "sync_response": {
        if (this.#connection.kind !== "awaiting_sync") return this.#failMessage();
        this.#sessionId = message.sessionId;
        this.#access = message.access;
        this.#metadata = message.metadata;
        if (message.access === "read" && this.hasUnsyncedEdits()) return this.#failMessage();
        if (!this.#applyRemote(message.missingUpdate)) return;
        this.#attempts = 0;
        this.#pending = { kind: "idle" };
        if (message.access === "edit") {
          const update = this.#document.syncUpdate(this.#doc, message.serverStateVector);
          if (!update.ok) return this.#fail(update.error.code);
          this.#connection = { kind: "syncing", socket };
          this.#submit(update.value, "sync");
        } else {
          this.#connection = { kind: "connected", socket };
        }
        this.#sendPresence();
        break;
      }
      case "update_broadcast":
        if (!this.#applyRemote(message.update)) return;
        break;
      case "update_accepted": {
        const accepted = this.#pending;
        if (accepted.kind === "idle" || accepted.updateId !== message.updateId) return this.#failMessage();
        this.#acknowledgedRevision = Math.max(this.#acknowledgedRevision, accepted.revision);
        this.#pending = { kind: "idle" };
        if (accepted.kind === "sync") this.#connection = { kind: "connected", socket };
        if (this.#revision > this.#acknowledgedRevision) {
          const update = this.#document.syncUpdate(this.#doc, accepted.stateVector);
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
        return assertNever(message, "Unexpected collaboration client state");
    }
    this.#emit();
  }

  #applyRemote(update: Update): boolean {
    const selections = this.#captureSelections(this.#doc);
    const applied = this.#document.apply(this.#doc, update);
    if (!applied.ok) {
      this.#fail(applied.error.code);
      return false;
    }
    if (this.#composition.kind === "idle") {
      this.#renderTextareas(selections);
    }
    return true;
  }

  #captureSelections(document: Document): ReadonlyMap<Field, LocalSelection> {
    const selections = new Map<Field, LocalSelection>();
    for (const field of this.#document.fields) {
      const textarea = this.#textareas[field];
      selections.set(field, this.#document.captureLocalSelection(
        document,
        field,
        textarea.selectionStart,
        textarea.selectionEnd,
        textarea.selectionDirection,
      ));
    }
    return selections;
  }

  #renderTextareas(selections: ReadonlyMap<Field, LocalSelection>): void {
    for (const field of this.#document.fields) {
      const textarea = this.#textareas[field];
      const selection = selections.get(field);
      if (selection === undefined) continue;
      const next = this.#document.resolveLocalSelection(this.#doc, selection);
      const scrollTop = textarea.scrollTop;
      textarea.value = this.#document.read(this.#doc, field);
      textarea.setSelectionRange(next.start, next.end, next.direction);
      textarea.scrollTop = scrollTop;
    }
  }

  #onBeforeInput(field: Field): void {
    if (!this.#canEdit() || this.#composition.kind !== "idle") return;
    const textarea = this.#textareas[field];
    this.#nativeInput = {
      kind: "replacing",
      field,
      before: textarea.value,
      range: { start: textarea.selectionStart, end: textarea.selectionEnd },
    };
  }

  #onInput(field: Field): void {
    const input = this.#nativeInput;
    this.#nativeInput = { kind: "idle" };
    if (this.#composition.kind === "composing") return this.#emit();
    if (!this.#canEdit()) return;
    const textarea = this.#textareas[field];
    const before = this.#document.read(this.#doc, field);
    const range = input.kind === "replacing" && input.field === field && input.before === before
      ? input.range
      : undefined;
    const edited = this.#document.edit(this.#doc, field, textarea.value, range);
    if (!edited.ok) return this.#fail(edited.error.code);
    this.#localEdit(edited.value);
  }

  #onCompositionStart(field: Field): void {
    if (!this.#canEdit() || this.#composition.kind !== "idle") return;
    const base = this.#document.clone(this.#doc);
    if (!base.ok) return this.#fail(base.error.code);
    const textarea = this.#textareas[field];
    this.#nativeInput = { kind: "idle" };
    this.#composition = {
      kind: "composing",
      field,
      base: base.value,
      range: { start: textarea.selectionStart, end: textarea.selectionEnd },
      selections: this.#captureSelections(this.#doc),
    };
    this.#sendPresence();
  }

  #onCompositionEnd(field: Field): void {
    const composition = this.#composition;
    if (composition.kind !== "composing" || composition.field !== field) return;
    this.#composition = { kind: "idle" };
    const textarea = this.#textareas[field];
    try {
      if (!this.#canEdit()) return;
      const edited = this.#document.edit(composition.base, field, textarea.value, composition.range);
      if (!edited.ok) return this.#fail(edited.error.code);
      const activeSelection = this.#document.captureLocalSelection(
        composition.base,
        field,
        textarea.selectionStart,
        textarea.selectionEnd,
        textarea.selectionDirection,
      );
      const applied = this.#document.apply(this.#doc, edited.value);
      if (!applied.ok) return this.#fail(applied.error.code);
      const selections = new Map(composition.selections);
      selections.set(field, activeSelection);
      this.#renderTextareas(selections);
      this.#localEdit(edited.value);
    } finally {
      this.#document.destroy(composition.base);
    }
  }

  #localEdit(update: Update): void {
    this.#revision++;
    if ((this.#connection.kind === "connected" || this.#connection.kind === "syncing") && this.#pending.kind === "idle") {
      this.#submit(update, "edit");
    }
    this.#schedulePresence();
    this.#emit();
  }

  #submit(update: Update, kind: "sync" | "edit"): void {
    const stateVector = this.#document.stateVector(this.#doc);
    if (!stateVector.ok) return this.#fail(stateVector.error.code);
    const updateId = crypto.randomUUID();
    this.#pending = { kind, updateId, revision: this.#revision, stateVector: stateVector.value };
    this.#send({ kind: "submit_update", updateId, update });
  }

  #send(message: TextCollaborationClientMessage<Update, StateVector, PresenceSelection>): void {
    const socket = socketOf(this.#connection);
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(this.#protocol.encodeClient(message));
    } catch {
      this.#disconnected(socket);
    }
  }

  #sendPresence(): void {
    if (this.#presenceTimer !== null) clearTimeout(this.#presenceTimer);
    this.#presenceTimer = null;
    if (this.#connection.kind !== "connected" && this.#connection.kind !== "syncing") return;
    const active = this.#activeField();
    const editing = active !== null && this.#canEdit() && this.#composition.kind === "idle";
    const selection = editing && active !== null
      ? this.#document.capturePresenceSelection(
          this.#doc,
          active.field,
          active.textarea.selectionStart,
          active.textarea.selectionEnd,
          active.textarea.selectionDirection,
        )
      : null;
    this.#send({ kind: "presence_update", state: editing ? "editing" : "viewing", selection });
  }

  #activeField(): Readonly<{ field: Field; textarea: HTMLTextAreaElement }> | null {
    for (const field of this.#document.fields) {
      const textarea = this.#textareas[field];
      if (document.activeElement === textarea) return { field, textarea };
    }
    return null;
  }

  #schedulePresence(): void {
    if (this.#presenceTimer === null) this.#presenceTimer = setTimeout(this.#sendPresenceBound, 100);
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
    this.#pointerIdle = setTimeout(this.#pointerHide, COLLABORATION_POINTER_IDLE_MS);
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
    socket.close();
    this.#participants = [];
    this.#agents = [];
    this.#hidePointer();
    this.#emit();
  }

  #stopLiveness(): void {
    this.#liveness?.stop();
    this.#liveness = null;
  }

  #fail(code: FailureCode): void {
    const previous = this.#connection;
    this.#connection = { kind: "failed", code };
    this.#stopLiveness();
    if (previous.kind === "reconnecting") clearTimeout(previous.timer);
    else socketOf(previous)?.close();
    this.#emit();
  }

  #failMessage(): void {
    this.#fail(this.#protocol.invalidMessageCode);
  }

  #canEdit(): boolean {
    return this.#metadata !== null && this.#access === "edit" &&
      this.#connection.kind !== "failed" && this.#connection.kind !== "closed";
  }

  #onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!this.hasUnsyncedEdits()) return;
    event.preventDefault();
    event.returnValue = "";
  }

  #emit(): void {
    if (this.#connection.kind === "closed") return;
    for (const field of this.#document.fields) {
      const textarea = this.#textareas[field];
      textarea.readOnly = !this.#canEdit();
    }
    const values = this.#document.readInputs(this.#textareas);
    const participants = this.#participants.map(this.#participantView.bind(this));
    if (this.#connection.kind === "failed") {
      this.#notify({
        kind: "failed",
        message: this.#protocol.failureMessage(this.#connection.code),
        values,
        participants: [],
        agents: [],
        metadata: this.#metadata,
        readOnly: true,
      });
      return;
    }
    const kind = this.#viewKind();
    this.#notify({ kind, values, participants, agents: this.#connection.kind === "connected" ? this.#agents : [], metadata: this.#metadata, readOnly: !this.#canEdit() });
  }

  #participantView(participant: CollaborationParticipant<PresenceSelection>): TextCollaborationParticipant<Field> {
    return {
      sessionId: participant.sessionId,
      userId: participant.userId,
      displayName: participant.displayName,
      state: participant.state,
      selection: participant.selection === null
        ? null
        : this.#document.resolvePresenceSelection(this.#doc, participant.selection),
      activeAt: participant.activeAt,
      pointer: participant.pointer,
      isSelf: participant.sessionId === this.#sessionId,
    };
  }

  #viewKind(): "connecting" | "synced" | "syncing" | "reconnecting" {
    if (this.#connection.kind === "reconnecting" ||
      this.#connection.kind === "connecting" && this.#metadata !== null) return "reconnecting";
    if (this.#connection.kind === "connecting" || this.#connection.kind === "awaiting_sync") return "connecting";
    if (this.#connection.kind === "syncing" || this.#pending.kind !== "idle" ||
      this.#revision > this.#acknowledgedRevision || this.#composition.kind === "composing") return "syncing";
    return "synced";
  }
}

export function socketOf<FailureCode extends string>(connection: Connection<FailureCode>): WebSocket | null {
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
      return assertNever(connection, "Unexpected collaboration client state");
  }
}
