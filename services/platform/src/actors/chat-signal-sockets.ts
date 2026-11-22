import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  CHAT_SIGNAL,
  SURFACE_EFFECT_SIGNAL,
  type ChatSignal,
} from "@purin-labs/control-api";
import { assertNever, isNonNegativeInteger, isRecord } from "@purin-labs/std";

import { visibleConversationsSql } from "../chat/conversation-access";
import type { ChatSignalTarget } from "../chat/signals";
import type { AuthorizedOrganisationRequest } from "../control/authorization";
import { controlError } from "../control/http";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseControlSessionId,
  type ControlSessionId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  SOCKET_SILENCE_LIMIT_MS,
  acceptSocket,
  closeSocket,
  openSockets,
  socketLastSeenAt,
  socketRouteTag,
} from "./hibernatable-sockets";
import { socketSessionAccess } from "./socket-session-access";

/** An open canvas page: a socket of a canvas room, with its canvas and user. */
type CanvasPage = Readonly<{
  socket: WebSocket;
  documentId: string;
  userId: UserId;
}>;

/**
 * The canvas pages of the Organisation actor, which the Kitchen owns. The
 * actor gives them, so that a chat of a canvas reaches its canvas pages.
 */
export type CanvasChatPages = Readonly<{
  open(ctx: DurableObjectState): readonly CanvasPage[];
  signal(pages: readonly CanvasPage[]): void;
}>;

/**
 * The chat signal sockets of an Organisation: one for each open chat page.
 * A socket carries only signals (`ChatSignal`); the page reads the changed
 * state through the checked chat routes. Everything that a socket needs
 * after a wake is in its attachment.
 */

/** The route kind in the attachment, and the tag of every chat socket. */
const CHAT_SIGNALS = "chat_signals";
const ACCESS_REVOKED_CODE = 4403;
/** A user has at most this many open chat pages with a socket. */
const SOCKETS_PER_USER = 20;

type ChatSignalAttachment = Readonly<{
  route: Readonly<{ kind: typeof CHAT_SIGNALS }>;
  controlSessionId: ControlSessionId;
  userId: UserId;
  openedAt: number;
}>;

/** A page sends only pings, which the runtime answers; anything else closes it. */
export const CHAT_SIGNAL_SOCKET_HANDLER = {
  receive(socket: WebSocket): void {
    closeSocket(socket, 1003, "unexpected_message");
  },
  closed(): void {},
};

/** Whether an accepted socket is a chat signal socket. */
export function isChatSignalSocket(socket: WebSocket): boolean {
  return chatSignalAttachment(socket) !== null;
}

/**
 * Accepts the signal socket of a chat page. The caller checked the request as
 * the chat GET checks it, and also the socket's Origin.
 */
export async function openChatSignalSocket(
  ctx: DurableObjectState,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const session = authorized.authenticated.session;
  const tag = await userTag(session.userId);
  if (openSockets(ctx, tag).length >= SOCKETS_PER_USER)
    return controlError("chat_signal_sockets_exhausted", 429);
  const attachment: ChatSignalAttachment = {
    route: { kind: CHAT_SIGNALS },
    controlSessionId: session.controlSessionId,
    userId: session.userId,
    openedAt: Date.now(),
  };
  return (
    acceptSocket(ctx, [CHAT_SIGNALS, tag], attachment) ??
    controlError("chat_signal_unavailable", 503)
  );
}

/**
 * Sends the signal to the open pages that `target` names. A conversation's
 * signal goes only to the users whom the visibility query allows; the query
 * runs only while such pages are open. A canvas chat belongs to its canvas:
 * its signal goes as a canvas frame to that canvas's room sockets, and to no
 * chat page.
 */
export async function sendChatSignal(
  ctx: DurableObjectState,
  organisationId: OrganisationId,
  target: ChatSignalTarget,
  database: () => OrganisationDatabase | null,
  canvasPages: CanvasChatPages,
  kind: ChatSignal["kind"] = CHAT_SIGNAL,
): Promise<void> {
  const signal = SIGNALS[kind];
  switch (target.kind) {
    case "organisation":
      broadcast(openSockets(ctx, CHAT_SIGNALS), signal);
      return;
    case "user":
      broadcast(openSockets(ctx, await userTag(target.userId)), signal);
      return;
    case "conversation": {
      const pages = openPages(ctx);
      const canvases = canvasPages.open(ctx);
      if (pages.length === 0 && canvases.length === 0) return;
      const db = database();
      if (db === null) return;
      const audience = await conversationAudience(
        db,
        organisationId,
        target.conversationId,
        [...new Set([...pages.map(pageUser), ...canvases.map(canvasUser)])],
      );
      if (audience.canvasDocumentId === null)
        broadcast(
          pages
            .filter((page) => audience.users.has(page.attachment.userId))
            .map(pageSocket),
          signal,
        );
      else
        canvasPages.signal(
          canvases.filter(
            (canvas) =>
              canvas.documentId === audience.canvasDocumentId &&
              audience.users.has(canvas.userId),
          ),
        );
      return;
    }
    default:
      return assertNever(target);
  }
}

/**
 * Closes each socket whose page stopped pinging, and each socket whose session
 * or chat access ended (code 4403, which the page does not reopen). A check
 * that fails leaves its socket to the next sweep.
 */
export async function sweepChatSignalSockets(
  ctx: DurableObjectState,
  env: Env,
  scope: OrganisationExecutionScope,
): Promise<void> {
  const now = Date.now();
  for (const page of openPages(ctx)) {
    if (
      now - socketLastSeenAt(ctx, page.socket, page.attachment.openedAt) >
      SOCKET_SILENCE_LIMIT_MS
    ) {
      closeSocket(page.socket, 1001, "silent");
      continue;
    }
    const access = await socketSessionAccess({
      env,
      scope,
      controlSessionId: page.attachment.controlSessionId,
      userId: page.attachment.userId,
      action: "disclose",
      requiredRole: "admin",
    });
    // A check that could not run now is checked again at the next sweep.
    if (access.kind === "refused")
      closeSocket(page.socket, ACCESS_REVOKED_CODE, "access_revoked");
  }
}

type ChatPage = Readonly<{
  socket: WebSocket;
  attachment: ChatSignalAttachment;
}>;

function openPages(ctx: DurableObjectState): ChatPage[] {
  const pages: ChatPage[] = [];
  for (const socket of openSockets(ctx, CHAT_SIGNALS)) {
    const attachment = chatSignalAttachment(socket);
    if (attachment === null) closeSocket(socket, 1011, "invalid_attachment");
    else pages.push({ socket, attachment });
  }
  return pages;
}

function pageUser(page: ChatPage): UserId {
  return page.attachment.userId;
}

function pageSocket(page: ChatPage): WebSocket {
  return page.socket;
}

function canvasUser(page: CanvasPage): UserId {
  return page.userId;
}

/**
 * Of `users`, the ones who may see the conversation, and the canvas that the
 * conversation belongs to, or `null` for a chat of the chat pages.
 */
type ConversationAudience = Readonly<{
  users: ReadonlySet<UserId>;
  canvasDocumentId: string | null;
}>;

async function conversationAudience(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  conversationId: string,
  users: readonly UserId[],
): Promise<ConversationAudience> {
  const rows = await db
    .prepare(
      `${visibleConversationsSql(
        "SELECT ? AS organisation_id, value AS user_id FROM json_each(?)",
        { requesterColumn: true },
      )}
      SELECT DISTINCT requester_user_id, access_kind, canvas_document_id
      FROM visible_conversation WHERE conversation_id = ?`,
    )
    .bind(organisationId, JSON.stringify(users), conversationId)
    .all<{
      requester_user_id: unknown;
      access_kind: unknown;
      canvas_document_id: unknown;
    }>();
  const audience = new Set<UserId>();
  let canvasDocumentId: string | null = null;
  for (const row of rows.results) {
    if (row.access_kind === "workspace_canvas") {
      // A canvas chat without its canvas reaches no page.
      if (typeof row.canvas_document_id !== "string")
        return { users: new Set(), canvasDocumentId: null };
      canvasDocumentId = row.canvas_document_id;
    }
    const userId =
      typeof row.requester_user_id === "string"
        ? parseUserId(row.requester_user_id)
        : null;
    if (userId?.ok === true) audience.add(userId.value);
  }
  return { users: audience, canvasDocumentId };
}

function userTag(userId: UserId): Promise<string> {
  return socketRouteTag("chat_user", userId);
}

const SIGNALS: Readonly<Record<ChatSignal["kind"], string>> = {
  [CHAT_SIGNAL]: JSON.stringify({ kind: CHAT_SIGNAL } satisfies ChatSignal),
  [SURFACE_EFFECT_SIGNAL]: JSON.stringify({
    kind: SURFACE_EFFECT_SIGNAL,
  } satisfies ChatSignal),
};

function broadcast(sockets: readonly WebSocket[], signal: string): void {
  for (const socket of sockets) {
    try {
      socket.send(signal);
    } catch {
      // The socket closed; its close event ends it.
    }
  }
}

function chatSignalAttachment(socket: WebSocket): ChatSignalAttachment | null {
  const value: unknown = socket.deserializeAttachment();
  if (
    !isRecord(value) ||
    !isRecord(value.route) ||
    value.route.kind !== CHAT_SIGNALS ||
    typeof value.controlSessionId !== "string" ||
    typeof value.userId !== "string" ||
    !isNonNegativeInteger(value.openedAt)
  )
    return null;
  const controlSessionId = parseControlSessionId(value.controlSessionId);
  const userId = parseUserId(value.userId);
  if (!controlSessionId.ok || !userId.ok) return null;
  return {
    route: { kind: CHAT_SIGNALS },
    controlSessionId: controlSessionId.value,
    userId: userId.value,
    openedAt: value.openedAt,
  };
}
