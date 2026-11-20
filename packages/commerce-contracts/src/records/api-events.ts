// Plan 78 step 2: the event feed and webhook records that
// packages/commerce-client reads in src/events.ts. Each schema
// follows its hand-written reader: exact keys, unique topics such as
// `order.created` or `order.*`, and a delivery as the delivery reader keeps it.
import { Type, type Static } from "typebox";
import { NonNegativeInteger, PositiveInteger } from "@purin-labs/contract-schema";
import { normalizedTextSchema, utcTimestampSchema } from "./fields.ts";
import { Nullable } from "./client-wire-fields.ts";
import {
  commerceDeliveryV1Schema,
  commerceMutationResultV1Schema,
  commerceReceivedDeliveryV1Schema,
} from "./api-mutations.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;
const exactKeys = { unevaluatedProperties: false } as const;

export const commerceEventResourceV1Schema = ReadonlyStrictObject({
  kind: text,
  id: text,
  revision: PositiveInteger,
});
export type CommerceEventResourceV1 = Static<
  typeof commerceEventResourceV1Schema
>;

const eventProperties = {
  eventId: text,
  cursor: text,
  kind: text,
  merchantRevision: PositiveInteger,
  occurredAt: utcTimestampSchema,
  resources: ImmutableArray(commerceEventResourceV1Schema),
};

export const commerceEventV1Schema = ReadonlyStrictObject({
  ...eventProperties,
  delivery: commerceDeliveryV1Schema,
});
export type CommerceEventV1 = Static<typeof commerceEventV1Schema>;

export const commerceEventPageV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.events.v1"),
  events: ImmutableArray(commerceEventV1Schema),
  nextCursor: Nullable(text),
});
export type CommerceEventPageV1 = Static<typeof commerceEventPageV1Schema>;

export const commerceReceivedEventV1Schema = Type.Intersect(
  [
    ReadonlyOpenObject(eventProperties),
    ReadonlyOpenObject({ delivery: commerceReceivedDeliveryV1Schema }),
  ],
  exactKeys,
);
export type CommerceReceivedEventV1 = Static<
  typeof commerceReceivedEventV1Schema
>;

export const commerceReceivedEventPageV1Schema = Type.Intersect(
  [
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.events.v1"),
      nextCursor: Nullable(text),
    }),
    ReadonlyOpenObject({
      events: ImmutableArray(commerceReceivedEventV1Schema),
    }),
  ],
  exactKeys,
);
export type CommerceReceivedEventPageV1 = Static<
  typeof commerceReceivedEventPageV1Schema
>;

export const commerceFeedConsumerV1Schema = ReadonlyStrictObject({
  consumerId: text,
  cursor: text,
  updatedAt: Nullable(utcTimestampSchema),
});
export type CommerceFeedConsumerV1 = Static<
  typeof commerceFeedConsumerV1Schema
>;

export const commerceWebhookEventV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.webhook-event.v1"),
  eventId: text,
  kind: text,
  merchantId: text,
  merchantRevision: PositiveInteger,
  occurredAt: utcTimestampSchema,
  resources: ImmutableArray(commerceEventResourceV1Schema),
});
export type CommerceWebhookEventV1 = Static<
  typeof commerceWebhookEventV1Schema
>;

/** `TOPIC`: `*`, an event kind, or a resource with `*`, such as `order.*`. */
const topicSchema = Type.String({
  pattern: "^(?:\\*|[a-z_]+\\.(?:\\*|[a-z_]+))$",
});

const topicsSchema = Type.Refine(
  ImmutableArray(topicSchema, { minItems: 1 }),
  hasUniqueTopics,
  topicsError,
);

function hasUniqueTopics(topics: readonly string[]): boolean {
  return new Set(topics).size === topics.length;
}

function topicsError(): string {
  return "topics must name unique topics";
}

/** `requireText` and an `https://` prefix. */
const webhookUrlSchema = Type.String({
  pattern: "^https://(?:[\\s\\S]*(?<!\\s))?$",
});

export const createCommerceWebhookSubscriptionV1Schema = ReadonlyStrictObject(
  {
    schemaVersion: Type.Literal("underclerk.create-webhook-subscription.v1"),
    merchantId: text,
    idempotencyKey: text,
    requestedAt: utcTimestampSchema,
    subscriptionId: text,
    url: webhookUrlSchema,
    topics: topicsSchema,
  },
);
export type CreateCommerceWebhookSubscriptionV1 = Static<
  typeof createCommerceWebhookSubscriptionV1Schema
>;

export const webhookSubscriptionCommandBaseSchema = ReadonlyOpenObject({
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
  subscriptionId: text,
  expectedRevision: PositiveInteger,
});
export type WebhookSubscriptionCommandBase = Static<
  typeof webhookSubscriptionCommandBaseSchema
>;

export const restartCommerceWebhookSubscriptionV1Schema = Type.Intersect(
  [
    webhookSubscriptionCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.restart-webhook-subscription.v1"),
    }),
  ],
  exactKeys,
);
export type RestartCommerceWebhookSubscriptionV1 = Static<
  typeof restartCommerceWebhookSubscriptionV1Schema
>;

export const rotateCommerceWebhookSecretV1Schema = Type.Intersect(
  [
    webhookSubscriptionCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.rotate-webhook-secret.v1"),
      keepPreviousSecretSeconds: Type.Integer({ minimum: 0, maximum: 86_400 }),
    }),
  ],
  exactKeys,
);
export type RotateCommerceWebhookSecretV1 = Static<
  typeof rotateCommerceWebhookSecretV1Schema
>;

export const deleteCommerceWebhookSubscriptionV1Schema = Type.Intersect(
  [
    webhookSubscriptionCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.delete-webhook-subscription.v1"),
    }),
  ],
  exactKeys,
);
export type DeleteCommerceWebhookSubscriptionV1 = Static<
  typeof deleteCommerceWebhookSubscriptionV1Schema
>;

export const commerceWebhookSubscriptionCommandV1Schema = Type.Union([
  restartCommerceWebhookSubscriptionV1Schema,
  rotateCommerceWebhookSecretV1Schema,
  deleteCommerceWebhookSubscriptionV1Schema,
]);
export type CommerceWebhookSubscriptionCommandV1 = Static<
  typeof commerceWebhookSubscriptionCommandV1Schema
>;

export const commerceWebhookSubscriptionCreatedV1Schema =
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.webhook-subscription-created.v1"),
    mutation: commerceMutationResultV1Schema,
    secret: Nullable(text),
  });
export type CommerceWebhookSubscriptionCreatedV1 = Static<
  typeof commerceWebhookSubscriptionCreatedV1Schema
>;

export const commerceWebhookSecretRotatedV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.webhook-secret-rotated.v1"),
  mutation: commerceMutationResultV1Schema,
  secret: Nullable(text),
});
export type CommerceWebhookSecretRotatedV1 = Static<
  typeof commerceWebhookSecretRotatedV1Schema
>;

export const commerceWebhookSubscriptionV1Schema = ReadonlyStrictObject({
  id: text,
  revision: PositiveInteger,
  url: text,
  topics: ImmutableArray(text),
  state: Type.Union([Type.Literal("active"), Type.Literal("failing")]),
  failedEvents: NonNegativeInteger,
  delivered: NonNegativeInteger,
  pending: NonNegativeInteger,
  previousSecretExpiresAt: Nullable(utcTimestampSchema),
  createdAt: utcTimestampSchema,
  occurredAt: utcTimestampSchema,
});
export type CommerceWebhookSubscriptionV1 = Static<
  typeof commerceWebhookSubscriptionV1Schema
>;

type WebhookSubscriptionList = Readonly<{
  schemaVersion: "underclerk.webhook-subscriptions.v1";
  subscriptions: readonly CommerceWebhookSubscriptionV1[];
}>;

/** `parseWebhookSubscriptions`: a merchant's webhook subscriptions. */
const webhookSubscriptionListSchema = Type.Unsafe<
  readonly CommerceWebhookSubscriptionV1[]
>(
  Type.Codec(
    ReadonlyStrictObject({
      schemaVersion: Type.Literal("underclerk.webhook-subscriptions.v1"),
      subscriptions: ImmutableArray(commerceWebhookSubscriptionV1Schema),
    }),
  )
    .Decode(subscriptionsOf)
    .Encode(subscriptionList),
);

function subscriptionsOf(
  list: WebhookSubscriptionList,
): readonly CommerceWebhookSubscriptionV1[] {
  return list.subscriptions;
}

function subscriptionList(
  subscriptions: readonly CommerceWebhookSubscriptionV1[],
): WebhookSubscriptionList {
  return {
    schemaVersion: "underclerk.webhook-subscriptions.v1",
    subscriptions,
  };
}

// Parsers of the client API types (Plan 78 step 2).
export const parseCreateCommerceWebhookSubscriptionV1 = wireRecordParser(
  createCommerceWebhookSubscriptionV1Schema,
);
export const parseCommerceFeedConsumerV1 = wireRecordParser(
  commerceFeedConsumerV1Schema,
);
export const parseCommerceReceivedEventPageV1 = wireRecordParser(
  commerceReceivedEventPageV1Schema,
);
export const parseCommerceWebhookEventV1 = wireRecordParser(
  commerceWebhookEventV1Schema,
);
export const parseCommerceWebhookSecretRotatedV1 = wireRecordParser(
  commerceWebhookSecretRotatedV1Schema,
);
export const parseCommerceWebhookSubscriptionCommandV1 = wireRecordParser(
  commerceWebhookSubscriptionCommandV1Schema,
);
export const parseCommerceWebhookSubscriptionCreatedV1 = wireRecordParser(
  commerceWebhookSubscriptionCreatedV1Schema,
);
export const parseCommerceWebhookSubscriptionsV1 = wireRecordParser(
  webhookSubscriptionListSchema,
);
