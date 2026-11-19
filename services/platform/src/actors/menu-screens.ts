import {
  MENU_SCREEN_SIGNAL,
  MENU_SCREEN_SOCKET_PROTOCOL,
  type MenuScreenSummary,
} from "@purin-labs/control-api";
import { isNonNegativeInteger, isRecord, sha256Hex } from "@purin-labs/std";

import { controlError } from "../control/http";
import type { UserId } from "../ids";
import {
  SOCKET_SILENCE_LIMIT_MS,
  acceptSocket,
  closeSocket,
  openSockets,
  socketLastSeenAt,
} from "./hibernatable-sockets";

/**
 * The paired screens of an Organisation (Plan 40B phase 1). A screen holds a
 * token; this Actor keeps only its SHA-256. A screen reads its feed over
 * HTTP and keeps one socket open, which carries only `MENU_SCREEN_SIGNAL`:
 * the screen then reads its feed again. A removed screen's token stops at
 * once, and its socket closes with 4403, which the player takes as the end
 * of its pairing.
 */

/** The tag of every screen socket, and the route kind of its attachment. */
const MENU_SCREENS = "menu_screens";
const SCREEN_REMOVED_CODE = 4403;
/** An Organisation pairs at most this many screens. */
const SCREEN_LIMIT = 40;
/** A screen keeps at most this many sockets open, for a page opened twice. */
const SOCKETS_PER_SCREEN = 3;

type MenuScreenRow = Readonly<{
  screenId: string;
  name: string;
  boardId: string;
}>;

type ScreenAttachment = Readonly<{
  route: Readonly<{ kind: typeof MENU_SCREENS }>;
  screenId: string;
  openedAt: number;
}>;

/** A screen's socket sends only pings, which the runtime answers. */
export const MENU_SCREEN_SOCKET_HANDLER = {
  receive(socket: WebSocket): void {
    closeSocket(socket, 1003, "unexpected_message");
  },
  closed(): void {},
};

export function isMenuScreenSocket(socket: WebSocket): boolean {
  return screenAttachment(socket) !== null;
}

/** A screen's token: the Organisation, the screen, and its secret. */
export function menuScreenToken(
  organisationId: string,
  screenId: string,
  secret: string,
): string {
  return `scr1.${organisationId}.${screenId}.${secret}`;
}

export function parseMenuScreenToken(
  token: string,
): Readonly<{
  organisationId: string;
  screenId: string;
  secret: string;
}> | null {
  const match =
    /^scr1\.([A-Za-z0-9][A-Za-z0-9:_-]{0,127})\.(screen_[a-f0-9]{20})\.([A-Za-z0-9_-]{43})$/u.exec(
      token,
    );
  return match === null
    ? null
    : {
        organisationId: match[1] ?? "",
        screenId: match[2] ?? "",
        secret: match[3] ?? "",
      };
}

/** Whether a request is a screen's signal socket, which the Actor serves. */
export function isMenuScreenSocketPath(pathname: string): boolean {
  return pathname === "/v1/screens/socket";
}

/** The token that a screen's socket request carries in its subprotocols. */
export function menuScreenSocketToken(request: Request): string | null {
  const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim());
  return protocols.length === 2 && protocols[0] === MENU_SCREEN_SOCKET_PROTOCOL
    ? (protocols[1] ?? null)
    : null;
}

export class MenuScreens {
  readonly #ctx: DurableObjectState;
  readonly #sql: SqlStorage;

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
    this.#sql = ctx.storage.sql;
    ctx.storage.transactionSync(createMenuScreenSchema.bind(null, this.#sql));
  }

  list(): MenuScreenSummary[] {
    const open = new Map<string, number>();
    for (const socket of openSockets(this.#ctx, MENU_SCREENS)) {
      const attachment = screenAttachment(socket);
      if (attachment === null) continue;
      const seen = socketLastSeenAt(this.#ctx, socket, attachment.openedAt);
      open.set(
        attachment.screenId,
        Math.max(open.get(attachment.screenId) ?? 0, seen),
      );
    }
    return this.#sql
      .exec<{
        screen_id: string;
        name: string;
        board_id: string;
        paired_at: number;
        last_seen_at: number | null;
      }>(
        `SELECT screen_id, name, board_id, paired_at, last_seen_at
         FROM menu_screen WHERE removed_at IS NULL ORDER BY paired_at, screen_id`,
      )
      .toArray()
      .map((row) => {
        const socketSeen = open.get(row.screen_id);
        return {
          screenId: row.screen_id,
          name: row.name,
          boardId: row.board_id,
          pairedAt: row.paired_at,
          lastSeenAt:
            socketSeen === undefined
              ? row.last_seen_at
              : Math.max(socketSeen, row.last_seen_at ?? 0),
          connected: socketSeen !== undefined,
        };
      });
  }

  /** The number of screens that play each board. */
  countByBoard(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of this.#sql
      .exec<{ board_id: string; count: number }>(
        `SELECT board_id, count(*) AS count FROM menu_screen
         WHERE removed_at IS NULL GROUP BY board_id`,
      )
      .toArray())
      counts.set(row.board_id, row.count);
    return counts;
  }

  /** Keeps a newly paired screen. The caller checked that its board exists. */
  async pair(
    input: Readonly<{
      screenId: string;
      secret: string;
      name: string;
      boardId: string;
      userId: UserId;
      now: number;
    }>,
  ): Promise<"paired" | "screen_limit"> {
    const count = this.#sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM menu_screen WHERE removed_at IS NULL",
      )
      .one().count;
    if (count >= SCREEN_LIMIT) return "screen_limit";
    this.#sql.exec(
      `INSERT INTO menu_screen
        (screen_id, name, board_id, token_hash, paired_by_app_user, paired_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.screenId,
      input.name,
      input.boardId,
      await sha256Hex(input.secret),
      input.userId,
      input.now,
    );
    return "paired";
  }

  /** Points a screen at another board. */
  assign(screenId: string, boardId: string): boolean {
    const changed = this.#sql.exec(
      `UPDATE menu_screen SET board_id = ?
       WHERE screen_id = ? AND removed_at IS NULL`,
      boardId,
      screenId,
    ).rowsWritten;
    if (changed > 0) this.signal({ kind: "screen", screenId });
    return changed > 0;
  }

  /** Ends a screen's pairing: its token stops, and its sockets close. */
  remove(screenId: string, now: number): boolean {
    const changed = this.#sql.exec(
      `UPDATE menu_screen SET removed_at = ?
       WHERE screen_id = ? AND removed_at IS NULL`,
      now,
      screenId,
    ).rowsWritten;
    for (const socket of this.#screenSockets(screenId))
      closeSocket(socket, SCREEN_REMOVED_CODE, "screen_removed");
    return changed > 0;
  }

  /** The screen that a token's secret proves, or null. */
  async verify(
    screenId: string,
    secret: string,
  ): Promise<MenuScreenRow | null> {
    const row = this.#sql
      .exec<{ name: string; board_id: string; token_hash: string }>(
        `SELECT name, board_id, token_hash FROM menu_screen
         WHERE screen_id = ? AND removed_at IS NULL`,
        screenId,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const presented = new TextEncoder().encode(await sha256Hex(secret));
    const kept = new TextEncoder().encode(row.token_hash);
    if (
      presented.byteLength !== kept.byteLength ||
      !crypto.subtle.timingSafeEqual(presented, kept)
    )
      return null;
    return { screenId, name: row.name, boardId: row.board_id };
  }

  seen(screenId: string, now: number): void {
    this.#sql.exec(
      "UPDATE menu_screen SET last_seen_at = ? WHERE screen_id = ?",
      now,
      screenId,
    );
  }

  /** Accepts the signal socket of a verified screen. */
  openSocket(screen: MenuScreenRow, now: number): Response {
    if (this.#screenSockets(screen.screenId).length >= SOCKETS_PER_SCREEN)
      return controlError("menu_screen_sockets_exhausted", 429);
    const attachment: ScreenAttachment = {
      route: { kind: MENU_SCREENS },
      screenId: screen.screenId,
      openedAt: now,
    };
    const accepted = acceptSocket(
      this.#ctx,
      [MENU_SCREENS, screenTag(screen.screenId)],
      attachment,
    );
    if (accepted === null) return controlError("menu_screen_unavailable", 503);
    this.seen(screen.screenId, now);
    accepted.headers.set("Sec-WebSocket-Protocol", MENU_SCREEN_SOCKET_PROTOCOL);
    return accepted;
  }

  /**
   * Tells the screens that `target` names to read their feed again. A lost
   * signal costs a later read: the player also reads on a timer.
   */
  signal(
    target:
      | Readonly<{ kind: "all" }>
      | Readonly<{ kind: "board"; boardId: string }>
      | Readonly<{ kind: "screen"; screenId: string }>,
  ): number {
    let sockets: WebSocket[];
    switch (target.kind) {
      case "all":
        sockets = openSockets(this.#ctx, MENU_SCREENS);
        break;
      case "screen":
        sockets = this.#screenSockets(target.screenId);
        break;
      case "board": {
        const screens = new Set(
          this.#sql
            .exec<{ screen_id: string }>(
              `SELECT screen_id FROM menu_screen
               WHERE board_id = ? AND removed_at IS NULL`,
              target.boardId,
            )
            .toArray()
            .map((row) => row.screen_id),
        );
        sockets = openSockets(this.#ctx, MENU_SCREENS).filter((socket) =>
          screens.has(screenAttachment(socket)?.screenId ?? ""),
        );
        break;
      }
    }
    for (const socket of sockets) {
      try {
        socket.send(SIGNAL);
      } catch {
        // A socket that closed meanwhile has no page to tell.
      }
    }
    return sockets.length;
  }

  /**
   * Closes each screen socket that stopped pinging, and each socket of a
   * removed screen, and keeps the last time each open screen answered.
   */
  sweep(now: number): void {
    for (const socket of openSockets(this.#ctx, MENU_SCREENS)) {
      const attachment = screenAttachment(socket);
      if (attachment === null) {
        closeSocket(socket, 1011, "Unknown screen socket");
        continue;
      }
      const seen = socketLastSeenAt(this.#ctx, socket, attachment.openedAt);
      if (now - seen > SOCKET_SILENCE_LIMIT_MS) {
        closeSocket(socket, 1001, "silent");
        continue;
      }
      const active = this.#sql
        .exec(
          "SELECT screen_id FROM menu_screen WHERE screen_id = ? AND removed_at IS NULL",
          attachment.screenId,
        )
        .toArray();
      if (active.length === 0) {
        closeSocket(socket, SCREEN_REMOVED_CODE, "screen_removed");
        continue;
      }
      this.#sql.exec(
        `UPDATE menu_screen SET last_seen_at = max(coalesce(last_seen_at, 0), ?)
         WHERE screen_id = ?`,
        seen,
        attachment.screenId,
      );
    }
  }

  #screenSockets(screenId: string): WebSocket[] {
    return openSockets(this.#ctx, screenTag(screenId));
  }
}

const SIGNAL = JSON.stringify({ kind: MENU_SCREEN_SIGNAL });

function screenTag(screenId: string): string {
  return `${MENU_SCREENS}:${screenId}`;
}

function screenAttachment(socket: WebSocket): ScreenAttachment | null {
  let value: unknown;
  try {
    value = socket.deserializeAttachment();
  } catch {
    return null;
  }
  return isRecord(value) &&
    isRecord(value.route) &&
    value.route.kind === MENU_SCREENS &&
    typeof value.screenId === "string" &&
    isNonNegativeInteger(value.openedAt)
    ? {
        route: { kind: MENU_SCREENS },
        screenId: value.screenId,
        openedAt: value.openedAt,
      }
    : null;
}

function createMenuScreenSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS menu_screen (
    screen_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    board_id TEXT NOT NULL,
    token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
    paired_by_app_user TEXT NOT NULL,
    paired_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    removed_at INTEGER
  )`);
}
