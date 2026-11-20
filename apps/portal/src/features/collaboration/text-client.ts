import type {
  CollaborationAgentActivity,
  CollaborationPointerPosition,
  EncodedValue,
  SyncClientMessage,
  TextInputRange,
  TextSelectionDirection,
  TextSelectionRange,
} from "@purin-labs/collaboration";
import type { TextCollaborationServerMessage } from "@purin-labs/collaboration";
import {
  DocumentClient,
  type DocumentConnection,
  type DocumentParticipant,
  type DocumentReplica,
  type DocumentState,
  type Result,
} from "./document-client";

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
  pointer: Readonly<{
    position: CollaborationPointerPosition;
    updatedAt: number;
  }> | null;
  isSelf: boolean;
}>;

export type TextCollaborationView<Field extends string, Metadata> = Readonly<{
  values: Readonly<Record<Field, string>>;
  participants: readonly TextCollaborationParticipant<Field>[];
  agents: readonly CollaborationAgentActivity[];
  metadata: Metadata | null;
  readOnly: boolean;
}> &
  (
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
  readInputs(
    textareas: Readonly<Record<Field, HTMLTextAreaElement>>,
  ): Readonly<Record<Field, string>>;
  edit(
    document: Document,
    field: Field,
    next: string,
    range?: TextInputRange,
  ): Result<Update, FailureCode>;
  apply(document: Document, update: Update): Result<null, FailureCode>;
  stateVector(document: Document): Result<StateVector, FailureCode>;
  syncUpdate(
    document: Document,
    stateVector: StateVector,
  ): Result<Update, FailureCode>;
  captureLocalSelection(
    document: Document,
    field: Field,
    start: number,
    end: number,
    direction: TextSelectionDirection,
  ): LocalSelection;
  resolveLocalSelection(
    document: Document,
    selection: LocalSelection,
  ): TextSelectionRange;
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

export type TextCollaborationClientMessage<
  Update,
  StateVector,
  PresenceSelection,
> = SyncClientMessage<PresenceSelection, StateVector, Update>;

export type TextProtocolAdapter<
  Update,
  StateVector,
  PresenceSelection,
  Metadata,
  FailureCode extends string,
> = Readonly<{
  parseServer(
    frame: unknown,
  ): Result<
    TextCollaborationServerMessage<
      Update,
      StateVector,
      PresenceSelection,
      Metadata,
      FailureCode
    >,
    FailureCode
  >;
  encodeClient(
    message: TextCollaborationClientMessage<
      Update,
      StateVector,
      PresenceSelection
    >,
  ): string;
  failureMessage(code: FailureCode): string;
  invalidMessageCode: FailureCode;
}>;

type Composition<Field extends string, Document, LocalSelection> =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "composing";
      field: Field;
      base: Document;
      range: TextInputRange;
      selections: ReadonlyMap<Field, LocalSelection>;
    }>;

type NativeInput<Field extends string> =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "replacing";
      field: Field;
      before: string;
      range: TextInputRange;
    }>;

/**
 * Shared plain-text fields (Plan 40C): each textarea edits one field of the
 * document. Remote updates keep each caret at its place in the text.
 */
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
  readonly #textareas: Readonly<Record<Field, HTMLTextAreaElement>>;
  readonly #document: TextDocumentAdapter<
    Field,
    Document,
    Update,
    StateVector,
    LocalSelection,
    PresenceSelection,
    FailureCode
  >;
  readonly #protocol: TextProtocolAdapter<
    Update,
    StateVector,
    PresenceSelection,
    Metadata,
    FailureCode
  >;
  readonly #notify: (view: TextCollaborationView<Field, Metadata>) => void;
  readonly #client: DocumentClient<
    DocumentReplica<Update, StateVector, FailureCode>,
    Update,
    StateVector,
    PresenceSelection,
    FailureCode,
    Readonly<{ metadata: Metadata }>
  >;
  readonly #listeners = new Map<
    Field,
    Readonly<{
      input: () => void;
      beforeInput: () => void;
      compositionStart: () => void;
      compositionEnd: () => void;
    }>
  >();
  #composition: Composition<Field, Document, LocalSelection> = {
    kind: "idle",
  };
  #nativeInput: NativeInput<Field> = { kind: "idle" };
  #metadata: Metadata | null = null;
  #presenceTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #selectionChanged = this.#schedulePresence.bind(this);
  readonly #sendPresenceBound = this.#sendPresence.bind(this);
  readonly #pointerHide = this.#hidePointer.bind(this);

  constructor(
    input: Readonly<{
      url: string;
      surface: HTMLElement;
      textareas: Readonly<Record<Field, HTMLTextAreaElement>>;
      document: TextDocumentAdapter<
        Field,
        Document,
        Update,
        StateVector,
        LocalSelection,
        PresenceSelection,
        FailureCode
      >;
      protocol: TextProtocolAdapter<
        Update,
        StateVector,
        PresenceSelection,
        Metadata,
        FailureCode
      >;
      notify: (view: TextCollaborationView<Field, Metadata>) => void;
    }>,
  ) {
    const created = input.document.create();
    if (!created.ok) {
      throw new Error(created.error.code);
    }
    const doc = created.value;
    const adapter = input.document;
    this.#doc = doc;
    this.#textareas = input.textareas;
    this.#document = adapter;
    this.#protocol = input.protocol;
    this.#notify = input.notify;
    this.#client = new DocumentClient({
      url: input.url,
      surface: input.surface,
      create: () => ({
        stateVector: () => adapter.stateVector(doc),
        syncUpdate: (vector: StateVector) => adapter.syncUpdate(doc, vector),
        apply: this.#applyRemote.bind(this),
        destroy: () => adapter.destroy(doc),
      }),
      parse: (frame) => input.protocol.parseServer(frame),
      encode: (message) => input.protocol.encodeClient(message),
      invalidMessage: input.protocol.invalidMessageCode,
      unsavedInput: this.#unsavedInput.bind(this),
      presence: this.#presence.bind(this),
      syncResponse: (message) => {
        this.#metadata = message.metadata;
        if (message.access === "edit" || !this.#client.hasUnsyncedEdits()) {
          return true;
        }
        this.#client.fail(this.#protocol.invalidMessageCode);
        return false;
      },
      lost: this.#pointerHide,
      emit: this.#emit.bind(this),
    });
    for (const field of this.#document.fields) {
      this.#bindField(field);
    }
    window.addEventListener("blur", this.#pointerHide);
    window.addEventListener("scroll", this.#pointerHide, true);
    window.addEventListener("resize", this.#pointerHide);
    this.#client.connect();
  }

  dispose(): void {
    this.#client.dispose();
    if (this.#presenceTimer !== null) {
      clearTimeout(this.#presenceTimer);
    }
    for (const field of this.#document.fields) {
      this.#unbindField(field);
    }
    window.removeEventListener("blur", this.#pointerHide);
    window.removeEventListener("scroll", this.#pointerHide, true);
    window.removeEventListener("resize", this.#pointerHide);
    if (this.#composition.kind === "composing") {
      this.#document.destroy(this.#composition.base);
    }
  }

  hasUnsyncedEdits(): boolean {
    return this.#client.hasUnsyncedEdits();
  }

  #unsavedInput(): boolean {
    for (const field of this.#document.fields) {
      if (
        this.#textareas[field].value !== this.#document.read(this.#doc, field)
      ) {
        return true;
      }
    }
    return false;
  }

  #bindField(field: Field): void {
    const input = this.#onInput.bind(this, field);
    const beforeInput = this.#onBeforeInput.bind(this, field);
    const compositionStart = this.#onCompositionStart.bind(this, field);
    const compositionEnd = this.#onCompositionEnd.bind(this, field);
    this.#listeners.set(field, {
      input,
      beforeInput,
      compositionStart,
      compositionEnd,
    });
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
    if (listeners === undefined) {
      return;
    }
    const textarea = this.#textareas[field];
    textarea.removeEventListener("input", listeners.input);
    textarea.removeEventListener("beforeinput", listeners.beforeInput);
    textarea.removeEventListener(
      "compositionstart",
      listeners.compositionStart,
    );
    textarea.removeEventListener("compositionend", listeners.compositionEnd);
    textarea.removeEventListener("focus", this.#sendPresenceBound);
    textarea.removeEventListener("blur", this.#sendPresenceBound);
    textarea.removeEventListener("select", this.#selectionChanged);
    textarea.removeEventListener("keyup", this.#selectionChanged);
    textarea.removeEventListener("pointerup", this.#selectionChanged);
  }

  /** Applies a room update and keeps each caret at its place in the text. */
  #applyRemote(update: Update): Result<null, FailureCode> {
    const selections = this.#captureSelections(this.#doc);
    const applied = this.#document.apply(this.#doc, update);
    if (applied.ok && this.#composition.kind === "idle") {
      this.#renderTextareas(selections);
    }
    return applied;
  }

  #captureSelections(document: Document): ReadonlyMap<Field, LocalSelection> {
    const selections = new Map<Field, LocalSelection>();
    for (const field of this.#document.fields) {
      const textarea = this.#textareas[field];
      selections.set(
        field,
        this.#document.captureLocalSelection(
          document,
          field,
          textarea.selectionStart,
          textarea.selectionEnd,
          textarea.selectionDirection,
        ),
      );
    }
    return selections;
  }

  #renderTextareas(selections: ReadonlyMap<Field, LocalSelection>): void {
    for (const field of this.#document.fields) {
      const textarea = this.#textareas[field];
      const selection = selections.get(field);
      if (selection === undefined) {
        continue;
      }
      const next = this.#document.resolveLocalSelection(this.#doc, selection);
      const scrollTop = textarea.scrollTop;
      textarea.value = this.#document.read(this.#doc, field);
      textarea.setSelectionRange(next.start, next.end, next.direction);
      textarea.scrollTop = scrollTop;
    }
  }

  #onBeforeInput(field: Field): void {
    if (!this.#canEdit() || this.#composition.kind !== "idle") {
      return;
    }
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
    if (this.#composition.kind === "composing") {
      return this.#client.emit();
    }
    if (!this.#canEdit()) {
      return;
    }
    const textarea = this.#textareas[field];
    const before = this.#document.read(this.#doc, field);
    const range =
      input.kind === "replacing" &&
      input.field === field &&
      input.before === before
        ? input.range
        : undefined;
    this.#localEdit(
      this.#document.edit(this.#doc, field, textarea.value, range),
    );
  }

  #onCompositionStart(field: Field): void {
    if (!this.#canEdit() || this.#composition.kind !== "idle") {
      return;
    }
    const base = this.#document.clone(this.#doc);
    if (!base.ok) {
      return this.#client.fail(base.error.code);
    }
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
    if (composition.kind !== "composing" || composition.field !== field) {
      return;
    }
    this.#composition = { kind: "idle" };
    const textarea = this.#textareas[field];
    try {
      if (!this.#canEdit()) {
        return;
      }
      const edited = this.#document.edit(
        composition.base,
        field,
        textarea.value,
        composition.range,
      );
      if (!edited.ok) {
        return this.#client.fail(edited.error.code);
      }
      const activeSelection = this.#document.captureLocalSelection(
        composition.base,
        field,
        textarea.selectionStart,
        textarea.selectionEnd,
        textarea.selectionDirection,
      );
      const applied = this.#document.apply(this.#doc, edited.value);
      if (!applied.ok) {
        return this.#client.fail(applied.error.code);
      }
      const selections = new Map(composition.selections);
      selections.set(field, activeSelection);
      this.#renderTextareas(selections);
      this.#localEdit(edited);
    } finally {
      this.#document.destroy(composition.base);
    }
  }

  #localEdit(edited: Result<Update, FailureCode>): void {
    if (this.#client.edit(edited)) {
      this.#schedulePresence();
    }
  }

  #sendPresence(): void {
    this.#client.sendPresence(this.#presence());
  }

  /** The selection that this person shows. It also ends a waiting presence. */
  #presence(): PresenceSelection | null {
    if (this.#presenceTimer !== null) {
      clearTimeout(this.#presenceTimer);
    }
    this.#presenceTimer = null;
    const active = this.#activeField();
    if (
      active === null ||
      !this.#canEdit() ||
      this.#composition.kind !== "idle"
    ) {
      return null;
    }
    return this.#document.capturePresenceSelection(
      this.#doc,
      active.field,
      active.textarea.selectionStart,
      active.textarea.selectionEnd,
      active.textarea.selectionDirection,
    );
  }

  #activeField(): Readonly<{
    field: Field;
    textarea: HTMLTextAreaElement;
  }> | null {
    for (const field of this.#document.fields) {
      const textarea = this.#textareas[field];
      if (document.activeElement === textarea) {
        return { field, textarea };
      }
    }
    return null;
  }

  #schedulePresence(): void {
    if (this.#presenceTimer === null) {
      this.#presenceTimer = setTimeout(this.#sendPresenceBound, 100);
    }
  }

  #hidePointer(): void {
    this.#client.hidePointer();
  }

  #canEdit(): boolean {
    const connection = this.#client.connection;
    return (
      this.#metadata !== null &&
      this.#client.access === "edit" &&
      connection !== "failed" &&
      connection !== "closed"
    );
  }

  #emit(
    state: DocumentState<
      DocumentReplica<Update, StateVector, FailureCode>,
      PresenceSelection,
      FailureCode
    >,
  ): void {
    const readOnly = !this.#canEdit();
    for (const field of this.#document.fields) {
      this.#textareas[field].readOnly = readOnly;
    }
    const values = this.#document.readInputs(this.#textareas);
    if (state.status === "failed") {
      this.#notify({
        kind: "failed",
        message: this.#protocol.failureMessage(state.code),
        values,
        participants: [],
        agents: [],
        metadata: this.#metadata,
        readOnly: true,
      });
      return;
    }
    this.#notify({
      kind: this.#viewKind(state),
      values,
      participants: state.participants.map(this.#participantView.bind(this)),
      agents: state.connection === "connected" ? state.agents : [],
      metadata: this.#metadata,
      readOnly,
    });
  }

  #participantView(
    participant: DocumentParticipant<PresenceSelection>,
  ): TextCollaborationParticipant<Field> {
    return {
      sessionId: participant.sessionId,
      userId: participant.userId,
      displayName: participant.displayName,
      state: participant.state,
      selection:
        participant.selection === null
          ? null
          : this.#document.resolvePresenceSelection(
              this.#doc,
              participant.selection,
            ),
      activeAt: participant.activeAt,
      pointer: participant.pointer,
      isSelf: participant.isSelf,
    };
  }

  /**
   * A socket that connects again after a sync shows as reconnecting, and a
   * composition waits as an edit.
   */
  #viewKind(
    state: Readonly<{
      connection: DocumentConnection;
      status: "connecting" | "syncing" | "synced" | "reconnecting";
    }>,
  ): "connecting" | "synced" | "syncing" | "reconnecting" {
    if (state.connection === "connecting" && this.#metadata !== null) {
      return "reconnecting";
    }
    if (state.status === "synced" && this.#composition.kind === "composing") {
      return "syncing";
    }
    return state.status;
  }
}
