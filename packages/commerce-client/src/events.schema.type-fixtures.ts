// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiEvents from "@seams/commerce-contracts/records/api-events";
import type {
  CreateCommerceWebhookSubscriptionV1,
  DeleteCommerceWebhookSubscriptionV1,
  RestartCommerceWebhookSubscriptionV1,
  RotateCommerceWebhookSecretV1,
  CommerceEventResourceV1,
  CommerceEventV1,
  CommerceEventPageV1,
  CommerceFeedConsumerV1,
  CommerceReceivedEventV1,
  CommerceReceivedEventPageV1,
  CommerceWebhookEventV1,
  CommerceWebhookSecretRotatedV1,
  CommerceWebhookSubscriptionCommandV1,
  CommerceWebhookSubscriptionCreatedV1,
  CommerceWebhookSubscriptionV1,
} from "./events.ts";
export type CreateCommerceWebhookSubscriptionV1Parity = Assert<
  Equal<
    CreateCommerceWebhookSubscriptionV1,
    apiEvents.CreateCommerceWebhookSubscriptionV1
  >
>;
export type DeleteCommerceWebhookSubscriptionV1Parity = Assert<
  Equal<
    DeleteCommerceWebhookSubscriptionV1,
    apiEvents.DeleteCommerceWebhookSubscriptionV1
  >
>;
export type RestartCommerceWebhookSubscriptionV1Parity = Assert<
  Equal<
    RestartCommerceWebhookSubscriptionV1,
    apiEvents.RestartCommerceWebhookSubscriptionV1
  >
>;
export type RotateCommerceWebhookSecretV1Parity = Assert<
  Equal<
    RotateCommerceWebhookSecretV1,
    apiEvents.RotateCommerceWebhookSecretV1
  >
>;
export type CommerceEventResourceV1Parity = Assert<
  Equal<CommerceEventResourceV1, apiEvents.CommerceEventResourceV1>
>;
export type CommerceEventV1Parity = Assert<
  Equal<CommerceEventV1, apiEvents.CommerceEventV1>
>;
export type CommerceEventPageV1Parity = Assert<
  Equal<CommerceEventPageV1, apiEvents.CommerceEventPageV1>
>;
export type CommerceFeedConsumerV1Parity = Assert<
  Equal<CommerceFeedConsumerV1, apiEvents.CommerceFeedConsumerV1>
>;
export type CommerceReceivedEventV1Parity = Assert<
  Equal<CommerceReceivedEventV1, apiEvents.CommerceReceivedEventV1>
>;
export type CommerceReceivedEventPageV1Parity = Assert<
  Equal<CommerceReceivedEventPageV1, apiEvents.CommerceReceivedEventPageV1>
>;
export type CommerceWebhookEventV1Parity = Assert<
  Equal<CommerceWebhookEventV1, apiEvents.CommerceWebhookEventV1>
>;
export type CommerceWebhookSecretRotatedV1Parity = Assert<
  Equal<
    CommerceWebhookSecretRotatedV1,
    apiEvents.CommerceWebhookSecretRotatedV1
  >
>;
export type CommerceWebhookSubscriptionCommandV1Parity = Assert<
  Equal<
    CommerceWebhookSubscriptionCommandV1,
    apiEvents.CommerceWebhookSubscriptionCommandV1
  >
>;
export type CommerceWebhookSubscriptionCreatedV1Parity = Assert<
  Equal<
    CommerceWebhookSubscriptionCreatedV1,
    apiEvents.CommerceWebhookSubscriptionCreatedV1
  >
>;
export type CommerceWebhookSubscriptionV1Parity = Assert<
  Equal<
    CommerceWebhookSubscriptionV1,
    apiEvents.CommerceWebhookSubscriptionV1
  >
>;
