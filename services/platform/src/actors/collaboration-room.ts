import { assertNever } from "@purin-labs/std";
import {
  authorizeSessionTurnExecution,
  type SessionTurnExecution,
} from "../chat/turn-access";
import { createContinueSerialQueue } from "@purin-labs/async-control/serial-queue";
import {
  COLLABORATION_SOCKET_LIMIT,
  type CollaborationAgentActivity,
  isCollaborationPointer,
  isCollaborationPresenceState,
  type CollaborationParticipant,
  type CollaborationPointer,
  type CollaborationPointerPosition,
  type CollaborationPresenceState,
  type EncodedValue,
} from "@purin-labs/collaboration";
import { isNonNegativeInteger, isRecord } from "@purin-labs/std";
import type { AuthorizedOrganisationRequest } from "../control/authorization";
import {
  listOrganisationMembers,
  type ActiveOrganisationMembership,
} from "../data/control-plane";
import type { Env } from "../env";
import {
  parseControlSessionId,
  type ControlSessionId,
  type OrganisationId,
} from "../ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import { newRequestId } from "../ids";
import { traceWarn } from "../observability";
import type { Result } from "../result";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { admitActorRecovery } from "./actor-activation";
import { isOrganisationExecutionActive } from "./actor-execution-quiescence";
import {
  SOCKET_MOVED,
  SOCKET_SILENCE_LIMIT_MS,
  acceptSocket,
  closeSocket,
  openSockets,
  socketLastSeenAt,
  socketRouteTag,
} from "./hibernatable-sockets";
import {
  socketSessionAccess,
  socketSessionMembership,
} from "./socket-session-access";

export type CollaborationRoomClientMessage<Update, StateVector, Selection> =
  | Readonly<{
      kind: "pointer_update";
      position: CollaborationPointerPosition | null;
    }>
  | Readonly<{
      kind: "presence_update";
      state: CollaborationPresenceState;
      selection: Selection | null;
    }>
  | Readonly<{ kind: "sync_request"; stateVector: StateVector }>
  | Readonly<{ kind: "submit_update"; updateId: string; update: Update }>;

export type CollaborationRoomServerMessage<
  Update,
  StateVector,
  Selection,
  Metadata,
  FailureCode extends string,
> =
  | Readonly<{
      kind: "sync_response";
      serverStateVector: StateVector;
      missingUpdate: Update;
      metadata: Metadata;
      access: "read" | "edit";
      sessionId: string;
    }>
  | Readonly<{ kind: "update_accepted"; updateId: string }>
  | Readonly<{ kind: "update_broadcast"; update: Update }>
  | Readonly<{
      kind: "presence_changed";
      participants: readonly CollaborationParticipant<Selection>[];
      agents: readonly CollaborationAgentActivity[];
    }>
  | Readonly<{ kind: "failure"; code: FailureCode }>;

export type CollaborationRoomProtocol<
  Update,
  StateVector,
  Selection,
  Metadata,
  FailureCode extends string,
> = Readonly<{
  frameLimit: number;
  failureCodes: Readonly<{
    invalidMessage: FailureCode;
    accessRevoked: FailureCode;
    storageUnavailable: FailureCode;
    roomFull: FailureCode;
  }>;
  parseClientMessage(
    frame: unknown,
  ): Result<
    CollaborationRoomClientMessage<Update, StateVector, Selection>,
    Readonly<{ code: FailureCode }>
  >;
  encodeServerMessage(
    message: CollaborationRoomServerMessage<
      Update,
      StateVector,
      Selection,
      Metadata,
      FailureCode
    >,
  ): string;
}>;

type CollaborationRoomDocument<
  Update,
  StateVector,
  FailureCode extends string,
> = Readonly<{
  apply(update: Update): Result<null, Readonly<{ code: FailureCode }>>;
  state(): Result<EncodedValue, Readonly<{ code: FailureCode }>>;
  stateVector(): Result<StateVector, Readonly<{ code: FailureCode }>>;
  syncUpdate(
    stateVector: StateVector,
  ): Result<Update, Readonly<{ code: FailureCode }>>;
  destroy(): void;
}>;

export type CollaborationRoomBacking<
  Document,
  Metadata,
  FailureCode extends string,
> = Readonly<{
  initialize(
    userId: UserId,
    scope: OrganisationExecutionScope,
  ): Promise<Result<null, Readonly<{ code: FailureCode }>>>;
  readDocument(): Result<Document, Readonly<{ code: FailureCode }>>;
  readForSync(
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      Readonly<{ document: Document; metadata: Metadata }>,
      Readonly<{ code: FailureCode }>
    >
  >;
  persist(state: Uint8Array, userId: UserId): void;
  /**
   * The feature's own check of one participant, after the role check passed.
   * It may lower `edit` to `read`, refuse the participant, or report that it
   * could not run. A room without it gives each role its usual access.
   */
  participantAccess?(
    participant: CollaborationParticipantCheck,
    scope: OrganisationExecutionScope,
  ): Promise<CollaborationParticipantAccess>;
}>;

export type CollaborationParticipantCheck = Readonly<{
  controlSessionId: ControlSessionId;
  membership: ActiveOrganisationMembership;
}>;

export type CollaborationParticipantAccess =
  "read" | "edit" | "refused" | "unavailable";

export type CollaborationMutationOrigin =
  | Readonly<{
      kind: "session_turn";
      execution: SessionTurnExecution;
      controlSessionId?: never;
    }>
  | Readonly<{
      kind: "control_session";
      controlSessionId: ControlSessionId;
      execution?: never;
    }>;

export type CollaborationMutationAuthority = Readonly<{
  origin: CollaborationMutationOrigin;
  scope: OrganisationExecutionScope;
  userId: UserId;
  deadlineAt: number;
}>;

type ActiveAgentOperation = {
  readonly activity: CollaborationAgentActivity;
  readonly authority: CollaborationMutationAuthority;
  pending: number;
};
// An agent's edit takes a few milliseconds, too short for a person to see.
// After an accepted edit, the room keeps the agent's label on its target for
// this long, or until the same agent starts its next edit. The label grants
// nothing and is not checked again: the turn often ends inside the hold.
export const AGENT_ACTIVITY_HOLD_MS = 5_000;
type HeldAgentActivity = Readonly<{
  activity: CollaborationAgentActivity;
  timer: ReturnType<typeof setTimeout>;
}>;
// A draft preview (Plan 40B phase 7, slices 3 and 4): the edit that the
// model writes now, before the Session runs it. It lasts this long after its
// last frame, so a stream that stops leaves no box on the board. The room
// admits the agent again at most this often while a preview streams.
const AGENT_PREVIEW_LIFETIME_MS = 6_000;
const AGENT_PREVIEW_ADMISSION_MS = 2_000;
type AgentPreview = {
  readonly activity: CollaborationAgentActivity;
  readonly authority: CollaborationMutationAuthority;
  readonly admittedAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
};
type AgentOperationRegistration =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "active"; key: string; entry: ActiveAgentOperation }>;

type CollaborationMutation<Update, Value, Error> = () => Result<
  Readonly<{ value: Value; update: Update | null }>,
  Error
>;

export type CollaborationRoomKind =
  | "costs_sheet"
  | "email_draft"
  | "mail_reply_draft"
  | "menu_board"
  | "menu_draft"
  | "product_description"
  | "production_plan"
  | "workflow_canvas"
  | "workflow_draft";

/** The room that a socket belongs to. The host reads it after a wake. */
export type CollaborationSocketRoute = Readonly<{
  kind: CollaborationRoomKind;
  key: string;
}>;

/**
 * Everything the room knows about one participant. It lives in the socket's
 * attachment, so it survives while the Actor leaves memory. It holds the
 * control session's identity, never the browser's bearer token.
 */
type CollaborationSocketAttachment<Selection> = Readonly<{
  route: CollaborationSocketRoute;
  sessionId: string;
  controlSessionId: ControlSessionId;
  userId: UserId;
  displayName: string;
  openedAccess: "read" | "edit";
  state: CollaborationPresenceState;
  selection: Selection | null;
  activeAt: number;
  pointer: CollaborationPointer | null;
  lastMessageAt: number;
}>;

/** What the Actor's socket handlers need from a room of any kind. */
export interface CollaborationSocketRoom {
  receive(socket: WebSocket, data: string | ArrayBuffer): void;
  closed(socket: WebSocket): void;
  sweep(): Promise<void>;
}

type CollaborationPeer<Selection> = Readonly<{
  socket: WebSocket;
  attachment: CollaborationSocketAttachment<Selection>;
}>;

/**
 * A socket's access, checked again now. `access_unavailable` means the check
 * could not run; the socket closes, and its client reconnects through the
 * open path, which checks access again before it syncs.
 */
type CollaborationAccess = Result<
  "read" | "edit",
  Readonly<{ code: "access_revoked" | "access_unavailable" }>
>;

export class CollaborationRoom<
  Update,
  StateVector,
  Selection,
  Metadata,
  FailureCode extends string,
  Document extends CollaborationRoomDocument<Update, StateVector, FailureCode>,
> {
  readonly #ctx: DurableObjectState;
  readonly #storage: DurableObjectStorage;
  readonly #env: Env;
  readonly #organisationId: OrganisationId;
  readonly #protocol: CollaborationRoomProtocol<
    Update,
    StateVector,
    Selection,
    Metadata,
    FailureCode
  >;
  readonly #backing: CollaborationRoomBacking<Document, Metadata, FailureCode>;
  readonly #route: CollaborationSocketRoute;
  readonly #tag: Promise<string>;
  readonly #onEmpty: () => void;
  readonly #closeReason: string;
  readonly #queue = createContinueSerialQueue();
  // Messages of one socket that wait in the queue. A wake resets the count,
  // because the queue of the earlier activation is gone with it.
  readonly #queued = new WeakMap<WebSocket, number>();
  #pendingOpens = 0;
  #pendingMutations = 0;
  // Set when the host drops the room. The Organisation's sweep can still hold
  // the room after that, and a new room then serves the same sockets.
  #dropped = false;
  readonly #agents = new Map<string, ActiveAgentOperation>();
  // Keyed by the agent's Session: one held label for each agent.
  readonly #heldAgents = new Map<string, HeldAgentActivity>();
  // Keyed by the agent's Session and the preview's operation.
  readonly #previews = new Map<string, AgentPreview>();

  constructor(
    input: Readonly<{
      ctx: DurableObjectState;
      env: Env;
      organisationId: OrganisationId;
      protocol: CollaborationRoomProtocol<
        Update,
        StateVector,
        Selection,
        Metadata,
        FailureCode
      >;
      backing: CollaborationRoomBacking<Document, Metadata, FailureCode>;
      route: CollaborationSocketRoute;
      closeReason: string;
      onEmpty: () => void;
    }>,
  ) {
    this.#ctx = input.ctx;
    this.#storage = input.ctx.storage;
    this.#env = input.env;
    this.#organisationId = input.organisationId;
    this.#protocol = input.protocol;
    this.#backing = input.backing;
    this.#route = input.route;
    this.#tag = socketRouteTag(input.route.kind, input.route.key);
    this.#closeReason = input.closeReason;
    this.#onEmpty = input.onEmpty;
  }

  open(
    authorized: AuthorizedOrganisationRequest,
    displayName: string,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    this.#pendingOpens++;
    return this.#queue
      .enqueue(this.#open.bind(this, authorized, displayName, scope))
      .then(this.#opened.bind(this), this.#openFailed.bind(this));
  }

  /** A message on one of this room's sockets, from the Actor's handler. */
  receive(socket: WebSocket, data: string | ArrayBuffer): void {
    if (
      typeof data !== "string" ||
      data.length > this.#protocol.frameLimit ||
      new TextEncoder().encode(data).byteLength > this.#protocol.frameLimit
    ) {
      this.#malformed(socket, "frame_size");
      return;
    }
    const queued = (this.#queued.get(socket) ?? 0) + 1;
    if (queued > 8) {
      this.#malformed(socket, "queue_limit");
      return;
    }
    this.#queued.set(socket, queued);
    void this.#queue
      .enqueue(this.#message.bind(this, socket, data))
      .catch(this.#unexpected.bind(this, socket));
  }

  /** A socket of this room closed or failed, from the Actor's handler. */
  closed(socket: WebSocket): void {
    this.#queued.delete(socket);
    void this.#queue
      .enqueue(this.#afterClose.bind(this))
      .catch(this.#ignore.bind(this));
  }

  /**
   * Closes sockets whose client stopped answering and sockets whose access
   * ended, then sends presence once. The Actor's alarm runs it.
   */
  sweep(): Promise<void> {
    return this.#queue.enqueue(this.#sweep.bind(this));
  }

  async #sweep(): Promise<void> {
    if (!this.#dropped) await this.#refreshPresence();
  }

  /**
   * Ends each socket with a final failure, after the feature closed the
   * document. It runs after the work that the queue already holds.
   */
  end(code: FailureCode): Promise<void> {
    return this.#queue.enqueue(this.#end.bind(this, code));
  }

  async #end(code: FailureCode): Promise<void> {
    for (const peer of await this.#peers()) this.#fail(peer.socket, code);
  }

  async mutate<Value, Error extends Readonly<{ code: string }>>(
    authority: CollaborationMutationAuthority,
    mutation: CollaborationMutation<Update, Value, Error>,
    activity: CollaborationAgentActivity | null = null,
  ): Promise<
    Result<
      Value,
      | Error
      | Readonly<{
          code:
            "access_revoked" | "organisation_placement_conflict" | "room_full";
        }>
    >
  > {
    this.#pendingMutations++;
    let registration: AgentOperationRegistration = { kind: "none" };
    let accepted = false;
    try {
      if (activity !== null) {
        if (
          authority.origin.kind !== "session_turn" ||
          activity.agent.sessionId !== authority.origin.execution.sessionId
        )
          return accessRevoked();
        const admission = await this.#admitMutation(authority);
        if (!admission.ok) return admission;
        const key = JSON.stringify([
          activity.agent.sessionId,
          activity.operationId,
        ]);
        let entry = this.#agents.get(key);
        if (entry === undefined) {
          if (this.#agents.size >= COLLABORATION_SOCKET_LIMIT)
            return { ok: false, error: { code: "room_full" } };
          entry = { activity, authority, pending: 0 };
          this.#agents.set(key, entry);
        }
        entry.pending++;
        registration = { kind: "active", key, entry };
        this.#releaseHeldAgent(activity.agent.sessionId);
        // The real edit takes the place of the agent's draft preview.
        this.#releasePreviews(activity.agent.sessionId);
      }
      const result = await this.#queue.enqueue(
        (this.#mutate<Value, Error>).bind(this, authority, mutation),
      );
      accepted = result.ok;
      return result;
    } finally {
      if (registration.kind === "active") {
        if (this.#agents.get(registration.key) === registration.entry) {
          registration.entry.pending--;
          if (registration.entry.pending === 0) {
            this.#agents.delete(registration.key);
            if (accepted)
              this.#holdAgent(appliedActivity(registration.entry.activity));
          }
        }
        await this.#queue.enqueue(this.#refreshPresence.bind(this));
      }
      this.#mutationFinished();
    }
  }

  /**
   * Shows the edit that an agent's model writes now, before the Session runs
   * it (Plan 40B phase 7). The Session sends it only after the checks of the
   * edit pass; the room admits the agent as it admits an edit. A preview
   * changes nothing: it is presence, and the room never stores it.
   */
  async preview(
    authority: CollaborationMutationAuthority,
    activity: CollaborationAgentActivity,
  ): Promise<
    Result<
      null,
      Readonly<{
        code:
          "access_revoked" | "organisation_placement_conflict" | "room_full";
      }>
    >
  > {
    if (
      authority.origin.kind !== "session_turn" ||
      activity.agent.sessionId !== authority.origin.execution.sessionId
    )
      return accessRevoked();
    if (this.#dropped) return { ok: true, value: null };
    this.#pendingMutations++;
    try {
      const key = JSON.stringify([
        activity.agent.sessionId,
        activity.operationId,
      ]);
      const before = this.#previews.get(key);
      let admittedAt = before?.admittedAt ?? 0;
      if (Date.now() - admittedAt >= AGENT_PREVIEW_ADMISSION_MS) {
        if (
          before === undefined &&
          this.#agents.size + this.#previews.size >= COLLABORATION_SOCKET_LIMIT
        )
          return { ok: false, error: { code: "room_full" } };
        const admission = await this.#admitMutation(authority);
        if (!admission.ok) {
          this.#releasePreview(key);
          await this.#queue.enqueue(this.#publishPresence.bind(this));
          return admission;
        }
        admittedAt = Date.now();
      } else if (Date.now() >= authority.deadlineAt) {
        this.#releasePreview(key);
        await this.#queue.enqueue(this.#publishPresence.bind(this));
        return accessRevoked();
      }
      // A late frame never brings a preview back after its edit started.
      if (this.#dropped || this.#agentEditing(activity.agent.sessionId))
        return { ok: true, value: null };
      this.#releasePreview(key);
      this.#releaseHeldAgent(activity.agent.sessionId);
      this.#previews.set(key, {
        activity,
        authority,
        admittedAt,
        timer: setTimeout(
          this.#previewExpired.bind(this, key, activity),
          AGENT_PREVIEW_LIFETIME_MS,
        ),
      });
      await this.#queue.enqueue(this.#publishPresence.bind(this));
      return { ok: true, value: null };
    } finally {
      this.#mutationFinished();
    }
  }

  /** The Session ended a preview without an edit: its model stream ended. */
  async endPreview(
    authority: CollaborationMutationAuthority,
    agentSessionId: string,
    operationId: string,
  ): Promise<void> {
    if (
      authority.origin.kind !== "session_turn" ||
      agentSessionId !== authority.origin.execution.sessionId
    )
      return;
    const key = JSON.stringify([agentSessionId, operationId]);
    if (!this.#previews.has(key)) return;
    this.#releasePreview(key);
    await this.#queue.enqueue(this.#publishPresence.bind(this));
  }

  #agentEditing(sessionId: string): boolean {
    for (const entry of this.#agents.values())
      if (entry.activity.agent.sessionId === sessionId) return true;
    return false;
  }

  #releasePreview(key: string): void {
    const preview = this.#previews.get(key);
    if (preview === undefined) return;
    clearTimeout(preview.timer);
    this.#previews.delete(key);
  }

  #releasePreviews(sessionId: string): void {
    for (const [key, preview] of [...this.#previews])
      if (preview.activity.agent.sessionId === sessionId)
        this.#releasePreview(key);
  }

  #previewExpired(key: string, activity: CollaborationAgentActivity): void {
    if (this.#previews.get(key)?.activity !== activity) return;
    this.#previews.delete(key);
    void this.#queue.enqueue(this.#publishPresence.bind(this));
  }

  async #open(
    authorized: AuthorizedOrganisationRequest,
    displayName: string,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    if (
      scope.organisationId !== this.#organisationId ||
      !(await isOrganisationExecutionActive(this.#storage.sql, scope))
    )
      return this.#rejectedSocket(this.#protocol.failureCodes.accessRevoked);
    const tag = await this.#tag;
    if (openSockets(this.#ctx, tag).length >= COLLABORATION_SOCKET_LIMIT) {
      return this.#rejectedSocket(this.#protocol.failureCodes.roomFull);
    }
    const initialized = await this.#backing.initialize(
      authorized.authenticated.session.userId,
      scope,
    );
    if (!initialized.ok) {
      return this.#rejectedSocket(initialized.error.code);
    }
    const featureAccess = await this.#participantAccess(
      {
        controlSessionId: authorized.authenticated.session.controlSessionId,
        membership: authorized.membership,
      },
      scope,
    );
    if (!featureAccess.ok)
      return this.#rejectedSocket(
        featureAccess.error.code === "access_unavailable"
          ? this.#protocol.failureCodes.storageUnavailable
          : this.#protocol.failureCodes.accessRevoked,
      );
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return this.#rejectedSocket(this.#protocol.failureCodes.accessRevoked);
    const attachment: CollaborationSocketAttachment<Selection> = {
      route: this.#route,
      sessionId: crypto.randomUUID(),
      controlSessionId: authorized.authenticated.session.controlSessionId,
      userId: authorized.authenticated.session.userId,
      displayName,
      openedAccess: featureAccess.value,
      state: "viewing",
      selection: null,
      activeAt: 0,
      pointer: null,
      lastMessageAt: Date.now(),
    };
    return (
      acceptSocket(this.#ctx, tag, attachment) ??
      this.#rejectedSocket(this.#protocol.failureCodes.invalidMessage)
    );
  }

  async #message(socket: WebSocket, frame: string): Promise<void> {
    this.#queued.set(socket, Math.max(0, (this.#queued.get(socket) ?? 1) - 1));
    const current = this.#attachment(socket);
    if (current === null) {
      return;
    }
    const parsed = this.#protocol.parseClientMessage(frame);
    if (!parsed.ok) {
      this.#malformed(socket, "frame_shape", parsed.error.code);
      return;
    }
    const now = Date.now();
    const message = parsed.value;
    const admission = await this.#captureScope();
    if (!admission.ok) {
      await this.#closeAll();
      return;
    }
    const scope = admission.value;
    switch (message.kind) {
      case "pointer_update":
        if (
          !this.#write(socket, {
            ...current,
            lastMessageAt: now,
            pointer:
              message.position === null
                ? null
                : { position: message.position, updatedAt: now },
          })
        )
          return;
        await this.#refreshPresence();
        return;
      case "presence_update": {
        const state =
          current.openedAccess === "read" ? "viewing" : message.state;
        const selection = state === "editing" ? message.selection : null;
        const changed =
          current.state !== message.state ||
          JSON.stringify(current.selection) !==
            JSON.stringify(message.selection);
        if (
          !this.#write(socket, {
            ...current,
            lastMessageAt: now,
            activeAt: changed ? now : current.activeAt,
            state,
            selection,
          })
        )
          return;
        await this.#refreshPresence();
        return;
      }
      case "sync_request": {
        if (!this.#write(socket, { ...current, lastMessageAt: now })) return;
        const access = await this.#contentAccess(socket, scope);
        if (access === null) return;
        await this.#sync(socket, scope, access, message.stateVector);
        return;
      }
      case "submit_update": {
        if (!this.#write(socket, { ...current, lastMessageAt: now })) return;
        const access = await this.#contentAccess(socket, scope);
        if (access === null) return;
        await this.#submit(
          socket,
          scope,
          access,
          message.updateId,
          message.update,
        );
        return;
      }
    }
  }

  async #contentAccess(
    socket: WebSocket,
    scope: OrganisationExecutionScope,
  ): Promise<"read" | "edit" | null> {
    const attachment = this.#attachment(socket);
    if (attachment === null) return null;
    const access = await this.#authorize(attachment, scope);
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope))) {
      await this.#closeAll();
      return null;
    }
    if (!access.ok) {
      this.#refuse(socket, access.error.code);
      return null;
    }
    return access.value;
  }

  async #sync(
    socket: WebSocket,
    scope: OrganisationExecutionScope,
    access: "read" | "edit",
    remoteStateVector: StateVector,
  ): Promise<void> {
    const stored = await this.#backing.readForSync(scope);
    if (!stored.ok) {
      this.#fail(socket, stored.error.code);
      return;
    }
    try {
      if (!(await isOrganisationExecutionActive(this.#storage.sql, scope))) {
        await this.#closeAll();
        return;
      }
      const attachment = this.#attachment(socket);
      if (attachment === null) return;
      const vector = stored.value.document.stateVector();
      const update = stored.value.document.syncUpdate(remoteStateVector);
      if (!vector.ok) {
        this.#fail(socket, vector.error.code);
        return;
      }
      if (!update.ok) {
        this.#fail(socket, update.error.code);
        return;
      }
      this.#send(socket, {
        kind: "sync_response",
        sessionId: attachment.sessionId,
        serverStateVector: vector.value,
        missingUpdate: update.value,
        metadata: stored.value.metadata,
        access,
      });
    } finally {
      stored.value.document.destroy();
    }
    await this.#refreshPresence();
  }

  async #submit(
    socket: WebSocket,
    scope: OrganisationExecutionScope,
    access: "read" | "edit",
    updateId: string,
    update: Update,
  ): Promise<void> {
    if (access !== "edit") {
      this.#fail(socket, this.#protocol.failureCodes.accessRevoked);
      return;
    }
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope))) {
      await this.#closeAll();
      return;
    }
    const attachment = this.#attachment(socket);
    if (attachment === null) return;
    const stored = this.#backing.readDocument();
    if (!stored.ok) {
      this.#fail(socket, stored.error.code);
      return;
    }
    let changed = false;
    try {
      const before = stored.value.state();
      if (!before.ok) {
        this.#fail(socket, before.error.code);
        return;
      }
      const applied = stored.value.apply(update);
      if (!applied.ok) {
        this.#fail(socket, applied.error.code);
        return;
      }
      const state = stored.value.state();
      if (!state.ok) {
        this.#fail(socket, state.error.code);
        return;
      }
      const encodedState = state.value.encode();
      changed = !sameBytes(before.value.encode(), encodedState);
      if (changed) {
        this.#storage.transactionSync(
          this.#backing.persist.bind(
            this.#backing,
            encodedState,
            attachment.userId,
          ),
        );
      }
    } finally {
      stored.value.destroy();
    }
    this.#send(socket, { kind: "update_accepted", updateId });
    if (changed) {
      await this.#broadcastUpdate(socket, update, scope);
    }
  }

  async #admitMutation(
    authority: CollaborationMutationAuthority,
  ): Promise<
    Result<
      null,
      Readonly<{ code: "access_revoked" | "organisation_placement_conflict" }>
    >
  > {
    const scope = authority.scope;
    if (
      scope.organisationId !== this.#organisationId ||
      !(await isOrganisationExecutionActive(this.#storage.sql, scope))
    ) {
      return placementConflict();
    }
    const members = await listOrganisationMembers({
      db: scope.database,
      organisationId: scope.organisationId,
    });
    let permitted = false;
    for (const member of members) {
      if (
        member.userId === authority.userId &&
        member.role !== "viewer" &&
        collaborationRequesterMatches(
          authority.origin,
          member.personId,
          member.userId,
        )
      ) {
        permitted = true;
      }
    }
    if (!permitted || Date.now() >= authority.deadlineAt) {
      return accessRevoked();
    }
    if (!(await authorizeCollaborationMutation(this.#env, authority)))
      return accessRevoked();
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return placementConflict();
    if (Date.now() >= authority.deadlineAt) return accessRevoked();
    return { ok: true, value: null };
  }

  async #mutate<Value, Error extends Readonly<{ code: string }>>(
    authority: CollaborationMutationAuthority,
    mutation: CollaborationMutation<Update, Value, Error>,
  ): Promise<
    Result<
      Value,
      | Error
      | Readonly<{ code: "access_revoked" | "organisation_placement_conflict" }>
    >
  > {
    const admitted = await this.#admitMutation(authority);
    if (!admitted.ok) return admitted;
    const scope = authority.scope;
    try {
      if (this.#agents.size > 0) {
        await this.#refreshPresence();
        if (!(await authorizeCollaborationMutation(this.#env, authority)))
          return accessRevoked();
        if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
          return placementConflict();
        if (Date.now() >= authority.deadlineAt) return accessRevoked();
      }
      const result = this.#storage.transactionSync(mutation);
      if (!result.ok) {
        return result;
      }
      if (result.value.update !== null) {
        await this.#broadcastUpdate(null, result.value.update, scope);
      }
      if (!(await authorizeCollaborationMutation(this.#env, authority)))
        return accessRevoked();
      if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
        return placementConflict();
      if (Date.now() >= authority.deadlineAt) return accessRevoked();
      return { ok: true, value: result.value.value };
    } finally {
      await this.#refreshPresence();
    }
  }

  async #broadcastUpdate(
    sender: WebSocket | null,
    update: Update,
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    for (const peer of await this.#peers()) {
      if (peer.socket === sender) {
        continue;
      }
      const allowed = await this.#authorize(peer.attachment, scope);
      if (!(await isOrganisationExecutionActive(this.#storage.sql, scope))) {
        await this.#closeAll();
        return;
      }
      if (!allowed.ok) {
        this.#refuse(peer.socket, allowed.error.code);
      } else {
        this.#send(peer.socket, { kind: "update_broadcast", update });
      }
    }
  }

  async #authorize(
    attachment: CollaborationSocketAttachment<Selection>,
    scope: OrganisationExecutionScope,
  ): Promise<CollaborationAccess> {
    if (scope.organisationId !== this.#organisationId) return accessRevoked();
    const checked = await socketSessionAccess({
      env: this.#env,
      scope,
      controlSessionId: attachment.controlSessionId,
      userId: attachment.userId,
      action: "disclose",
      requiredRole: "viewer",
    });
    if (checked.kind === "unavailable")
      return { ok: false, error: { code: "access_unavailable" } };
    if (checked.kind === "refused") return accessRevoked();
    const featureAccess = await this.#participantAccess(
      {
        controlSessionId: attachment.controlSessionId,
        membership: checked.membership,
      },
      scope,
    );
    if (!featureAccess.ok) return featureAccess;
    const access = featureAccess.value;
    if (attachment.openedAccess === "edit" && access === "read") {
      return accessRevoked();
    }
    return { ok: true, value: access };
  }

  /** The role's access, lowered or refused by the feature's own check. */
  async #participantAccess(
    participant: CollaborationParticipantCheck,
    scope: OrganisationExecutionScope,
  ): Promise<CollaborationAccess> {
    const roleAccess =
      participant.membership.role === "viewer" ? "read" : "edit";
    if (this.#backing.participantAccess === undefined)
      return { ok: true, value: roleAccess };
    const checked = await this.#backing.participantAccess(participant, scope);
    switch (checked) {
      case "refused":
        return accessRevoked();
      case "unavailable":
        return { ok: false, error: { code: "access_unavailable" } };
      case "read":
        return { ok: true, value: "read" };
      case "edit":
        return { ok: true, value: roleAccess };
      default:
        return assertNever(checked);
    }
  }

  async #afterClose(): Promise<void> {
    if ((await this.#peers()).length > 0) await this.#refreshPresence();
    this.#cleanup((await this.#peers()).length);
  }

  async #refreshPresence(): Promise<void> {
    const admission = await this.#captureScope();
    if (!admission.ok) {
      await this.#closeAll();
      return;
    }
    for (const [key, { authority }] of this.#agents) {
      if (
        Date.now() >= authority.deadlineAt ||
        !(await authorizeCollaborationMutation(this.#env, authority))
      ) {
        this.#agents.delete(key);
      }
    }
    for (const [key, { authority }] of [...this.#previews]) {
      if (
        Date.now() >= authority.deadlineAt ||
        !(await authorizeCollaborationMutation(this.#env, authority))
      )
        this.#releasePreview(key);
    }
    const now = Date.now();
    for (const peer of await this.#peers()) {
      if (
        now -
          socketLastSeenAt(
            this.#ctx,
            peer.socket,
            peer.attachment.lastMessageAt,
          ) >
        SOCKET_SILENCE_LIMIT_MS
      ) {
        this.#close(peer.socket);
      } else {
        const access = await this.#authorize(peer.attachment, admission.value);
        if (!access.ok) this.#refuse(peer.socket, access.error.code);
      }
    }
    if (
      !(await isOrganisationExecutionActive(this.#storage.sql, admission.value))
    ) {
      await this.#closeAll();
      return;
    }
    await this.#publishPresence();
  }

  #holdAgent(activity: CollaborationAgentActivity): void {
    this.#releaseHeldAgent(activity.agent.sessionId);
    this.#heldAgents.set(activity.agent.sessionId, {
      activity,
      timer: setTimeout(
        this.#heldAgentExpired.bind(this, activity),
        AGENT_ACTIVITY_HOLD_MS,
      ),
    });
  }

  #releaseHeldAgent(sessionId: string): void {
    const held = this.#heldAgents.get(sessionId);
    if (held === undefined) return;
    clearTimeout(held.timer);
    this.#heldAgents.delete(sessionId);
  }

  #heldAgentExpired(activity: CollaborationAgentActivity): void {
    if (this.#heldAgents.get(activity.agent.sessionId)?.activity !== activity)
      return;
    this.#heldAgents.delete(activity.agent.sessionId);
    void this.#queue.enqueue(this.#publishPresence.bind(this));
  }

  /**
   * The agents that edit now, then the draft previews and the held labels
   * of the other agents.
   */
  #visibleAgents(): CollaborationAgentActivity[] {
    const visible = [...this.#agents.values()].map(agentOperationActivity);
    const editing = new Set(visible.map(agentSessionId));
    for (const preview of this.#previews.values())
      if (
        !editing.has(preview.activity.agent.sessionId) &&
        visible.length < COLLABORATION_SOCKET_LIMIT
      )
        visible.push(preview.activity);
    for (const preview of this.#previews.values())
      editing.add(preview.activity.agent.sessionId);
    for (const [sessionId, held] of this.#heldAgents)
      if (
        !editing.has(sessionId) &&
        visible.length < COLLABORATION_SOCKET_LIMIT
      )
        visible.push(held.activity);
    return visible;
  }

  async #publishPresence(): Promise<void> {
    const peers = await this.#peers();
    const participants: CollaborationParticipant<Selection>[] = [];
    for (const peer of peers) {
      participants.push({
        sessionId: peer.attachment.sessionId,
        userId: peer.attachment.userId,
        displayName: peer.attachment.displayName,
        state: peer.attachment.state,
        selection: peer.attachment.selection,
        activeAt: peer.attachment.activeAt,
        pointer: peer.attachment.pointer,
      });
    }
    for (const peer of peers) {
      this.#send(peer.socket, {
        kind: "presence_changed",
        participants,
        agents: this.#visibleAgents(),
      });
    }
  }

  async #captureScope(): Promise<
    Result<
      OrganisationExecutionScope,
      Readonly<{ code: "organisation_placement_conflict" }>
    >
  > {
    const admission = await admitActorRecovery(this.#env, this.#storage);
    if (
      admission.kind !== "admitted" ||
      admission.scope.organisationId !== this.#organisationId ||
      !(await isOrganisationExecutionActive(this.#storage.sql, admission.scope))
    )
      return placementConflict();
    return { ok: true, value: admission.scope };
  }

  async #peers(): Promise<CollaborationPeer<Selection>[]> {
    const peers: CollaborationPeer<Selection>[] = [];
    for (const socket of openSockets(this.#ctx, await this.#tag)) {
      const attachment = this.#attachment(socket);
      if (attachment !== null) peers.push({ socket, attachment });
    }
    return peers;
  }

  #attachment(
    socket: WebSocket,
  ): CollaborationSocketAttachment<Selection> | null {
    if (socket.readyState !== WebSocket.OPEN) return null;
    const attachment = parseSocketAttachment<Selection>(
      socket.deserializeAttachment(),
    );
    if (
      attachment === null ||
      attachment.route.kind !== this.#route.kind ||
      attachment.route.key !== this.#route.key
    ) {
      this.#close(socket);
      return null;
    }
    return attachment;
  }

  #write(
    socket: WebSocket,
    attachment: CollaborationSocketAttachment<Selection>,
  ): boolean {
    try {
      socket.serializeAttachment(attachment);
      return true;
    } catch {
      this.#malformed(socket, "attachment_write");
      return false;
    }
  }

  #send(
    socket: WebSocket,
    message: CollaborationRoomServerMessage<
      Update,
      StateVector,
      Selection,
      Metadata,
      FailureCode
    >,
  ): void {
    try {
      socket.send(this.#protocol.encodeServerMessage(message));
    } catch {
      this.#close(socket);
    }
  }

  #fail(socket: WebSocket, code: FailureCode): void {
    this.#send(socket, { kind: "failure", code });
    this.#close(socket);
  }

  /**
   * Ends a socket for a message that the room does not take. The client
   * shows one text for all of them, so the trace names the cause.
   */
  #malformed(
    socket: WebSocket,
    reason: "frame_size" | "queue_limit" | "frame_shape" | "attachment_write",
    code: FailureCode = this.#protocol.failureCodes.invalidMessage,
  ): void {
    traceWarn("collaboration.socket_refused", {
      requestId: newRequestId(),
      room: this.#route.kind,
      reason,
      code,
    });
    this.#fail(socket, code);
  }

  #unexpected(socket: WebSocket): void {
    this.#fail(socket, this.#protocol.failureCodes.storageUnavailable);
  }

  #ignore(): void {}

  /**
   * A refused socket ends with a failure that its client shows as final. A
   * socket whose check could not run closes, so that its client reconnects
   * and is checked again before it syncs; its unsent edits stay with it.
   */
  #refuse(
    socket: WebSocket,
    code: "access_revoked" | "access_unavailable",
  ): void {
    if (code === "access_unavailable") this.#close(socket);
    else this.#fail(socket, this.#protocol.failureCodes.accessRevoked);
  }

  #close(socket: WebSocket): void {
    this.#queued.delete(socket);
    closeSocket(socket, 1000, this.#closeReason);
  }

  /**
   * The placement changed under the room. Each client reconnects, without a
   * failure that it would show as final, and reaches the Actor that serves
   * the Organisation now.
   */
  async #closeAll(): Promise<void> {
    for (const sessionId of [...this.#heldAgents.keys()])
      this.#releaseHeldAgent(sessionId);
    for (const key of [...this.#previews.keys()]) this.#releasePreview(key);
    for (const peer of await this.#peers()) {
      this.#queued.delete(peer.socket);
      closeSocket(peer.socket, SOCKET_MOVED.code, SOCKET_MOVED.reason);
    }
  }

  async #opened(response: Response): Promise<Response> {
    this.#pendingOpens--;
    this.#cleanup((await this.#peers()).length);
    return response;
  }

  async #openFailed(): Promise<Response> {
    this.#pendingOpens--;
    this.#cleanup((await this.#peers()).length);
    return this.#rejectedSocket(this.#protocol.failureCodes.storageUnavailable);
  }

  async #mutationFinished(): Promise<void> {
    this.#pendingMutations--;
    this.#cleanup((await this.#peers()).length);
  }

  // The room holds no state that the sockets and storage do not hold, so a
  // host may drop it when it is idle and build it again for the next event.
  // A held agent label is the one exception: with no socket open nobody sees
  // it, so it goes with the room. Its timer would otherwise publish the
  // dropped room's presence to the sockets of the next room. A dropped room
  // does not sweep, for the same reason, and tells its host only once, so a
  // late call cannot remove the next room from the host.
  #cleanup(openPeers: number): void {
    if (
      !this.#dropped &&
      openPeers === 0 &&
      this.#pendingOpens === 0 &&
      this.#pendingMutations === 0
    ) {
      for (const sessionId of [...this.#heldAgents.keys()])
        this.#releaseHeldAgent(sessionId);
      for (const key of [...this.#previews.keys()]) this.#releasePreview(key);
      this.#dropped = true;
      this.#onEmpty();
    }
  }

  // A browser cannot read the body of a refused upgrade, so a refusal is sent
  // on a socket that closes at once. The socket never waits, so it uses the
  // standard API.
  #rejectedSocket(code: FailureCode): Response {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].send(this.#protocol.encodeServerMessage({ kind: "failure", code }));
    pair[1].close(1000, this.#closeReason);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}

const ROOM_KINDS: ReadonlySet<string> = new Set<CollaborationRoomKind>([
  "costs_sheet",
  "email_draft",
  "mail_reply_draft",
  "menu_board",
  "menu_draft",
  "product_description",
  "production_plan",
  "workflow_canvas",
  "workflow_draft",
]);

/** The route of a socket's attachment, for the Actor's dispatch. */
export function collaborationSocketRoute(
  value: unknown,
): CollaborationSocketRoute | null {
  if (
    !isRecord(value) ||
    !isRecord(value.route) ||
    typeof value.route.kind !== "string" ||
    !ROOM_KINDS.has(value.route.kind) ||
    typeof value.route.key !== "string"
  )
    return null;
  return {
    kind: value.route.kind as CollaborationRoomKind,
    key: value.route.key,
  };
}

/** An open socket of a room, with the room's key and the socket's user. */
export type CollaborationRoomSocket = Readonly<{
  socket: WebSocket;
  key: string;
  userId: UserId;
}>;

/**
 * The open sockets of every room of `kind`. The host sends a frame on them
 * without the room, such as a signal that carries no content.
 */
export function openRoomSockets(
  ctx: DurableObjectState,
  kind: CollaborationRoomKind,
): CollaborationRoomSocket[] {
  const sockets: CollaborationRoomSocket[] = [];
  for (const socket of openSockets(ctx)) {
    const attachment = parseSocketAttachment(socket.deserializeAttachment());
    if (attachment?.route.kind === kind)
      sockets.push({
        socket,
        key: attachment.route.key,
        userId: attachment.userId,
      });
  }
  return sockets;
}

function parseSocketAttachment<Selection>(
  value: unknown,
): CollaborationSocketAttachment<Selection> | null {
  const route = collaborationSocketRoute(value);
  if (route === null || !isRecord(value)) return null;
  const controlSessionId =
    typeof value.controlSessionId === "string"
      ? parseControlSessionId(value.controlSessionId)
      : null;
  const userId =
    typeof value.userId === "string" ? parseUserId(value.userId) : null;
  if (
    controlSessionId === null ||
    !controlSessionId.ok ||
    userId === null ||
    !userId.ok ||
    typeof value.sessionId !== "string" ||
    typeof value.displayName !== "string" ||
    (value.openedAccess !== "read" && value.openedAccess !== "edit") ||
    !isCollaborationPresenceState(value.state) ||
    !isNonNegativeInteger(value.activeAt) ||
    !isCollaborationPointer(value.pointer) ||
    !isNonNegativeInteger(value.lastMessageAt)
  )
    return null;
  return {
    route,
    sessionId: value.sessionId,
    controlSessionId: controlSessionId.value,
    userId: userId.value,
    displayName: value.displayName,
    openedAccess: value.openedAccess,
    state: value.state,
    // The room wrote this selection after the protocol parsed it.
    selection: (value.selection ?? null) as Selection | null,
    activeAt: value.activeAt,
    pointer: value.pointer,
    lastMessageAt: value.lastMessageAt,
  };
}

export function accessRevoked(): Result<
  never,
  Readonly<{ code: "access_revoked" }>
> {
  return { ok: false, error: { code: "access_revoked" } };
}

function placementConflict(): Result<
  never,
  Readonly<{ code: "organisation_placement_conflict" }>
> {
  return { ok: false, error: { code: "organisation_placement_conflict" } };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function collaborationRequesterMatches(
  origin: CollaborationMutationOrigin,
  personId: string,
  userId: UserId,
): boolean {
  if (origin.kind === "control_session") return true;
  const authority = origin.execution.requestAuthority;
  switch (authority.kind) {
    case "control":
      return (
        authority.userId === userId && authority.requesterPersonId === personId
      );
    case "direct_conversation":
    case "shared_conversation":
      return authority.requesterPersonId === personId;
    case "workflow":
    case "agent_mailbox":
    case "whatsapp_support":
      return false;
    default:
      return assertNever(authority);
  }
}

async function authorizeCollaborationMutation(
  env: Env,
  authority: CollaborationMutationAuthority,
): Promise<boolean> {
  switch (authority.origin.kind) {
    case "session_turn":
      return authorizeSessionTurnExecution(
        env.DB,
        authority.scope.database,
        authority.scope.organisationId,
        authority.origin.execution,
        authority.scope.accountAccess,
      );
    case "control_session":
      return (
        (await socketSessionMembership({
          env,
          scope: authority.scope,
          controlSessionId: authority.origin.controlSessionId,
          userId: authority.userId,
          action: "execute",
          requiredRole: "operator",
        })) !== null
      );
    default:
      return assertNever(authority.origin);
  }
}

function agentOperationActivity(
  entry: ActiveAgentOperation,
): CollaborationAgentActivity {
  return entry.activity;
}

/** A held activity shows its action as done (Plan 40B phase 7). */
function appliedActivity(
  activity: CollaborationAgentActivity,
): CollaborationAgentActivity {
  return activity.action === undefined
    ? activity
    : { ...activity, action: { ...activity.action, state: "applied" } };
}

function agentSessionId(activity: CollaborationAgentActivity): string {
  return activity.agent.sessionId;
}
