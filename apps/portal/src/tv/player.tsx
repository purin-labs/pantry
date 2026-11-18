import React from "react";
import {
  COLLABORATION_PING,
  COLLABORATION_PING_INTERVAL_MS,
} from "@seams/collaboration";
import {
  MENU_SCREEN_SOCKET_PROTOCOL,
  parseMenuScreenFeed,
  parseMenuScreenPairing,
  parseMenuScreenPairingState,
  parseMenuScreenPickup,
  parseMenuScreenSignal,
  type MenuScreenFeed,
  type MenuScreenPairing,
  type MenuScreenPickup,
} from "@seams/control-api";
import { ScaledBoard } from "../features/menu-boards/board-view";

/**
 * The shop screen's player at /tv (Plan 40B phase 1). A new screen shows a
 * pairing code until a member pairs it in the Portal. A paired screen plays
 * its board: it reads its feed, keeps a signal socket open, and reads again
 * on each signal and once a minute. It saves the last feed it read, and
 * when the shop cannot be reached it keeps showing that copy with the
 * prices and sold-out marks marked as not verified. A board with order codes
 * also reads the shop's pickups, and never saves them across a restart. A
 * screen that the shop removed goes back to a new code.
 */

const STORAGE_KEY = "satyr.tv.v1";
const POLL_PAIRING_MS = 3_000;
const READ_EVERY_MS = 60_000;

type Stored = Readonly<{
  token: string | null;
  pairing: MenuScreenPairing | null;
  saved: MenuScreenFeed | null;
}>;

/** "limit": too many open codes from this address; "network": no answer. */
type PairingFailure = "limit" | "network";

type PlayerState =
  | Readonly<{ kind: "starting" }>
  | Readonly<{
      kind: "pairing";
      pairing: MenuScreenPairing | null;
      failure: PairingFailure | null;
    }>
  | Readonly<{
      kind: "playing";
      feed: MenuScreenFeed | null;
      /** False while the shop cannot be reached and the saved copy shows. */
      verified: boolean;
      pickup: MenuScreenPickup | null;
    }>;

export function TvPlayer(): React.ReactNode {
  const [state, setState] = React.useState<PlayerState>({ kind: "starting" });
  React.useEffect(() => {
    const player = new Player(setState);
    player.start();
    return () => player.stop();
  }, []);
  switch (state.kind) {
    case "starting":
      return (
        <div className="tv-message">
          <p>Starting…</p>
        </div>
      );
    case "pairing":
      return <PairingScreen pairing={state.pairing} failure={state.failure} />;
    case "playing": {
      const release = state.feed?.release ?? null;
      if (state.feed === null || release === null)
        return (
          <div className="tv-message">
            <h1>{state.feed?.screen.name ?? "Paired"}</h1>
            <p>
              This screen is paired. Publish its board in Seams Pantry, under
              Menus › Boards.
            </p>
          </div>
        );
      return (
        <ScaledBoard
          content={release}
          facts={{
            facts: state.feed.facts,
            // A pickup board shows no menu facts, so only its codes count.
            verified:
              state.verified &&
              (state.feed.facts !== null || release.elements.some(isPickupCodes)),
            pickup: state.pickup,
          }}
          fill
        />
      );
    }
    default:
      return state satisfies never;
  }
}

function PairingScreen(
  props: Readonly<{
    pairing: MenuScreenPairing | null;
    failure: PairingFailure | null;
  }>,
): React.ReactNode {
  return (
    <div className="tv-message tv-pairing">
      <p className="tv-eyebrow">Seams screen</p>
      {props.pairing === null ? (
        <p>
          {props.failure === "limit"
            ? "Too many screens on this network wait for a code. This screen tries again in a minute."
            : props.failure === "network"
              ? "No network. This screen tries again in a moment."
              : "Getting a code…"}
        </p>
      ) : (
        <>
          <p>
            In Seams Pantry, open Menus › Screens, choose “Add a screen”, and
            enter this code:
          </p>
          <p
            className="tv-code"
            aria-label={`Pairing code ${props.pairing.code.split("").join(" ")}`}
          >
            {props.pairing.code}
          </p>
          <p className="tv-detail">
            The code lasts ten minutes. This screen then gets a new one.
          </p>
        </>
      )}
    </div>
  );
}

class Player {
  readonly #notify: (state: PlayerState) => void;
  #stored: Stored;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #reader: ReturnType<typeof setInterval> | null = null;
  #socket: WebSocket | null = null;
  #ping: ReturnType<typeof setInterval> | null = null;
  #attempts = 0;
  #verified = true;
  #pickup: MenuScreenPickup | null = null;

  constructor(notify: (state: PlayerState) => void) {
    this.#notify = notify;
    this.#stored = readStored();
  }

  start(): void {
    window.addEventListener("online", this.#online);
    if (this.#stored.token === null) void this.#pair();
    else this.#play();
  }

  stop(): void {
    this.#stopped = true;
    window.removeEventListener("online", this.#online);
    this.#clearTimers();
    this.#closeSocket();
  }

  readonly #online = (): void => {
    if (this.#stored.token !== null) void this.#read();
  };

  async #pair(): Promise<void> {
    if (this.#stopped) return;
    const kept = this.#stored.pairing;
    let pairing =
      kept !== null && kept.expiresAt > Date.now() + 15_000 ? kept : null;
    if (pairing === null) {
      const response = await fetch("/v1/screens/pairings", {
        method: "POST",
      }).catch(() => null);
      pairing =
        response?.ok === true
          ? parseMenuScreenPairing(await response.json().catch(() => null))
          : null;
      if (pairing === null) {
        // A refusal for this address waits longer than a lost network.
        const failure = response?.status === 429 ? "limit" : "network";
        this.#notify({ kind: "pairing", pairing: null, failure });
        this.#later(
          this.#pair.bind(this),
          failure === "limit" ? 60_000 : 10_000,
        );
        return;
      }
      this.#save({ ...this.#stored, pairing });
    }
    this.#notify({ kind: "pairing", pairing, failure: null });
    const response = await fetch(`/v1/screens/pairings/${pairing.pairingId}`, {
      headers: { Authorization: `Bearer ${pairing.secret}` },
    }).catch(() => null);
    if (response?.status === 404) {
      // The code expired; the next round asks for a new one.
      this.#save({ ...this.#stored, pairing: null });
      this.#later(this.#pair.bind(this), 0);
      return;
    }
    const answer =
      response?.ok === true
        ? parseMenuScreenPairingState(await response.json().catch(() => null))
        : null;
    if (answer?.state === "paired") {
      this.#save({ token: answer.token, pairing: null, saved: null });
      this.#play();
      return;
    }
    this.#later(this.#pair.bind(this), POLL_PAIRING_MS);
  }

  #play(): void {
    this.#verified = this.#stored.saved === null;
    this.#notify({
      kind: "playing",
      feed: this.#stored.saved,
      verified: this.#verified,
      pickup: this.#pickup,
    });
    void this.#read();
    this.#connect();
    this.#reader = setInterval(() => void this.#read(), READ_EVERY_MS);
  }

  async #read(): Promise<void> {
    const token = this.#stored.token;
    if (this.#stopped || token === null) return;
    const response = await fetch("/v1/screens/feed", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }).catch(() => null);
    if (response?.status === 401) return this.#unpaired();
    const feed =
      response?.ok === true
        ? parseMenuScreenFeed(await response.json().catch(() => null))
        : null;
    if (feed === null) {
      this.#verified = false;
      this.#notify({
        kind: "playing",
        feed: this.#stored.saved,
        verified: false,
        pickup: this.#pickup,
      });
      return;
    }
    // A feed without facts keeps the saved facts, which are then not verified.
    const facts = feed.facts ?? this.#stored.saved?.facts ?? null;
    const shown: MenuScreenFeed = { ...feed, facts };
    this.#verified = feed.facts !== null;
    this.#save({ ...this.#stored, saved: shown });
    if (feed.release?.elements.some(isPickupCodes) === true) {
      const pickup = await this.#readPickup(token);
      this.#verified = pickup !== null;
      if (pickup !== null) this.#pickup = pickup;
    }
    this.#notify({
      kind: "playing",
      feed: shown,
      verified: this.#verified,
      pickup: this.#pickup,
    });
  }

  async #readPickup(token: string): Promise<MenuScreenPickup | null> {
    const response = await fetch("/v1/screens/pickup", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }).catch(() => null);
    return response?.ok === true
      ? parseMenuScreenPickup(await response.json().catch(() => null))
      : null;
  }

  #connect(): void {
    const token = this.#stored.token;
    if (this.#stopped || token === null) return;
    const url = new URL("/v1/screens/socket", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, [MENU_SCREEN_SOCKET_PROTOCOL, token]);
    } catch {
      this.#reconnect();
      return;
    }
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#attempts = 0;
      this.#ping = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(COLLABORATION_PING);
      }, COLLABORATION_PING_INTERVAL_MS);
      // A signal may have come while the socket was closed.
      void this.#read();
    });
    socket.addEventListener("message", (event) => {
      if (parseMenuScreenSignal(event.data)) void this.#read();
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#closeSocket();
      if (event.code === 4403) return this.#unpaired();
      this.#reconnect();
    });
  }

  #reconnect(): void {
    if (this.#stopped) return;
    this.#attempts = Math.min(this.#attempts + 1, 5);
    this.#later(
      this.#connect.bind(this),
      Math.min(1_000 * 2 ** this.#attempts, 30_000),
    );
    void this.#read();
  }

  #unpaired(): void {
    this.#clearTimers();
    this.#closeSocket();
    this.#save({ token: null, pairing: null, saved: null });
    void this.#pair();
  }

  #closeSocket(): void {
    if (this.#ping !== null) clearInterval(this.#ping);
    this.#ping = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null && socket.readyState <= WebSocket.OPEN) socket.close();
  }

  #clearTimers(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    if (this.#reader !== null) clearInterval(this.#reader);
    this.#timer = null;
    this.#reader = null;
  }

  #later(run: () => void, ms: number): void {
    if (this.#stopped) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(run, ms);
  }

  #save(stored: Stored): void {
    this.#stored = stored;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // A screen without storage still plays; it loses its copy on restart.
    }
  }
}

function isPickupCodes(element: Readonly<{ kind: string }>): boolean {
  return element.kind === "pickup_codes";
}

function readStored(): Stored {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    );
    if (typeof raw !== "object" || raw === null) return EMPTY;
    const value = raw as Record<string, unknown>;
    const token =
      typeof value.token === "string" && value.token.startsWith("scr1.")
        ? value.token
        : null;
    return {
      token,
      pairing: token === null ? parseMenuScreenPairing(value.pairing) : null,
      saved: token === null ? null : parseMenuScreenFeed(value.saved),
    };
  } catch {
    return EMPTY;
  }
}

const EMPTY: Stored = { token: null, pairing: null, saved: null };
