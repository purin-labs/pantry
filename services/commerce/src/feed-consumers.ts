// Readers of the event feed that keep their place here (Plan 76 phase 4).
// A consumer, such as Pantry, reads events after its cursor, applies them, and
// moves the cursor forward. A cursor never moves back, so a consumer that
// stops and starts again catches up with no lost and no repeated event.
//
// Deliveries up to the slowest consumer's cursor count as delivered: the
// archive and the wake-up alarm read that status, as they did when Platform
// acknowledged each delivery.
import type { CommerceDatabase } from "./database.ts";
import { formatCursor, parseCursor } from "./event-feed.ts";

export type CommerceFeedConsumerV1 = Readonly<{
  consumerId: string;
  cursor: string;
  /** Null until the consumer first moves its cursor. */
  updatedAt: string | null;
}>;

export type FeedConsumerResult =
  | Readonly<{ kind: "ok"; value: CommerceFeedConsumerV1 }>
  | Readonly<{ kind: "error"; status: 404 | 409 | 422; message: string }>;

type Position = Readonly<{ revision: number; deliveryId: string }>;

export class FeedConsumers {
  readonly #database: CommerceDatabase;
  readonly #now: () => string;

  constructor(
    options: Readonly<{ database: CommerceDatabase; now: () => string }>,
  ) {
    this.#database = options.database;
    this.#now = options.now;
  }

  /**
   * The consumer's cursor. A new consumer starts just before the oldest
   * delivery nobody acknowledged, so it reads what the delivery stream would
   * have given it next.
   */
  read(merchantId: string, consumerId: string): FeedConsumerResult {
    if (!isConsumerId(consumerId))
      return invalid("A consumer id is lowercase letters, digits, - and _");
    const row = this.#row(merchantId, consumerId);
    return row === undefined
      ? {
          kind: "ok",
          value: {
            consumerId,
            cursor: this.#startCursor(merchantId),
            updatedAt: null,
          },
        }
      : {
          kind: "ok",
          value: { consumerId, cursor: row.cursor, updatedAt: row.updatedAt },
        };
  }

  /**
   * Moves the cursor to an event the consumer applied. A cursor at or
   * before the current one changes nothing and answers with the current
   * cursor: two runs of one consumer may overlap, and the later one has
   * already passed the event.
   */
  advance(
    merchantId: string,
    consumerId: string,
    body: unknown,
  ): FeedConsumerResult {
    if (!isConsumerId(consumerId))
      return invalid("A consumer id is lowercase letters, digits, - and _");
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "cursor") ||
      typeof (body as { cursor?: unknown }).cursor !== "string"
    )
      return invalid("Send the cursor of the last applied event");
    const cursor = (body as { cursor: string }).cursor;
    let target: Position;
    try {
      target = parseCursor(cursor);
    } catch {
      return invalid("The cursor is not valid");
    }
    if (
      this.#database
        .prepare("SELECT 1 AS present FROM merchant WHERE merchant_id = ?")
        .get<Readonly<{ present: number }>>(merchantId) === undefined
    )
      return { kind: "error", status: 404, message: "Merchant not found" };
    const current = this.read(merchantId, consumerId);
    if (current.kind === "error") return current;
    const from = parseCursor(current.value.cursor);
    if (before(target, from) || same(target, from)) return current;
    if (!this.#isEvent(merchantId, target))
      return {
        kind: "error",
        status: 409,
        message: "The cursor names no event of this merchant",
      };
    const at = this.#now();
    this.#database.transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO feed_consumer (merchant_id, consumer_id, cursor, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (merchant_id, consumer_id) DO UPDATE SET
             cursor = excluded.cursor, updated_at = excluded.updated_at`,
        )
        .run(merchantId, consumerId, cursor, at);
      this.#markDelivered(merchantId, at);
    });
    return { kind: "ok", value: { consumerId, cursor, updatedAt: at } };
  }

  // Every delivery up to the slowest consumer's cursor is delivered.
  #markDelivered(merchantId: string, at: string): void {
    const cursors = this.#database
      .prepare("SELECT cursor FROM feed_consumer WHERE merchant_id = ?")
      .all<Readonly<{ cursor: string }>>(merchantId)
      .map((row) => parseCursor(row.cursor));
    const slowest = cursors.reduce<Position | undefined>(
      (low, cursor) =>
        low === undefined || before(cursor, low) ? cursor : low,
      undefined,
    );
    if (slowest === undefined) return;
    this.#database
      .prepare(
        `UPDATE observation_outbox SET status = 'delivered', delivered_at = ?
         WHERE merchant_id = ? AND status = 'pending' AND (
           merchant_revision < ? OR (merchant_revision = ? AND delivery_id <= ?)
         )`,
      )
      .run(
        at,
        merchantId,
        slowest.revision,
        slowest.revision,
        slowest.deliveryId,
      );
  }

  #startCursor(merchantId: string): string {
    const oldest = this.#database
      .prepare(
        `SELECT merchant_revision AS revision, delivery_id AS deliveryId
         FROM observation_outbox WHERE merchant_id = ? AND status = 'pending'
         ORDER BY merchant_revision, delivery_id LIMIT 1`,
      )
      .get<Position>(merchantId);
    const previous = this.#database
      .prepare(
        oldest === undefined
          ? `SELECT merchant_revision AS revision, delivery_id AS deliveryId
             FROM observation_outbox WHERE merchant_id = ?
             ORDER BY merchant_revision DESC, delivery_id DESC LIMIT 1`
          : `SELECT merchant_revision AS revision, delivery_id AS deliveryId
             FROM observation_outbox WHERE merchant_id = ? AND (
               merchant_revision < ? OR (merchant_revision = ? AND delivery_id < ?)
             )
             ORDER BY merchant_revision DESC, delivery_id DESC LIMIT 1`,
      )
      .get<Position>(
        ...(oldest === undefined
          ? [merchantId]
          : [merchantId, oldest.revision, oldest.revision, oldest.deliveryId]),
      );
    if (previous !== undefined)
      return formatCursor(previous.revision, previous.deliveryId);
    // Every earlier event is archived. "(r, '')" is before every event of
    // revision r; with nothing pending, the next commit gets a later revision.
    return oldest !== undefined
      ? formatCursor(oldest.revision, "")
      : formatCursor(this.#merchantRevision(merchantId) + 1, "");
  }

  #merchantRevision(merchantId: string): number {
    return (
      this.#database
        .prepare("SELECT revision FROM merchant WHERE merchant_id = ?")
        .get<Readonly<{ revision: number }>>(merchantId)?.revision ?? 0
    );
  }

  #isEvent(merchantId: string, position: Position): boolean {
    return (
      this.#database
        .prepare(
          "SELECT 1 AS present FROM observation_outbox WHERE merchant_id = ? AND merchant_revision = ? AND delivery_id = ?",
        )
        .get<Readonly<{ present: number }>>(
          merchantId,
          position.revision,
          position.deliveryId,
        ) !== undefined
    );
  }

  #row(
    merchantId: string,
    consumerId: string,
  ): Readonly<{ cursor: string; updatedAt: string }> | undefined {
    return this.#database
      .prepare(
        "SELECT cursor, updated_at AS updatedAt FROM feed_consumer WHERE merchant_id = ? AND consumer_id = ?",
      )
      .get<Readonly<{ cursor: string; updatedAt: string }>>(
        merchantId,
        consumerId,
      );
  }
}

function before(left: Position, right: Position): boolean {
  return (
    left.revision < right.revision ||
    (left.revision === right.revision && left.deliveryId < right.deliveryId)
  );
}

function same(left: Position, right: Position): boolean {
  return (
    left.revision === right.revision && left.deliveryId === right.deliveryId
  );
}

function isConsumerId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value);
}

function invalid(message: string): FeedConsumerResult {
  return { kind: "error", status: 422, message };
}

/**
 * Moves every consumer's cursor back to just before `revision`, when
 * Commerce reopens a delivery that a consumer already passed: the signing
 * repair turns a delivery that a receiver rejected back into a pending one.
 * Events of that revision are read again; consumers apply them by revision.
 */
export function rewindFeedConsumers(
  database: CommerceDatabase,
  merchantId: string,
  revision: number,
): void {
  const start = { revision, deliveryId: "" };
  for (const row of database
    .prepare(
      "SELECT consumer_id AS consumerId, cursor FROM feed_consumer WHERE merchant_id = ?",
    )
    .all<Readonly<{ consumerId: string; cursor: string }>>(merchantId)) {
    if (before(parseCursor(row.cursor), start)) continue;
    database
      .prepare(
        "UPDATE feed_consumer SET cursor = ? WHERE merchant_id = ? AND consumer_id = ?",
      )
      .run(formatCursor(revision, ""), merchantId, row.consumerId);
  }
}
