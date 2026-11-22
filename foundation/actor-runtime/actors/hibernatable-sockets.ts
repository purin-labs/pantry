import {
  sha256Hex,
  SOCKET_PING,
  SOCKET_PONG,
  SOCKET_PRESENCE_EXPIRY_MS,
} from "@purin-labs/std";

/**
 * Sockets that an Actor accepts through the hibernation API.
 *
 * The runtime keeps such a socket open while the Actor leaves memory, and it
 * starts the Actor again for the next event on the socket. An idle open socket
 * therefore costs no Actor time. Everything a socket needs after a wake lives
 * in its attachment; nothing lives only in the memory of one activation.
 */

/** The runtime refuses a larger serialized attachment. */
const ATTACHMENT_LIMIT_BYTES = 16_384;

/** The time between sweeps while any socket is open. */
export const SOCKET_SWEEP_INTERVAL_MS = 300_000;

/**
 * A client pings every 30 s. A socket silent for longer than this lost its
 * client, and a sweep closes it. While two people share a room, sweeps run
 * this often, so a dropped client leaves the room's presence in time.
 */
export const SOCKET_SILENCE_LIMIT_MS = SOCKET_PRESENCE_EXPIRY_MS;

/**
 * The Actor no longer serves its sockets: the Organisation moved, or its
 * state is erased. A client reconnects, and its next socket reaches the
 * Actor that serves the Organisation now.
 */
export const SOCKET_MOVED = { code: 1012, reason: "organisation_moved" };

/** Answers a client's ping without a wake and without a charge. */
export function installSocketAutoResponse(ctx: DurableObjectState): void {
  // A runtime without the hibernation API (an Actor built outside workerd)
  // serves no sockets, so it needs no answer.
  if (typeof WebSocketRequestResponsePair !== "function") return;
  ctx.setWebSocketAutoResponse(
    new WebSocketRequestResponsePair(SOCKET_PING, SOCKET_PONG),
  );
}

/**
 * The tag that names the sockets of one resource. A tag holds at most 256
 * characters and a resource key may hold as many, so the tag holds a digest;
 * the attachment keeps the full key.
 */
export async function socketRouteTag(
  kind: string,
  key: string,
): Promise<string> {
  return `${kind}:${(await sha256Hex(key)).slice(0, 32)}`;
}

const acceptedServers = new WeakMap<Response, WebSocket>();

/**
 * Accepts a socket under `tags` with its attachment, or returns `null` when
 * the attachment is larger than the runtime keeps.
 */
export function acceptSocket(
  ctx: DurableObjectState,
  tags: string | readonly string[],
  attachment: unknown,
): Response | null {
  if (
    new TextEncoder().encode(JSON.stringify(attachment)).byteLength >
    ATTACHMENT_LIMIT_BYTES
  )
    return null;
  const pair = new WebSocketPair();
  ctx.acceptWebSocket(pair[1], typeof tags === "string" ? [tags] : [...tags]);
  try {
    pair[1].serializeAttachment(attachment);
  } catch {
    // An accepted socket without its attachment would serve no one.
    closeSocket(pair[1], 1011, "attachment_refused");
    return null;
  }
  const response = new Response(null, { status: 101, webSocket: pair[0] });
  acceptedServers.set(response, pair[1]);
  return response;
}

/** Whether `response` carries a socket that this module accepted. */
export function acceptedSocket(response: Response): boolean {
  return acceptedServers.has(response);
}

/**
 * Closes the server end of an accepted socket whose upgrade response the
 * Actor replaced with a refusal, so that no socket stays open without a client.
 */
export function closeAcceptedSocket(response: Response, reason: string): void {
  const server = acceptedServers.get(response);
  if (server === undefined) return;
  acceptedServers.delete(response);
  closeSocket(server, 1011, reason);
}

/** Closes `socket`, which may be closed already. */
export function closeSocket(
  socket: WebSocket,
  code: number,
  reason: string,
): void {
  try {
    socket.close(code, reason);
  } catch {
    // The socket is closed already.
  }
}

/** Closes every socket of the Actor, so that each client reconnects. */
export function closeAllSockets(ctx: DurableObjectState): void {
  for (const socket of ctx.getWebSockets())
    closeSocket(socket, SOCKET_MOVED.code, SOCKET_MOVED.reason);
}

/** The open sockets under `tag`, or every open socket of the Actor. */
export function openSockets(
  ctx: DurableObjectState,
  tag?: string,
): WebSocket[] {
  return ctx.getWebSockets(tag).filter(isOpen);
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}

/** The last time that the client sent a message or a ping. */
export function socketLastSeenAt(
  ctx: DurableObjectState,
  socket: WebSocket,
  lastMessageAt: number,
): number {
  const answered = ctx.getWebSocketAutoResponseTimestamp(socket);
  return Math.max(lastMessageAt, answered === null ? 0 : answered.getTime());
}

export function createSocketSweepSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS hibernatable_socket_sweep (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      due_at INTEGER NOT NULL CHECK (due_at >= 0)
    )`,
  );
}

/** Keeps a sweep due no later than `interval` after `now`. */
export function scheduleSocketSweep(
  sql: SqlStorage,
  now: number,
  interval: number,
): void {
  sql.exec(
    `INSERT INTO hibernatable_socket_sweep (singleton, due_at) VALUES (1, ?)
     ON CONFLICT (singleton) DO UPDATE SET due_at = min(due_at, excluded.due_at)`,
    now + interval,
  );
}

export function readSocketSweepDueAt(sql: SqlStorage): number | null {
  const row = sql
    .exec<{
      due_at: number;
    }>("SELECT due_at FROM hibernatable_socket_sweep WHERE singleton = 1")
    .toArray()[0];
  return row === undefined ? null : row.due_at;
}

/**
 * Sets the next sweep after a sweep ran, `interval` after `now`, or ends
 * sweeps when `interval` is null because no socket is open.
 */
export function finishSocketSweep(
  sql: SqlStorage,
  now: number,
  interval: number | null,
): void {
  if (interval === null) {
    sql.exec("DELETE FROM hibernatable_socket_sweep");
    return;
  }
  sql.exec(
    `INSERT INTO hibernatable_socket_sweep (singleton, due_at) VALUES (1, ?)
     ON CONFLICT (singleton) DO UPDATE SET due_at = excluded.due_at`,
    now + interval,
  );
}
