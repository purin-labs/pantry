import { assertNever } from "@purin-labs/std";
import {
  DraftEncoding,
  WorkflowDraftDoc,
} from "@purin-labs/workflow-canvas-crdt/draft";
import {
  encodeDraftClientMessage,
  parseDraftServerMessage,
  type DraftClientMessage,
  type DraftParticipant,
  type DraftServerMessage,
} from "@purin-labs/workflow-canvas-crdt/draft-protocol";
import {
  DocumentSocket,
  webSocketUrl,
  type DocumentConnection,
} from "../collaboration/document-client";

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

/**
 * The page's view of one recipe's draft room. Edits reach the replica first, and
 * `flush` sends what the room has not acknowledged, so an edit made without a
 * connection arrives after the reconnect. It uses the acknowledged delta flow of
 * the other shared drafts.
 */
export class WorkflowDraftClient {
  readonly doc = WorkflowDraftDoc.createReplica();
  readonly #listener: Listener;
  /** The socket's failure is the message that the page shows. */
  readonly #socket: DocumentSocket<string, DraftClientMessage>;
  #access: "read" | "edit" = "read";
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
    this.#socket = new DocumentSocket(
      webSocketUrl(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/bakery/workflows/${encodeURIComponent(workflowId)}/socket`,
      ),
      encodeDraftClientMessage,
      {
        connecting: this.#emit.bind(this),
        opened: this.#requestSync.bind(this),
        received: this.#received.bind(this),
        closed: this.#closed.bind(this),
      },
    );
    this.#socket.connect();
  }

  dispose(): void {
    this.#socket.close();
    this.doc.destroy();
  }

  select(objectId: string | null): void {
    this.#selection = objectId === null ? null : { objectId };
    this.#presence();
  }

  /** Call after each local edit. It sends what the room has not acknowledged. */
  flush(): void {
    this.#revision++;
    if (this.#socket.kind === "connected" && this.#pending === null) {
      this.#submitUnacknowledged();
    }
    this.#emit();
  }

  hasUnsyncedEdits(): boolean {
    return this.#revision > this.#acknowledgedRevision;
  }

  #requestSync(): void {
    const vector = this.doc.stateVector();
    if (!vector.ok) {
      return this.#fail("The draft cannot be read.");
    }
    this.#socket.send({ kind: "sync_request", stateVector: vector.value });
  }

  #received(frame: unknown): void {
    const parsed = parseDraftServerMessage(frame);
    if (!parsed.ok) {
      return this.#fail("The draft cannot be synchronized.");
    }
    this.#handle(parsed.value);
  }

  #handle(message: DraftServerMessage): void {
    switch (message.kind) {
      case "sync_response": {
        const applied = this.doc.apply(message.missingUpdate);
        if (!applied.ok) {
          return this.#fail("The draft cannot be synchronized.");
        }
        this.#access = message.access;
        this.#socket.resetBackoff();
        this.#pending = null;
        this.#roomVector = message.serverStateVector;
        this.#socket.mark("connected");
        this.#listener.changed();
        if (this.hasUnsyncedEdits() && this.#access !== "edit") {
          return this.#fail("Your access to edit this draft ended.");
        }
        this.#submitUnacknowledged();
        this.#presence();
        break;
      }
      case "update_broadcast": {
        const applied = this.doc.apply(message.update);
        if (!applied.ok) {
          return this.#fail("The draft cannot be synchronized.");
        }
        this.#listener.changed();
        break;
      }
      case "update_accepted": {
        const pending = this.#pending;
        if (pending === null || pending.id !== message.updateId) {
          return this.#fail("The room sent an unexpected receipt.");
        }
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
    ) {
      return;
    }
    const update = this.doc.syncUpdate(this.#roomVector);
    const vector = this.doc.stateVector();
    if (!update.ok || !vector.ok) {
      return this.#fail("The draft cannot be saved. Reload the page.");
    }
    const id = crypto.randomUUID();
    this.#pending = { id, revision: this.#revision, vector: vector.value };
    this.#socket.send({
      kind: "submit_update",
      updateId: id,
      update: update.value,
    });
  }

  #presence(): void {
    if (this.#socket.kind !== "connected") {
      return;
    }
    this.#socket.send({
      kind: "presence_update",
      state: this.#selection === null ? "viewing" : "editing",
      selection: this.#selection,
    });
  }

  #closed(): void {
    this.#participants = [];
    this.#pending = null;
    this.#emit();
  }

  #fail(message: string): void {
    this.#socket.fail(message);
    this.#participants = [];
    this.#emit();
  }

  #emit(): void {
    const connection = this.#socket.kind;
    if (connection === "closed") {
      return;
    }
    this.#listener.view({
      ...statusOf(connection, this.#socket.failure, this.hasUnsyncedEdits()),
      canEdit: connection !== "failed" && this.#access === "edit",
      participants: connection === "connected" ? this.#participants : [],
    });
  }
}

function statusOf(
  connection: Exclude<DocumentConnection, "closed">,
  failure: string | null,
  unsynced: boolean,
): Pick<DraftConnectionView, "status" | "message"> {
  switch (connection) {
    case "connecting":
    case "awaiting_sync":
      return { status: "connecting", message: "Connecting the draft…" };
    case "reconnecting":
      return {
        status: "reconnecting",
        message: "Reconnecting. Your changes stay on this page until then.",
      };
    case "failed":
      return { status: "failed", message: failure ?? "" };
    case "syncing":
    case "connected":
      return unsynced
        ? { status: "syncing", message: "Saving the draft…" }
        : { status: "synced", message: "Draft saved." };
    default:
      return assertNever(connection, "Unexpected draft connection");
  }
}
