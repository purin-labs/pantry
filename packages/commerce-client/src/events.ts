// The event feed and webhooks (Plan 76A step 4B, Plan 76 phase 4). Every
// committed change is an event with a named kind. A consumer reads the feed
// with its own cursor; reading changes nothing. A webhook subscription gets
// each matching event as a signed HTTPS post, with retries.
import type { CommerceEngineTimestamp } from "./commerce-resources.ts";
import {
  type CommerceDeliveryV1,
  type CommerceMutationResultV1,
  type CommerceReceivedDeliveryV1,
} from "./mutations.ts";
import { parseCreateCommerceWebhookSubscriptionV1 as parseCreateCommerceWebhookSubscriptionV1Record, parseCommerceFeedConsumerV1 as parseCommerceFeedConsumerV1Record, parseCommerceReceivedEventPageV1 as parseCommerceReceivedEventPageV1Record, parseCommerceWebhookEventV1 as parseCommerceWebhookEventV1Record, parseCommerceWebhookSecretRotatedV1 as parseCommerceWebhookSecretRotatedV1Record, parseCommerceWebhookSubscriptionCommandV1 as parseCommerceWebhookSubscriptionCommandV1Record, parseCommerceWebhookSubscriptionCreatedV1 as parseCommerceWebhookSubscriptionCreatedV1Record, parseCommerceWebhookSubscriptionsV1 as parseCommerceWebhookSubscriptionsV1Record } from "@purin-labs/commerce-contracts/records/api-events";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

export type CommerceEventResourceV1 = Readonly<{
  kind: string;
  id: string;
  revision: number;
}>;

export type CommerceEventV1 = Readonly<{
  eventId: string;
  cursor: string;
  /** A named kind such as `order.created` or `refund.succeeded`. */
  kind: string;
  merchantRevision: number;
  occurredAt: CommerceEngineTimestamp;
  resources: readonly CommerceEventResourceV1[];
  /** The signed snapshots, as Platform's delivery stream carries them. */
  delivery: CommerceDeliveryV1;
}>;

export type CommerceEventPageV1 = Readonly<{
  schemaVersion: "commerce.events.v1";
  events: readonly CommerceEventV1[];
  /** Pass as `after` for the next page; null when the page is empty. */
  nextCursor: string | null;
}>;

/** An event as a client reads it: the delivery keeps its signed observations. */
export type CommerceReceivedEventV1 = Omit<CommerceEventV1, "delivery"> &
  Readonly<{ delivery: CommerceReceivedDeliveryV1 }>;

export type CommerceReceivedEventPageV1 = Omit<
  CommerceEventPageV1,
  "events"
> &
  Readonly<{ events: readonly CommerceReceivedEventV1[] }>;

/** A feed reader's place (Plan 76 phase 4). */
export type CommerceFeedConsumerV1 = Readonly<{
  consumerId: string;
  cursor: string;
  updatedAt: string | null;
}>;

export function parseFeedConsumer(value: unknown): CommerceFeedConsumerV1 {
  return decodeRecord(parseCommerceFeedConsumerV1Record, value);
}

/** The body of a webhook post: identifiers only, never personal fields. */
export type CommerceWebhookEventV1 = Readonly<{
  schemaVersion: "commerce.webhook-event.v1";
  eventId: string;
  kind: string;
  merchantId: string;
  merchantRevision: number;
  occurredAt: CommerceEngineTimestamp;
  resources: readonly CommerceEventResourceV1[];
}>;

export type CommerceWebhookSubscriptionV1 = Readonly<{
  id: string;
  revision: number;
  url: string;
  topics: readonly string[];
  state: "active" | "failing";
  /** Events that this subscription could not deliver within 48 hours. */
  failedEvents: number;
  delivered: number;
  pending: number;
  /**
   * After a secret rotation, posts carry a second signature made with the
   * previous secret until this time; null when there is none.
   */
  previousSecretExpiresAt: CommerceEngineTimestamp | null;
  createdAt: CommerceEngineTimestamp;
  occurredAt: CommerceEngineTimestamp;
}>;

export type CreateCommerceWebhookSubscriptionV1 = Readonly<{
  schemaVersion: "commerce.create-webhook-subscription.v1";
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  subscriptionId: string;
  url: string;
  /** Event kinds, or a resource with `*`, such as `order.*`. */
  topics: readonly string[];
}>;

export type CommerceWebhookSubscriptionCreatedV1 = Readonly<{
  schemaVersion: "commerce.webhook-subscription-created.v1";
  mutation: CommerceMutationResultV1;
  /** The signing secret, returned once, when the subscription is new. */
  secret: string | null;
}>;

type WebhookSubscriptionCommandBase = Readonly<{
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  subscriptionId: string;
  expectedRevision: number;
}>;

/**
 * Makes a `failing` subscription active again. Every event that it has not
 * delivered, dead or pending, gets a new 48-hour window, and the events that
 * came while it was failing follow from its cursor.
 */
export type RestartCommerceWebhookSubscriptionV1 =
  WebhookSubscriptionCommandBase &
    Readonly<{ schemaVersion: "commerce.restart-webhook-subscription.v1" }>;

/**
 * Replaces the signing secret. Until `keepPreviousSecretSeconds` after the
 * request (at most 24 hours), each post also carries a signature made with
 * the previous secret, so the endpoint can change its secret without
 * refusing a post.
 */
export type RotateCommerceWebhookSecretV1 = WebhookSubscriptionCommandBase &
  Readonly<{
    schemaVersion: "commerce.rotate-webhook-secret.v1";
    keepPreviousSecretSeconds: number;
  }>;

/** Removes a subscription and its deliveries; the feed keeps the events. */
export type DeleteCommerceWebhookSubscriptionV1 =
  WebhookSubscriptionCommandBase &
    Readonly<{ schemaVersion: "commerce.delete-webhook-subscription.v1" }>;

export type CommerceWebhookSubscriptionCommandV1 =
  | RestartCommerceWebhookSubscriptionV1
  | RotateCommerceWebhookSecretV1
  | DeleteCommerceWebhookSubscriptionV1;

export type CommerceWebhookSecretRotatedV1 = Readonly<{
  schemaVersion: "commerce.webhook-secret-rotated.v1";
  mutation: CommerceMutationResultV1;
  /** The new signing secret, returned once, when the rotation applies. */
  secret: string | null;
}>;

/** The longest time that a previous secret keeps signing posts. */
export const WEBHOOK_PREVIOUS_SECRET_MAX_SECONDS = 86_400;

export function parseCreateWebhookSubscriptionCommand(value: unknown): CreateCommerceWebhookSubscriptionV1 {
  return decodeRecord(parseCreateCommerceWebhookSubscriptionV1Record, value);
}

export function parseWebhookSubscriptionCommand(value: unknown): CommerceWebhookSubscriptionCommandV1 {
  return decodeRecord(parseCommerceWebhookSubscriptionCommandV1Record, value);
}

/** Whether a topic such as `order.*` selects an event kind. */
export function webhookTopicMatches(topic: string, kind: string): boolean {
  if (topic === "*") return true;
  if (topic.endsWith(".*")) return kind.startsWith(topic.slice(0, -1));
  return topic === kind;
}

export function parseEventPage(value: unknown): CommerceReceivedEventPageV1 {
  return decodeRecord(parseCommerceReceivedEventPageV1Record, value);
}

export function parseWebhookEvent(value: unknown): CommerceWebhookEventV1 {
  return decodeRecord(parseCommerceWebhookEventV1Record, value);
}

export function parseWebhookSubscriptions(
  value: unknown,
): readonly CommerceWebhookSubscriptionV1[] {
  return decodeRecord(parseCommerceWebhookSubscriptionsV1Record, value);
}

export function parseWebhookSubscriptionCreated(value: unknown): CommerceWebhookSubscriptionCreatedV1 {
  return decodeRecord(parseCommerceWebhookSubscriptionCreatedV1Record, value);
}

export function parseWebhookSecretRotated(value: unknown): CommerceWebhookSecretRotatedV1 {
  return decodeRecord(parseCommerceWebhookSecretRotatedV1Record, value);
}
