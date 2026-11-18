import {
  ProductionPlanDoc,
  type ProductionPlanCrdtResult,
  type ProductionPlanSelection,
  type ProductionPlanStateVector,
  type ProductionPlanUpdate,
} from "@seams/production-plan-crdt";
import {
  encodePlanClientMessage,
  parsePlanServerMessage,
  type PlanClientMessage,
  type PlanFailureCode,
  type PlanParticipant,
  type PlanServerMessage,
} from "@seams/production-plan-crdt/protocol";
import {
  COLLABORATION_POINTER_IDLE_MS,
  type CollaborationAgentActivity,
  type CollaborationPointerPosition,
} from "@seams/collaboration";
import { assertNever } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";
import { SocketLiveness } from "../collaboration/socket-liveness";

const SYNC_RETRY_LIMIT = 3;

/**
 * Plan 40D: the shared production plan of one location. Each person's
 * quantity change reaches the other open pages; "Accept plan" applies them.
 */
type Connection =
  | Readonly<{
      kind: "connecting" | "awaiting_sync" | "syncing" | "connected";
      socket: WebSocket;
    }>
  | Readonly<{ kind: "reconnecting"; timer: ReturnType<typeof setTimeout> }>
  | Readonly<{ kind: "failed"; code: PlanFailureCode }>
  | Readonly<{ kind: "closed" }>;

type Pending =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "sync" | "edit";
      updateId: string;
      revision: number;
      stateVector: ProductionPlanStateVector;
    }>;

export type ProductionPlanPresence = PlanParticipant &
  Readonly<{ isSelf: boolean }>;

export type ProductionPlanView = Readonly<{
  /** Draft quantity by request id. */
  lines: ReadonlyMap<string, string>;
  participants: readonly ProductionPlanPresence[];
  agents: readonly CollaborationAgentActivity[];
  access: "read" | "edit";
}> &
  StrictUnion<
    | Readonly<{ kind: "connecting" | "syncing" | "synced" | "reconnecting" }>
    | Readonly<{ kind: "failed"; message: string; recovery: "retry" | "none" }>
  >;

export class ProductionPlanClient {
  #doc: ProductionPlanDoc;
  readonly #url: string;
  readonly #surface: HTMLElement;
  readonly #notify: (view: ProductionPlanView) => void;
  #connection: Connection = { kind: "closed" };
  #pending: Pending = { kind: "idle" };
  #participants: readonly PlanParticipant[] = [];
  #agents: readonly CollaborationAgentActivity[] = [];
  #selection: ProductionPlanSelection | null = null;
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
    locationId: string,
    surface: HTMLElement,
    notify: (view: ProductionPlanView) => void,
  ) {
    this.#doc = ProductionPlanDoc.create();
    this.#surface = surface;
    this.#notify = notify;
    const url = new URL(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/inventory/production-plan/${encodeURIComponent(locationId)}/socket`,
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

  isSynced(): boolean {
    return (
      this.#connection.kind === "connected" &&
      this.#connection.socket.readyState === WebSocket.OPEN &&
      this.#pending.kind === "idle" &&
      !this.hasUnsyncedEdits()
    );
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

  /** The line that this person works on, shown to the others. */
  select(requestId: string | null): void {
    this.#selection = requestId === null ? null : { requestId };
    this.#sendPresence();
  }

  /** Returns false when the quantity is not a valid plan quantity. */
  setQuantity(requestId: string, quantity: string): boolean {
    const result = this.#doc.setQuantity(requestId, quantity);
    if (!result.ok && result.error.code === "quantity_invalid") return false;
    this.#edit(result);
    return true;
  }

  /** Removes lines whose requests left `requested`. */
  clear(requestIds: readonly string[]): void {
    this.#edit(this.#doc.clear(requestIds));
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
    const parsed = parsePlanServerMessage(event.data);
    if (!parsed.ok) return this.#fail(parsed.error.code);
    this.#handle(socket, parsed.value);
  }

  #handle(socket: WebSocket, message: PlanServerMessage): void {
    switch (message.kind) {
      case "sync_response": {
        if (this.#connection.kind !== "awaiting_sync")
          return this.#fail("invalid_message");
        if (
          this.#generation !== null &&
          this.#generation !== message.generation
        ) {
          // The room replaced the document. This copy's history must not
          // merge into the new one, so start again from the room's copy.
          this.#generation = null;
          this.#doc.destroy();
          this.#doc = ProductionPlanDoc.create();
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
        return assertNever(message, "Unexpected production plan branch");
    }
    this.#emit();
  }

  #edit(result: ProductionPlanCrdtResult<ProductionPlanUpdate>): void {
    if (!result.ok) {
      if (
        result.error.code === "collection_limit" ||
        result.error.code === "record_conflict"
      ) {
        this.#emit();
        return;
      }
      return this.#fail(result.error.code);
    }
    this.#revision++;
    if (
      (this.#connection.kind === "connected" ||
        this.#connection.kind === "syncing") &&
      this.#pending.kind === "idle"
    )
      this.#submit(result.value, "edit");
    this.#emit();
  }

  #submit(update: ProductionPlanUpdate, kind: "sync" | "edit"): void {
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

  #send(message: PlanClientMessage): void {
    const socket = socketOf(this.#connection);
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(encodePlanClientMessage(message));
  }

  #sendPresence(): void {
    if (
      this.#connection.kind !== "connected" &&
      this.#connection.kind !== "syncing"
    )
      return;
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

  #fail(code: PlanFailureCode): void {
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
    const lines = new Map<string, string>();
    for (const line of this.#doc.read().lines)
      lines.set(line.requestId, line.quantity);
    const base = {
      lines,
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
  participant: PlanParticipant,
): ProductionPlanPresence {
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
      return assertNever(connection, "Unexpected production plan branch");
  }
}

function failureRecovery(code: PlanFailureCode): "retry" | "none" {
  switch (code) {
    case "storage_unavailable":
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "invalid_message":
      return "retry";
    case "quantity_invalid":
    case "record_conflict":
    case "update_too_large":
    case "state_too_large":
    case "state_vector_too_large":
    case "access_revoked":
    case "collection_limit":
    case "room_full":
      return "none";
    default:
      return assertNever(code, "Unexpected production plan branch");
  }
}

function failureMessage(code: PlanFailureCode): string {
  switch (code) {
    case "access_revoked":
      return "Your access to this plan has ended.";
    case "collection_limit":
      return "This location's plan is full. Accept or clear lines before adding more.";
    case "quantity_invalid":
    case "record_conflict":
      return "That plan change could not be applied. Reload the page and try again.";
    case "room_full":
      return "This plan already has 20 connected sessions.";
    case "storage_unavailable":
      return "The plan is temporarily unavailable. Your changes remain on this page. Retry the connection.";
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "invalid_message":
      return "The shared plan could not be synchronized. Your changes remain on this page. Retry the connection.";
    case "update_too_large":
    case "state_too_large":
    case "state_vector_too_large":
      return "The shared plan could not be synchronized. Reload the page.";
    default:
      return assertNever(code, "Unexpected production plan branch");
  }
}
