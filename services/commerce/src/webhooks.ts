// Webhooks (Plan 76A step 4B). A subscription reads the event feed with its
// own cursor and gets each matching event as an HTTPS post, signed with
// HMAC-SHA256 over the timestamp and the canonical JSON body. A failed post
// is retried with growing delays; an event still failing 48 hours after its
// first post is dead, and its subscription becomes `failing` and gets no more
// posts until staff restart it. A consumer can fill any gap from the feed.
// Staff can rotate the secret, with a time in which the previous secret also
// signs, and delete a subscription with its deliveries.
import { createHmac, randomBytes } from "node:crypto";

import {
  parseCreateWebhookSubscriptionCommand,
  parseWebhookSubscriptionCommand,
  webhookTopicMatches,
  type CreateCommerceWebhookSubscriptionV1,
  type CommerceEventV1,
  type CommerceMutationResultV1,
  type CommerceWebhookEventV1,
  type CommerceWebhookSubscriptionCommandV1,
  type CommerceWebhookSubscriptionV1,
} from "@purin-labs/commerce-client";
import { commerceTransition } from "@purin-labs/commerce-contracts";
import { canonicalJson } from "@purin-labs/std";

import type { MerchantRow } from "./commerce-authority/ledger.ts";
import {
  beginMerchantCommand,
  type MerchantCommandPorts,
} from "./commerce-authority/merchant-command.ts";
import type { CommerceDatabase } from "./database.ts";
import { headCursor, readEventPage } from "./event-feed.ts";

export type WebhookPost = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

export type WebhookPostResult =
  | Readonly<{ kind: "response"; status: number }>
  | Readonly<{ kind: "error"; reason: string }>;

export interface WebhookSender {
  post(request: WebhookPost): Promise<WebhookPostResult>;
}

/** Posts with `fetch`; never follows a redirect. */
export class FetchWebhookSender implements WebhookSender {
  async post(request: WebhookPost): Promise<WebhookPostResult> {
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      return { kind: "response", status: response.status };
    } catch (error) {
      return {
        kind: "error",
        reason: error instanceof Error ? error.message : "post failed",
      };
    }
  }
}

type WebhookCommand =
  CreateCommerceWebhookSubscriptionV1 | CommerceWebhookSubscriptionCommandV1;

export type WebhookCommitRequest = Readonly<{
  command: WebhookCommand;
  merchant: MerchantRow;
  /** The subscription's revision after the change. */
  revision: number;
  write: () => void;
}>;

type WebhookAuthorityOptions = MerchantCommandPorts<WebhookCommand> &
  Readonly<{
    database: CommerceDatabase;
    now: () => string;
    commit: (request: WebhookCommitRequest) => CommerceMutationResultV1;
    /** The addresses that may get posts; `publicHttpsAddress` when absent. */
    addressAllowed?: (url: string) => boolean;
  }>;

/** Seconds before each retry; the last delay repeats. */
const RETRY_DELAYS = [
  60, 300, 900, 1_800, 3_600, 7_200, 14_400, 28_800, 43_200,
];
const GIVE_UP_AFTER_MS = 48 * 60 * 60 * 1_000;
const FAN_OUT_PAGE = 100;
const POST_BATCH = 50;

type SubscriptionRow = Readonly<{
  merchantId: string;
  subscriptionId: string;
  revision: number;
  url: string;
  topicsJson: string;
  secret: string;
  state: "active" | "failing";
  cursor: string;
  createdAt: string;
  occurredAt: string;
  previousSecret: string | null;
  previousSecretExpiresAt: string | null;
}>;

export class WebhookAuthority {
  readonly #options: WebhookAuthorityOptions;

  constructor(options: WebhookAuthorityOptions) {
    this.#options = options;
  }

  #addressAllowed(url: string): boolean {
    return (this.#options.addressAllowed ?? publicHttpsAddress)(url);
  }

  createSubscription(
    rawCommand: unknown,
  ): Readonly<{ mutation: CommerceMutationResultV1; secret: string | null }> {
    const start = beginMerchantCommand(
      this.#options,
      rawCommand,
      parseCreateWebhookSubscriptionCommand,
    );
    if (start.kind !== "ready") return { mutation: start.result, secret: null };
    const { command, merchant } = start;
    if (!this.#addressAllowed(command.url))
      return {
        mutation: this.#options.rejected({
          code: "resource_relationship_invalid",
          field: "webhookSubscription.url",
        }),
        secret: null,
      };
    if (this.#row(command.merchantId, command.subscriptionId) !== undefined)
      return {
        mutation: this.#options.rejected({
          code: "resource_already_exists",
          kind: "webhook_subscription",
          id: command.subscriptionId,
        }),
        secret: null,
      };
    const secret = randomBytes(32).toString("base64url");
    // A new subscription starts after the newest event; older events are in
    // the feed.
    const cursor = headCursor(this.#options.database, command.merchantId);
    const mutation = this.#options.commit({
      command,
      merchant,
      revision: 1,
      write: () =>
        this.#options.database
          .prepare(
            `INSERT INTO webhook_subscription (
               merchant_id, subscription_id, revision, url, topics_json, secret,
               state, cursor, created_at, occurred_at
             ) VALUES (?, ?, 1, ?, ?, ?, 'active', ?, ?, ?)`,
          )
          .run(
            command.merchantId,
            command.subscriptionId,
            command.url,
            JSON.stringify(command.topics),
            secret,
            cursor,
            command.requestedAt,
            command.requestedAt,
          ),
    });
    return {
      mutation,
      secret: mutation.outcome === "applied" ? secret : null,
    };
  }

  /** Restarts or deletes a subscription. */
  changeSubscription(rawCommand: unknown): CommerceMutationResultV1 {
    const admitted = this.#admitChange(rawCommand);
    if ("outcome" in admitted) return admitted;
    const { command, merchant, subscription } = admitted;
    if (command.schemaVersion === "commerce.rotate-webhook-secret.v1")
      return this.#options.rejected(
        this.#options.invalidCommand(
          new Error("A secret rotation has its own route"),
        ),
      );
    const { database } = this.#options;
    const revision = subscription.revision + 1;
    const key = [command.merchantId, command.subscriptionId] as const;
    if (command.schemaVersion === "commerce.delete-webhook-subscription.v1")
      return this.#options.commit({
        command,
        merchant,
        revision,
        write: () => {
          database
            .prepare(
              "DELETE FROM webhook_delivery WHERE merchant_id = ? AND subscription_id = ?",
            )
            .run(...key);
          database
            .prepare(
              "DELETE FROM webhook_subscription WHERE merchant_id = ? AND subscription_id = ?",
            )
            .run(...key);
        },
      });
    const move = commerceTransition(
      "webhook_subscription",
      { state: subscription.state },
      "restart",
    );
    if (!move.allowed) return this.#options.rejected(move.refusal);
    return this.#options.commit({
      command,
      merchant,
      revision,
      write: () => {
        database
          .prepare(
            `UPDATE webhook_subscription SET state = ?, revision = ?, occurred_at = ?
             WHERE merchant_id = ? AND subscription_id = ?`,
          )
          .run(move.to, revision, command.requestedAt, ...key);
        // A delivery whose event was archived cannot be posted again: it
        // is gone. Every other event that was not delivered gets a new
        // 48-hour window.
        database
          .prepare(
            `UPDATE webhook_delivery SET status = 'gone'
             WHERE merchant_id = ? AND subscription_id = ?
               AND status IN ('pending', 'dead')
               AND NOT EXISTS (
                 SELECT 1 FROM observation_outbox o
                 WHERE o.merchant_id = webhook_delivery.merchant_id
                   AND o.delivery_id = webhook_delivery.event_id
               )`,
          )
          .run(...key);
        database
          .prepare(
            `UPDATE webhook_delivery
             SET status = 'pending', attempts = 0, first_attempt_at = NULL,
                 next_attempt_at = ?
             WHERE merchant_id = ? AND subscription_id = ?
               AND status IN ('pending', 'dead')`,
          )
          .run(this.#options.now(), ...key);
      },
    });
  }

  rotateSecret(
    rawCommand: unknown,
  ): Readonly<{ mutation: CommerceMutationResultV1; secret: string | null }> {
    const admitted = this.#admitChange(rawCommand);
    if ("outcome" in admitted) return { mutation: admitted, secret: null };
    const { command, merchant, subscription } = admitted;
    if (command.schemaVersion !== "commerce.rotate-webhook-secret.v1")
      return {
        mutation: this.#options.rejected(
          this.#options.invalidCommand(
            new Error(
              "schemaVersion must be commerce.rotate-webhook-secret.v1",
            ),
          ),
        ),
        secret: null,
      };
    const move = commerceTransition(
      "webhook_subscription",
      { state: subscription.state },
      "rotate_secret",
    );
    if (!move.allowed)
      return { mutation: this.#options.rejected(move.refusal), secret: null };
    const secret = randomBytes(32).toString("base64url");
    const revision = subscription.revision + 1;
    // The previous secret signs for the given time from now, whatever time
    // the command names.
    const keep = command.keepPreviousSecretSeconds;
    const expiresAt = new Date(
      Date.parse(this.#options.now()) + keep * 1_000,
    ).toISOString();
    const mutation = this.#options.commit({
      command,
      merchant,
      revision,
      write: () =>
        this.#options.database
          .prepare(
            `UPDATE webhook_subscription
             SET secret = ?, previous_secret = ?, previous_secret_expires_at = ?,
                 revision = ?, occurred_at = ?
             WHERE merchant_id = ? AND subscription_id = ?`,
          )
          .run(
            secret,
            keep === 0 ? null : subscription.secret,
            keep === 0 ? null : expiresAt,
            revision,
            command.requestedAt,
            command.merchantId,
            command.subscriptionId,
          ),
    });
    return {
      mutation,
      secret: mutation.outcome === "applied" ? secret : null,
    };
  }

  #admitChange(rawCommand: unknown):
    | CommerceMutationResultV1
    | Readonly<{
        command: CommerceWebhookSubscriptionCommandV1;
        merchant: MerchantRow;
        subscription: SubscriptionRow;
      }> {
    const start = beginMerchantCommand(
      this.#options,
      rawCommand,
      parseWebhookSubscriptionCommand,
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant } = start;
    const subscription = this.#row(command.merchantId, command.subscriptionId);
    if (subscription === undefined)
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "webhook_subscription",
        id: command.subscriptionId,
      });
    if (subscription.revision !== command.expectedRevision)
      return this.#options.rejected({
        code: "stale_resource_revision",
        kind: "webhook_subscription",
        id: command.subscriptionId,
        expected: command.expectedRevision,
        actual: subscription.revision,
      });
    return { command, merchant, subscription };
  }

  listSubscriptions(
    merchantId: string,
  ): readonly CommerceWebhookSubscriptionV1[] {
    const rows = this.#options.database
      .prepare(
        `${SUBSCRIPTION_COLUMNS} WHERE merchant_id = ? ORDER BY subscription_id`,
      )
      .all<SubscriptionRow>(merchantId);
    const now = this.#options.now();
    return rows.map((row) => {
      const counts = this.#options.database
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN status IN ('dead', 'gone') THEN 1 ELSE 0 END) AS dead
           FROM webhook_delivery WHERE merchant_id = ? AND subscription_id = ?`,
        )
        .get<
          Readonly<{
            delivered: number | null;
            pending: number | null;
            dead: number | null;
          }>
        >(merchantId, row.subscriptionId);
      return {
        id: row.subscriptionId,
        revision: row.revision,
        url: row.url,
        topics: JSON.parse(row.topicsJson) as string[],
        state: row.state,
        failedEvents: counts?.dead ?? 0,
        delivered: counts?.delivered ?? 0,
        pending: counts?.pending ?? 0,
        previousSecretExpiresAt:
          previousSecret(row, now) === null
            ? null
            : row.previousSecretExpiresAt,
        createdAt: row.createdAt,
        occurredAt: row.occurredAt,
      };
    });
  }

  /**
   * Queues new matching events for every active subscription, then posts the
   * deliveries that are due. Returns when the next retry is due.
   */
  async dispatch(
    sender: WebhookSender,
  ): Promise<Readonly<{ posted: number; nextAttemptAt: string | null }>> {
    const { database } = this.#options;
    const now = this.#options.now();
    const subscriptions = database
      .prepare(`${SUBSCRIPTION_COLUMNS} WHERE state = 'active'`)
      .all<SubscriptionRow>();
    for (const subscription of subscriptions) this.#fanOut(subscription, now);
    const due = database
      .prepare(
        `SELECT d.merchant_id AS merchantId, d.subscription_id AS subscriptionId,
                d.event_id AS eventId, d.merchant_revision AS merchantRevision,
                d.attempts, d.first_attempt_at AS firstAttemptAt
         FROM webhook_delivery d
         JOIN webhook_subscription s
           ON s.merchant_id = d.merchant_id AND s.subscription_id = d.subscription_id
         WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND s.state = 'active'
         ORDER BY d.merchant_revision, d.event_id LIMIT ?`,
      )
      .all<
        Readonly<{
          merchantId: string;
          subscriptionId: string;
          eventId: string;
          merchantRevision: number;
          attempts: number;
          firstAttemptAt: string | null;
        }>
      >(now, POST_BATCH);
    let posted = 0;
    for (const delivery of due) {
      const subscription = this.#row(
        delivery.merchantId,
        delivery.subscriptionId,
      );
      if (subscription?.state !== "active") continue;
      const event = this.#event(delivery.merchantId, delivery.eventId);
      if (event === undefined) {
        // The archive moved the event; the delivery ends and is not due.
        database
          .prepare(
            `UPDATE webhook_delivery SET status = 'gone'
             WHERE merchant_id = ? AND subscription_id = ? AND event_id = ?
               AND status = 'pending'`,
          )
          .run(delivery.merchantId, delivery.subscriptionId, delivery.eventId);
        continue;
      }
      const body = canonicalJson(webhookBody(delivery.merchantId, event));
      const timestamp = now;
      const previous = previousSecret(subscription, now);
      const result = this.#addressAllowed(subscription.url)
        ? await sender.post({
            url: subscription.url,
            headers: {
              "content-type": "application/json",
              "x-commerce-event-id": event.eventId,
              "x-commerce-event-kind": event.kind,
              "x-commerce-timestamp": timestamp,
              "x-commerce-signature": [subscription.secret, previous]
                .flatMap((secret) =>
                  secret === null
                    ? []
                    : [`v1=${webhookSignature(secret, timestamp, body)}`],
                )
                .join(","),
            },
            body,
          })
        : ({ kind: "error", reason: "address is not public" } as const);
      posted += 1;
      const attempts = delivery.attempts + 1;
      const firstAttemptAt = delivery.firstAttemptAt ?? now;
      if (
        result.kind === "response" &&
        result.status >= 200 &&
        result.status < 300
      ) {
        database
          .prepare(
            `UPDATE webhook_delivery
             SET status = 'delivered', attempts = ?, first_attempt_at = ?,
                 last_status = ?, delivered_at = ?
             WHERE merchant_id = ? AND subscription_id = ? AND event_id = ?`,
          )
          .run(
            attempts,
            firstAttemptAt,
            result.status,
            now,
            delivery.merchantId,
            delivery.subscriptionId,
            delivery.eventId,
          );
        continue;
      }
      const lastStatus = result.kind === "response" ? result.status : null;
      // The guard `failed_for_48_hours`.
      if (Date.parse(now) - Date.parse(firstAttemptAt) >= GIVE_UP_AFTER_MS) {
        const move = commerceTransition(
          "webhook_subscription",
          subscription,
          "fail",
        );
        database.transaction(() => {
          database
            .prepare(
              `UPDATE webhook_delivery
               SET status = 'dead', attempts = ?, first_attempt_at = ?, last_status = ?
               WHERE merchant_id = ? AND subscription_id = ? AND event_id = ?`,
            )
            .run(
              attempts,
              firstAttemptAt,
              lastStatus,
              delivery.merchantId,
              delivery.subscriptionId,
              delivery.eventId,
            );
          if (move.allowed)
            database
              .prepare(
                `UPDATE webhook_subscription
                 SET state = ?, revision = revision + 1, occurred_at = ?
                 WHERE merchant_id = ? AND subscription_id = ? AND state = ?`,
              )
              .run(
                move.to,
                now,
                delivery.merchantId,
                delivery.subscriptionId,
                subscription.state,
              );
        });
        continue;
      }
      const delay =
        RETRY_DELAYS[Math.min(attempts, RETRY_DELAYS.length) - 1] ?? 43_200;
      database
        .prepare(
          `UPDATE webhook_delivery
           SET attempts = ?, first_attempt_at = ?, last_status = ?, next_attempt_at = ?
           WHERE merchant_id = ? AND subscription_id = ? AND event_id = ?`,
        )
        .run(
          attempts,
          firstAttemptAt,
          lastStatus,
          new Date(Date.parse(now) + delay * 1_000).toISOString(),
          delivery.merchantId,
          delivery.subscriptionId,
          delivery.eventId,
        );
    }
    const next = database
      .prepare(
        `SELECT MIN(d.next_attempt_at) AS nextAttemptAt
         FROM webhook_delivery d
         JOIN webhook_subscription s
           ON s.merchant_id = d.merchant_id AND s.subscription_id = d.subscription_id
         WHERE d.status = 'pending' AND s.state = 'active'`,
      )
      .get<Readonly<{ nextAttemptAt: string | null }>>();
    return { posted, nextAttemptAt: next?.nextAttemptAt ?? null };
  }

  #fanOut(subscription: SubscriptionRow, now: string): void {
    const { database } = this.#options;
    const topics = JSON.parse(subscription.topicsJson) as string[];
    let cursor = subscription.cursor;
    for (;;) {
      const page = readEventPage(
        database,
        subscription.merchantId,
        cursor,
        FAN_OUT_PAGE,
      );
      if (page.nextCursor === null) break;
      database.transaction(() => {
        for (const event of page.events) {
          if (!topics.some((topic) => webhookTopicMatches(topic, event.kind)))
            continue;
          database
            .prepare(
              `INSERT OR IGNORE INTO webhook_delivery (
                 merchant_id, subscription_id, event_id, merchant_revision,
                 status, attempts, first_attempt_at, next_attempt_at,
                 last_status, delivered_at
               ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, NULL, NULL)`,
            )
            .run(
              subscription.merchantId,
              subscription.subscriptionId,
              event.eventId,
              event.merchantRevision,
              now,
            );
        }
        database
          .prepare(
            `UPDATE webhook_subscription SET cursor = ?
             WHERE merchant_id = ? AND subscription_id = ?`,
          )
          .run(
            page.nextCursor,
            subscription.merchantId,
            subscription.subscriptionId,
          );
      });
      cursor = page.nextCursor;
      if (page.events.length < FAN_OUT_PAGE) break;
    }
  }

  #event(merchantId: string, eventId: string): CommerceEventV1 | undefined {
    const row = this.#options.database
      .prepare(
        `SELECT merchant_revision AS merchantRevision FROM observation_outbox
         WHERE merchant_id = ? AND delivery_id = ?`,
      )
      .get<Readonly<{ merchantRevision: number }>>(merchantId, eventId);
    if (row === undefined) return undefined;
    // The event just before this one, so the page starts with this event.
    const page = readEventPage(
      this.#options.database,
      merchantId,
      `${row.merchantRevision - 1}:￿`,
      20,
    );
    return page.events.find((event) => event.eventId === eventId);
  }

  #row(
    merchantId: string,
    subscriptionId: string,
  ): SubscriptionRow | undefined {
    return this.#options.database
      .prepare(
        `${SUBSCRIPTION_COLUMNS} WHERE merchant_id = ? AND subscription_id = ?`,
      )
      .get<SubscriptionRow>(merchantId, subscriptionId);
  }
}

function webhookBody(
  merchantId: string,
  event: CommerceEventV1,
): CommerceWebhookEventV1 {
  return {
    schemaVersion: "commerce.webhook-event.v1",
    eventId: event.eventId,
    kind: event.kind,
    merchantId,
    merchantRevision: event.merchantRevision,
    occurredAt: event.occurredAt,
    resources: event.resources,
  };
}

/** The previous secret of a rotation, while it still signs posts. */
function previousSecret(row: SubscriptionRow, now: string): string | null {
  return row.previousSecret !== null &&
    row.previousSecretExpiresAt !== null &&
    Date.parse(now) < Date.parse(row.previousSecretExpiresAt)
    ? row.previousSecret
    : null;
}

function webhookSignature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

/**
 * Only HTTPS to a public host: no local names and no private, loopback,
 * link-local or literal IPv6 addresses.
 */
export function publicHttpsAddress(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return false;
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.startsWith("[") ||
    !host.includes(".")
  )
    return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 === null) return true;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

const SUBSCRIPTION_COLUMNS = `SELECT merchant_id AS merchantId,
  subscription_id AS subscriptionId, revision, url, topics_json AS topicsJson,
  secret, state, cursor, created_at AS createdAt, occurred_at AS occurredAt,
  previous_secret AS previousSecret,
  previous_secret_expires_at AS previousSecretExpiresAt
  FROM webhook_subscription`;
