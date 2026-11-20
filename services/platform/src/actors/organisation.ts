import type { ScreenRelevanceCheckInput } from "../jev-features/screen-relevance-check";
import {
  deliverJevUsageHours,
  sealJevUsageHours,
} from "../jev-features/usage-records";
import {
  actorMachineCensus,
  type MachineCensus,
} from "./lifecycle/machine-census";
import {
  armAlarmAfterFailedSteps,
  runAlarmSteps,
} from "./lifecycle/actor-alarm";
import type { CollaborationAgent } from "@purin-labs/collaboration";
import { screenMediaBase } from "../commerce/cafe-media";
import {
  CHAT_SIGNAL_SOCKET_HANDLER,
  isChatSignalSocket,
  openChatSignalSocket,
  sendChatSignal,
  sweepChatSignalSockets,
} from "./chat-signal-sockets";
import type { ChatSignalTarget } from "../chat/signals";
import {
  authorizeChatSignalRequest,
  matchChatSignalRoute,
} from "../control/admission/chat-signals";
import {
  ensureWorkspaceCanvasChat,
  readWorkspaceCanvasChat,
  continueWorkspaceCanvasChat,
} from "../chat/workspace-canvas";
import {
  CHAT_SIGNAL,
  SURFACE_EFFECT_SIGNAL,
  isConversationId,
  type ChatSignal,
} from "@purin-labs/control-api";
import { workflowCanvasDocumentId } from "@purin-labs/bakery-model/bakery-canvas-source";
import type { WorkflowCanvasSource } from "@purin-labs/bakery-model/bakery-canvas-source";
import { savedBakeryRunArchiveKeys } from "../commerce/bakery/saved-runs";
import {
  reconcileFrozenOrganisationReceipt,
  type RelocationReceiptRequest,
} from "./actor-relocation-state";
import { workspaceRevisionArchiveKeys } from "../workspace-revision-store";
import { readPortalChatAttachmentKeys } from "../chat/attachments";
import { readChatForkAttachmentKeys } from "../chat/fork-history";
import {
  captureOrganisationDataArchive,
  deleteOrganisationDataArchivePages,
  restoreOrganisationDataArchive,
} from "../data/organisation-regional-copy";
import type { SessionTurnExecution } from "../chat/turn-access";
import { type MailEvaluationInput } from "../mail-inbox/evaluation";
import {
  canAdmitOrganisationArchiveCleanup,
  closeOrganisationArchiveCleanupAdmission,
  type OrganisationArchiveCleanupError,
  type OrganisationArchiveCleanupRequest,
} from "./organisation-archive-cleanup";
import type { ActorFenceToken } from "./actor-registry";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { isOrganisationExecutionActive } from "./actor-execution-quiescence";
import {
  CostsSheetRooms,
  type CostsSheetAgentEdit,
  type CostsSheetSettleInput,
} from "./costs-sheet-draft";
import {
  dispatchOrganisationCollaborationFetch,
  resolveOrganisationCollaborationSocket,
  type OrganisationCollaborationRooms,
} from "./organisation-collaboration-rooms";
import {
  ProductDescriptionDraftRooms,
  type DraftAgentEdit,
  type DraftAgentReadRequest,
} from "./product-description-draft";
import { EmailDraftRooms, type EmailDraftAgentEdit } from "./email-draft";
import {
  MailReplyDraftRooms,
  type MailReplyDraftAgentEdit,
} from "./mail-reply-draft";
import { MenuDraftRooms, type MenuDraftAgentEdit } from "./menu-draft";
import {
  MenuBoardRooms,
  type MenuBoardAgentEdit,
  type MenuBoardAgentPreview,
} from "./menu-boards";
import {
  MENU_SCREEN_SOCKET_HANDLER,
  MenuScreens,
  isMenuScreenSocket,
  isMenuScreenSocketPath,
  menuScreenSocketToken,
  parseMenuScreenToken,
} from "./menu-screens";
import {
  runMenuBoardCommand,
  type MenuBoardCommand,
  type MenuBoardCommandReply,
} from "./menu-board-commands";
import {
  ProductionPlanRooms,
  type ProductionPlanAgentEdit,
} from "./production-plan";
import { WorkflowCanvasRooms } from "./workflow-canvas-rooms";
import type {
  DraftChangeSet,
  DraftSnapshot,
} from "@purin-labs/workflow-canvas-crdt/draft-shape";
import { WorkflowDraftRooms } from "./workflow-draft";
import {
  collaborationSocketRoute,
  type CollaborationSocketRoom,
} from "./collaboration-room";
import {
  acceptedSocket,
  closeAcceptedSocket,
  closeAllSockets,
  closeSocket,
  createSocketSweepSchema,
  finishSocketSweep,
  installSocketAutoResponse,
  openSockets,
  readSocketSweepDueAt,
  scheduleSocketSweep,
} from "./hibernatable-sockets";
import type { ControlSessionId, UserId } from "../ids";
import {
  CanvasAgentRequest,
  CanvasMoveRequest,
} from "@purin-labs/workflow-canvas-crdt/move";
import {
  authorizeWorkflowCanvasRequest,
  matchWorkflowCanvasRoute,
} from "../control/admission/workflow-canvas";
import {
  authorizeMenuBoardSocketRequest,
  matchMenuBoardSocketRoute,
} from "../control/admission/menu-boards";
import { controlError, readBoundedJsonRecord } from "../control/http";
import type { Env } from "../env";
import { parseOrganisationId, newRequestId, type OrganisationId } from "../ids";
import { traceLog } from "../observability";
import type { Result } from "../result";
import { admitActorRecovery, pinnedActorDatabase } from "./actor-activation";
import {
  exportActorPlacement,
  importActorExport,
  loadActorExport,
  readActivationExportSource,
  type ActorExportError,
  type ActorExportRef,
  type ActorExportRequest,
  type ActorImportRequest,
  type ActorImportedState,
} from "./actor-export";
import { createCodeModeBudgetSchema } from "./code-mode-budget";
import {
  type AssignShopifyLocationClassificationInput,
  type ShopifyLocationObservationInput,
} from "./shopify-location-observation";
import type { CaseExecutionEffectRecords } from "../case-execution/records";
import { readCaseEffectRecords } from "./organisation-execution-records";
import { type AcceptedMemoryCursor } from "../memory/store";
import { cleanupTypeSafeCredentials } from "../integrations/typesafe/connection";
import { assertNever, errorMessage } from "@purin-labs/std";
import type { CommerceBoardPresenceEntry } from "@purin-labs/control-api";
import { expireOrganisationLeases } from "./organisation/activation";
import { deliverCaseContextCollectionInvalidations } from "./organisation/case-context-collection";
import { createOrganisationSchema } from "./organisation/schema";
import {
  organisationPlacementConflict,
  organisationRowToMeta,
  pruneCommerceBoardPresence,
  readCommerceBoardPresence,
  readOrganisationMetaRow,
  resolveOrganisationActorDatabase,
  socketSweepInterval,
  sweepSafely,
  validateActionOrganisation,
} from "./organisation/support";
import type {
  CommerceBoardPresenceRead,
  CommerceBoardPresenceUpdate,
} from "./organisation/commerce-types";
import type {
  OrganisationMeta,
  OrganisationMetaRequest,
  OrganisationPing,
  OrganisationStateError,
} from "./organisation/types";
import { OrganisationCommerce } from "./organisation/organisation-commerce";

export class OrganisationDO extends OrganisationCommerce {
  /** State counts of this Actor's machines, for the census (Refactor 15, S5). */
  machineCensus(): Promise<readonly MachineCensus[]> {
    return actorMachineCensus(this.ctx.storage);
  }

  readonly #commerceBoardPresence = new Map<
    string,
    CommerceBoardPresenceEntry
  >();
  readonly #costsSheets: CostsSheetRooms;
  readonly #descriptionDrafts: ProductDescriptionDraftRooms;
  readonly #emailDrafts: EmailDraftRooms;
  readonly #mailReplyDrafts: MailReplyDraftRooms;
  readonly #menuDrafts: MenuDraftRooms;
  readonly #menuBoards: MenuBoardRooms;
  readonly #menuScreens: MenuScreens;
  readonly #productionPlans: ProductionPlanRooms;
  readonly #workflowCanvases: WorkflowCanvasRooms;
  readonly #workflowDrafts: WorkflowDraftRooms;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { executionBarrier: false });
    createOrganisationSchema(this.ctx.storage);
    createCodeModeBudgetSchema(this.ctx.storage);
    createSocketSweepSchema(this.ctx.storage.sql);
    installSocketAutoResponse(this.ctx);
    this.#costsSheets = new CostsSheetRooms(this.ctx, this.env);
    this.#descriptionDrafts = new ProductDescriptionDraftRooms(
      this.ctx,
      this.env,
    );
    this.#emailDrafts = new EmailDraftRooms(this.ctx, this.env);
    this.#mailReplyDrafts = new MailReplyDraftRooms(this.ctx, this.env);
    this.#menuDrafts = new MenuDraftRooms(this.ctx, this.env);
    this.#menuBoards = new MenuBoardRooms(this.ctx, this.env);
    this.#menuScreens = new MenuScreens(this.ctx);
    this.#productionPlans = new ProductionPlanRooms(this.ctx, this.env);
    this.#workflowCanvases = new WorkflowCanvasRooms(this.ctx, this.env);
    this.#workflowDrafts = new WorkflowDraftRooms(this.ctx, this.env);
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const handler = await this.#socketHandler(socket);
    if (handler === null) {
      closeSocket(socket, 1011, "Unknown collaboration socket");
      return;
    }
    handler.receive(socket, message);
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    (await this.#socketHandler(socket))?.closed(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    (await this.#socketHandler(socket))?.closed(socket);
  }

  /**
   * Sends a chat signal after a committed write. A lost signal costs a later
   * read, so the signal never fails its writer. The recipient query reads the
   * regional database that this Actor's activation pins; a signal changes
   * nothing, so it needs no admission.
   */
  async signalChat(
    input: Readonly<{
      organisationId: OrganisationId;
      target: ChatSignalTarget;
      /** Absent from a caller of an earlier build: the chat changed. */
      kind?: ChatSignal["kind"];
    }>,
  ): Promise<void> {
    const row = readOrganisationMetaRow(this.ctx.storage.sql);
    if (row === undefined || row.organisation_id !== input.organisationId)
      return;
    await sendChatSignal(
      this.ctx,
      input.organisationId,
      input.target,
      () =>
        pinnedActorDatabase(
          this.env,
          this.ctx.storage.sql,
          input.organisationId,
        ),
      input.kind === SURFACE_EFFECT_SIGNAL
        ? SURFACE_EFFECT_SIGNAL
        : CHAT_SIGNAL,
    );
  }

  /** What handles an accepted socket's events: its chat page or its room. */
  async #socketHandler(
    socket: WebSocket,
  ): Promise<Pick<CollaborationSocketRoom, "receive" | "closed"> | null> {
    if (isChatSignalSocket(socket)) return CHAT_SIGNAL_SOCKET_HANDLER;
    if (isMenuScreenSocket(socket)) return MENU_SCREEN_SOCKET_HANDLER;
    return this.#socketRoom(socket);
  }

  #collaborationRooms(): OrganisationCollaborationRooms {
    return {
      costsSheets: this.#costsSheets,
      descriptionDrafts: this.#descriptionDrafts,
      emailDrafts: this.#emailDrafts,
      mailReplyDrafts: this.#mailReplyDrafts,
      menuBoards: this.#menuBoards,
      menuDrafts: this.#menuDrafts,
      productionPlans: this.#productionPlans,
      workflowCanvases: this.#workflowCanvases,
      workflowDrafts: this.#workflowDrafts,
    };
  }

  /** The room of an accepted socket, built again after a wake. */
  async #socketRoom(
    socket: WebSocket,
  ): Promise<CollaborationSocketRoom | null> {
    const route = collaborationSocketRoute(socket.deserializeAttachment());
    if (route === null) return null;
    const row = readOrganisationMetaRow(this.ctx.storage.sql);
    if (row === undefined) return null;
    const organisationId = parseOrganisationId(row.organisation_id);
    if (!organisationId.ok) return null;
    return resolveOrganisationCollaborationSocket(
      this.#collaborationRooms(),
      organisationId.value,
      route,
    );
  }

  /**
   * Runs the chat sweep and each room's sweep once, then sets the next sweep
   * while a socket stays open. A sweep that fails leaves the others, and the
   * next sweep, to run. A room that cannot be built now closes its sockets,
   * so that their clients open them again instead of staying unswept.
   */
  async #sweepSockets(scope: OrganisationExecutionScope): Promise<void> {
    await sweepSafely("chat", () =>
      sweepChatSignalSockets(this.ctx, this.env, scope),
    );
    await sweepSafely("menu_screens", async () =>
      this.#menuScreens.sweep(Date.now()),
    );
    const rooms = new Map<
      string,
      { room: Promise<CollaborationSocketRoom | null>; sockets: WebSocket[] }
    >();
    for (const socket of openSockets(this.ctx)) {
      if (isChatSignalSocket(socket) || isMenuScreenSocket(socket)) continue;
      const route = collaborationSocketRoute(socket.deserializeAttachment());
      if (route === null) {
        closeSocket(socket, 1011, "Unknown collaboration socket");
        continue;
      }
      const key = JSON.stringify([route.kind, route.key]);
      const entry = rooms.get(key) ?? {
        room: this.#socketRoom(socket),
        sockets: [],
      };
      entry.sockets.push(socket);
      rooms.set(key, entry);
    }
    for (const [key, entry] of rooms)
      await sweepSafely(key, async () => {
        const room = await entry.room;
        if (room !== null) return room.sweep();
        for (const socket of entry.sockets)
          closeSocket(socket, 1013, "room_unavailable");
      });
    this.ctx.storage.transactionSync(
      finishSocketSweep.bind(
        null,
        this.ctx.storage.sql,
        Date.now(),
        socketSweepInterval(this.ctx),
      ),
    );
  }

  async fetch(request: Request): Promise<Response> {
    return this.trackExecution(this.executeDraftRequest.bind(this, request));
  }

  private async executeDraftRequest(request: Request): Promise<Response> {
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      !(await isOrganisationExecutionActive(
        this.ctx.storage.sql,
        admission.scope,
      ))
    )
      return controlError("organisation_placement_conflict", 409);
    const response = await this.admittedDraftRequest(request, admission.scope);
    if (
      !(await isOrganisationExecutionActive(
        this.ctx.storage.sql,
        admission.scope,
      ))
    ) {
      closeAcceptedSocket(response, "Organisation placement changed");
      return controlError("organisation_placement_conflict", 409);
    }
    if (acceptedSocket(response)) {
      try {
        const interval = socketSweepInterval(this.ctx);
        if (interval !== null)
          this.ctx.storage.transactionSync(
            scheduleSocketSweep.bind(
              null,
              this.ctx.storage.sql,
              Date.now(),
              interval,
            ),
          );
        await this.rearm();
      } catch (error) {
        // A socket without its sweep would never be checked again.
        closeAcceptedSocket(response, "Socket sweep unavailable");
        throw error;
      }
    }
    return response;
  }

  private async admittedDraftRequest(
    request: Request,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (isMenuScreenSocketPath(pathname)) {
      const raw = menuScreenSocketToken(request);
      const token = raw === null ? null : parseMenuScreenToken(raw);
      const screen =
        token === null || token.organisationId !== scope.organisationId
          ? null
          : await this.#menuScreens.verify(token.screenId, token.secret);
      return screen === null
        ? controlError("menu_screen_refused", 401)
        : this.#menuScreens.openSocket(screen, Date.now());
    }
    const boardRoute = matchMenuBoardSocketRoute(pathname);
    if (boardRoute !== null) {
      const authorized = await authorizeMenuBoardSocketRequest(
        request,
        this.env,
        boardRoute,
      );
      if (!authorized.ok) return authorized.response;
      if (
        authorized.organisationId !== scope.organisationId ||
        !(await isOrganisationExecutionActive(this.ctx.storage.sql, scope))
      )
        return controlError("organisation_placement_conflict", 409);
      const organisation = validateActionOrganisation(
        this.ctx.storage.sql,
        authorized.organisationId,
      );
      if (!organisation.ok) return controlError(organisation.error.code, 404);
      return this.#menuBoards.open(authorized, boardRoute.boardId, scope);
    }
    const chatSignalRoute = matchChatSignalRoute(pathname);
    if (chatSignalRoute !== null) {
      const authorized = await authorizeChatSignalRequest(
        request,
        this.env,
        chatSignalRoute,
      );
      if (!authorized.ok) return authorized.response;
      if (
        authorized.organisationId !== scope.organisationId ||
        !(await isOrganisationExecutionActive(this.ctx.storage.sql, scope))
      )
        return controlError("organisation_placement_conflict", 409);
      return openChatSignalSocket(this.ctx, authorized);
    }
    const canvasRoute = matchWorkflowCanvasRoute(pathname);
    if (canvasRoute !== null) {
      const authorized = await authorizeWorkflowCanvasRequest(
        request,
        this.env,
        canvasRoute,
      );
      if (!authorized.ok) return authorized.response;
      if (
        authorized.organisationId !== scope.organisationId ||
        !(await isOrganisationExecutionActive(this.ctx.storage.sql, scope))
      )
        return controlError("organisation_placement_conflict", 409);
      const organisation = validateActionOrganisation(
        this.ctx.storage.sql,
        authorized.organisationId,
      );
      if (!organisation.ok) return controlError(organisation.error.code, 404);
      const userId = authorized.authenticated.session.userId;
      switch (canvasRoute.transport) {
        case "undo": {
          const body = await readBoundedJsonRecord(request, 1024);
          if (
            body === null ||
            typeof body.expectedRevision !== "number" ||
            !Number.isSafeInteger(body.expectedRevision) ||
            body.expectedRevision < 1 ||
            typeof body.operationId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,128}$/u.test(body.operationId)
          )
            return controlError("invalid_move", 422);
          return Response.json(
            await this.#workflowCanvases.undo(
              scope,
              canvasRoute.reference,
              body.expectedRevision,
              body.operationId,
              userId,
              authorized.authenticated.session.controlSessionId,
            ),
          );
        }
        case "chat/continue": {
          const body = await readBoundedJsonRecord(request, 1024);
          if (body === null || !isConversationId(body.conversationId))
            return controlError("invalid_conversation", 422);
          const conversationId = await continueWorkspaceCanvasChat(
            this.env,
            scope,
            userId,
            workflowCanvasDocumentId(canvasRoute.reference),
            body.conversationId,
          );
          return Response.json({ conversationId });
        }
        case "chat": {
          if (request.method === "GET") {
            const query = new URL(request.url).searchParams;
            const conversationId = query.get("conversation");
            const cursor = query.get("after");
            if (
              (conversationId !== null && !isConversationId(conversationId)) ||
              (cursor !== null && !/^[a-f0-9]{64}$/u.test(cursor))
            )
              return controlError("invalid_conversation", 422);
            return Response.json(
              await readWorkspaceCanvasChat(
                this.env,
                scope,
                userId,
                workflowCanvasDocumentId(canvasRoute.reference),
                conversationId === null
                  ? { kind: "current" }
                  : { kind: "history", conversationId },
                cursor,
              ),
            );
          }
          const source = await this.#workflowCanvases.read(
            scope,
            canvasRoute.reference,
            userId,
            { kind: "human" },
          );
          if (!source.ok) return controlError(source.error.code, 503);
          const conversationId = await ensureWorkspaceCanvasChat(
            this.env,
            scope,
            userId,
            source.value.documentId,
          );
          return Response.json({ conversationId });
        }
        case "socket":
          return this.#workflowCanvases.open(
            authorized,
            scope,
            canvasRoute.reference,
          );
        case "snapshot": {
          const read = await this.#workflowCanvases.read(
            scope,
            canvasRoute.reference,
            userId,
            { kind: "human" },
          );
          const current = await authorizeWorkflowCanvasRequest(
            request,
            this.env,
            canvasRoute,
          );
          if (!current.ok) return current.response;
          return read.ok
            ? Response.json(read)
            : controlError(read.error.code, 503);
        }
        case "move": {
          const body = await readBoundedJsonRecord(request, 2048);
          if (body === null) return controlError("invalid_move", 422);
          const move = CanvasMoveRequest.parse(body);
          if (move === null) return controlError("invalid_move", 422);
          const result = await this.#workflowCanvases.move(
            scope,
            canvasRoute.reference,
            move,
            userId,
            Date.now() + 30_000,
            {
              kind: "control_session",
              controlSessionId:
                authorized.authenticated.session.controlSessionId,
            },
            null,
          );
          return Response.json(result);
        }
        default:
          return assertNever(canvasRoute.transport);
      }
    }
    return dispatchOrganisationCollaborationFetch({
      request,
      pathname,
      env: this.env,
      sql: this.ctx.storage.sql,
      scope,
      rooms: this.#collaborationRooms(),
      validateOrganisation: validateActionOrganisation.bind(
        null,
        this.ctx.storage.sql,
      ),
    });
  }

  async readCostsSheetDraft(
    input: Readonly<{ organisationId: OrganisationId }>,
  ) {
    return this.#roomCommand(input.organisationId, async () =>
      this.#costsSheets.read(),
    );
  }

  async editCostsSheetDraft(input: CostsSheetAgentEdit) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#costsSheets.edit(input, scope),
    );
  }

  async settleCostsSheetDraft(input: CostsSheetSettleInput) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#costsSheets.settleSaved(scope, input),
    );
  }

  /** Plan 40D: an agent's read of an Inbox reply's shared draft. */
  async readMailReplyDraft(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      userId: UserId;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#mailReplyDrafts.read(scope, input.proposalId, input.userId),
    );
  }

  async editMailReplyDraft(input: MailReplyDraftAgentEdit) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#mailReplyDrafts.edit(input, scope),
    );
  }

  /** The draft's text for a reviewed save, read by the reply route. */
  async mailReplyDraftForSave(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      saver: UserId;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, () =>
      this.#mailReplyDrafts.forSave(input.proposalId, input.saver),
    );
  }

  async markMailReplyDraftSaved(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      version: number;
      body: string;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, () =>
      this.#mailReplyDrafts.markSaved(
        input.proposalId,
        input.version,
        input.body,
      ),
    );
  }

  /** Whether a send of `version` sends what the shared draft shows. */
  async mailReplyDraftApproval(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      version: number;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, () =>
      this.#mailReplyDrafts.approval(input.proposalId, input.version),
    );
  }

  async reloadMailReplyDraft(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      userId: UserId;
      controlSessionId: ControlSessionId;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#mailReplyDrafts.reload(
        scope,
        input.organisationId,
        input.proposalId,
        {
          userId: input.userId,
          controlSessionId: input.controlSessionId,
        },
      ),
    );
  }

  /** Plan 40D: a location plan's draft quantities, for an agent read. */
  /** A person applied a workflow revision. Open draft pages read it again. */
  bakeryWorkflowApplied(workflowId: string): void {
    this.#workflowDrafts.revisionApplied(workflowId);
  }

  bakeryWorkflowDraftSnapshot(
    input: Readonly<{ organisationId: OrganisationId; workflowId: string }>,
  ): DraftSnapshot | null {
    return this.#workflowDrafts.snapshot(input.workflowId);
  }

  /** Plan 84: an approved proposal reaches the shared draft and its open pages. */
  async bakeryWorkflowMergeProposal(
    input: Readonly<{
      organisationId: OrganisationId;
      workflowId: string;
      change: DraftChangeSet;
      userId: UserId;
      controlSessionId: ControlSessionId;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#workflowDrafts.mergeProposal(
        scope,
        input.organisationId,
        input.workflowId,
        input.change,
        { userId: input.userId, controlSessionId: input.controlSessionId },
      ),
    );
  }

  async readProductionPlan(
    input: Readonly<{ organisationId: OrganisationId; locationId: string }>,
  ) {
    return this.#roomCommand(input.organisationId, async () =>
      this.#productionPlans.read(input.locationId),
    );
  }

  /** Plan 40D: the Slack thread or Portal chat shared with a plan. */
  async readProductionPlanShare(
    input: Readonly<{ organisationId: OrganisationId; locationId: string }>,
  ) {
    return this.#roomCommand(input.organisationId, async (scope) => ({
      ok: true as const,
      value: await this.#productionPlans.sharedTarget(scope, input.locationId),
    }));
  }

  /** Plan 40D: an agent's change of one line of a location's plan. */
  async editProductionPlan(input: ProductionPlanAgentEdit) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#productionPlans.edit(input, scope),
    );
  }

  /** Plan 40D: removes settled requests from a location's shared plan. */
  async clearProductionPlanLines(
    input: Readonly<{
      organisationId: OrganisationId;
      locationId: string;
      requestIds: readonly string[];
      userId: UserId;
      controlSessionId: ControlSessionId;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#productionPlans.clear(
        scope,
        input.organisationId,
        input.locationId,
        input.requestIds,
        { userId: input.userId, controlSessionId: input.controlSessionId },
      ),
    );
  }

  /** Deletes the draft's text after the reply was sent, rejected or closed. */
  async closeMailReplyDraft(
    input: Readonly<{ organisationId: OrganisationId; proposalId: string }>,
  ) {
    return this.#roomCommand(input.organisationId, async () => {
      await this.#mailReplyDrafts.close(input.organisationId, input.proposalId);
      return { ok: true as const, value: null };
    });
  }

  #roomCommand<Outcome extends Result<unknown, { readonly code: string }>>(
    organisationId: OrganisationId,
    run: (scope: OrganisationExecutionScope) => Promise<Outcome>,
  ) {
    type Outcomes = Outcome | Result<never, OrganisationStateError>;
    const start = async (
      scope: OrganisationExecutionScope,
    ): Promise<Outcomes> => {
      const organisation = validateActionOrganisation(
        this.ctx.storage.sql,
        organisationId,
      );
      if (!organisation.ok) return organisation;
      return run(scope);
    };
    return this.command(organisationId, start);
  }

  async readProductDescriptionDraft(
    input: Readonly<{
      organisationId: OrganisationId;
      request: DraftAgentReadRequest;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadProductDescriptionDraft.bind(this, input),
    );
  }

  async readWorkflowCanvas(
    input: Readonly<{
      organisationId: OrganisationId;
      reference: WorkflowCanvasSource;
      userId: UserId;
      agentRequest: ReturnType<CanvasAgentRequest["toJSON"]>;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadWorkflowCanvas.bind(this, input),
    );
  }

  private async admittedReadWorkflowCanvas(
    input: Readonly<{
      organisationId: OrganisationId;
      reference: WorkflowCanvasSource;
      userId: UserId;
      agentRequest: ReturnType<CanvasAgentRequest["toJSON"]>;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    const request = CanvasAgentRequest.parse(input.agentRequest);
    if (request === null)
      return {
        ok: false as const,
        error: { code: "invalid_request" as const },
      };
    return this.#workflowCanvases.read(scope, input.reference, input.userId, {
      kind: "agent",
      request,
    });
  }

  async moveWorkflowCanvasObject(
    input: Readonly<{
      organisationId: OrganisationId;
      reference: WorkflowCanvasSource;
      request: ReturnType<CanvasMoveRequest["toJSON"]>;
      userId: UserId;
      deadlineAt: number;
      execution: SessionTurnExecution;
      agent: CollaborationAgent;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedMoveWorkflowCanvasObject.bind(this, input),
    );
  }

  private async admittedMoveWorkflowCanvasObject(
    input: Readonly<{
      organisationId: OrganisationId;
      reference: WorkflowCanvasSource;
      request: ReturnType<CanvasMoveRequest["toJSON"]>;
      userId: UserId;
      deadlineAt: number;
      execution: SessionTurnExecution;
      agent: CollaborationAgent;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    const request = CanvasMoveRequest.parse(input.request);
    if (request === null)
      return { ok: false as const, error: { code: "invalid_move" as const } };
    return this.#workflowCanvases.move(
      scope,
      input.reference,
      request,
      input.userId,
      input.deadlineAt,
      { kind: "session_turn", execution: input.execution },
      input.agent,
    );
  }

  private async admittedReadProductDescriptionDraft(
    input: Readonly<{
      organisationId: OrganisationId;
      request: DraftAgentReadRequest;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.#descriptionDrafts.read(scope, input.request.productId);
  }

  async checkScreenRelevance(input: ScreenRelevanceCheckInput) {
    return this.command(
      input.organisationId,
      this.admittedCheckScreenRelevance.bind(this, input),
    );
  }

  async decideScreenRelevance(
    input: Parameters<OrganisationDO["admittedDecideScreenRelevance"]>[0],
  ) {
    return this.command(
      input.organisationId,
      this.admittedDecideScreenRelevance.bind(this, input),
    );
  }

  async evaluateMailClassification(input: MailEvaluationInput) {
    return this.trackExecution(
      this.evaluateAdmittedMailClassification.bind(this, input),
    );
  }

  /**
   * Every Memory with its labels, for the authorized reader to filter. The
   * caller decides what a viewer or a turn may see; nothing here is released
   * to either without that check.
   */
  async readMemories(input: Readonly<{ organisationId: OrganisationId }>) {
    return this.command(
      input.organisationId,
      this.admittedReadMemories.bind(this),
    );
  }

  /** One Memory with its labels, or null, for the authorized reader. */
  async readMemory(
    input: Readonly<{ organisationId: OrganisationId; memoryId: string }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadMemory.bind(this, input.memoryId),
    );
  }

  /** The receipt one applied Memory command left, or null. */
  async readMemoryCommandReceipt(
    input: Readonly<{ organisationId: OrganisationId; commandId: string }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadMemoryCommandReceipt.bind(this, input.commandId),
    );
  }

  /**
   * One page of the accepted revisions scoped to one of `applicabilityKeys`,
   * with their labels, for the turn reader to filter.
   */
  async readAcceptedMemories(
    input: Readonly<{
      organisationId: OrganisationId;
      applicabilityKeys: readonly string[];
      after: AcceptedMemoryCursor | null;
      limit: number;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadAcceptedMemories.bind(this, input),
    );
  }

  /** The accepted revision of each named Memory that has one. */
  async readAcceptedMemoryRevisions(
    input: Readonly<{
      organisationId: OrganisationId;
      memoryIds: readonly string[];
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadAcceptedMemoryRevisions.bind(this, input.memoryIds),
    );
  }

  /**
   * Applies one Memory command for a principal the caller authenticated. A
   * proposal carries the label the caller joined from its evidence and author.
   */
  async commandMemory(
    input: Readonly<{
      organisationId: OrganisationId;
      principal: unknown;
      body: unknown;
      flowLabel: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedCommandMemory.bind(this, input),
    );
  }

  /**
   * Every Eval with its labels, for the authorized reader to filter. The
   * caller decides what a viewer may see; nothing here is released without
   * that check.
   */
  async readEvals(input: Readonly<{ organisationId: OrganisationId }>) {
    return this.command(
      input.organisationId,
      this.admittedReadEvals.bind(this),
    );
  }

  /** One Eval with its labels, or null, for the authorized reader. */
  async readEval(
    input: Readonly<{ organisationId: OrganisationId; evalId: string }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadEval.bind(this, input.evalId),
    );
  }

  /** The receipt one applied Eval command left, or null. */
  async readEvalCommandReceipt(
    input: Readonly<{ organisationId: OrganisationId; commandId: string }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadEvalCommandReceipt.bind(this, input.commandId),
    );
  }

  /**
   * Applies one Eval command for a principal the caller authenticated. A
   * proposal or a revision carries the label the caller joined for it.
   */
  async commandEval(
    input: Readonly<{
      organisationId: OrganisationId;
      principal: unknown;
      body: unknown;
      flowLabel: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedCommandEval.bind(this, input),
    );
  }

  /**
   * Records the settled result of one eval run. Run execution stays with the
   * run's Case and Sessions; this Actor receives only the result.
   */
  async settleEvalRun(
    input: Readonly<{
      organisationId: OrganisationId;
      result: unknown;
      flowLabel: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedSettleEvalRun.bind(this, input),
    );
  }

  /**
   * The governed actions the ledger holds for one Case, for the Case
   * execution projection. The read changes nothing.
   */
  async readCaseExecutionEffects(
    input: Readonly<{ organisationId: OrganisationId; caseId: string }>,
  ): Promise<CaseExecutionEffectRecords | null> {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    return organisation.ok
      ? readCaseEffectRecords(
          this.ctx.storage.sql,
          input.organisationId,
          input.caseId,
        )
      : null;
  }

  /** The settled runs of one Eval with their labels, for the authorized reader. */
  async readEvalRunResults(
    input: Readonly<{ organisationId: OrganisationId; evalId: string }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadEvalRunResults.bind(this, input.evalId),
    );
  }

  async editProductDescriptionDraft(input: DraftAgentEdit) {
    return this.command(
      input.organisationId,
      this.admittedEditProductDescriptionDraft.bind(this, input),
    );
  }

  private async admittedEditProductDescriptionDraft(
    input: DraftAgentEdit,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.#descriptionDrafts.edit(input, scope);
  }

  async readProductDescriptionDraftThread(
    input: Readonly<{
      organisationId: OrganisationId;
      productId: string;
      caseId: string;
    }>,
  ) {
    const start = this.admittedReadProductDescriptionDraftThread.bind(
      this,
      input,
    );
    const result = await this.command(input.organisationId, start);
    return result.ok ? result.value : null;
  }

  async readConnectedProductDescriptionDrafts(
    input: Readonly<{ organisationId: OrganisationId; caseId: string }>,
  ) {
    const start = this.admittedReadConnectedProductDescriptionDrafts.bind(
      this,
      input,
    );
    const result = await this.command(input.organisationId, start);
    return result.ok ? result.value : null;
  }

  private async admittedReadConnectedProductDescriptionDrafts(
    input: Readonly<{ organisationId: OrganisationId; caseId: string }>,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return {
      ok: true as const,
      value: this.#descriptionDrafts.connectedProducts(input.caseId),
    };
  }

  private async admittedReadProductDescriptionDraftThread(
    input: Readonly<{
      organisationId: OrganisationId;
      productId: string;
      caseId: string;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    const sharing = await this.#descriptionDrafts.sharedThread(
      scope,
      input.productId,
      input.caseId,
    );
    return { ok: true as const, value: sharing };
  }

  /** Plan 40B: a board or screen command of the menu board routes. */
  async menuBoardCommand(
    input: Readonly<{
      organisationId: OrganisationId;
      command: MenuBoardCommand;
    }>,
  ): Promise<MenuBoardCommandReply<MenuBoardCommand>> {
    return this.command(
      input.organisationId,
      this.admittedMenuBoardCommand.bind(this, input.command),
    );
  }

  private async admittedMenuBoardCommand(
    command: MenuBoardCommand,
    scope: OrganisationExecutionScope,
  ): Promise<MenuBoardCommandReply<MenuBoardCommand>> {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok)
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    return runMenuBoardCommand(
      {
        boards: this.#menuBoards,
        screens: this.#menuScreens,
        drafts: this.#menuDrafts,
        // A release names the Platform's screen media route: it serves an
        // image only while a published board names it.
        mediaBase: () => Promise.resolve(screenMediaBase(scope.organisationId)),
      },
      command,
      Date.now(),
      scope,
    );
  }

  /**
   * Plan 40B: tells the shop's screens to read their feed again, after the
   * menu or its stock changed. A signal changes nothing, so it needs no
   * admission, and it never fails its caller.
   */
  async signalMenuScreens(
    input: Readonly<{ organisationId: OrganisationId }>,
  ): Promise<number> {
    const row = readOrganisationMetaRow(this.ctx.storage.sql);
    if (row === undefined || row.organisation_id !== input.organisationId)
      return 0;
    return this.#menuScreens.signal({ kind: "all" });
  }

  /**
   * Plan 40B phase 4: the shop's boards for an agent, each with its draft
   * and its newest release, and the menu copy that they name.
   */
  async readMenuBoards(
    input: Readonly<{ organisationId: OrganisationId; boardId: string | null }>,
  ) {
    return this.#roomCommand(input.organisationId, async () => {
      const summaries = this.#menuBoards.list(this.#menuScreens.countByBoard());
      const chosen =
        input.boardId === null
          ? summaries
          : summaries.filter((board) => board.boardId === input.boardId);
      if (input.boardId !== null && chosen.length === 0)
        return {
          ok: false as const,
          error: { code: "menu_board_missing" as const },
        };
      const boards = [];
      for (const summary of chosen) {
        const read = this.#menuBoards.read(summary.boardId);
        if (!read.ok) return read;
        boards.push({ ...read.value, screens: summary.screens });
      }
      const menu = this.#menuDrafts.read();
      return {
        ok: true as const,
        value: {
          boards,
          archivedBoards:
            input.boardId === null ? this.#menuBoards.archivedBoards() : [],
          menu: menu.ok
            ? menu.value.draft
            : { title: "Café menu", sections: [], items: [] },
        },
      };
    });
  }

  /** Plan 40B phase 4: an agent's change of one board's draft. */
  async editMenuBoard(
    input: MenuBoardAgentEdit & Readonly<{ organisationId: OrganisationId }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) => {
      const menu = this.#menuDrafts.read();
      return this.#menuBoards.edit(
        input.organisationId,
        input,
        menu.ok
          ? menu.value.draft
          : { title: "Café menu", sections: [], items: [] },
        scope,
      );
    });
  }

  /** Plan 40B phase 7: an agent's board edit while its model writes it. */
  async previewMenuBoardEdit(
    input: MenuBoardAgentPreview & Readonly<{ organisationId: OrganisationId }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#menuBoards.preview(input.organisationId, input, scope),
    );
  }

  /** Plan 81: an agent's change of the shared menu. */
  async editMenuDraft(
    input: MenuDraftAgentEdit & Readonly<{ organisationId: OrganisationId }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#menuDrafts.edit(input.organisationId, input, scope),
    );
  }

  async readMenuDraft(input: Readonly<{ organisationId: OrganisationId }>) {
    return this.command(
      input.organisationId,
      this.admittedReadMenuDraft.bind(this),
    );
  }

  private async admittedReadMenuDraft(scope: OrganisationExecutionScope) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.#menuDrafts.read();
  }

  async readEmailDraft(input: Readonly<{ organisationId: OrganisationId }>) {
    return this.command(
      input.organisationId,
      this.admittedReadEmailDraft.bind(this),
    );
  }

  private async admittedReadEmailDraft(scope: OrganisationExecutionScope) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.#emailDrafts.read();
  }

  async editEmailDraft(input: EmailDraftAgentEdit) {
    return this.command(
      input.organisationId,
      this.admittedEditEmailDraft.bind(this, input),
    );
  }

  private async admittedEditEmailDraft(
    input: EmailDraftAgentEdit,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.#emailDrafts.edit(input, scope);
  }

  async readEmailDraftThread(
    input: Readonly<{ organisationId: OrganisationId; caseId: string }>,
  ) {
    const start = this.admittedReadEmailDraftThread.bind(this, input);
    const result = await this.command(input.organisationId, start);
    return result.ok ? result.value : null;
  }

  private async admittedReadEmailDraftThread(
    input: Readonly<{ organisationId: OrganisationId; caseId: string }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    const sharing = await this.#emailDrafts.sharedThread(scope, input.caseId);
    return { ok: true as const, value: sharing };
  }

  protected acceptsActivation(): boolean {
    return true;
  }

  async reconcileRelocationReceipt(request: RelocationReceiptRequest) {
    return reconcileFrozenOrganisationReceipt(
      this.env.DB,
      this.ctx.storage,
      request,
    );
  }

  protected override async referencedArchiveKeys(): Promise<
    Result<Iterable<string>, ActorExportError>
  > {
    const database = await resolveOrganisationActorDatabase(
      this.env,
      this.ctx.storage.sql,
    );
    if (!database.ok) return database;
    const activation = readActivationExportSource(this.ctx.storage.sql);
    if (!activation.ok) return activation;
    const organisationId = activation.value.identity.organisationId;
    const references = await workspaceRevisionArchiveKeys(
      database.value,
      this.env.ARCHIVE,
      organisationId,
    );
    if (!references.ok)
      return {
        ok: false,
        error: { code: "export_read_failed", detail: references.error.code },
      };
    return {
      ok: true,
      value: [
        ...(await savedBakeryRunArchiveKeys(this.env.ARCHIVE, organisationId)),
        ...(await readPortalChatAttachmentKeys(
          database.value,
          this.env.ARCHIVE,
          organisationId,
        )),
        ...(await readChatForkAttachmentKeys(database.value, organisationId)),
      ],
    };
  }

  protected override async prepareErasure(): Promise<() => Promise<void>> {
    // The Organisation's clients reconnect to the Actor that serves it next.
    closeAllSockets(this.ctx);
    return async () => {};
  }

  protected quiesceForExport(expectedFenceToken: ActorFenceToken) {
    return this.quiesceArchiveCleanup({ expectedFenceToken });
  }

  /**
   * The Organisation keeps its own export frame: the export captures the
   * Organisation's data archive and deletes its pages after the copy.
   */
  override async exportPlacementState(
    input: ActorExportRequest,
  ): Promise<Result<ActorExportRef, ActorExportError>> {
    const organisation = await this.quiesceForExport(input.expectedFenceToken);
    if (!organisation.ok) return organisation;
    // The Organisation moves: each client reconnects to the Actor that
    // serves it next.
    closeAllSockets(this.ctx);
    const database = await resolveOrganisationActorDatabase(
      this.env,
      this.ctx.storage.sql,
    );
    if (!database.ok) return database;
    let dataKeys: readonly string[] = [];
    try {
      const workspaceKeys = await workspaceRevisionArchiveKeys(
        database.value,
        this.env.ARCHIVE,
        organisation.value,
      );
      if (!workspaceKeys.ok)
        return {
          ok: false,
          error: {
            code: "export_read_failed",
            detail: workspaceKeys.error.code,
          },
        };
      dataKeys = await captureOrganisationDataArchive(
        database.value,
        this.env.ARCHIVE,
        organisation.value,
        input.exportId,
      );
      const referencedR2Keys = [
        ...(await savedBakeryRunArchiveKeys(
          this.env.ARCHIVE,
          organisation.value,
        )),
        ...(await readPortalChatAttachmentKeys(
          database.value,
          this.env.ARCHIVE,
          organisation.value,
        )),
        ...(await readChatForkAttachmentKeys(
          database.value,
          organisation.value,
        )),
      ];
      return await exportActorPlacement({
        storage: this.ctx.storage,
        bucket: this.env.ARCHIVE,
        root: this.env.DATA_ENCRYPTION_ROOT,
        request: input,
        referencedR2Keys: [
          ...referencedR2Keys,
          ...workspaceKeys.value,
          ...dataKeys,
        ],
      });
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "export_write_failed",
          detail: error instanceof Error ? error.message : "chat_export_failed",
        },
      };
    } finally {
      await deleteOrganisationDataArchivePages(this.env.ARCHIVE, dataKeys);
    }
  }

  async reconcileArchiveCleanup(
    input: OrganisationArchiveCleanupRequest,
  ): Promise<Result<number, OrganisationArchiveCleanupError>> {
    if (
      !canAdmitOrganisationArchiveCleanup(this.ctx.storage.sql, input) ||
      this.archiveCleanup !== null
    )
      return {
        ok: false,
        error: { code: "organisation_archive_cleanup_conflict" },
      };
    this.archiveCleanup = this.admitArchiveCleanup(input);
    try {
      return await this.archiveCleanup;
    } finally {
      this.archiveCleanup = null;
    }
  }

  async quiesceArchiveCleanup(input: {
    readonly expectedFenceToken: ActorFenceToken;
  }): Promise<Result<OrganisationId, ActorExportError>> {
    const closed = closeOrganisationArchiveCleanupAdmission(
      this.ctx.storage.sql,
      input.expectedFenceToken,
    );
    if (!closed.ok) return closed;
    if (this.archiveQuiescence === null)
      this.archiveQuiescence = this.drainArchiveCleanup(closed.value);
    const result = await this.archiveQuiescence;
    if (!result.ok) this.archiveQuiescence = null;
    return result;
  }

  override async importPlacementState(
    input: ActorImportRequest,
  ): Promise<Result<ActorImportedState, ActorExportError>> {
    const requestId = newRequestId();
    const startedAt = Date.now();
    traceLog("organisation.import_started", {
      requestId,
      export_id: input.exportRef.exportId,
    });
    const loaded = await loadActorExport({
      bucket: this.env.ARCHIVE,
      root: this.env.DATA_ENCRYPTION_ROOT,
      ref: input.exportRef,
    });
    if (!loaded.ok) return loaded;
    traceLog("organisation.import_manifest_loaded", {
      requestId,
      export_id: input.exportRef.exportId,
      elapsed_ms: Date.now() - startedAt,
    });
    const database = await resolveOrganisationActorDatabase(
      this.env,
      this.ctx.storage.sql,
    );
    if (!database.ok) return database;
    const imported = await importActorExport({
      storage: this.ctx.storage,
      bucket: this.env.ARCHIVE,
      envelope: loaded.value,
      expectedTargetFenceToken: input.expectedTargetFenceToken,
      now: input.requestedAt,
    });
    if (!imported.ok) return imported;
    traceLog("organisation.import_actor_restored", {
      requestId,
      export_id: input.exportRef.exportId,
      elapsed_ms: Date.now() - startedAt,
    });
    const activation = readActivationExportSource(this.ctx.storage.sql);
    if (!activation.ok) return activation;
    try {
      await restoreOrganisationDataArchive({
        directory: this.env.DB,
        database: database.value,
        bucket: this.env.ARCHIVE,
        envelope: loaded.value,
        targetPlacementEpoch: activation.value.placementEpoch,
      });
      traceLog("organisation.import_data_restored", {
        requestId,
        export_id: input.exportRef.exportId,
        elapsed_ms: Date.now() - startedAt,
      });
    } catch (error) {
      return {
        ok: false,
        error: { code: "export_read_failed", detail: errorMessage(error) },
      };
    }
    return imported;
  }

  async ping(): Promise<OrganisationPing> {
    return { ok: true, kind: "organisation" };
  }

  async updateCommerceBoardPresence(input: CommerceBoardPresenceUpdate) {
    return this.command(
      input.organisationId,
      this.admittedUpdateCommerceBoardPresence.bind(this, input),
    );
  }

  private async admittedUpdateCommerceBoardPresence(
    input: CommerceBoardPresenceUpdate,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      readonly CommerceBoardPresenceEntry[],
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    pruneCommerceBoardPresence(this.#commerceBoardPresence, input.now);
    this.#commerceBoardPresence.set(input.userId, {
      userId: input.userId,
      displayName: input.displayName,
      resourceKey: input.resourceKey,
      selection: input.selection,
      dragPreview: input.dragPreview,
      observedAt: input.now,
    });
    return {
      ok: true,
      value: readCommerceBoardPresence(
        this.#commerceBoardPresence,
        input.resourceKey,
      ),
    };
  }

  async readCommerceBoardPresence(input: CommerceBoardPresenceRead) {
    return this.command(
      input.organisationId,
      this.admittedReadCommerceBoardPresence.bind(this, input),
    );
  }

  private async admittedReadCommerceBoardPresence(
    input: CommerceBoardPresenceRead,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      readonly CommerceBoardPresenceEntry[],
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    pruneCommerceBoardPresence(this.#commerceBoardPresence, input.now);
    return {
      ok: true,
      value: readCommerceBoardPresence(
        this.#commerceBoardPresence,
        input.resourceKey,
      ),
    };
  }

  async acceptShopifyLocationObservation(
    input: ShopifyLocationObservationInput,
  ) {
    return this.command(
      input.organisationId,
      this.admittedAcceptShopifyLocationObservation.bind(this, input),
    );
  }

  async assignShopifyLocationClassification(
    input: AssignShopifyLocationClassificationInput,
  ) {
    return this.command(
      input.organisationId,
      this.admittedAssignShopifyLocationClassification.bind(this, input),
    );
  }

  async getOrganisation(
    request: OrganisationMetaRequest,
  ): Promise<
    Result<
      OrganisationMeta,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const row = readOrganisationMetaRow(this.ctx.storage.sql);

    if (row === undefined) {
      return { ok: false, error: { code: "organisation_not_initialized" } };
    }

    if (row.organisation_id !== request.requestingOrganisationId) {
      return { ok: false, error: { code: "organisation_mismatch" } };
    }

    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      admission.scope.organisationId !== request.requestingOrganisationId ||
      !(await isOrganisationExecutionActive(
        this.ctx.storage.sql,
        admission.scope,
      ))
    )
      return organisationPlacementConflict();
    return { ok: true, value: organisationRowToMeta(row) };
  }

  async alarm(): Promise<void> {
    if (this.alarmExecution !== null) {
      await this.alarmExecution;
      return;
    }
    const work = this.runAlarm();
    this.alarmExecution = work;
    try {
      await work;
    } finally {
      this.alarmExecution = null;
    }
  }

  private async runAlarm(): Promise<void> {
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (admission.kind === "deferred") return;
    if (
      admission.kind === "inactive" ||
      !(await isOrganisationExecutionActive(
        this.ctx.storage.sql,
        admission.scope,
      ))
    ) {
      // Another Actor serves the Organisation now. The runtime still answers
      // these sockets' pings, so their clients would never notice.
      closeAllSockets(this.ctx);
      return;
    }
    // Without an identity no reconciler can read the Organisation's rows,
    // so the alarm stops.
    const organisation = readOrganisationMetaRow(this.ctx.storage.sql);
    if (organisation === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const organisationId = parseOrganisationId(organisation.organisation_id);
    if (!organisationId.ok) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    // Each step runs on its own (Refactor 15, S3): a failed step does not
    // stop the others, and the alarm comes back for it after a backoff.
    const failed = await runAlarmSteps("organisation", [
      {
        name: "leases",
        run: () =>
          this.ctx.storage.transactionSync(
            expireOrganisationLeases.bind(
              null,
              this.ctx.storage.sql,
              organisationId.value,
              now,
            ),
          ),
      },
      {
        name: "socket_sweep",
        run: async () => {
          const sweepDueAt = readSocketSweepDueAt(this.ctx.storage.sql);
          if (sweepDueAt !== null && sweepDueAt <= now)
            await this.#sweepSockets(admission.scope);
        },
      },
      {
        // Candidate credentials belong to admitted mutations until those
        // executions settle.
        name: "typesafe_credentials",
        run: async () => {
          if (this.executions.size > 0) return;
          const credentials = await cleanupTypeSafeCredentials({
            sql: this.ctx.storage.sql,
            db: admission.scope.database,
            organisationId: admission.scope.organisationId,
            now,
          });
          if (!credentials.ok) throw new Error(credentials.error.code);
        },
      },
      {
        // Plan 88: each closed hour of Jev use on Pantry's key goes to the meter.
        name: "jev_usage",
        run: async () => {
          this.ctx.storage.transactionSync(
            sealJevUsageHours.bind(
              null,
              this.ctx.storage.sql,
              organisationId.value,
              now,
            ),
          );
          await deliverJevUsageHours({
            sql: this.ctx.storage.sql,
            env: this.env,
            organisationId: organisationId.value,
            now,
          });
        },
      },
      {
        name: "case_context_invalidations",
        run: () =>
          deliverCaseContextCollectionInvalidations(
            this.env,
            this.ctx.storage.sql,
            admission.scope,
          ),
      },
    ]);
    await this.rearm();
    await armAlarmAfterFailedSteps(this.ctx.storage, this.alarmRetries, failed);
  }

  /** Runs in a row with a failed alarm step; the backoff grows with it. */
  private readonly alarmRetries = { failures: 0 };
}

declare module "../env" {
  interface Env {
    ORGANISATION: DurableObjectNamespace<OrganisationDO>;
  }
}
