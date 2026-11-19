import {
  COLLABORATION_PING,
  COLLABORATION_PING_INTERVAL_MS,
  COLLABORATION_PONG,
  COLLABORATION_PONG_TIMEOUT_MS,
} from "@purin-labs/collaboration";

/**
 * Pings a collaboration socket and reports a connection that stopped
 * answering. The server's runtime answers the ping without waking the room, so
 * an idle open tab costs the room no time. Any frame from the server also
 * shows that the connection is alive.
 */
export class SocketLiveness {
  readonly #socket: WebSocket;
  readonly #lost: () => void;
  readonly #timer: ReturnType<typeof setInterval>;
  #answeredAt = Date.now();

  constructor(socket: WebSocket, lost: () => void) {
    this.#socket = socket;
    this.#lost = lost;
    this.#timer = setInterval(this.#tick.bind(this), COLLABORATION_PING_INTERVAL_MS);
  }

  /** Records a frame from the server. Returns `true` for a pong, which needs no other handling. */
  received(data: unknown): boolean {
    this.#answeredAt = Date.now();
    return data === COLLABORATION_PONG;
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  #tick(): void {
    if (Date.now() - this.#answeredAt > COLLABORATION_PONG_TIMEOUT_MS) {
      this.stop();
      this.#lost();
      return;
    }
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.send(COLLABORATION_PING);
  }
}
