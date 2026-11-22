import type { CollaborationAgent } from "@purin-labs/collaboration";
import type { CollaborationMutationOrigin } from "@purin-labs/collaboration/worker/collaboration-room";
import {
  parseWorkflowCanvasSource,
  workflowCanvasDocumentId,
  type WorkflowCanvasSource,
} from "@purin-labs/bakery-model/bakery-canvas-source";
import {
  type CanvasEncoding,
  WorkflowCanvasDoc,
} from "@purin-labs/workflow-canvas-crdt";
import {
  CanvasMoveRequest,
  CanvasAgentRequest,
  type CanvasMoveOrigin,
} from "@purin-labs/workflow-canvas-crdt/move";
import {
  encodeCanvasServerMessage,
  type CanvasProtocolFailureCode,
  type CanvasRoomMetadata,
  type CanvasSelection,
} from "@purin-labs/workflow-canvas-crdt/protocol";
import type { AuthorizedOrganisationRequest } from "@purin-labs/control/worker/authorization";
import { controlError } from "@purin-labs/control/worker/http";
import {
  listOrganisationMembers,
  resolveUser,
} from "@purin-labs/tenancy/data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { admitActorRecovery } from "@purin-labs/actor-runtime/actors/actor-activation";
import {
  CollaborationRoom,
  accessRevoked,
  openRoomSockets,
  type CollaborationRoomSocket,
  type CollaborationSocketRoom,
} from "@purin-labs/collaboration/worker/collaboration-room";
import { readWorkflowCanvasSource } from "./workflow-canvas-source";
import {
  createWorkflowCanvasSchema,
  createWorkflowCanvasProtocol,
  WorkflowCanvasBacking,
} from "./workflow-canvas";

type CanvasRoom = CollaborationRoom<
  CanvasEncoding<"update">,
  CanvasEncoding<"state_vector">,
  CanvasSelection,
  CanvasRoomMetadata,
  CanvasProtocolFailureCode,
  WorkflowCanvasDoc
>;
type OwnedRoom = Readonly<{ room: CanvasRoom; backing: WorkflowCanvasBacking }>;

export class WorkflowCanvasRooms {
  readonly #rooms = new Map<string, OwnedRoom>();
  // A room needs its source read before it exists. Events that arrive while
  // that read runs wait for the same room, in the order they arrived.
  readonly #opening = new Map<string, Promise<OwnedRoom | null>>();
  readonly #ctx: DurableObjectState;
  readonly #storage: DurableObjectStorage;
  readonly #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#storage = ctx.storage;
    this.#env = env;
    ctx.storage.transactionSync(
      createWorkflowCanvasSchema.bind(null, ctx.storage.sql),
    );
  }

  /** The room of a socket that the Actor accepted, after a wake. */
  async socketRoom(
    organisationId: OrganisationId,
    documentId: string,
  ): Promise<CollaborationSocketRoom | null> {
    const existing = this.#rooms.get(documentId);
    if (existing !== undefined) return existing.room;
    let opening = this.#opening.get(documentId);
    if (opening === undefined) {
      opening = this.#reopen(organisationId, documentId);
      this.#opening.set(documentId, opening);
      const settled = this.#opening.delete.bind(this.#opening, documentId);
      void opening.then(settled, settled);
    }
    return (await opening)?.room ?? null;
  }

  async #reopen(
    organisationId: OrganisationId,
    documentId: string,
  ): Promise<OwnedRoom | null> {
    let reference: WorkflowCanvasSource;
    try {
      reference = parseWorkflowCanvasSource(documentId);
    } catch {
      return null;
    }
    const admission = await admitActorRecovery(this.#env, this.#storage);
    if (
      admission.kind !== "admitted" ||
      admission.scope.organisationId !== organisationId
    )
      return null;
    const owned = await this.#resolve(admission.scope, reference);
    return owned.ok ? owned.value : null;
  }

  async open(
    authorized: AuthorizedOrganisationRequest,
    scope: OrganisationExecutionScope,
    reference: WorkflowCanvasSource,
  ): Promise<Response> {
    const user = await resolveUser({
      db: this.#env.DB,
      userId: authorized.authenticated.session.userId,
    });
    if (user === null || user.displayName.length > 256)
      return controlError("access_revoked", 403);
    const owned = await this.#resolve(scope, reference);
    if (!owned.ok) return controlError(owned.error.code, 503);
    return owned.value.room.open(authorized, user.displayName, scope);
  }

  async read(
    scope: OrganisationExecutionScope,
    reference: WorkflowCanvasSource,
    userId: UserId,
    origin: CanvasMoveOrigin,
  ) {
    if (!(await canRead(scope, userId))) return accessRevoked();
    const source = await readWorkflowCanvasSource(
      this.#storage.sql,
      this.#env,
      scope,
      reference,
    );
    if (!source.ok) return source;
    const backing = new WorkflowCanvasBacking(
      this.#storage,
      workflowCanvasDocumentId(reference),
      source.value.layout,
      source.value.labels,
    );
    const initialized = await backing.initialize(userId, scope);
    if (!initialized.ok) return initialized;
    if (!(await canRead(scope, userId))) return accessRevoked();
    return this.#storage.transactionSync(
      backing.readLayout.bind(backing, origin, userId),
    );
  }

  async move(
    scope: OrganisationExecutionScope,
    reference: WorkflowCanvasSource,
    request: CanvasMoveRequest,
    userId: UserId,
    deadlineAt: number,
    authorityOrigin: CollaborationMutationOrigin,
    agent: CollaborationAgent | null,
  ) {
    if (request.documentId !== workflowCanvasDocumentId(reference))
      return {
        ok: false as const,
        error: { code: "object_conflict" as const },
      };
    const origin = canvasMutationOrigin(authorityOrigin);
    if (origin === null)
      return { ok: false as const, error: { code: "invalid_move" as const } };
    const owned = await this.#resolve(scope, reference);
    if (!owned.ok) return owned;
    return owned.value.room.mutate(
      { scope, userId, deadlineAt, origin: authorityOrigin },
      owned.value.backing.move.bind(
        owned.value.backing,
        request,
        userId,
        origin,
      ),
      agent === null
        ? null
        : {
            agent,
            operationId: request.operationId,
            target: request.destination.objectId,
          },
    );
  }

  async undo(
    scope: OrganisationExecutionScope,
    reference: WorkflowCanvasSource,
    expectedRevision: number,
    operationId: string,
    userId: UserId,
    controlSessionId: import("@purin-labs/kernel/ids").ControlSessionId,
  ) {
    const owned = await this.#resolve(scope, reference);
    if (!owned.ok) return owned;
    return owned.value.room.mutate(
      {
        scope,
        userId,
        deadlineAt: Date.now() + 30_000,
        origin: { kind: "control_session", controlSessionId },
      },
      owned.value.backing.undoAgentMove.bind(
        owned.value.backing,
        expectedRevision,
        operationId,
        userId,
      ),
      null,
    );
  }

  async #resolve(
    scope: OrganisationExecutionScope,
    reference: WorkflowCanvasSource,
  ): Promise<Result<OwnedRoom, Readonly<{ code: "source_unavailable" }>>> {
    const source = await readWorkflowCanvasSource(
      this.#storage.sql,
      this.#env,
      scope,
      reference,
    );
    if (!source.ok) return source;
    const existing = this.#rooms.get(workflowCanvasDocumentId(reference));
    if (existing !== undefined) return { ok: true, value: existing };
    const backing = new WorkflowCanvasBacking(
      this.#storage,
      workflowCanvasDocumentId(reference),
      source.value.layout,
      source.value.labels,
    );
    const room = new CollaborationRoom({
      ctx: this.#ctx,
      env: this.#env,
      organisationId: scope.organisationId,
      protocol: createWorkflowCanvasProtocol(backing),
      backing,
      route: {
        kind: "workflow_canvas",
        key: workflowCanvasDocumentId(reference),
      },
      closeReason: "Workflow canvas disconnected",
      onEmpty: this.#remove.bind(this, workflowCanvasDocumentId(reference)),
    });
    const owned = { room, backing };
    this.#rooms.set(workflowCanvasDocumentId(reference), owned);
    return { ok: true, value: owned };
  }

  #remove(documentId: string): void {
    this.#rooms.delete(documentId);
  }
}

/** An open canvas page: a socket of a canvas room, with its canvas and user. */
export type CanvasPage = Readonly<{
  socket: WebSocket;
  documentId: string;
  userId: UserId;
}>;

export function openCanvasPages(ctx: DurableObjectState): CanvasPage[] {
  return openRoomSockets(ctx, "workflow_canvas").map(canvasPage);
}

function canvasPage(room: CollaborationRoomSocket): CanvasPage {
  return { socket: room.socket, documentId: room.key, userId: room.userId };
}

const CHAT_CHANGED: string = encodeCanvasServerMessage({
  kind: "chat_changed",
});

/**
 * Tells canvas pages that their canvas's chat changed. The frame carries no
 * content, so a page reads the chat through its checked route. The frame
 * needs no room, so the Actor does not read the canvas source for it.
 */
export function signalCanvasChat(pages: readonly CanvasPage[]): void {
  for (const page of pages) {
    try {
      page.socket.send(CHAT_CHANGED);
    } catch {
      // The socket closed; its close event ends it.
    }
  }
}

async function canRead(
  scope: OrganisationExecutionScope,
  userId: UserId,
): Promise<boolean> {
  const members = await listOrganisationMembers({
    db: scope.database,
    organisationId: scope.organisationId,
  });
  for (const member of members) if (member.userId === userId) return true;
  return false;
}

function canvasMutationOrigin(
  origin: CollaborationMutationOrigin,
): CanvasMoveOrigin | null {
  if (origin.kind === "control_session") return { kind: "human" };
  const request = CanvasAgentRequest.parse({
    sessionId: origin.execution.sessionId,
    turnId: origin.execution.turnId,
  });
  return request === null ? null : { kind: "agent", request };
}
