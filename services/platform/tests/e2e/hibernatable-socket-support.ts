// Clients, sockets and sweeps for journeys over the Organisation's
// hibernatable sockets (collaboration rooms and chat signals).
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { COLLABORATION_PING, COLLABORATION_PONG } from "@purin-labs/collaboration";

import type { OrganisationDO } from "../../src/actors/organisation";
import {
  issueControlSession,
  upsertUser,
  type IssuedControlSession,
  type User,
} from "../../src/data/control-plane";

export const PUBLIC_ORIGIN = "https://localhost";
/** The close code of a socket whose Actor no longer serves the Organisation. */
export const SOCKET_MOVED_CODE = 1012;

export type ControlClient = Readonly<{
  identity: User;
  session: IssuedControlSession;
}>;

export async function createControlClient(
  subject: string,
  displayName: string,
): Promise<ControlClient> {
  const now = Date.now() - 1_000;
  const identity = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject,
      email: `${subject}@sockets.example`,
      displayName,
      emailVerified: true,
    },
    now,
  });
  const session = await issueControlSession({
    db: env.DB,
    userId: identity.userId,
    now,
    ttlMs: 30 * 60 * 1_000,
  });
  return { identity, session };
}

/** The Portal's session cookies, for a read. */
export function controlReadHeaders(
  session: IssuedControlSession,
): Record<string, string> {
  return {
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
  };
}

/** Opens a socket from the Portal's origin and accepts it. */
export async function openSocket(
  url: string,
  session: IssuedControlSession,
): Promise<WebSocket> {
  const response = await exports.default.fetch(url, {
    headers: {
      ...controlReadHeaders(session),
      Upgrade: "websocket",
      Origin: PUBLIC_ORIGIN,
    },
  });
  expect(response.status).toBe(101);
  if (response.webSocket === null) throw new Error("socket was not returned");
  response.webSocket.accept();
  return response.webSocket;
}

/** The runtime answers a ping without waking the Actor. */
export function expectPong(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      if (event.data !== COLLABORATION_PONG) return;
      socket.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("socket did not answer its ping"));
    }, 5_000);
    socket.addEventListener("message", onMessage);
    socket.send(COLLABORATION_PING);
  });
}

/** The code of the socket's next close. */
export function nextCloseCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve(-1);
    socket.addEventListener(
      "close",
      (event: CloseEvent) => resolve(event.code),
      { once: true },
    );
  });
}

export async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = nextCloseCode(socket);
  socket.close(1000, "journey finished");
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

export async function dueSocketSweepNow(
  _instance: OrganisationDO,
  state: DurableObjectState,
): Promise<void> {
  // The sweep is due now. The alarm stays in the future, so that the journey
  // runs it with runDurableObjectAlarm and not the runtime on its own.
  state.storage.sql.exec("UPDATE hibernatable_socket_sweep SET due_at = 0");
  await state.storage.setAlarm(Date.now() + 60_000);
}
