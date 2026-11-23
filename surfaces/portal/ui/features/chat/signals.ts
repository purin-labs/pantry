import {
  parseChatSignal,
  SURFACE_EFFECT_SIGNAL,
  type ChatSignal,
} from "@purin-labs/control-api";
import { SocketLiveness } from "@purin-labs/collaboration/portal/socket-liveness";
import {
  announceSurfaceEffect,
  setSurfaceSignalsLive,
} from "@purin-labs/ui/features/surface-effect-signals";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_LIMIT_MS = 30_000;
/** The server closed the socket because the page's chat access ended. */
const ACCESS_REVOKED_CODE = 4403;

/**
 * The chat page's signal socket. The server sends a signal after a write
 * that changes what the page shows; the signal carries no content, so the
 * page reads through the chat routes. While the socket is down, `live()` is
 * false and the page polls instead. After each connection, `connected` runs,
 * so the page reads once what it missed.
 */
export class ChatSignalSocket {
  readonly #url: string;
  readonly #signal: (signal: ChatSignal) => void;
  readonly #connected: () => void;
  #socket: WebSocket | null = null;
  #live = false;
  #liveness: SocketLiveness | null = null;
  #attempts = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(
    organisationId: string,
    signal: (signal: ChatSignal) => void,
    connected: () => void,
  ) {
    const url = new URL(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/chat/signals`,
      window.location.origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.#url = url.href;
    this.#signal = signal;
    this.#connected = connected;
    this.#connect();
  }

  live(): boolean {
    return this.#live;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#liveness?.stop();
    this.#liveness = null;
    this.#live = false;
    setSurfaceSignalsLive(this, false);
    this.#socket?.close();
    this.#socket = null;
  }

  #connect(): void {
    this.#timer = null;
    if (this.#disposed) return;
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    socket.addEventListener("open", this.#opened.bind(this, socket));
    socket.addEventListener("message", this.#received.bind(this, socket));
    socket.addEventListener("close", this.#closed.bind(this, socket));
    socket.addEventListener("error", this.#lost.bind(this, socket));
  }

  #opened(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#attempts = 0;
    this.#live = true;
    setSurfaceSignalsLive(this, true);
    this.#liveness?.stop();
    this.#liveness = new SocketLiveness(socket, this.#lost.bind(this, socket));
    this.#connected();
  }

  #received(socket: WebSocket, event: MessageEvent): void {
    if (this.#socket !== socket) return;
    if (this.#liveness?.received(event.data) === true) return;
    const signal = parseChatSignal(event.data);
    // A browser command goes to the Kitchen bridge, not to the page.
    if (signal?.kind === SURFACE_EFFECT_SIGNAL) announceSurfaceEffect();
    else if (signal !== null) this.#signal(signal);
  }

  #closed(socket: WebSocket, event: CloseEvent): void {
    // Without chat access the page polls, and its reads show the refusal.
    if (this.#socket === socket && event.code === ACCESS_REVOKED_CODE)
      this.#disposed = true;
    this.#lost(socket);
  }

  #lost(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#live = false;
    setSurfaceSignalsLive(this, false);
    this.#liveness?.stop();
    this.#liveness = null;
    socket.close();
    if (this.#disposed) return;
    const delay = Math.min(
      RECONNECT_LIMIT_MS,
      RECONNECT_BASE_MS * 2 ** this.#attempts,
    );
    this.#attempts += 1;
    this.#timer = setTimeout(
      this.#connect.bind(this),
      delay / 2 + Math.random() * (delay / 2),
    );
  }
}
